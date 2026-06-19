//! App State KV 存储 — `~/.flowix/global_meta_data.json`。
//!
//! 用于 memo-list 存每个 notebook 的 tag 顺序 / 隐藏状态等。
//! 保留原 `settings.*` 命令名 + 旧签名, 避免破坏前端调用方。

use std::collections::HashMap;

use serde::Serialize;
use tauri::State;

use super::AppState;

#[derive(Serialize)]
pub struct GetSettingResponse {
    pub value: Option<String>,
}

#[tauri::command]
pub fn get_setting(key: String, state: State<AppState>) -> GetSettingResponse {
    GetSettingResponse {
        value: state.global_meta_data.get(&key),
    }
}

#[derive(Serialize)]
pub struct GetAllSettingsResponse {
    pub settings: HashMap<String, String>,
}

#[tauri::command]
pub fn get_all_settings(state: State<AppState>) -> GetAllSettingsResponse {
    let mut map = HashMap::new();
    for (k, v) in state.global_meta_data.get_all() {
        map.insert(k, v);
    }
    GetAllSettingsResponse { settings: map }
}

#[tauri::command]
pub fn set_setting(key: String, value: String, state: State<AppState>) -> Result<(), String> {
    // 现有 set/delete 是 fire-and-forget, 内部已 warn 但不返回错误。
    // 这里返回 Ok 让前端能 await; 真正的磁盘错误仍在 tracing 日志里。
    state.global_meta_data.set(&key, &value);
    Ok(())
}

#[tauri::command]
pub fn set_multiple_settings(
    settings: HashMap<String, String>,
    state: State<AppState>,
) -> Result<(), String> {
    for (key, value) in settings {
        state.global_meta_data.set(&key, &value);
    }
    Ok(())
}

#[tauri::command]
pub fn delete_setting(key: String, state: State<AppState>) -> Result<bool, String> {
    Ok(state.global_meta_data.delete(&key))
}
