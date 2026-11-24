use super::*;

impl AccountService {
    pub async fn update_account_region(
        &self,
        region: &str,
    ) -> Result<crate::models::CloudState, SyncError> {
        if !matches!(region, "mainland" | "non_mainland") {
            return Err(SyncError::InvalidState("unsupported account region".into()));
        }

        let generation = self.auth_generation();
        let token = self.access_token(generation).await?;
        let first = self.client.update_account_region(&token, region).await;
        let updated_region = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token(generation).await?;
            self.client
                .update_account_region(&refreshed, region)
                .await?
        } else {
            first?
        };
        if updated_region != region {
            return Err(SyncError::InvalidState(
                "cloud returned an unexpected account region".into(),
            ));
        }

        let generation_guard = self.require_auth_generation(generation)?;
        let mut auth = self.auth.write().unwrap_or_else(|p| p.into_inner());
        let mut account = self.store.account()?.ok_or(SyncError::NotAuthenticated)?;
        account.user.region = updated_region;
        self.store.save_account(&account)?;
        auth.revision = auth.revision.saturating_add(1);
        drop(auth);
        drop(generation_guard);
        self.notify_state_change();
        self.state()
    }

    pub async fn products(&self, region: &str) -> Result<Vec<CloudProduct>, SyncError> {
        self.client.products(region).await
    }

    pub async fn billing_orders(&self) -> Result<Vec<CloudOrder>, SyncError> {
        let generation = self.auth_generation();
        let token = self.access_token(generation).await?;
        let first = self.client.billing_orders(&token).await;
        let result = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token(generation).await?;
            self.client.billing_orders(&refreshed).await
        } else {
            first
        };
        let _generation = self.require_auth_generation(generation)?;
        result
    }

    pub async fn check_billing_order(&self, order_id: &str) -> Result<CloudOrderCheck, SyncError> {
        let generation = self.auth_generation();
        let token = self.access_token(generation).await?;
        let first = self.client.check_billing_order(&token, order_id).await;
        let result = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token(generation).await?;
            self.client.check_billing_order(&refreshed, order_id).await
        } else {
            first
        };
        let _generation = self.require_auth_generation(generation)?;
        result
    }

    pub async fn subscriptions(&self) -> Result<Vec<crate::models::CloudSubscription>, SyncError> {
        let generation = self.auth_generation();
        let token = self.access_token(generation).await?;
        let first = self.client.subscriptions(&token).await;
        let result = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token(generation).await?;
            self.client.subscriptions(&refreshed).await
        } else {
            first
        };
        let _generation = self.require_auth_generation(generation)?;
        result
    }

    pub async fn cancel_subscription(&self, subscription_id: &str) -> Result<(), SyncError> {
        let generation = self.auth_generation();
        let token = self.access_token(generation).await?;
        let first = self
            .client
            .cancel_subscription(&token, subscription_id)
            .await;
        let result = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token(generation).await?;
            self.client
                .cancel_subscription(&refreshed, subscription_id)
                .await
        } else {
            first
        };
        let _generation = self.require_auth_generation(generation)?;
        result
    }

    pub async fn create_checkout(
        &self,
        product_id: &str,
        idempotency_key: &str,
    ) -> Result<CloudCheckout, SyncError> {
        let generation = self.auth_generation();
        let token = self.access_token(generation).await?;
        let first = self
            .client
            .checkout(&token, product_id, idempotency_key)
            .await;
        let result = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token(generation).await?;
            self.client
                .checkout(&refreshed, product_id, idempotency_key)
                .await
        } else {
            first
        };
        let _generation = self.require_auth_generation(generation)?;
        result
    }
}
