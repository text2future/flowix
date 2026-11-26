use reqwest::Method;
use serde::de::DeserializeOwned;
use serde_json::json;

use crate::error::SyncError;
use crate::models::{
    AccountDeletionOutcome, AccountDeletionState, ApiErrorEnvelope,
    AppleAuthChallenge, AppleAuthorization, AuthData, CloudAiCredential, CloudCheckout,
    CloudNoteShareLink, CloudOrder, CloudOrderCheck, CloudProduct, CloudSubscription, DataEnvelope,
    EntitlementData, MeData, PasswordResetCodeRequest, RefreshData, RegistrationCodeRequest,
    RegistrationCodeResend,
};
use crate::object_store::StorageCredentialEnvelope;

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

fn with_registration_client(mut body: serde_json::Value) -> serde_json::Value {
    if let Some(fields) = body.as_object_mut() {
        fields.insert(
            "clientVersion".to_string(),
            serde_json::Value::String(env!("CARGO_PKG_VERSION").to_string()),
        );
        let platform = match std::env::consts::OS {
            "macos" => Some("macos"),
            "windows" => Some("windows"),
            _ => None,
        };
        if let Some(platform) = platform {
            fields.insert(
                "clientPlatform".to_string(),
                serde_json::Value::String(platform.to_string()),
            );
        }
    }
    body
}

fn apple_registration_body(
    authorization: &AppleAuthorization,
    account_region: Option<&str>,
) -> serde_json::Value {
    let mut body = with_registration_client(apple_authorization_body(authorization));
    if let (Some(account_region), Some(fields)) = (account_region, body.as_object_mut()) {
        fields.insert(
            "accountRegion".to_string(),
            serde_json::Value::String(account_region.to_string()),
        );
    }
    body
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

    pub(crate) async fn create_note_share_link(
        &self,
        access_token: &str,
        notebook_id: &str,
        relative_path: &str,
        content_hash: &str,
    ) -> Result<CloudNoteShareLink, SyncError> {
        self.send::<DataEnvelope<CloudNoteShareLink>>(
            Method::POST,
            "/v2/shares/notes",
            Some(access_token),
            Some(json!({
                "notebookId": notebook_id,
                "relativePath": relative_path,
                "contentHash": content_hash,
            })),
        )
        .await
        .map(|envelope| envelope.data)
    }

    pub(crate) async fn create_folder_share_link(
        &self,
        access_token: &str,
        notebook_id: &str,
        relative_path: &str,
    ) -> Result<CloudNoteShareLink, SyncError> {
        self.send::<DataEnvelope<CloudNoteShareLink>>(
            Method::POST,
            "/v2/shares/folders",
            Some(access_token),
            Some(json!({ "notebookId": notebook_id, "relativePath": relative_path })),
        )
        .await
        .map(|envelope| envelope.data)
    }

    async fn decode<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, SyncError> {
        let status = response.status();
        let request_id = response
            .headers()
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
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

    pub(crate) async fn products(&self, region: &str) -> Result<Vec<CloudProduct>, SyncError> {
        self.send::<DataEnvelope<Vec<CloudProduct>>>(
            Method::GET,
            &format!("/v2/catalog/products?region={region}"),
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
        quantity: u8,
        idempotency_key: &str,
    ) -> Result<CloudCheckout, SyncError> {
        let response = self
            .http
            .post(format!("{}/v2/billing/checkout", self.base_url))
            .bearer_auth(access_token)
            .header("Idempotency-Key", idempotency_key)
            .json(&json!({
                "productId": product_id,
                "quantity": quantity,
                "successUrl": "flowix://billing/success",
            }))
            .send()
            .await?;
        Self::decode::<DataEnvelope<CloudCheckout>>(response)
            .await
            .map(|value| value.data)
    }

    pub(crate) async fn billing_orders(
        &self,
        access_token: &str,
    ) -> Result<Vec<CloudOrder>, SyncError> {
        self.send::<DataEnvelope<Vec<CloudOrder>>>(
            Method::GET,
            "/v2/billing/orders",
            Some(access_token),
            None,
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn check_billing_order(
        &self,
        access_token: &str,
        order_id: &str,
    ) -> Result<CloudOrderCheck, SyncError> {
        self.send::<DataEnvelope<CloudOrderCheck>>(
            Method::POST,
            &format!("/v2/billing/orders/{order_id}/check"),
            Some(access_token),
            Some(json!({})),
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn subscriptions(
        &self,
        access_token: &str,
    ) -> Result<Vec<CloudSubscription>, SyncError> {
        self.send::<DataEnvelope<Vec<CloudSubscription>>>(
            Method::GET,
            "/v1/account/subscriptions",
            Some(access_token),
            None,
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn cancel_subscription(
        &self,
        access_token: &str,
        subscription_id: &str,
    ) -> Result<(), SyncError> {
        self.send::<DataEnvelope<serde_json::Value>>(
            Method::POST,
            &format!("/v1/account/subscriptions/{subscription_id}/cancel"),
            Some(access_token),
            None,
        )
        .await
        .map(|_| ())
    }

    pub(crate) async fn submit_feedback(
        &self,
        device_id: &str,
        kind: &str,
        content: &str,
        app_version: &str,
        platform: &str,
        attachments: &[serde_json::Value],
    ) -> Result<(), SyncError> {
        self.send::<serde_json::Value>(
            Method::POST,
            "/v1/feedback",
            None,
            Some(json!({
                "deviceId": device_id,
                "type": kind,
                "content": content,
                "appVersion": app_version,
                "platform": platform,
                "attachments": attachments,
            })),
        )
        .await
        .map(|_| ())
    }

    pub(crate) async fn request_registration_code(
        &self,
        email: &str,
        password: &str,
        display_name: &str,
        email_language: &str,
    ) -> Result<RegistrationCodeRequest, SyncError> {
        self.send::<DataEnvelope<RegistrationCodeRequest>>(
            Method::POST,
            "/v1/auth/register",
            None,
            Some(with_registration_client(json!({
                "email": email,
                "password": password,
                "displayName": display_name,
                "emailLanguage": email_language,
                "accountRegion": if email_language == "zh-CN" { "mainland" } else { "non_mainland" },
                "confirmationVersion": 2,
            }))),
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn resend_registration_code(
        &self,
        email: &str,
    ) -> Result<RegistrationCodeResend, SyncError> {
        self.send::<DataEnvelope<RegistrationCodeResend>>(
            Method::POST,
            "/v1/auth/register/resend",
            None,
            Some(json!({ "email": email })),
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn confirm_registration(
        &self,
        email: &str,
        code: &str,
        password: &str,
    ) -> Result<AuthData, SyncError> {
        self.send::<DataEnvelope<AuthData>>(
            Method::POST,
            "/v1/auth/register/confirm",
            None,
            Some(json!({ "email": email, "code": code, "password": password })),
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn request_password_reset_code(
        &self,
        email: &str,
        email_language: &str,
    ) -> Result<PasswordResetCodeRequest, SyncError> {
        self.send::<DataEnvelope<PasswordResetCodeRequest>>(
            Method::POST,
            "/v1/auth/password/reset/code/request",
            None,
            Some(json!({ "email": email, "emailLanguage": email_language })),
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn confirm_password_reset_code(
        &self,
        email: &str,
        code: &str,
        new_password: &str,
    ) -> Result<(), SyncError> {
        self.send::<DataEnvelope<serde_json::Value>>(
            Method::POST,
            "/v1/auth/password/reset/code/confirm",
            None,
            Some(json!({ "email": email, "code": code, "newPassword": new_password })),
        )
        .await
        .map(|_| ())
    }

    pub(crate) async fn login(
        &self,
        email: &str,
        password: &str,
        restore_deleted: bool,
    ) -> Result<AuthData, SyncError> {
        self.send::<DataEnvelope<AuthData>>(
            Method::POST,
            "/v1/auth/login",
            None,
            Some(json!({
                "email": email,
                "password": password,
                "restoreDeleted": restore_deleted,
            })),
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn account_deletion(
        &self,
        access_token: &str,
    ) -> Result<AccountDeletionState, SyncError> {
        self.send::<DataEnvelope<AccountDeletionState>>(
            Method::GET,
            "/v1/account/deletion",
            Some(access_token),
            None,
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn delete_account(
        &self,
        access_token: &str,
        confirm_email: &str,
    ) -> Result<AccountDeletionOutcome, SyncError> {
        self.send::<DataEnvelope<AccountDeletionOutcome>>(
            Method::DELETE,
            "/v1/account",
            Some(access_token),
            Some(json!({ "confirmEmail": confirm_email })),
        )
        .await
        .map(|value| value.data)
    }

    /// The server wraps the export document in the usual `data` envelope; the
    /// document itself is an open-ended snapshot, so it stays untyped here.
    pub(crate) async fn account_export(
        &self,
        access_token: &str,
    ) -> Result<serde_json::Value, SyncError> {
        self.send::<DataEnvelope<serde_json::Value>>(
            Method::GET,
            "/v1/account/export",
            Some(access_token),
            None,
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
        account_region: &str,
    ) -> Result<AuthData, SyncError> {
        self.send::<DataEnvelope<AuthData>>(
            Method::POST,
            "/v1/auth/apple/exchange",
            None,
            Some(apple_registration_body(authorization, Some(account_region))),
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
            Self::decode::<serde_json::Value>(response)
                .await
                .map(|_| ())
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

    pub(crate) async fn create_ai_credential(
        &self,
        access_token: &str,
    ) -> Result<CloudAiCredential, SyncError> {
        self.send::<DataEnvelope<CloudAiCredential>>(
            Method::POST,
            "/v1/ai/credentials",
            Some(access_token),
            Some(json!({})),
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn ai_model_availability(
        &self,
        access_token: &str,
    ) -> Result<crate::models::CloudAiModelAvailability, SyncError> {
        self.send::<DataEnvelope<crate::models::CloudAiModelAvailability>>(
            Method::GET,
            "/v1/ai/model-availability",
            Some(access_token),
            None,
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn ai_credit_balance(
        &self,
        access_token: &str,
    ) -> Result<crate::models::CloudAiCreditBalance, SyncError> {
        self.send::<DataEnvelope<crate::models::CloudAiCreditBalance>>(
            Method::GET,
            "/v1/account/ai-credits",
            Some(access_token),
            None,
        )
        .await
        .map(|value| value.data)
    }

    pub(crate) async fn revoke_ai_credential(&self, access_token: &str) -> Result<(), SyncError> {
        self.send::<DataEnvelope<serde_json::Value>>(
            Method::DELETE,
            "/v1/ai/credentials/current",
            Some(access_token),
            None,
        )
        .await
        .map(|_| ())
    }

    /// Fetches the short-lived, prefix-scoped credential the object store
    /// accepts. This is the only cloud round trip on the direct-transfer path.
    pub async fn storage_credentials(
        &self,
        token: &str,
        mode: &str,
        ttl_seconds: Option<u32>,
    ) -> Result<StorageCredentialEnvelope, SyncError> {
        let mut body = json!({ "mode": mode });
        if let Some(ttl_seconds) = ttl_seconds {
            body["ttlSeconds"] = json!(ttl_seconds);
        }
        self.send(
            Method::POST,
            "/v2/storage/credentials",
            Some(token),
            Some(body),
        )
        .await
    }

    pub(crate) async fn storage_tombstone(
        &self,
        token: &str,
        notebook: &str,
        path: &str,
        etag: &str,
    ) -> Result<(), SyncError> {
        self.send::<DataEnvelope<serde_json::Value>>(
            Method::POST,
            "/v2/storage/tombstone",
            Some(token),
            Some(json!({"notebookId": notebook, "path": path, "etag": etag})),
        )
        .await
        .map(|_| ())
    }

    pub(crate) async fn storage_deletion_stamp(
        &self,
        token: &str,
        notebook: &str,
        path: &str,
    ) -> Result<(), SyncError> {
        self.send::<DataEnvelope<serde_json::Value>>(
            Method::POST,
            "/v2/storage/deletion-stamp",
            Some(token),
            Some(json!({"notebookId": notebook, "path": path})),
        )
        .await
        .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::apple_authorization_body;
    use crate::models::AppleAuthorization;
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
}
