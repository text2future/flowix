use std::path::PathBuf;

use tokio::process::Command;

use super::binary::resolve_claude_binary;
use super::history::claude_session_cwd;
use super::AGENT_TYPE;

pub(crate) fn resolve_claude_cwd(
    message: &crate::agent_flowix::AgentUserMessage,
    session_id: Option<&str>,
) -> PathBuf {
    let from_ipc = message
        .cwd_for_runtime(AGENT_TYPE)
        .map(PathBuf::from)
        .filter(|p| p.exists());
    if let Some(cwd) = from_ipc {
        return cwd;
    }

    if let Some(sid) = session_id.filter(|s| !s.trim().is_empty()) {
        if let Ok(Some(cwd)) = claude_session_cwd(sid) {
            if cwd.exists() {
                return cwd;
            }
        }
    }

    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

pub(crate) fn build_claude_command(
    session_id: Option<&str>,
    cwd: &PathBuf,
    workspace_paths: &[String],
    permission_mode: Option<&str>,
    model: Option<&str>,
) -> Command {
    let claude = resolve_claude_binary();
    let claude_real = std::fs::canonicalize(&claude).unwrap_or_else(|_| claude.clone());
    let mut cmd = match claude_real.extension().and_then(|s| s.to_str()) {
        Some("js") => {
            let node = resolve_claude_node_binary().unwrap_or_else(|| PathBuf::from("node"));
            let mut cmd = Command::new(node);
            cmd.arg(claude_real);
            cmd
        }
        _ => {
            let mut cmd = Command::new(claude);
            ensure_claude_node_on_path(&mut cmd);
            cmd
        }
    };
    crate::process_window::hide_command_window(&mut cmd);
    cmd.current_dir(cwd);
    cmd.arg("-p");
    if let Some(session_id) = session_id.filter(|s| !s.trim().is_empty()) {
        cmd.args(["--resume", session_id]);
    }
    cmd.args(["--output-format", "stream-json", "--verbose"]);
    if let Some(mode) = normalized_claude_permission_mode(permission_mode) {
        cmd.args(["--permission-mode", mode]);
    }
    if let Some(model) = normalized_claude_model(model) {
        cmd.args(["--model", model]);
    }
    append_additional_workspace_dirs(&mut cmd, cwd, workspace_paths);
    cmd.arg("");
    cmd
}

pub(crate) fn preflight_claude() -> Result<(), String> {
    let claude = resolve_claude_binary();
    let claude_real = std::fs::canonicalize(&claude).unwrap_or(claude);
    let needs_node = claude_real.extension().and_then(|s| s.to_str()) == Some("js");
    if !needs_node {
        return Ok(());
    }
    if resolve_claude_node_binary().is_none() {
        return Err(format!(
            "Claude Code CLI requires Node.js, but no Node.js installation was found. \
             Install Node.js from https://nodejs.org/, or set the CLAUDE_NODE_PATH \
             environment variable to your `node` binary. \
             (Claude binary resolved to: {})",
            resolve_claude_binary().display()
        ));
    }
    Ok(())
}

pub(crate) fn resolve_claude_node_binary() -> Option<PathBuf> {
    crate::agent_external::node::resolve_node_binary("CLAUDE_NODE_PATH")
}

#[cfg(test)]
pub(crate) fn parse_node_version(dir_name: &str) -> Option<(u32, u32, u32)> {
    crate::agent_external::node::parse_node_version(dir_name)
}

#[cfg(test)]
pub(crate) fn latest_versioned_subdir(root: &std::path::Path) -> Option<PathBuf> {
    crate::agent_external::node::latest_versioned_subdir(root)
}

fn ensure_claude_node_on_path(cmd: &mut Command) {
    crate::agent_external::node::ensure_node_on_path(cmd);
}

pub(crate) fn normalized_claude_model(model: Option<&str>) -> Option<&str> {
    let model = model?.trim();
    if model.is_empty() || model == "inherit" {
        return None;
    }
    Some(model)
}

fn append_additional_workspace_dirs(cmd: &mut Command, cwd: &PathBuf, workspace_paths: &[String]) {
    for path in normalized_additional_workspace_dirs(cwd, workspace_paths) {
        cmd.arg("--add-dir");
        cmd.arg(path);
    }
}

fn normalized_additional_workspace_dirs(cwd: &PathBuf, workspace_paths: &[String]) -> Vec<PathBuf> {
    let cwd_normalized = normalize_workspace_path_for_compare(cwd);
    let mut seen = std::collections::HashSet::new();
    let mut dirs = Vec::new();

    for raw in workspace_paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = PathBuf::from(trimmed);
        if !path.exists() {
            continue;
        }
        let normalized = normalize_workspace_path_for_compare(&path);
        if normalized == cwd_normalized || !seen.insert(normalized) {
            continue;
        }
        dirs.push(path);
    }

    dirs
}

fn normalize_workspace_path_for_compare(path: &PathBuf) -> String {
    path.to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .to_string()
}

pub(crate) fn normalized_claude_permission_mode(mode: Option<&str>) -> Option<&'static str> {
    match mode.map(str::trim) {
        Some("read-only") => Some("plan"),
        Some("workspace-write") => Some("acceptEdits"),
        Some("danger-full-access") => Some("bypassPermissions"),
        _ => None,
    }
}
