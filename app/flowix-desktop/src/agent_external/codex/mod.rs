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

// CLI runtime 鈹€鈹€ spawn `codex` binary 瀛愯繘绋? 鎸?JSONL 琛岃В鏋?stdout銆?
pub use cli::CodexCliManager;

// History API 鈹€鈹€ 璇?~/.codex/sessions/* 涓嬬殑 jsonl, 杞垚 ChatMessage 娴併€?
pub use history::{get_session, get_session_page, is_codex_session_id, list_sessions};

// Event JSON 鈫?AgentChunk 杞崲 (渚?cli 妯″潡鍐呴儴浣跨敤, 涔熷澶栨毚闇茬粰
// 鏈潵鎯宠鍐呭祵鍒伴潪澶栭儴 runtime 鐨勮皟鐢ㄦ柟澶嶇敤)銆?
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
