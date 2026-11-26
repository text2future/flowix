use super::*;

impl AccountService {
    pub async fn ai_model_availability(
        &self,
    ) -> Result<crate::models::CloudAiModelAvailability, SyncError> {
        let generation = self.auth_generation();
        let access_token = self.access_token(generation).await?;
        let first = self.client.ai_model_availability(&access_token).await;
        let availability = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token(generation).await?;
            self.client.ai_model_availability(&refreshed).await?
        } else {
            first?
        };
        let _generation = self.require_auth_generation(generation)?;
        Ok(availability)
    }

    /// Monotonic identity for the current in-memory Cloud login session.
    /// Runtime adapters use this to refresh session-bound API credentials only
    /// after a sign-in transition, not before every request.
    pub fn ai_credential_session_generation(&self) -> u64 {
        self.auth_generation()
    }

    pub async fn ai_credit_balance(
        &self,
    ) -> Result<crate::models::CloudAiCreditBalance, SyncError> {
        let generation = self.auth_generation();
        let mut refresh = match self.ai_credits_refresh.try_lock() {
            Ok(guard) => guard,
            Err(_) => {
                let guard = self.ai_credits_refresh.lock().await;
                let _generation = self.require_auth_generation(generation)?;
                if *guard == Some(generation) {
                    let entitlement = self.account_entitlement.read().unwrap_or_else(|p| p.into_inner());
                    if let Some(balance) = entitlement.ai_credits.data.clone() {
                        return Ok(balance);
                    }
                    if let Some(error) = &entitlement.ai_credits.error {
                        return Err(SyncError::InvalidState(error.clone()));
                    }
                }
                guard
            }
        };
        *refresh = None;
        {
            let _generation = self.require_auth_generation(generation)?;
            let mut auth = self.auth.write().unwrap_or_else(|p| p.into_inner());
            if auth.session.is_none() {
                return Err(SyncError::NotAuthenticated);
            }
            let mut entitlement = self.account_entitlement.write().unwrap_or_else(|p| p.into_inner());
            entitlement.ai_credits.status = CloudAiCreditStatus::Refreshing;
            entitlement.ai_credits.error = None;
            auth.revision = auth.revision.saturating_add(1);
        }
        self.notify_state_change();
        let result = async {
            let token = self.access_token(generation).await?;
            let first = self.client.ai_credit_balance(&token).await;
            if first.as_ref().is_err_and(SyncError::is_unauthorized) {
                let refreshed = self.force_refresh_access_token(generation).await?;
                self.client.ai_credit_balance(&refreshed).await
            } else {
                first
            }
        }.await;
        {
            let _generation = self.require_auth_generation(generation)?;
            let mut auth = self.auth.write().unwrap_or_else(|p| p.into_inner());
            let mut entitlement = self.account_entitlement.write().unwrap_or_else(|p| p.into_inner());
            entitlement.ai_credits = match &result {
                Ok(balance) => CloudAiCreditState {
                    data: Some(balance.clone()),
                    status: CloudAiCreditStatus::Ready,
                    error: None,
                    updated_at: Some(chrono::Utc::now().timestamp_millis()),
                },
                Err(error) => CloudAiCreditState {
                    data: None,
                    status: CloudAiCreditStatus::Error,
                    error: Some(error.to_string()),
                    updated_at: None,
                },
            };
            auth.revision = auth.revision.saturating_add(1);
            *refresh = Some(generation);
        }
        drop(refresh);
        self.notify_state_change();
        result
    }

    pub async fn create_ai_credential(
        &self,
    ) -> Result<crate::models::CloudAiCredential, SyncError> {
        let generation = self.auth_generation();
        let access_token = self.access_token(generation).await?;
        let first = self.client.create_ai_credential(&access_token).await;
        let credential = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token(generation).await?;
            self.client.create_ai_credential(&refreshed).await?
        } else {
            first?
        };
        let _generation = self.require_auth_generation(generation)?;
        Ok(credential)
    }

    pub async fn revoke_ai_credential(&self) -> Result<(), SyncError> {
        let generation = self.auth_generation();
        let access_token = self.access_token(generation).await?;
        let first = self.client.revoke_ai_credential(&access_token).await;
        if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token(generation).await?;
            self.client.revoke_ai_credential(&refreshed).await?;
        } else {
            first?;
        }
        let _generation = self.require_auth_generation(generation)?;
        Ok(())
    }
}
