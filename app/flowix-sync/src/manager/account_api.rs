//! Compatibility facade. New account integrations use SyncManager::account().
use super::*;

impl SyncManager {
    pub fn new(api_base: &str, database_path: impl AsRef<Path>) -> Result<Self, SyncError> {
        Ok(Self::from_account(AccountService::new(
            api_base,
            database_path,
        )?))
    }

    pub fn new_with_token_store(
        api_base: &str,
        database_path: impl AsRef<Path>,
        token_store: Arc<dyn RefreshTokenStore>,
    ) -> Result<Self, SyncError> {
        Ok(Self::from_account(AccountService::new_with_token_store(
            api_base,
            database_path,
            token_store,
        )?))
    }

    pub fn new_with_session_dependencies(
        api_base: &str,
        database_path: impl AsRef<Path>,
        token_store: Arc<dyn RefreshTokenStore>,
        state_notifier: Arc<dyn Fn(CloudState) + Send + Sync>,
    ) -> Result<Self, SyncError> {
        Ok(Self::from_account(
            AccountService::new_with_session_dependencies(
                api_base,
                database_path,
                token_store,
                state_notifier,
            )?,
        ))
    }

    pub fn new_with_session_dependencies_deferred(
        api_base: &str,
        database_path: impl AsRef<Path>,
        token_store: Arc<dyn RefreshTokenStore>,
        state_notifier: Arc<dyn Fn(CloudState) + Send + Sync>,
    ) -> Result<Self, SyncError> {
        Ok(Self::from_account(
            AccountService::new_with_session_dependencies_deferred(
                api_base,
                database_path,
                token_store,
                state_notifier,
            )?,
        ))
    }

    pub fn initialize_storage(&self) -> Result<(), SyncError> {
        self.account.initialize_storage()
    }

    pub fn initialize_runtime_storage(&self) -> Result<(), SyncError> {
        self.store.initialize_runtime_schema()?;
        self.account.initialize_storage()
    }

    pub fn store(&self) -> &SyncStore {
        &self.store
    }

    pub fn state(&self) -> Result<CloudState, SyncError> {
        self.account.state()
    }

    pub fn cloud_sync_available(&self) -> bool {
        self.account.sync_access().can_read
    }

    pub fn cloud_sync_read_only(&self) -> bool {
        self.account.sync_access().restriction
            == Some(crate::account::CloudSyncRestriction::StorageLimited)
    }

    pub async fn register(
        &self,
        email: &str,
        password: &str,
        display_name: &str,
    ) -> Result<CloudState, SyncError> {
        self.account.register(email, password, display_name).await
    }

    pub async fn login(&self, email: &str, password: &str) -> Result<CloudState, SyncError> {
        self.account.login(email, password).await
    }

    /// Same as [`Self::login`] with an explicit decision about reviving an
    /// account that is inside its deletion grace window.
    pub async fn login_with_restore(
        &self,
        email: &str,
        password: &str,
        restore_deleted: bool,
    ) -> Result<CloudState, SyncError> {
        self.account
            .login_with_restore(email, password, restore_deleted)
            .await
    }

    pub async fn account_deletion(&self) -> Result<crate::AccountDeletionState, SyncError> {
        self.account.deletion_state().await
    }

    pub async fn delete_account(
        &self,
        confirm_email: &str,
    ) -> Result<crate::AccountDeletionOutcome, SyncError> {
        self.account.delete_account(confirm_email).await
    }

    pub async fn export_account(&self) -> Result<serde_json::Value, SyncError> {
        self.account.export_account().await
    }

    pub async fn apple_challenge(&self) -> Result<AppleAuthChallenge, SyncError> {
        self.account.apple_challenge().await
    }

    pub async fn sign_in_with_apple(
        &self,
        authorization: &AppleAuthorization,
    ) -> Result<CloudState, SyncError> {
        self.account.sign_in_with_apple(authorization).await
    }

    pub fn begin_google_sign_in(&self) -> u64 {
        self.account.begin_google_sign_in()
    }

    pub async fn sign_in_with_google_desktop(
        &self,
        code: &str,
        state: &str,
        code_verifier: &str,
        generation: u64,
    ) -> Result<CloudState, SyncError> {
        self.account
            .sign_in_with_google_desktop(code, state, code_verifier, generation)
            .await
    }

    pub async fn link_apple(
        &self,
        authorization: &AppleAuthorization,
    ) -> Result<CloudState, SyncError> {
        self.account.link_apple(authorization).await
    }

    pub fn session_generation(&self) -> u64 {
        self.account.session_generation()
    }

    pub fn begin_logout(&self) -> PendingLogout {
        self.account.begin_logout()
    }

    pub async fn finish_logout(&self, pending: PendingLogout) -> Result<(), SyncError> {
        self.account.finish_logout(pending).await
    }

    pub async fn logout(&self) -> Result<(), SyncError> {
        self.account.logout().await
    }

    pub async fn ai_model_availability(
        &self,
    ) -> Result<crate::models::CloudAiModelAvailability, SyncError> {
        self.account.ai_model_availability().await
    }

    pub fn ai_credential_session_generation(&self) -> u64 {
        self.account.ai_credential_session_generation()
    }

    pub async fn ai_credit_balance(
        &self,
    ) -> Result<crate::models::CloudAiCreditBalance, SyncError> {
        self.account.ai_credit_balance().await
    }

    pub async fn create_ai_credential(
        &self,
    ) -> Result<crate::models::CloudAiCredential, SyncError> {
        self.account.create_ai_credential().await
    }

    pub async fn revoke_ai_credential(&self) -> Result<(), SyncError> {
        self.account.revoke_ai_credential().await
    }

    pub async fn refresh_membership(&self) -> Result<CloudMembership, SyncError> {
        self.account.refresh_membership().await
    }

    pub async fn products(&self, region: &str) -> Result<Vec<CloudProduct>, SyncError> {
        self.account.products(region).await
    }

    pub async fn billing_orders(&self) -> Result<Vec<CloudOrder>, SyncError> {
        self.account.billing_orders().await
    }

    pub async fn check_billing_order(&self, order_id: &str) -> Result<CloudOrderCheck, SyncError> {
        self.account.check_billing_order(order_id).await
    }

    pub async fn subscriptions(&self) -> Result<Vec<crate::models::CloudSubscription>, SyncError> {
        self.account.subscriptions().await
    }

    pub async fn cancel_subscription(&self, subscription_id: &str) -> Result<(), SyncError> {
        self.account.cancel_subscription(subscription_id).await
    }

    pub async fn submit_feedback(
        &self,
        device_id: &str,
        kind: &str,
        content: &str,
        app_version: &str,
        platform: &str,
        attachments: &[serde_json::Value],
    ) -> Result<(), SyncError> {
        self.account
            .submit_feedback(device_id, kind, content, app_version, platform, attachments)
            .await
    }

    pub async fn create_checkout(
        &self,
        product_id: &str,
        idempotency_key: &str,
    ) -> Result<CloudCheckout, SyncError> {
        self.account
            .create_checkout(product_id, idempotency_key)
            .await
    }

    pub async fn run_session_service(&self) {
        self.account.run_session_service().await
    }
}
