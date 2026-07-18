use std::path::PathBuf;

use tokio::process::Command;

use super::binary::resolve_codex_binary;
use super::history::codex_session_cwd;
use super::AGENT_TYPE;

/// Cwd fallback chain:
/// 1. `message.cwd_for_runtime` from IPC runtime_config.
/// 2. The original cwd persisted in Codex session metadata.
/// 3. Tauri process cwd.
/// 4. ".".
pub(crate) fn resolve_codex_cwd(
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
        if let Ok(Some(cwd)) = codex_session_cwd(sid) {
            if cwd.exists() {
                return cwd;
            }
        }
    }

    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

#[cfg(test)]
pub(crate) fn build_codex_command(
    session_id: Option<&str>,
    cwd: &PathBuf,
    workspace_paths: &[String],
    permission_mode: Option<&str>,
    codex_model: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Command {
    build_codex_command_with_images(
        session_id,
        cwd,
        workspace_paths,
        permission_mode,
        codex_model,
        reasoning_effort,
        &[],
    )
}

pub(crate) fn build_codex_command_with_images(
    session_id: Option<&str>,
    cwd: &PathBuf,
    workspace_paths: &[String],
    permission_mode: Option<&str>,
    codex_model: Option<&str>,
    reasoning_effort: Option<&str>,
    image_paths: &[String],
) -> Command {
    let codex = resolve_codex_binary();
    let codex_real = std::fs::canonicalize(&codex).unwrap_or_else(|_| codex.clone());
    let mut cmd = match codex_real.extension().and_then(|s| s.to_str()) {
        Some("js") => {
            let node = resolve_node_binary().unwrap_or_else(|| PathBuf::from("node"));
            let mut cmd = Command::new(node);
            cmd.arg(codex_real);
            cmd
        }
        _ => {
            let mut cmd = Command::new(codex);
            ensure_node_on_path(&mut cmd);
            cmd
        }
    };
    cmd.current_dir(cwd);
    crate::process_window::hide_command_window(&mut cmd);
    // `--search` is a Codex top-level option (not an `exec` subcommand
    // option). Keep it before both `exec` and `exec resume` so every Flowix
    // Codex turn exposes the native Responses web_search tool by default.
    cmd.arg("--search");
    match session_id {
        Some(session_id) if !session_id.trim().is_empty() => {
            cmd.args(["exec", "resume"]);
            append_resume_permission_override(&mut cmd, permission_mode);
            append_model_override(&mut cmd, codex_model);
            append_reasoning_effort_override(&mut cmd, reasoning_effort);
            append_image_paths(&mut cmd, image_paths);
            cmd.args(["--json", "--skip-git-repo-check", session_id, "-"]);
        }
        _ => {
            cmd.arg("exec");
            append_permission_override(&mut cmd, permission_mode);
            append_model_override(&mut cmd, codex_model);
            append_reasoning_effort_override(&mut cmd, reasoning_effort);
            append_image_paths(&mut cmd, image_paths);
            cmd.args(["--json", "--skip-git-repo-check"]);
            cmd.arg("-C");
            cmd.arg(cwd);
            append_additional_workspace_dirs(&mut cmd, cwd, workspace_paths);
        }
    }
    cmd
}

fn append_image_paths(cmd: &mut Command, image_paths: &[String]) {
    for raw in image_paths {
        let path = PathBuf::from(raw.trim());
        if path.is_file() {
            cmd.arg("--image");
            cmd.arg(path);
        }
    }
}

pub(crate) fn preflight_codex() -> Result<(), String> {
    let codex = resolve_codex_binary();
    let codex_real = std::fs::canonicalize(&codex).unwrap_or(codex);
    let needs_node = codex_real.extension().and_then(|s| s.to_str()) == Some("js");
    if !needs_node {
        return Ok(());
    }
    if resolve_node_binary().is_none() {
        return Err(format!(
            "Codex CLI requires Node.js, but no Node.js installation was found. \
             Install Node.js from https://nodejs.org/, or set the CODEX_NODE_PATH \
             environment variable to your `node` binary. \
             (Codex binary resolved to: {})",
            resolve_codex_binary().display()
        ));
    }
    Ok(())
}

pub(crate) fn resolve_node_binary() -> Option<PathBuf> {
    crate::agent_external::node::resolve_node_binary("CODEX_NODE_PATH")
}

#[cfg(test)]
pub(crate) fn parse_node_version(dir_name: &str) -> Option<(u32, u32, u32)> {
    crate::agent_external::node::parse_node_version(dir_name)
}

#[cfg(test)]
pub(crate) fn latest_versioned_subdir(root: &std::path::Path) -> Option<PathBuf> {
    crate::agent_external::node::latest_versioned_subdir(root)
}

fn ensure_node_on_path(cmd: &mut Command) {
    crate::agent_external::node::ensure_node_on_path(cmd);
}

#[cfg(test)]
pub(crate) fn is_executable_file(path: &std::path::Path) -> bool {
    crate::agent_external::cli_resolver::is_executable_file(path)
}

fn append_permission_override(cmd: &mut Command, permission_mode: Option<&str>) {
    if matches!(permission_mode.map(str::trim), Some("yolo")) {
        cmd.arg("--yolo");
        return;
    }
    if let Some(mode) = normalized_permission_mode(permission_mode) {
        cmd.arg("--sandbox");
        cmd.arg(mode);
    }
}

/// `codex exec resume` does not accept `--sandbox`, and each resume starts a
/// fresh CLI process whose runtime policy is resolved for that invocation.
/// Keep the thread-card permission snapshot effective on every turn by using
/// the resume-specific flags/config overrides that the CLI accepts.
fn append_resume_permission_override(cmd: &mut Command, permission_mode: Option<&str>) {
    match normalized_permission_mode(permission_mode) {
        Some("yolo") => {
            cmd.arg("--yolo");
        }
        Some(mode) => {
            cmd.arg("-c");
            cmd.arg(format!("sandbox_mode=\"{mode}\""));
        }
        None => {}
    }
}

fn append_model_override(cmd: &mut Command, codex_model: Option<&str>) {
    if let Some(model) = normalized_codex_model(codex_model) {
        cmd.arg("-m");
        cmd.arg(model);
    }
}

fn append_reasoning_effort_override(cmd: &mut Command, reasoning_effort: Option<&str>) {
    if let Some(effort) = normalized_reasoning_effort(reasoning_effort) {
        cmd.arg("-c");
        cmd.arg(format!("model_reasoning_effort=\"{effort}\""));
    }
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

pub(crate) fn normalized_codex_model(model: Option<&str>) -> Option<String> {
    let model = model?.trim();
    if model.is_empty() || model == "inherit" {
        return None;
    }
    Some(model.to_string())
}

pub(crate) fn normalized_reasoning_effort(reasoning_effort: Option<&str>) -> Option<&'static str> {
    match reasoning_effort?.trim() {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        _ => None,
    }
}

pub(crate) fn normalized_permission_mode(mode: Option<&str>) -> Option<&'static str> {
    match mode.map(str::trim) {
        Some("read-only") => Some("read-only"),
        Some("workspace-write") => Some("workspace-write"),
        Some("danger-full-access") => Some("danger-full-access"),
        Some("yolo") => Some("yolo"),
        _ => None,
    }
}

#[cfg(test)]
pub(crate) fn which_codex() -> Result<PathBuf, ()> {
    crate::agent_external::cli_resolver::which_in_path("codex", std::env::var_os("PATH").as_deref())
        .ok_or(())
}
