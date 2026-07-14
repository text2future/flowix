use std::path::PathBuf;

use crate::external_runtime::cli_resolver::{resolve_external_cli, ExternalCliSpec};

pub(crate) fn resolve_codex_binary() -> PathBuf {
    if let Some(path) = crate::external_runtime::binary::custom_agent_binary("codex", "codex") {
        return path;
    }
    resolve_external_cli(&CODEX_CLI_SPEC)
}

#[cfg(test)]
pub(crate) fn codex_candidate_paths() -> Vec<PathBuf> {
    crate::external_runtime::cli_resolver::external_cli_candidate_paths(&CODEX_CLI_SPEC)
}

const CODEX_CLI_SPEC: ExternalCliSpec = ExternalCliSpec {
    binary_name: "codex",
    #[cfg(windows)]
    windows_binary_name: "codex.cmd",
    env_vars: &["CODEX_CLI_PATH"],
    extra_unix_candidates: codex_extra_unix_candidates,
    #[cfg(windows)]
    extra_windows_candidates: crate::external_runtime::cli_resolver::no_extra_candidates,
};

fn codex_extra_unix_candidates() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        // ChatGPT for macOS bundles a native Codex CLI here. Treat it as a
        // product-supported fallback when npm/global installs are absent.
        return vec![PathBuf::from(
            "/Applications/ChatGPT.app/Contents/Resources/codex",
        )];
    }

    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}
