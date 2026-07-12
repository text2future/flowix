use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::agent::{AgentChunk, AgentUserMessage};
use crate::external_runtime::{
    emit_chunk_with_run_id, kill_child_tree, persist_watchdog_finalized_run_state,
    read_capped_line, resolve_run_id, select_external_session_for_runtime,
    ExternalRunRegistry, MAX_STDOUT_LINE_BYTES,
};
use crate::runtime_log;
use crate::session::ThreadManager;
use super::history::{claude_session_cwd, is_claude_session_id};

const AGENT_TYPE: &str = "claude";

pub struct ClaudeCliManager {
    thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>,
    runs: ExternalRunRegistry,
}

impl ClaudeCliManager {
    pub fn new(thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>) -> Self {
        Self {
            thread_manager,
            runs: ExternalRunRegistry::new(AGENT_TYPE, AGENT_TYPE),
        }
    }

    pub async fn chat_stream(
        self: &Arc<Self>,
        thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, String> {
        let thread_id = thread_id.to_string();
        let app_handle = app_handle.clone();
        let manager = self.clone();
        let run_id = resolve_run_id(&thread_id, message.run_id.as_deref());

        // Reap any zombie child (kill/oom/broken pipe leaves the registry
        // entry behind until the watchdog sweeps it) and refuse overlapping
        // runs BEFORE we emit StreamStart — otherwise the UI flashes
        // loading for ~ms and then bounces to an error.
        if let Some(reason) = self.runs.reap_stale(&thread_id).await {
            return Err(reason);
        }

        tokio::spawn(async move {
            // 通用 metadata 协议 ── StreamStart 携带该 run 锁定的
            // model / reasoning_effort, 前端 hover card 等组件可读。
            let model = message.model_for_runtime("claude").map(str::to_string);
            let reasoning_effort = message
                .reasoning_effort_for_runtime("claude")
                .map(str::to_string);
            emit_chunk_with_run_id(
                &app_handle,
                &AgentChunk::StreamStart {
                    thread_id: thread_id.clone(),
                    model,
                    reasoning_effort,
                },
                AGENT_TYPE,
                &run_id,
            );

            let (reason, stream_end_emitted) = match manager
                .run_claude(&thread_id, &run_id, message, &app_handle)
                .await
            {
                Ok(stream_end_emitted) => (None, stream_end_emitted),
                Err(err) => {
                    emit_chunk_with_run_id(
                        &app_handle,
                        &AgentChunk::Error {
                            thread_id: thread_id.clone(),
                            message: err.clone(),
                        },
                        AGENT_TYPE,
                        &run_id,
                    );
                    (Some(err), false)
                }
            };

            if !stream_end_emitted {
                emit_chunk_with_run_id(
                    &app_handle,
                    &AgentChunk::StreamEnd { thread_id, reason },
                    AGENT_TYPE,
                    &run_id,
                );
            }
        });

        Ok(String::new())
    }

    pub async fn stop_chat(&self, thread_id: &str, run_id: Option<&str>) -> bool {
        let mut running = match run_id {
            Some(rid) => self.runs.remove_if_run_id(thread_id, Some(rid)).await,
            None => self.runs.remove(thread_id).await,
        };
        if running.is_none() {
            let mapped_thread_id = {
                let manager = self.thread_manager.read().await;
                manager
                    .find_thread_by_external_session(thread_id, AGENT_TYPE)
                    .await
                    .ok()
                    .flatten()
            };
            if let Some(mapped_thread_id) = mapped_thread_id {
                if mapped_thread_id != thread_id {
                    running = match run_id {
                        Some(rid) => {
                            self.runs
                                .remove_if_run_id(&mapped_thread_id, Some(rid))
                                .await
                        }
                        None => self.runs.remove(&mapped_thread_id).await,
                    };
                }
            }
        }
        let Some(mut running) = running else {
            return false;
        };
        kill_child_tree(&mut running.child, "ClaudeCli", thread_id).await;
        true
    }

    pub async fn running_threads(&self) -> HashMap<String, crate::agent::RunInfo> {
        self.runs.running_threads().await
    }

    pub async fn stop_all(&self) -> usize {
        self.runs.kill_all("ClaudeCli").await
    }

    pub async fn reap_inactive_runs(
        &self,
        app_handle: &tauri::AppHandle,
        idle_timeout_ms: i64,
    ) -> usize {
        let finalized = self.runs.reap_inactive(idle_timeout_ms, "ClaudeCli").await;
        for run in &finalized {
            let run_id = run.run_id.as_deref().unwrap_or(run.thread_id.as_str());
            if let Some(reason) = run.reason.clone() {
                emit_chunk_with_run_id(
                    app_handle,
                    &AgentChunk::Error {
                        thread_id: run.thread_id.clone(),
                        message: reason.clone(),
                    },
                    AGENT_TYPE,
                    run_id,
                );
            }
            emit_chunk_with_run_id(
                app_handle,
                &AgentChunk::StreamEnd {
                    thread_id: run.thread_id.clone(),
                    reason: run.reason.clone(),
                },
                AGENT_TYPE,
                run_id,
            );
            persist_watchdog_finalized_run_state(&self.thread_manager, run, "ClaudeCli").await;
        }
        finalized.len()
    }

    async fn run_claude(
        &self,
        thread_id: &str,
        run_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<bool, String> {
        let mapped_session_id = {
            let manager = self.thread_manager.read().await;
            manager
                .get_external_session(thread_id, AGENT_TYPE)
                .await
                .map_err(|e| e.to_string())?
        };
        let hint = is_claude_session_id(thread_id).then(|| thread_id.to_string());
        let session_id = select_external_session_for_runtime(mapped_session_id, hint);

        let cwd = resolve_claude_cwd(&message, session_id.as_deref());
        let workspace_paths = message.workspace_paths_for_runtime(AGENT_TYPE);

        let permission_mode = message
            .permission_mode_for_runtime(AGENT_TYPE)
            .map(str::to_string);
        let model = message.model_for_runtime(AGENT_TYPE).map(str::to_string);
        let prompt = message.llm_content.unwrap_or(message.content);

        runtime_log::record_agent_event(
            "info",
            "claude_process",
            "claude.spawn_start",
            "Starting Claude Code CLI",
            Some(thread_id),
            Some(AGENT_TYPE),
            Some(serde_json::json!({
                "run_id": run_id,
                "session_mode": if session_id.is_some() { "resume" } else { "new" },
                "session_id": session_id,
                "cwd": cwd.display().to_string(),
                "workspace_paths": workspace_paths,
                "permission_mode": permission_mode,
                "model": model,
                "prompt_chars": prompt.chars().count(),
            })),
        );

        preflight_claude()?;

        let mut child = build_claude_command(
            session_id.as_deref(),
            &cwd,
            &workspace_paths,
            permission_mode.as_deref(),
            model.as_deref(),
        )
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start Claude Code CLI: {e}"))?;
        let child_pid = child.id();
        runtime_log::record_agent_event(
            "info",
            "claude_process",
            "claude.spawn_ok",
            "Claude Code CLI process started",
            Some(thread_id),
            Some(AGENT_TYPE),
            Some(serde_json::json!({
                "run_id": run_id,
                "child_pid": child_pid,
            })),
        );

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .await
                .map_err(|e| format!("failed to write Claude Code prompt: {e}"))?;
            stdin
                .shutdown()
                .await
                .map_err(|e| format!("failed to close Claude Code stdin: {e}"))?;
        }

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture Claude Code stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "failed to capture Claude Code stderr".to_string())?;

        if let Err(mut duplicate_child) = self
            .runs
            .try_insert(thread_id.to_string(), child, Some(run_id.to_string()))
            .await
        {
            let _ = duplicate_child.kill().await;
            return Err("Claude Code CLI is already running for this thread".to_string());
        }

        let stdout_task = read_claude_stdout(
            thread_id.to_string(),
            run_id.to_string(),
            app_handle.clone(),
            self.thread_manager.clone(),
            self.runs.clone(),
            BufReader::new(stdout),
        );
        let stderr_task = read_stderr_to_string(
            thread_id.to_string(),
            run_id.to_string(),
            self.runs.clone(),
            BufReader::new(stderr),
        );
        let (stdout_result, stderr_text) = tokio::join!(stdout_task, stderr_task);

        let mut child = { self.runs.remove(thread_id).await };
        let status = if let Some(running) = child.as_mut() {
            running.child.wait().await.map_err(|e| e.to_string())?
        } else {
            if self
                .runs
                .take_watchdog_finalized(thread_id, Some(run_id))
                .await
            {
                return Ok(true);
            }
            runtime_log::record_agent_event(
                "warn",
                "claude_process",
                "claude.child_missing_after_run",
                "Claude child was removed before wait; likely stopped by user",
                Some(thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({
                    "run_id": run_id,
                    "child_pid": child_pid,
                })),
            );
            return Ok(false);
        };

        stdout_result?;
        let stderr_text = stderr_text.unwrap_or_default();
        runtime_log::record_agent_event(
            if status.success() { "info" } else { "error" },
            "claude_process",
            "claude.exit",
            "Claude Code CLI process exited",
            Some(thread_id),
            Some(AGENT_TYPE),
            Some(serde_json::json!({
                "run_id": run_id,
                "child_pid": child_pid,
                "success": status.success(),
                "code": status.code(),
                "stderr_chars": stderr_text.chars().count(),
                "stderr_preview": truncate_for_log(stderr_text.trim()),
            })),
        );
        if !status.success() {
            let detail = stderr_text.trim();
            return Err(if detail.is_empty() {
                format!("Claude Code CLI exited with status {status}")
            } else {
                format!("Claude Code CLI exited with status {status}: {detail}")
            });
        }
        if !stderr_text.trim().is_empty() {
            tracing::info!("[ClaudeCli] stderr: {}", stderr_text.trim());
        }
        Ok(false)
    }
}

fn truncate_for_log(text: &str) -> String {
    const MAX_LOG_TEXT_CHARS: usize = 2048;
    let mut chars = text.chars();
    let truncated: String = chars.by_ref().take(MAX_LOG_TEXT_CHARS).collect();
    if chars.next().is_some() {
        format!("{truncated}\n...[truncated]")
    } else {
        truncated
    }
}

/// Cwd 兜底链 ── 顺序:
/// 1. `message.cwd_for_runtime` (前端 IPC 入参, 即 `chat-stream.ts` 组装的 runtime_config)
/// 2. **该 session jsonl 里的原始 cwd** (`~/.claude/projects/<...>/<sid>.jsonl`
///    自身的 cwd 字段 ── 这是最可靠的真源, 不依赖前端 store 状态)
/// 3. Tauri 进程 cwd
/// 4. "." 兜底
///
/// 关键修复: 见 `claude_history::claude_session_cwd` 注释。 修 "重启产品
/// 后, 已存在的 thread card resume 时 cwd 缺失" (Claude Code CLI exit 1:
/// Please provide a directory path)。
pub(crate) fn resolve_claude_cwd(
    message: &crate::agent::AgentUserMessage,
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
fn build_claude_command(
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
    // Keep the full user prompt on stdin to avoid command-line length limits.
    // Passing an empty print-mode query preserves Claude Code's piped-input path.
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
    if let Ok(path) = std::env::var("CLAUDE_NODE_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }

    if let Some(found) = which_in_path("node", std::env::var_os("PATH").as_deref()) {
        return Some(found);
    }

    for candidate in node_candidate_paths() {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn node_candidate_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    paths.push(PathBuf::from("/opt/homebrew/bin/node"));
    paths.push(PathBuf::from("/usr/local/bin/node"));
    paths.push(PathBuf::from("/usr/bin/node"));

    let Some(home) = dirs::home_dir() else {
        return paths;
    };

    paths.push(home.join(".npm-global/bin/node"));
    paths.push(home.join(".npm/bin/node"));

    if let Some(latest) = latest_versioned_subdir(&home.join(".nvm/versions/node")) {
        paths.push(latest.join("bin/node"));
    }
    if let Some(latest) = latest_versioned_subdir(&home.join(".local/share/fnm/node-versions")) {
        paths.push(latest.join("installation/bin/node"));
    }

    paths.push(home.join(".volta/tools/image/node/current/bin/node"));

    if let Some(latest) = latest_versioned_subdir(&home.join(".asdf/installs/nodejs")) {
        paths.push(latest.join("bin/node"));
    }
    if let Some(latest) = latest_versioned_subdir(&home.join(".asdf/installs/node")) {
        paths.push(latest.join("bin/node"));
    }

    paths.push(home.join("n/bin/node"));

    paths
}

fn latest_versioned_subdir(root: &std::path::Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    if dirs.is_empty() {
        return None;
    }
    dirs.sort();
    Some(dirs.swap_remove(dirs.len() - 1))
}

fn ensure_claude_node_on_path(cmd: &mut Command) {
    if which_in_path("node", std::env::var_os("PATH").as_deref()).is_some() {
        return;
    }

    let mut seen = std::collections::HashSet::new();
    let mut extra_dirs = Vec::new();
    for node in node_candidate_paths() {
        if let Some(parent) = node.parent() {
            if seen.insert(parent.to_path_buf()) {
                extra_dirs.push(parent.to_path_buf());
            }
        }
    }

    let merged: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .chain(extra_dirs)
        .collect();
    cmd.env("PATH", std::env::join_paths(merged).unwrap_or_default());
}

fn which_in_path(name: &str, path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let path = path?;
    for dir in std::env::split_paths(path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn normalized_claude_model(model: Option<&str>) -> Option<&str> {
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

fn normalized_claude_permission_mode(mode: Option<&str>) -> Option<&'static str> {
    match mode.map(str::trim) {
        Some("read-only") => Some("plan"),
        Some("workspace-write") => Some("acceptEdits"),
        Some("danger-full-access") => Some("bypassPermissions"),
        _ => None,
    }
}

pub(crate) fn resolve_claude_binary() -> PathBuf {
    if let Ok(path) = std::env::var("CLAUDE_CODE_CLI_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return path;
        }
    }

    #[cfg(windows)]
    {
        if let Some(home) = dirs::home_dir() {
            let npm_cmd = home
                .join("AppData")
                .join("Roaming")
                .join("npm")
                .join("claude.cmd");
            if npm_cmd.exists() {
                return npm_cmd;
            }
        }
        PathBuf::from("claude.cmd")
    }

    #[cfg(not(windows))]
    {
        if let Ok(found) = which_claude() {
            return found;
        }
        if let Some(home) = dirs::home_dir() {
            let candidates = [
                home.join(".npm-global/bin/claude"),
                home.join(".npm/bin/claude"),
                home.join(".local/bin/claude"),
                home.join(".bun/bin/claude"),
                home.join(".volta/bin/claude"),
                PathBuf::from("/opt/homebrew/bin/claude"),
                PathBuf::from("/usr/local/bin/claude"),
            ];
            for candidate in candidates {
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
        PathBuf::from("claude")
    }
}

#[cfg(not(windows))]
fn which_claude() -> Result<PathBuf, ()> {
    let path = std::env::var_os("PATH").ok_or(())?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join("claude");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(())
}

async fn read_claude_stdout<R>(
    thread_id: String,
    run_id: String,
    app_handle: tauri::AppHandle,
    thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>,
    runs: ExternalRunRegistry,
    reader: BufReader<R>,
) -> Result<(), String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut reader = reader;
    let mut seen_sessions = HashSet::new();
    while let Some((raw, truncated_by_reader)) =
        read_capped_line(&mut reader, MAX_STDOUT_LINE_BYTES).await?
    {
        if truncated_by_reader {
            runtime_log::record_agent_event(
                "warn",
                "claude_stdout",
                "claude.stdout_line_truncated",
                "Claude stdout line exceeded reader limit and was truncated",
                Some(&thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({
                    "run_id": run_id,
                    "line_bytes_limit": MAX_STDOUT_LINE_BYTES,
                    "line_preview": truncate_for_log(raw.trim()),
                })),
            );
        }
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        runs.touch(&thread_id, Some(&run_id)).await;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let parsed = parse_claude_stdout_line(&thread_id, line);
        let value = match parsed.value {
            Some(value) => value,
            None => {
                let line_chars = line.chars().count();
                runtime_log::record_agent_event(
                    "warn",
                    "claude_stdout",
                    "claude.stdout_non_json",
                    "Claude stdout emitted a non-JSON line",
                    Some(&thread_id),
                    Some(AGENT_TYPE),
                    Some(serde_json::json!({
                        "run_id": run_id,
                        "line_chars": line_chars,
                        "line_preview": truncate_for_log(line),
                    })),
                );
                emit_chunk_with_run_id(
                    &app_handle,
                    &AgentChunk::Text {
                        thread_id: thread_id.clone(),
                        text: format!("{line}\n"),
                    },
                    AGENT_TYPE,
                    &run_id,
                );
                continue;
            }
        };

        if let Some(session_id) = parsed.session_id {
            if seen_sessions.insert(session_id.clone()) {
                runtime_log::record_agent_event(
                    "info",
                    "claude_stdout",
                    "claude.session_resolved",
                    "Claude Code reported a session id",
                    Some(&thread_id),
                    Some(AGENT_TYPE),
                    Some(serde_json::json!({
                        "run_id": run_id,
                        "session_id": session_id,
                    })),
                );
                let manager = thread_manager.read().await;
                if let Err(err) = manager
                    .upsert_external_session(
                        &thread_id,
                        AGENT_TYPE,
                        &session_id,
                        Some(value.clone()),
                    )
                    .await
                {
                    runtime_log::record_agent_event(
                        "warn",
                        "claude_stdout",
                        "claude.session_persist_failed",
                        "Failed to persist Claude external session mapping",
                        Some(&thread_id),
                        Some(AGENT_TYPE),
                        Some(serde_json::json!({
                            "run_id": run_id,
                            "session_id": session_id,
                            "error": err.to_string(),
                        })),
                    );
                    tracing::warn!(
                        "[ClaudeCli] failed to persist external session mapping for {thread_id}: {err}"
                    );
                }
                emit_chunk_with_run_id(
                    &app_handle,
                    &AgentChunk::SessionResolved {
                        thread_id: thread_id.clone(),
                        session_id: session_id.clone(),
                    },
                    AGENT_TYPE,
                    &run_id,
                );
                runs.set_session_id(&thread_id, Some(&run_id), session_id.clone())
                    .await;
            }
        }

        for chunk in parsed.chunks {
            emit_chunk_with_run_id(&app_handle, &chunk, AGENT_TYPE, &run_id);
        }
    }
    runtime_log::record_agent_event(
        "info",
        "claude_stdout",
        "claude.stdout_eof",
        "Claude stdout reached EOF",
        Some(&thread_id),
        Some(AGENT_TYPE),
        None,
    );
    Ok(())
}

struct ParsedClaudeStdoutLine {
    value: Option<Value>,
    session_id: Option<String>,
    chunks: Vec<AgentChunk>,
}

fn parse_claude_stdout_line(thread_id: &str, line: &str) -> ParsedClaudeStdoutLine {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return ParsedClaudeStdoutLine {
            value: None,
            session_id: None,
            chunks: vec![AgentChunk::Text {
                thread_id: thread_id.to_string(),
                text: format!("{line}\n"),
            }],
        };
    };

    let session_id = extract_session_id(&value);
    let chunks = claude_event_to_chunks(thread_id, &value);

    ParsedClaudeStdoutLine {
        value: Some(value),
        session_id,
        chunks,
    }
}

async fn read_stderr_to_string<R>(
    thread_id: String,
    run_id: String,
    runs: ExternalRunRegistry,
    reader: BufReader<R>,
) -> Result<String, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = reader.lines();
    let mut out = String::new();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        runs.touch(&thread_id, Some(&run_id)).await;
        out.push_str(&line);
        out.push('\n');
    }
    Ok(out)
}

fn claude_event_to_chunks(thread_id: &str, value: &Value) -> Vec<AgentChunk> {
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();

    if event_type == "assistant" {
        let mut chunks = Vec::new();
        if let Some(content) = value
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        {
            for block in content {
                match block
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                {
                    "text" => {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            if !text.trim().is_empty() {
                                chunks.push(AgentChunk::Text {
                                    thread_id: thread_id.to_string(),
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                    "thinking" => {
                        if let Some(text) = block
                            .get("thinking")
                            .or_else(|| block.get("text"))
                            .and_then(Value::as_str)
                        {
                            if !text.trim().is_empty() {
                                chunks.push(AgentChunk::Reasoning {
                                    thread_id: thread_id.to_string(),
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                    "tool_use" => {
                        let id = block
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("claude_tool")
                            .to_string();
                        let name = block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string();
                        chunks.push(AgentChunk::ToolCall {
                            thread_id: thread_id.to_string(),
                            id,
                            name,
                            input: block.get("input").cloned().unwrap_or(Value::Null),
                        });
                    }
                    _ => {}
                }
            }
        }
        return chunks;
    }

    if event_type == "user" {
        let mut chunks = Vec::new();
        if let Some(content) = value
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        {
            for block in content {
                if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                let id = block
                    .get("tool_use_id")
                    .or_else(|| block.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("claude_tool")
                    .to_string();
                chunks.push(AgentChunk::ToolResult {
                    thread_id: thread_id.to_string(),
                    id,
                    name: String::new(),
                    result: claude_tool_result_value(block),
                });
            }
        }
        return chunks;
    }

    if event_type == "result" {
        return Vec::new();
    }

    if event_type == "system" {
        if value.get("subtype").and_then(Value::as_str) == Some("error") {
            if let Some(text) = first_string(value, &["message", "error"]) {
                return vec![AgentChunk::Error {
                    thread_id: thread_id.to_string(),
                    message: text,
                }];
            }
        }
        return Vec::new();
    }

    if let Some(text) = first_string(value, &["delta", "text", "content"]) {
        if !text.trim().is_empty() {
            return vec![AgentChunk::Text {
                thread_id: thread_id.to_string(),
                text,
            }];
        }
    }

    Vec::new()
}

fn claude_tool_result_value(block: &Value) -> Value {
    let Some(content) = block.get("content") else {
        return claude_tool_result_envelope(block.clone(), block);
    };
    let content = match content {
        Value::String(text) => serde_json::json!({ "content": text }),
        Value::Array(parts) => {
            let text = parts
                .iter()
                .filter_map(|part| {
                    part.get("text")
                        .or_else(|| part.get("content"))
                        .and_then(Value::as_str)
                })
                .collect::<Vec<_>>()
                .join("");
            if text.trim().is_empty() {
                serde_json::json!({ "content": content })
            } else {
                serde_json::json!({ "content": text })
            }
        }
        _ => serde_json::json!({ "content": content }),
    };
    claude_tool_result_envelope(content, block)
}

fn claude_tool_result_envelope(mut value: Value, source: &Value) -> Value {
    if let Some(is_error) = source.get("is_error").and_then(Value::as_bool) {
        match &mut value {
            Value::Object(map) => {
                map.insert("is_error".to_string(), Value::Bool(is_error));
            }
            _ => {
                value = serde_json::json!({
                    "content": value,
                    "is_error": is_error,
                });
            }
        }
    }
    value
}

fn extract_session_id(value: &Value) -> Option<String> {
    for key in ["session_id", "sessionId", "uuid"] {
        if let Some(id) = value.get(key).and_then(Value::as_str) {
            return Some(id.to_string());
        }
    }
    value.get("message").and_then(extract_session_id)
}

fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str) {
            return Some(text.to_string());
        }
    }

    match value {
        Value::Object(map) => map.values().find_map(|v| first_string(v, keys)),
        Value::Array(items) => items.iter().find_map(|v| first_string(v, keys)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_claude_assistant_text_to_chunk() {
        let value = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [{ "type": "text", "text": "hello" }]
            }
        });
        let chunks = claude_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::Text { text, .. }] if text == "hello"
        ));
    }

    #[test]
    fn maps_permission_modes() {
        assert_eq!(
            normalized_claude_permission_mode(Some("read-only")),
            Some("plan")
        );
        assert_eq!(
            normalized_claude_permission_mode(Some("workspace-write")),
            Some("acceptEdits")
        );
        assert_eq!(
            normalized_claude_permission_mode(Some("danger-full-access")),
            Some("bypassPermissions")
        );
        assert_eq!(normalized_claude_permission_mode(Some("inherit")), None);
    }

    #[test]
    fn normalizes_claude_model_override() {
        assert_eq!(
            normalized_claude_model(Some("claude-sonnet-4-20250514")),
            Some("claude-sonnet-4-20250514")
        );
        assert_eq!(normalized_claude_model(Some(" inherit ")), None);
        assert_eq!(normalized_claude_model(Some("")), None);
        assert_eq!(normalized_claude_model(None), None);
    }

    #[test]
    fn claude_command_adds_model_and_workspace_dirs() {
        let root = std::env::temp_dir().join(format!(
            "flowix-claude-workspace-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
        ));
        let cwd = root.join("primary");
        let secondary = root.join("secondary");
        let third = root.join("third");
        std::fs::create_dir_all(&cwd).expect("create primary dir");
        std::fs::create_dir_all(&secondary).expect("create secondary dir");
        std::fs::create_dir_all(&third).expect("create third dir");

        let workspace_paths = vec![
            cwd.to_string_lossy().to_string(),
            secondary.to_string_lossy().to_string(),
            secondary.to_string_lossy().to_string(),
            root.join("missing").to_string_lossy().to_string(),
            third.to_string_lossy().to_string(),
        ];
        let cmd = build_claude_command(
            None,
            &cwd,
            &workspace_paths,
            Some("workspace-write"),
            Some("claude-sonnet-4-20250514"),
        );
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();

        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--permission-mode" && pair[1] == "acceptEdits"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--model" && pair[1] == "claude-sonnet-4-20250514"));
        assert_eq!(
            args.windows(2)
                .filter(|pair| pair[0] == "--add-dir")
                .map(|pair| pair[1].clone())
                .collect::<Vec<_>>(),
            vec![
                secondary.to_string_lossy().to_string(),
                third.to_string_lossy().to_string()
            ]
        );

        cleanup(&root);
    }

    #[test]
    fn parse_claude_stdout_line_extracts_session_and_text() {
        let parsed = parse_claude_stdout_line(
            "thread_1",
            r#"{"type":"assistant","session_id":"019f0000-0000-7000-8000-000000000000","message":{"content":[{"type":"text","text":"hello"}]}}"#,
        );

        assert_eq!(
            parsed.session_id.as_deref(),
            Some("019f0000-0000-7000-8000-000000000000")
        );
        assert!(matches!(
            parsed.chunks.as_slice(),
            [AgentChunk::Text { thread_id, text }] if thread_id == "thread_1" && text == "hello"
        ));
    }

    #[test]
    fn parse_claude_stdout_line_keeps_non_json_as_text() {
        let parsed = parse_claude_stdout_line("thread_1", "plain progress");

        assert!(parsed.value.is_none());
        assert!(parsed.session_id.is_none());
        assert!(matches!(
            parsed.chunks.as_slice(),
            [AgentChunk::Text { text, .. }] if text == "plain progress\n"
        ));
    }

    #[test]
    fn parse_claude_stdout_line_maps_system_error() {
        let parsed = parse_claude_stdout_line(
            "thread_1",
            r#"{"type":"system","subtype":"error","message":"bad auth"}"#,
        );

        assert!(matches!(
            parsed.chunks.as_slice(),
            [AgentChunk::Error { message, .. }] if message == "bad auth"
        ));
    }

    #[test]
    fn maps_claude_tool_blocks_to_chunks() {
        let assistant = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "Read",
                    "input": { "file_path": "README.md" }
                }]
            }
        });
        let chunks = claude_event_to_chunks("thread_1", &assistant);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolCall { id, name, input, .. }]
                if id == "toolu_1" && name == "Read" && input["file_path"] == "README.md"
        ));

        let user = serde_json::json!({
            "type": "user",
            "message": {
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "content": "file contents"
                }]
            }
        });
        let chunks = claude_event_to_chunks("thread_1", &user);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolResult { id, name, result, .. }]
                if id == "toolu_1" && name.is_empty() && result["content"] == "file contents"
        ));
    }

    #[test]
    fn ignores_claude_user_text_blocks_while_streaming() {
        let value = serde_json::json!({
            "type": "user",
            "message": {
                "content": [
                    {
                        "type": "text",
                        "text": "Base directory for this skill: /tmp/verify\n\nskill body"
                    },
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": "loaded"
                    }
                ]
            }
        });

        let chunks = claude_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolResult { id, result, .. }]
                if id == "toolu_1" && result["content"] == "loaded"
        ));
    }

    fn make_fake_executable(dir_suffix: &str, name: &str, body: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "flowix-claude-cli-test-{}-{}-{}",
            std::process::id(),
            dir_suffix,
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let executable = dir.join(name);
        std::fs::write(&executable, body).expect("write fake executable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&executable)
                .expect("stat fake executable")
                .permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&executable, perms).expect("chmod fake executable");
        }
        (dir, executable)
    }

    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn resolve_claude_node_binary_prefers_claude_node_path_env() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (dir, fake_node) = make_fake_executable("node-env", "node", "#!/bin/sh\nexit 0\n");

        let original = std::env::var_os("CLAUDE_NODE_PATH");
        std::env::set_var("CLAUDE_NODE_PATH", &fake_node);
        let resolved = resolve_claude_node_binary();
        match original {
            Some(value) => std::env::set_var("CLAUDE_NODE_PATH", value),
            None => std::env::remove_var("CLAUDE_NODE_PATH"),
        }
        cleanup(&dir);

        assert_eq!(resolved, Some(fake_node));
    }

    #[test]
    fn resolve_claude_node_binary_finds_node_in_path() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (dir, fake_node) = make_fake_executable("node-path", "node", "#!/bin/sh\nexit 0\n");

        let original_path = std::env::var_os("PATH");
        let original_node_env = std::env::var_os("CLAUDE_NODE_PATH");
        std::env::remove_var("CLAUDE_NODE_PATH");
        let sep = if cfg!(windows) { ';' } else { ':' };
        let joined = match &original_path {
            Some(path) => format!("{}{}{}", dir.display(), sep, path.to_string_lossy()),
            None => dir.display().to_string(),
        };
        std::env::set_var("PATH", joined);
        let resolved = resolve_claude_node_binary();
        match original_path {
            Some(value) => std::env::set_var("PATH", value),
            None => std::env::remove_var("PATH"),
        }
        match original_node_env {
            Some(value) => std::env::set_var("CLAUDE_NODE_PATH", value),
            None => std::env::remove_var("CLAUDE_NODE_PATH"),
        }
        cleanup(&dir);

        assert_eq!(resolved, Some(fake_node));
    }

    #[test]
    fn claude_command_launches_js_cli_through_node() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (claude_dir, fake_claude_js) =
            make_fake_executable("js-cli", "claude.js", "#!/usr/bin/env node\n");
        let (node_dir, fake_node) = make_fake_executable("js-node", "node", "#!/bin/sh\nexit 0\n");

        let original_cli = std::env::var_os("CLAUDE_CODE_CLI_PATH");
        let original_node = std::env::var_os("CLAUDE_NODE_PATH");
        std::env::set_var("CLAUDE_CODE_CLI_PATH", &fake_claude_js);
        std::env::set_var("CLAUDE_NODE_PATH", &fake_node);

        let cwd = std::env::temp_dir();
        let cmd = build_claude_command(None, &cwd, &[], None, None);
        let program = cmd.as_std().get_program().to_string_lossy().to_string();
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        let expected_cli = std::fs::canonicalize(&fake_claude_js)
            .unwrap_or_else(|_| fake_claude_js.clone())
            .to_string_lossy()
            .to_string();

        match original_cli {
            Some(value) => std::env::set_var("CLAUDE_CODE_CLI_PATH", value),
            None => std::env::remove_var("CLAUDE_CODE_CLI_PATH"),
        }
        match original_node {
            Some(value) => std::env::set_var("CLAUDE_NODE_PATH", value),
            None => std::env::remove_var("CLAUDE_NODE_PATH"),
        }
        cleanup(&claude_dir);
        cleanup(&node_dir);

        assert_eq!(program, fake_node.to_string_lossy());
        assert_eq!(
            args.first().map(String::as_str),
            Some(expected_cli.as_str())
        );
    }

    #[test]
    fn preflight_claude_returns_friendly_error_when_no_node() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (dir, fake_claude_js) =
            make_fake_executable("preflight-js", "claude.js", "#!/usr/bin/env node\n");

        let original_path = std::env::var_os("PATH");
        let original_node_env = std::env::var_os("CLAUDE_NODE_PATH");
        let original_cli_env = std::env::var_os("CLAUDE_CODE_CLI_PATH");
        std::env::remove_var("CLAUDE_NODE_PATH");
        std::env::set_var("PATH", "");
        std::env::set_var("CLAUDE_CODE_CLI_PATH", &fake_claude_js);

        let result = preflight_claude();

        match original_path {
            Some(value) => std::env::set_var("PATH", value),
            None => std::env::remove_var("PATH"),
        }
        match original_node_env {
            Some(value) => std::env::set_var("CLAUDE_NODE_PATH", value),
            None => std::env::remove_var("CLAUDE_NODE_PATH"),
        }
        match original_cli_env {
            Some(value) => std::env::set_var("CLAUDE_CODE_CLI_PATH", value),
            None => std::env::remove_var("CLAUDE_CODE_CLI_PATH"),
        }
        cleanup(&dir);

        if let Err(message) = result {
            assert!(message.contains("Node.js"));
            assert!(message.contains("CLAUDE_NODE_PATH") || message.contains("nodejs.org"));
        }
    }

    #[tokio::test]
    async fn real_claude_binary_smoke_test_opt_in() {
        if std::env::var("FLOWIX_RUN_REAL_CLAUDE_TESTS")
            .ok()
            .as_deref()
            != Some("1")
        {
            return;
        }

        preflight_claude().expect("claude preflight should pass");
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            Command::new(resolve_claude_binary())
                .arg("--version")
                .output(),
        )
        .await
        .expect("claude --version timed out")
        .expect("failed to run claude --version");

        assert!(
            output.status.success(),
            "claude --version failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }
}
