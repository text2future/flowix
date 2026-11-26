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

mod credentials;
mod listing;
mod signing;
mod transport;

pub use credentials::{
    ClockSkew, CredentialResolver, ObjectStoreCredentials, StorageCredentialEnvelope, StorageQuota,
};
pub use listing::{list_prefix, parse_http_date, parse_list_page, ListPage, ListedObject};
pub use signing::{sign_get, SignedRequest};

pub(crate) use signing::{sign_request, SignInput};
pub(crate) use transport::send_with_credential_renewal;

#[cfg(test)]
pub(crate) use listing::{list_query, validate_list_response};
#[cfg(test)]
pub(crate) use signing::{encode, hex, hmac_sha256, PAYLOAD_HASH_GET};
#[cfg(test)]
pub(crate) use transport::is_expired_token_response;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::SyncError;
    use chrono::{DateTime, TimeZone, Utc};
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
            "backendId": "r2-primary", "scheme": "s3-state",
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
        let http = crate::http::HttpClient::pinned(reqwest::Client::new());
        let response = send_with_credential_renewal(
            &http,
            &resolver,
            "other",
            "list",
            |http, credentials, now| {
                let query = Vec::new();
                let signed = sign_get(credentials, &query, now)?;
                let mut request = http.get(&signed.url);
                for (name, value) in &signed.headers {
                    request = request.header(name, value);
                }
                Ok(request.header("x-test-credential", &credentials.access_key_id))
            },
        )
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
