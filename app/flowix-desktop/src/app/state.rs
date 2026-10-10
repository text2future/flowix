use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, RwLock};

use serde::Serialize;

use crate::agent_external::runtime_registry::ExternalRuntimeRegistry;
use crate::agent_external_config::AgentExternalConfig;
use crate::agent_session::ThreadManager;
use crate::app::startup::StartupCoordinator;
use crate::config::{AgentAccessStore, SecurityBookmarkStore, UserConfigStore};
use crate::plugin::PluginRunCoordinator;
use crate::system_data::SystemData;
use flowix_core::memo_file::MemoFile;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NotebookImportStatusKind {
    Started,
    Skipped,
    Completed,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookImportStatus {
    pub notebook_id: String,
    pub status: NotebookImportStatusKind,
    pub message: Option<String>,
}

/// 应用状态 ── 通过 `tauri::State<AppState>` 注入给 Tauri 命令和运行时服务。
///
/// `user_config` / `memo_file` / `thread_manager` 之间会共享
/// 引用, 共享形态是 `Arc<...>`, 不是 `Arc<RwLock<...>>` 套娃。
/// 锁的位置在具体字段内部。
///
/// `search` / `system_data` 没有跨模块需求, 保持原样 (不 Arc 包裹)。
pub struct AppState {
    pub upload_sessions: Arc<crate::commands::dialog::upload_sessions::UploadSessions>,
    pub document_access: crate::app::document_access::DocumentAccess,
    pub export_access: crate::app::export_access::ExportAccess,
    pub user_config: Arc<UserConfigStore>,
    pub cloud_sync: Arc<flowix_sync::SyncManager>,
    /// Legacy system metadata reader used to migrate notebook tag state into
    /// each notebook's `.flowix/system.json`.
    pub system_data: SystemData,
    /// External CLI 路径配置 (`~/.flowix/agent-external-config.json`) ──
    /// codex/claude/hermes/opencode 执行路径的唯一参照, 启动探测写入,
    /// 运行时 `resolve_external_cli` 命中即用。
    pub agent_external_config: AgentExternalConfig,
    pub memo_file: Arc<RwLock<MemoFile>>,
    /// 当前 notebook 的全文搜索索引 (内存倒排). 切换 notebook 时 rebuild;
    /// 写命令做 upsert/remove.
    pub external_runtimes: Arc<ExternalRuntimeRegistry>,
    /// Long-lived Codex App Server. Codex owns its thread history and model
    /// catalog; Flowix stores only the mapping to its local conversation.
    pub codex_app_server: Arc<crate::agent_external::codex::CodexAppServerManager>,
    pub opencode: Arc<crate::agent_external::opencode::OpenCodeAcpManager>,
    pub pi: Arc<crate::agent_external::pi::PiRpcManager>,
    pub deepseek_harness: Arc<crate::agent_external::deepseek_harness::DeepSeekHarnessManager>,
    /// Product-level history policy and fallback orchestration. Runtime
    /// adapters remain responsible for their own protocol and transcript.
    pub agent_history: Arc<crate::agent_history::AgentHistoryService>,
    /// Product-level thread archive/delete dispatch across external runtimes.
    /// Runtimes without a lifecycle adapter keep Flowix-local semantics.
    pub agent_lifecycle: Arc<crate::agent_lifecycle::AgentLifecycleService>,
    pub thread_manager: Arc<ThreadManager>,
    /// Agent 可访问目录 (notebook + 用户额外 folder), 持久化在
    /// `~/.flowix/agent-access.json`。驱动 external agent 的
    /// 工作区 / 资料目录过滤。
    pub agent_access: Arc<AgentAccessStore>,
    pub security_bookmarks: Arc<SecurityBookmarkStore>,
    pub plugin_runs: PluginRunCoordinator,
    /// Last known state for background notebook imports. Keeping the state in
    /// AppState lets a Webview recover when it subscribes after an event was
    /// emitted or when a transient IPC/event bridge failure occurs.
    pub notebook_imports: Arc<Mutex<HashMap<String, NotebookImportStatus>>>,
    /// In-process exclusion for durable first-open template preparation jobs.
    pub notebook_template_initializations: Arc<Mutex<HashSet<String>>>,
    /// Serializes the complete current-notebook transition, including its
    /// migration, index invalidation, and persisted selection update.
    pub notebook_transition: Arc<Mutex<()>>,
    /// Native startup migrations are independent from WebView startup but
    /// remain a gate for commands that depend on a consistent memo library.
    pub startup: Arc<StartupCoordinator>,
}
