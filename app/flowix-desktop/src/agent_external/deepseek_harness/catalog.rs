use std::collections::HashSet;

use super::config::resolve_runtime_config;
use super::discovery::timed_host_request;
use super::error::validate_plugin_key;
use super::manager::{DeepSeekHarnessManager, DeepSeekHarnessSessionUsage};
use super::protocol;
use super::AGENT_TYPE;
use crate::config::AiModelConfig;

impl DeepSeekHarnessManager {
    /// Return the vendored llm-pi-ai catalog without requiring a configured
    /// provider or API key. The response is static and contains no secrets.
    pub async fn model_catalog(&self) -> Result<serde_json::Value, String> {
        let host = self.model_host().await?;
        let result = timed_host_request(
            &host.client(),
            protocol::model_catalog_request(host.next_request_id()),
        )
        .await;
        result
    }

    pub async fn session_usage(
        &self,
        thread_id: &str,
    ) -> Result<Option<DeepSeekHarnessSessionUsage>, String> {
        let session_id = self
            .thread_manager
            .get_external_session(thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;

        let Some(session_id) = session_id else {
            return Ok(None);
        };
        let host = self.model_host().await?;
        let request = protocol::app_session_usage_request(host.next_request_id(), &session_id);
        let result = timed_host_request(&host.client(), request).await?;
        if result.is_null() {
            return Ok(None);
        }
        serde_json::from_value(result)
            .map(Some)
            .map_err(|error| format!("invalid DeepSeek Harness session usage: {error}"))
    }

    /// Return the plugin rows from the same host and agent-preset compositions
    /// used by dsh-host. This is metadata only and does not require a model or
    /// API key, so the preferences page can load it before the first chat.
    pub async fn plugin_catalog(&self) -> Result<serde_json::Value, String> {
        let host = self.model_host().await?;
        let result = timed_host_request(
            &host.client(),
            protocol::plugins_catalog_request(host.next_request_id()),
        )
        .await;
        result.and_then(|value| {
            value
                .get("plugins")
                .filter(|plugins| plugins.is_object())
                .cloned()
                .or_else(|| {
                    // Accept the unwrapped shape too so the desktop client
                    // remains compatible with hosts that expose the catalog
                    // directly.
                    (value.get("host").is_some() && value.get("presets").is_some())
                        .then_some(value.clone())
                })
                .ok_or_else(|| "DeepSeek Harness returned an invalid plugin catalog".to_string())
        })
    }

    pub async fn set_plugin_enabled(
        &self,
        plugin_key: &str,
        enabled: bool,
    ) -> Result<serde_json::Value, String> {
        let _lifecycle = self.lifecycle_gate.lock().await;
        validate_plugin_key(plugin_key)?;
        if !self.runs.is_empty().await {
            return Err("DeepSeek Harness 插件运行中不可切换，请先停止当前任务".to_string());
        }

        self.user_config
            .set_deepseek_harness_plugin_enabled(plugin_key, enabled)
            .map_err(|error| error.to_string())?;

        self.hosts.shutdown_if_no_runs().await?;

        self.plugin_catalog().await
    }

    /// Backwards-compatible flat model list for older callers. New DSH UI code
    /// uses `deepseekHarness.list()` so it can retain the provider route next
    /// to every model id; this method intentionally remains string-only.
    pub async fn supported_models(&self) -> Result<Vec<String>, String> {
        let configs = self
            .dsh_model_configs()
            .await?
            .into_iter()
            .flat_map(|config| {
                let model = config.model;
                if model.models.is_empty() {
                    vec![model.model].into_iter()
                } else {
                    model
                        .models
                        .into_iter()
                        .map(|entry| entry.id)
                        .collect::<Vec<_>>()
                        .into_iter()
                }
            })
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
            .collect::<Vec<_>>();
        let mut seen = HashSet::new();
        let models = configs
            .into_iter()
            .filter(|id| seen.insert(id.clone()))
            .collect();
        Ok(models)
    }

    /// Discover models for the provider draft currently being edited. The key
    /// is sent only in this one request and is never persisted by the host.
    pub async fn discover_models(
        &self,
        config: &AiModelConfig,
    ) -> Result<serde_json::Value, String> {
        let runtime_config = resolve_runtime_config(config, None)?;
        // The route id is the pi-ai provider id for built-in routes. For a
        // custom route it intentionally falls through to endpoint discovery;
        // using the route here also lets newly-added pi-ai providers work
        // without another Flowix provider mapping.
        let provider = Some(runtime_config.provider.as_str());
        let host = self.model_host().await?;
        let request = protocol::model_discover_request(
            host.next_request_id(),
            provider,
            &runtime_config.base_url,
            &runtime_config.api_protocol,
            runtime_config.api_key.as_deref(),
        );
        let result = timed_host_request(&host.client(), request).await;
        result
    }
}
