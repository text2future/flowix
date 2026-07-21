mod binary;
mod command;
mod events;
mod history;
mod stream;

pub const AGENT_TYPE: &str = "claude";
pub const MAX_LOG_TEXT_CHARS: usize = 2048;

// History API 鈹€鈹€ 璇?~/.claude/projects/<encoded>/*.jsonl, 杞垚 ChatMessage 娴併€?
pub use history::{get_session, is_claude_session_id, list_sessions};

// CLI runtime 鈹€鈹€ spawn `claude` binary 瀛愯繘绋? stdout 鎸夎瑙ｆ瀽, 閫氳繃 shared::emit_chunk_with_run_id
// 鎶曢€?AgentChunk銆?
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
