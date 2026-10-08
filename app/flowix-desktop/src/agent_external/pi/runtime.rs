use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;

use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::Manager;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{mpsc, Mutex, OwnedMutexGuard};
use tokio::time::Duration;

use super::super::lifecycle::ExternalLifecycleEmitter;
use super::super::{
    persist_and_emit_external_chunk, resolve_and_freeze_runtime_cwd, resolve_run_id,
    AgentChunkMetadata, USER_STOPPED_REASON,
};
use super::AGENT_TYPE;
use crate::agent_session::ThreadManager;
use crate::agent_wire::{AgentChunk, AgentUserMessage, RunInfo, UsageInfo};

const PI_IDLE_SESSION_TTL_MS: i64 = 10 * 60 * 1000;
const PI_RPC_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const PI_HISTORY_LOCK_TIMEOUT: Duration = Duration::from_secs(30);
const PI_ABORT_SETTLE_TIMEOUT: Duration = Duration::from_secs(5);

/// Pi generates thinking blocks as configured, but Flowix only forwards them
/// when explicitly enabled by the host environment.
fn pi_forward_thinking_enabled() -> bool {
    std::env::var("FLOWIX_PI_FORWARD_THINKING")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn pi_tools_for_permission_mode(mode: Option<&str>) -> &'static str {
    match mode {
        Some("read-only") => "read",
        Some("workspace-write") => "read,edit,write",
        // Pi's built-in tools have no per-path sandbox. Unknown and legacy
        // modes retain the existing full-access behavior.
        _ => "read,bash,edit,write",
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PiSessionConfig {
    cwd: PathBuf,
    tools: String,
    code_mode: bool,
    tool_search: bool,
    provider: Option<String>,
    model: Option<String>,
    thinking: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiHistoryRevision {
    session_id: String,
    append_cursor: Option<String>,
    leaf_id: Option<String>,
}

#[derive(serde::Serialize)]
pub struct PiSessionSnapshot {
    messages: Vec<Value>,
    revision: PiHistoryRevision,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiHistoryPage {
    messages: Vec<Value>,
    revision: PiHistoryRevision,
    before_entry_id: Option<String>,
    oldest_sequence: Option<usize>,
    snapshot_sequence: usize,
    has_more: bool,
}

fn page_pi_snapshot(
    snapshot: &PiSessionSnapshot,
    before: Option<&str>,
    limit: usize,
) -> Result<PiHistoryPage, String> {
    let messages = &snapshot.messages;
    let upper = match before {
        Some(id) => messages
            .iter()
            .position(|message| {
                message
                    .get("_pi_session_message_id")
                    .and_then(Value::as_str)
                    == Some(id)
            })
            .ok_or("Pi history cursor is not in the pinned snapshot")?,
        None => messages.len(),
    };
    if upper > 0
        && upper < messages.len()
        && messages[upper].get("role").and_then(Value::as_str) != Some("user")
    {
        return Err("Pi history cursor must point to a complete turn boundary".into());
    }
    let mut turns = vec![0];
    for index in 1..upper {
        if messages[index].get("role").and_then(Value::as_str) == Some("user") {
            turns.push(index);
        }
    }
    let start = turns[turns.len().saturating_sub(limit.clamp(1, 100))];
    let page = messages[start..upper].to_vec();
    let before_entry_id = page
        .first()
        .and_then(|message| message.get("_pi_session_message_id"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok(PiHistoryPage {
        oldest_sequence: (!page.is_empty()).then_some(start),
        messages: page,
        before_entry_id,
        revision: snapshot.revision.clone(),
        snapshot_sequence: messages.len(),
        has_more: start > 0,
    })
}

// Pi frames contain whole session snapshots. This reader deliberately has no
// line-size truncation and never applies display limits to the RPC transport.
async fn read_pi_rpc_record<R: AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<Option<Value>, String> {
    loop {
        let mut bytes = Vec::new();
        if reader
            .read_until(b'\n', &mut bytes)
            .await
            .map_err(|error| error.to_string())?
            == 0
        {
            return Ok(None);
        }
        if bytes.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        return serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| format!("invalid Pi RPC record: {error}"));
    }
}

#[derive(Default)]
struct PiEntriesCache {
    entries: Arc<Vec<Value>>,
    by_id: HashMap<String, usize>,
}

impl PiEntriesCache {
    fn update(&mut self, entries: &[Value], replace: bool) {
        if replace {
            *self = Self::default();
        }
        let cached = Arc::make_mut(&mut self.entries);
        for entry in entries {
            if let Some(id) = entry.get("id").and_then(Value::as_str) {
                self.by_id.insert(id.to_owned(), cached.len());
            }
            cached.push(entry.clone());
        }
    }

    fn message_id(&self, leaf: Option<&str>, message: &Value) -> Result<String, String> {
        let mut current = leaf;
        let mut visited = std::collections::HashSet::new();
        while let Some(id) = current {
            if !visited.insert(id) {
                return Err("Pi session branch contains a cycle".into());
            }
            let entry = self
                .by_id
                .get(id)
                .and_then(|index| self.entries.get(*index))
                .ok_or("Pi active session branch references a missing entry")?;
            if entry.get("type").and_then(Value::as_str) == Some("message")
                && entry
                    .get("message")
                    .is_some_and(|saved| pi_message_matches(saved, message))
            {
                return Ok(id.to_owned());
            }
            current = entry.get("parentId").and_then(Value::as_str);
        }
        Err("Pi completed a message without a matching native entry on the active RPC session branch".into())
    }
}

struct PiSession {
    session_id: Mutex<String>,
    config: PiSessionConfig,
    stdin: Arc<Mutex<ChildStdin>>,
    records: Mutex<mpsc::UnboundedReceiver<Result<Value, String>>>,
    deferred_records: Mutex<VecDeque<Value>>,
    entries_cache: Mutex<PiEntriesCache>,
    child: Mutex<tokio::process::Child>,
    stdout_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    stderr: Arc<Mutex<String>>,
    operation: Arc<Mutex<()>>,
    invalidated: AtomicBool,
    last_used_at: AtomicI64,
}

impl PiSession {
    async fn write(&self, value: &Value) -> Result<(), String> {
        write_rpc(&self.stdin, value).await
    }

    async fn write_prompt_if_running(
        &self,
        active: &ActivePiRun,
        value: &Value,
    ) -> Result<bool, String> {
        let mut stdin = self.stdin.lock().await;
        // Coordinate the stop flag with the prompt write itself. If Stop wins
        // the stdin lock, no late prompt can be queued after `abort`; if the
        // prompt wins, Stop's clear_queue/abort commands follow it in order.
        if active.stop_reason.lock().await.is_some() {
            return Ok(false);
        }
        write_rpc_locked(&mut stdin, value).await?;
        Ok(true)
    }

    async fn next_record(&self) -> Result<Value, String> {
        if let Some(record) = self.deferred_records.lock().await.pop_front() {
            return Ok(record);
        }
        self.records
            .lock()
            .await
            .recv()
            .await
            .ok_or_else(|| "Pi RPC event reader closed".to_string())?
    }

    /// Called only by the owner of `operation`. Read responses from the same
    /// receiver and preserve interleaved agent events for the main event loop.
    async fn session_entries(&self) -> Result<(Arc<Vec<Value>>, Option<String>), String> {
        static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let mut cache = self.entries_cache.lock().await;
        // The cursor follows append order, not the active leaf: branch switches
        // can move the leaf backwards without changing the append-only log.
        let mut since = cache
            .entries
            .last()
            .and_then(|entry| entry.get("id"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        loop {
            let request_id = format!(
                "flowix-entries-{}",
                REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            );
            let mut request = serde_json::json!({"id": request_id, "type": "get_entries"});
            if let Some(cursor) = &since {
                request["since"] = Value::String(cursor.clone());
            }
            self.write(&request).await?;
            let mut records = self.records.lock().await;
            let mut deferred = self.deferred_records.lock().await;
            let response = tokio::time::timeout(
                PI_RPC_REQUEST_TIMEOUT,
                receive_rpc_response(&mut records, &mut deferred, &request_id),
            )
            .await
            .map_err(|_| "Pi session entries RPC timed out".to_string())??;
            if response.get("success").and_then(Value::as_bool) != Some(true) {
                if since.take().is_some() {
                    // A stale cursor or an older runtime can be recovered with
                    // one authoritative full RPC snapshot.
                    continue;
                }
                return Err(response
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Pi could not read session entries")
                    .to_string());
            }
            let entries = response
                .pointer("/data/entries")
                .and_then(Value::as_array)
                .ok_or("Pi session entries RPC did not include entries")?;
            cache.update(entries, since.is_none());
            let leaf_id = response
                .pointer("/data/leafId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            return Ok((Arc::clone(&cache.entries), leaf_id));
        }
    }

    async fn is_alive(&self) -> bool {
        !self.invalidated.load(Ordering::Acquire)
            && matches!(self.child.lock().await.try_wait(), Ok(None))
    }

    fn touch(&self) {
        self.last_used_at
            .store(chrono::Utc::now().timestamp_millis(), Ordering::Relaxed);
    }

    async fn stderr_text(&self) -> String {
        self.stderr.lock().await.clone()
    }

    async fn lock_operation(self: &Arc<Self>) -> OwnedMutexGuard<()> {
        self.operation.clone().lock_owned().await
    }

    async fn shutdown(&self, thread_id: &str) {
        let _ = self.stdin.lock().await.shutdown().await;
        let mut child = self.child.lock().await;
        if tokio::time::timeout(std::time::Duration::from_millis(500), child.wait())
            .await
            .is_err()
        {
            crate::agent_external::shared::kill_child_tree(&mut child, "Pi RPC", thread_id).await;
            let _ = child.wait().await;
        }
        drop(child);
        if let Some(task) = self.stdout_task.lock().await.take() {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(1), task).await;
        }
    }
}

struct ActivePiRun {
    run_id: String,
    started_at: i64,
    session: Mutex<Option<Arc<PiSession>>>,
    session_id: Mutex<Option<String>>,
    stop_notify: tokio::sync::Notify,
    last_event_at: AtomicI64,
    stop_reason: Mutex<Option<String>>,
    finalizing: AtomicBool,
    stream_end_emitted: Arc<AtomicBool>,
}

pub struct PiRpcManager {
    thread_manager: Arc<ThreadManager>,
    sessions: Mutex<HashMap<String, Arc<PiSession>>>,
    starting_sessions: Mutex<HashMap<String, Arc<PiSession>>>,
    session_start_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    active_runs: Mutex<HashMap<String, Arc<ActivePiRun>>>,
    shutting_down: AtomicBool,
    history_snapshots: Mutex<VecDeque<(String, Arc<PiSessionSnapshot>)>>,
}

#[async_trait::async_trait]
impl ExternalLifecycleEmitter for PiRpcManager {
    fn lifecycle_agent_type(&self) -> &'static str {
        AGENT_TYPE
    }

    async fn emit_and_persist_lifecycle_chunk(
        &self,
        app_handle: &tauri::AppHandle,
        chunk: &AgentChunk,
        run_id: &str,
    ) {
        persist_and_emit_external_chunk(
            app_handle,
            &self.thread_manager,
            AGENT_TYPE,
            chunk,
            run_id,
            None,
        )
        .await;
    }

    async fn persist_emitted_stream_end(&self, chunk: &AgentChunk, run_id: &str) {
        crate::agent_external::persist_external_chunk(
            &self.thread_manager,
            AGENT_TYPE,
            chunk,
            run_id,
            None,
        )
        .await;
    }
}

impl PiRpcManager {
    pub fn new(thread_manager: Arc<ThreadManager>) -> Self {
        Self {
            thread_manager,
            sessions: Mutex::new(HashMap::new()),
            starting_sessions: Mutex::new(HashMap::new()),
            session_start_locks: Mutex::new(HashMap::new()),
            active_runs: Mutex::new(HashMap::new()),
            shutting_down: AtomicBool::new(false),
            history_snapshots: Mutex::new(VecDeque::new()),
        }
    }

    pub async fn delete_session(&self, thread_id: &str) -> Result<bool, String> {
        self.history_snapshots
            .lock()
            .await
            .retain(|(id, _)| id != thread_id);
        let session = self.sessions.lock().await.remove(thread_id);
        if let Some(session) = session {
            session.shutdown(thread_id).await;
        }
        let path = resolve_pi_session_dir(thread_id, false)?;
        let mut deleted = false;
        for candidate in [path, legacy_pi_session_dir(thread_id)?] {
            match std::fs::remove_dir_all(candidate) {
                Ok(()) => deleted = true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!("could not delete Pi conversation session: {error}"));
                }
            }
        }
        Ok(deleted)
    }

    async fn ensure_session(
        &self,
        app: &tauri::AppHandle,
        thread_id: &str,
        config: PiSessionConfig,
        history_read: bool,
    ) -> Result<Arc<PiSession>, String> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("Pi runtime is shutting down".into());
        }
        // Serialize startup/replacement per Flowix thread. The global session
        // map is only held for lookups and inserts, never while waiting for a
        // process response or another session's operation.
        let start_lock = {
            let mut locks = self.session_start_locks.lock().await;
            locks
                .entry(thread_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _start_guard = start_lock.lock_owned().await;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("Pi runtime is shutting down".into());
        }
        let existing = self.sessions.lock().await.get(thread_id).cloned();
        if let Some(existing) = existing {
            if existing.is_alive().await && (history_read || existing.config == config) {
                return Ok(existing);
            }
            let operation = existing.lock_operation().await;
            let removed = {
                let mut sessions = self.sessions.lock().await;
                if sessions
                    .get(thread_id)
                    .is_some_and(|current| Arc::ptr_eq(current, &existing))
                {
                    sessions.remove(thread_id)
                } else {
                    None
                }
            };
            drop(operation);
            if let Some(removed) = removed {
                removed.shutdown(thread_id).await;
            }
        }

        let session_dir = resolve_pi_session_dir(thread_id, true)?;
        let expected_id = self
            .thread_manager
            .get_external_session(thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        let config_dir = pi_config_dir()?;
        std::fs::create_dir_all(&config_dir)
            .map_err(|error| format!("cannot create Pi config directory: {error}"))?;

        let mut command = Command::new(resolve_pi_binary(app)?);
        let mut tools = config.tools.split(',').map(str::to_owned).collect::<Vec<_>>();
        if config.code_mode { tools.push("codemode".into()); }
        if config.tool_search { tools.push("tool_search".into()); }
        let tools = tools.join(",");
        command
            .args(["--mode", "rpc", "--session-dir"])
            .arg(&session_dir)
            .arg("--tools")
            .arg(&tools)
            .args(if config.code_mode { vec!["--extension", "builtin:codemode"] } else { Vec::new() })
            .args(if config.tool_search { vec!["--extension", "builtin:tool-search"] } else { Vec::new() })
            .current_dir(&config.cwd)
            .env("PI_CODING_AGENT_DIR", &config_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(session_id) = expected_id.as_deref() {
            command.arg("--session").arg(session_id);
        } else {
            command.arg("--continue");
        }
        if let Some(provider) = config.provider.as_deref() {
            command.args(["--provider", provider]);
        }
        if let Some(model) = config.model.as_deref() {
            command.args(["--model", model]);
        }
        if let Some(thinking) = config.thinking.as_deref() {
            command.args(["--thinking", thinking]);
        }
        crate::agent_external::shared::configure_unix_process_group(&mut command);
        crate::process_window::hide_command_window(&mut command);

        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start Pi v1.0.3 RPC: {error}"))?;
        let stdin = Arc::new(Mutex::new(
            child.stdin.take().ok_or("Pi stdin unavailable")?,
        ));
        let stdout = child.stdout.take().ok_or("Pi stdout unavailable")?;
        let stderr_pipe = child.stderr.take().ok_or("Pi stderr unavailable")?;
        let (record_tx, record_rx) = mpsc::unbounded_channel();
        let stdout_task = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let record = match read_pi_rpc_record(&mut reader).await {
                    Ok(Some(record)) => Ok(record),
                    Ok(None) => {
                        let _ = record_tx.send(Err("Pi RPC process exited".into()));
                        break;
                    }
                    Err(error) => Err(error),
                };
                let fatal = record.is_err();
                if record_tx.send(record).is_err() || fatal {
                    break;
                }
            }
        });
        let stderr = Arc::new(Mutex::new(String::new()));
        let stderr_capture = stderr.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr_pipe);
            let mut captured = String::new();
            let _ = reader.read_to_string(&mut captured).await;
            *stderr_capture.lock().await = captured;
        });

        let session = Arc::new(PiSession {
            session_id: Mutex::new(String::new()),
            config: config.clone(),
            stdin,
            records: Mutex::new(record_rx),
            deferred_records: Mutex::new(VecDeque::new()),
            entries_cache: Mutex::new(PiEntriesCache::default()),
            child: Mutex::new(child),
            stdout_task: Mutex::new(Some(stdout_task)),
            stderr,
            operation: Arc::new(Mutex::new(())),
            invalidated: AtomicBool::new(false),
            last_used_at: AtomicI64::new(chrono::Utc::now().timestamp_millis()),
        });
        {
            let mut starting = self.starting_sessions.lock().await;
            if self.shutting_down.load(Ordering::Acquire) {
                drop(starting);
                session.shutdown(thread_id).await;
                return Err("Pi runtime is shutting down".into());
            }
            starting.insert(thread_id.to_string(), session.clone());
        }
        let state = match request_pi_state(&session).await {
            Ok(state) => state,
            Err(error) => {
                self.remove_starting_session_if_same(thread_id, &session)
                    .await;
                session.shutdown(thread_id).await;
                return Err(error);
            }
        };
        if self.shutting_down.load(Ordering::Acquire) {
            self.remove_starting_session_if_same(thread_id, &session)
                .await;
            session.shutdown(thread_id).await;
            return Err("Pi runtime is shutting down".into());
        }
        let Some(session_id) = state
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
        else {
            self.remove_starting_session_if_same(thread_id, &session)
                .await;
            session.shutdown(thread_id).await;
            return Err("Pi did not report a sessionId for this conversation".into());
        };
        if let Some(expected_id) = expected_id {
            if expected_id != session_id {
                self.remove_starting_session_if_same(thread_id, &session)
                    .await;
                session.shutdown(thread_id).await;
                return Err(format!(
                    "Pi opened session {session_id}, but Flowix expected {expected_id}"
                ));
            }
        }
        *session.session_id.lock().await = session_id;
        let persisted_session_id = session.session_id.lock().await.clone();
        if let Err(error) = self
            .thread_manager
            .upsert_external_session(
                thread_id,
                AGENT_TYPE,
                &persisted_session_id,
                Some(serde_json::json!({
                    "sessionFile": state.get("sessionFile").and_then(Value::as_str),
                    "cwd": config.cwd.to_string_lossy(),
                })),
            )
            .await
        {
            self.remove_starting_session_if_same(thread_id, &session)
                .await;
            session.shutdown(thread_id).await;
            return Err(error.to_string());
        }
        let mut sessions = self.sessions.lock().await;
        let mut starting = self.starting_sessions.lock().await;
        if self.shutting_down.load(Ordering::Acquire)
            || !starting
                .get(thread_id)
                .is_some_and(|current| Arc::ptr_eq(current, &session))
        {
            if starting
                .get(thread_id)
                .is_some_and(|current| Arc::ptr_eq(current, &session))
            {
                starting.remove(thread_id);
            }
            drop(starting);
            drop(sessions);
            session.shutdown(thread_id).await;
            return Err("Pi runtime is shutting down".into());
        }
        starting.remove(thread_id);
        sessions.insert(thread_id.to_string(), session.clone());
        Ok(session)
    }

    async fn remove_starting_session_if_same(&self, thread_id: &str, session: &Arc<PiSession>) {
        let mut starting = self.starting_sessions.lock().await;
        if starting
            .get(thread_id)
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            starting.remove(thread_id);
        }
    }

    async fn remove_session_if_same(&self, thread_id: &str, session: &Arc<PiSession>) {
        let removed = {
            let mut sessions = self.sessions.lock().await;
            if sessions
                .get(thread_id)
                .is_some_and(|current| Arc::ptr_eq(current, session))
            {
                sessions.remove(thread_id)
            } else {
                None
            }
        };
        if let Some(removed) = removed {
            removed.shutdown(thread_id).await;
        }
    }

    async fn shutdown_and_remove_session_if_same(&self, thread_id: &str, session: &Arc<PiSession>) {
        // Mark it unusable before releasing the operation guard. A concurrent
        // prompt will wait for that guard, then fail validation instead of
        // writing to a process whose abort did not settle.
        session.invalidated.store(true, Ordering::Release);
        session.shutdown(thread_id).await;
        let mut sessions = self.sessions.lock().await;
        if sessions
            .get(thread_id)
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            sessions.remove(thread_id);
        }
    }

    async fn remove_idle_session_if_same(&self, thread_id: &str, session: &Arc<PiSession>) {
        let mut sessions = self.sessions.lock().await;
        let Some(current) = sessions.get(thread_id) else {
            return;
        };
        if !Arc::ptr_eq(current, session) {
            return;
        }
        // Reaping is best-effort. Never hold the manager map while awaiting a
        // prompt to settle; a busy session will be checked on the next pass.
        let Ok(operation) = session.operation.try_lock() else {
            return;
        };
        // A new run can start after the reaper snapshots idle sessions but
        // before this removal. Hold the run map while removing so a
        // concurrently arriving prompt either prevents reaping or starts
        // against a fresh process afterward.
        let active_runs = self.active_runs.lock().await;
        if active_runs.contains_key(thread_id) {
            drop(active_runs);
            drop(operation);
            return;
        }
        let removed = sessions.remove(thread_id);
        drop(active_runs);
        drop(sessions);
        drop(operation);
        if let Some(removed) = removed {
            removed.shutdown(thread_id).await;
        }
    }

    async fn lock_session_operation(
        &self,
        thread_id: &str,
        session: &Arc<PiSession>,
    ) -> Result<OwnedMutexGuard<()>, String> {
        let operation = session.lock_operation().await;
        let sessions = self.sessions.lock().await;
        let current = sessions
            .get(thread_id)
            .ok_or_else(|| "Pi session was closed before the operation started".to_string())?;
        if !Arc::ptr_eq(current, session) {
            return Err("Pi session changed before the operation started".into());
        }
        if session.invalidated.load(Ordering::Acquire) {
            return Err("Pi session was closed before the operation started".into());
        }
        drop(sessions);
        Ok(operation)
    }

    /// Read history and native identities through Pi RPC. Flowix never opens
    /// or parses Pi's session JSONL files.
    pub async fn get_session_page(
        &self,
        app: &tauri::AppHandle,
        thread_id: &str,
        before: Option<&str>,
        limit: usize,
        revision: Option<PiHistoryRevision>,
    ) -> Result<PiHistoryPage, String> {
        if before.is_some() && revision.is_none() {
            return Err("Pi history pagination requires a native snapshot revision".into());
        }
        let mut cached = None;
        if let Some(expected) = &revision {
            let mut snapshots = self.history_snapshots.lock().await;
            if let Some(index) = snapshots
                .iter()
                .position(|(id, snapshot)| id == thread_id && &snapshot.revision == expected)
            {
                let entry = snapshots.remove(index).unwrap();
                cached = Some(Arc::clone(&entry.1));
                snapshots.push_back(entry);
            }
        }
        let snapshot = match cached {
            Some(snapshot) => snapshot,
            None => {
                let snapshot = Arc::new(self.get_session_snapshot(app, thread_id).await?);
                if revision
                    .as_ref()
                    .is_some_and(|expected| expected != &snapshot.revision)
                {
                    return Err(
                        "Pi history branch changed; refresh history before loading older pages"
                            .into(),
                    );
                }
                let mut snapshots = self.history_snapshots.lock().await;
                snapshots.retain(|(id, previous)| {
                    id != thread_id || previous.revision != snapshot.revision
                });
                snapshots.push_back((thread_id.to_owned(), Arc::clone(&snapshot)));
                while snapshots.len() > 16 {
                    snapshots.pop_front();
                }
                snapshot
            }
        };
        page_pi_snapshot(&snapshot, before, limit)
    }

    pub async fn get_session_messages(
        &self,
        app: &tauri::AppHandle,
        thread_id: &str,
    ) -> Result<Vec<Value>, String> {
        Ok(self.get_session_snapshot(app, thread_id).await?.messages)
    }

    pub async fn get_session_snapshot(
        &self,
        app: &tauri::AppHandle,
        thread_id: &str,
    ) -> Result<PiSessionSnapshot, String> {
        let mapped_session = self
            .thread_manager
            .get_external_session(thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        let has_session =
            mapped_session.is_some() || self.sessions.lock().await.contains_key(thread_id);
        if !has_session {
            return Ok(PiSessionSnapshot {
                messages: Vec::new(),
                revision: PiHistoryRevision {
                    session_id: String::new(),
                    append_cursor: None,
                    leaf_id: None,
                },
            });
        }
        let cwd = self
            .thread_manager
            .read_frozen_cwd(thread_id)
            .await
            .map_err(|error| error.to_string())?
            .filter(|cwd| cwd.is_dir())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let config = PiSessionConfig {
            cwd: cwd.clone(),
            tools: "read".into(),
            code_mode: false,
            tool_search: false,
            provider: None,
            model: None,
            thinking: None,
        };
        let session = self.ensure_session(app, thread_id, config, true).await?;
        let _operation = tokio::time::timeout(
            PI_HISTORY_LOCK_TIMEOUT,
            self.lock_session_operation(thread_id, &session),
        )
        .await
        .map_err(|_| {
            "Pi history read timed out waiting for the active turn to finish".to_string()
        })??;
        session.touch();
        let request_id = format!("flowix-history-{}", chrono::Utc::now().timestamp_millis());
        if let Err(error) = session
            .write(&serde_json::json!({"id":request_id,"type":"get_messages"}))
            .await
        {
            drop(_operation);
            self.remove_session_if_same(thread_id, &session).await;
            return Err(error);
        }
        let response = tokio::time::timeout(PI_RPC_REQUEST_TIMEOUT, async {
            loop {
                let value = session.next_record().await?;
                if value.get("id").and_then(Value::as_str) == Some(&request_id)
                    && value.get("type").and_then(Value::as_str) == Some("response")
                {
                    return Ok::<Value, String>(value);
                }
            }
        })
        .await;
        let value = match response {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => {
                drop(_operation);
                self.remove_session_if_same(thread_id, &session).await;
                return Err(error);
            }
            Err(_) => {
                drop(_operation);
                self.remove_session_if_same(thread_id, &session).await;
                return Err("Pi history read timed out waiting for an RPC response".into());
            }
        };
        if value.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Pi could not read this session")
                .to_string());
        }
        session.touch();
        let mut messages = value
            .pointer("/data/messages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let (entries, leaf_id) = match session.session_entries().await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                drop(_operation);
                self.shutdown_and_remove_session_if_same(thread_id, &session)
                    .await;
                return Err(error);
            }
        };
        attach_pi_session_message_ids(&mut messages, &entries, leaf_id.as_deref())?;
        // Keep original Pi block positions even when thinking is hidden.
        for (sequence, message) in messages.iter_mut().enumerate() {
            if let Some(object) = message.as_object_mut() {
                object.insert("_pi_history_sequence".into(), serde_json::json!(sequence));
            }
            if let Some(blocks) = message.get_mut("content").and_then(Value::as_array_mut) {
                for (index, block) in blocks.iter_mut().enumerate() {
                    if let Some(object) = block.as_object_mut() {
                        object.insert("_pi_content_index".into(), serde_json::json!(index));
                    }
                }
            }
        }
        if !pi_forward_thinking_enabled() {
            for message in &mut messages {
                if message.get("role").and_then(Value::as_str) != Some("assistant") {
                    continue;
                }
                if let Some(blocks) = message.get_mut("content").and_then(Value::as_array_mut) {
                    blocks.retain(|block| {
                        block.get("type").and_then(Value::as_str) != Some("thinking")
                    });
                }
            }
        }
        let native_session_id = session.session_id.lock().await.clone();
        Ok(PiSessionSnapshot {
            messages,
            revision: PiHistoryRevision {
                session_id: native_session_id,
                append_cursor: entries
                    .last()
                    .and_then(|entry| entry.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                leaf_id,
            },
        })
    }

    pub async fn supported_models(&self, app: &tauri::AppHandle) -> Result<Vec<String>, String> {
        let config_dir = pi_config_dir()?;
        std::fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
        let mut command = Command::new(resolve_pi_binary(app)?);
        command
            .args(["--mode", "rpc", "--no-session"])
            .kill_on_drop(true)
            .current_dir(std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
            .env("PI_CODING_AGENT_DIR", config_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        crate::process_window::hide_command_window(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start Pi model catalog: {error}"))?;
        let stdin = Arc::new(Mutex::new(
            child.stdin.take().ok_or("Pi catalog stdin unavailable")?,
        ));
        let stdout = child.stdout.take().ok_or("Pi catalog stdout unavailable")?;
        write_rpc(
            &stdin,
            &serde_json::json!({"id":"flowix-models","type":"get_available_models"}),
        )
        .await?;
        let mut reader = BufReader::new(stdout);
        let mut models = Vec::new();
        let response = tokio::time::timeout(PI_RPC_REQUEST_TIMEOUT, async {
            loop {
                let value = read_pi_rpc_record(&mut reader)
                    .await
                    .map_err(|error| format!("Pi model catalog read failed: {error}"))?
                    .ok_or("Pi closed before returning its model catalog")?;
                if value.get("id").and_then(Value::as_str) != Some("flowix-models") {
                    continue;
                }
                if value.get("success").and_then(Value::as_bool) != Some(true) {
                    return Err(value
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Pi model catalog failed")
                        .to_string());
                }
                if let Some(entries) = value
                    .get("data")
                    .and_then(|data| data.get("models"))
                    .and_then(Value::as_array)
                {
                    for model in entries {
                        let provider = model
                            .get("provider")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let id = model.get("id").and_then(Value::as_str).unwrap_or_default();
                        if !provider.is_empty() && !id.is_empty() {
                            models.push(format!("{provider}::{id}"));
                        }
                    }
                }
                return Ok::<(), String>(());
            }
        })
        .await;
        let _ = child.kill().await;
        match response {
            Ok(result) => result?,
            Err(_) => return Err("Pi model catalog did not respond within 15 seconds".into()),
        }
        Ok(models)
    }

    pub async fn chat_stream(
        self: &Arc<Self>,
        thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, String> {
        let thread_id = thread_id.to_string();
        let run_id = resolve_run_id(&thread_id, message.run_id.as_deref());
        let started_at = chrono::Utc::now().timestamp_millis();
        let active = Arc::new(ActivePiRun {
            run_id: run_id.clone(),
            started_at,
            session: Mutex::new(None),
            session_id: Mutex::new(None),
            stop_notify: tokio::sync::Notify::new(),
            last_event_at: AtomicI64::new(started_at),
            stop_reason: Mutex::new(None),
            finalizing: AtomicBool::new(false),
            stream_end_emitted: Arc::new(AtomicBool::new(false)),
        });
        {
            let mut active_runs = self.active_runs.lock().await;
            if active_runs.contains_key(&thread_id) {
                return Err("Pi is already running for this conversation".into());
            }
            active_runs.insert(thread_id.clone(), active.clone());
        }
        let manager = self.clone();
        let app = app_handle.clone();
        tokio::spawn(async move {
            manager
                .emit_stream_start(&app, &thread_id, &message, &run_id)
                .await;
            let result = manager
                .run_turn(&thread_id, &run_id, message, &app, active.clone())
                .await;
            manager
                .finish_run(&app, &thread_id, &run_id, active, result)
                .await;
        });
        Ok(String::new())
    }

    async fn finish_run(
        &self,
        app: &tauri::AppHandle,
        thread_id: &str,
        run_id: &str,
        active: Arc<ActivePiRun>,
        result: Result<(), String>,
    ) {
        if active.finalizing.swap(true, Ordering::AcqRel) {
            return;
        }
        let stop_reason = active.stop_reason.lock().await.clone();
        let error = match stop_reason.as_deref() {
            Some(USER_STOPPED_REASON) => None,
            Some(reason) if reason.starts_with("watchdog_idle_timeout_ms=") => {
                Some(reason.to_string())
            }
            _ => result.as_ref().err().cloned(),
        };
        if let Some(error) = error.as_ref() {
            self.emit_run_error(app, thread_id, error.clone(), run_id)
                .await;
        }
        let reason = stop_reason.or_else(|| result.err());
        {
            let mut active_runs = self.active_runs.lock().await;
            if active_runs
                .get(thread_id)
                .is_some_and(|current| current.run_id == run_id)
            {
                active_runs.remove(thread_id);
            }
        }
        self.emit_stream_end(app, thread_id, run_id, reason, &active.stream_end_emitted)
            .await;
    }

    async fn run_turn(
        &self,
        thread_id: &str,
        run_id: &str,
        message: AgentUserMessage,
        app: &tauri::AppHandle,
        active: Arc<ActivePiRun>,
    ) -> Result<(), String> {
        if active.stop_reason.lock().await.is_some() {
            return Ok(());
        }
        let cwd = resolve_and_freeze_runtime_cwd(
            &self.thread_manager,
            thread_id,
            |message, _| message.cwd_for_runtime(AGENT_TYPE).map(PathBuf::from),
            &message,
            None,
            None,
        )
        .await?;
        let runtime_model = message.model_for_runtime(AGENT_TYPE).map(str::to_owned);
        let provider = message
            .provider_id_for_runtime(AGENT_TYPE)
            .map(str::to_owned);
        let permission_mode = message.permission_mode_for_runtime(AGENT_TYPE);
        let runtime_model =
            runtime_model.filter(|value| !value.trim().is_empty() && value != "inherit");
        let thinking = message
            .reasoning_effort_for_runtime(AGENT_TYPE)
            .filter(|value| {
                matches!(
                    *value,
                    "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
                )
            })
            .map(str::to_owned);
        let config = PiSessionConfig {
            cwd: cwd.clone(),
            tools: pi_tools_for_permission_mode(permission_mode).into(),
            code_mode: super::config::features()?.code_mode,
            tool_search: super::config::features()?.tool_search,
            provider: provider.clone().filter(|value| !value.trim().is_empty()),
            model: runtime_model.clone(),
            thinking,
        };
        let session = self.ensure_session(app, thread_id, config, false).await?;
        *active.session.lock().await = Some(session.clone());
        let session_id = session.session_id.lock().await.clone();
        *active.session_id.lock().await = Some(session_id.clone());
        active
            .last_event_at
            .store(chrono::Utc::now().timestamp_millis(), Ordering::Relaxed);
        session.touch();
        let mut operation = Some(self.lock_session_operation(thread_id, &session).await?);
        if active.stop_reason.lock().await.is_some() {
            session.touch();
            return Ok(());
        }

        let base_prompt = message
            .llm_content
            .clone()
            .unwrap_or_else(|| message.content.clone());
        let workspace_paths = message.workspace_paths_for_runtime(AGENT_TYPE);
        let mut prompt =
            super::super::append_workspace_context(&base_prompt, &cwd, &workspace_paths);
        let attachments = message.message_attachments();
        let mut images = Vec::new();
        let mut attached_files = Vec::new();
        for attachment in attachments {
            if attachment.r#type == "input_image" {
                let bytes = match tokio::fs::read(&attachment.path).await {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        return Err(format!(
                            "cannot read attached image {}: {error}",
                            attachment.name
                        ));
                    }
                };
                images.push(serde_json::json!({
                    "type": "image",
                    "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                    "mimeType": attachment.mime_type,
                }));
            } else {
                attached_files.push(attachment.path);
            }
        }
        if !attached_files.is_empty() {
            let paths = attached_files
                .iter()
                .map(|path| format!("- {path}"))
                .collect::<Vec<_>>()
                .join("\n");
            prompt.push_str(&format!("\n\n<attached_files>\n{paths}\n</attached_files>"));
        }
        let prompt_id = format!("flowix-prompt-{run_id}");
        let mut prompt_command = serde_json::json!({
            "id": prompt_id,
            "type": "prompt",
            "message": prompt,
        });
        if !images.is_empty() {
            prompt_command["images"] = Value::Array(images);
        }
        match session
            .write_prompt_if_running(&active, &prompt_command)
            .await
        {
            Ok(true) => {}
            Ok(false) => {
                session.touch();
                return Ok(());
            }
            Err(error) => {
                drop(operation.take());
                self.remove_session_if_same(thread_id, &session).await;
                return Err(error);
            }
        }
        let mut settled = false;
        let mut sequence = 0_u64;
        let mut latest_usage = None;
        let mut stop_settle_deadline = None;
        loop {
            let next_record = if let Some(deadline) = stop_settle_deadline {
                match tokio::time::timeout_at(deadline, session.next_record()).await {
                    Ok(result) => result,
                    Err(_) => {
                        self.shutdown_and_remove_session_if_same(thread_id, &session)
                            .await;
                        drop(operation.take());
                        return Err(
                            "Pi did not settle after Stop; its RPC process was restarted".into(),
                        );
                    }
                }
            } else {
                tokio::select! {
                    result = session.next_record() => result,
                    _ = active.stop_notify.notified() => {
                        stop_settle_deadline = Some(
                            tokio::time::Instant::now() + PI_ABORT_SETTLE_TIMEOUT,
                        );
                        continue;
                    }
                }
            };
            let value = match next_record {
                Ok(value) => value,
                Err(error) => {
                    drop(operation.take());
                    self.remove_session_if_same(thread_id, &session).await;
                    let stderr = session.stderr_text().await;
                    return Err(if stderr.trim().is_empty() {
                        error
                    } else {
                        format!(
                            "{error}: {}",
                            crate::agent_external::truncate_for_log(stderr.trim())
                        )
                    });
                }
            };
            session.touch();
            active
                .last_event_at
                .store(chrono::Utc::now().timestamp_millis(), Ordering::Relaxed);
            if value.get("type").and_then(Value::as_str) == Some("agent_settled") {
                settled = true;
                break;
            }
            let mut prompt_handled = false;
            if value.get("type").and_then(Value::as_str) == Some("response")
                && value.get("id").and_then(Value::as_str) == Some(&prompt_id)
            {
                if value.get("success").and_then(Value::as_bool) == Some(false) {
                    return Err(value
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Pi rejected the prompt")
                        .to_string());
                }
                if value.pointer("/data/disposition").and_then(Value::as_str) == Some("handled") {
                    // Extension commands can handle a prompt without starting
                    // an agent run. The RPC process remains ready for reuse.
                    settled = true;
                    prompt_handled = true;
                }
            }
            if prompt_handled {
                break;
            }
            if active.finalizing.load(Ordering::Acquire) {
                continue;
            }
            if value.get("type").and_then(Value::as_str) == Some("message_update") {
                if let Some(event) = value.get("assistantMessageEvent") {
                    sequence += 1;
                    self.project_message_update(app, thread_id, run_id, sequence, event)
                        .await;
                }
                if let Some(usage) = value.get("usage") {
                    let usage = UsageInfo {
                        input_tokens: usage.get("input").and_then(Value::as_u64).map(|v| v as u32),
                        cached_input_tokens: usage
                            .get("cacheRead")
                            .and_then(Value::as_u64)
                            .map(|v| v as u32),
                        output_tokens: usage
                            .get("output")
                            .and_then(Value::as_u64)
                            .map(|v| v as u32),
                        reasoning_output_tokens: None,
                        total_tokens: usage
                            .get("totalTokens")
                            .and_then(Value::as_u64)
                            .map(|v| v as u32),
                        model_context_window: None,
                        context_used_tokens: None,
                    };
                    latest_usage = Some(usage);
                }
            } else if value.get("type").and_then(Value::as_str) == Some("tool_execution_start") {
                let Some(tool_call_id) = value
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                else {
                    continue;
                };
                sequence += 1;
                let chunk = AgentChunk::ToolCall {
                    thread_id: thread_id.to_string(),
                    id: tool_call_id.to_string(),
                    name: value
                        .get("toolName")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string(),
                    input: value.get("args").cloned().unwrap_or(Value::Null),
                };
                self.emit_event(app, &chunk, run_id, sequence, None, None, None)
                    .await;
            } else if value.get("type").and_then(Value::as_str) == Some("tool_execution_end") {
                let Some(tool_call_id) = value
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                else {
                    continue;
                };
                sequence += 1;
                let chunk = AgentChunk::ToolResult {
                    thread_id: thread_id.to_string(),
                    id: tool_call_id.to_string(),
                    name: value
                        .get("toolName")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string(),
                    result: value.get("result").cloned().unwrap_or(Value::Null),
                };
                self.emit_event(app, &chunk, run_id, sequence, None, None, None)
                    .await;
            }
            if value.get("type").and_then(Value::as_str) == Some("message_end") {
                if let Some(completed_message) = value.get("message") {
                    if !matches!(
                        completed_message.get("role").and_then(Value::as_str),
                        Some("user" | "assistant")
                    ) {
                        continue;
                    }
                    sequence += 1;
                    let (_entries, leaf_id) = match session.session_entries().await {
                        Ok(snapshot) => snapshot,
                        Err(error) => {
                            drop(operation.take());
                            self.shutdown_and_remove_session_if_same(thread_id, &session)
                                .await;
                            return Err(error);
                        }
                    };
                    let message_id = match session
                        .entries_cache
                        .lock()
                        .await
                        .message_id(leaf_id.as_deref(), completed_message)
                    {
                        Ok(id) => id,
                        Err(error) => {
                            drop(operation.take());
                            self.shutdown_and_remove_session_if_same(thread_id, &session)
                                .await;
                            return Err(error);
                        }
                    };
                    self.project_completed_message(
                        app,
                        thread_id,
                        &message_id,
                        run_id,
                        sequence,
                        completed_message,
                        &message,
                    )
                    .await?;
                }
            }
        }
        if settled {
            if !active.finalizing.load(Ordering::Acquire) {
                if let Some(usage) = latest_usage {
                    sequence += 1;
                    let chunk = AgentChunk::Usage {
                        thread_id: thread_id.to_string(),
                        model_id: runtime_model.as_ref().map(|model| {
                            provider
                                .as_ref()
                                .map(|provider| format!("{provider}/{model}"))
                                .unwrap_or_else(|| model.clone())
                        }),
                        last_run_at: Some(chrono::Utc::now().timestamp_millis()),
                        usage: Some(usage),
                        status_info: None,
                    };
                    self.emit_event(app, &chunk, run_id, sequence, None, None, None)
                        .await;
                }
            }
            session.touch();
            return Ok(());
        }
        session.touch();
        Ok(())
    }

    async fn project_message_update(
        &self,
        app: &tauri::AppHandle,
        thread_id: &str,
        run_id: &str,
        sequence: u64,
        event: &Value,
    ) {
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !pi_forward_thinking_enabled() && matches!(kind, "thinking_delta" | "thinking_end") {
            return;
        }
        let delta = event
            .get("delta")
            .and_then(Value::as_str)
            .or_else(|| event.get("content").and_then(Value::as_str))
            .unwrap_or_default();
        let (chunk, phase, mode) = match kind {
            "text_delta" if !delta.is_empty() => (
                Some(AgentChunk::Text {
                    thread_id: thread_id.to_string(),
                    text: delta.to_string(),
                }),
                None,
                Some("delta"),
            ),
            "text_end" if !delta.is_empty() => (
                Some(AgentChunk::Text {
                    thread_id: thread_id.to_string(),
                    text: delta.to_string(),
                }),
                Some("updated"),
                Some("snapshot"),
            ),
            "thinking_delta" if !delta.is_empty() => (
                Some(AgentChunk::Reasoning {
                    thread_id: thread_id.to_string(),
                    text: delta.to_string(),
                }),
                None,
                Some("delta"),
            ),
            "thinking_end" if !delta.is_empty() => (
                Some(AgentChunk::Reasoning {
                    thread_id: thread_id.to_string(),
                    text: delta.to_string(),
                }),
                Some("updated"),
                Some("snapshot"),
            ),
            // Tool calls are emitted with the completed assistant message
            // below. That preserves the native parent entry id and lets the
            // final text snapshot adopt its streaming draft before a tool row
            // creates the next stream boundary. tool_execution_start then
            // enriches that same row by its native toolCallId.
            _ => (None, None, None),
        };
        if let Some(chunk) = chunk {
            self.emit_event_with_metadata(
                app,
                &chunk,
                run_id,
                AgentChunkMetadata {
                    source_sequence: Some(sequence),
                    source_subsequence: event
                        .get("contentIndex")
                        .and_then(Value::as_u64)
                        .and_then(|index| u32::try_from(index).ok()),
                    message_phase: phase,
                    content_mode: mode,
                    ..AgentChunkMetadata::default()
                },
            )
            .await;
        }
    }

    async fn project_completed_message(
        &self,
        app: &tauri::AppHandle,
        thread_id: &str,
        message_id: &str,
        run_id: &str,
        sequence: u64,
        message: &Value,
        user_message: &AgentUserMessage,
    ) -> Result<(), String> {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(role, "user" | "assistant") {
            return Ok(());
        }
        let source_timestamp = message
            .get("timestamp")
            .and_then(Value::as_i64)
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
        if role == "user" {
            let user_chunk = AgentChunk::UserMessage {
                thread_id: thread_id.to_string(),
                id: message_id.to_string(),
                text: user_message
                    .llm_content
                    .clone()
                    .unwrap_or_else(|| user_message.content.clone()),
                timestamp: source_timestamp,
                attachments: user_message.message_attachments(),
            };
            self.emit_event_with_metadata(
                app,
                &user_chunk,
                run_id,
                AgentChunkMetadata {
                    source_sequence: Some(sequence),
                    source_subsequence: Some(0),
                    source_timestamp: Some(source_timestamp),
                    message_phase: Some("completed"),
                    content_mode: Some("snapshot"),
                    ..AgentChunkMetadata::default()
                },
            )
            .await;
            return Ok(());
        }

        enum SnapshotBlock {
            Text(String),
            Reasoning(String),
            ToolCall {
                id: String,
                name: String,
                input: Value,
            },
        }
        let Some(blocks) = message.get("content").and_then(Value::as_array) else {
            let text = message
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let error_message = message
                .get("errorMessage")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let text = match (text.is_empty(), error_message.is_empty()) {
                (true, true) => None,
                (false, true) => Some(text.to_string()),
                (true, false) => Some(error_message.to_string()),
                (false, false) => Some(format!("{text}\n\n{error_message}")),
            };
            if let Some(text) = text {
                let chunk = AgentChunk::Text {
                    thread_id: thread_id.to_string(),
                    text,
                };
                self.emit_native_message_event(
                    app,
                    &chunk,
                    run_id,
                    sequence,
                    Some("completed"),
                    Some("snapshot"),
                    Some(&message_id),
                    source_timestamp,
                    Some(0),
                    None,
                )
                .await;
            }
            return Ok(());
        };

        let mut projected = Vec::<(usize, SnapshotBlock)>::new();
        let mut text_index: Option<usize> = None;
        for (block_index, block) in blocks.iter().enumerate() {
            let block_type = block.get("type").and_then(Value::as_str);
            if !pi_forward_thinking_enabled() && block_type == Some("thinking") {
                continue;
            }
            if block_type == Some("toolCall") {
                let Some(id) = block
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                else {
                    continue;
                };
                projected.push((
                    block_index,
                    SnapshotBlock::ToolCall {
                        id: id.to_string(),
                        name: block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string(),
                        input: block.get("arguments").cloned().unwrap_or(Value::Null),
                    },
                ));
                continue;
            }
            let text = match block_type {
                Some("text") => block.get("text").and_then(Value::as_str),
                Some("thinking") => block.get("thinking").and_then(Value::as_str),
                _ => None,
            };
            let Some(text) = text else { continue };
            if block_type == Some("thinking") {
                projected.push((block_index, SnapshotBlock::Reasoning(text.to_string())));
            } else {
                text_index = Some(projected.len());
                projected.push((block_index, SnapshotBlock::Text(text.to_string())));
            }
        }
        if let Some(error_message) = message
            .get("errorMessage")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            if let Some(index) = text_index.filter(|index| *index + 1 == projected.len()) {
                if let SnapshotBlock::Text(text) = &mut projected[index].1 {
                    if !text.is_empty() {
                        text.push_str("\n\n");
                    }
                    text.push_str(error_message);
                }
            } else {
                projected.push((blocks.len(), SnapshotBlock::Text(error_message.to_string())));
            }
        }
        for (block_index, block) in projected {
            let source_subsequence = Some(u32::try_from(block_index).unwrap_or(u32::MAX));
            match block {
                SnapshotBlock::Text(text) => {
                    let chunk = AgentChunk::Text {
                        thread_id: thread_id.to_string(),
                        text,
                    };
                    self.emit_native_message_event(
                        app,
                        &chunk,
                        run_id,
                        sequence,
                        Some("completed"),
                        Some("snapshot"),
                        Some(&message_id),
                        source_timestamp,
                        source_subsequence,
                        None,
                    )
                    .await;
                }
                SnapshotBlock::Reasoning(text) => {
                    let chunk = AgentChunk::Reasoning {
                        thread_id: thread_id.to_string(),
                        text,
                    };
                    self.emit_native_message_event(
                        app,
                        &chunk,
                        run_id,
                        sequence,
                        Some("completed"),
                        Some("snapshot"),
                        Some(&message_id),
                        source_timestamp,
                        source_subsequence,
                        None,
                    )
                    .await;
                }
                SnapshotBlock::ToolCall { id, name, input } => {
                    let chunk = AgentChunk::ToolCall {
                        thread_id: thread_id.to_string(),
                        id,
                        name,
                        input,
                    };
                    self.emit_native_message_event(
                        app,
                        &chunk,
                        run_id,
                        sequence,
                        Some("completed"),
                        Some("snapshot"),
                        None,
                        source_timestamp,
                        source_subsequence,
                        Some(&message_id),
                    )
                    .await;
                }
            }
        }
        Ok(())
    }

    async fn emit_event(
        &self,
        app: &tauri::AppHandle,
        chunk: &AgentChunk,
        run_id: &str,
        sequence: u64,
        phase: Option<&'static str>,
        content_mode: Option<&'static str>,
        message_id: Option<&str>,
    ) {
        let metadata = AgentChunkMetadata {
            source_sequence: Some(sequence),
            source_timestamp: Some(chrono::Utc::now().timestamp_millis()),
            message_phase: phase,
            content_mode,
            message_id: message_id.map(str::to_string),
            ..AgentChunkMetadata::default()
        };
        self.emit_event_with_metadata(app, chunk, run_id, metadata)
            .await;
    }

    async fn emit_native_message_event(
        &self,
        app: &tauri::AppHandle,
        chunk: &AgentChunk,
        run_id: &str,
        sequence: u64,
        phase: Option<&'static str>,
        content_mode: Option<&'static str>,
        message_id: Option<&str>,
        source_timestamp: i64,
        source_subsequence: Option<u32>,
        parent_message_id: Option<&str>,
    ) {
        let metadata = AgentChunkMetadata {
            source_sequence: Some(sequence),
            source_timestamp: Some(source_timestamp),
            message_phase: phase,
            content_mode,
            message_id: message_id.map(str::to_string),
            parent_message_id: parent_message_id.map(str::to_string),
            source_subsequence,
            ..AgentChunkMetadata::default()
        };
        self.emit_event_with_metadata(app, chunk, run_id, metadata)
            .await;
    }

    async fn emit_event_with_metadata(
        &self,
        app: &tauri::AppHandle,
        chunk: &AgentChunk,
        run_id: &str,
        metadata: AgentChunkMetadata,
    ) {
        crate::agent_external::shared::persist_and_emit_external_chunk_with_metadata(
            app,
            &self.thread_manager,
            AGENT_TYPE,
            chunk,
            run_id,
            None,
            &metadata,
        )
        .await;
    }

    pub async fn stop_chat(
        &self,
        thread_id: &str,
        run_id: Option<&str>,
        app: &tauri::AppHandle,
    ) -> bool {
        let active = self.active_runs.lock().await.get(thread_id).cloned();
        let Some(active) = active else {
            return false;
        };
        if run_id.is_some_and(|expected| expected != active.run_id) {
            return false;
        }
        // The active run owns its session handle, so contention in another
        // conversation cannot prevent Stop from reaching this Pi process.
        // `None` means startup has not assigned a process yet; run_turn checks
        // stop_reason before it can write the prompt.
        let session = active.session.lock().await.clone();
        if let Some(session) = session {
            // Serialize Stop and prompt writes on stdin. Keeping this lock
            // until both abort commands are written guarantees that a prompt
            // for a subsequent run cannot be aborted by this Stop request.
            let mut stdin = session.stdin.lock().await;
            let active_runs = self.active_runs.lock().await;
            if !active_runs
                .get(thread_id)
                .is_some_and(|current| Arc::ptr_eq(current, &active))
            {
                return false;
            }
            *active.stop_reason.lock().await = Some(USER_STOPPED_REASON.to_string());
            active.stop_notify.notify_one();
            drop(active_runs);
            // Pi's abort command continues queued messages. Clear any queued
            // extension follow-ups first so Stop ends this conversation turn.
            let clear_result =
                write_rpc_locked(&mut stdin, &serde_json::json!({"type":"clear_queue"})).await;
            let abort_result =
                write_rpc_locked(&mut stdin, &serde_json::json!({"type":"abort"})).await;
            drop(stdin);
            if clear_result.is_err() || abort_result.is_err() {
                self.remove_session_if_same(thread_id, &session).await;
            }
        } else {
            let active_runs = self.active_runs.lock().await;
            if !active_runs
                .get(thread_id)
                .is_some_and(|current| Arc::ptr_eq(current, &active))
            {
                return false;
            }
            *active.stop_reason.lock().await = Some(USER_STOPPED_REASON.to_string());
            active.stop_notify.notify_one();
        }
        let active_run_id = active.run_id.clone();
        self.finish_run(app, thread_id, &active_run_id, active, Ok(()))
            .await;
        true
    }

    pub async fn running_threads(&self) -> HashMap<String, RunInfo> {
        let active_runs = self
            .active_runs
            .lock()
            .await
            .iter()
            .map(|(thread_id, active)| (thread_id.clone(), active.clone()))
            .collect::<Vec<_>>();
        let mut running = HashMap::with_capacity(active_runs.len());
        for (thread_id, active) in active_runs {
            let session_id = active.session_id.lock().await.clone();
            running.insert(
                thread_id.clone(),
                RunInfo::active(
                    active.started_at,
                    Some("Pi RPC"),
                    Some(AGENT_TYPE),
                    Some(active.run_id.clone()),
                    Some(thread_id),
                    session_id,
                ),
            );
        }
        running
    }
    pub async fn stop_all(&self) -> usize {
        self.shutting_down.store(true, Ordering::Release);
        // Use the same map lock order as startup promotion. The shutdown flag
        // prevents any later session registration or promotion.
        let mut sessions_map = self.sessions.lock().await;
        let mut starting_map = self.starting_sessions.lock().await;
        let mut sessions = std::mem::take(&mut *sessions_map);
        sessions.extend(std::mem::take(&mut *starting_map));
        drop(starting_map);
        drop(sessions_map);
        self.active_runs.lock().await.clear();
        let count = sessions.len();
        futures::future::join_all(sessions.into_iter().map(|(thread_id, session)| async move {
            session.shutdown(&thread_id).await;
        }))
        .await;
        count
    }
    pub async fn reap_inactive_runs(&self, app: &tauri::AppHandle, idle_timeout_ms: i64) -> usize {
        let now = chrono::Utc::now().timestamp_millis();
        let stale_runs = self
            .active_runs
            .lock()
            .await
            .iter()
            .filter(|(_, active)| {
                idle_timeout_ms > 0
                    && now.saturating_sub(active.last_event_at.load(Ordering::Relaxed))
                        >= idle_timeout_ms
            })
            .map(|(thread_id, active)| (thread_id.clone(), active.clone()))
            .collect::<Vec<_>>();
        for (thread_id, active) in &stale_runs {
            let reason = format!("watchdog_idle_timeout_ms={idle_timeout_ms}");
            *active.stop_reason.lock().await = Some(reason.clone());
            let session = { active.session.lock().await.clone() };
            if let Some(session) = session {
                self.remove_session_if_same(thread_id, &session).await;
            }
            self.finish_run(app, thread_id, &active.run_id, active.clone(), Err(reason))
                .await;
        }

        let active_ids = self
            .active_runs
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        let idle_sessions = self
            .sessions
            .lock()
            .await
            .iter()
            .filter(|(thread_id, session)| {
                !active_ids.contains(*thread_id)
                    && now.saturating_sub(session.last_used_at.load(Ordering::Relaxed))
                        >= PI_IDLE_SESSION_TTL_MS
            })
            .map(|(thread_id, session)| (thread_id.clone(), session.clone()))
            .collect::<Vec<_>>();
        for (thread_id, session) in idle_sessions {
            self.remove_idle_session_if_same(&thread_id, &session).await;
        }
        stale_runs.len()
    }
}

async fn request_pi_state(session: &PiSession) -> Result<Value, String> {
    let request_id = format!("flowix-state-{}", chrono::Utc::now().timestamp_millis());
    let response = tokio::time::timeout(PI_RPC_REQUEST_TIMEOUT, async {
        session
            .write(&serde_json::json!({"id":request_id,"type":"get_state"}))
            .await?;
        loop {
            let value = session.next_record().await?;
            if value.get("id").and_then(Value::as_str) == Some(request_id.as_str())
                && value.get("type").and_then(Value::as_str) == Some("response")
            {
                return Ok::<Value, String>(value);
            }
        }
    })
    .await
    .map_err(|_| "Pi did not respond to get_state within 15 seconds".to_string())??;
    if response.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Pi could not report session state")
            .to_string());
    }
    response
        .get("data")
        .cloned()
        .ok_or_else(|| "Pi state response did not include data".to_string())
}

async fn write_rpc(stdin: &Arc<Mutex<ChildStdin>>, value: &Value) -> Result<(), String> {
    let mut stdin = stdin.lock().await;
    write_rpc_locked(&mut stdin, value).await
}

async fn write_rpc_locked(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    stdin
        .write_all(&bytes)
        .await
        .map_err(|error| format!("Pi RPC stdin write failed: {error}"))
}

pub(super) fn pi_config_dir() -> Result<PathBuf, String> {
    if let Some(path) = dirs::config_dir() {
        return Ok(path.join("Flowix").join("pi"));
    }
    dirs::home_dir()
        .map(|path| path.join(".flowix").join("pi"))
        .ok_or_else(|| "user config directory is unavailable".to_string())
}

fn pi_session_dir(thread_id: &str) -> Result<PathBuf, String> {
    let root = pi_session_root()?;
    let digest = Sha256::digest(thread_id.as_bytes());
    let stable_name = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(root.join(stable_name))
}

fn legacy_pi_session_dir(thread_id: &str) -> Result<PathBuf, String> {
    let root = pi_session_root()?;
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    thread_id.hash(&mut hasher);
    Ok(root.join(format!("{:016x}", hasher.finish())))
}

fn pi_session_root() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .map(|path| path.join("Flowix").join("pi-sessions"))
        .ok_or_else(|| "user data directory is unavailable".to_string())
}

fn resolve_pi_session_dir(thread_id: &str, create: bool) -> Result<PathBuf, String> {
    let stable = pi_session_dir(thread_id)?;
    let legacy = legacy_pi_session_dir(thread_id)?;
    if !stable.exists() && legacy.exists() {
        std::fs::create_dir_all(stable.parent().ok_or("Pi session path has no parent")?)
            .map_err(|error| format!("cannot create Pi session directory: {error}"))?;
        match std::fs::rename(&legacy, &stable) {
            Ok(()) => {}
            Err(_) if stable.exists() => {}
            Err(error) => {
                return Err(format!(
                    "could not migrate Pi conversation session: {error}"
                ));
            }
        }
    }
    if create {
        std::fs::create_dir_all(&stable)
            .map_err(|error| format!("cannot create Pi session directory: {error}"))?;
    }
    Ok(stable)
}

/// The sole receiver owner preserves every agent event while waiting for RPC.
async fn receive_rpc_response(
    records: &mut mpsc::UnboundedReceiver<Result<Value, String>>,
    deferred: &mut VecDeque<Value>,
    request_id: &str,
) -> Result<Value, String> {
    loop {
        let record = records.recv().await.ok_or("Pi RPC event reader closed")??;
        if record.get("type").and_then(Value::as_str) == Some("response")
            && record.get("id").and_then(Value::as_str) == Some(request_id)
        {
            return Ok(record);
        }
        deferred.push_back(record);
    }
}

fn pi_message_matches(left: &Value, right: &Value) -> bool {
    left == right
}

#[cfg(test)]
fn pi_rpc_message_id(
    entries: &[Value],
    leaf_id: Option<&str>,
    message: &Value,
) -> Result<String, String> {
    pi_active_branch_entries(entries, leaf_id)?.into_iter().rev()
        .find(|entry| entry.get("type").and_then(Value::as_str) == Some("message")
            && entry.get("message").is_some_and(|saved| pi_message_matches(saved, message)))
        .and_then(|entry| entry.get("id").and_then(Value::as_str).map(str::to_owned))
        .ok_or_else(|| "Pi completed a message without a matching native entry on the active RPC session branch".into())
}

fn pi_active_branch_entries<'a>(
    entries: &'a [Value],
    leaf_id: Option<&str>,
) -> Result<Vec<&'a Value>, String> {
    let Some(mut current_id) = leaf_id.map(str::to_owned) else {
        return if entries.is_empty() {
            Ok(Vec::new())
        } else {
            Err("Pi returned session entries without a current leaf id".into())
        };
    };
    let by_id = entries
        .iter()
        .filter_map(|entry| Some((entry.get("id")?.as_str()?, entry)))
        .collect::<HashMap<_, _>>();
    let mut branch = Vec::new();
    let mut visited = std::collections::HashSet::new();
    loop {
        if !visited.insert(current_id.clone()) {
            return Err("Pi returned a cycle in the active session branch".into());
        }
        let entry = by_id
            .get(current_id.as_str())
            .copied()
            .ok_or_else(|| "Pi active session leaf references a missing entry".to_string())?;
        let parent_id = entry
            .get("parentId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        branch.push(entry);
        let Some(parent_id) = parent_id else { break };
        current_id = parent_id;
    }
    branch.reverse();
    Ok(branch)
}

fn attach_pi_session_message_ids(
    messages: &mut [Value],
    entries: &[Value],
    leaf_id: Option<&str>,
) -> Result<(), String> {
    let branch = pi_active_branch_entries(entries, leaf_id)?;
    let mut entry_index = 0;
    let mut unmatched_renderable_messages = 0;
    for message in messages {
        let matched_index = branch[entry_index..].iter().position(|entry| {
            entry.get("type").and_then(Value::as_str) == Some("message")
                && entry
                    .get("message")
                    .is_some_and(|saved| pi_message_matches(saved, message))
        });
        let Some(relative_index) = matched_index else {
            if matches!(
                message.get("role").and_then(Value::as_str),
                Some(
                    "user"
                        | "assistant"
                        | "bashExecution"
                        | "custom"
                        | "branchSummary"
                        | "compactionSummary"
                )
            ) {
                unmatched_renderable_messages += 1;
            }
            continue;
        };
        entry_index += relative_index;
        let entry = branch[entry_index];
        entry_index += 1;
        if let Some(object) = message.as_object_mut() {
            if let Some(id) = entry.get("id").and_then(Value::as_str) {
                object.insert("_pi_session_message_id".into(), Value::String(id.into()));
            }
            if let Some(parent_id) = entry.get("parentId").and_then(Value::as_str) {
                object.insert(
                    "_pi_session_parent_id".into(),
                    Value::String(parent_id.into()),
                );
            }
        }
    }
    if unmatched_renderable_messages > 0 {
        return Err(format!(
            "Pi returned {unmatched_renderable_messages} history messages that could not be reconciled with native ids on the active session branch"
        ));
    }
    Ok(())
}

fn resolve_pi_binary(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("PI_CLI_PATH") {
        let candidate = PathBuf::from(value);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    #[cfg(target_os = "macos")]
    let platform = "darwin";
    #[cfg(target_os = "windows")]
    let platform = "windows";
    #[cfg(target_os = "linux")]
    let platform = "linux";
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    if let Ok(resources) = app.path().resource_dir() {
        let name = if cfg!(windows) { "pi.exe" } else { "pi" };
        let bundled_root = resources.join("pi").join(format!("{platform}-{arch}"));
        let bundled_candidates = [
            bundled_root.join("dist").join(name),
            bundled_root.join(name),
        ];
        if let Some(bundled) = bundled_candidates
            .into_iter()
            .find(|candidate| candidate.is_file())
        {
            return Ok(bundled);
        }
    }
    if let Some(path) = crate::agent_external::cli_resolver::which_in_path(
        if cfg!(windows) { "pi.exe" } else { "pi" },
        std::env::var_os("PATH").as_deref(),
    ) {
        return Ok(path);
    }
    if let Some(path) = installed_flowix_pi_binary() {
        return Ok(path);
    }
    Ok(
        crate::agent_external::cli_resolver::resolve_external_cli_uncached(
            &crate::agent_external::cli_resolver::ExternalCliSpec {
                binary_name: "pi",
                #[cfg(windows)]
                windows_binary_name: "pi.exe",
                env_vars: &["PI_CLI_PATH"],
                extra_unix_candidates: crate::agent_external::cli_resolver::no_extra_candidates,
                #[cfg(windows)]
                extra_windows_candidates: crate::agent_external::cli_resolver::no_extra_candidates,
            },
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::{
        attach_pi_session_message_ids, pi_active_branch_entries, pi_rpc_message_id,
        receive_rpc_response,
    };
    use serde_json::json;

    #[tokio::test]
    async fn pi_rpc_accepts_frames_larger_than_the_shared_512_kib_limit() {
        let expected =
            json!({"type":"response","data":{"messages":[{"content":"文本".repeat(150_000)}]}});
        let mut bytes = serde_json::to_vec(&expected).unwrap();
        assert!(bytes.len() > 512 * 1024);
        bytes.extend_from_slice(b"\n{\"type\":\"next\"}\n");
        let mut reader = tokio::io::BufReader::new(bytes.as_slice());
        assert_eq!(
            super::read_pi_rpc_record(&mut reader).await.unwrap(),
            Some(expected)
        );
        assert_eq!(
            super::read_pi_rpc_record(&mut reader).await.unwrap(),
            Some(json!({"type":"next"}))
        );
        assert!(super::read_pi_rpc_record(&mut reader)
            .await
            .unwrap()
            .is_none());
    }

    #[test]
    fn pi_backend_pages_complete_turns_using_native_entry_cursors() {
        let snapshot = super::PiSessionSnapshot {
            messages: vec![
                json!({"role":"user","_pi_session_message_id":"u1"}),
                json!({"role":"assistant","_pi_session_message_id":"a1","content":[{"type":"text","text":"before"},{"type":"toolCall","id":"call"},{"type":"text","text":"after"}]}),
                json!({"role":"toolResult","_pi_session_message_id":"r1","toolCallId":"call"}),
                json!({"role":"user","_pi_session_message_id":"u2"}),
                json!({"role":"assistant","_pi_session_message_id":"a2"}),
            ],
            revision: super::PiHistoryRevision {
                session_id: "session".into(),
                append_cursor: Some("a2".into()),
                leaf_id: Some("a2".into()),
            },
        };
        let latest = super::page_pi_snapshot(&snapshot, None, 1).unwrap();
        assert_eq!(latest.messages.len(), 2);
        assert_eq!(latest.before_entry_id.as_deref(), Some("u2"));
        assert_eq!(latest.oldest_sequence, Some(3));
        assert!(latest.has_more);
        let older =
            super::page_pi_snapshot(&snapshot, latest.before_entry_id.as_deref(), 1).unwrap();
        assert_eq!(older.messages.len(), 3);
        assert_eq!(older.messages[1]["content"].as_array().unwrap().len(), 3);
        assert_eq!(older.messages[2]["toolCallId"], "call");
        assert_eq!(older.before_entry_id.as_deref(), Some("u1"));
        assert!(!older.has_more);
        assert_eq!(older.revision, latest.revision);
        assert_eq!(older.snapshot_sequence, latest.snapshot_sequence);
        assert!(super::page_pi_snapshot(&snapshot, Some("unknown"), 1).is_err());
        let empty = super::page_pi_snapshot(&snapshot, Some("u1"), 1).unwrap();
        assert!(empty.messages.is_empty());
        assert_eq!(empty.before_entry_id, None);
    }

    #[test]
    fn pi_snapshot_exposes_native_revision_without_generating_message_ids() {
        let snapshot = super::PiSessionSnapshot {
            messages: vec![json!({"_pi_session_message_id":"native-entry"})],
            revision: super::PiHistoryRevision {
                session_id: "native-session".into(),
                append_cursor: Some("append-entry".into()),
                leaf_id: Some("branch-leaf".into()),
            },
        };
        let value = serde_json::to_value(snapshot).unwrap();
        assert_eq!(
            value["messages"][0]["_pi_session_message_id"],
            "native-entry"
        );
        assert_eq!(
            value["revision"],
            json!({"sessionId":"native-session","appendCursor":"append-entry","leafId":"branch-leaf"})
        );
    }

    #[test]
    fn pi_incremental_cache_tracks_append_cursor_and_active_branch() {
        let mut cache = super::PiEntriesCache::default();
        let message = json!({"role":"assistant","content":"same"});
        cache.update(
            &[json!({"id":"a","type":"message","parentId":null,"message":message})],
            true,
        );
        cache.update(
            &[json!({"id":"b","type":"message","parentId":null,"message":message})],
            false,
        );
        assert_eq!(cache.entries.last().unwrap()["id"], "b");
        assert_eq!(cache.message_id(Some("a"), &message).unwrap(), "a");
        assert_eq!(cache.message_id(Some("b"), &message).unwrap(), "b");
        cache.update(&[], false);
        assert_eq!(cache.entries.len(), 2);
        cache.update(
            &[json!({"id":"c","type":"message","parentId":null,"message":message})],
            true,
        );
        assert_eq!(cache.entries.len(), 1);
        assert!(cache.message_id(Some("a"), &message).is_err());
    }

    #[tokio::test]
    async fn pi_entries_response_preserves_interleaved_events_in_order() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let events = vec![
            json!({"type":"message_end","message":{"role":"assistant"}}),
            json!({"type":"tool_execution_start","toolCallId":"call-1"}),
            json!({"type":"response","id":"other","success":true}),
            json!({"type":"agent_settled"}),
        ];
        for event in &events {
            tx.send(Ok(event.clone())).unwrap();
        }
        tx.send(Ok(json!({"type":"response","id":"entries","success":true})))
            .unwrap();
        let mut deferred = std::collections::VecDeque::new();
        let response = receive_rpc_response(&mut rx, &mut deferred, "entries")
            .await
            .unwrap();
        assert_eq!(response["id"], "entries");
        assert_eq!(deferred.into_iter().collect::<Vec<_>>(), events);
    }

    #[test]
    fn pi_live_identity_uses_active_rpc_branch_even_for_identical_messages() {
        let message =
            json!({"role":"assistant","content":[{"type":"text","text":"same"}],"timestamp":42});
        let entries = vec![
            json!({"type":"message","id":"active","parentId":null,"message":message}),
            json!({"type":"message","id":"abandoned","parentId":null,"message":message}),
        ];
        assert_eq!(
            pi_rpc_message_id(&entries, Some("active"), &message).unwrap(),
            "active"
        );
        assert!(pi_rpc_message_id(&[], None, &message).is_err());
    }

    #[test]
    fn pi_history_message_ids_follow_the_current_branch_and_exact_messages() {
        let user = json!({
            "role": "user",
            "content": [{"type": "text", "text": "second prompt"}],
            "timestamp": 1791301625351_i64
        });
        let assistant = json!({
            "role": "assistant",
            "content": [{"type": "text", "text": "answer"}],
            "timestamp": 1791301626000_i64,
            "stopReason": "stop"
        });
        let entries = vec![
            json!({"type":"message","id":"u1","parentId":null,"message":user}),
            json!({"type":"message","id":"old-answer","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"abandoned"}],"timestamp":1791301626000_i64}}),
            json!({"type":"message","id":"a1","parentId":"u1","message":assistant}),
        ];
        let mut messages = vec![user, assistant];

        attach_pi_session_message_ids(&mut messages, &entries, Some("a1"))
            .expect("reconcile current branch history");

        assert_eq!(messages[0]["_pi_session_message_id"], "u1");
        assert_eq!(messages[1]["_pi_session_message_id"], "a1");
        assert_eq!(messages[1]["_pi_session_parent_id"], "u1");
        let branch = pi_active_branch_entries(&entries, Some("a1")).expect("resolve active branch");
        assert_eq!(
            branch
                .iter()
                .map(|entry| entry["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["u1", "a1"]
        );
    }

    #[test]
    fn pi_history_does_not_silently_accept_unmatched_renderable_messages() {
        let mut messages = vec![json!({
            "role": "assistant",
            "content": [{"type": "text", "text": "answer"}],
            "timestamp": 10_i64
        })];

        let error = attach_pi_session_message_ids(&mut messages, &[], None)
            .expect_err("history identity mismatch must be surfaced");

        assert!(error.contains("could not be reconciled with native ids"));
    }
}

/// Find Pi shipped inside a regular Flowix installation. Dev launches use
/// this when Tauri does not preserve the `PI_CLI_PATH` set by tauri-dev.mjs.
pub fn installed_flowix_pi_binary() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let platform = "darwin";
    #[cfg(target_os = "windows")]
    let platform = "windows";
    #[cfg(target_os = "linux")]
    let platform = "linux";
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    let executable = if cfg!(windows) { "pi.exe" } else { "pi" };
    let mut app_roots = Vec::new();
    if let Some(root) = std::env::var_os("FLOWIX_PROD_APP_PATH") {
        app_roots.push(PathBuf::from(root));
    }
    #[cfg(target_os = "macos")]
    {
        app_roots.push(PathBuf::from("/Applications/Flowix.app"));
        if let Some(home) = dirs::home_dir() {
            app_roots.push(home.join("Applications").join("Flowix.app"));
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            app_roots.push(
                PathBuf::from(local_app_data)
                    .join("Programs")
                    .join("Flowix"),
            );
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            app_roots.push(PathBuf::from(program_files).join("Flowix"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        app_roots.push(PathBuf::from("/opt/Flowix"));
        app_roots.push(PathBuf::from("/usr/lib/flowix"));
        app_roots.push(PathBuf::from("/usr/lib/Flowix"));
    }

    for app_root in app_roots {
        #[cfg(target_os = "macos")]
        let resource_roots = vec![app_root.join("Contents").join("Resources")];
        #[cfg(not(target_os = "macos"))]
        let resource_roots = vec![app_root.join("resources"), app_root];
        for resource_root in resource_roots {
            let root = resource_root.join("pi").join(format!("{platform}-{arch}"));
            for candidate in [root.join("dist").join(executable), root.join(executable)] {
                if crate::agent_external::cli_resolver::is_executable_file(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }
    None
}
