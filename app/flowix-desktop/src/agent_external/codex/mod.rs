pub mod binary;
pub mod cli;
mod command;
pub mod events;
pub mod history;
pub mod io;
pub mod runtime;
mod stream;
mod tool_events;

pub const AGENT_TYPE: &str = "codex";
pub const MAX_TOOL_OUTPUT_CHARS: usize = 64 * 1024;
pub const MAX_LOG_TEXT_CHARS: usize = 2048;
pub const MAX_UI_OUTPUT_PREVIEW_CHARS: usize = 4096;
pub use crate::agent_external::MAX_STDOUT_LINE_BYTES;

// CLI runtime ── spawn `codex` binary 子进程, 按 JSONL 行解析 stdout。
pub use cli::CodexCliManager;

// History API ── 读 ~/.codex/sessions/* 下的 jsonl, 转成 ChatMessage 流。
pub use history::{get_session, get_session_page, is_codex_session_id, list_sessions};

// Event JSON → AgentChunk 转换 (供 cli 模块内部使用, 也对外暴露给
// 未来想要内嵌到非外部 runtime 的调用方复用)。

pub fn truncate_for_log(text: &str) -> String {
    truncate_chars(text, MAX_LOG_TEXT_CHARS)
}

pub fn truncate_chars(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{truncated}\n...[truncated]")
    } else {
        truncated
    }
}
