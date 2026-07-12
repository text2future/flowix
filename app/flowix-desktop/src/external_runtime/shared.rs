use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, RwLock};

use crate::agent::{AgentChunk, RunInfo};
use crate::runtime_log;
use crate::session::{AgentConversationRun, ThreadManager};
use crate::watcher::dispatcher;

/// One live external-agent child process per `thread_id`.
///
/// Codex / Claude Code / `simple_cli` all fall under this shape: a long-lived
/// process whose stdout is line-streamed as JSON events. Consolidating the
/// state here makes run-id / kill / stdout-cap semantics single-sourced.
#[derive(Clone)]
pub struct ExternalRunRegistry {
    agent_type: &'static str,
    current_tool: &'static str,
    children: Arc<Mutex<HashMap<String, ExternalRunningChild>>>,
}

pub struct ExternalRunningChild {
    pub child: Child,
    pub started_at: i64,
    pub last_event_at: i64,
    pub run_id: Option<String>,
    pub session_id: Option<String>,
    /// Shared one-shot flag between the streaming task that spawned this child
    /// and anyone that may end the run out-of-band (`stop_chat`, the idle
    /// watchdog). Whoever wins the `compare_exchange(false → true)` race is
    /// the sole emitter of `AgentChunk::StreamEnd`; every other path sees the
    /// flag set and skips. This is the *only* "StreamEnd already emitted"
    /// mechanism ── there is no parallel bool. It lets `stop_chat` /
    /// watchdog converge the UI immediately instead of waiting on the
    /// streaming task to notice the child died (which can hang when
    /// grandchildren still hold the stdout write end).
    pub stream_end_emitted: Arc<AtomicBool>,
}

#[derive(Clone, Debug)]
pub struct ExternalWatchdogFinalizedRun {
    pub thread_id: String,
    pub run_id: Option<String>,
    pub reason: Option<String>,
}

impl ExternalRunRegistry {
    pub fn new(agent_type: &'static str, current_tool: &'static str) -> Self {
        Self {
            agent_type,
            current_tool,
            children: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn insert(
        &self,
        thread_id: String,
        child: Child,
        run_id: Option<String>,
        stream_end_emitted: Arc<AtomicBool>,
    ) {
        let mut children = self.children.lock().await;
        let now = chrono::Utc::now().timestamp_millis();
        children.insert(
            thread_id,
            ExternalRunningChild {
                child,
                started_at: now,
                last_event_at: now,
                run_id,
                session_id: None,
                stream_end_emitted,
            },
        );
    }

    pub async fn try_insert(
        &self,
        thread_id: String,
        child: Child,
        run_id: Option<String>,
        stream_end_emitted: Arc<AtomicBool>,
    ) -> Result<(), Child> {
        let mut children = self.children.lock().await;
        if children.contains_key(&thread_id) {
            return Err(child);
        }
        let now = chrono::Utc::now().timestamp_millis();
        children.insert(
            thread_id,
            ExternalRunningChild {
                child,
                started_at: now,
                last_event_at: now,
                run_id,
                session_id: None,
                stream_end_emitted,
            },
        );
        Ok(())
    }

    pub async fn touch(&self, thread_id: &str, expected_run_id: Option<&str>) {
        let mut children = self.children.lock().await;
        let Some(running) = children.get_mut(thread_id) else {
            return;
        };
        if expected_run_id.is_some() && running.run_id.as_deref() != expected_run_id {
            return;
        }
        running.last_event_at = chrono::Utc::now().timestamp_millis();
    }

    pub async fn set_session_id(
        &self,
        thread_id: &str,
        expected_run_id: Option<&str>,
        session_id: String,
    ) {
        let mut children = self.children.lock().await;
        let Some(running) = children.get_mut(thread_id) else {
            return;
        };
        if expected_run_id.is_some() && running.run_id.as_deref() != expected_run_id {
            return;
        }
        running.session_id = Some(session_id);
        running.last_event_at = chrono::Utc::now().timestamp_millis();
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

    /// Make room for a new chat on `thread_id`.
    ///
    ///   * No entry, or the previous child has already exited (`try_wait`
    ///     returns `Some(_)`): returns `None`. The entry has been dropped
    ///     in the exited case; the caller can proceed.
    ///   * Previous child is still running, or `try_wait` errored: returns
    ///     `Some(reason)` and restores the entry. The caller should refuse.
    ///
    /// Without this, a child that crashed (SIGKILL / OOM / broken pipe)
    /// leaves a zombie entry that every later `contains`-style guard
    /// reports as "already running" — the thread is permanently blocked
    /// until the watchdog's 60s+ idle reaper finally sweeps it. Calling
    /// this at `chat_stream` entry keeps the registry honest.
    ///
    /// Implementation note: the entire remove → try_wait → maybe-insert
    /// sequence runs under one `children` lock acquisition. `try_wait` is
    /// non-blocking per its docs, so holding the mutex is safe; doing the
    /// operation across two lock acquisitions would let a concurrent
    /// `chat_stream` slip a fresh child into the registry between our
    /// `remove` and `insert`, and our restore would clobber it.
    pub async fn reap_stale(&self, thread_id: &str) -> Option<String> {
        let mut children = self.children.lock().await;
        let Some(mut running) = children.remove(thread_id) else {
            return None;
        };
        match running.child.try_wait() {
            Ok(Some(_status)) => {
                tracing::info!(
                    "[{}] reaped stale child for {} before new chat",
                    self.current_tool,
                    thread_id
                );
                None
            }
            Ok(None) => {
                children.insert(thread_id.to_string(), running);
                Some(format!(
                    "{} is already running for this thread",
                    self.current_tool
                ))
            }
            Err(err) => {
                tracing::warn!(
                    "[{}] try_wait failed for {}: {err}; treating as live",
                    self.current_tool,
                    thread_id
                );
                children.insert(thread_id.to_string(), running);
                Some(format!(
                    "{} child state unknown; refusing to overlap",
                    self.current_tool
                ))
            }
        }
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

    pub async fn kill_all(&self, label: &str) -> usize {
        let running = {
            let mut children = self.children.lock().await;
            children.drain().collect::<Vec<_>>()
        };
        let count = running.len();
        for (thread_id, mut running) in running {
            kill_child_tree(&mut running.child, label, &thread_id).await;
        }
        count
    }

    pub async fn reap_inactive(
        &self,
        idle_timeout_ms: i64,
        label: &str,
    ) -> Vec<ExternalWatchdogFinalizedRun> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut finalized = Vec::new();
        let mut idle_children = Vec::new();

        {
            let mut children = self.children.lock().await;
            let thread_ids = children.keys().cloned().collect::<Vec<_>>();
            for thread_id in thread_ids {
                enum Decision {
                    Keep,
                    Exited(bool, String),
                    InspectFailed(String),
                    Idle,
                    Missing,
                }

                let decision = match children.get_mut(&thread_id) {
                    Some(running) => {
                        let is_idle = idle_timeout_ms > 0
                            && now.saturating_sub(running.last_event_at) >= idle_timeout_ms;
                        if !is_idle {
                            Decision::Keep
                        } else {
                            match running.child.try_wait() {
                                Ok(Some(status)) => {
                                    Decision::Exited(status.success(), status.to_string())
                                }
                                Ok(None) => Decision::Idle,
                                Err(err) => Decision::InspectFailed(err.to_string()),
                            }
                        }
                    }
                    None => Decision::Missing,
                };

                match decision {
                    Decision::Keep | Decision::Missing => {}
                    Decision::Exited(success, status) => {
                        if let Some(running) = children.remove(&thread_id) {
                            // 在锁内、kill 之前抢 StreamEnd slot ── 若 tail /
                            // stop_chat 已先发过 (Exited: child 已死, tail 可能已
                            // 观察到 EOF 并 CAS), 跳过本 run, 不双发也不覆盖。
                            // Idle: child 还活着, tail 必然还阻塞在 read, 这里
                            // 确定性赢, 避免杀进程后 tail 抢赢导致 idle-timeout
                            // reason + persist 丢失。
                            if !claim_stream_end_once(&running.stream_end_emitted) {
                                continue;
                            }
                            let reason = (!success).then(|| format!("process_exited: {status}"));
                            finalized.push(ExternalWatchdogFinalizedRun {
                                thread_id,
                                run_id: running.run_id,
                                reason,
                            });
                        }
                    }
                    Decision::InspectFailed(err) => {
                        if let Some(running) = children.remove(&thread_id) {
                            if !claim_stream_end_once(&running.stream_end_emitted) {
                                continue;
                            }
                            finalized.push(ExternalWatchdogFinalizedRun {
                                thread_id,
                                run_id: running.run_id,
                                reason: Some(format!("process_watchdog_failed: {err}")),
                            });
                        }
                    }
                    Decision::Idle => {
                        if let Some(running) = children.remove(&thread_id) {
                            if !claim_stream_end_once(&running.stream_end_emitted) {
                                continue;
                            }
                            idle_children.push((thread_id, running));
                        }
                    }
                }
            }
        }

        for (thread_id, mut running) in idle_children {
            kill_child_tree(&mut running.child, label, &thread_id).await;
            finalized.push(ExternalWatchdogFinalizedRun {
                thread_id,
                run_id: running.run_id,
                reason: Some(format!("watchdog_idle_timeout_ms={idle_timeout_ms}")),
            });
        }

        finalized
    }

    pub async fn running_threads(&self) -> HashMap<String, RunInfo> {
        let children = self.children.lock().await;
        children
            .iter()
            .map(|(thread_id, running)| {
                let canonical_thread_id = running
                    .session_id
                    .clone()
                    .unwrap_or_else(|| thread_id.clone());
                (
                    canonical_thread_id,
                    RunInfo::active(
                        running.started_at,
                        Some(self.current_tool),
                        Some(self.agent_type),
                        running.run_id.clone(),
                        Some(thread_id.clone()),
                        running.session_id.clone(),
                    ),
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

/// Reason string `stop_chat` attaches to its `StreamEnd`. The frontend
/// (`run-lifecycle::USER_STOPPED_REASON`) maps this to `cancelled` status ──
/// a user-initiated stop is never `failed` / `completed`. Kept in sync by name
/// + value; changing one side without the other breaks the status mapping.
pub const USER_STOPPED_REASON: &str = "user_stopped";

/// Atomically claim the "StreamEnd has been emitted" slot for a run. First
/// caller wins (`true`); everyone else (`stop_chat`, streaming tail, watchdog)
/// gets `false` and must skip. This is the single chokepoint that prevents
/// double `StreamEnd` ── there is no parallel "already emitted" bool.
pub fn claim_stream_end_once(stream_end_emitted: &Arc<AtomicBool>) -> bool {
    stream_end_emitted
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

/// Claim the slot via [`claim_stream_end_once`] and, on a win, emit
/// `AgentChunk::StreamEnd`. Returns whether this caller emitted.
///
/// Callers:
///   * `*CliManager::stop_chat` ── reason `Some(USER_STOPPED_REASON)`
///   * the streaming `tokio::spawn` tail ── reason `None` (clean) or the run error
///
/// The idle watchdog does NOT use this ── it must emit an `Error` chunk
/// *before* `StreamEnd`, and it must claim *before* killing the child (else
/// the tail can race ahead and emit a bare `completed`). So `reap_inactive`
/// calls [`claim_stream_end_once`] directly under the children lock (before
/// `kill_child_tree`), and `reap_inactive_runs` then emits `Error` +
/// `StreamEnd` + persist for the runs that won the claim.
pub fn emit_stream_end_once(
    app_handle: &tauri::AppHandle,
    thread_id: &str,
    run_id: &str,
    agent_type: &'static str,
    reason: Option<String>,
    stream_end_emitted: &Arc<AtomicBool>,
) -> bool {
    if claim_stream_end_once(stream_end_emitted) {
        emit_chunk_with_run_id(
            app_handle,
            &AgentChunk::StreamEnd {
                thread_id: thread_id.to_string(),
                reason,
            },
            agent_type,
            run_id,
        );
        true
    } else {
        false
    }
}

pub async fn persist_watchdog_finalized_run_state(
    thread_manager: &Arc<RwLock<ThreadManager>>,
    run: &ExternalWatchdogFinalizedRun,
    log_label: &str,
) {
    let Some(run_id) = run.run_id.as_deref() else {
        return;
    };

    let ended_at = chrono::Utc::now().timestamp_millis();
    let status = if run.reason.is_some() {
        "failed"
    } else {
        "completed"
    };

    let manager = thread_manager.read().await;
    let instance = match manager.find_agent_conversation_by_run_id(run_id).await {
        Ok(Some(instance)) => instance,
        Ok(None) => return,
        Err(err) => {
            tracing::warn!(
                "[{log_label}] failed to find run state for watchdog finalization: {err}"
            );
            return;
        }
    };

    let existing_run = instance.run.as_ref();
    let run_state = AgentConversationRun {
        run_id: run_id.to_string(),
        status: status.to_string(),
        started_at: existing_run
            .map(|existing| existing.started_at)
            .unwrap_or(ended_at),
        ended_at: Some(ended_at),
        current_tool: None,
        model: existing_run.and_then(|existing| existing.model.clone()),
        model_id: existing_run.and_then(|existing| existing.model_id.clone()),
        reasoning_effort: existing_run.and_then(|existing| existing.reasoning_effort.clone()),
        last_run_at: Some(ended_at),
        reason: run.reason.clone(),
        usage: existing_run.and_then(|existing| existing.usage.clone()),
        status_info: existing_run.and_then(|existing| existing.status_info.clone()),
    };

    if let Err(err) = manager
        .upsert_agent_conversation_run_state(&instance.instance_id, run_state)
        .await
    {
        tracing::warn!("[{log_label}] failed to persist watchdog run state: {err}");
    }
}

/// Pick the external-CLI session id for a `chat_stream` invocation.
///
/// Decision order (first hit wins):
///   * `external_session_id_hint` — when the frontend thread id is itself a
///     provider-format session id (e.g. a Codex / Claude UUID pasted as a
///     thread id, or an `codex-local-...` placeholder resolved to one),
///     resume that session.
///   * `mapped_session_id` — otherwise trust the SQLite
///     `thread_external_sessions` mapping created when the thread first ran.
///     If a CLI process already produced a session id for this thread, we
///     resume it instead of starting a new one.
///
/// UI locks cwd / workspace dirs at first message time, so cwd drift
/// mid-conversation can't happen; we don't gate resume on cwd anymore.
/// (The previous runtime_key check used to be the source of a silent
/// post-restart fork — the in-memory key was wiped, so the comparison
/// always mismatched and we started a fresh session every cold start.)
pub fn select_external_session_for_runtime(
    mapped_session_id: Option<String>,
    external_session_id_hint: Option<String>,
) -> Option<String> {
    external_session_id_hint.or(mapped_session_id)
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

    /// `stream_end_emitted` 是 `stop_chat` / 流式任务 tail / watchdog 三方共享
    /// 的"StreamEnd 已发"哨兵 ── 各持一份 Arc clone, 谁先 CAS(false -> true) 谁负责
    /// 发, 另两方 CAS 失败而 skip。这条测试钉死该不变量: 注册时塞进去的 flag
    /// 与调用方手里那份是同一个 AtomicBool, 且只有一次 CAS 能赢。
    #[cfg(unix)]
    #[tokio::test]
    async fn stream_end_emitted_flag_is_shared_and_oneshot() {
        use std::sync::atomic::Ordering;

        let registry = ExternalRunRegistry::new("codex", "codex");
        let stream_end_emitted = Arc::new(AtomicBool::new(false));
        let caller_clone = stream_end_emitted.clone();

        let child = tokio::process::Command::new("true")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn `true`");
        registry
            .insert(
                "t".to_string(),
                child,
                Some("run-1".to_string()),
                stream_end_emitted,
            )
            .await;

        // stop_chat 路径: 从 registry 抢出 entry, 用 entry 里的 flag CAS。
        let running = registry.remove("t").await.expect("running entry exists");
        let stop_won = running
            .stream_end_emitted
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();

        // 流式任务 tail 路径: 用调用方手里的 clone 再 CAS, 必须失败。
        let tail_won = caller_clone
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();

        assert!(stop_won, "stop_chat should win the CAS");
        assert!(!tail_won, "streaming tail must skip after stop_chat won");
        assert!(
            caller_clone.load(Ordering::SeqCst),
            "flag must be visible as true to the tail clone"
        );
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

    #[tokio::test]
    async fn reap_stale_returns_none_when_no_entry() {
        let registry = ExternalRunRegistry::new("codex", "codex");
        assert!(registry.reap_stale("missing").await.is_none());
    }

    /// Spawn a child that exits immediately, register it, wait for it to
    /// exit, then call reap_stale — should drop the entry and return None.
    #[cfg(unix)]
    #[tokio::test]
    async fn reap_stale_drops_already_exited_child() {
        let registry = ExternalRunRegistry::new("codex", "codex");
        let child = tokio::process::Command::new("true")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn `true`");
        registry
            .insert(
                "t".to_string(),
                child,
                Some("run-1".to_string()),
                Arc::new(AtomicBool::new(false)),
            )
            .await;
        // Give the kernel a moment to actually reap the process. Without
        // this, try_wait can still return Ok(None) on slow runners.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        assert!(registry.reap_stale("t").await.is_none());
        assert!(!registry.contains("t").await);
    }
}
