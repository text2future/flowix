use super::*;

impl AccountService {
    pub async fn refresh_membership(&self) -> Result<CloudMembership, SyncError> {
        let generation = self.auth_generation();
        let mut refresh = match self.membership_refresh.try_lock() {
            Ok(guard) => guard,
            Err(_) => {
                let guard = self.membership_refresh.lock().await;
                // Share a successful in-flight refresh only within its session.
                let _generation = self.require_auth_generation(generation)?;
                if *guard == Some(generation) {
                    if let Some(membership) = self
                        .account_entitlement
                        .read()
                        .unwrap_or_else(|p| p.into_inner())
                        .membership
                        .clone()
                    {
                        return Ok(membership);
                    }
                }
                guard
            }
        };
        // Failure or cancellation must not let waiters reuse an older cache.
        *refresh = None;
        {
            let _generation = self.require_auth_generation(generation)?;
            let mut auth = self.auth.write().unwrap_or_else(|p| p.into_inner());
            let mut entitlement = self
                .account_entitlement
                .write()
                .unwrap_or_else(|p| p.into_inner());
            entitlement.status = CloudEntitlementStatus::Refreshing;
            entitlement.error = None;
            auth.revision = auth.revision.saturating_add(1);
            drop(entitlement);
            drop(auth);
            drop(_generation);
            self.notify_state_change();
        }
        let entitlement_result = async {
            let token = self.access_token(generation).await?;
            let first = self.client.entitlements(&token).await;
            if first.as_ref().is_err_and(SyncError::is_unauthorized) {
                let refreshed = self.force_refresh_access_token(generation).await?;
                self.client.entitlements(&refreshed).await
            } else {
                first
            }
        }
        .await;
        let entitlement = match entitlement_result {
            Ok(entitlement) => entitlement,
            Err(error) => {
                // An unsuccessful verification invalidates access in every
                // window. A later retry must not reuse the previous grant.
                let _generation = self.require_auth_generation(generation)?;
                let mut auth = self.auth.write().unwrap_or_else(|p| p.into_inner());
                let mut account_entitlement = self
                    .account_entitlement
                    .write()
                    .unwrap_or_else(|p| p.into_inner());
                account_entitlement.membership = None;
                account_entitlement.updated_at = None;
                account_entitlement.status = CloudEntitlementStatus::Error;
                account_entitlement.error = Some(error.to_string());
                auth.revision = auth.revision.saturating_add(1);
                drop(account_entitlement);
                drop(auth);
                drop(_generation);
                self.notify_state_change();
                return Err(error);
            }
        };
        let membership: CloudMembership = entitlement.into();
        {
            let _generation = self.require_auth_generation(generation)?;
            let mut auth = self.auth.write().unwrap_or_else(|p| p.into_inner());
            let mut account_entitlement = self
                .account_entitlement
                .write()
                .unwrap_or_else(|p| p.into_inner());
            account_entitlement.membership = Some(membership.clone());
            account_entitlement.updated_at = Some(chrono::Utc::now().timestamp_millis());
            account_entitlement.status = CloudEntitlementStatus::Verified;
            account_entitlement.error = None;
            auth.revision = auth.revision.saturating_add(1);
            drop(account_entitlement);
            drop(auth);
            drop(_generation);
        }
        self.notify_state_change();
        // Account metadata is best effort and must not delay publishing verified access.
        let account_result = async {
            let token = self.access_token(generation).await?;
            let result = self.client.me(&token).await;
            if result.as_ref().is_err_and(SyncError::is_unauthorized) {
                let token = self.force_refresh_access_token(generation).await?;
                self.client.me(&token).await
            } else {
                result
            }
        }
        .await;
        if let Ok(account) = account_result {
            let _generation = self.require_auth_generation(generation)?;
            let update = (|| -> Result<(), SyncError> {
                if self
                    .store
                    .account()?
                    .is_some_and(|current| current.user.id == account.user.id)
                {
                    self.store
                        .save_account(&CloudAccount { user: account.user })?;
                    self.auth
                        .write()
                        .unwrap_or_else(|p| p.into_inner())
                        .revision += 1;
                }
                Ok(())
            })();
            drop(_generation);
            if let Err(error) = update {
                tracing::warn!(%error, "failed to update cached cloud account");
            } else {
                self.notify_state_change();
            }
        } else if let Err(error) = account_result {
            tracing::debug!(%error, "failed to refresh cloud account");
        }
        *refresh = Some(generation);
        drop(refresh);
        Ok(membership)
    }
}
