//! Account deletion and data export.
//!
//! Deletion is the one account operation that must leave nothing usable
//! behind locally. The server revokes every session as part of the request, so
//! the local side is a teardown rather than a logout: there is no refresh token
//! left to revoke, and re-running the sync state would silently re-upload the
//! same notes if the address were ever registered again.
use super::*;

impl AccountService {
    /// Ask the server where this account stands before offering a destructive
    /// button. The grace period and its deadline are server-owned, so the UI
    /// never has to hardcode "30 days" and drift from the contract.
    pub async fn deletion_state(&self) -> Result<AccountDeletionState, SyncError> {
        let generation = self.auth_generation();
        let token = self.access_token(generation).await?;
        match self.client.account_deletion(&token).await {
            Err(error) if error.is_unauthorized() => {
                let refreshed = self.force_refresh_access_token(generation).await?;
                self.client.account_deletion(&refreshed).await
            }
            other => other,
        }
    }

    /// Everything this service stores about the caller, as the server's own
    /// export document. Kept untyped because it is a snapshot, not a contract
    /// the client parses field by field.
    pub async fn export_account(&self) -> Result<serde_json::Value, SyncError> {
        let generation = self.auth_generation();
        let token = self.access_token(generation).await?;
        match self.client.account_export(&token).await {
            Err(error) if error.is_unauthorized() => {
                let refreshed = self.force_refresh_access_token(generation).await?;
                self.client.account_export(&refreshed).await
            }
            other => other,
        }
    }

    /// Start deleting the signed-in account, then drop every local trace of it.
    ///
    /// The local teardown runs only after the server confirms, and it reuses
    /// the logout path (`clear_auth_at_generation`) so the generation bump,
    /// entitlement reset, `v2_cloud_account` wipe and refresh-credential delete
    /// stay in one place. `clear_v2_account` already clears cursors, note
    /// states, dirty rows and inflight operations, which is what makes a later
    /// account with the same address start from scratch instead of replaying
    /// the old notebook.
    ///
    /// A failure to remove the persisted credential is reported, not swallowed:
    /// leaving a usable refresh token on disk after the user asked to be
    /// deleted is exactly the outcome this operation exists to prevent.
    pub async fn delete_account(
        &self,
        confirm_email: &str,
    ) -> Result<AccountDeletionOutcome, SyncError> {
        let generation = self.auth_generation();
        let token = self.access_token(generation).await?;
        let outcome = match self.client.delete_account(&token, confirm_email).await {
            Err(error) if error.is_unauthorized() => {
                let refreshed = self.force_refresh_access_token(generation).await?;
                self.client.delete_account(&refreshed, confirm_email).await
            }
            other => other,
        }?;
        let (_, cleanup) = self
            .clear_auth_at_generation(generation, || self.delete_persisted_refresh_token())?;
        cleanup?;
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests;
