//! 偏好 / AI 配置 IPC — `~/.flowix/boot/preference.json` + `~/.flowix/agent-config.toml`。
//!
//! 两个 JSON 文件由 `crate::config::UserConfigStore` 管理 (原子写, 0o600)。
//! 写入成功后 emit `user-config-changed` 事件, 让多窗口 React 树重新 load。

use crate::watcher::dispatcher;
use tauri::{AppHandle, Emitter, State};

use crate::config::{AiConfigFile, PreferenceFile};

use super::AppState;

/// 跨窗口同步事件 — 任一窗口成功写入偏好 / AI 配置后 emit, 其它窗口
/// (主窗口 / 偏好窗口 / 未来的多窗口) 收到后从磁盘重新 load。
/// 解决: 两个 Tauri 窗口各跑独立 React 树 + 独立 zustand store, 一边
/// 改动另一边看不到的问题。
pub(super) const USER_CONFIG_CHANGED_EVENT: &str = "user-config-changed";

/// 用户偏好 (preference.json) — 走 ~/.flowix/boot/preference.json
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

/// AI 模型配置 (agent-config.toml) — 走 ~/.flowix/agent-config.toml
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

/// 文件监听白/黑名单 (PR2) — 走 `preference.json::watcher` 字段。
///
/// 提供独立 IPC, 避免前端为改一个字段传完整 PreferenceFile; 写后
/// emit `user-config-changed` 触发 `MemoWatcher::set_whitelist` 热更新。
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
