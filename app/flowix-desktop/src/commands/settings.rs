//! 鍋忓ソ / AI 閰嶇疆 IPC 鈥?`~/.flowix/boot/preference.json` + `~/.flowix/agent-config.toml`銆?//!
//! 涓や釜 JSON 鏂囦欢鐢?`crate::config::UserConfigStore` 绠＄悊 (鍘熷瓙鍐? 0o600)銆?//! 鍐欏叆鎴愬姛鍚?emit `user-config-changed` 浜嬩欢, 璁╁绐楀彛 React 鏍戦噸鏂?load銆?
use crate::events as dispatcher;
use tauri::{AppHandle, State};

use crate::agent_flowix::provider::{probe_chat, TestConnectionResult};
use crate::config::{AiConfigFile, AiModelConfig, PreferenceFile};

use crate::app::state::AppState;

/// 璺ㄧ獥鍙ｅ悓姝ヤ簨浠?鈥?浠讳竴绐楀彛鎴愬姛鍐欏叆鍋忓ソ / AI 閰嶇疆鍚?emit, 鍏跺畠绐楀彛
/// (涓荤獥鍙?/ 鍋忓ソ绐楀彛 / 鏈潵鐨勫绐楀彛) 鏀跺埌鍚庝粠纾佺洏閲嶆柊 load銆?/// 瑙ｅ喅: 涓や釜 Tauri 绐楀彛鍚勮窇鐙珛 React 鏍?+ 鐙珛 zustand store, 涓€杈?/// 鏀瑰姩鍙︿竴杈圭湅涓嶅埌鐨勯棶棰樸€?
pub(super) const USER_CONFIG_CHANGED_EVENT: &str = "user-config-changed";

/// 鐢ㄦ埛鍋忓ソ (preference.json) 鈥?璧?~/.flowix/boot/preference.json
#[tauri::command]
pub fn get_preference(state: State<AppState>) -> PreferenceFile {
    state.user_config.get_preference()
}

#[tauri::command]
pub fn set_preference(
    preference: PreferenceFile,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    state
        .user_config
        .set_preference(preference)
        .map(|_| {
            dispatcher::emit_to(&app, USER_CONFIG_CHANGED_EVENT, "preference");
            Ok(())
        })
        .map_err(|e| e.to_string())?
}

/// AI 妯″瀷閰嶇疆 (agent-config.toml) 鈥?璧?~/.flowix/agent-config.toml
#[tauri::command]
pub fn get_ai_config(state: State<AppState>) -> AiConfigFile {
    state.user_config.get_ai_config()
}

#[tauri::command]
pub fn set_ai_config(
    config: AiConfigFile,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    state
        .user_config
        .set_ai_config(config)
        .map(|_| {
            dispatcher::emit_to(&app, USER_CONFIG_CHANGED_EVENT, "ai_config");
            Ok(())
        })
        .map_err(|e| e.to_string())?
}

/// 鏂囦欢鐩戝惉鐧?榛戝悕鍗?(PR2) 鈥?璧?`preference.json::watcher` 瀛楁銆?///
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
    let mut pref = state.user_config.get_preference();
    pref.watcher = config;
    state
        .user_config
        .set_preference(pref)
        .map(|_| {
            dispatcher::emit_to(&app, USER_CONFIG_CHANGED_EVENT, "watcher");
            Ok(())
        })
        .map_err(|e| e.to_string())?
}

/// One-shot connectivity probe for the AI configuration form.
///
/// Distinct from `set_ai_config`:
/// - **Does not write to disk** 鈥?the user is editing, not committing.
/// - **Does not emit** `user-config-changed` 鈥?no cross-window reload needed.
/// - **Bypasses** the `AgentManager` provider cache 鈥?each probe uses a
///   fresh instance built from the exact config being tested.
///
/// Returns a structured `TestConnectionResult` (always 200-shaped for the
/// IPC boundary; failures live in `result.error.kind`), so the UI can pick
/// the right hint based on auth vs network vs bad-model etc.
///
/// Note: `AiModelConfig` is `#[serde(rename_all = "camelCase")]`, so the
/// front-end sends `apiUrl` / `apiKeys` directly 鈥?no extra conversion.
#[tauri::command]
pub async fn test_ai_connection(config: AiModelConfig) -> TestConnectionResult {
    probe_chat(&config).await
}
