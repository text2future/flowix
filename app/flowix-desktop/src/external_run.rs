use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::agent::{AgentChunk, RunInfo};
use crate::runtime_log;
use crate::watcher::dispatcher;

/// One live external-agent child process per `thread_id`.
///
/// Codex / Claude Code / `simple_cli` all fall under this shape: a long-lived
/// process whose stdout is line-streamed as JSON events. Consolidating the
/// state here makes run-id / kill / stdout-cap semantics single-sourced.
pub struct ExternalRunRegistry {
    agent_type: &'static str,
    current_tool: &'static str,
    children: Mutex<HashMap<String, ExternalRunningChild>>,
}

pub struct ExternalRunningChild {
    pub child: Child,
    pub started_at: i64,
    pub run_id: Option<String>,
}

impl ExternalRunRegistry {
    pub fn new(agent_type: &'static str, current_tool: &'static str) -> Self {
        Self {
            agent_type,
            current_tool,
            children: Mutex::new(HashMap::new()),
        }
    }

    pub async fn insert(&self, thread_id: String, child: Child, run_id: Option<String>) {
        let mut children = self.children.lock().await;
        children.insert(
            thread_id,
            ExternalRunningChild {
                child,
                started_at: chrono::Utc::now().timestamp_millis(),
                run_id,
            },
        );
    }

    pub async fn remove(&self, thread_id: &str) -> Option<ExternalRunningChild> {
        let mut children = self.children.lock().await;
        children.remove(thread_id)
    }

    /// Cheap "is there a live child for this thread?" probe. Used by
    /// managers to refuse a concurrent start on the same thread before
    /// even bothering to spawn a process.
    pub async fn contains(&self, thread_id: &str) -> bool {
        let children = self.children.lock().await;
        children.contains_key(thread_id)
    }

    pub async fn remove_if_run_id(
        &self,
        thread_id: &str,
        expected_run_id: Option<&str>,
    ) -> Option<ExternalRunningChild> {
        let mut children = self.children.lock().await;
        let Some(running) = children.get(thread_id) else {
            return None;
        };
        if running.run_id.as_deref() != expected_run_id {
            return None;
        }
        children.remove(thread_id)
    }

    pub async fn running_threads(&self) -> HashMap<String, RunInfo> {
        let children = self.children.lock().await;
        children
            .iter()
            .map(|(thread_id, running)| {
                (
                    thread_id.clone(),
                    RunInfo {
                        started_at: running.started_at,
                        current_tool: Some(self.current_tool.to_string()),
                        agent_type: Some(self.agent_type.to_string()),
                        run_id: running.run_id.clone(),
                    },
                )
            })
            .collect()
    }
}

/// Build a run id when the caller did not provide one. Format keeps it
/// grep-friendly in `runtime_log::agent.log`: `{thread_id}-{unix_millis}`.
pub fn create_run_id(thread_id: &str) -> String {
    format!("{}-{}", thread_id, chrono::Utc::now().timestamp_millis())
}

/// Resolve the run id for a chat invocation. Frontend may attach an id (used
/// by the thread-card UI to disambiguate overlapping runs on the same
/// thread); otherwise we mint one. Trimmed-empty values fall through to the
/// generated branch so callers never see a blank `run_id`.
pub fn resolve_run_id(thread_id: &str, provided_run_id: Option<&str>) -> String {
    provided_run_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| create_run_id(thread_id))
}

/// Emit an `AgentChunk` on `agent-chunk` with the run id injected at the
/// payload's top level. Frontend `chat-store` keys live state by
/// `(thread_id, run_id)` so emit paths that bypass this helper (e.g. emit
/// before the run id has been resolved) silently break the discriminator.
///
/// Logs `codex_emit` / `claude_emit`-shaped records on serialize / dispatch
/// failure so missing-the-front-door bugs don't disappear silently.
pub fn emit_chunk_with_run_id(
    app_handle: &tauri::AppHandle,
    chunk: &AgentChunk,
    agent_type: &'static str,
    run_id: &str,
) {
    let mut payload = match serde_json::to_value(chunk) {
        Ok(value) => value,
        Err(err) => {
            runtime_log::record_agent_event(
                "warn",
                "agent_emit",
                "agent.emit_serialize_failed",
                "Failed to serialize agent chunk",
                Some(chunk.thread_id()),
                Some(agent_type),
                Some(serde_json::json!({
                    "chunk_kind": chunk.kind(),
                    "run_id": run_id,
                    "error": err.to_string(),
                })),
            );
            return;
        }
    };
    if let Some(object) = payload.as_object_mut() {
        object.insert("run_id".to_string(), Value::String(run_id.to_string()));
        object.insert(
            "agent_type".to_string(),
            Value::String(agent_type.to_string()),
        );
    }
    if !dispatcher::emit_to(app_handle, "agent-chunk", payload) {
        runtime_log::record_agent_event(
            "warn",
            "agent_emit",
            "agent.emit_failed",
            "Failed to emit agent chunk",
            Some(chunk.thread_id()),
            Some(agent_type),
            Some(serde_json::json!({
                "chunk_kind": chunk.kind(),
                "run_id": run_id,
            })),
        );
        tracing::warn!(
            chunk_kind = chunk.kind(),
            thread_id = chunk.thread_id(),
            run_id = run_id,
            agent_type = agent_type,
            "emit agent-chunk failed"
        );
    }
}

/// Tracks per-thread `runtime_key` for external CLIs so future runs can
/// detect cwd/workspace drift and refuse to silently leak the old context
/// into a new cwd.
///
/// `runtime_key` is a hashable fingerprint of where the CLI is going to do
/// its work — its `cwd` plus any extra workspace dirs the runtime was
/// configured with. Callers pair the manager with the pure
/// `select_external_session_for_runtime` decision, reading the previous key
/// and recording the new one around each invocation.
pub struct ExternalSessionManager {
    runtime_keys: Mutex<HashMap<String, String>>,
}

impl ExternalSessionManager {
    pub fn new() -> Self {
        Self {
            runtime_keys: Mutex::new(HashMap::new()),
        }
    }

    pub async fn previous_runtime_key(&self, thread_id: &str) -> Option<String> {
        self.runtime_keys.lock().await.get(thread_id).cloned()
    }

    pub async fn record_runtime_key(&self, thread_id: &str, runtime_key: String) {
        self.runtime_keys
            .lock()
            .await
            .insert(thread_id.to_string(), runtime_key);
    }
}

/// Pure decision: should this external-CLI invocation resume a previously
/// mapped session id, or start fresh?
///
///   * `external_session_id_hint` — when the frontend thread id is itself a
///     provider-format session id (long UUID string), that wins unconditionally.
///   * `runtime_key` — the cwd/workspace fingerprint for this run. If absent,
///     the runtime wasn't given an explicit cwd, so we trust the mapping.
///   * `previous_runtime_key` — what we recorded on the prior run for this
///     thread; only relevant when `runtime_key` is set.
pub fn select_external_session_for_runtime(
    mapped_session_id: Option<String>,
    external_session_id_hint: Option<String>,
    runtime_key: Option<&str>,
    previous_runtime_key: Option<&str>,
) -> Option<String> {
    if let Some(hint) = external_session_id_hint {
        return Some(hint);
    }

    match runtime_key {
        Some(current) => {
            if previous_runtime_key == Some(current) {
                mapped_session_id
            } else {
                None
            }
        }
        None => mapped_session_id,
    }
}

/// Build a fingerprint of where the external CLI will execute, to gate
/// resume-vs-fresh decisions. `workspace_paths` are additional dirs the
/// runtime is configured to expose; for CLIs that don't support them pass an
/// empty slice. Non-existent paths and empty strings are skipped; duplicates
/// (and the `cwd` itself) are folded out so the order stays stable across
/// invocations that name the same paths in different orders.
pub fn external_runtime_key(cwd: &Path, workspace_paths: &[String]) -> Option<String> {
    if workspace_paths.is_empty() && cwd.as_os_str().is_empty() {
        return None;
    }

    let cwd_buf = cwd.to_path_buf();
    let cwd_normalized = normalize_workspace_path_for_compare(&cwd_buf);
    let mut seen = std::collections::HashSet::new();
    seen.insert(cwd_normalized.clone());
    let mut parts = vec![cwd_normalized];
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
        if seen.insert(normalized.clone()) {
            parts.push(normalized);
        }
    }
    Some(parts.join("|"))
}

fn normalize_workspace_path_for_compare(path: &PathBuf) -> String {
    path.to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .to_string()
}

/// Hard cap (in bytes) on a single line of stdout read from an external CLI.
/// Without this, a single tool output that happens to land on a child's
/// stdout without a trailing newline — e.g. a giant heredoc — would force the
/// reader to accumulate the whole payload in memory before parsing. 512 KiB
/// covers every realistic tool result; anything larger goes through the
/// truncated path and is recorded in `runtime_log`.
pub const MAX_STDOUT_LINE_BYTES: usize = 512 * 1024;

/// Read a single line from a stdout-style async reader with a hard byte cap.
/// Returns `Ok(None)` at clean EOF, `Ok(Some((line, truncated)))` otherwise.
/// `truncated == true` means the source line exceeded the cap and the
/// returned string is the cap-sized prefix; the reader's internal cursor has
/// been advanced past the newline (if any) so subsequent calls resume cleanly.
pub async fn read_capped_line<R>(
    reader: &mut R,
    max_bytes: usize,
) -> Result<Option<(String, bool)>, String>
where
    R: AsyncBufRead + Unpin,
{
    let mut out = Vec::new();
    let mut truncated = false;
    loop {
        let available = reader.fill_buf().await.map_err(|e| e.to_string())?;
        if available.is_empty() {
            if out.is_empty() && !truncated {
                return Ok(None);
            }
            return Ok(Some((String::from_utf8_lossy(&out).to_string(), truncated)));
        }

        let newline_pos = available.iter().position(|byte| *byte == b'\n');
        let take_len = newline_pos.map(|pos| pos + 1).unwrap_or(available.len());
        if out.len() < max_bytes {
            let remaining = max_bytes - out.len();
            out.extend_from_slice(&available[..take_len.min(remaining)]);
            if take_len > remaining {
                truncated = true;
            }
        } else {
            truncated = true;
        }

        reader.consume(take_len);
        if newline_pos.is_some() {
            return Ok(Some((String::from_utf8_lossy(&out).to_string(), truncated)));
        }
    }
}

/// Kill an external-CLI child process tree. On Windows we use `taskkill /T /F`
/// to take down the whole tree (the child typically spawns its own helpers);
/// on failure or on non-Windows we fall back to `Child::kill`.
pub async fn kill_child_tree(child: &mut Child, label: &str, thread_id: &str) {
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let mut cmd = Command::new("taskkill");
        crate::process_window::hide_command_window(&mut cmd);
        match cmd
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .await
        {
            Ok(output) if output.status.success() => return,
            Ok(output) => tracing::warn!(
                "[{label}] taskkill failed for {thread_id}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
            Err(err) => tracing::warn!("[{label}] failed to run taskkill for {thread_id}: {err}"),
        }
    }

    if let Err(err) = child.kill().await {
        tracing::warn!("[{label}] failed to kill child for {thread_id}: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[test]
    fn registry_metadata_is_thread_scoped() {
        let registry = ExternalRunRegistry::new("codex", "codex");
        assert_eq!(registry.agent_type, "codex");
        assert_eq!(registry.current_tool, "codex");
    }

    #[test]
    fn resolve_run_id_prefers_frontend_run_id() {
        assert_eq!(
            resolve_run_id("thread_1", Some(" frontend-run ")),
            "frontend-run"
        );
    }

    #[test]
    fn resolve_run_id_falls_back_to_generated_thread_scoped_id() {
        let run_id = resolve_run_id("thread_1", Some(" "));
        assert!(run_id.starts_with("thread_1-"));
    }

    #[tokio::test]
    async fn capped_stdout_reader_truncates_long_lines() {
        let input = format!("{}{}\nnext\n", "x".repeat(20), "y".repeat(20));
        let mut reader = BufReader::new(input.as_bytes());

        let (line, truncated) = read_capped_line(&mut reader, 16)
            .await
            .expect("read line")
            .expect("line");
        assert_eq!(line.len(), 16);
        assert!(truncated);

        let (line, truncated) = read_capped_line(&mut reader, 16)
            .await
            .expect("read next line")
            .expect("next line");
        assert_eq!(line.trim(), "next");
        assert!(!truncated);
    }
}
