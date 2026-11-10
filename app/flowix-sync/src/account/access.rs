//! Pure account policy. Sync and UI consume this projection without inspecting grants.
use crate::models::{CloudEntitlementStatus, CloudMembership};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncAccess {
    pub can_read: bool,
    pub can_upload: bool,
    pub can_delete: bool,
    pub restriction: Option<CloudSyncRestriction>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloudSyncRestriction {
    SignedOut,
    Verifying,
    VerificationFailed,
    MembershipRequired,
    StorageLimited,
}

impl CloudSyncAccess {
    fn denied(reason: CloudSyncRestriction) -> Self {
        Self {
            can_read: false,
            can_upload: false,
            can_delete: false,
            restriction: Some(reason),
        }
    }

    pub(super) fn resolve(
        authenticated: bool,
        status: CloudEntitlementStatus,
        membership: Option<&CloudMembership>,
        now: i64,
    ) -> Self {
        if !authenticated {
            return Self::denied(CloudSyncRestriction::SignedOut);
        }
        if status == CloudEntitlementStatus::Error {
            return Self::denied(CloudSyncRestriction::VerificationFailed);
        }
        if status == CloudEntitlementStatus::Unknown {
            return Self::denied(CloudSyncRestriction::Verifying);
        }
        let Some(membership) = membership else {
            return Self::denied(CloudSyncRestriction::Verifying);
        };
        let feature = match membership.features.get("cloudSync") {
            Some(serde_json::Value::Bool(enabled)) => *enabled,
            None => membership.features.get("membership") != Some(&serde_json::Value::Bool(false)),
            _ => false,
        };
        if !membership.is_active_at(now) || !feature {
            // A lapsed plan stops writes, not access to data the account already
            // stored. Reinstalling or switching machines must still be able to
            // pull the index and download blobs, and a user must still be able
            // to delete what they can no longer pay to keep.
            return Self {
                can_read: true,
                can_upload: false,
                can_delete: true,
                restriction: Some(CloudSyncRestriction::MembershipRequired),
            };
        }
        let limited =
            membership.read_only || membership.quota_bytes <= 0 || membership.available_bytes <= 0;
        Self {
            can_read: true,
            can_upload: !limited,
            can_delete: true,
            restriction: limited.then_some(CloudSyncRestriction::StorageLimited),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn member() -> CloudMembership {
        CloudMembership {
            active: true,
            starts_at: Some(1),
            expires_at: Some(100),
            features: serde_json::json!({"cloudSync": true}),
            storage_expires_at: Some(100),
            used_bytes: 10,
            quota_bytes: 100,
            available_bytes: 90,
            note_count: 1,
            read_only: false,
        }
    }
    #[test]
    fn account_access_distinguishes_verification_authentication_and_expiry() {
        let grant = member();
        for (authenticated, status, membership, reason) in [
            (
                false,
                CloudEntitlementStatus::Verified,
                Some(&grant),
                CloudSyncRestriction::SignedOut,
            ),
            (
                true,
                CloudEntitlementStatus::Unknown,
                None,
                CloudSyncRestriction::Verifying,
            ),
            (
                true,
                CloudEntitlementStatus::Error,
                Some(&grant),
                CloudSyncRestriction::VerificationFailed,
            ),
        ] {
            let access = CloudSyncAccess::resolve(authenticated, status, membership, 50);
            assert_eq!(access, CloudSyncAccess::denied(reason));
        }
        assert_eq!(
            CloudSyncAccess::resolve(true, CloudEntitlementStatus::Verified, Some(&grant), 100),
            CloudSyncAccess {
                can_read: true,
                can_upload: false,
                can_delete: true,
                restriction: Some(CloudSyncRestriction::MembershipRequired),
            }
        );
        assert!(
            CloudSyncAccess::resolve(true, CloudEntitlementStatus::Refreshing, Some(&grant), 50)
                .can_upload
        );
    }
    #[test]
    fn an_expired_membership_keeps_reading_and_deleting_but_never_uploads() {
        let mut grant = member();
        grant.expires_at = Some(50);
        let access =
            CloudSyncAccess::resolve(true, CloudEntitlementStatus::Verified, Some(&grant), 50);
        assert!(access.can_read && access.can_delete);
        assert!(!access.can_upload);
        assert_eq!(
            access.restriction,
            Some(CloudSyncRestriction::MembershipRequired)
        );
    }
    #[test]
    fn full_storage_preserves_read_and_delete_without_granting_uploads() {
        let mut grant = member();
        grant.available_bytes = 0;
        let access =
            CloudSyncAccess::resolve(true, CloudEntitlementStatus::Verified, Some(&grant), 50);
        assert!(access.can_read && access.can_delete);
        assert!(!access.can_upload);
        assert_eq!(
            access.restriction,
            Some(CloudSyncRestriction::StorageLimited)
        );
    }
    #[test]
    fn legacy_membership_is_supported_but_malformed_or_denied_features_are_not() {
        for (features, allowed) in [
            (serde_json::json!({}), true),
            (serde_json::json!({"membership":false}), false),
            (serde_json::json!({"cloudSync":false}), false),
            (serde_json::json!({"cloudSync":null}), false),
            (serde_json::json!({"cloudSync":"true"}), false),
        ] {
            let mut grant = member();
            grant.features = features;
            let access =
                CloudSyncAccess::resolve(true, CloudEntitlementStatus::Verified, Some(&grant), 50);
            // Reads never depend on the feature; uploads do.
            assert!(access.can_read);
            assert_eq!(access.can_upload, allowed);
            assert!(access.can_delete);
        }
    }
}
