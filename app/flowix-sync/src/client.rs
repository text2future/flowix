use reqwest::Method;
use serde::de::DeserializeOwned;
use serde_json::json;

use crate::error::SyncError;
use crate::models::{
    ApiErrorEnvelope, AppleAuthChallenge, AppleAuthorization, AuthData, CloudCheckout,
    CloudProduct, DataEnvelope, EntitlementData, MeData, RefreshData,
};
use crate::v2::{
    V2BlobDownloadEnvelope, V2BlobReservationEnvelope, V2Bootstrap, V2ChangesPage, V2History, V2PushOperation,
    V2PushResult, V2SyncStatus, PROTOCOL_EPOCH,
};

fn apple_authorization_body(authorization: &AppleAuthorization) -> serde_json::Value {
    let mut body = serde_json::Map::from_iter([
        (
            "challengeId".to_string(),
            serde_json::Value::String(authorization.challenge_id.clone()),
        ),
        (
            "nonce".to_string(),
            serde_json::Value::String(authorization.nonce.clone()),
        ),
        (
            "identityToken".to_string(),
            serde_json::Value::String(authorization.identity_token.clone()),
        ),
        (
            "authorizationCode".to_string(),
            serde_json::Value::String(authorization.authorization_code.clone()),
        ),
    ]);
    if let Some(display_name) = &authorization.display_name {
        body.insert(
            "displayName".to_string(),
            serde_json::Value::String(display_name.clone()),
        );
    }
    serde_json::Value::Object(body)
}

#[derive(Clone)]
pub struct CloudClient {
    base_url: String,
    http: reqwest::Client,
}

impl CloudClient {
    pub fn new(base_url: impl Into<String>) -> Result<Self, SyncError> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()?;
        Ok(Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            http,
        })
    }

    async fn send<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        token: Option<&str>,
        body: Option<serde_json::Value>,
    ) -> Result<T, SyncError> {
        let mut request = self
            .http
            .request(method, format!("{}{}", self.base_url, path));
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await?;
        Self::decode(response).await
    }

    async fn decode<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, SyncError> {
        let status = response.status();
        let request_id = response.headers().get("x-request-id")
            .and_then(|value| value.to_str().ok()).map(str::to_owned);
        let bytes = response.bytes().await?;
        if !status.is_success() {
            let parsed = serde_json::from_slice::<ApiErrorEnvelope>(&bytes).ok();
            let mut message = parsed
                .as_ref()
                .map(|value| value.error.message.clone())
                .unwrap_or_else(|| String::from_utf8_lossy(&bytes).into_owned());
            if let Some(request_id) = request_id {
                message.push_str(&format!(" (request id: {request_id})"));
            }
            return Err(SyncError::Api {
                status: status.as_u16(),
                code: parsed
                    .as_ref()
                    .map(|value| value.error.code.clone())
                    .unwrap_or_else(|| "HTTP_ERROR".to_string()),
                message,
                details: parsed.and_then(|value| value.error.details),
            });
        }
        serde_json::from_slice(&bytes)
            .map_err(|error| SyncError::InvalidState(format!("invalid cloud response: {error}")))
    }

    pub(crate) async fn products(&self) -> Result<Vec<CloudProduct>, SyncError> {
        self.send::<DataEnvelope<Vec<CloudProduct>>>(
            Method::GET,
            "/v2/catalog/products",
            None,
            None,
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn checkout(
        &self,
        access_token: &str,
        product_id: &str,
        idempotency_key: &str,
    ) -> Result<CloudCheckout, SyncError> {
        let response = self
            .http
            .post(format!("{}/v2/billing/checkout", self.base_url))
            .bearer_auth(access_token)
            .header("Idempotency-Key", idempotency_key)
            .json(&json!({
                "productId": product_id,
                "successUrl": "flowix://billing/success",
                "cancelUrl": "flowix://billing/cancel",
            }))
            .send()
            .await?;
        Self::decode::<DataEnvelope<CloudCheckout>>(response)
            .await
            .map(|value| value.data)
    }

    pub(crate) async fn register(
        &self,
        email: &str,
        password: &str,
        display_name: &str,
    ) -> Result<AuthData, SyncError> {
        self.send::<DataEnvelope<AuthData>>(
            Method::POST,
            "/v1/auth/register",
            None,
            Some(json!({
                "email": email,
                "password": password,
                "displayName": display_name,
            })),
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn login(&self, email: &str, password: &str) -> Result<AuthData, SyncError> {
        self.send::<DataEnvelope<AuthData>>(
            Method::POST,
            "/v1/auth/login",
            None,
            Some(json!({ "email": email, "password": password })),
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn apple_challenge(&self) -> Result<AppleAuthChallenge, SyncError> {
        self.send::<DataEnvelope<AppleAuthChallenge>>(
            Method::POST,
            "/v1/auth/apple/challenge",
            None,
            None,
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn apple_exchange(
        &self,
        authorization: &AppleAuthorization,
    ) -> Result<AuthData, SyncError> {
        self.send::<DataEnvelope<AuthData>>(
            Method::POST,
            "/v1/auth/apple/exchange",
            None,
            Some(apple_authorization_body(authorization)),
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn google_desktop_exchange(
        &self,
        code: &str,
        state: &str,
        code_verifier: &str,
    ) -> Result<AuthData, SyncError> {
        self.send::<DataEnvelope<AuthData>>(
            Method::POST,
            "/v1/auth/google/desktop/exchange",
            None,
            Some(json!({ "code": code, "state": state, "codeVerifier": code_verifier })),
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn apple_link(
        &self,
        access_token: &str,
        authorization: &AppleAuthorization,
    ) -> Result<(), SyncError> {
        self.send::<DataEnvelope<serde_json::Value>>(
            Method::POST,
            "/v1/auth/apple/link",
            Some(access_token),
            Some(apple_authorization_body(authorization)),
        )
        .await
        .map(|_| ())
    }

    pub(crate) async fn refresh(&self, refresh_token: &str) -> Result<RefreshData, SyncError> {
        self.send::<DataEnvelope<RefreshData>>(
            Method::POST,
            "/v1/auth/refresh",
            None,
            Some(json!({ "refreshToken": refresh_token })),
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn logout_with_refresh_token(
        &self,
        refresh_token: &str,
    ) -> Result<(), SyncError> {
        let response = self
            .http
            .post(format!("{}/v1/auth/logout/refresh", self.base_url))
            .json(&json!({ "refreshToken": refresh_token }))
            .send()
            .await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Self::decode::<serde_json::Value>(response).await.map(|_| ())
        }
    }

    pub(crate) async fn me(&self, access_token: &str) -> Result<MeData, SyncError> {
        self.send::<DataEnvelope<MeData>>(Method::GET, "/v1/auth/me", Some(access_token), None)
            .await
            .map(|value| value.data)
    }

    pub(crate) async fn entitlements(
        &self,
        access_token: &str,
    ) -> Result<EntitlementData, SyncError> {
        self.send::<DataEnvelope<EntitlementData>>(
            Method::GET,
            "/v2/entitlements/current",
            Some(access_token),
            None,
        )
        .await
        .map(|value| value.data)
    }

    pub async fn v2_sync_status(
        &self,
        access_token: &str,
        cursor: i64,
    ) -> Result<V2SyncStatus, SyncError> {
        self.send::<DataEnvelope<V2SyncStatus>>(
            Method::GET,
            &format!("/v2/sync/status?cursor={cursor}"),
            Some(access_token),
            None,
        )
        .await
        .map(|value| value.data)
    }

    pub async fn v2_changes(
        &self,
        access_token: &str,
        cursor: i64,
        limit: usize,
    ) -> Result<V2ChangesPage, SyncError> {
        let limit = limit.clamp(1, 1_000);
        self.send::<DataEnvelope<V2ChangesPage>>(
            Method::GET,
            &format!("/v2/sync/changes?cursor={cursor}&limit={limit}"),
            Some(access_token),
            None,
        )
        .await
        .map(|value| value.data)
    }

    pub async fn v2_bootstrap_page(&self, access_token: &str, page_token: Option<&str>) -> Result<V2Bootstrap, SyncError> {
        let path = match page_token {
            Some(token) => format!("/v2/sync/bootstrap?limit=10&pageToken={token}"),
            None => "/v2/sync/bootstrap?limit=10".to_string(),
        };
        self.send::<DataEnvelope<V2Bootstrap>>(Method::GET, &path, Some(access_token), None)
            .await.map(|value| value.data)
    }

    pub async fn v2_history(&self, access_token: &str, note_id: &str) -> Result<V2History, SyncError> {
        let mut history = self.send::<DataEnvelope<V2History>>(
            Method::GET, &format!("/v2/sync/history?noteId={note_id}&limit=200"), Some(access_token), None,
        ).await?.data;
        let mut pages = 0;
        while let Some(before) = history.next_before_seq.take() {
            pages += 1;
            if pages > 10_000 {
                return Err(SyncError::InvalidState("history exceeded page limit".into()));
            }
            let page = self.send::<DataEnvelope<V2History>>(
                Method::GET,
                &format!("/v2/sync/history?noteId={note_id}&limit=200&beforeSeq={before}"),
                Some(access_token), None,
            ).await?.data;
            if page.note_id != history.note_id || page.current_revision != history.current_revision {
                return Err(SyncError::InvalidState("history head changed during pagination".into()));
            }
            history.revisions.extend(page.revisions);
            history.next_before_seq = page.next_before_seq;
        }
        Ok(history)
    }

    pub async fn v2_reserve_blob(
        &self,
        access_token: &str,
        content_hash: &str,
        size_bytes: i64,
        blob_kind: &str,
        content_type: &str,
    ) -> Result<V2BlobReservationEnvelope, SyncError> {
        self.send::<V2BlobReservationEnvelope>(
            Method::POST,
            "/v2/blobs/reservations",
            Some(access_token),
            Some(json!({
                "protocolEpoch": PROTOCOL_EPOCH,
                "contentHash": content_hash,
                "sizeBytes": size_bytes,
                "blobKind": blob_kind,
                "contentType": content_type,
            })),
        )
        .await
    }

    pub async fn v2_upload_blob(
        &self,
        access_token: &str,
        upload: &crate::v2::V2BlobUpload,
        content_type: &str,
        content: Vec<u8>,
    ) -> Result<(), SyncError> {
        if upload.method != "PUT" {
            return Err(SyncError::InvalidState(
                "cloud returned an unsupported v2 upload method".into(),
            ));
        }
        let content_length = content.len();
        let direct_upload = upload.url.is_some();
        let response = if let Some(url) = upload.url.as_deref() {
            Self::validate_direct_blob_url(url)?;
            let mut request = self
                .http
                .put(url)
                .header(reqwest::header::CONTENT_TYPE, content_type)
                .header(reqwest::header::CONTENT_LENGTH, content_length);
            for (name, value) in &upload.headers {
                if Self::allowed_capability_header(name) {
                    request = request.header(name, value);
                }
            }
            request.body(content).send().await?
        } else if let Some(upload_path) = upload.path.as_deref() {
            if !upload_path.starts_with("/v2/blobs/reservations/") {
                return Err(SyncError::InvalidState(
                    "cloud returned an invalid v2 upload path".into(),
                ));
            }
            self.http
                .put(format!("{}{}", self.base_url, upload_path))
                .bearer_auth(access_token)
                .header(reqwest::header::CONTENT_TYPE, content_type)
                .body(content)
                .send()
                .await?
        } else {
            return Err(SyncError::InvalidState(
                "cloud returned no v2 upload destination".into(),
            ));
        };
        if direct_upload && response.status().is_success() {
            // S3-compatible PUT responses normally have no JSON body.
        } else {
            Self::decode::<DataEnvelope<serde_json::Value>>(response)
                .await
                .map(|_| ())?;
        }
        if let Some(completion_path) = upload.completion_path.as_deref() {
            if !completion_path.starts_with("/v2/blobs/reservations/")
                || !completion_path.ends_with("/complete")
            {
                return Err(SyncError::InvalidState(
                    "cloud returned an invalid v2 completion path".into(),
                ));
            }
            self.send::<DataEnvelope<serde_json::Value>>(
                Method::POST,
                completion_path,
                Some(access_token),
                None,
            )
            .await?;
        }
        Ok(())
    }

    pub async fn v2_push(
        &self,
        access_token: &str,
        operations: &[V2PushOperation],
    ) -> Result<V2PushResult, SyncError> {
        self.send::<DataEnvelope<V2PushResult>>(
            Method::POST,
            "/v2/sync/push",
            Some(access_token),
            Some(json!({
                "protocolEpoch": PROTOCOL_EPOCH,
                "operations": operations,
            })),
        )
        .await
        .map(|value| value.data)
    }

    pub async fn v2_download_blob(
        &self,
        access_token: &str,
        content_hash: &str,
    ) -> Result<Vec<u8>, SyncError> {
        let capability = self
            .send::<V2BlobDownloadEnvelope>(
                Method::GET,
                &format!("/v2/blobs/{content_hash}/access"),
                Some(access_token),
                None,
            )
            .await;
        let response = match capability {
            Ok(envelope) => {
                if envelope.download.method != "GET" {
                    return Err(SyncError::InvalidState(
                        "cloud returned an unsupported v2 download method".into(),
                    ));
                }
                if let Some(url) = envelope.download.url.as_deref() {
                    Self::validate_direct_blob_url(url)?;
                    let mut request = self.http.get(url);
                    for (name, value) in &envelope.download.headers {
                        if Self::allowed_capability_header(name) {
                            request = request.header(name, value);
                        }
                    }
                    request.send().await?
                } else if let Some(path) = envelope.download.path.as_deref() {
                    if !path.starts_with("/v2/blobs/") {
                        return Err(SyncError::InvalidState(
                            "cloud returned an invalid v2 download path".into(),
                        ));
                    }
                    self.http
                        .get(format!("{}{}", self.base_url, path))
                        .bearer_auth(access_token)
                        .send()
                        .await?
                } else {
                    return Err(SyncError::InvalidState(
                        "cloud returned no v2 download source".into(),
                    ));
                }
            }
            Err(SyncError::Api { status: 404, .. }) => {
                self.http
                    .get(format!("{}/v2/blobs/{content_hash}", self.base_url))
                    .bearer_auth(access_token)
                    .send()
                    .await?
            }
            Err(error) => return Err(error),
        };
        if !response.status().is_success() {
            return Self::decode::<DataEnvelope<serde_json::Value>>(response)
                .await
                .map(|_| Vec::new());
        }
        Ok(response.bytes().await?.to_vec())
    }

    fn validate_direct_blob_url(value: &str) -> Result<(), SyncError> {
        let url = reqwest::Url::parse(value).map_err(|error| {
            SyncError::InvalidState(format!("cloud returned an invalid blob URL: {error}"))
        })?;
        let local_test = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
        if url.scheme() != "https" && !(url.scheme() == "http" && local_test) {
            return Err(SyncError::InvalidState(
                "cloud returned an insecure blob URL".into(),
            ));
        }
        Ok(())
    }

    fn allowed_capability_header(name: &str) -> bool {
        let name = name.to_ascii_lowercase();
        name == "content-type" || name == "x-amz-checksum-sha256" || name.starts_with("x-amz-meta-")
    }
}

#[cfg(test)]
mod tests {
    use super::{apple_authorization_body, CloudClient};
    use crate::models::AppleAuthorization;
    use crate::v2::V2BlobReservationEnvelope;
    use serde_json::json;

    fn authorization(display_name: Option<&str>) -> AppleAuthorization {
        AppleAuthorization {
            challenge_id: "ach_test".into(),
            nonce: "nonce_test".into(),
            identity_token: "identity_token_test".into(),
            authorization_code: "authorization_code_test".into(),
            display_name: display_name.map(str::to_string),
        }
    }

    #[test]
    fn apple_authorization_body_includes_first_login_name() {
        assert_eq!(
            apple_authorization_body(&authorization(Some("Flowix User"))),
            json!({
                "challengeId": "ach_test",
                "nonce": "nonce_test",
                "identityToken": "identity_token_test",
                "authorizationCode": "authorization_code_test",
                "displayName": "Flowix User",
            })
        );
    }

    #[test]
    fn apple_authorization_body_omits_name_after_first_login() {
        let body = apple_authorization_body(&authorization(None));
        assert_eq!(
            body,
            json!({
                "challengeId": "ach_test",
                "nonce": "nonce_test",
                "identityToken": "identity_token_test",
                "authorizationCode": "authorization_code_test",
            })
        );
        assert!(body.get("displayName").is_none());
    }

    #[test]
    fn blob_upload_contract_accepts_proxy_and_direct_capabilities() {
        let proxy: V2BlobReservationEnvelope = serde_json::from_value(json!({
            "data": {
                "reservationId": "res_proxy",
                "contentHash": "A".repeat(43),
                "sizeBytes": 10,
                "expiresAt": 1000
            },
            "upload": { "method": "PUT", "path": "/v2/blobs/reservations/res_proxy" }
        }))
        .unwrap();
        assert!(proxy.upload.url.is_none());
        assert_eq!(
            proxy.upload.path.as_deref(),
            Some("/v2/blobs/reservations/res_proxy")
        );

        let direct: V2BlobReservationEnvelope = serde_json::from_value(json!({
            "data": {
                "reservationId": "res_direct",
                "contentHash": "A".repeat(43),
                "sizeBytes": 10,
                "expiresAt": 1000
            },
            "upload": {
                "method": "PUT",
                "path": "/v2/blobs/reservations/res_direct",
                "url": "https://storage.example.test/object?signature=test",
                "headers": { "x-amz-meta-sha256": "A".repeat(43) },
                "expiresAt": 1000,
                "completionPath": "/v2/blobs/reservations/res_direct/complete"
            }
        }))
        .unwrap();
        assert_eq!(
            direct.upload.path.as_deref(),
            Some("/v2/blobs/reservations/res_direct")
        );
        assert_eq!(direct.upload.expires_at, Some(1000));
        assert_eq!(
            direct.upload.completion_path.as_deref(),
            Some("/v2/blobs/reservations/res_direct/complete")
        );
    }

    #[test]
    fn direct_blob_capabilities_never_forward_cloud_credentials() {
        assert!(CloudClient::validate_direct_blob_url("https://storage.example.test/blob").is_ok());
        assert!(CloudClient::validate_direct_blob_url("http://localhost:8787/blob").is_ok());
        assert!(CloudClient::validate_direct_blob_url("http://storage.example.test/blob").is_err());
        assert!(CloudClient::allowed_capability_header(
            "x-amz-checksum-sha256"
        ));
        assert!(!CloudClient::allowed_capability_header("authorization"));
        assert!(!CloudClient::allowed_capability_header("cookie"));
    }
}
