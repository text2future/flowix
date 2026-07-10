pub mod events;
pub mod io;
pub mod runtime;
pub mod session;

pub const AGENT_TYPE: &str = "codex";
pub const MAX_TOOL_OUTPUT_CHARS: usize = 64 * 1024;
pub const MAX_LOG_TEXT_CHARS: usize = 2048;
pub const MAX_UI_OUTPUT_PREVIEW_CHARS: usize = 4096;
pub use crate::external_run::MAX_STDOUT_LINE_BYTES;

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
