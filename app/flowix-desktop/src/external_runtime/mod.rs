//! External agent runtimes — 后端用来跑 AI 对话的两条路径:
//!
//! - **sidecar CLI** (`claude` / `codex` / `hermes` / `simple_cli`): 本地
//!   spawn 一个 binary 子进程, 把 stdout 按行解析成 `AgentChunk`。
//!   三个 vendor 各有独立的 session 文件 (分别落 `~/.claude/` / `~/.codex/` /
//!   `~/.hermes/`), 由各自的 `history` 子模块读取。
//! - **in-process LLM provider** (`agent::factory`): 走 HTTP 流式协议。
//!
//! 本模块只收拢 sidecar 这一条。所有 sidecar 共享 `shared::ExternalRunRegistry`
//! (child 进程注册表 + watchdog) 和 `shared::emit_chunk_with_run_id` (统一
//! 把 run_id 写到 chunk payload 顶层)。
//!
//! 入口模块就两层: `shared` 是真正的 cross-runtime 工具, 其余每个 runtime
//! 都是 `cli + history` (history 只在有磁盘 session 文件的 vendor 里有意义)。

pub mod claude;
pub mod codex;
pub mod hermes;
pub mod shared;
pub mod simple_cli;

// Re-export cross-runtime helpers at the crate root so callers can write
// `crate::external_runtime::ExternalRunRegistry` without dropping into
// `shared`. Per-runtime APIs (ClaudeCliManager etc.) live on the
// submodules.
pub use shared::{
    emit_chunk_with_run_id, emit_stream_end_once, kill_child_tree,
    persist_watchdog_finalized_run_state, read_capped_line, resolve_run_id,
    select_external_session_for_runtime, ExternalRunRegistry, USER_STOPPED_REASON,
    MAX_STDOUT_LINE_BYTES,
};
