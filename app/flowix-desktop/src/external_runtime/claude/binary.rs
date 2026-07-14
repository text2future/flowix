use std::path::PathBuf;

use crate::external_runtime::cli_resolver::{
    no_extra_candidates, resolve_external_cli, ExternalCliSpec,
};

pub(crate) fn resolve_claude_binary() -> PathBuf {
    resolve_external_cli(&CLAUDE_CLI_SPEC)
}

const CLAUDE_CLI_SPEC: ExternalCliSpec = ExternalCliSpec {
    binary_name: "claude",
    #[cfg(windows)]
    windows_binary_name: "claude.cmd",
    env_vars: &["CLAUDE_CODE_CLI_PATH"],
    extra_unix_candidates: no_extra_candidates,
    #[cfg(windows)]
    extra_windows_candidates: claude_extra_windows_candidates,
};

#[cfg(windows)]
fn claude_extra_windows_candidates() -> Vec<PathBuf> {
    dirs::home_dir()
        .map(|home| vec![home.join(".local").join("bin").join("claude.exe")])
        .unwrap_or_default()
}
