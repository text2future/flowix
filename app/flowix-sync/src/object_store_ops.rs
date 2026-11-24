//! Object read/write against the bucket, signed by the client.
//!
//! `object_store` covers enumeration and the SigV4 primitive; this module adds
//! the read, write, and tombstone operations used by the path sync pass.
//!
//! The one design decision embedded here: **`upload` ends with a `HEAD`.**
//! A `PUT` response carries no `Last-Modified`, so a baseline taken from the
//! response `Date` header can be up to a second behind the value `list` will
//! report. The next pass would then see `remote.mtime > baseline` on a file
//! this device just wrote, call it `download:remote-new`, and pull its own
//! bytes back — every save, forever. One extra `HEAD` (a Class B operation,
//! ~$0.000002) buys an exact baseline and removes that whole class of bug.

use chrono::Utc;
use sha2::{Digest, Sha256};

use crate::error::SyncError;
use crate::object_store::{
    parse_http_date, send_with_credential_renewal, sign_request, CredentialResolver,
    ObjectStoreCredentials, SignInput,
};
use crate::reconcile::RemoteObject;

const EMPTY_PAYLOAD_HASH: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// Metadata field names, without the backend-dependent prefix.
const META_CONTENT_HASH: &str = "contenthash";
const META_DELETED: &str = "deleted";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadedObject {
    pub remote: RemoteObject,
    pub bytes: Vec<u8>,
}

/// Uploads `body` and returns the object as the server now sees it.
///
/// `content_hash` is the `sha256:<hex>` of `body`; it travels as object
/// metadata so a later pass (or a `HEAD`) can compare without downloading.
pub async fn upload(
    http: &reqwest::Client,
    credential_resolver: &dyn CredentialResolver,
    key: &str,
    body: bytes::Bytes,
    content_hash: &str,
) -> Result<RemoteObject, SyncError> {
    upload_with_progress(http, credential_resolver, key, body, content_hash, || ()).await
}

/// Takes the body by value: a `PUT` may be retried once after a credential
/// renewal, and a `Bytes` clone is a refcount bump where a `&[u8]` would force
/// a full copy of the object per attempt.
pub(crate) async fn upload_with_progress<G>(
    http: &reqwest::Client,
    credential_resolver: &dyn CredentialResolver,
    key: &str,
    body: bytes::Bytes,
    content_hash: &str,
    start: impl FnOnce() -> G,
) -> Result<RemoteObject, SyncError> {
    let metadata_credentials = credential_resolver
        .resolve(Utc::now().timestamp_millis())
        .await?;
    let transfer = start();
    let result = put(
        http,
        credential_resolver,
        key,
        body,
        &[
            (
                metadata_credentials.meta_header(META_CONTENT_HASH),
                content_hash.to_string(),
            ),
            (
                metadata_credentials.meta_header(META_DELETED),
                "0".to_string(),
            ),
        ],
    )
    .await;
    drop(transfer);
    result?;
    head(http, credential_resolver, key).await?.ok_or_else(|| {
        SyncError::InvalidState(format!(
            "object {key} vanished between PUT and HEAD; the bucket is not consistent"
        ))
    })
}

/// Writes the zero-byte deletion marker. The key stays, which is what keeps
/// "deleted in the cloud" and "never uploaded" distinguishable (§5).
pub async fn write_tombstone(
    http: &reqwest::Client,
    credential_resolver: &dyn CredentialResolver,
    key: &str,
    etag: &str,
) -> Result<RemoteObject, SyncError> {
    let metadata_credentials = credential_resolver
        .resolve(Utc::now().timestamp_millis())
        .await?;
    put_object(
        http,
        credential_resolver,
        key,
        bytes::Bytes::new(),
        "application/octet-stream",
        &[
            (
                metadata_credentials.meta_header(META_DELETED),
                "1".to_string(),
            ),
            (
                "if-match".to_string(),
                format!("\"{}\"", etag.trim().trim_matches('"')),
            ),
        ],
    )
    .await?;
    let remote = head(http, credential_resolver, key).await?.ok_or_else(|| {
        SyncError::InvalidState(format!("tombstone {key} vanished between PUT and HEAD"))
    })?;
    if !remote.tombstone {
        return Err(SyncError::InvalidState(format!(
            "{key} changed while its tombstone was being written; deletion remains pending"
        )));
    }
    Ok(remote)
}

/// `None` means the key does not exist (404), which is evidence, not an error.
pub async fn head(
    http: &reqwest::Client,
    credential_resolver: &dyn CredentialResolver,
    key: &str,
) -> Result<Option<RemoteObject>, SyncError> {
    let response = send_with_credential_renewal(
        credential_resolver,
        crate::telemetry::category(key),
        "head",
        |credentials, now| {
            let scoped = credentials.scoped_key(key);
            let signed = sign_request(
                credentials,
                &SignInput {
                    method: "HEAD",
                    key: Some(&scoped),
                    query: &[],
                    headers: &[],
                    payload_hash: EMPTY_PAYLOAD_HASH,
                },
                now,
            )?;
            let mut request = http.head(&signed.url);
            for (name, value) in &signed.headers {
                request = request.header(name, value);
            }
            Ok(request)
        },
    )
    .await?;
    if response.status.as_u16() == 404 {
        return Ok(None);
    }
    if !response.status.is_success() {
        let body = String::from_utf8_lossy(&response.body);
        return Err(api_error(
            "OBJECT_STORE_HEAD_FAILED",
            response.status.as_u16(),
            &body,
        ));
    }
    Ok(Some(remote_from_headers(
        &response.credentials,
        key,
        &response.headers,
    )))
}

/// `None` means the key does not exist.
pub async fn download(
    http: &reqwest::Client,
    credential_resolver: &dyn CredentialResolver,
    key: &str,
) -> Result<Option<DownloadedObject>, SyncError> {
    let response = send_with_credential_renewal(
        credential_resolver,
        crate::telemetry::category(key),
        "get",
        |credentials, now| {
            let scoped = credentials.scoped_key(key);
            let signed = sign_request(
                credentials,
                &SignInput {
                    method: "GET",
                    key: Some(&scoped),
                    query: &[],
                    headers: &[],
                    payload_hash: EMPTY_PAYLOAD_HASH,
                },
                now,
            )?;
            let mut request = http.get(&signed.url);
            for (name, value) in &signed.headers {
                request = request.header(name, value);
            }
            Ok(request)
        },
    )
    .await?;
    if response.status.as_u16() == 404 {
        return Ok(None);
    }
    if !response.status.is_success() {
        let body = String::from_utf8_lossy(&response.body);
        return Err(api_error(
            "OBJECT_STORE_GET_FAILED",
            response.status.as_u16(),
            &body,
        ));
    }
    let remote = remote_from_headers(&response.credentials, key, &response.headers);
    let bytes = response.body;
    Ok(Some(DownloadedObject { remote, bytes }))
}

async fn put(
    http: &reqwest::Client,
    credential_resolver: &dyn CredentialResolver,
    key: &str,
    body: bytes::Bytes,
    metadata: &[(String, String)],
) -> Result<(), SyncError> {
    put_object(
        http,
        credential_resolver,
        key,
        body,
        "application/octet-stream",
        metadata,
    )
    .await
}

/// One `PUT`, with the content type and caller-supplied headers spelled out.
///
/// All headers participate in the SigV4 signature and reach the wire through
/// `SignedRequest`; callers can include metadata and conditional headers.
pub async fn put_object(
    http: &reqwest::Client,
    credential_resolver: &dyn CredentialResolver,
    key: &str,
    body: bytes::Bytes,
    content_type: &str,
    metadata: &[(String, String)],
) -> Result<(), SyncError> {
    let payload_hash = hex(&Sha256::digest(&body));
    let mut headers = vec![("content-type".to_string(), content_type.to_string())];
    headers.extend(metadata.iter().cloned());
    let response = send_with_credential_renewal(
        credential_resolver,
        crate::telemetry::category(key),
        "put",
        |credentials, now| {
            let scoped = credentials.scoped_key(key);
            let signed = sign_request(
                credentials,
                &SignInput {
                    method: "PUT",
                    key: Some(&scoped),
                    query: &[],
                    headers: &headers,
                    payload_hash: &payload_hash,
                },
                now,
            )?;
            // Some S3 gateways reject empty PUTs unless Content-Length is
            // explicit. This also covers zero-byte notes and tombstones.
            //
            // Cloning `Bytes` keeps the retry path allocation-free; the
            // previous `copy_from_slice` duplicated the whole object once per
            // attempt, which for attachments meant a second full-size buffer
            // per in-flight upload.
            let bytes = body.clone();
            let progress = crate::telemetry::progress_callback();
            let stream =
                futures_util::stream::unfold((bytes, progress), |(bytes, progress)| async move {
                    if bytes.is_empty() {
                        return None;
                    }
                    let length = bytes.len().min(64 * 1024);
                    let chunk = bytes.slice(..length);
                    let rest = bytes.slice(length..);
                    if let Some(notify) = &progress {
                        notify();
                    }
                    Some((Ok::<_, std::io::Error>(chunk), (rest, progress)))
                });
            let mut request = http
                .put(&signed.url)
                .header(reqwest::header::CONTENT_LENGTH, body.len())
                .body(reqwest::Body::wrap_stream(stream));
            for (name, value) in &signed.headers {
                request = request.header(name, value);
            }
            Ok(request)
        },
    )
    .await?;
    if response.status.is_success() {
        Ok(())
    } else {
        let body = String::from_utf8_lossy(&response.body);
        Err(api_error(
            "OBJECT_STORE_PUT_FAILED",
            response.status.as_u16(),
            &body,
        ))
    }
}

/// Builds a [`RemoteObject`] from response headers.
///
/// Tombstone detection reads the marker rather than the size: a legitimate
/// empty note is also zero bytes, so size cannot distinguish them.
fn remote_from_headers(
    credentials: &ObjectStoreCredentials,
    key: &str,
    headers: &reqwest::header::HeaderMap,
) -> RemoteObject {
    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    let relative = key
        .strip_prefix(&credentials.prefix)
        .unwrap_or(key)
        .to_string();

    let mtime = header("last-modified")
        .and_then(parse_http_date)
        .or_else(|| header("date").and_then(parse_http_date))
        .unwrap_or(0);
    let size = header("content-length")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let etag = header("etag").map(|value| value.trim_matches('"').to_string());
    let content_hash = header(&credentials.meta_header(META_CONTENT_HASH)).map(str::to_string);
    let tombstone = header(&credentials.meta_header(META_DELETED)) == Some("1");

    RemoteObject {
        path: relative,
        mtime_millis: mtime,
        size,
        content_hash,
        etag,
        tombstone,
    }
}

fn api_error(code: &str, status: u16, body: &str) -> SyncError {
    SyncError::Api {
        status,
        code: code.to_string(),
        message: body.chars().take(400).collect(),
        details: None,
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::object_store::parse_http_date;

    fn credentials() -> ObjectStoreCredentials {
        ObjectStoreCredentials {
            backend_id: "r2-primary".into(),
            scheme: "s3-v4".into(),
            endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com".into(),
            bucket: "flowix-blobs".into(),
            region: "auto".into(),
            access_key_id: "parent-access-key".into(),
            secret_access_key: "parent-secret".into(),
            session_token: Some("jwt.a.b".into()),
            token_header: "x-amz-security-token".into(),
            meta_prefix: "x-amz-meta-".into(),
            prefix: "u/usr_abc12345/".into(),
            mode: "read-write".into(),
            expires_at: 1_800_000_000_000,
        }
    }

    #[tokio::test]
    async fn empty_put_sends_an_explicit_zero_content_length() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 1024];
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let count = stream.read(&mut chunk).unwrap();
                assert_ne!(count, 0);
                request.extend_from_slice(&chunk[..count]);
            }
            let headers = String::from_utf8(request).unwrap().to_ascii_lowercase();
            assert!(headers.starts_with("put "));
            assert!(
                headers
                    .lines()
                    .any(|line| line.trim() == "content-length: 0"),
                "{headers}"
            );
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .unwrap();
        });
        let mut credentials = credentials();
        credentials.endpoint = endpoint;
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        put_object(
            &http,
            &credentials,
            "nb/test/f/empty.md",
            bytes::Bytes::new(),
            "application/octet-stream",
            &[],
        )
        .await
        .unwrap();
        server.join().unwrap();
    }

    #[tokio::test]
    async fn upload_reports_progress_before_server_response() {
        use std::io::{Read, Write};
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let counter = Arc::new(AtomicUsize::new(0));
        let observed = counter.clone();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 8192];
            loop {
                let count = stream.read(&mut buf).unwrap();
                assert_ne!(count, 0);
                request.extend_from_slice(&buf[..count]);
                if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    if request.len() >= end + 4 + 150_000 {
                        break;
                    }
                }
            }
            assert!(observed.load(Ordering::SeqCst) >= 2);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .unwrap();
        });
        let mut credential = credentials();
        credential.endpoint = endpoint;
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let progress = Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        crate::telemetry::observe_sync_with_progress(
            async {
                put_object(
                    &http,
                    &credential,
                    "nb/test/f/large.bin",
                    bytes::Bytes::from(vec![7; 150_000]),
                    "application/octet-stream",
                    &[],
                )
                .await
                .unwrap();
            },
            progress,
            |_| {},
        )
        .await;
        server.join().unwrap();
    }

    /// `Last-Modified` is the only trustworthy clock in the design, so its
    /// parser is worth pinning: a silent `None` would make every object look
    /// like it was written at epoch 0.
    #[test]
    fn parses_the_header_shapes_buckets_emit() {
        let rfc = parse_http_date("Wed, 21 Oct 2015 07:28:00 GMT").unwrap();
        assert_eq!(rfc, 1_445_412_480_000);
        assert_eq!(parse_http_date("2015-10-21T07:28:00Z").unwrap(), rfc);
        assert_eq!(parse_http_date("2015-10-21T07:28:00.000Z").unwrap(), rfc);
        assert_eq!(
            parse_http_date("  Wed, 21 Oct 2015 07:28:00 GMT  ").unwrap(),
            rfc
        );
        assert_eq!(parse_http_date("not a date"), None);
    }

    #[test]
    fn tombstones_are_detected_by_marker_not_by_size() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("content-length", "0".parse().unwrap());
        headers.insert(
            "last-modified",
            "Wed, 21 Oct 2015 07:28:00 GMT".parse().unwrap(),
        );
        headers.insert("x-amz-meta-deleted", "1".parse().unwrap());
        headers.insert("x-amz-meta-contenthash", "sha256:aa".parse().unwrap());

        let object = remote_from_headers(&credentials(), "u/usr_abc12345/nb/f/a.md", &headers);
        assert!(object.tombstone);
        assert_eq!(object.path, "nb/f/a.md", "the scope prefix is stripped");
        assert_eq!(object.content_hash.as_deref(), Some("sha256:aa"));
        assert_eq!(object.mtime_millis, 1_445_412_480_000);

        // A real empty note carries `deleted=0` and must stay a file.
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("content-length", "0".parse().unwrap());
        headers.insert("x-amz-meta-deleted", "0".parse().unwrap());
        assert!(
            !remote_from_headers(&credentials(), "u/usr_abc12345/nb/f/empty.md", &headers)
                .tombstone
        );
    }

    /// A gateway that omits `Last-Modified` (some COS responses) must still
    /// produce a usable object rather than panicking or inventing a time.
    #[test]
    fn missing_headers_degrade_to_zero_instead_of_failing() {
        let object = remote_from_headers(
            &credentials(),
            "u/usr_abc12345/a.md",
            &reqwest::header::HeaderMap::new(),
        );
        assert_eq!(object.mtime_millis, 0);
        assert_eq!(object.size, 0);
        assert_eq!(object.content_hash, None);
        assert!(!object.tombstone);
    }

    #[test]
    fn metadata_header_follows_the_declared_prefix() {
        assert_eq!(
            credentials().meta_header("contenthash"),
            "x-amz-meta-contenthash"
        );
        let mut cos = credentials();
        cos.meta_prefix = "x-cos-meta-".into();
        assert_eq!(cos.meta_header("contenthash"), "x-cos-meta-contenthash");
    }
}

