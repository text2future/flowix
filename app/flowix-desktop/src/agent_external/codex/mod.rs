mod app_server;
mod binary;
mod command;

pub const AGENT_TYPE: &str = "codex";
pub const MAX_TOOL_OUTPUT_CHARS: usize = 64 * 1024;
pub const MAX_UI_OUTPUT_PREVIEW_CHARS: usize = 4096;
pub use crate::agent_external::MAX_STDOUT_LINE_BYTES;

pub(crate) fn parse_codex_version(value: &str) -> Option<(u64, u64, u64)> {
    let stable = value.split('-').next()?;
    let mut parts = stable.split('.');
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ))
}

// Long-lived Codex App Server runtime.
pub use app_server::CodexAppServerManager;
pub(crate) use binary::resolve_codex_binary;
pub(crate) use command::{build_codex_entrypoint, preflight_codex};
