use std::sync::{Arc, RwLock};

use crate::agent_external::claude::ClaudeCliManager;
use crate::agent_external::codex::CodexCliManager;
use crate::agent_external::hermes::HermesCliManager;
use crate::agent_external::simple_cli;
use crate::agent_flowix::AgentManager;
use crate::agent_session::ThreadManager;
use crate::commands::cli::SidecarHandle;
use crate::config::{AgentAccessStore, SecurityBookmarkStore, UserConfigStore};
use crate::system_data::SystemData;
use flowix_core::memo_file::MemoFile;
use flowix_core::search::MemoIndex;

/// 应用状态 — 通过 `tauri::State<AppState>` 注入到 Tauri 命令和运行时服务。
///
/// `user_config` / `memo_file` / `thread_manager` 与 `agent_manager` 之间会共享
/// 引用 (例如 `AgentManager` 需要读写 thread_manager / memo_file), 共享形态是
/// `Arc<...>`, 不是 `Arc<RwLock<...>>` 套娃。锁的位置在具体字段内部。
///
/// `search` / `system_data` 没有跨模块需求, 保持原样 (无 Arc 包装)。
pub struct AppState {
    pub user_config: Arc<UserConfigStore>,
    /// System metadata (notebook tag order/layout/hidden state).
    /// Stored at `~/.flowix/boot/system.json`.
    pub system_data: SystemData,
    pub memo_file: Arc<RwLock<MemoFile>>,
    /// 当前 notebook 的全文搜索索引 (内存倒排). 切换 notebook 时 rebuild;
    /// 写命令增量 upsert/remove.
    pub search: RwLock<MemoIndex>,
    pub agent_manager: Arc<AgentManager>,
    pub codex_cli_manager: Arc<CodexCliManager>,
    pub claude_cli_manager: Arc<ClaudeCliManager>,
    pub gemini_cli_manager: Arc<simple_cli::SimpleCliManager>,
    pub hermes_cli_manager: Arc<HermesCliManager>,
    pub openclaw_cli_manager: Arc<simple_cli::SimpleCliManager>,
    pub thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>,
    /// Agent 可访问目录 (notebook + 用户自添加 folder), 持久化在
    /// `~/.flowix/agent-access.json`。驱动 [`crate::agent_flowix::tools::ToolScope`]
    /// 的 `allowed_roots` 与 `available_dirs` 工具的过滤。
    pub agent_access: Arc<AgentAccessStore>,
    pub security_bookmarks: Arc<SecurityBookmarkStore>,
    /// `flowix-cli serve` sidecar 句柄 ── 装在 `RwLock<Option<...>>` 里,
    /// 启动时先 manage 一个 `None` (placeholder), `.setup()` 末尾 spawn 完再写
    /// `Some(handle)`。通过 [`crate::commands::cli::cli_invoke`] 走 JSON-RPC
    /// 让前端调用 CLI 业务方法。
    pub flowix_cli: Arc<tokio::sync::RwLock<Option<Arc<SidecarHandle>>>>,
}
