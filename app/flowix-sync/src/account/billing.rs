use super::*;

impl AccountService {
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
