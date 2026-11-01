use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;

use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex, OwnedMutexGuard};
use tokio::time::Duration;

use super::super::lifecycle::ExternalLifecycleEmitter;
use super::super::{
    persist_and_emit_external_chunk, resolve_and_freeze_runtime_cwd, resolve_run_id,
    AgentChunkMetadata, USER_STOPPED_REASON,
};
use super::shell;
use super::skill_resources::{self, PiStartupResources};
use super::AGENT_TYPE;
use crate::agent_session::ThreadManager;
use crate::agent_wire::{AgentChunk, AgentMessageAttachment, AgentUserMessage, RunInfo, UsageInfo};

const PI_IDLE_SESSION_TTL_MS: i64 = 10 * 60 * 1000;
const PI_RPC_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const PI_ABORT_SETTLE_TIMEOUT: Duration = Duration::from_secs(5);
const PI_STDERR_TAIL_BYTES: usize = 64 * 1024;
const PI_FORK_TIMEOUT: Duration = Duration::from_secs(20);

const PI_FORK_EXTENSION: &str = r#"
import { renameSync, writeFileSync } from 'node:fs';

function report(value) {
  const target = process.env.FLOWIX_PI_FORK_RESULT;
  if (target) {
    writeFileSync(`${target}.tmp`, JSON.stringify(value));
    renameSync(`${target}.tmp`, target);
  }
}

export default function (pi) {
  pi.registerCommand('flowix-fork', {
    description: 'Create a Flowix session fork at a native Pi entry',
    handler: async (args, ctx) => {
      try {
        const entryId = args.trim();
        if (!entryId) throw new Error('Missing Pi entry ID');
        const result = await ctx.fork(entryId, {
          position: 'at',
          withSession: async (next) => {
            const leafId = next.sessionManager.getLeafId();
            const branch = leafId ? next.sessionManager.getBranch(leafId) : [];
            report({
              sessionId: next.sessionManager.getSessionId(),
              sessionFile: next.sessionManager.getSessionFile(),
              parentSessionFile: next.sessionManager.getHeader().parentSession,
              branchEntryIds: branch.map((entry) => entry.id),
            });
          },
        });
        if (result.cancelled) report({ error: 'Pi fork was cancelled' });
      } catch (error) {
        report({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  });
}
"#;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PiForkMetadata {
    session_id: String,
    session_file: PathBuf,
    parent_session_file: PathBuf,
    branch_entry_ids: Vec<String>,
}

fn next_pi_rpc_id() -> String {
    static NEXT_ID: AtomicU64 = AtomicU64::new(0);
    format!("flowix-command-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed))
}

fn next_pi_queue_sequence() -> u64 {
    static NEXT_SEQUENCE: AtomicU64 = AtomicU64::new(0);
    NEXT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
}

async fn pi_message_payload(
    message: &AgentUserMessage,
    cwd: &std::path::Path,
) -> Result<Value, String> {
    let base_prompt = message.llm_content.as_deref().unwrap_or(&message.content);
    let workspace_paths = message.workspace_paths_for_runtime(AGENT_TYPE);
    let mut prompt = super::super::append_workspace_context(base_prompt, cwd, &workspace_paths);
    let mut images = Vec::new();
    let mut attached_files = Vec::new();
    for attachment in message.message_attachments() {
        if attachment.r#type == "input_image" {
            let bytes = tokio::fs::read(&attachment.path).await.map_err(|error| {
                format!("cannot read attached image {}: {error}", attachment.name)
            })?;
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
    let mut payload = serde_json::json!({ "message": prompt });
    if !images.is_empty() {
        payload["images"] = Value::Array(images);
    }
    Ok(payload)
}

fn queued_payloads(
    command_type: &str,
    texts: &[String],
    known: &mut HashMap<(String, String), VecDeque<Value>>,
) -> Vec<Value> {
    texts
        .iter()
        .map(|text| {
            known
                .get_mut(&(command_type.to_string(), text.clone()))
                .and_then(VecDeque::pop_front)
                .unwrap_or_else(|| serde_json::json!({ "message": text }))
        })
        .collect()
}

async fn enqueue_pi_payload(
    session: &PiSession,
    command_type: &str,
    payload: Value,
) -> Result<(), String> {
    let id = next_pi_rpc_id();
    let mut command = payload;
    command["id"] = Value::String(id.clone());
    command["type"] = Value::String(command_type.to_string());
    session.request(&id, &command).await?;
    Ok(())
}

async fn restore_pi_queues(
    session: &PiSession,
    active: &ActivePiRun,
    steering: &[String],
    follow_up: &[String],
) -> Result<(), String> {
    restore_pi_queues_excluding(session, active, steering, follow_up, None).await
}

async fn known_pi_queue_payloads(
    active: &ActivePiRun,
    steering: &[String],
    follow_up: &[String],
    excluded_id: Option<&str>,
) -> HashMap<(String, String), VecDeque<Value>> {
    let mut counts = HashMap::<(String, String), usize>::new();
    for (mode, texts) in [("steer", steering), ("follow_up", follow_up)] {
        for text in texts {
            *counts.entry((mode.to_string(), text.clone())).or_default() += 1;
        }
    }
    let mut entries = active
        .queued_messages
        .lock()
        .await
        .iter()
        .filter(|(id, _)| Some(id.as_str()) != excluded_id)
        .map(|(_, queued)| queued.clone())
        .collect::<Vec<_>>();
    entries.sort_by_key(|queued| queued.sequence);
    let mut known = HashMap::<(String, String), VecDeque<Value>>::new();
    for queued in entries {
        if let Some(text) = queued.payload.get("message").and_then(Value::as_str) {
            known
                .entry((queued.command_type.to_string(), text.to_string()))
                .or_default()
                .push_back(queued.payload.clone());
        }
    }
    for (key, payloads) in &mut known {
        let excess = payloads
            .len()
            .saturating_sub(*counts.get(key).unwrap_or(&0));
        for _ in 0..excess {
            payloads.pop_front();
        }
    }
    known
}

async fn pi_queue_target_index(
    active: &ActivePiRun,
    queue: &[String],
    target: &PiQueuedMessage,
) -> Option<usize> {
    let target_text = target.payload.get("message")?.as_str()?;
    let queued_count = queue
        .iter()
        .filter(|text| text.as_str() == target_text)
        .count();
    let mut sequences = active
        .queued_messages
        .lock()
        .await
        .values()
        .filter(|queued| {
            queued.command_type == target.command_type
                && queued.payload.get("message").and_then(Value::as_str) == Some(target_text)
        })
        .map(|queued| queued.sequence)
        .collect::<Vec<_>>();
    sequences.sort_unstable();
    if queued_count > sequences.len() {
        return None;
    }
    let first_live = sequences.len().saturating_sub(queued_count);
    let position = sequences[first_live..]
        .iter()
        .position(|sequence| *sequence == target.sequence)?;
    queue
        .iter()
        .enumerate()
        .filter(|(_, text)| text.as_str() == target_text)
        .nth(position)
        .map(|(index, _)| index)
}

async fn restore_pi_queues_excluding(
    session: &PiSession,
    active: &ActivePiRun,
    steering: &[String],
    follow_up: &[String],
    excluded_id: Option<&str>,
) -> Result<(), String> {
    let mut known = known_pi_queue_payloads(active, steering, follow_up, excluded_id).await;
    for payload in queued_payloads("steer", steering, &mut known) {
        enqueue_pi_payload(session, "steer", payload).await?;
    }
    for payload in queued_payloads("follow_up", follow_up, &mut known) {
        enqueue_pi_payload(session, "follow_up", payload).await?;
    }
    Ok(())
}

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

/// Permission mode chooses the *maximum* tool set; the environment decides
/// what is actually usable. Intersecting the two keeps a read-only
/// conversation useful (`ls`/`grep`/`find`) and keeps a shell tool the machine
/// cannot run out of the model's tool list entirely.
fn pi_tools_for_permission_mode(mode: Option<&str>, caps: shell::PiCapabilities) -> String {
    let mut tools = vec!["read", "ls"];
    // Pi's grep/find have no JS fallback: without rg/fd they try to download
    // from GitHub and fail the call, so only offer them when they resolve.
    if caps.ripgrep {
        tools.push("grep");
    }
    if caps.fd {
        tools.push("find");
    }
    match mode {
        Some("read-only") => {}
        Some("workspace-write") => {
            tools.push("edit");
            tools.push("write");
        }
        // Pi's built-in tools have no per-path sandbox. Unknown and legacy
        // modes retain the existing full-access behavior.
        _ => {
            tools.push("edit");
            tools.push("write");
            // Windows has no /bin/bash; without Git Bash Pi's bash tool cannot
            // start a shell, but its powershell tool always can.
            if let Some(shell_tool) = caps.shell.tool_name() {
                tools.push(shell_tool);
            }
        }
    }
    tools.join(",")
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PiSessionConfig {
    cwd: PathBuf,
    tools: String,
    code_mode: bool,
    tool_search: bool,
    provider: Option<String>,
    model: Option<String>,
    cloud_auth_generation: Option<u64>,
    thinking: Option<String>,
    startup_resources: PiStartupResources,
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

fn empty_pi_session_snapshot() -> PiSessionSnapshot {
    PiSessionSnapshot {
        messages: Vec::new(),
        revision: PiHistoryRevision {
            session_id: String::new(),
            append_cursor: None,
            leaf_id: None,
        },
    }
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

/// Keep diagnostics available while the process is alive, with bounded memory.
async fn capture_pi_stderr<R: AsyncRead + Unpin>(
    mut reader: R,
    captured: Arc<Mutex<String>>,
) -> std::io::Result<()> {
    let mut tail = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        let count = reader.read(&mut chunk).await?;
        if count == 0 {
            return Ok(());
        }
        tail.extend_from_slice(&chunk[..count]);
        if tail.len() > PI_STDERR_TAIL_BYTES {
            tail.drain(..tail.len() - PI_STDERR_TAIL_BYTES);
        }
        // Decode the retained bytes together so a UTF-8 character split across
        // reads is restored once its remaining bytes arrive.
        *captured.lock().await = String::from_utf8_lossy(&tail).into_owned();
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
    response_waiters: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
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

    async fn request(&self, id: &str, value: &Value) -> Result<Value, String> {
        let response = self.request_response(id, value).await?;
        if response.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Pi rejected the RPC command")
                .to_string());
        }
        Ok(response)
    }

    async fn request_response(&self, id: &str, value: &Value) -> Result<Value, String> {
        let (sender, receiver) = oneshot::channel();
        self.response_waiters
            .lock()
            .await
            .insert(id.to_string(), sender);
        if let Err(error) = self.write(value).await {
            self.response_waiters.lock().await.remove(id);
            return Err(error);
        }
        let response = match tokio::time::timeout(PI_RPC_REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => return Err("Pi RPC response channel closed".into()),
            Err(_) => {
                self.response_waiters.lock().await.remove(id);
                return Err("Pi RPC command timed out".into());
            }
        };
        Ok(response)
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
        self.records
            .lock()
            .await
            .recv()
            .await
            .ok_or_else(|| "Pi RPC event reader closed".to_string())?
    }

    /// Serialize cursor updates while allowing the read RPC to run alongside
    /// a prompt and its streamed events.
    async fn session_entries(&self) -> Result<(Arc<Vec<Value>>, Option<String>), String> {
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
            let request_id = format!("flowix-entries-{}", next_pi_rpc_id());
            let mut request = serde_json::json!({"id": request_id, "type": "get_entries"});
            if let Some(cursor) = &since {
                request["since"] = Value::String(cursor.clone());
            }
            let response = self.request_response(&request_id, &request).await?;
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

    async fn session_messages(&self) -> Result<Vec<Value>, String> {
        let request_id = format!("flowix-messages-{}", next_pi_rpc_id());
        let request = serde_json::json!({"id":request_id, "type":"get_messages"});
        let response = self.request(&request_id, &request).await?;
        response
            .pointer("/data/messages")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| "Pi get_messages response did not include messages".to_string())
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
    session_state: tokio::sync::watch::Sender<Option<Arc<PiSession>>>,
    session_id: Mutex<Option<String>>,
    queued_messages: Mutex<HashMap<String, PiQueuedMessage>>,
    queue_lock: Mutex<()>,
    stop_notify: tokio::sync::Notify,
    last_event_at: AtomicI64,
    stop_reason: Mutex<Option<String>>,
    finalizing: AtomicBool,
    stream_end_emitted: Arc<AtomicBool>,
}

#[derive(Clone)]
struct PiQueuedMessage {
    command_type: &'static str,
    payload: Value,
    sequence: u64,
    display_text: String,
    attachments: Vec<AgentMessageAttachment>,
}

struct PiProjectedUserMessage {
    text: String,
    attachments: Vec<AgentMessageAttachment>,
    client_message_id: Option<String>,
}

impl ActivePiRun {
    async fn wait_for_session(&self) -> Option<Arc<PiSession>> {
        let mut session_state = self.session_state.subscribe();
        loop {
            if let Some(session) = session_state.borrow().clone() {
                return Some(session);
            }
            if self.finalizing.load(Ordering::Acquire) {
                return None;
            }
            if session_state.changed().await.is_err() {
                return None;
            }
        }
    }

    async fn take_queued_user_message(&self, native_text: &str) -> Option<PiProjectedUserMessage> {
        let _queue_guard = self.queue_lock.lock().await;
        let mut queued = self.queued_messages.lock().await;
        let client_message_id = queued
            .iter()
            .filter(|(_, message)| {
                message.payload.get("message").and_then(Value::as_str) == Some(native_text)
            })
            .min_by_key(|(_, message)| message.sequence)
            .map(|(id, _)| id.clone())?;
        let message = queued.remove(&client_message_id)?;
        Some(PiProjectedUserMessage {
            text: message.display_text,
            attachments: message.attachments,
            client_message_id: Some(client_message_id),
        })
    }
}

fn pi_user_message_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| {
                (block.get("type").and_then(Value::as_str) == Some("text"))
                    .then(|| block.get("text").and_then(Value::as_str))
                    .flatten()
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

type CloudRefreshResults = HashMap<u64, (tokio::time::Instant, Result<bool, String>)>;

pub struct PiRpcManager {
    thread_manager: Arc<ThreadManager>,
    sessions: Mutex<HashMap<String, Arc<PiSession>>>,
    starting_sessions: Mutex<HashMap<String, Arc<PiSession>>>,
    session_start_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    active_runs: Mutex<HashMap<String, Arc<ActivePiRun>>>,
    shutting_down: AtomicBool,
    history_snapshots: Mutex<VecDeque<(String, Arc<PiSessionSnapshot>)>>,
    cloud_credential_generation: Mutex<Option<u64>>,
    startup_cloud_refresh_results: Mutex<CloudRefreshResults>,
}

async fn run_startup_cloud_refresh_once<F, Fut>(
    results: &Mutex<CloudRefreshResults>,
    generation: u64,
    refresh: F,
) -> Result<bool, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<bool, String>>,
{
    // Keep the lock while refreshing so concurrent WebViews await the same
    // result, including a failure, instead of treating an in-flight attempt
    // as a successful refresh.
    let mut results = results.lock().await;
    if let Some((finished_at, result)) = results.get(&generation) {
        // Coalesce concurrent failures without poisoning this login session.
        if result.is_ok() || finished_at.elapsed() < Duration::from_secs(2) {
            return result.clone();
        }
    }

    let result = refresh().await;
    results.retain(|key, _| *key >= generation);
    results.insert(generation, (tokio::time::Instant::now(), result.clone()));
    result
}

async fn run_startup_cloud_credential_refresh_once<F, Fut>(
    results: &Mutex<CloudRefreshResults>,
    credential_generation: &Mutex<Option<u64>>,
    generation: u64,
    refresh: F,
) -> Result<bool, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    run_startup_cloud_refresh_once(results, generation, || async {
        // Startup refreshes the live model catalog even if this process has
        // already created a credential for the current Cloud login.
        let mut credential_generation = credential_generation.lock().await;
        refresh().await?;
        *credential_generation = Some(generation);
        Ok(true)
    })
    .await
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
            cloud_credential_generation: Mutex::new(None),
            startup_cloud_refresh_results: Mutex::new(HashMap::new()),
        }
    }

    pub async fn connect_cloud_model_provider(
        &self,
        app: &tauri::AppHandle,
        api_base: &str,
    ) -> Result<(), String> {
        let app_state = app.state::<crate::app::state::AppState>();
        let cloud_sync = app_state.cloud_sync.clone();
        let generation = cloud_sync.ai_credential_session_generation();
        drop(app_state);

        let mut cached_generation = self.cloud_credential_generation.lock().await;
        self.create_and_save_cloud_credential(app, api_base, &cloud_sync, generation)
            .await?;
        *cached_generation = Some(generation);
        Ok(())
    }

    /// Remove the local Flowix Cloud provider and its credential after logout.
    pub async fn disconnect_cloud_model_provider(
        &self,
        app: &tauri::AppHandle,
        api_base: &str,
        logout_generation: u64,
    ) -> Result<(), String> {
        // Serialize with credential creation and refresh before reading the
        // provider files, so a concurrent save cannot slip past this cleanup.
        let mut cached_generation = self.cloud_credential_generation.lock().await;
        let app_state = app.state::<crate::app::state::AppState>();
        let cloud_sync = app_state.cloud_sync.clone();
        drop(app_state);
        if cloud_sync.ai_credential_session_generation() != logout_generation
            || cloud_sync
                .state()
                .map_err(|error| error.to_string())?
                .authenticated
        {
            return Ok(());
        }
        *cached_generation = None;
        if super::config::delete_cloud_providers(api_base)? {
            let _ = app.emit(
                crate::commands::settings::USER_CONFIG_CHANGED_EVENT,
                "pi_config",
            );
        }
        Ok(())
    }

    /// Ensure the Flowix Cloud Pi catalog is available once for the current
    /// signed-in account, including the first login before a provider exists.
    /// The generation guard deduplicates calls from multiple content WebViews.
    pub async fn refresh_cloud_model_provider_at_startup(
        &self,
        app: &tauri::AppHandle,
        api_base: &str,
    ) -> Result<bool, String> {
        let app_state = app.state::<crate::app::state::AppState>();
        let cloud_sync = app_state.cloud_sync.clone();
        if !cloud_sync
            .state()
            .map_err(|error| error.to_string())?
            .authenticated
        {
            return Ok(false);
        }
        let generation = cloud_sync.ai_credential_session_generation();
        drop(app_state);

        run_startup_cloud_credential_refresh_once(
            &self.startup_cloud_refresh_results,
            &self.cloud_credential_generation,
            generation,
            || async {
                self.create_and_save_cloud_credential(app, api_base, &cloud_sync, generation)
                    .await
            },
        )
        .await
    }

    /// Refresh the saved Flowix Cloud model catalog on an explicit user request.
    pub async fn refresh_cloud_model_provider(
        &self,
        app: &tauri::AppHandle,
        api_base: &str,
    ) -> Result<bool, String> {
        let has_cloud_provider = super::config::list()?
            .iter()
            .any(|provider| provider.source.as_deref() == Some("flowix-cloud"));
        if !has_cloud_provider {
            return Ok(false);
        }

        let app_state = app.state::<crate::app::state::AppState>();
        let cloud_sync = app_state.cloud_sync.clone();
        if !cloud_sync
            .state()
            .map_err(|error| error.to_string())?
            .authenticated
        {
            return Ok(false);
        }
        let generation = cloud_sync.ai_credential_session_generation();
        drop(app_state);

        let mut cached_generation = self.cloud_credential_generation.lock().await;
        self.create_and_save_cloud_credential(app, api_base, &cloud_sync, generation)
            .await?;
        *cached_generation = Some(generation);
        Ok(true)
    }

    async fn ensure_cloud_credential(
        &self,
        app: &tauri::AppHandle,
        provider_id: Option<&str>,
        api_base: &str,
    ) -> Result<Option<u64>, String> {
        if !super::config::is_flowix_cloud_provider(provider_id, api_base)? {
            return Ok(None);
        }
        let app_state = app.state::<crate::app::state::AppState>();
        let cloud_sync = app_state.cloud_sync.clone();
        let generation = cloud_sync.ai_credential_session_generation();
        drop(app_state);
        let mut cached_generation = self.cloud_credential_generation.lock().await;
        if *cached_generation == Some(generation) {
            return Ok(Some(generation));
        }

        self.create_and_save_cloud_credential(app, api_base, &cloud_sync, generation)
            .await?;
        *cached_generation = Some(generation);
        Ok(Some(generation))
    }

    async fn create_and_save_cloud_credential(
        &self,
        app: &tauri::AppHandle,
        api_base: &str,
        cloud_sync: &flowix_sync::SyncManager,
        generation: u64,
    ) -> Result<(), String> {
        let credential = cloud_sync
            .create_ai_credential()
            .await
            .map_err(|error| error.to_string())?;
        if cloud_sync.ai_credential_session_generation() != generation {
            return Err(
                "Flowix Cloud account changed while preparing the Pi model; retry the request"
                    .into(),
            );
        }
        if let Err(error) = super::config::save_cloud_credential(app, api_base, credential) {
            if cloud_sync.ai_credential_session_generation() == generation {
                if let Err(revoke_error) = cloud_sync.revoke_ai_credential().await {
                    tracing::warn!(
                        "failed to revoke an unconfigured Flowix Cloud Pi credential: {revoke_error}"
                    );
                }
            }
            return Err(error);
        }
        let _ = app.emit(
            crate::commands::settings::USER_CONFIG_CHANGED_EVENT,
            "pi_config",
        );
        Ok(())
    }

    pub async fn queue_message(
        &self,
        thread_id: &str,
        message: AgentUserMessage,
        client_message_id: String,
        delivery: &str,
    ) -> Result<(), String> {
        let command_type = match delivery {
            "steer" => "steer",
            "follow_up" => "follow_up",
            _ => return Err("unsupported Pi message delivery mode".into()),
        };
        let active = self
            .active_runs
            .lock()
            .await
            .get(thread_id)
            .cloned()
            .ok_or_else(|| "Pi has no active turn to queue a message for".to_string())?;
        let _queue_guard = active.queue_lock.lock().await;
        if active.finalizing.load(Ordering::Acquire) || active.stop_reason.lock().await.is_some() {
            return Err("Pi turn is already stopping".into());
        }
        let session = tokio::time::timeout(PI_RPC_REQUEST_TIMEOUT, async {
            loop {
                if let Some(session) = active.session.lock().await.clone() {
                    return Ok(session);
                }
                if active.finalizing.load(Ordering::Acquire)
                    || active.stop_reason.lock().await.is_some()
                {
                    return Err("Pi turn stopped before the session was ready".to_string());
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .map_err(|_| "Pi session did not become ready in time".to_string())??;
        let payload = pi_message_payload(&message, &session.config.cwd).await?;
        let id = next_pi_rpc_id();
        let mut command = payload.clone();
        command["id"] = Value::String(id.clone());
        command["type"] = Value::String(command_type.to_string());
        active.queued_messages.lock().await.insert(
            client_message_id.clone(),
            PiQueuedMessage {
                command_type,
                payload,
                sequence: next_pi_queue_sequence(),
                display_text: message.content.clone(),
                attachments: message.message_attachments(),
            },
        );
        let response = match session.request(&id, &command).await {
            Ok(response) => response,
            Err(error) => {
                active
                    .queued_messages
                    .lock()
                    .await
                    .remove(&client_message_id);
                return Err(error);
            }
        };
        let disposition = response
            .pointer("/data/disposition")
            .and_then(Value::as_str)
            .unwrap_or("queued");
        if disposition == "handled" {
            active
                .queued_messages
                .lock()
                .await
                .remove(&client_message_id);
        }
        Ok(())
    }

    pub async fn promote_follow_up_to_steer(
        &self,
        thread_id: &str,
        client_message_id: &str,
    ) -> Result<(), String> {
        let active = self
            .active_runs
            .lock()
            .await
            .get(thread_id)
            .cloned()
            .ok_or_else(|| "Pi has no active turn".to_string())?;
        let _queue_guard = active.queue_lock.lock().await;
        let target = active
            .queued_messages
            .lock()
            .await
            .get(client_message_id)
            .cloned()
            .filter(|queued| queued.command_type == "follow_up")
            .ok_or_else(|| "Pi follow-up is no longer queued".to_string())?;
        let session = active
            .session
            .lock()
            .await
            .clone()
            .ok_or_else(|| "Pi turn is still starting".to_string())?;
        let clear_id = next_pi_rpc_id();
        let cleared = session
            .request(
                &clear_id,
                &serde_json::json!({ "id": clear_id.clone(), "type": "clear_queue" }),
            )
            .await?;
        let data = cleared
            .get("data")
            .ok_or("Pi clear_queue response did not include queued messages")?;
        let mut steering = data
            .get("steering")
            .and_then(Value::as_array)
            .ok_or("Pi clear_queue response did not include steering messages")?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>();
        let mut follow_up = data
            .get("followUp")
            .and_then(Value::as_array)
            .ok_or("Pi clear_queue response did not include follow-up messages")?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>();
        let Some(target_index) = pi_queue_target_index(&active, &follow_up, &target).await else {
            restore_pi_queues(&session, &active, &steering, &follow_up).await?;
            return Err("Pi follow-up has already started and cannot be steered".into());
        };
        follow_up.remove(target_index);
        let mut pending =
            known_pi_queue_payloads(&active, &steering, &follow_up, Some(client_message_id)).await;
        let steer_payloads = queued_payloads("steer", &steering, &mut pending);
        let follow_up_payloads = queued_payloads("follow_up", &follow_up, &mut pending);
        steering.clear();
        for payload in steer_payloads {
            enqueue_pi_payload(&session, "steer", payload).await?;
        }
        enqueue_pi_payload(&session, "steer", target.payload.clone()).await?;
        for payload in follow_up_payloads {
            enqueue_pi_payload(&session, "follow_up", payload).await?;
        }
        active.queued_messages.lock().await.insert(
            client_message_id.to_string(),
            PiQueuedMessage {
                command_type: "steer",
                payload: target.payload,
                sequence: next_pi_queue_sequence(),
                display_text: target.display_text,
                attachments: target.attachments,
            },
        );
        Ok(())
    }

    pub async fn delete_queued_message(
        &self,
        thread_id: &str,
        client_message_id: &str,
    ) -> Result<(), String> {
        let active = self
            .active_runs
            .lock()
            .await
            .get(thread_id)
            .cloned()
            .ok_or_else(|| "Pi has no active turn".to_string())?;
        let _queue_guard = active.queue_lock.lock().await;
        let target = active
            .queued_messages
            .lock()
            .await
            .get(client_message_id)
            .cloned()
            .ok_or_else(|| "Pi message is no longer queued".to_string())?;
        let session = active
            .session
            .lock()
            .await
            .clone()
            .ok_or_else(|| "Pi turn is still starting".to_string())?;
        let clear_id = next_pi_rpc_id();
        let cleared = session
            .request(
                &clear_id,
                &serde_json::json!({ "id": clear_id.clone(), "type": "clear_queue" }),
            )
            .await?;
        let data = cleared
            .get("data")
            .ok_or("Pi clear_queue response did not include queued messages")?;
        let mut steering = data
            .get("steering")
            .and_then(Value::as_array)
            .ok_or("Pi clear_queue response did not include steering messages")?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>();
        let mut follow_up = data
            .get("followUp")
            .and_then(Value::as_array)
            .ok_or("Pi clear_queue response did not include follow-up messages")?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>();
        let queue = if target.command_type == "steer" {
            &mut steering
        } else {
            &mut follow_up
        };
        let Some(target_index) = pi_queue_target_index(&active, queue, &target).await else {
            restore_pi_queues(&session, &active, &steering, &follow_up).await?;
            return Err("Pi message has already started and cannot be deleted".into());
        };
        queue.remove(target_index);
        restore_pi_queues_excluding(
            &session,
            &active,
            &steering,
            &follow_up,
            Some(client_message_id),
        )
        .await?;
        active
            .queued_messages
            .lock()
            .await
            .remove(client_message_id);
        Ok(())
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
        let mut deleted = false;
        match std::fs::remove_dir_all(pi_session_dir(thread_id)?) {
            Ok(()) => deleted = true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("could not delete Pi conversation session: {error}"));
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
        // Make the packages vendored into the bundle available in the user's
        // Pi agent directory before any process reads it. Best-effort: a
        // failed seed must not block launching Pi.
        super::package_seed::seed_bundled_packages(app);

        let mut command = Command::new(resolve_pi_binary(app)?);
        // The bash tool reads its environment from this process, so the PATH
        // resolved from the user's login shell has to be injected here.
        shell::apply_child_path(&mut command, shell::child_path().await.as_deref());
        let mut tools = config
            .tools
            .split(',')
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if config.code_mode {
            tools.push("codemode".into());
        }
        if config.tool_search {
            tools.push("tool_search".into());
        }
        let tools = tools.join(",");
        command
            .args(["--mode", "rpc", "--session-dir"])
            .arg(&session_dir)
            .arg("--tools")
            .arg(&tools)
            .args(if config.code_mode {
                vec!["--extension", "builtin:codemode"]
            } else {
                Vec::new()
            })
            .args(if config.tool_search {
                vec!["--extension", "builtin:tool-search"]
            } else {
                Vec::new()
            })
            .current_dir(&config.cwd)
            .env("PI_CODING_AGENT_DIR", &config_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // RPC cannot ask for project trust. Explicitly load the exact notebook
        // skills represented by this session's startup-resource fingerprint.
        for skill_directory in &config.startup_resources.skill_directories {
            command.arg("--skill").arg(skill_directory);
        }
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
            .map_err(|error| format!("failed to start Pi v1.1.0 RPC: {error}"))?;
        let stdin = Arc::new(Mutex::new(
            child.stdin.take().ok_or("Pi stdin unavailable")?,
        ));
        let stdout = child.stdout.take().ok_or("Pi stdout unavailable")?;
        let stderr_pipe = child.stderr.take().ok_or("Pi stderr unavailable")?;
        let (record_tx, record_rx) = mpsc::unbounded_channel();
        let response_waiters =
            Arc::new(Mutex::new(HashMap::<String, oneshot::Sender<Value>>::new()));
        let response_routes = response_waiters.clone();
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
                if let Ok(value) = record.as_ref() {
                    if value.get("type").and_then(Value::as_str) == Some("response") {
                        if let Some(id) = value.get("id").and_then(Value::as_str) {
                            if let Some(waiter) = response_routes.lock().await.remove(id) {
                                let _ = waiter.send(value.clone());
                                continue;
                            }
                        }
                    }
                }
                if record_tx.send(record).is_err() || fatal {
                    break;
                }
            }
        });
        let stderr = Arc::new(Mutex::new(String::new()));
        let stderr_capture = stderr.clone();
        tokio::spawn(async move {
            let _ = capture_pi_stderr(stderr_pipe, stderr_capture).await;
        });

        let session = Arc::new(PiSession {
            session_id: Mutex::new(String::new()),
            config: config.clone(),
            stdin,
            records: Mutex::new(record_rx),
            response_waiters,
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

    pub async fn fork_session(
        &self,
        app: &tauri::AppHandle,
        source_thread_id: &str,
        entry_id: &str,
        child_thread_id: &str,
        cwd: &std::path::Path,
    ) -> Result<String, String> {
        if entry_id.is_empty()
            || !entry_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err("Pi fork entry ID is invalid".into());
        }
        let expected_source_id = self
            .thread_manager
            .get_external_session(source_thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("Pi source conversation has not started yet")?;
        // The source process holds its operation lock for the whole turn. Read
        // its persisted session through an independent Pi process instead.
        let source_file = self
            .thread_manager
            .get_pi_session_file(source_thread_id)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("Pi source session file is unavailable")?;
        if !source_file.is_file() {
            return Err("Pi source session has no persisted conversation to fork".into());
        }

        let child_dir = pi_session_dir(child_thread_id)?;
        if child_dir.exists() {
            return Err("Pi fork destination already exists".into());
        }
        std::fs::create_dir_all(&child_dir)
            .map_err(|error| format!("could not create Pi fork directory: {error}"))?;
        let result = run_pi_fork_extension(
            app,
            &expected_source_id,
            &source_file,
            &child_dir,
            cwd,
            entry_id,
        )
        .await;
        let fork = match result {
            Ok(value) => value,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&child_dir);
                return Err(error);
            }
        };
        self.thread_manager
            .upsert_external_session(
                child_thread_id,
                AGENT_TYPE,
                &fork.session_id,
                Some(serde_json::json!({
                    "sessionFile": fork.session_file,
                    "cwd": cwd.to_string_lossy(),
                    "parentThreadId": source_thread_id,
                    "parentSessionId": expected_source_id,
                    "forkEntryId": entry_id,
                })),
            )
            .await
            .map_err(|error| {
                let _ = std::fs::remove_dir_all(&child_dir);
                error.to_string()
            })?;
        Ok(fork.session_id)
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
                    return Err("HistoryChanged:pi_branch".into());
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
        let active_run = self.active_runs.lock().await.get(thread_id).cloned();
        let has_session = mapped_session.is_some()
            || self.sessions.lock().await.contains_key(thread_id)
            || active_run.is_some();
        if !has_session {
            return Ok(empty_pi_session_snapshot());
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
            cloud_auth_generation: None,
            thinking: None,
            startup_resources: skill_resources::capture(
                &cwd,
                &pi_config_dir()?,
                &resolve_pi_session_dir(thread_id, true)?,
            )?,
        };
        let session = if let Some(active_run) = active_run.as_ref() {
            let active_session =
                tokio::time::timeout(PI_RPC_REQUEST_TIMEOUT, active_run.wait_for_session())
                    .await
                    .map_err(|_| {
                        "Pi session initialization timed out while reading history".to_string()
                    })?;
            if let Some(session) = active_session {
                session
            } else if let Some(session) = self.sessions.lock().await.get(thread_id).cloned() {
                session
            } else {
                let mapped_session = self
                    .thread_manager
                    .get_external_session(thread_id, AGENT_TYPE)
                    .await
                    .map_err(|error| error.to_string())?;
                if mapped_session.is_some() {
                    self.ensure_session(app, thread_id, config, true).await?
                } else {
                    return Ok(empty_pi_session_snapshot());
                }
            }
        } else {
            self.ensure_session(app, thread_id, config, true).await?
        };
        session.touch();
        // Pi keeps the operation lock for the whole prompt. History reads use
        // correlated RPC waiters and a small revision fence instead, matching
        // the behavior of Codex's concurrent live-turn/history reads.
        let active_at_start = self.active_runs.lock().await.contains_key(thread_id);
        let mut last_read = None;
        let mut stable_revision_seen = false;
        for attempt in 0..3 {
            let (before_entries, before_leaf) = session.session_entries().await?;
            let messages = session.session_messages().await?;
            let (entries, leaf_id) = session.session_entries().await?;
            let before_cursor = before_entries
                .last()
                .and_then(|entry| entry.get("id"))
                .and_then(Value::as_str);
            let after_cursor = entries
                .last()
                .and_then(|entry| entry.get("id"))
                .and_then(Value::as_str);
            let revision_matches = before_cursor == after_cursor && before_leaf == leaf_id;
            last_read = Some((messages, entries, leaf_id));
            if revision_matches {
                stable_revision_seen = true;
                break;
            }
            if attempt < 2 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        let (mut messages, entries, leaf_id) =
            last_read.ok_or_else(|| "Pi history read did not return a snapshot".to_string())?;
        let active_during_read =
            active_at_start || self.active_runs.lock().await.contains_key(thread_id);
        attach_pi_session_message_ids_with_pending_tail(
            &mut messages,
            &entries,
            leaf_id.as_deref(),
            active_during_read || !stable_revision_seen,
        )?;
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
        session.touch();
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
            session_state: tokio::sync::watch::channel(None).0,
            session_id: Mutex::new(None),
            queued_messages: Mutex::new(HashMap::new()),
            queue_lock: Mutex::new(()),
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
        active
            .session_state
            .send_replace(active.session.lock().await.clone());
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
        let pi_features = super::config::features()?;
        let runtime_model =
            runtime_model.filter(|value| !value.trim().is_empty() && value != "inherit");
        let cloud_api_base = app
            .state::<crate::app::state::AppState>()
            .cloud_environment
            .api_base()
            .to_string();
        let cloud_auth_generation = self
            .ensure_cloud_credential(app, provider.as_deref(), &cloud_api_base)
            .await?;
        let thinking = message
            .reasoning_effort_for_runtime(AGENT_TYPE)
            .filter(|value| {
                matches!(
                    *value,
                    "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
                )
            })
            .map(str::to_owned);
        let child_path = shell::child_path().await;
        let configured_shell = super::config::shell_path()
            .ok()
            .flatten()
            .map(PathBuf::from);
        let caps = shell::capabilities(child_path.as_deref(), configured_shell.as_deref());
        let config = PiSessionConfig {
            cwd: cwd.clone(),
            tools: pi_tools_for_permission_mode(permission_mode, caps),
            code_mode: message.code_mode_for_runtime(AGENT_TYPE).unwrap_or(false),
            tool_search: pi_features.tool_search,
            provider: provider.clone().filter(|value| !value.trim().is_empty()),
            model: runtime_model.clone(),
            cloud_auth_generation,
            thinking,
            startup_resources: skill_resources::capture(
                &cwd,
                &pi_config_dir()?,
                &resolve_pi_session_dir(thread_id, true)?,
            )?,
        };
        let session = self.ensure_session(app, thread_id, config, false).await?;
        *active.session.lock().await = Some(session.clone());
        active.session_state.send_replace(Some(session.clone()));
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
        let mut initial_user_seen = false;
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
                    let user_projection =
                        if completed_message.get("role").and_then(Value::as_str) == Some("user") {
                            if !initial_user_seen {
                                initial_user_seen = true;
                                Some(PiProjectedUserMessage {
                                    text: message.content.clone(),
                                    attachments: message.message_attachments(),
                                    client_message_id: None,
                                })
                            } else {
                                let native_text = pi_user_message_text(completed_message);
                                Some(
                                    active
                                        .take_queued_user_message(&native_text)
                                        .await
                                        .unwrap_or(PiProjectedUserMessage {
                                            text: native_text,
                                            attachments: Vec::new(),
                                            client_message_id: None,
                                        }),
                                )
                            }
                        } else {
                            None
                        };
                    self.project_completed_message(
                        app,
                        thread_id,
                        &message_id,
                        run_id,
                        sequence,
                        completed_message,
                        user_projection.as_ref(),
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
        user_projection: Option<&PiProjectedUserMessage>,
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
            let Some(user_projection) = user_projection else {
                return Ok(());
            };
            let user_chunk = AgentChunk::UserMessage {
                thread_id: thread_id.to_string(),
                id: message_id.to_string(),
                text: user_projection.text.clone(),
                timestamp: source_timestamp,
                attachments: user_projection.attachments.clone(),
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
                    client_user_message_id: user_projection.client_message_id.clone(),
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
        _app: &tauri::AppHandle,
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
        let confirmed =
            tokio::time::timeout(PI_ABORT_SETTLE_TIMEOUT + Duration::from_secs(1), async {
                loop {
                    let still_active = self
                        .active_runs
                        .lock()
                        .await
                        .get(thread_id)
                        .is_some_and(|current| Arc::ptr_eq(current, &active));
                    if !still_active {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            })
            .await
            .is_ok();
        if !confirmed {
            tracing::warn!("[Pi RPC] StopUnconfirmed for run {}", active.run_id);
        }
        confirmed
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
            let stopping = active.stop_reason.lock().await.is_some();
            let mut info = RunInfo::active(
                active.started_at,
                Some("Pi RPC"),
                Some(AGENT_TYPE),
                Some(active.run_id.clone()),
                Some(thread_id.clone()),
                session_id,
            );
            if stopping {
                info.phase = Some("stopping".to_string());
            }
            running.insert(thread_id, info);
        }
        running
    }
    /// Called only after update cleanup has finished and installation returned.
    /// Existing processes stay stopped; subsequent requests can create sessions.
    #[cfg(windows)]
    pub(crate) fn resume_after_failed_update(&self) {
        self.shutting_down.store(false, Ordering::Release);
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
        let count = sessions.len();
        futures::future::join_all(sessions.into_iter().map(|(thread_id, session)| async move {
            session.shutdown(&thread_id).await;
        }))
        .await;
        self.active_runs.lock().await.clear();
        count
    }
    pub async fn reap_inactive_runs(&self, _app: &tauri::AppHandle, idle_timeout_ms: i64) -> usize {
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
        let mut confirmed = 0;
        for (thread_id, active) in &stale_runs {
            let reason = format!("watchdog_idle_timeout_ms={idle_timeout_ms}");
            *active.stop_reason.lock().await = Some(reason.clone());
            active.stop_notify.notify_one();
            let session = { active.session.lock().await.clone() };
            if let Some(session) = session {
                self.remove_session_if_same(thread_id, &session).await;
            }
            let settled =
                tokio::time::timeout(PI_ABORT_SETTLE_TIMEOUT + Duration::from_secs(1), async {
                    loop {
                        let still_active = self
                            .active_runs
                            .lock()
                            .await
                            .get(thread_id)
                            .is_some_and(|current| Arc::ptr_eq(current, active));
                        if !still_active {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                })
                .await
                .is_ok();
            if settled {
                confirmed += 1;
            } else {
                tracing::warn!(
                    "[Pi RPC] watchdog StopUnconfirmed for run {}",
                    active.run_id
                );
            }
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
        confirmed
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

async fn pi_fork_process_request(
    reader: &mut (impl AsyncBufRead + Unpin),
    stdin: &mut ChildStdin,
    kind: &str,
) -> Result<Value, String> {
    let id = next_pi_rpc_id();
    write_rpc_locked(stdin, &serde_json::json!({"id": id, "type": kind})).await?;
    tokio::time::timeout(PI_FORK_TIMEOUT, async {
        let mut line = String::new();
        loop {
            line.clear();
            if reader
                .read_line(&mut line)
                .await
                .map_err(|error| error.to_string())?
                == 0
            {
                return Err("Pi fork process exited before replying".to_string());
            }
            let record: Value = serde_json::from_str(&line)
                .map_err(|error| format!("Pi fork process returned invalid JSON: {error}"))?;
            if record.get("type").and_then(Value::as_str) == Some("response")
                && record.get("id").and_then(Value::as_str) == Some(&id)
            {
                if record.get("success").and_then(Value::as_bool) != Some(true) {
                    return Err(record
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Pi fork RPC failed")
                        .to_string());
                }
                return Ok(record);
            }
        }
    })
    .await
    .map_err(|_| "Pi fork RPC timed out".to_string())?
}

async fn run_pi_fork_extension(
    app: &tauri::AppHandle,
    expected_source_id: &str,
    source_file: &std::path::Path,
    child_dir: &std::path::Path,
    cwd: &std::path::Path,
    entry_id: &str,
) -> Result<PiForkMetadata, String> {
    let extension_path = child_dir.join(".flowix-pi-fork-extension.ts");
    let result_path = child_dir.join(".flowix-pi-fork-result.json");
    std::fs::write(&extension_path, PI_FORK_EXTENSION)
        .map_err(|error| format!("could not prepare Pi fork extension: {error}"))?;

    let operation = async {
        let config_dir = pi_config_dir()?;
        let mut command = Command::new(resolve_pi_binary(app)?);
        shell::apply_child_path(&mut command, shell::child_path().await.as_deref());
        command
            .args(["--mode", "rpc", "--session-dir"])
            .arg(child_dir)
            .args(["--tools", "read", "--extension"])
            .arg(&extension_path)
            .arg("--session")
            .arg(source_file)
            .current_dir(cwd)
            .env("PI_CODING_AGENT_DIR", config_dir)
            .env("FLOWIX_PI_FORK_RESULT", &result_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        crate::agent_external::shared::configure_unix_process_group(&mut command);
        crate::process_window::hide_command_window(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start Pi fork process: {error}"))?;
        let mut stdin = child.stdin.take().ok_or("Pi fork stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("Pi fork stdout unavailable")?;
        let mut reader = BufReader::new(stdout);

        let state = pi_fork_process_request(&mut reader, &mut stdin, "get_state").await?;
        let opened_id = state.pointer("/data/sessionId").and_then(Value::as_str);
        if opened_id != Some(expected_source_id) {
            let _ = child.kill().await;
            return Err("Pi fork process opened a different source session".into());
        }
        let snapshot = pi_fork_process_request(&mut reader, &mut stdin, "get_entries").await?;
        let entries = snapshot
            .pointer("/data/entries")
            .and_then(Value::as_array)
            .ok_or("Pi fork process did not return session entries")?;
        let leaf_id = snapshot.pointer("/data/leafId").and_then(Value::as_str);
        let branch = pi_active_branch_entries(entries, leaf_id)?;
        let selected = branch
            .iter()
            .find(|entry| entry.get("id").and_then(Value::as_str) == Some(entry_id))
            .ok_or("Pi fork point is not on the active session branch")?;
        if selected.get("type").and_then(Value::as_str) != Some("message")
            || selected.pointer("/message/role").and_then(Value::as_str) != Some("assistant")
        {
            return Err("Pi fork point must be an assistant message".into());
        }
        let commands = pi_fork_process_request(&mut reader, &mut stdin, "get_commands").await?;
        if !commands
            .pointer("/data/commands")
            .and_then(Value::as_array)
            .is_some_and(|commands| {
                commands.iter().any(|command| {
                    command.get("name").and_then(Value::as_str) == Some("flowix-fork")
                })
            })
        {
            let _ = child.kill().await;
            return Err("Pi did not load Flowix's fork extension".into());
        }
        let id = next_pi_rpc_id();
        write_rpc_locked(
            &mut stdin,
            &serde_json::json!({
                "id": id,
                "type": "prompt",
                "message": format!("/flowix-fork {entry_id}"),
            }),
        )
        .await?;
        tokio::time::timeout(PI_FORK_TIMEOUT, async {
            let mut line = String::new();
            loop {
                line.clear();
                if reader
                    .read_line(&mut line)
                    .await
                    .map_err(|error| error.to_string())?
                    == 0
                {
                    return Err("Pi fork process exited during the fork command".to_string());
                }
                let record: Value = serde_json::from_str(&line)
                    .map_err(|error| format!("Pi fork process returned invalid JSON: {error}"))?;
                if record.get("type").and_then(Value::as_str) == Some("response")
                    && record.get("id").and_then(Value::as_str) == Some(&id)
                {
                    if record.get("success").and_then(Value::as_bool) != Some(true) {
                        return Err(record
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("Pi rejected its fork command")
                            .to_string());
                    }
                    break Ok::<(), String>(());
                }
            }
        })
        .await
        .map_err(|_| "Pi fork command timed out".to_string())??;

        let result = tokio::time::timeout(PI_FORK_TIMEOUT, async {
            loop {
                if let Ok(bytes) = tokio::fs::read(&result_path).await {
                    let value: Value = serde_json::from_slice(&bytes)
                        .map_err(|error| format!("Pi fork returned invalid metadata: {error}"))?;
                    if let Some(error) = value.get("error").and_then(Value::as_str) {
                        return Err(error.to_string());
                    }
                    let fork: PiForkMetadata = serde_json::from_value(value).map_err(|error| {
                        format!("Pi fork returned incomplete metadata: {error}")
                    })?;
                    if fork.session_id.trim().is_empty() || fork.session_id == expected_source_id {
                        return Err("Pi fork did not create a new session ID".into());
                    }
                    if fork.parent_session_file != source_file {
                        return Err("Pi fork did not retain its native parent session".into());
                    }
                    if !fork.branch_entry_ids.iter().any(|id| id == entry_id) {
                        return Err(
                            "Pi fork did not retain the selected entry in its branch".into()
                        );
                    }
                    if !fork.session_file.starts_with(child_dir) {
                        return Err(
                            "Pi fork created its session outside the child session directory"
                                .into(),
                        );
                    }
                    if fork.session_file == source_file || !fork.session_file.is_file() {
                        return Err("Pi did not create an independent fork session".into());
                    }
                    return Ok(fork);
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .map_err(|_| "Pi fork did not report its new session".to_string())?;
        let _ = child.kill().await;
        let _ = child.wait().await;
        result
    }
    .await;

    let _ = std::fs::remove_file(&extension_path);
    let _ = std::fs::remove_file(&result_path);
    operation
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

fn pi_session_root() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        return crate::runtime_state::windows_state_dir().map(|root| root.join("pi-sessions"));
    }
    #[cfg(not(windows))]
    dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .map(|path| path.join("Flowix").join("pi-sessions"))
        .ok_or_else(|| "user data directory is unavailable".to_string())
}

fn resolve_pi_session_dir(thread_id: &str, create: bool) -> Result<PathBuf, String> {
    let path = pi_session_dir(thread_id)?;
    if create {
        std::fs::create_dir_all(&path)
            .map_err(|error| format!("cannot create Pi session directory: {error}"))?;
    }
    Ok(path)
}

fn pi_message_matches(left: &Value, right: &Value) -> bool {
    left == right
}

#[cfg(test)]
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

#[cfg(test)]
fn attach_pi_session_message_ids(
    messages: &mut Vec<Value>,
    entries: &[Value],
    leaf_id: Option<&str>,
) -> Result<(), String> {
    attach_pi_session_message_ids_impl(messages, entries, leaf_id, false)
}

fn attach_pi_session_message_ids_with_pending_tail(
    messages: &mut Vec<Value>,
    entries: &[Value],
    leaf_id: Option<&str>,
    allow_pending_tail: bool,
) -> Result<(), String> {
    attach_pi_session_message_ids_impl(messages, entries, leaf_id, allow_pending_tail)
}

fn attach_pi_session_message_ids_impl(
    messages: &mut Vec<Value>,
    entries: &[Value],
    leaf_id: Option<&str>,
    allow_pending_tail: bool,
) -> Result<(), String> {
    let branch = pi_active_branch_entries(entries, leaf_id)?;
    let mut entry_index = 0;
    let mut first_unmatched_renderable = None;
    let mut unmatched_renderable_messages = 0;
    for (message_index, message) in messages.iter_mut().enumerate() {
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
                first_unmatched_renderable.get_or_insert(message_index);
                unmatched_renderable_messages += 1;
            }
            continue;
        };
        if first_unmatched_renderable.is_some() {
            return Err(
                "Pi history contains an unmatched message before a later committed message".into(),
            );
        }
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
        if allow_pending_tail {
            if let Some(start) = first_unmatched_renderable {
                messages.truncate(start);
                return Ok(());
            }
        }
        return Err(format!(
            "Pi returned {unmatched_renderable_messages} history messages that could not be reconciled with native ids on the active session branch"
        ));
    }
    Ok(())
}

pub(crate) fn resolve_pi_binary(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let target = pi_runtime_target().ok_or_else(|| {
        format!(
            "Pi runtime is not bundled for {}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    let executable = if cfg!(windows) { "pi.exe" } else { "pi" };
    let mut roots = Vec::new();

    if let Ok(resources) = app.path().resource_dir() {
        roots.push(resources.join("pi").join(&target));
    }
    #[cfg(debug_assertions)]
    roots.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.build/pi-runtime/resources")
            .join(&target),
    );

    for root in roots {
        for candidate in [root.join("dist").join(executable), root.join(executable)] {
            if crate::agent_external::cli_resolver::is_executable_file(&candidate) {
                return Ok(candidate);
            }
        }
    }

    Err(format!(
        "Bundled Pi runtime is missing or not executable for {target}"
    ))
}

/// Bundled runtime target directory name, e.g. `darwin-arm64`.
fn pi_runtime_target() -> Option<String> {
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "windows",
        "linux" => "linux",
        _ => return None,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => return None,
    };
    Some(format!("{platform}-{arch}"))
}

/// Directory of the Pi packages vendored next to the bundled runtime
/// (`pi-agent` inside the staged Pi resource, written by
/// `scripts/prepare-pi-bundle.mjs`). Returns `None` when the staged runtime
/// predates package vendoring; in development re-run
/// `npm run tauri:dev:pi` to restage.
pub(super) fn resolve_pi_agent_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let target = pi_runtime_target()?;
    let mut roots = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        roots.push(resources.join("pi").join(&target));
    }
    #[cfg(debug_assertions)]
    roots.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.build/pi-runtime/resources")
            .join(&target),
    );
    roots
        .into_iter()
        .map(|root| root.join("pi-agent"))
        .find(|dir| dir.is_dir())
}

#[cfg(test)]
mod tests {
    use super::{
        attach_pi_session_message_ids, pi_active_branch_entries, pi_rpc_message_id,
        pi_tools_for_permission_mode, receive_rpc_response,
        run_startup_cloud_credential_refresh_once, run_startup_cloud_refresh_once,
        CloudRefreshResults,
    };
    use crate::agent_external::pi::shell::{PiCapabilities, ShellKind};
    use serde_json::json;

    fn capabilities(shell: ShellKind, ripgrep: bool, fd: bool) -> PiCapabilities {
        PiCapabilities { shell, ripgrep, fd }
    }

    #[test]
    fn full_access_asks_for_the_platform_shell_tool() {
        let bash = pi_tools_for_permission_mode(
            Some("danger-full-access"),
            capabilities(ShellKind::Bash, false, false),
        );
        assert!(bash.split(',').any(|tool| tool == "bash"), "{bash}");

        let powershell = pi_tools_for_permission_mode(
            Some("danger-full-access"),
            capabilities(ShellKind::PowerShell, false, false),
        );
        assert!(powershell.split(',').any(|tool| tool == "powershell"));
        assert!(!powershell.split(',').any(|tool| tool == "bash"));

        let shellless =
            pi_tools_for_permission_mode(None, capabilities(ShellKind::None, false, false));
        assert!(!shellless.split(',').any(|tool| tool == "bash"));
        assert!(!shellless.split(',').any(|tool| tool == "powershell"));
    }

    #[test]
    fn read_only_mode_stays_useful_without_a_shell() {
        let tools = pi_tools_for_permission_mode(
            Some("read-only"),
            capabilities(ShellKind::Bash, true, true),
        );
        let parsed: Vec<&str> = tools.split(',').collect();
        assert_eq!(parsed, vec!["read", "ls", "grep", "find"]);
    }

    #[test]
    fn search_tools_are_omitted_when_rg_and_fd_are_missing() {
        let tools = pi_tools_for_permission_mode(
            Some("read-only"),
            capabilities(ShellKind::Bash, false, false),
        );
        assert_eq!(tools, "read,ls");
        // Pi's grep/find try to download from GitHub when the binary is absent,
        // so a partial availability must be handled per tool.
        let partial = pi_tools_for_permission_mode(
            Some("read-only"),
            capabilities(ShellKind::Bash, true, false),
        );
        assert_eq!(partial, "read,ls,grep");
    }

    #[test]
    fn write_modes_keep_the_edit_tools_and_drop_the_shell_when_unavailable() {
        let write = pi_tools_for_permission_mode(
            Some("workspace-write"),
            capabilities(ShellKind::Bash, false, false),
        );
        assert_eq!(write, "read,ls,edit,write");
        let legacy =
            pi_tools_for_permission_mode(None, capabilities(ShellKind::None, false, false));
        assert_eq!(legacy, "read,ls,edit,write");
    }

    #[tokio::test]
    async fn startup_cloud_refresh_coalesces_failures_and_allows_retry() {
        use std::collections::HashMap;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use tokio::sync::Mutex;

        let results = Arc::new(Mutex::new(HashMap::new()));
        let refresh_count = Arc::new(AtomicUsize::new(0));
        let run = |results: Arc<Mutex<CloudRefreshResults>>, refresh_count: Arc<AtomicUsize>| async move {
            run_startup_cloud_refresh_once(&results, 7, || async move {
                refresh_count.fetch_add(1, Ordering::SeqCst);
                tokio::task::yield_now().await;
                Err("credential refresh failed".to_string())
            })
            .await
        };

        let (first, concurrent) = tokio::join!(
            run(results.clone(), refresh_count.clone()),
            run(results.clone(), refresh_count.clone()),
        );
        assert_eq!(first, Err("credential refresh failed".to_string()));
        assert_eq!(concurrent, Err("credential refresh failed".to_string()));
        assert_eq!(refresh_count.load(Ordering::SeqCst), 1);

        let cached = run_startup_cloud_refresh_once(&results, 7, || async { Ok(true) }).await;
        assert_eq!(cached, Err("credential refresh failed".to_string()));
        assert_eq!(refresh_count.load(Ordering::SeqCst), 1);

        results.lock().await.get_mut(&7).unwrap().0 -= std::time::Duration::from_secs(3);
        let retried = run_startup_cloud_refresh_once(&results, 7, || async { Ok(true) }).await;
        assert_eq!(retried, Ok(true));

        let next_generation =
            run_startup_cloud_refresh_once(&results, 8, || async { Ok(true) }).await;
        assert_eq!(next_generation, Ok(true));
    }

    #[tokio::test]
    async fn startup_cloud_refresh_fetches_latest_catalog_once_even_if_credential_is_cached() {
        use std::collections::HashMap;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use tokio::sync::Mutex;

        let results = Mutex::new(HashMap::new());
        let credential_generation = Mutex::new(Some(7));
        let refresh_count = Arc::new(AtomicUsize::new(0));
        let count = refresh_count.clone();
        let refreshed = run_startup_cloud_credential_refresh_once(
            &results,
            &credential_generation,
            7,
            || async move {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;
        assert_eq!(refreshed, Ok(true));
        assert_eq!(refresh_count.load(Ordering::SeqCst), 1);

        let count = refresh_count.clone();
        let coalesced = run_startup_cloud_credential_refresh_once(
            &results,
            &credential_generation,
            7,
            || async move {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;
        assert_eq!(coalesced, Ok(true));
        assert_eq!(refresh_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn stderr_is_visible_before_eof_and_keeps_only_a_bounded_tail() {
        use std::sync::Arc;
        use tokio::io::AsyncWriteExt;
        use tokio::sync::Mutex;
        let (mut writer, reader) = tokio::io::duplex(4096);
        let captured = Arc::new(Mutex::new(String::new()));
        let task = tokio::spawn(super::capture_pi_stderr(reader, captured.clone()));
        writer.write_all(b"startup diagnostic").await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if captured.lock().await.contains("startup diagnostic") {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(
            !task.is_finished(),
            "diagnostics must be visible before EOF"
        );
        writer
            .write_all(&vec![b'x'; super::PI_STDERR_TAIL_BYTES * 2])
            .await
            .unwrap();
        writer.write_all("最新错误".as_bytes()).await.unwrap();
        drop(writer);
        task.await.unwrap().unwrap();
        let text = captured.lock().await;
        assert!(text.ends_with("最新错误"));
        assert!(text.len() <= super::PI_STDERR_TAIL_BYTES);
        assert!(!text.contains("startup diagnostic"));
    }
    #[tokio::test]
    async fn pi_queue_rebuild_keeps_duplicate_message_attachments_with_the_right_item() {
        use super::{known_pi_queue_payloads, pi_queue_target_index, ActivePiRun, PiQueuedMessage};
        use std::collections::HashMap;
        use std::sync::atomic::{AtomicBool, AtomicI64};
        use std::sync::Arc;
        use tokio::sync::{Mutex, Notify};

        let first = PiQueuedMessage {
            command_type: "follow_up",
            payload: json!({"message":"same text","images":[{"data":"first"}]}),
            sequence: 1,
            display_text: "first".into(),
            attachments: Vec::new(),
        };
        let second = PiQueuedMessage {
            command_type: "follow_up",
            payload: json!({"message":"same text","images":[{"data":"second"}]}),
            sequence: 2,
            display_text: "second".into(),
            attachments: Vec::new(),
        };
        let active = ActivePiRun {
            run_id: "test".into(),
            started_at: 0,
            session: Mutex::new(None),
            session_state: tokio::sync::watch::channel(None).0,
            session_id: Mutex::new(None),
            queued_messages: Mutex::new(HashMap::from([
                ("first".into(), first.clone()),
                ("second".into(), second.clone()),
            ])),
            queue_lock: Mutex::new(()),
            stop_notify: Notify::new(),
            last_event_at: AtomicI64::new(0),
            stop_reason: Mutex::new(None),
            finalizing: AtomicBool::new(false),
            stream_end_emitted: Arc::new(AtomicBool::new(false)),
        };
        let texts = vec!["same text".to_string(), "same text".to_string()];
        assert_eq!(
            pi_queue_target_index(&active, &texts, &second).await,
            Some(1)
        );
        let mut known =
            known_pi_queue_payloads(&active, &[], &["same text".to_string()], Some("first")).await;
        let payloads = super::queued_payloads("follow_up", &["same text".to_string()], &mut known);
        assert_eq!(payloads[0]["images"][0]["data"], "second");
        let delivered = active.take_queued_user_message("same text").await.unwrap();
        assert_eq!(delivered.client_message_id.as_deref(), Some("first"));
        assert_eq!(delivered.text, "first");
        assert_eq!(
            super::pi_user_message_text(&json!({
                "role": "user",
                "content": [{"type": "text", "text": "same text"}]
            })),
            "same text"
        );
    }

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
