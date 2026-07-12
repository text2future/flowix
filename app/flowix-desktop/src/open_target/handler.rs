//! Tauri IPC: `open_memo_by_target` — 接收任意形式的"打开目标", 解析 +
//! 落盘校验 + emit `flowix:open-target` 给前端。 前端做真正的 UI 切换。
//!
//! 这是后端"权威解析"边界 ── 前端热路径(粘贴 / Agent / 跨窗口)拿不到完整
//! notebook 信息, 一律走这个 IPC 让后端查磁盘。
//!
//! ## 失败语义
//!
//! - `Err(String)` → 前端 await 抛错, 调用方 `try/catch` 静默 return。
//! - 解析失败 (`OpenTargetError`) / 解析后查不到 (`ResolveError`) 都映射到 `None`,
//!   前端视为"用户粘贴了不存在的路径"或"memo 已被删", 静默 no-op。

use crate::watcher::dispatcher;
use tauri::{AppHandle, State};

use super::parser::parse_open_target;
use super::resolver::resolve_open_target;
use super::ResolvedOpenTarget;

/// Tauri command: 接收任意 `OpenTarget` 原始字符串, 返回 `ResolvedOpenTarget`。
///
/// 副作用:
/// - emit `flowix:open-target` 事件给所有窗口 (主窗口优先处理)。
#[tauri::command]
pub fn open_memo_by_target(
    raw: String,
    emit_event: Option<bool>,
    state: State<'_, crate::commands::AppState>,
    app: AppHandle,
) -> Option<ResolvedOpenTarget> {
    let parsed = match parse_open_target(&raw) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("[open_target] parse failed: {e}");
            return None;
        }
    };

    let resolved = match resolve_open_target(parsed, state.inner()) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("[open_target] resolve failed: {e}");
            return None;
        }
    };

    // 推前端: 主窗口 + 偏好窗口都能收到, 由前端 listener 自行判断是否处理。
    // 主窗口 prefs 窗口都挂了 listener (顶层 app.tsx), 主窗口负责真正打开,
    // 偏好窗口收到后直接忽略。
    // emit_to 返回 bool 用于诊断, 错误跟 agent.rs::emit_chunk 一致留追踪。
    if emit_event.unwrap_or(true) && !dispatcher::emit_to(&app, "flowix:open-target", &resolved) {
        tracing::warn!("[open_target] emit failed (no subscribers or transport error)");
    }

    Some(resolved)
}
