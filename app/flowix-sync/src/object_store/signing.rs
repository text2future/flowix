//! Request signing: SigV4 for S3-compatible stores, COS v5 for Tencent COS.
//!
//! Both produce a URL plus the headers that have to travel with it, so the
//! caller never assembles an authorization header itself.

use chrono::{DateTime, Utc};
use sha1::Sha1;
use sha2::{Digest, Sha256};

use super::credentials::ObjectStoreCredentials;
use crate::error::SyncError;

pub(crate) const PAYLOAD_HASH_GET: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ALGORITHM: &str = "AWS4-HMAC-SHA256";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
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
pub(crate) fn encode(value: &str, keep_slash: bool) -> String {
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

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn hmac_sha256(key: &[u8], value: &[u8]) -> Vec<u8> {
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
