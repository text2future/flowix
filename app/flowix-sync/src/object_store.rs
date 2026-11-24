//! Direct object-storage access, signed by the client.
//!
//! Official storage gets a short-lived, prefix-scoped credential from the
//! Worker; a custom S3 Remote uses its locally stored keypair. The protocol
//! layer resolves credentials at each request boundary, so official grants can
//! renew between pages or objects while a custom Remote returns its static
//! keypair. Both paths sign requests here. The official credential contract is
//! described in `docs/CLOUD_STORAGE_PATH_LWW_DESIGN.md` §8.
//!
//! This is the shared path-style S3 protocol layer used by both official
//! storage credentials and locally configured S3 Remotes. It implements
//! `ListObjectsV2` plus SigV4 signing; [`crate::object_store_ops`] builds the
//! `GET`, `HEAD`, and `PUT` object operations on the same signer. Deletion is
//! represented by writing a tombstone object, so the sync engine does not send
//! S3 `DELETE` requests. This is the focused protocol subset the engine needs,
//! not a general purpose S3 client.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest, Sha256};

use crate::error::SyncError;

const PAYLOAD_HASH_GET: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ALGORITHM: &str = "AWS4-HMAC-SHA256";

/// The `data` object of `POST /v2/storage/credentials`.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectStoreCredentials {
    pub backend_id: String,
    #[serde(default = "default_scheme")]
    pub scheme: String,
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    #[serde(default)]
    pub session_token: Option<String>,
    #[serde(default = "default_token_header")]
    pub token_header: String,
    /// Prefix for object metadata headers (`x-amz-meta-`, `x-cos-meta-`).
    /// A capability the server declares, so the client never branches on the
    /// backend's name.
    #[serde(default = "default_meta_prefix")]
    pub meta_prefix: String,
    pub prefix: String,
    #[serde(default = "default_mode")]
    pub mode: String,
    /// Unix epoch milliseconds, as issued by the server.
    pub expires_at: i64,
}

fn default_scheme() -> String {
    "s3-v4".to_string()
}

fn default_token_header() -> String {
    "x-amz-security-token".to_string()
}

fn default_meta_prefix() -> String {
    "x-amz-meta-".to_string()
}

fn default_mode() -> String {
    "read".to_string()
}

impl std::fmt::Debug for ObjectStoreCredentials {
    /// Redacted on purpose.
    ///
    /// The derived version prints `secretAccessKey` and `sessionToken`, and a
    /// credential is exactly the value that ends up in a `tracing::debug!` line,
    /// a panic message or a support log — the three places a temporary secret
    /// must never reach. Nothing is lost for debugging: the identity of the
    /// credential (bucket, prefix, mode, expiry) is all a human needs.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ObjectStoreCredentials")
            .field("backend_id", &self.backend_id)
            .field("scheme", &self.scheme)
            .field("endpoint", &self.endpoint)
            .field("bucket", &self.bucket)
            .field("region", &self.region)
            .field("access_key_id", &self.access_key_id)
            .field("secret_access_key", &"<redacted>")
            .field(
                "session_token",
                &self.session_token.as_ref().map(|_| "<redacted>"),
            )
            .field("meta_prefix", &self.meta_prefix)
            .field("prefix", &self.prefix)
            .field("mode", &self.mode)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

impl ObjectStoreCredentials {
    /// Renew a little before expiry so a request cannot be signed with a
    /// credential that dies in flight.
    pub fn is_fresh(&self, now_millis: i64) -> bool {
        self.is_fresh_within(now_millis, 60_000)
    }

    /// The same question with a caller-chosen margin.
    ///
    /// A pass can outlive one short-lived grant. The request layer checks this
    /// margin before every S3 request, so a later page or transfer renews the
    /// grant before it gets close to expiry (§8: renew five minutes early).
    pub fn is_fresh_within(&self, now_millis: i64, margin_millis: i64) -> bool {
        self.expires_at - now_millis > margin_millis
    }

    pub fn remaining_millis(&self, now_millis: i64) -> i64 {
        self.expires_at.saturating_sub(now_millis)
    }

    pub fn can_write(&self) -> bool {
        self.mode == "read-write"
    }

    /// Keys are always resolved against the issued prefix; a caller-supplied
    /// path can never escape it.
    pub fn scoped_key(&self, relative: &str) -> String {
        format!("{}{}", self.prefix, relative.trim_start_matches('/'))
    }

    /// Wire header for one metadata field, e.g. `contenthash`.
    pub fn meta_header(&self, name: &str) -> String {
        format!("{}{}", self.meta_prefix, name)
    }

    pub(crate) fn same_signing_material(&self, other: &Self) -> bool {
        self.access_key_id == other.access_key_id
            && self.secret_access_key == other.secret_access_key
            && self.session_token == other.session_token
    }
}

/// Resolves the credentials used for one object-store request.
///
/// Official storage renews its short-lived grant when it approaches expiry;
/// a custom S3 Remote simply returns the locally configured keypair. Keeping
/// this boundary at the request layer lets a long pass renew between pages or
/// objects without changing the shared S3 protocol implementation.
#[async_trait::async_trait]
pub trait CredentialResolver: Send + Sync {
    async fn resolve(&self, now_millis: i64) -> Result<ObjectStoreCredentials, SyncError>;

    fn supports_deletion_proxy(&self) -> bool {
        false
    }

    async fn proxy_tombstone(
        &self,
        _notebook: &str,
        _path: &str,
        _etag: &str,
    ) -> Result<(), SyncError> {
        Err(SyncError::InvalidState(
            "remote deletion proxy unavailable".into(),
        ))
    }
    async fn proxy_deletion_stamp(&self, _notebook: &str, _path: &str) -> Result<(), SyncError> {
        Err(SyncError::InvalidState(
            "remote deletion proxy unavailable".into(),
        ))
    }

    /// Requests a fresh grant after the object store explicitly rejected the
    /// previous one as expired. Static providers fall back to `resolve`; the
    /// caller retries only if the signing material actually changed.
    async fn refresh_after_rejection(
        &self,
        now_millis: i64,
        _rejected: &ObjectStoreCredentials,
    ) -> Result<ObjectStoreCredentials, SyncError> {
        self.resolve(now_millis).await
    }
}

/// Static local credentials are already resolved. This implementation keeps
/// connection checks and protocol utilities on the same request interface as
/// the official, renewable credential source.
#[async_trait::async_trait]
impl CredentialResolver for ObjectStoreCredentials {
    async fn resolve(&self, _now_millis: i64) -> Result<ObjectStoreCredentials, SyncError> {
        Ok(self.clone())
    }
}

/// A fully buffered object-store response. Object downloads already have to
/// materialize their body for reconciliation; buffering here also lets the
/// signer inspect a small S3 XML error body before deciding to renew once.
pub(crate) struct BufferedObjectResponse {
    pub credentials: ObjectStoreCredentials,
    pub status: reqwest::StatusCode,
    pub headers: reqwest::header::HeaderMap,
    pub body: Vec<u8>,
}

/// Sends a signed request and retries exactly once when S3 explicitly reports
/// an expired temporary token. Permission failures and ordinary 403/400
/// responses pass through unchanged.
pub(crate) async fn send_with_credential_renewal<F>(
    resolver: &dyn CredentialResolver,
    category: &'static str,
    operation: &'static str,
    mut build: F,
) -> Result<BufferedObjectResponse, SyncError>
where
    F: FnMut(&ObjectStoreCredentials, DateTime<Utc>) -> Result<reqwest::RequestBuilder, SyncError>,
{
    let mut credentials = resolver.resolve(Utc::now().timestamp_millis()).await?;
    for attempt in 0..2 {
        let request = build(&credentials, Utc::now())?;
        let mut measurement = crate::telemetry::RequestMeasurement::start(category, operation);
        let mut response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                measurement.finish(false);
                return Err(error.into());
            }
        };
        let status = response.status();
        let headers = response.headers().clone();
        let mut body = Vec::new();
        let progress = crate::telemetry::progress_callback();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    body.extend_from_slice(&chunk);
                    if !chunk.is_empty() {
                        if let Some(progress) = &progress {
                            progress();
                        }
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    measurement.finish(false);
                    return Err(error.into());
                }
            }
        }
        measurement.finish(status.is_success() || status.as_u16() == 404);
        drop(measurement);
        if attempt == 0 && is_expired_token_response(status, &body) {
            let renewed = resolver
                .refresh_after_rejection(Utc::now().timestamp_millis(), &credentials)
                .await?;
            if !credentials.same_signing_material(&renewed) {
                credentials = renewed;
                continue;
            }
        }
        return Ok(BufferedObjectResponse {
            credentials,
            status,
            headers,
            body,
        });
    }
    unreachable!("the renewal loop returns after at most two attempts")
}

fn is_expired_token_response(status: reqwest::StatusCode, body: &[u8]) -> bool {
    if status != reqwest::StatusCode::BAD_REQUEST && status != reqwest::StatusCode::FORBIDDEN {
        return false;
    }
    let body = String::from_utf8_lossy(body);
    matches!(
        tag(&body, "Code").as_deref(),
        Some("ExpiredToken" | "InvalidToken" | "TokenRefreshRequired")
    )
}

/// `POST /v2/storage/credentials` — one credential plus the quota it was
/// issued under. The client can defer writes when the reported usage is already
/// at the limit; it does not reserve capacity for an upcoming batch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageCredentialEnvelope {
    pub data: ObjectStoreCredentials,
    #[serde(default)]
    pub quota: Option<StorageQuota>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageQuota {
    pub mode: String,
    /// Bytes already stored, as the server last measured them.
    ///
    /// The only figure a direct-transfer client can act on: the Worker no
    /// longer sees writes, so the client can only use this as a snapshot.
    /// `None` for read scope, where nothing will be published anyway.
    #[serde(default)]
    pub used_bytes: Option<i64>,
    #[serde(default)]
    pub limit_bytes: Option<i64>,
    #[serde(default)]
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedObject {
    pub key: String,
    pub last_modified: String,
    pub size: u64,
    pub etag: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListPage {
    pub objects: Vec<ListedObject>,
    /// First-level child prefixes returned by a delimiter-based listing. S3
    /// uses these to enumerate notebook IDs without listing every file below
    /// `nb/`.
    pub common_prefixes: Vec<String>,
    pub next_cursor: Option<String>,
    /// The response `Date` header, epoch milliseconds.
    ///
    /// This is the only clock the design trusts for ordering (`§4.2`): device
    /// clocks drift, and `LastModified` is produced by the same server, so
    /// every "is this newer than what I last saw" comparison must be made in
    /// the server's frame. `None` only when a gateway omits the header.
    pub server_date_millis: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
}

/// The `ListObjectsV2` query for one page.
///
/// Split out of [`list_prefix`] so the shape is testable without a network —
/// a wrong `prefix` here silently reads another user's keys, and a missing
/// `delimiter` silently turns a directory listing into a whole-notebook one.
pub(crate) fn list_query(
    credentials: &ObjectStoreCredentials,
    prefix: &str,
    cursor: Option<&str>,
    delimiter: Option<&str>,
) -> Vec<(String, String)> {
    let mut query = vec![
        ("list-type".to_string(), "2".to_string()),
        ("prefix".to_string(), credentials.scoped_key(prefix)),
        ("max-keys".to_string(), "1000".to_string()),
    ];
    if let Some(cursor) = cursor {
        query.push(("continuation-token".to_string(), cursor.to_string()));
    }
    if let Some(delimiter) = delimiter {
        query.push(("delimiter".to_string(), delimiter.to_string()));
    }
    query
}

/// Lists one prefix with a request the client signed itself.
///
/// `prefix` is relative to the credential's scope; `cursor` is the
/// `NextContinuationToken` of the previous page.
///
/// `delimiter` is what makes "one directory" expressible on a flat key space.
/// Passing `Some("/")` returns only the direct children of `prefix`, which is
/// the only way `list("…/f/notes/")` means *notes*, not *notes and everything
/// beneath it*. Without it, enumerating the notebook root would return the
/// whole notebook and the L1 gate would lose its point (§4.1). The `s/`
/// listing wants the recursive form, so it passes `None`.
pub async fn list_prefix(
    http: &reqwest::Client,
    credential_resolver: &dyn CredentialResolver,
    prefix: &str,
    cursor: Option<&str>,
    delimiter: Option<&str>,
) -> Result<ListPage, SyncError> {
    let response = send_with_credential_renewal(
        credential_resolver,
        crate::telemetry::category(prefix),
        "list",
        |credentials, now| {
            let query = list_query(credentials, prefix, cursor, delimiter);
            let signed = sign_get(credentials, &query, now)?;
            let mut request = http.get(&signed.url);
            for (name, value) in &signed.headers {
                request = request.header(name, value);
            }
            Ok(request)
        },
    )
    .await?;
    // Read `Date` before the body is consumed; it is the pass's server clock.
    let server_date_millis = response
        .headers
        .get("date")
        .and_then(|value| value.to_str().ok())
        .and_then(parse_http_date);
    let body = String::from_utf8_lossy(&response.body);
    if !response.status.is_success() {
        return Err(SyncError::Api {
            status: response.status.as_u16(),
            code: "OBJECT_STORE_LIST_FAILED".to_string(),
            message: body.chars().take(400).collect(),
            details: None,
        });
    }
    validate_list_response(&body)?;
    Ok(ListPage {
        server_date_millis,
        ..parse_list_page(&body)
    })
}

/// An incomplete listing must never become evidence that remote objects are
/// absent. Reject truncated or malformed pages before the caller marks a
/// directory as fully enumerated.
fn validate_list_response(xml: &str) -> Result<(), SyncError> {
    let invalid = || SyncError::InvalidState("incomplete object store listing".into());
    if !xml.contains("<ListBucketResult") || !xml.contains("</ListBucketResult>") {
        return Err(invalid());
    }
    match tag(xml, "IsTruncated").as_deref() {
        Some("false") => {}
        Some("true") if tag(xml, "NextContinuationToken").is_some_and(|v| !v.is_empty()) => {}
        _ => return Err(invalid()),
    }
    for (open, close, required) in [
        (
            "<Contents>",
            "</Contents>",
            &["Key", "LastModified", "Size"][..],
        ),
        ("<CommonPrefixes>", "</CommonPrefixes>", &["Prefix"][..]),
    ] {
        let mut rest = xml;
        while let Some(start) = rest.find(open) {
            let after = &rest[start + open.len()..];
            let end = after.find(close).ok_or_else(invalid)?;
            if required
                .iter()
                .any(|name| tag(&after[..end], name).is_none())
            {
                return Err(invalid());
            }
            if open == "<Contents>"
                && (tag(&after[..end], "Size")
                    .and_then(|s| s.parse::<u64>().ok())
                    .is_none()
                    || tag(&after[..end], "LastModified")
                        .and_then(|s| parse_http_date(&s))
                        .is_none())
            {
                return Err(invalid());
            }
            rest = &after[end + close.len()..];
        }
    }
    Ok(())
}

/// What to sign: one request, described by the parts SigV4 cares about.
///
/// `headers` must hold only the extra headers that have to be signed
/// (`content-type`, every `x-amz-meta-*`); `host`, `x-amz-date`,
/// `x-amz-content-sha256` and the session token are added here so no caller can
/// forget them.
pub(crate) struct SignInput<'a> {
    pub method: &'a str,
    /// Path relative to the credential's scope. `None` addresses the bucket
    /// itself, which is what `ListObjectsV2` does.
    pub key: Option<&'a str>,
    pub query: &'a [(String, String)],
    pub headers: &'a [(String, String)],
    pub payload_hash: &'a str,
}

/// Builds the signed GET for `?list-type=2` on the credential's bucket.
pub fn sign_get(
    credentials: &ObjectStoreCredentials,
    query: &[(String, String)],
    now: DateTime<Utc>,
) -> Result<SignedRequest, SyncError> {
    sign_request(
        credentials,
        &SignInput {
            method: "GET",
            key: None,
            query,
            headers: &[],
            payload_hash: PAYLOAD_HASH_GET,
        },
        now,
    )
}

pub(crate) fn sign_request(
    credentials: &ObjectStoreCredentials,
    input: &SignInput<'_>,
    now: DateTime<Utc>,
) -> Result<SignedRequest, SyncError> {
    if credentials.scheme == "cos-v5" {
        return sign_cos_request(credentials, input, now);
    }
    if credentials.scheme != "s3-v4" {
        return Err(SyncError::InvalidState(
            "unsupported object storage signing scheme".into(),
        ));
    }
    let endpoint = credentials
        .endpoint
        .strip_prefix("https://")
        .or_else(|| credentials.endpoint.strip_prefix("http://"))
        .ok_or_else(|| {
            SyncError::InvalidState("object storage endpoint must be an http(s) URL".into())
        })?;
    let host = endpoint.trim_end_matches('/');
    let scheme = if credentials.endpoint.starts_with("https://") {
        "https"
    } else {
        "http"
    };
    let canonical_uri = match input.key {
        Some(key) => format!(
            "/{}/{}",
            encode(&credentials.bucket, true),
            encode(key, true)
        ),
        None => format!("/{}/", encode(&credentials.bucket, true)),
    };

    let mut pairs = input.query.to_vec();
    pairs.sort_by(|left, right| left.0.cmp(&right.0));
    let canonical_query = pairs
        .iter()
        .map(|(name, value)| format!("{}={}", encode(name, false), encode(value, false)))
        .collect::<Vec<_>>()
        .join("&");

    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();

    // SigV4 signs lowercase header names; the wire header keeps its real casing.
    let token = credentials.session_token.as_ref().map(|token| {
        (
            credentials.token_header.to_lowercase(),
            credentials.token_header.clone(),
            token.clone(),
        )
    });
    let mut canonical = vec![
        ("host".to_string(), host.to_string()),
        (
            "x-amz-content-sha256".to_string(),
            input.payload_hash.to_string(),
        ),
        ("x-amz-date".to_string(), amz_date.clone()),
    ];
    for (name, value) in input.headers {
        canonical.push((name.to_lowercase(), value.clone()));
    }
    if let Some((lowercase, _, value)) = &token {
        canonical.push((lowercase.clone(), value.clone()));
    }
    canonical.sort_by(|left, right| left.0.cmp(&right.0));
    canonical.dedup_by(|left, right| left.0 == right.0);
    let canonical_headers = canonical
        .iter()
        .map(|(name, value)| format!("{name}:{}\n", value.trim()))
        .collect::<String>();
    let signed_headers = canonical
        .iter()
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>()
        .join(";");

    let canonical_request = [
        input.method,
        &canonical_uri,
        &canonical_query,
        &canonical_headers,
        &signed_headers,
        input.payload_hash,
    ]
    .join("\n");

    let scope = format!("{date_stamp}/{}/s3/aws4_request", credentials.region);
    let string_to_sign = [
        ALGORITHM,
        &amz_date,
        &scope,
        &hex(&Sha256::digest(canonical_request.as_bytes())),
    ]
    .join("\n");

    let mut key = hmac_sha256(
        format!("AWS4{}", credentials.secret_access_key).as_bytes(),
        date_stamp.as_bytes(),
    );
    key = hmac_sha256(&key, credentials.region.as_bytes());
    key = hmac_sha256(&key, b"s3");
    key = hmac_sha256(&key, b"aws4_request");
    let signature = hex(&hmac_sha256(&key, string_to_sign.as_bytes()));

    let mut headers_out = vec![
        ("x-amz-date".to_string(), amz_date),
        (
            "x-amz-content-sha256".to_string(),
            input.payload_hash.to_string(),
        ),
    ];
    for (name, value) in input.headers {
        headers_out.push((name.clone(), value.clone()));
    }
    if let Some((_, wire_name, value)) = token {
        headers_out.push((wire_name, value));
    }
    headers_out.push((
        "authorization".to_string(),
        format!(
            "{ALGORITHM} Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            credentials.access_key_id,
        ),
    ));

    let url = if canonical_query.is_empty() {
        format!("{scheme}://{host}{canonical_uri}")
    } else {
        format!("{scheme}://{host}{canonical_uri}?{canonical_query}")
    };
    Ok(SignedRequest {
        url,
        headers: headers_out,
    })
}

fn sign_cos_request(
    credentials: &ObjectStoreCredentials,
    input: &SignInput<'_>,
    now: DateTime<Utc>,
) -> Result<SignedRequest, SyncError> {
    let url = reqwest::Url::parse(&credentials.endpoint)
        .map_err(|_| SyncError::InvalidState("invalid COS endpoint".into()))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(SyncError::InvalidState("invalid COS endpoint".into()));
    }
    let host = url.host_str().unwrap();
    // COS signs the decoded object key, but the URL must use encoded bytes.
    let canonical_path = input
        .key
        .map(|key| format!("/{key}"))
        .unwrap_or_else(|| "/".into());
    let path = input
        .key
        .map(|key| format!("/{}", encode(key, true)))
        .unwrap_or_else(|| "/".into());
    let mut pairs = input.query.to_vec();
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    let query = pairs
        .iter()
        .map(|(k, v)| format!("{}={}", encode(&k.to_lowercase(), false), encode(v, false)))
        .collect::<Vec<_>>()
        .join("&");
    let params = pairs
        .iter()
        .map(|(k, _)| k.to_lowercase())
        .collect::<Vec<_>>()
        .join(";");
    let start = now.timestamp() - 60;
    let key_time = format!("{start};{}", start + 360);
    let canonical = format!(
        "{}\n{canonical_path}\n{query}\nhost={host}\n",
        input.method.to_lowercase()
    );
    let digest = hex(&Sha1::digest(canonical.as_bytes()));
    let sign_key = hex(&hmac_sha1(
        credentials.secret_access_key.as_bytes(),
        key_time.as_bytes(),
    ));
    let to_sign = format!("sha1\n{key_time}\n{digest}\n");
    let signature = hex(&hmac_sha1(sign_key.as_bytes(), to_sign.as_bytes()));
    let authorization = format!("q-sign-algorithm=sha1&q-ak={}&q-sign-time={key_time}&q-key-time={key_time}&q-header-list=host&q-url-param-list={params}&q-signature={signature}", credentials.access_key_id);
    let mut headers = input.headers.to_vec();
    if let Some(token) = &credentials.session_token {
        headers.push((credentials.token_header.clone(), token.clone()));
    }
    headers.push(("authorization".into(), authorization));
    let suffix = if query.is_empty() {
        String::new()
    } else {
        format!("?{query}")
    };
    Ok(SignedRequest {
        url: format!("https://{host}{path}{suffix}"),
        headers,
    })
}

fn hmac_sha1(key: &[u8], value: &[u8]) -> Vec<u8> {
    let mut normalized = [0u8; 64];
    if key.len() > 64 {
        normalized[..20].copy_from_slice(&Sha1::digest(key));
    } else {
        normalized[..key.len()].copy_from_slice(key);
    }
    let mut inner = normalized.iter().map(|b| b ^ 0x36).collect::<Vec<_>>();
    inner.extend_from_slice(value);
    let mut outer = normalized.iter().map(|b| b ^ 0x5c).collect::<Vec<_>>();
    outer.extend_from_slice(&Sha1::digest(&inner));
    Sha1::digest(&outer).to_vec()
}

/// Percent-encodes per the SigV4 rules: unreserved characters stay, everything
/// else becomes uppercase `%XX` of its UTF-8 bytes. `keep_slash` is used for
/// the canonical URI, where path separators must survive.
fn encode(value: &str, keep_slash: bool) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char);
            }
            b'/' if keep_slash => encoded.push('/'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hmac_sha256(key: &[u8], value: &[u8]) -> Vec<u8> {
    const BLOCK: usize = 64;
    let mut normalized = [0u8; BLOCK];
    if key.len() > BLOCK {
        normalized[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        normalized[..key.len()].copy_from_slice(key);
    }
    let mut inner = Vec::with_capacity(BLOCK + value.len());
    let mut outer = Vec::with_capacity(BLOCK + 32);
    for byte in normalized {
        inner.push(byte ^ 0x36);
        outer.push(byte ^ 0x5c);
    }
    inner.extend_from_slice(value);
    outer.extend_from_slice(&Sha256::digest(&inner));
    Sha256::digest(&outer).to_vec()
}

/// Parses the `Last-Modified` / `Date` shape S3 returns
/// (`Wed, 21 Oct 2015 07:28:00 GMT`).
///
/// Also accepts the ISO form because COS and some S3-compatible gateways emit
/// it. Returns epoch milliseconds: second granularity is the protocol's, so the
/// low three digits are always zero.
pub fn parse_http_date(value: &str) -> Option<i64> {
    let value = value.trim();
    for format in [
        "%a, %d %b %Y %H:%M:%S GMT",
        "%Y-%m-%dT%H:%M:%S%.fZ",
        "%Y-%m-%dT%H:%M:%SZ",
    ] {
        if let Ok(parsed) = chrono::NaiveDateTime::parse_from_str(value, format) {
            return Some(parsed.and_utc().timestamp_millis());
        }
    }
    None
}

/// Extracts the parts of a `ListObjectsV2` response the engine uses.
///
/// This is a fixed-shape reader, not an XML parser: it understands `<Contents>`
/// and `<CommonPrefixes>` blocks plus `<NextContinuationToken>`, and decodes the five
/// predefined entities plus numeric references. S3 escapes keys, so an
/// `&amp;`-heavy name must still round-trip.
pub fn parse_list_page(xml: &str) -> ListPage {
    let mut objects = Vec::new();
    let mut common_prefixes = Vec::new();
    let mut cursor = None;
    let mut rest = xml;
    while let Some(start) = rest.find("<Contents>") {
        let after = &rest[start + "<Contents>".len()..];
        let Some(end) = after.find("</Contents>") else {
            break;
        };
        let block = &after[..end];
        if let (Some(key), Some(last_modified)) = (tag(block, "Key"), tag(block, "LastModified")) {
            objects.push(ListedObject {
                key,
                last_modified,
                size: tag(block, "Size")
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0),
                etag: tag(block, "ETag").unwrap_or_default(),
            });
        }
        rest = &after[end + "</Contents>".len()..];
    }
    let mut rest = xml;
    while let Some(start) = rest.find("<CommonPrefixes>") {
        let after = &rest[start + "<CommonPrefixes>".len()..];
        let Some(end) = after.find("</CommonPrefixes>") else {
            break;
        };
        if let Some(prefix) = tag(&after[..end], "Prefix") {
            common_prefixes.push(prefix);
        }
        rest = &after[end + "</CommonPrefixes>".len()..];
    }
    if let Some(value) = tag(xml, "NextContinuationToken") {
        if !value.is_empty() {
            cursor = Some(value);
        }
    }
    let truncated = tag(xml, "IsTruncated")
        .map(|value| value == "true")
        .unwrap_or(false);
    if !truncated {
        cursor = None;
    }
    ListPage {
        objects,
        common_prefixes,
        next_cursor: cursor,
        server_date_millis: None,
    }
}

fn tag(block: &str, name: &str) -> Option<String> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = block.find(&open)? + open.len();
    let end = block[start..].find(&close)? + start;
    Some(decode_entities(&block[start..end]))
}

fn decode_entities(value: &str) -> String {
    if !value.contains('&') {
        return value.to_string();
    }
    let mut decoded = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(index) = rest.find('&') {
        decoded.push_str(&rest[..index]);
        let tail = &rest[index..];
        let Some(end) = tail.find(';') else {
            decoded.push_str(tail);
            return decoded;
        };
        let entity = &tail[1..end];
        match entity {
            "amp" => decoded.push('&'),
            "lt" => decoded.push('<'),
            "gt" => decoded.push('>'),
            "quot" => decoded.push('"'),
            "apos" => decoded.push('\''),
            _ => match numeric_entity(entity) {
                Some(character) => decoded.push(character),
                None => decoded.push_str(&tail[..=end]),
            },
        }
        rest = &tail[end + 1..];
    }
    decoded.push_str(rest);
    decoded
}

fn numeric_entity(entity: &str) -> Option<char> {
    let code = match entity
        .strip_prefix("#x")
        .or_else(|| entity.strip_prefix("#X"))
    {
        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
        None => entity.strip_prefix('#')?.parse().ok()?,
    };
    char::from_u32(code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn incomplete_listings_are_not_treated_as_empty_or_complete() {
        for xml in [
            "",
            "<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>",
            "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>x</Key></ListBucketResult>",
            "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>x</Key></Contents></ListBucketResult>",
        ] {
            assert!(validate_list_response(xml).is_err(), "{xml}");
        }
        assert!(validate_list_response(
            "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"
        )
        .is_ok());
        assert!(validate_list_response("<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken></ListBucketResult>").is_ok());
    }

    fn credentials(mode: &str) -> ObjectStoreCredentials {
        ObjectStoreCredentials {
            backend_id: "r2-primary".into(),
            scheme: "s3-v4".into(),
            endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com".into(),
            bucket: "flowix-blobs".into(),
            region: "auto".into(),
            access_key_id: "parent-access-key".into(),
            secret_access_key: "parent-secret-key".into(),
            session_token: Some("jwt.header.payload".into()),
            token_header: "x-amz-security-token".into(),
            meta_prefix: "x-amz-meta-".into(),
            prefix: "u/usr_abc12345/".into(),
            mode: mode.into(),
            expires_at: 1_800_000_000_000,
        }
    }

    #[test]
    fn signs_cos_bucket_list_with_temporary_token() {
        let mut cred = credentials("read");
        cred.scheme = "cos-v5".into();
        cred.endpoint = "https://flowix-123.cos.ap-guangzhou.myqcloud.com".into();
        cred.secret_access_key = "test-secret".into();
        cred.token_header = "x-cos-security-token".into();
        let query = vec![
            ("list-type".into(), "2".into()),
            ("prefix".into(), "u/usr_a/".into()),
        ];
        let signed = sign_get(
            &cred,
            &query,
            DateTime::from_timestamp(1795521600, 0).unwrap(),
        )
        .unwrap();
        assert_eq!(
            signed.url,
            "https://flowix-123.cos.ap-guangzhou.myqcloud.com/?list-type=2&prefix=u%2Fusr_a%2F"
        );
        assert!(signed
            .headers
            .iter()
            .any(|(k, v)| k == "x-cos-security-token" && v == "jwt.header.payload"));
        assert!(signed.headers.iter().any(|(k, v)| k == "authorization"
            && v.ends_with("q-signature=c991a035d92152191c51ac1a2d6039525315dc36")));
    }

    #[test]
    fn signs_cos_put_with_decoded_unicode_and_reserved_characters() {
        let mut cred = credentials("write");
        cred.scheme = "cos-v5".into();
        cred.endpoint = "https://flowix-123.cos.ap-guangzhou.myqcloud.com".into();
        cred.secret_access_key = "test-secret".into();
        let signed = sign_request(
            &cred,
            &SignInput {
                method: "PUT",
                key: Some("u/usr_a/文章/a +%#?.md"),
                query: &[],
                headers: &[],
                payload_hash: PAYLOAD_HASH_GET,
            },
            DateTime::from_timestamp(1795521600, 0).unwrap(),
        )
        .unwrap();
        assert_eq!(signed.url, "https://flowix-123.cos.ap-guangzhou.myqcloud.com/u/usr_a/%E6%96%87%E7%AB%A0/a%20%2B%25%23%3F.md");
        assert!(signed.headers.iter().any(|(k, v)| k == "authorization"
            && v.ends_with("q-signature=030590264a52f27ced4a6e851ba67d4914c13cd4")));
    }

    /// RFC 4231 test case 1 — proves the hand-rolled HMAC is a real HMAC.
    #[test]
    fn hmac_matches_rfc4231_vector() {
        let signature = hmac_sha256(&[0x0b; 20], b"Hi There");
        assert_eq!(
            hex(&signature),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
        );
    }

    #[test]
    fn signs_a_list_request_over_the_issued_prefix() {
        let now = Utc.with_ymd_and_hms(2026, 11, 22, 8, 0, 0).unwrap();
        let query = vec![
            ("list-type".to_string(), "2".to_string()),
            ("prefix".to_string(), "u/usr_abc12345/projects/".to_string()),
            ("max-keys".to_string(), "1000".to_string()),
        ];
        let signed = sign_get(&credentials("read"), &query, now).unwrap();

        // Query parameters are sorted, so the URL is stable across calls.
        assert_eq!(
            signed.url,
            "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/flowix-blobs/\
             ?list-type=2&max-keys=1000&prefix=u%2Fusr_abc12345%2Fprojects%2F",
        );
        let lookup = |name: &str| {
            signed
                .headers
                .iter()
                .find(|(header, _)| header.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.clone())
        };
        assert_eq!(
            lookup("host"),
            None,
            "host rides on the URL, not as a header"
        );
        assert_eq!(lookup("x-amz-date").as_deref(), Some("20261122T080000Z"));
        assert_eq!(
            lookup("x-amz-content-sha256").as_deref(),
            Some(PAYLOAD_HASH_GET)
        );
        assert_eq!(
            lookup("x-amz-security-token").as_deref(),
            Some("jwt.header.payload")
        );
        let authorization = lookup("authorization").expect("authorization header");
        assert!(authorization.starts_with(
            "AWS4-HMAC-SHA256 Credential=parent-access-key/20261122/auto/s3/aws4_request, \
             SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=",
        ));
        assert_eq!(authorization.rsplit('=').next().unwrap().len(), 64);
    }

    #[test]
    fn list_queries_stay_inside_the_scope_and_can_ask_for_one_level() {
        let credentials = credentials("read");

        // The `s/` listing wants every nested directory, so no delimiter.
        let recursive = list_query(&credentials, "nb/nb_7/s/", None, None);
        assert_eq!(
            recursive[1],
            (
                "prefix".to_string(),
                "u/usr_abc12345/nb/nb_7/s/".to_string()
            ),
        );
        assert!(recursive.iter().all(|(name, _)| name != "delimiter"));

        // A file listing must be one level: without the delimiter, the root
        // would return the entire notebook and the L1 gate would be pointless.
        let one_level = list_query(&credentials, "nb/nb_7/f/notes/", Some("1ueG"), Some("/"));
        assert_eq!(
            one_level.last(),
            Some(&("delimiter".to_string(), "/".to_string())),
        );
        assert_eq!(
            one_level[3],
            ("continuation-token".to_string(), "1ueG".to_string())
        );
    }

    #[test]
    fn encodings_follow_sigv4_rules() {
        assert_eq!(encode("a b/c~d", true), "a%20b/c~d");
        assert_eq!(
            encode("项目/规划.md", true),
            "%E9%A1%B9%E7%9B%AE/%E8%A7%84%E5%88%92.md"
        );
        assert_eq!(encode("a/b", false), "a%2Fb");
    }

    #[test]
    fn parses_pages_and_decodes_escaped_keys() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <CommonPrefixes><Prefix>u/usr_abc12345/nb/nb_7/</Prefix></CommonPrefixes>
  <Contents>
    <Key>u/usr_abc12345/R&amp;D/plan.md</Key>
    <LastModified>2026-11-22T07:59:58.000Z</LastModified>
    <ETag>&quot;d41d8cd98f00b204e9800998ecf8427e&quot;</ETag>
    <Size>12844</Size>
  </Contents>
  <NextContinuationToken>1ueGcxLPRx1Tr</NextContinuationToken>
</ListBucketResult>"#;
        let page = parse_list_page(xml);
        assert_eq!(page.objects.len(), 1);
        assert_eq!(page.objects[0].key, "u/usr_abc12345/R&D/plan.md");
        assert_eq!(page.objects[0].size, 12844);
        assert_eq!(page.objects[0].last_modified, "2026-11-22T07:59:58.000Z");
        assert_eq!(page.common_prefixes, ["u/usr_abc12345/nb/nb_7/"]);
        assert_eq!(page.next_cursor.as_deref(), Some("1ueGcxLPRx1Tr"));

        // A non-truncated page must not report a cursor even if one leaks in.
        let last = xml.replace(
            "<IsTruncated>true</IsTruncated>",
            "<IsTruncated>false</IsTruncated>",
        );
        assert_eq!(parse_list_page(&last).next_cursor, None);
        assert!(parse_list_page("").objects.is_empty());
    }

    /// The route serialises camelCase; a rename on either side must fail here
    /// rather than at runtime on a user's first sync.
    #[test]
    fn deserializes_the_cloud_contract() {
        let json = r#"{
          "data": {
            "backendId": "r2-primary", "scheme": "s3-v4",
            "endpoint": "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
            "bucket": "flowix-blobs", "region": "auto",
            "accessKeyId": "parent-access-key", "secretAccessKey": "derived",
            "sessionToken": "jwt.a.b", "tokenHeader": "x-amz-security-token",
            "prefix": "u/usr_abc12345/", "mode": "read-write",
            "expiresAt": 1800000000000
          },
          "quota": { "mode": "read-write", "limitBytes": 5368709120, "expiresAt": 1800000000000 }
        }"#;
        let envelope: StorageCredentialEnvelope = serde_json::from_str(json).unwrap();
        assert_eq!(envelope.data.prefix, "u/usr_abc12345/");
        assert_eq!(envelope.data.token_header, "x-amz-security-token");
        // Absent in this payload, so the S3 default applies — but a COS
        // deployment must be able to override it.
        assert_eq!(envelope.data.meta_prefix, "x-amz-meta-");
        assert_eq!(
            envelope.data.meta_header("contenthash"),
            "x-amz-meta-contenthash"
        );
        assert!(envelope.data.can_write());
        assert_eq!(envelope.quota.unwrap().limit_bytes, Some(5_368_709_120));
    }

    #[test]
    fn keeps_keys_inside_the_issued_prefix() {
        let read_only = credentials("read");
        assert_eq!(
            read_only.scoped_key("notes/a.md"),
            "u/usr_abc12345/notes/a.md"
        );
        assert_eq!(
            read_only.scoped_key("/notes/a.md"),
            "u/usr_abc12345/notes/a.md"
        );
        assert!(!read_only.can_write());
        assert!(credentials("read-write").can_write());
        assert!(read_only.is_fresh(read_only.expires_at - 61_000));
        assert!(!read_only.is_fresh(read_only.expires_at - 30_000));
    }

    /// A credential is the one value that routinely ends up in a debug log or a
    /// panic message; neither may carry the secret.
    #[test]
    fn debug_output_never_carries_the_secret() {
        let mut value = credentials("read-write");
        value.session_token = Some("jwt.header.payload".into());
        let rendered = format!("{value:?}");
        assert!(!rendered.contains("parent-secret-key"), "{rendered}");
        assert!(!rendered.contains("jwt.header.payload"), "{rendered}");
        // Identifying fields stay, or the line is useless for support.
        assert!(rendered.contains("flowix-blobs"));
        assert!(rendered.contains("u/usr_abc12345/"));
    }

    struct RotatingResolver {
        rejected: ObjectStoreCredentials,
        refreshed: ObjectStoreCredentials,
        refresh_calls: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl CredentialResolver for RotatingResolver {
        async fn resolve(&self, _now_millis: i64) -> Result<ObjectStoreCredentials, SyncError> {
            Ok(self.rejected.clone())
        }

        async fn refresh_after_rejection(
            &self,
            _now_millis: i64,
            _rejected: &ObjectStoreCredentials,
        ) -> Result<ObjectStoreCredentials, SyncError> {
            self.refresh_calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.refreshed.clone())
        }
    }

    #[tokio::test]
    async fn retries_once_with_rotated_credentials_after_expired_token() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for (status, code, expected_credential) in [
                (403, "ExpiredToken", "old-access-key"),
                (200, "", "new-access-key"),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                loop {
                    let read = stream.read(&mut buffer).unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                    if request.windows(4).any(|part| part == b"\r\n\r\n") {
                        break;
                    }
                }
                assert!(String::from_utf8_lossy(&request)
                    .to_ascii_lowercase()
                    .contains(&format!("x-test-credential: {expected_credential}")));
                let body = if code.is_empty() {
                    "<Result/>".to_string()
                } else {
                    format!("<Error><Code>{code}</Code></Error>")
                };
                let reason = if status == 200 { "OK" } else { "Forbidden" };
                write!(
                    stream,
                    "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
        });

        let mut rejected = credentials("read");
        rejected.endpoint = endpoint;
        rejected.access_key_id = "old-access-key".into();
        let mut refreshed = rejected.clone();
        refreshed.access_key_id = "new-access-key".into();
        refreshed.secret_access_key = "new-secret-key".into();
        refreshed.session_token = Some("new-session-token".into());
        let resolver = RotatingResolver {
            rejected,
            refreshed,
            refresh_calls: AtomicUsize::new(0),
        };
        let http = reqwest::Client::new();
        let response =
            send_with_credential_renewal(&resolver, "other", "list", |credentials, now| {
                let query = Vec::new();
                let signed = sign_get(credentials, &query, now)?;
                let mut request = http.get(&signed.url);
                for (name, value) in &signed.headers {
                    request = request.header(name, value);
                }
                Ok(request.header("x-test-credential", &credentials.access_key_id))
            })
            .await
            .unwrap();
        server.join().unwrap();

        assert!(response.status.is_success());
        assert_eq!(response.credentials.access_key_id, "new-access-key");
        assert_eq!(resolver.refresh_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn only_explicit_temporary_token_errors_trigger_renewal() {
        assert!(is_expired_token_response(
            reqwest::StatusCode::FORBIDDEN,
            b"<Error><Code>ExpiredToken</Code></Error>"
        ));
        assert!(is_expired_token_response(
            reqwest::StatusCode::BAD_REQUEST,
            b"<Error><Code>TokenRefreshRequired</Code></Error>"
        ));
        assert!(!is_expired_token_response(
            reqwest::StatusCode::FORBIDDEN,
            b"<Error><Code>AccessDenied</Code></Error>"
        ));
        assert!(!is_expired_token_response(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            b"<Error><Code>ExpiredToken</Code></Error>"
        ));
    }
}
