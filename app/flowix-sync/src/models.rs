use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudUser {
    pub id: String,
    pub email: String,
    pub display_name: String,
    #[serde(default = "default_non_mainland_region")]
    pub region: String,
}

fn default_non_mainland_region() -> String {
    "non_mainland".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudNotebook {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub synced: bool,
    #[serde(default)]
    pub used_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudSession {
    pub access_token: String,
    pub access_token_expires_at: i64,
    pub refresh_token: String,
    pub refresh_token_expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthData {
    pub user: CloudUser,
    pub session: CloudSession,
    /// Set when the sign-in revived an account that had been deleted but was
    /// still inside its grace window. Absent for ordinary sign-ins.
    #[serde(default)]
    pub restored: bool,
}

/// Where a deleted account stands. `state` is one of `active`, `restorable`,
/// `purged` or `suspended`; `restorable_until` is the deadline after which
/// recovery stops working.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountDeletionState {
    pub state: String,
    pub restorable_until: Option<i64>,
    #[serde(default)]
    pub grace_days: u32,
    #[serde(default)]
    pub deleted_at: Option<i64>,
}

/// Result of starting a deletion. `pending_subscription_cancellations` lists
/// subscriptions a payment provider refused to cancel, so the UI can point the
/// user at the billing portal instead of claiming everything ended.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountDeletionOutcome {
    pub state: String,
    pub restorable_until: Option<i64>,
    #[serde(default)]
    pub pending_subscription_cancellations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppleAuthChallenge {
    pub challenge_id: String,
    pub nonce: String,
    pub expires_at: i64,
    pub client_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppleAuthorization {
    pub challenge_id: String,
    pub nonce: String,
    pub identity_token: String,
    pub authorization_code: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct DataEnvelope<T> {
    pub data: T,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RefreshData {
    pub session: CloudSession,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MeData {
    pub user: CloudUser,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ApiErrorEnvelope {
    pub error: ApiErrorBody,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiErrorBody {
    pub code: String,
    pub message: String,
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeSession {
    pub access_token: String,
    pub access_token_expires_at: i64,
    pub refresh_token: String,
    pub refresh_token_expires_at: i64,
}

impl From<CloudSession> for RuntimeSession {
    fn from(value: CloudSession) -> Self {
        Self {
            access_token: value.access_token,
            access_token_expires_at: value.access_token_expires_at,
            refresh_token: value.refresh_token,
            refresh_token_expires_at: value.refresh_token_expires_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudMembership {
    pub active: bool,
    pub starts_at: Option<i64>,
    pub expires_at: Option<i64>,
    #[serde(default = "empty_feature_flags")]
    pub features: serde_json::Value,
    #[serde(default)]
    pub storage_expires_at: Option<i64>,
    pub used_bytes: i64,
    pub quota_bytes: i64,
    pub available_bytes: i64,
    pub note_count: i64,
    pub read_only: bool,
}

impl CloudMembership {
    /// Account membership unlocks every member feature during its validity period.
    pub fn is_active_at(&self, now_ms: i64) -> bool {
        self.active
            && self.starts_at.is_none_or(|starts_at| starts_at <= now_ms)
            && self.expires_at.is_some_and(|expires_at| expires_at > now_ms)
    }


}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudAiCredential {
    pub api_key: String,
    pub model: CloudAiModel,
    #[serde(default)]
    pub models: Vec<CloudAiModel>,
    #[serde(default)]
    pub provider: Option<CloudAiProvider>,
    #[serde(default = "default_cloud_models_enabled")]
    pub cloud_models_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAiModelAvailability {
    pub enabled: bool,
}

fn default_cloud_models_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAiCreditBalance {
    pub balance_microcredits: i64,
    #[serde(default)]
    pub monthly_balance_microcredits: i64,
    #[serde(default)]
    pub permanent_balance_microcredits: i64,
    #[serde(default)]
    pub monthly_expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudAiModel {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub subtitle: Option<String>,
    #[serde(default)]
    pub credit_multiplier: Option<f64>,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub provider_name: Option<String>,
    #[serde(default)]
    pub provider_icon_url: Option<String>,
    /// Directory ordering advertised by Cloud: larger values come first.
    /// Optional so credentials issued by older Cloud versions still parse.
    #[serde(default)]
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudAiProvider {
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub icon_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudProduct {
    pub id: String,
    pub name: String,
    pub description: String,
    pub price: CloudPrice,
    // Older Cloud catalog responses omit this field; those products are subscriptions.
    #[serde(default = "default_billing_type")]
    pub billing_type: String,
    #[serde(default = "default_non_mainland_region")]
    pub market_region: String,
    // Authoritative product category since the storage/ai split. Older catalog
    // responses omit it; the web layer then falls back to feature-based
    // classification for cached entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entitlement_kind: Option<String>,
    pub entitlement: ProductEntitlement,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudPrice {
    pub amount: i64,
    pub currency: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductEntitlement {
    pub storage_bytes: i64,
    pub duration: ProductDuration,
    pub features: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductDuration {
    pub unit: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudCheckout {
    pub order_id: String,
    pub status: String,
    pub checkout_url: String,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudOrder {
    pub id: String,
    pub product_id: String,
    pub product_name: String,
    pub amount: i64,
    pub currency: String,
    pub status: String,
    pub created_at: i64,
    pub paid_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudSubscription {
    pub id: String,
    pub status: String,
    #[serde(alias = "product_id")]
    pub product_id: Option<String>,
    #[serde(alias = "product_name")]
    pub product_name: Option<String>,
    #[serde(alias = "current_period_end")]
    pub current_period_end: Option<i64>,
    // Older account responses omit these flags.
    #[serde(default, alias = "cancel_at_period_end")]
    pub cancel_at_period_end: bool,
    #[serde(default, alias = "is_annual_membership")]
    pub is_annual_membership: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudOrderCheck {
    pub status: String,
    pub confirmed: bool,
    pub check_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudState {
    pub revision: u64,
    pub authenticated: bool,
    pub auth_status: CloudAuthStatus,
    pub auth_error: Option<String>,
    pub account: Option<crate::v2::V2CloudAccount>,
    pub membership: Option<CloudMembership>,
    pub membership_status: CloudEntitlementStatus,
    pub membership_error: Option<String>,
    pub sync_access: crate::account::CloudSyncAccess,
    /// True only for a session created by reviving a deleted account. It stays
    /// true for the lifetime of that session so the UI can explain what
    /// happened once, then never again.
    #[serde(default)]
    pub restored: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CloudAuthStatus {
    SignedOut,
    Restoring,
    Authenticated,
}

/// Local verification state for the current account's server-owned entitlement.
/// This is separate from authentication and from the entitlement payload itself.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum CloudEntitlementStatus {
    #[default]
    Unknown,
    Refreshing,
    Verified,
    Error,
}

pub trait RefreshTokenStore: Send + Sync {
    fn load(&self) -> Result<Option<String>, String>;
    fn save(&self, token: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalChangeKind {
    Put,
    Delete,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EntitlementData {
    pub membership: EntitlementMembership,
    pub usage: EntitlementUsage,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EntitlementMembership {
    pub active: bool,
    pub starts_at: Option<i64>,
    pub expires_at: Option<i64>,
    #[serde(default = "empty_feature_flags")]
    pub features: serde_json::Value,
    #[serde(default)]
    pub storage_expires_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EntitlementUsage {
    pub used_bytes: i64,
    pub quota_bytes: i64,
    pub available_bytes: i64,
    pub note_count: i64,
    pub read_only: bool,
}

impl From<EntitlementData> for CloudMembership {
    fn from(value: EntitlementData) -> Self {
        Self {
            active: value.membership.active,
            starts_at: value.membership.starts_at,
            expires_at: value.membership.expires_at,
            features: value.membership.features,
            storage_expires_at: value.membership.storage_expires_at,
            used_bytes: value.usage.used_bytes,
            quota_bytes: value.usage.quota_bytes,
            available_bytes: value.usage.available_bytes,
            note_count: value.usage.note_count,
            read_only: value.usage.read_only,
        }
    }
}

fn empty_feature_flags() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}

fn default_billing_type() -> String {
    "subscription".to_owned()
}

#[cfg(test)]
mod subscription_tests {
    use super::{CloudSubscription, DataEnvelope};

    #[test]
    fn older_subscription_response_without_flags_is_supported() {
        let response: DataEnvelope<Vec<CloudSubscription>> = serde_json::from_value(
            serde_json::json!({"data": [{
                "id": "sub_legacy",
                "status": "active",
                "productId": "membership",
                "productName": "Annual membership",
                "currentPeriodEnd": 1800000000000_i64
            }]}),
        )
        .unwrap();
        let subscription = &response.data[0];
        assert_eq!(subscription.id, "sub_legacy");
        assert!(!subscription.cancel_at_period_end);
        assert!(!subscription.is_annual_membership);
    }

    #[test]
    fn subscription_flags_are_preserved_when_present() {
        for flag in [false, true] {
            let subscription: CloudSubscription = serde_json::from_value(serde_json::json!({
                "id": "sub_current",
                "status": "active",
                "cancelAtPeriodEnd": flag,
                "isAnnualMembership": flag
            }))
            .unwrap();
            assert_eq!(subscription.cancel_at_period_end, flag);
            assert_eq!(subscription.is_annual_membership, flag);
            let serialized = serde_json::to_value(subscription).unwrap();
            assert_eq!(serialized["cancelAtPeriodEnd"], flag);
            assert_eq!(serialized["isAnnualMembership"], flag);
        }
    }

    #[test]
    fn snake_case_subscription_fields_are_preserved() {
        let subscription: CloudSubscription = serde_json::from_value(serde_json::json!({
            "id": "sub_legacy",
            "status": "active",
            "product_id": "membership",
            "product_name": "Annual membership",
            "current_period_end": 1800000000000_i64,
            "cancel_at_period_end": true,
            "is_annual_membership": true
        }))
        .unwrap();
        assert_eq!(subscription.product_id.as_deref(), Some("membership"));
        assert_eq!(subscription.product_name.as_deref(), Some("Annual membership"));
        assert_eq!(subscription.current_period_end, Some(1800000000000));
        assert!(subscription.cancel_at_period_end);
        assert!(subscription.is_annual_membership);
    }
}
