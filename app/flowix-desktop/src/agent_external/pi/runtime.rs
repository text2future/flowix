use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex, OwnedMutexGuard};
use tokio::time::Duration;

use super::super::lifecycle::ExternalLifecycleEmitter;
use super::super::{
    persist_and_emit_external_chunk, resolve_and_freeze_runtime_cwd, resolve_run_id,
    AgentChunkMetadata, USER_STOPPED_REASON,
};
use super::cloud_context::PiCloudContext;
use super::shell;
use super::skill_resources::{self, PiStartupResources};
use super::AGENT_TYPE;
use crate::agent_session::ThreadManager;
use crate::agent_wire::{AgentChunk, AgentMessageAttachment, AgentUserMessage, RunInfo, UsageInfo};

mod cloud;
mod queue;
mod session;

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
struct PiWebToolsLaunch {
    base_url: String,
    token: String,
}

fn web_tools_launch(enabled: bool, api_base: &str) -> Result<Option<PiWebToolsLaunch>, String> {
    if !enabled || api_base.is_empty() {
        return Ok(None);
    }
    let Some(token) = super::config::cloud_model_credential_key()? else {
        return Ok(None);
    };
    Ok(Some(PiWebToolsLaunch {
        base_url: format!("{}/v1/ai", api_base.trim_end_matches('/')),
        token,
    }))
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PiSessionConfig {
    cwd: PathBuf,
    tools: String,
    code_mode: bool,
    tool_search: bool,
    web_tools: Option<PiWebToolsLaunch>,
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

#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PiSessionStats {
    pub session_id: Option<String>,
    /// Most recent assistant model, recovered from Pi's native session history.
    pub model: Option<String>,
    pub tokens: PiSessionTokenStats,
    pub cost: Option<f64>,
    pub context_usage: Option<PiSessionContextUsage>,
}

#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PiSessionTokenStats {
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub cache_read: Option<u64>,
    pub cache_write: Option<u64>,
    pub total: Option<u64>,
}

#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PiSessionContextUsage {
    pub tokens: Option<u64>,
    pub context_window: Option<u64>,
    pub percent: Option<f64>,
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

    async fn session_stats(&self) -> Result<PiSessionStats, String> {
        let request_id = format!("flowix-stats-{}", next_pi_rpc_id());
        let request = serde_json::json!({"id": request_id, "type": "get_session_stats"});
        let response = self.request(&request_id, &request).await?;
        let data = response
            .get("data")
            .cloned()
            .ok_or("Pi get_session_stats response did not include data")?;
        serde_json::from_value(data)
            .map_err(|error| format!("invalid Pi get_session_stats response: {error}"))
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

/// Pi tool results use a `{ content: [...blocks], details: {...} }` envelope.
/// Product rendering consumes one text payload per tool row, so flatten the
/// text blocks in the runtime. Doing it here (instead of only in the frontend)
/// keeps the live stream and the persisted history projection identical: the
/// frontend would otherwise stringify the raw envelope for a live result and
/// then swap to flattened text as soon as history replaces the row.
///
/// `is_error` mirrors Pi's own `tool_execution_end.isError`; it travels with
/// the content so both projection paths agree on whether the row failed.
fn pi_tool_result_value(result: Option<&Value>, is_error: bool) -> Value {
    let text = match result {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Object(object)) => match object.get("content") {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Array(blocks)) => blocks
                .iter()
                .filter_map(|block| match block {
                    Value::String(text) => Some(text.clone()),
                    _ => block
                        .get("text")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .or_else(|| {
                            (block.get("type").and_then(Value::as_str) == Some("image"))
                                .then(|| "[Image attachment]".to_string())
                        }),
                })
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        },
        _ => String::new(),
    };
    json!({ "content": text, "is_error": is_error })
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
    pub(super) cloud_context: OnceLock<PiCloudContext>,
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
            cloud_context: OnceLock::new(),
        }
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
        let mut provider = message
            .provider_id_for_runtime(AGENT_TYPE)
            .map(str::to_owned);
        if provider.as_deref() == Some("__flowix-cloud-preview") {
            let context = self.cloud_or_err()?;
            if !context
                .sync()
                .state()
                .map_err(|error| error.to_string())?
                .authenticated
            {
                return Err("请先登录 Flowix 账号后使用 Cloud 模型".to_string());
            }
            let api_base = context.api_base().to_string();
            self.connect_cloud_model_provider(app, &api_base).await?;
            provider = Some(
                super::config::list()?
                    .into_iter()
                    .find(|provider| provider.source.as_deref() == Some("flowix-cloud"))
                    .ok_or_else(|| "Cloud models are unavailable".to_string())?
                    .id,
            );
        }
        let permission_mode = message.permission_mode_for_runtime(AGENT_TYPE);
        let pi_features = super::config::features()?;
        let runtime_model =
            runtime_model.filter(|value| !value.trim().is_empty() && value != "inherit");
        // 未注入时为空串：Cloud 分支已在上面报错，本地模型不受影响。
        let cloud_api_base = self
            .cloud_context_opt()
            .map(|context| context.api_base().to_string())
            .unwrap_or_default();
        let model_cloud_auth_generation = self
            .ensure_cloud_credential(app, provider.as_deref(), &cloud_api_base)
            .await?;
        let web_search_auth_generation = if pi_features.web_search {
            match self.ensure_web_search_credential(app, &cloud_api_base).await {
                Ok(generation) => generation,
                Err(error) => {
                    tracing::warn!("could not prepare Pi web search credential: {error}");
                    None
                }
            }
        } else {
            None
        };
        let cloud_auth_generation = model_cloud_auth_generation.or(web_search_auth_generation);
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
            web_tools: web_tools_launch(web_search_auth_generation.is_some(), &cloud_api_base)?,
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
        let mut last_assistant_error: Option<String> = None;
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
                let is_error = value
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let chunk = AgentChunk::ToolResult {
                    thread_id: thread_id.to_string(),
                    id: tool_call_id.to_string(),
                    name: value
                        .get("toolName")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string(),
                    result: pi_tool_result_value(value.get("result"), is_error),
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
                    if completed_message.get("role").and_then(Value::as_str) == Some("assistant") {
                        last_assistant_error =
                            if completed_message.get("stopReason").and_then(Value::as_str)
                                == Some("error")
                            {
                                completed_message
                                    .get("errorMessage")
                                    .and_then(Value::as_str)
                                    .filter(|message| !message.is_empty())
                                    .map(str::to_owned)
                            } else {
                                None
                            };
                        // Only surface the final failure after Pi has settled, not intermediate retries.
                        if last_assistant_error.is_some() {
                            continue;
                        }
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
            if let Some(error) = last_assistant_error {
                session.touch();
                return Err(error);
            }
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
    let app_directory = if option_env!("FLOWIX_DEV_MODE") == Some("1") {
        "Flowix Dev"
    } else {
        "Flowix"
    };
    if let Some(path) = dirs::config_dir() {
        return Ok(path.join(app_directory).join("pi"));
    }
    dirs::home_dir()
        .map(|path| {
            let config_directory = if option_env!("FLOWIX_DEV_MODE") == Some("1") {
                ".flowix-dev"
            } else {
                ".flowix"
            };
            path.join(config_directory).join("pi")
        })
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
        let is_dev_build = option_env!("FLOWIX_DEV_MODE") == Some("1");
        return crate::runtime_state::windows_state_dir().map(|root| {
            root.join(if is_dev_build {
                "pi-sessions-dev"
            } else {
                "pi-sessions"
            })
        });
    }
    #[cfg(not(windows))]
    {
        let app_directory = if option_env!("FLOWIX_DEV_MODE") == Some("1") {
            "Flowix Dev"
        } else {
            "Flowix"
        };
        dirs::data_local_dir()
            .or_else(dirs::home_dir)
            .map(|path| path.join(app_directory).join("pi-sessions"))
            .ok_or_else(|| "user data directory is unavailable".to_string())
    }
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
    let mut matched_summaries = std::collections::HashSet::new();
    for (message_index, message) in messages.iter_mut().enumerate() {
        // Pi synthesizes summaries from non-message entries. A compaction
        // summary precedes retained messages in the context even though its
        // entry follows them in the journal, so it must not advance the
        // ordinary message cursor.
        let summary_type = match message.get("role").and_then(Value::as_str) {
            Some("compactionSummary") => Some("compaction"),
            Some("branchSummary") => Some("branch_summary"),
            _ => None,
        };
        if let Some(summary_type) = summary_type {
            let matched = branch.iter().enumerate().find(|(index, entry)| {
                !matched_summaries.contains(index)
                    && entry.get("type").and_then(Value::as_str) == Some(summary_type)
                    && entry.get("summary").and_then(Value::as_str).is_some()
                    && entry.get("summary") == message.get("summary")
                    && entry.get("timestamp").and_then(Value::as_str)
                        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                        .map(|value| value.timestamp_millis())
                        == message.get("timestamp").and_then(Value::as_i64)
                    && message.get("timestamp").and_then(Value::as_i64).is_some()
            });
            if let Some((index, entry)) = matched {
                if first_unmatched_renderable.is_some() {
                    return Err("Pi history contains an unmatched message before a later committed message".into());
                }
                matched_summaries.insert(index);
                if let Some(object) = message.as_object_mut() {
                    if let Some(id) = entry.get("id").and_then(Value::as_str) {
                        object.insert("_pi_session_message_id".into(), Value::String(id.into()));
                    }
                    if let Some(parent_id) = entry.get("parentId").and_then(Value::as_str) {
                        object.insert("_pi_session_parent_id".into(), Value::String(parent_id.into()));
                    }
                }
                continue;
            }
        }
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
mod tests;
