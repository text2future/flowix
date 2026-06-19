//! Agent 访问目录 IPC — 读写 `~/.flowix/agent_access.json`。
//!
//! 与 `commands::settings` 同形: 写操作成功后 emit `agent-access-changed`
//! 事件, 其它窗口的 React 树收到后从磁盘重新 load。 前端 `set_agent_access`
//! 走乐观更新 (改本地后再 await), 失败由 store 的 `loadInitial` 回滚 ──
//! 见 `app/flowix-web/lib/store/agent-access-store.ts`。

use crate::watcher::dispatcher;
use tauri::{AppHandle, Emitter, State};

use crate::agent_access::AgentAccessConfig;

use super::AppState;

/// 跨窗口同步事件 ── 任一窗口成功写入 agent_access.json 后 emit, 其它窗口
/// 收到后从磁盘重新 load。 payload 是 `()` (无 payload), 监听者直接
/// `loadInitial()` 拉整份 config ── 比按 entry diff 简单且不会错过任何字段。
pub(super) const AGENT_ACCESS_CHANGED_EVENT: &str = "agent-access-changed";

/// 拉取当前 agent_access 整份 config。 每次都从 store 读, `missing` 字段
/// 在 `get_config` 内重新算, 失联目录会立刻拿到最新 disk 状态。
#[tauri::command]
pub fn get_agent_access(state: State<AppState>) -> AgentAccessConfig {
    state.agent_access.get_config()
}

/// 用整份新 config 覆盖 (前端走乐观更新, 整份 set 避免一条 IPC 一份的
/// 复杂协议)。 先落盘, 再 emit, 成功才更新内存 (跟 user_config 的 set
/// 路径完全对齐)。
#[tauri::command]
pub fn set_agent_access(
    config: AgentAccessConfig,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    state
        .agent_access
        .replace_config(config)
        .map(|_| {
            dispatcher::emit_to(&app, AGENT_ACCESS_CHANGED_EVENT, ());
            Ok(())
        })
        .map_err(|e| e.to_string())?
}
