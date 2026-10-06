//! 偏好 / AI 配置 IPC —— `~/.flowix/boot/preference.json` + DeepSeek Harness
//! 的 llm-pi-ai settings。文件读写由 `crate::config::UserConfigStore` 管理
//! (原子写, 0o600)。写入成功后 emit `user-config-changed` 事件,
//! 让各窗口 React 树重新 load。
use crate::events as dispatcher;
use tauri::{AppHandle, Emitter, State};

use crate::config::{AiConfigFile, AiModelConfig, PreferenceFile};
use crate::connection_probe::TestConnectionResult;

use crate::agent_external::pi::config::{self as pi_model_config, PiProviderConfig};
use crate::app::state::AppState;

/// 跨窗口同步事�?—任一窗口成功写入偏好 / AI 配置�?emit, 其它窗口
/// (主窗�?/ 偏好窗口 / �?��的�?窗口) 收到后从磁盘重新 load�?/// 解决: 两个 Tauri 窗口各跑�?�� React �?+ �?�� zustand store, 一�?/// 改动另一边看不到的问题�?
pub(super) const USER_CONFIG_CHANGED_EVENT: &str = "user-config-changed";

/// 用户偏好 (preference.json) —�?~/.flowix/boot/preference.json
#[tauri::command]
pub fn get_preference(state: State<AppState>) -> PreferenceFile {
    state.user_config.get_preference()
}

#[tauri::command]
pub fn patch_preference(
    patch: serde_json::Value,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    state
        .user_config
        .patch_preference(patch)
        .map(|_| {
            let _ = app.emit(USER_CONFIG_CHANGED_EVENT, "preference");
        })
        .map_err(|error| error.to_string())
}

/// DeepSeek Harness model configuration. This is persisted by llm-pi-ai's
/// settings-file provider at `~/.dsh/settings.yaml`, independently of
/// the retired built-in agent's `agent-config.toml`.
#[tauri::command]
pub async fn get_deepseek_harness_config(
    state: State<'_, AppState>,
) -> Result<AiConfigFile, String> {
    let mut configs = load_dsh_model_configs(&state).await?;
    hydrate_dsh_credentials_without_blocking(&state, &mut configs).await;
    Ok(configs.into_iter().next().unwrap_or_default())
}

#[tauri::command]
pub async fn get_deepseek_harness_configs(
    state: State<'_, AppState>,
) -> Result<Vec<AiConfigFile>, String> {
    let mut configs = load_dsh_model_configs(&state).await?;
    hydrate_dsh_credentials_without_blocking(&state, &mut configs).await;
    Ok(configs)
}

async fn load_dsh_model_configs(state: &State<'_, AppState>) -> Result<Vec<AiConfigFile>, String> {
    state.deepseek_harness.dsh_model_configs().await
}

/// Preferences must remain usable when Flowix has just installed an older or
/// temporarily unavailable remote DSH runtime. Credential migration/status is
/// best-effort here; save and connection-test commands still return actionable
/// runtime errors when the user explicitly invokes them.
async fn hydrate_dsh_credentials_without_blocking(
    state: &State<'_, AppState>,
    configs: &mut [AiConfigFile],
) {
    if let Err(error) = state
        .deepseek_harness
        .migrate_legacy_credentials(configs)
        .await
    {
        tracing::warn!(%error, "could not migrate legacy Flowix credentials to DSH");
    }
    if let Err(error) = state
        .deepseek_harness
        .hydrate_credential_statuses(configs)
        .await
    {
        for config in configs.iter_mut() {
            // Unknown is treated conservatively as configured so merely
            // opening/saving preferences cannot delete an existing DSH key.
            config.model.credential_configured = true;
        }
        tracing::warn!(%error, "could not read credential status from DSH");
    }
}

#[tauri::command]
pub async fn set_deepseek_harness_config(
    mut config: AiConfigFile,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    state.deepseek_harness.invalidate_hosts().await?;
    state
        .deepseek_harness
        .persist_credential(&config.model)
        .await?;
    config.model.api_keys.clear();
    state
        .deepseek_harness
        .persist_dsh_model_config(&config, false)
        .await?;
    dispatcher::emit_to(&app, USER_CONFIG_CHANGED_EVENT, "dsh_config");
    Ok(())
}

#[tauri::command]
pub async fn add_deepseek_harness_model(
    mut config: AiConfigFile,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    state.deepseek_harness.invalidate_hosts().await?;
    state
        .deepseek_harness
        .persist_credential(&config.model)
        .await?;
    config.model.api_keys.clear();
    state
        .deepseek_harness
        .persist_dsh_model_config(&config, true)
        .await?;
    dispatcher::emit_to(&app, USER_CONFIG_CHANGED_EVENT, "dsh_config");
    Ok(())
}

/// 文件监听�?黑名�?(PR2) —�?`preference.json::watcher` 字�?�?///
/// 鎻愪緵鐙珛 IPC, 閬垮厤鍓嶇涓烘敼涓€涓瓧娈典紶瀹屾暣 PreferenceFile; 鍐欏悗
/// emit `user-config-changed` 瑙﹀彂 `MemoWatcher::set_whitelist` 鐑洿鏂般€?
#[tauri::command]
pub fn get_watcher_config(state: State<AppState>) -> crate::watcher::WhitelistConfig {
    state.user_config.get_preference().watcher
}

#[tauri::command]
pub fn update_watcher_config(
    config: crate::watcher::WhitelistConfig,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let previous = state.user_config.get_preference().watcher;
    if config.skip_dirs != previous.skip_dirs
        || config.skip_files != previous.skip_files
        || config.allowed_filename_patterns != previous.allowed_filename_patterns
        || config.watch_hidden != previous.watch_hidden
    {
        return Err("WATCHER_PATH_RULES_MOVED_TO_FILE_MANAGEMENT".to_string());
    }
    state
        .user_config
        .patch_preference(serde_json::json!({ "watcher": config }))
        .map(|_| {
            dispatcher::emit_to(&app, USER_CONFIG_CHANGED_EVENT, "watcher");
            Ok(())
        })
        .map_err(|e| e.to_string())?
}

/// Harness-specific model probe used only by the DeepSeek Harness preferences
/// page.
#[tauri::command]
pub async fn test_deepseek_harness_connection(
    config: AiModelConfig,
    state: State<'_, AppState>,
) -> Result<TestConnectionResult, String> {
    Ok(state.deepseek_harness.test_connection(&config).await)
}

#[tauri::command]
pub async fn deepseek_harness_model_catalog(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state.deepseek_harness.model_catalog().await
}

#[tauri::command]
pub async fn deepseek_harness_plugin_catalog(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state.deepseek_harness.plugin_catalog().await
}

#[tauri::command]
pub async fn set_deepseek_harness_plugin_enabled(
    plugin_key: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state
        .deepseek_harness
        .set_plugin_enabled(&plugin_key, enabled)
        .await
}

#[tauri::command]
pub async fn discover_deepseek_harness_models(
    config: AiModelConfig,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state.deepseek_harness.discover_models(&config).await
}

#[tauri::command]
pub fn get_pi_model_configs() -> Result<Vec<PiProviderConfig>, String> {
    pi_model_config::list()
}

#[tauri::command]
pub fn get_pi_model_catalog(
    app: AppHandle,
) -> Result<crate::agent_external::pi::config::PiModelCatalog, String> {
    pi_model_config::catalog(&app)
}

#[tauri::command]
pub fn save_pi_model_config(config: PiProviderConfig, app: AppHandle) -> Result<(), String> {
    pi_model_config::save(config, &app)?;
    dispatcher::emit_to(&app, USER_CONFIG_CHANGED_EVENT, "pi_config");
    Ok(())
}

#[tauri::command]
pub fn delete_pi_model_config(provider_id: String, app: AppHandle) -> Result<(), String> {
    pi_model_config::delete(&provider_id)?;
    dispatcher::emit_to(&app, USER_CONFIG_CHANGED_EVENT, "pi_config");
    Ok(())
}

#[tauri::command]
pub async fn test_pi_model_config(config: PiProviderConfig) -> Result<u64, String> {
    pi_model_config::test_connection(config).await
}

#[tauri::command]
pub async fn discover_pi_models(
    config: PiProviderConfig,
) -> Result<Vec<crate::agent_external::pi::config::PiModelEntry>, String> {
    pi_model_config::discover_models(config).await
}
