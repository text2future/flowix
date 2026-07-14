mod binary;
mod command;
mod events;
mod history;
mod stream;

pub const AGENT_TYPE: &str = "claude";
pub const MAX_LOG_TEXT_CHARS: usize = 2048;

// History API ── 读 ~/.claude/projects/<encoded>/*.jsonl, 转成 ChatMessage 流。
pub use history::{get_session, is_claude_session_id, list_sessions};

// CLI runtime ── spawn `claude` binary 子进程, stdout 按行解析, 通过 shared::emit_chunk_with_run_id
// 投递 AgentChunk。
pub mod cli;
pub use cli::ClaudeCliManager;

pub fn truncate_for_log(text: &str) -> String {
    let mut chars = text.chars();
    let truncated: String = chars.by_ref().take(MAX_LOG_TEXT_CHARS).collect();
    if chars.next().is_some() {
        format!("{truncated}\n...[truncated]")
    } else {
        truncated
    }
}
