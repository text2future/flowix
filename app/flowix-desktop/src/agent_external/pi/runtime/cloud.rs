//! Cloud 模型的凭据生命周期。
//!
//! Pi 的 Cloud 模型走的是「一条长连接 + 一份凭据」：连上时换一份短期凭据写进 Pi 的
//! 配置，断开时清掉。启动时还会做一次 refresh，失败不能阻塞本地模型 —— 所以每个
//! 入口都把错误包成字符串往上传，而不是中断进程。

use super::*;

use tauri::Emitter;

impl PiRpcManager {
    pub async fn connect_cloud_model_provider(
        &self,
        app: &tauri::AppHandle,
        api_base: &str,
    ) -> Result<(), String> {
        let cloud_sync = self.cloud_or_err()?.sync().clone();
        let generation = cloud_sync.ai_credential_session_generation();

        let mut cached_generation = self.cloud_credential_generation.lock().await;
        self.create_and_save_cloud_credential(app, api_base, &cloud_sync, generation)
            .await?;
        *cached_generation = Some(generation);
        Ok(())
    }

    /// Remove the local Flowix Cloud provider and its credential after logout.
    pub async fn disconnect_cloud_model_provider(
        &self,
        app: &tauri::AppHandle,
        api_base: &str,
        logout_generation: u64,
    ) -> Result<(), String> {
        // Serialize with credential creation and refresh before reading the
        // provider files, so a concurrent save cannot slip past this cleanup.
        let mut cached_generation = self.cloud_credential_generation.lock().await;
        let cloud_sync = self.cloud_or_err()?.sync().clone();
        if cloud_sync.ai_credential_session_generation() != logout_generation
            || cloud_sync
                .state()
                .map_err(|error| error.to_string())?
                .authenticated
        {
            return Ok(());
        }
        *cached_generation = None;
        if super::super::config::delete_cloud_providers(api_base)? {
            let _ = app.emit(crate::events::USER_CONFIG_CHANGED_EVENT, "pi_config");
        }
        Ok(())
    }

    /// Ensure the Flowix Cloud Pi catalog is available once for the current
    /// signed-in account, including the first login before a provider exists.
    /// The generation guard deduplicates calls from multiple content WebViews.
    pub async fn refresh_cloud_model_provider_at_startup(
        &self,
        app: &tauri::AppHandle,
        api_base: &str,
    ) -> Result<bool, String> {
        let cloud_sync = self.cloud_or_err()?.sync().clone();
        if !cloud_sync
            .state()
            .map_err(|error| error.to_string())?
            .authenticated
        {
            return Ok(false);
        }
        let generation = cloud_sync.ai_credential_session_generation();

        run_startup_cloud_credential_refresh_once(
            &self.startup_cloud_refresh_results,
            &self.cloud_credential_generation,
            generation,
            || async {
                self.create_and_save_cloud_credential(app, api_base, &cloud_sync, generation)
                    .await
            },
        )
        .await
    }

    /// Refresh the saved Flowix Cloud model catalog on an explicit user request.
    pub async fn refresh_cloud_model_provider(
        &self,
        app: &tauri::AppHandle,
        api_base: &str,
    ) -> Result<bool, String> {
        let has_cloud_provider = super::super::config::list()?
            .iter()
            .any(|provider| provider.source.as_deref() == Some("flowix-cloud"));
        if !has_cloud_provider {
            return Ok(false);
        }

        let cloud_sync = self.cloud_or_err()?.sync().clone();
        if !cloud_sync
            .state()
            .map_err(|error| error.to_string())?
            .authenticated
        {
            return Ok(false);
        }
        let generation = cloud_sync.ai_credential_session_generation();

        let mut cached_generation = self.cloud_credential_generation.lock().await;
        self.create_and_save_cloud_credential(app, api_base, &cloud_sync, generation)
            .await?;
        *cached_generation = Some(generation);
        Ok(true)
    }

    pub(super) async fn ensure_cloud_credential(
        &self,
        app: &tauri::AppHandle,
        provider_id: Option<&str>,
        api_base: &str,
    ) -> Result<Option<u64>, String> {
        if !super::super::config::is_flowix_cloud_provider(provider_id, api_base)? {
            return Ok(None);
        }
        let cloud_sync = self.cloud_or_err()?.sync().clone();
        let generation = cloud_sync.ai_credential_session_generation();
        let mut cached_generation = self.cloud_credential_generation.lock().await;
        if *cached_generation == Some(generation) {
            return Ok(Some(generation));
        }

        self.create_and_save_cloud_credential(app, api_base, &cloud_sync, generation)
            .await?;
        *cached_generation = Some(generation);
        Ok(Some(generation))
    }

    /// Prepare the account credential used by web search even when the active
    /// Pi model comes from a user-owned provider. Web search is a separate
    /// Flowix Cloud tool and does not depend on the selected model provider.
    pub(super) async fn ensure_web_search_credential(
        &self,
        app: &tauri::AppHandle,
        api_base: &str,
    ) -> Result<Option<u64>, String> {
        if api_base.is_empty() {
            return Ok(None);
        }
        let cloud_sync = self.cloud_or_err()?.sync().clone();
        if !cloud_sync
            .state()
            .map_err(|error| error.to_string())?
            .authenticated
        {
            return Ok(None);
        }
        let generation = cloud_sync.ai_credential_session_generation();
        let mut cached_generation = self.cloud_credential_generation.lock().await;
        if *cached_generation == Some(generation)
            && super::super::config::cloud_model_credential_key()?.is_some()
        {
            return Ok(Some(generation));
        }

        self.create_and_save_cloud_credential(app, api_base, &cloud_sync, generation)
            .await?;
        *cached_generation = Some(generation);
        Ok(Some(generation))
    }

    pub(super) async fn create_and_save_cloud_credential(
        &self,
        app: &tauri::AppHandle,
        api_base: &str,
        cloud_sync: &flowix_sync::SyncManager,
        generation: u64,
    ) -> Result<(), String> {
        let credential = cloud_sync
            .create_ai_credential()
            .await
            .map_err(|error| error.to_string())?;
        if cloud_sync.ai_credential_session_generation() != generation {
            return Err(
                "Flowix Cloud account changed while preparing the Pi model; retry the request"
                    .into(),
            );
        }
        if let Err(error) = super::super::config::save_cloud_credential(app, api_base, credential) {
            if cloud_sync.ai_credential_session_generation() == generation {
                if let Err(revoke_error) = cloud_sync.revoke_ai_credential().await {
                    tracing::warn!(
                        "failed to revoke an unconfigured Flowix Cloud Pi credential: {revoke_error}"
                    );
                }
            }
            return Err(error);
        }
        let _ = app.emit(crate::events::USER_CONFIG_CHANGED_EVENT, "pi_config");
        Ok(())
    }
}
