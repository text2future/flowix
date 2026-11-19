//! Long-lived Codex app-server runtime.
//!
//! The app-server protocol is JSON-RPC over JSONL on stdio. A single server
//! owns many Codex threads and turns, so Flowix keeps the process connection
//! separately from the per-thread run registry.

mod history_projection;
mod tool_items;
mod chat;
mod connection;
mod control;
mod project;
mod queue;
mod run;
mod threads;
use history_projection::*;
use tool_items::{
    codex_custom_tool_message_type, codex_tool_call_identity, codex_tool_call_input,
    codex_tool_result_identity, codex_tool_result_value, is_custom_tool_call_item,
};

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex, OwnedMutexGuard};

use super::command::build_codex_entrypoint;
use super::{parse_codex_version, AGENT_TYPE};
use crate::agent_external::lifecycle::ExternalLifecycleEmitter;
use crate::agent_external::{
    emit_chunk_with_run_id, emit_chunk_with_run_id_and_metadata, AgentChunkMetadata,
    USER_STOPPED_REASON,
};
use crate::agent_session::{ChatMessage, ThreadInfo, ThreadManager, ThreadMessagesPage};
use crate::agent_types::AgentId;
use crate::agent_wire::{AgentChunk, AgentMessageAttachment, AgentUserMessage};

const INITIALIZE_METHOD: &str = "initialize";
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const MAX_PENDING_TURN_NOTIFICATIONS: usize = 4096;
const CONTEXT_COMPACTION_MESSAGE_TYPE: &str = "context-compaction";
const CODEX_COMMAND_MESSAGE_TYPE: &str = "codex-command";
const CODEX_COMMENTARY_MESSAGE_TYPE: &str = "agent-commentary";
const CODEX_MISSING_USER_ITEM_ID: &str = "flowix:codex:missing-user-item";
const MIN_PAGINATED_CODEX_VERSION: &str = "0.150.0";

fn codex_turn_error_message_id(turn_id: &str) -> String {
    format!("msg:codex:turn-error:{turn_id}")
}

fn codex_command_message_id(turn_id: Option<&str>, source_id: &str) -> String {
    match turn_id.filter(|id| !id.trim().is_empty()) {
        Some(turn_id) => format!("flowix:codex:command:{turn_id}"),
        // History has no shared turn key for older records that omit turn IDs.
        None => format!("flowix:codex:command:unbound:{source_id}"),
    }
}

fn codex_tool_call_message_id(turn_id: Option<&str>, call_id: &str) -> String {
    format!(
        "flowix:codex:tool-call:{}:{call_id}",
        turn_id
            .filter(|id| !id.trim().is_empty())
            .unwrap_or("unbound")
    )
}

fn codex_custom_tool_output_message_id(turn_id: Option<&str>, call_id: &str) -> String {
    format!(
        "flowix:codex:tool-output:{}:{call_id}",
        turn_id
            .filter(|id| !id.trim().is_empty())
            .unwrap_or("unbound")
    )
}

fn codex_fallback_item_message_id(
    turn_id: &str,
    role: &str,
    content: &str,
    occurrence: usize,
) -> String {
    let mut first = 0x811c_9dc5_u32;
    let mut second = 0x9e37_79b9_u32;
    for byte in content.as_bytes() {
        first = (first ^ u32::from(*byte)).wrapping_mul(0x0100_0193);
        second = (second ^ u32::from(*byte)).wrapping_mul(0x85eb_ca6b);
    }
    format!("flowix:codex:item:{turn_id}:{role}:{first:08x}{second:08x}:{occurrence}")
}

fn codex_turn_error_metadata(turn_id: Option<&str>) -> AgentChunkMetadata {
    let Some(turn_id) = turn_id.filter(|id| !id.trim().is_empty()) else {
        return AgentChunkMetadata::default();
    };
    AgentChunkMetadata {
        codex_turn_id: Some(turn_id.to_string()),
        message_id: Some(codex_turn_error_message_id(turn_id)),
        ..AgentChunkMetadata::default()
    }
}

fn is_stale_queued_submission_error(error: &str) -> bool {
    error
        .to_ascii_lowercase()
        .contains("queued submission not found")
}

fn is_queue_start_conflict_error(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    is_stale_queued_submission_error(&error)
        || error.contains("thread already has an active or pending turn")
        || error.contains("codex already has an active turn")
}

fn codex_user_input(message: &AgentUserMessage) -> Vec<Value> {
    let mut input = vec![json!({
        "type": "text",
        "text": message.llm_content.clone().unwrap_or_else(|| message.content.clone()),
    })];
    input.extend(
        message
            .image_paths
            .iter()
            .filter(|path| std::path::Path::new(path).is_file())
            .filter(|path| is_image_attachment(path))
            .map(|path| json!({ "type": "localImage", "path": path })),
    );
    let attached_files = message
        .image_paths
        .iter()
        .filter(|path| std::path::Path::new(path).is_file())
        .filter(|path| !is_image_attachment(path))
        .map(|path| format!("- {path}"))
        .collect::<Vec<_>>();
    if !attached_files.is_empty() {
        input.push(json!({
            "type": "text",
            "text": format!("\n<attached_files>\n{}\n</attached_files>", attached_files.join("\n")),
        }));
    }
    input
}

fn is_image_attachment(path: &str) -> bool {
    matches!(
        std::path::Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "gif")
    )
}

struct Connection {
    _child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    generation: u64,
}

#[derive(Clone)]
struct ActiveTurn {
    flowix_thread_id: String,
    run_id: String,
    /// Present when Codex started this turn directly from its Follow-up queue.
    client_user_message_id: Option<String>,
    codex_thread_id: String,
    codex_turn_id: String,
    binding: TurnBinding,
    /// Turn-scoped notifications can beat the `turn/start` response. Ordinary
    /// chats keep them here until that response supplies the authoritative id.
    pending_notifications: Vec<Value>,
    dropped_notifications: u64,
    turn_ready: Arc<tokio::sync::Notify>,
    /// The UI can stop a native command before Codex announces its provider
    /// turn. Keep the registry entry until that turn id arrives so the
    /// notification path can interrupt the real provider work.
    cancel_requested: bool,
    stopping: bool,
    /// Present only for a Codex-native slash command. `/compact` and goal
    /// mutations keep this active until the provider's follow-up turn ends.
    command_id: Option<String>,
    command: Option<String>,
    app_handle: tauri::AppHandle,
    started_at: i64,
    last_event_at: i64,
    stream_end_emitted: Arc<AtomicBool>,
    /// Completed agent item snapshots can be present both in
    /// `item/completed` and in the terminal turn payload. Keep the snapshots
    /// per active turn so the terminal payload remains a true fallback
    /// instead of a second delivery.
    completed_agent_messages: Arc<Mutex<Vec<SeenCompletedAgentMessage>>>,
    /// Runtime-owned receipts survive webview reloads until userMessage consumption.
    pending_steers: Vec<Value>,
}

#[derive(Clone)]
struct QueuedCodexFollowUp {
    flowix_thread_id: String,
    codex_thread_id: String,
    queued_submission_id: Option<String>,
    client_user_message_id: String,
    message: AgentUserMessage,
    run_id: String,
}

struct CompletedAgentMessageCandidate {
    id: Option<String>,
    text: String,
}

struct SeenCompletedAgentMessage {
    id: Option<String>,
    text: String,
    fallback_occurrence: Option<usize>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TurnBinding {
    /// An ordinary chat is bound only by its own `turn/start` response.
    StartResponse,
    /// Native asynchronous commands do not always return a turn id and must
    /// bind from their first `turn/started` notification.
    StartedNotification,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UnboundNotificationAction {
    Buffer,
    Bind,
    Ignore,
}

fn unbound_notification_action(
    binding: TurnBinding,
    method: &str,
    has_thread_and_turn: bool,
) -> UnboundNotificationAction {
    if !has_thread_and_turn || !turn_scoped_notification(method) {
        return UnboundNotificationAction::Ignore;
    }
    match binding {
        TurnBinding::StartResponse => UnboundNotificationAction::Buffer,
        TurnBinding::StartedNotification if method == "turn/started" => {
            UnboundNotificationAction::Bind
        }
        TurnBinding::StartedNotification => UnboundNotificationAction::Buffer,
    }
}

fn buffer_turn_notification(active: &mut ActiveTurn, message: &Value) {
    if active.pending_notifications.len() == MAX_PENDING_TURN_NOTIFICATIONS {
        active.dropped_notifications = active.dropped_notifications.saturating_add(1);
        if active.dropped_notifications.is_power_of_two() {
            tracing::warn!(
                thread_id = %active.flowix_thread_id,
                run_id = %active.run_id,
                dropped = active.dropped_notifications,
                limit = MAX_PENDING_TURN_NOTIFICATIONS,
                "Codex startup notification buffer overflow; oldest notifications dropped"
            );
        }
        active.pending_notifications.remove(0);
    }
    active.pending_notifications.push(message.clone());
}

/// Called under active_turns when registering ordinary work, so Stop cannot
/// fall between publishing a cancellation and registering the active turn.
fn take_pending_cancellation(
    pending: &mut HashMap<String, String>,
    thread_id: &str,
    run_id: &str,
) -> bool {
    pending
        .remove(thread_id)
        .is_some_and(|expected| expected == run_id)
}

struct Inner {
    thread_manager: Arc<ThreadManager>,
    connection: Mutex<Option<Connection>>,
    // Serialize the first connection attempt. `ensure_connection` is called
    // by thread, history, and model APIs and those calls can arrive
    // concurrently during startup; checking `connection` alone is not enough
    // to prevent spawning one app-server per caller.
    connection_start_lock: Mutex<()>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    pending_approvals: Mutex<Vec<CodexApprovalRequest>>,
    /// Stop may arrive after the web projection is marked pending but before
    /// the slash-command task has registered its ActiveTurn. Scope the
    /// cancellation to the command run id so an unrelated future command is
    /// not cancelled accidentally.
    pending_cancellations: Mutex<HashMap<String, String>>,
    app_handle: Mutex<Option<tauri::AppHandle>>,
    active_turns: Mutex<HashMap<String, ActiveTurn>>,
    /// Flowix queue entries awaiting Codex's automatic post-turn start.
    /// Codex owns the actual queue; this map only binds its next turn to the
    /// matching Flowix run and optimistic user message.
    queued_follow_ups: Mutex<HashMap<String, Vec<QueuedCodexFollowUp>>>,
    /// Serialize queue mutations and delivery decisions per Flowix thread,
    /// including calls from separate webviews.
    follow_up_operation_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Keep notification routing and buffered-event replay in one total order.
    notification_dispatch: Mutex<()>,
    latest_usage: Mutex<HashMap<String, crate::agent_types::UsageInfo>>,
    next_request_id: AtomicU64,
    next_connection_generation: AtomicU64,
}

pub struct CodexAppServerManager {
    inner: Arc<Inner>,
}

fn queued_follow_up_from_submission(
    flowix_thread_id: &str,
    codex_thread_id: &str,
    submission: &Value,
) -> Option<QueuedCodexFollowUp> {
    let client_user_message_id = submission
        .get("clientUserMessageId")
        .and_then(Value::as_str)?
        .to_string();
    let queued_submission_id = submission
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string);
    let input = submission.get("input").and_then(Value::as_array)?;
    let texts = input
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let content = texts.join("\n");
    let image_paths = input
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("localImage"))
        .filter_map(|item| item.get("path").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let run_id = crate::agent_external::resolve_run_id(flowix_thread_id, None);
    Some(QueuedCodexFollowUp {
        flowix_thread_id: flowix_thread_id.to_string(),
        codex_thread_id: codex_thread_id.to_string(),
        queued_submission_id,
        client_user_message_id,
        message: AgentUserMessage {
            content: content.clone(),
            display_content: None,
            llm_content: Some(content),
            image_paths,
            run_id: Some(run_id.clone()),
            system_reminder_directory: None,
            agent_type: Some(AGENT_TYPE.to_string()),
            runtime_config: None,
            permission_mode: None,
            codex_model: None,
            codex_reasoning_effort: None,
            conversation_title: None,
        },
        run_id,
    })
}

fn queued_follow_up_at_queue_head(
    flowix_thread_id: &str,
    codex_thread_id: &str,
    queue: &Value,
) -> Option<QueuedCodexFollowUp> {
    queue
        .get("data")
        .and_then(Value::as_array)
        .and_then(|submissions| submissions.first())
        .and_then(|submission| {
            queued_follow_up_from_submission(flowix_thread_id, codex_thread_id, submission)
        })
}

fn order_queued_follow_ups(items: &mut Vec<QueuedCodexFollowUp>, provider_order: &[String]) {
    let positions = provider_order
        .iter()
        .enumerate()
        .map(|(index, id)| (id.as_str(), index))
        .collect::<HashMap<_, _>>();
    let mut indexed = items.drain(..).enumerate().collect::<Vec<_>>();
    indexed.sort_by_key(|(original_index, item)| {
        match item
            .queued_submission_id
            .as_deref()
            .and_then(|id| positions.get(id).copied())
        {
            Some(provider_index) => (1, provider_index, *original_index),
            // An item missing from the provider queue may already have been
            // consumed and still be waiting for its `turn/started` event.
            // Keep those candidates before the live queue, in their prior
            // order, so that event can still claim the correct run.
            None if item.queued_submission_id.is_some() => (0, *original_index, 0),
            None => (2, *original_index, 0),
        }
    });
    items.extend(indexed.into_iter().map(|(_, item)| item));
}

async fn remember_queued_follow_ups(
    inner: &Arc<Inner>,
    flowix_thread_id: &str,
    codex_thread_id: &str,
    queue: &Value,
) {
    let Some(submissions) = queue.get("data").and_then(Value::as_array) else {
        return;
    };
    let mut provider_order = Vec::new();
    for submission in submissions {
        if let Some(id) = submission.get("id").and_then(Value::as_str) {
            provider_order.push(id.to_string());
        }
        if let Some(queued) =
            queued_follow_up_from_submission(flowix_thread_id, codex_thread_id, submission)
        {
            upsert_queued_follow_up(inner, queued).await;
        }
    }
    if let Some(items) = inner
        .queued_follow_ups
        .lock()
        .await
        .get_mut(codex_thread_id)
    {
        order_queued_follow_ups(items, &provider_order);
    }
}

async fn upsert_queued_follow_up(inner: &Arc<Inner>, queued: QueuedCodexFollowUp) {
    let mut by_thread = inner.queued_follow_ups.lock().await;
    let items = by_thread.entry(queued.codex_thread_id.clone()).or_default();
    if let Some(existing) = items.iter_mut().find(|item| {
        item.client_user_message_id == queued.client_user_message_id
            || (queued.queued_submission_id.is_some()
                && item.queued_submission_id == queued.queued_submission_id)
    }) {
        if existing.queued_submission_id.is_none() {
            existing.queued_submission_id = queued.queued_submission_id;
        }
        return;
    }
    items.push(queued);
}

async fn remove_queued_follow_up(
    inner: &Arc<Inner>,
    codex_thread_id: &str,
    queued_submission_id: Option<&str>,
    client_user_message_id: Option<&str>,
) {
    let mut by_thread = inner.queued_follow_ups.lock().await;
    let Some(items) = by_thread.get_mut(codex_thread_id) else {
        return;
    };
    items.retain(|item| {
        !(queued_submission_id.is_some_and(|id| item.queued_submission_id.as_deref() == Some(id))
            || client_user_message_id.is_some_and(|id| item.client_user_message_id == id))
    });
    if items.is_empty() {
        by_thread.remove(codex_thread_id);
    }
}

async fn lock_follow_up_operations(
    inner: &Arc<Inner>,
    flowix_thread_id: &str,
) -> OwnedMutexGuard<()> {
    let lock = {
        let mut locks = inner.follow_up_operation_locks.lock().await;
        locks
            .entry(flowix_thread_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    lock.lock_owned().await
}

async fn bind_automatically_started_queue_turn(
    inner: &Arc<Inner>,
    codex_thread_id: &str,
    codex_turn_id: &str,
) {
    let app_handle = inner.app_handle.lock().await.clone();
    let Some(app_handle) = app_handle else {
        return;
    };
    let queued = {
        let mut by_thread = inner.queued_follow_ups.lock().await;
        let Some(items) = by_thread.get_mut(codex_thread_id) else {
            return;
        };
        if items.is_empty() {
            return;
        }
        let queued = items.remove(0);
        if items.is_empty() {
            by_thread.remove(codex_thread_id);
        }
        queued
    };
    let started_at = chrono::Utc::now().timestamp_millis();
    let stream_end_emitted = Arc::new(AtomicBool::new(false));
    let completed_agent_messages = Arc::new(Mutex::new(Vec::new()));
    {
        let mut active_turns = inner.active_turns.lock().await;
        if active_turns
            .values()
            .any(|active| active.codex_thread_id == codex_thread_id)
        {
            drop(active_turns);
            // A separately tracked run already owns this provider thread.
            // Put the queue record back so the next matching start can claim it.
            inner
                .queued_follow_ups
                .lock()
                .await
                .entry(codex_thread_id.to_string())
                .or_default()
                .insert(0, queued);
            return;
        }
        active_turns.insert(
            queued.flowix_thread_id.clone(),
            ActiveTurn {
                flowix_thread_id: queued.flowix_thread_id.clone(),
                run_id: queued.run_id.clone(),
                client_user_message_id: Some(queued.client_user_message_id.clone()),
                codex_thread_id: codex_thread_id.to_string(),
                codex_turn_id: codex_turn_id.to_string(),
                binding: TurnBinding::StartedNotification,
                pending_notifications: Vec::new(),
                dropped_notifications: 0,
                turn_ready: Arc::new(tokio::sync::Notify::new()),
                cancel_requested: false,
                stopping: false,
                command_id: None,
                command: None,
                app_handle: app_handle.clone(),
                started_at,
                last_event_at: started_at,
                stream_end_emitted: stream_end_emitted.clone(),
                completed_agent_messages: completed_agent_messages.clone(),
                pending_steers: Vec::new(),
            },
        );
    }
    let manager = CodexAppServerManager {
        inner: inner.clone(),
    };
    manager
        .emit_stream_start(
            &app_handle,
            &queued.flowix_thread_id,
            &queued.message,
            &queued.run_id,
        )
        .await;
}


async fn write_inner(inner: &Arc<Inner>, message: Value) -> Result<(), String> {
    let stdin = inner
        .connection
        .lock()
        .await
        .as_ref()
        .map(|connection| connection.stdin.clone())
        .ok_or_else(|| "Codex app-server is not connected".to_string())?;
    let mut stdin = stdin.lock().await;
    let encoded = serde_json::to_string(&message).map_err(|error| error.to_string())?;
    stdin
        .write_all(encoded.as_bytes())
        .await
        .map_err(|error| format!("failed to write to Codex app-server: {error}"))?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(|error| format!("failed to delimit Codex app-server message: {error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("failed to flush Codex app-server input: {error}"))
}

async fn request_inner(inner: &Arc<Inner>, method: &str, params: Value) -> Result<Value, String> {
    let id = inner.next_request_id.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = oneshot::channel();
    inner.pending.lock().await.insert(id, sender);
    if let Err(error) = write_inner(
        inner,
        json!({ "id": id, "method": method, "params": params }),
    )
    .await
    {
        inner.pending.lock().await.remove(&id);
        return Err(error);
    }
    match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(format!(
            "Codex app-server closed before responding to {method}"
        )),
        Err(_) => {
            inner.pending.lock().await.remove(&id);
            Err(format!("Codex app-server timed out responding to {method}"))
        }
    }
}

fn codex_command_result_text(command: &str, result: &Value) -> Option<String> {
    if !command
        .trim_start()
        .to_ascii_lowercase()
        .starts_with("/goal")
    {
        return None;
    }
    let goal = result.get("goal").unwrap_or(&Value::Null);
    if goal.is_null() {
        return Some("No Codex goal is currently set".to_string());
    }
    let objective = goal
        .get("objective")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let status = goal
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("active");
    if objective.is_empty() {
        return Some(format!("Codex goal: {status}"));
    }
    Some(format!("{objective} ({status})"))
}

fn is_codex_compact_command(command: &str) -> bool {
    command.trim().eq_ignore_ascii_case("/compact")
}

/// Codex applies a goal mutation immediately, then starts/resumes the goal's
/// autonomous work. The `thread/goal/set` response therefore does not mark
/// the user-visible operation complete; its following provider turn does.
/// `/goal` (get) and `/goal clear` only read or clear state and do not start a
/// provider turn.
fn is_codex_goal_mutation_command(command: &str) -> bool {
    let trimmed = command.trim();
    let lower = trimmed.to_ascii_lowercase();
    let Some(rest) = lower
        .strip_prefix("/goal")
        .filter(|rest| rest.chars().next().is_none_or(char::is_whitespace))
    else {
        return false;
    };
    let rest = rest.trim();
    !rest.is_empty() && !rest.eq_ignore_ascii_case("get") && !rest.eq_ignore_ascii_case("clear")
}

async fn verify_paginated_codex_version() -> Result<(), String> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        build_codex_entrypoint().arg("--version").output(),
    )
    .await
    .map_err(|_| "Timed out reading Codex CLI version".to_string())?
    .map_err(|error| format!("Unable to read Codex CLI version: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = if stdout.trim().is_empty() {
        stderr.trim()
    } else {
        stdout.trim()
    };
    let version = text
        .split_whitespace()
        .find_map(|part| parse_codex_version(part.trim_start_matches('v')))
        .ok_or_else(|| format!("Unable to parse Codex CLI version from `{text}`"))?;
    let minimum = parse_codex_version(MIN_PAGINATED_CODEX_VERSION)
        .expect("minimum Codex version must be valid");
    if version < minimum {
        return Err(format!(
            "Flowix paginated history requires Codex CLI {MIN_PAGINATED_CODEX_VERSION} or newer (installed: {text}). Update with `npm install -g @openai/codex@latest --force --include=optional`."
        ));
    }
    Ok(())
}

#[async_trait::async_trait]
impl ExternalLifecycleEmitter for CodexAppServerManager {
    fn lifecycle_agent_type(&self) -> &'static str {
        AGENT_TYPE
    }
    async fn emit_and_persist_lifecycle_chunk(
        &self,
        app: &tauri::AppHandle,
        chunk: &AgentChunk,
        run_id: &str,
    ) {
        emit_chunk_with_run_id(app, chunk, AGENT_TYPE, run_id);
    }
}

async fn read_loop(
    inner: Arc<Inner>,
    stdin: Arc<Mutex<ChildStdin>>,
    mut reader: BufReader<tokio::process::ChildStdout>,
    generation: u64,
) {
    let mut line = String::new();
    loop {
        line.clear();
        let Ok(bytes) = reader.read_line(&mut line).await else {
            break;
        };
        if bytes == 0 {
            break;
        }
        let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if let Some(id) = message.get("id") {
            if let Some(id_number) = id.as_u64() {
                if let Some(sender) = inner.pending.lock().await.remove(&id_number) {
                    let result = message
                        .get("error")
                        .map(|error| {
                            Err(error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("Codex app-server request failed")
                                .to_string())
                        })
                        .unwrap_or_else(|| {
                            Ok(message.get("result").cloned().unwrap_or(Value::Null))
                        });
                    let _ = sender.send(result);
                    continue;
                }
            }
            if let Some(method) = message.get("method").and_then(Value::as_str) {
                if is_user_decision_request(method) {
                    let request_id = id.to_string();
                    let params = message.get("params").cloned().unwrap_or(Value::Null);
                    let codex_thread_id = request_context(&params, "threadId");
                    let flowix_thread_id = if let Some(codex_thread_id) = codex_thread_id.as_deref()
                    {
                        inner
                            .active_turns
                            .lock()
                            .await
                            .values()
                            .find(|turn| turn.codex_thread_id == codex_thread_id)
                            .map(|turn| turn.flowix_thread_id.clone())
                    } else {
                        None
                    };
                    let request = CodexApprovalRequest {
                        request_id,
                        method: method.to_string(),
                        flowix_thread_id,
                        thread_id: codex_thread_id,
                        turn_id: request_context(&params, "turnId"),
                        item_id: request_context(&params, "itemId"),
                        params,
                    };
                    if let Some(app) = inner.app_handle.lock().await.clone() {
                        inner.pending_approvals.lock().await.push(request.clone());
                        if let Err(error) = app.emit("codex-approval-request", request) {
                            tracing::warn!("failed to emit Codex approval request: {error}");
                        }
                    } else {
                        write_server_response(&stdin, id, server_decline_result(method)).await;
                    }
                } else {
                    write_server_error(&stdin, id, method).await;
                }
            }
            continue;
        }
        dispatch_notification(&inner, &message).await;
    }
    close_connection(&inner, generation).await;
}

async fn close_connection(inner: &Arc<Inner>, generation: u64) {
    // Keep the connection visible while termination is unconfirmed. Removing it
    // first would allow another app-server to start while the old one still owns
    // native turns, and would release every active run prematurely.
    let mut current = inner.connection.lock().await;
    let Some(connection) = current
        .as_mut()
        .filter(|connection| connection.generation == generation)
    else {
        return;
    };
    if let Err(error) = connection._child.kill().await {
        tracing::warn!("[CodexAppServer] app-server kill request failed: {error}");
    }
    match tokio::time::timeout(std::time::Duration::from_secs(5), connection._child.wait()).await {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => {
            tracing::warn!("[CodexAppServer] app-server exit unconfirmed: {error}");
            return;
        }
        Err(_) => {
            tracing::warn!("[CodexAppServer] timed out waiting for app-server exit");
            return;
        }
    }
    current.take();
    let pending = std::mem::take(&mut *inner.pending.lock().await);
    inner.pending_approvals.lock().await.clear();
    let active = std::mem::take(&mut *inner.active_turns.lock().await);
    drop(current);
    let manager = CodexAppServerManager {
        inner: inner.clone(),
    };
    let error = "Codex app-server connection closed".to_string();
    for (_, turn) in active {
        if turn.stream_end_emitted.load(Ordering::Acquire) {
            continue;
        }
        if let (Some(command_id), Some(command)) =
            (turn.command_id.as_deref(), turn.command.as_deref())
        {
            manager
                .emit_codex_command(
                    &turn.app_handle,
                    &turn.flowix_thread_id,
                    &turn.run_id,
                    command_id,
                    command,
                    turn.started_at,
                    "error",
                    Some(error.clone()),
                )
                .await;
        }
        manager
            .emit_run_error(
                &turn.app_handle,
                &turn.flowix_thread_id,
                error.clone(),
                &turn.run_id,
            )
            .await;
        manager
            .emit_stream_end(
                &turn.app_handle,
                &turn.flowix_thread_id,
                &turn.run_id,
                Some(error.clone()),
                &turn.stream_end_emitted,
            )
            .await;
    }
    // Wake request callers only after the run's terminal events are emitted.
    // Their error paths inspect stream_end_emitted before reporting an error.
    for (_, sender) in pending {
        let _ = sender.send(Err(error.clone()));
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexApprovalRequest {
    pub request_id: String,
    pub method: String,
    pub flowix_thread_id: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub params: Value,
}

fn is_user_decision_request(method: &str) -> bool {
    matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
    )
}

fn server_decline_result(method: &str) -> Value {
    if method == "item/permissions/requestApproval" {
        json!({ "permissions": {}, "scope": "turn", "strictAutoReview": null })
    } else {
        json!({ "decision": "decline" })
    }
}

fn request_context(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(Value::as_str).map(str::to_string)
}

async fn write_server_response(stdin: &Arc<Mutex<ChildStdin>>, id: &Value, result: Value) {
    let reply = json!({ "id": id, "result": result });
    if let Ok(encoded) = serde_json::to_string(&reply) {
        let mut writer = stdin.lock().await;
        let _ = writer.write_all(format!("{encoded}\n").as_bytes()).await;
        let _ = writer.flush().await;
    }
}

async fn write_server_error(stdin: &Arc<Mutex<ChildStdin>>, id: &Value, method: &str) {
    let reply = json!({ "id": id, "error": { "code": -32601, "message": format!("Method not found: {method}") } });
    if let Ok(encoded) = serde_json::to_string(&reply) {
        let mut writer = stdin.lock().await;
        let _ = writer.write_all(format!("{encoded}\n").as_bytes()).await;
        let _ = writer.flush().await;
    }
}

fn finish_pending_steer(pending: &mut Vec<Value>, client_id: &str, accepted: bool) {
    if !accepted {
        pending.retain(|item| item["clientUserMessageId"] != client_id);
    } else if let Some(item) = pending
        .iter_mut()
        .find(|item| item["clientUserMessageId"] == client_id)
    {
        item["deliveryStatus"] = json!("steering");
    }
}

fn acknowledge_pending_steers(pending: &mut Vec<Value>, item: &Value) {
    if item.get("type").and_then(Value::as_str) != Some("userMessage") {
        return;
    }
    if let Some(client_id) = item.get("clientId").and_then(Value::as_str) {
        pending.retain(|receipt| {
            receipt.get("clientUserMessageId").and_then(Value::as_str) != Some(client_id)
        });
    }
}

async fn dispatch_notification(inner: &Arc<Inner>, message: &Value) {
    let _dispatch = inner.notification_dispatch.lock().await;
    dispatch_notification_inner(inner, message).await;
}

async fn dispatch_notification_inner(inner: &Arc<Inner>, message: &Value) {
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return;
    };
    let params = message.get("params").unwrap_or(&Value::Null);
    if method == "thread/settings/updated" {
        // Forward the authoritative App Server settings to the UI. The
        // notification can arrive outside an active turn, so it must not be
        // routed through the turn event path below.
        if let Some(app) = inner.app_handle.lock().await.clone() {
            let _ = app.emit("codex-thread-settings-updated", params.clone());
        }
        return;
    }
    if method == "thread/tokenUsage/updated" {
        if let (Some(thread_id), Some(usage)) = (
            params.get("threadId").and_then(Value::as_str),
            codex_usage_info(params.get("tokenUsage").unwrap_or(&Value::Null)),
        ) {
            inner
                .latest_usage
                .lock()
                .await
                .insert(thread_id.to_string(), usage);
        }
    }
    let thread_id = params
        .get("threadId")
        .and_then(Value::as_str)
        .or_else(|| params.pointer("/turn/threadId").and_then(Value::as_str));
    let turn_id = params
        .get("turnId")
        .and_then(Value::as_str)
        .or_else(|| params.pointer("/turn/id").and_then(Value::as_str));
    if method == "turn/started" {
        if let (Some(thread_id), Some(turn_id)) = (thread_id, turn_id) {
            bind_automatically_started_queue_turn(inner, thread_id, turn_id).await;
        }
    }
    let mut interrupt_target = None;
    let active = {
        let mut turns = inner.active_turns.lock().await;
        // Item lifecycle notifications are turn-scoped. Never fall back to
        // the currently active turn when `turnId` is absent: a late item from
        // the previous turn would otherwise be attributed to the new run on
        // the same Codex thread.
        let requires_exact_turn = turn_scoped_notification(method);
        let found = (thread_id.is_some() || turn_id.is_some())
            && (!requires_exact_turn || (thread_id.is_some() && turn_id.is_some()));
        let waiting_for_start_response =
            if requires_exact_turn && thread_id.is_some() && turn_id.is_some() {
                turns.values_mut().find(|active| {
                    active.codex_turn_id.is_empty()
                        && unbound_notification_action(active.binding, method, true)
                            == UnboundNotificationAction::Buffer
                        && active.binding == TurnBinding::StartResponse
                        && thread_id == Some(active.codex_thread_id.as_str())
                })
            } else {
                None
            };
        if let Some(active) = waiting_for_start_response {
            buffer_turn_notification(active, message);
            return;
        }
        let waiting_for_started_notification = if requires_exact_turn
            && method != "turn/started"
            && thread_id.is_some()
            && turn_id.is_some()
        {
            turns.values_mut().find(|active| {
                active.codex_turn_id.is_empty()
                    && unbound_notification_action(active.binding, method, true)
                        == UnboundNotificationAction::Buffer
                    && active.binding == TurnBinding::StartedNotification
                    && thread_id == Some(active.codex_thread_id.as_str())
            })
        } else {
            None
        };
        if let Some(active) = waiting_for_started_notification {
            buffer_turn_notification(active, message);
            return;
        }
        let mut found = found
            .then(|| {
                turns.values_mut().find(|active| {
                    thread_id
                        .map(|id| id == active.codex_thread_id)
                        .unwrap_or(true)
                        && (active.codex_turn_id.is_empty()
                            || turn_id.map(|id| id == active.codex_turn_id).unwrap_or(true))
                })
            })
            .flatten();
        // Ordinary chats are bound by their own `turn/start` response above.
        // Native asynchronous commands may have no response turn id, so only
        // their `turn/started` notification is allowed to establish identity.
        if let Some(active) = found.as_deref_mut() {
            if active.codex_turn_id.is_empty()
                && active.binding == TurnBinding::StartedNotification
                && method == "turn/started"
            {
                if let Some(turn_id) = turn_id {
                    active.codex_turn_id = turn_id.to_string();
                    active.turn_ready.notify_one();
                }
            }
            if method == "item/completed" {
                if let Some(item) = params.get("item") {
                    acknowledge_pending_steers(&mut active.pending_steers, item);
                }
            }
            if active.cancel_requested && !active.codex_turn_id.is_empty() {
                // `dispatch_notification` runs on the app-server reader task;
                // waiting here for the interrupt response would deadlock that
                // reader. Schedule it after releasing the registry lock.
                active.cancel_requested = false;
                interrupt_target =
                    Some((active.codex_thread_id.clone(), active.codex_turn_id.clone()));
            }
        }
        found.map(|active| {
            active.last_event_at = chrono::Utc::now().timestamp_millis();
            (
                active.flowix_thread_id.clone(),
                active.run_id.clone(),
                active.app_handle.clone(),
                active.stream_end_emitted.clone(),
                active.completed_agent_messages.clone(),
                active.command_id.clone(),
                active.command.clone(),
                active.started_at,
                if method == "turn/started" {
                    std::mem::take(&mut active.pending_notifications)
                } else {
                    Vec::new()
                },
            )
        })
    };
    let Some((
        flowix_thread_id,
        run_id,
        app,
        ended,
        completed_agent_messages,
        command_id,
        command,
        started_at,
        pending,
    )) = active
    else {
        return;
    };
    for notification in pending {
        Box::pin(dispatch_notification_inner(inner, &notification)).await;
    }
    if let Some((codex_thread_id, codex_turn_id)) = interrupt_target {
        let inner = inner.clone();
        tokio::spawn(async move {
            let _ = request_inner(
                &inner,
                "turn/interrupt",
                json!({ "threadId": codex_thread_id, "turnId": codex_turn_id }),
            )
            .await;
        });
    }
    match method {
        "turn/started" => {}
        "thread/tokenUsage/updated" => {
            let token_usage = params.get("tokenUsage").unwrap_or(&Value::Null);
            let last = token_usage
                .get("last")
                .or_else(|| token_usage.get("lastTokenUsage"))
                .and_then(codex_usage_info);
            if let Some(usage) = last {
                emit_notification_chunk(
                    inner,
                    &flowix_thread_id,
                    &run_id,
                    &app,
                    AgentChunk::Usage {
                        thread_id: flowix_thread_id.clone(),
                        model_id: None,
                        last_run_at: None,
                        usage: Some(usage),
                        status_info: None,
                    },
                )
                .await;
            }
        }
        "item/agentMessage/delta" => {
            if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                emit_notification_chunk_with_metadata(
                    inner,
                    &flowix_thread_id,
                    &run_id,
                    &app,
                    AgentChunk::Text {
                        thread_id: flowix_thread_id.clone(),
                        text: delta.to_string(),
                    },
                    with_turn_id(item_delta_metadata(params), turn_id.as_deref()),
                )
                .await;
            }
        }
        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
            if let Some(delta) = params
                .get("delta")
                .and_then(Value::as_str)
                .filter(|delta| has_visible_text(delta))
            {
                emit_notification_chunk_with_metadata(
                    inner,
                    &flowix_thread_id,
                    &run_id,
                    &app,
                    AgentChunk::Reasoning {
                        thread_id: flowix_thread_id.clone(),
                        text: delta.to_string(),
                    },
                    with_turn_id(item_delta_metadata(params), turn_id.as_deref()),
                )
                .await;
            }
        }
        "item/started" => {
            if let Some(item) = params.get("item") {
                if let Some((chunk, metadata)) =
                    tool_call_notification_chunk(&flowix_thread_id, item, turn_id)
                {
                    emit_notification_chunk_with_metadata(
                        inner,
                        &flowix_thread_id,
                        &run_id,
                        &app,
                        chunk,
                        metadata,
                    )
                    .await;
                }
            }
        }
        "item/completed" => {
            if let Some(item) = params.get("item") {
                if let Some((chunk, metadata)) =
                    completed_message_chunk(&flowix_thread_id, item, turn_id.as_deref())
                {
                    let mut metadata = metadata;
                    if should_emit_completed_agent_message(
                        &completed_agent_messages,
                        item,
                        turn_id.as_deref(),
                        None,
                        &mut metadata,
                    )
                    .await
                    {
                        emit_notification_chunk_with_metadata(
                            inner,
                            &flowix_thread_id,
                            &run_id,
                            &app,
                            chunk,
                            metadata,
                        )
                        .await;
                    }
                } else if is_custom_tool_call_item(item) {
                    // Some App Server versions only expose the completed
                    // snapshot for custom tools. Replaying the call is
                    // idempotent with item/started and preserves a visible
                    // row when that notification was absent.
                    if let Some((chunk, metadata)) =
                        tool_call_notification_chunk(&flowix_thread_id, item, turn_id)
                    {
                        emit_notification_chunk_with_metadata(
                            inner,
                            &flowix_thread_id,
                            &run_id,
                            &app,
                            chunk,
                            metadata,
                        )
                        .await;
                    }
                    if let Some((chunk, metadata)) =
                        tool_result_notification_chunk(&flowix_thread_id, item, turn_id)
                    {
                        emit_notification_chunk_with_metadata(
                            inner,
                            &flowix_thread_id,
                            &run_id,
                            &app,
                            chunk,
                            metadata,
                        )
                        .await;
                    }
                } else if let Some((chunk, metadata)) =
                    tool_result_notification_chunk(&flowix_thread_id, item, turn_id)
                {
                    emit_notification_chunk_with_metadata(
                        inner,
                        &flowix_thread_id,
                        &run_id,
                        &app,
                        chunk,
                        metadata,
                    )
                    .await;
                }
            }
        }
        "turn/completed" => {
            let status = params
                .pointer("/turn/status")
                .and_then(Value::as_str)
                .unwrap_or("failed");
            let reason = match status {
                "completed" => None,
                "interrupted" => Some(USER_STOPPED_REASON.to_string()),
                _ => Some(
                    params
                        .pointer("/turn/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("Codex turn failed")
                        .to_string(),
                ),
            };
            if ended
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                // App Server normally finalizes messages through item/completed.
                // The completed turn also carries the final agent message, so
                // project it as an idempotent fallback before ending the stream.
                if let Some(items) = params.pointer("/turn/items").and_then(Value::as_array) {
                    if let Some((item_index, item)) =
                        items.iter().enumerate().rev().find(|(_, item)| {
                            item.get("type").and_then(Value::as_str) == Some("agentMessage")
                        })
                    {
                        if let Some((chunk, metadata)) =
                            completed_message_chunk(&flowix_thread_id, item, turn_id.as_deref())
                        {
                            let occurrence =
                                codex_fallback_agent_message_occurrence(items, item_index, status);
                            let mut metadata = metadata;
                            if should_emit_completed_agent_message(
                                &completed_agent_messages,
                                item,
                                turn_id.as_deref(),
                                Some(occurrence),
                                &mut metadata,
                            )
                            .await
                            {
                                emit_notification_chunk_with_metadata(
                                    inner,
                                    &flowix_thread_id,
                                    &run_id,
                                    &app,
                                    chunk,
                                    metadata,
                                )
                                .await;
                            }
                        }
                    }
                }
                if let Some(reason) = &reason {
                    emit_notification_chunk_with_metadata(
                        inner,
                        &flowix_thread_id,
                        &run_id,
                        &app,
                        AgentChunk::Error {
                            thread_id: flowix_thread_id.clone(),
                            message: reason.clone(),
                            error_details: Some(crate::agent_external::classify_agent_error(
                                reason,
                                "app-server",
                            )),
                        },
                        codex_turn_error_metadata(turn_id.as_deref()),
                    )
                    .await;
                }
                if let (Some(command_id), Some(command)) =
                    (command_id.as_deref(), command.as_deref())
                {
                    let status = if reason.as_deref() == Some(USER_STOPPED_REASON) {
                        "cancelled"
                    } else if reason.is_some() {
                        "error"
                    } else {
                        "success"
                    };
                    emit_codex_command_notification(
                        &app,
                        &flowix_thread_id,
                        &run_id,
                        command_id,
                        command,
                        started_at,
                        status,
                        reason.clone(),
                        turn_id,
                    )
                    .await;
                }
                emit_notification_chunk(
                    inner,
                    &flowix_thread_id,
                    &run_id,
                    &app,
                    AgentChunk::StreamEnd {
                        thread_id: flowix_thread_id.clone(),
                        reason,
                        duration_ms: params.pointer("/turn/durationMs").and_then(Value::as_u64),
                    },
                )
                .await;
            }
            let mut turns = inner.active_turns.lock().await;
            if turns.get(&flowix_thread_id).is_some_and(|active| {
                active.run_id == run_id && turn_id.is_some_and(|id| id == active.codex_turn_id)
            }) {
                turns.remove(&flowix_thread_id);
            }
        }
        _ => {}
    }
}

fn codex_usage_info(value: &Value) -> Option<crate::agent_types::UsageInfo> {
    let source = value
        .get("total")
        .or_else(|| value.get("totalTokenUsage"))
        .unwrap_or(value);
    let number = |key: &str| {
        source
            .get(key)
            .and_then(Value::as_u64)
            .map(|n| n.min(u32::MAX as u64) as u32)
    };
    let context = value
        .get("modelContextWindow")
        .or_else(|| value.get("model_context_window"))
        .and_then(Value::as_u64)
        .map(|n| n.min(u32::MAX as u64) as u32);
    if number("inputTokens").is_none()
        && number("input_tokens").is_none()
        && number("outputTokens").is_none()
        && number("output_tokens").is_none()
        && context.is_none()
    {
        return None;
    }
    Some(crate::agent_types::UsageInfo {
        input_tokens: number("inputTokens").or_else(|| number("input_tokens")),
        cached_input_tokens: number("cachedInputTokens").or_else(|| number("cached_input_tokens")),
        output_tokens: number("outputTokens").or_else(|| number("output_tokens")),
        reasoning_output_tokens: number("reasoningOutputTokens")
            .or_else(|| number("reasoning_output_tokens")),
        total_tokens: number("totalTokens").or_else(|| number("total_tokens")),
        model_context_window: context,
        context_used_tokens: None,
    })
}

fn turn_scoped_notification(method: &str) -> bool {
    matches!(
        method,
        "turn/started"
            | "item/agentMessage/delta"
            | "item/reasoning/summaryTextDelta"
            | "item/reasoning/textDelta"
            | "item/started"
            | "item/completed"
            | "turn/completed"
    )
}

async fn emit_notification_chunk(
    _inner: &Arc<Inner>,
    _flowix_thread_id: &str,
    run_id: &str,
    app: &tauri::AppHandle,
    chunk: AgentChunk,
) {
    emit_chunk_with_run_id(app, &chunk, AGENT_TYPE, run_id);
}

async fn emit_codex_command_notification(
    app: &tauri::AppHandle,
    thread_id: &str,
    run_id: &str,
    command_id: &str,
    command: &str,
    timestamp: i64,
    status: &str,
    result: Option<String>,
    turn_id: Option<&str>,
) {
    let chunk = AgentChunk::CodexCommand {
        thread_id: thread_id.to_string(),
        id: command_id.to_string(),
        command: command.to_string(),
        status: status.to_string(),
        result,
        timestamp,
    };
    let metadata = with_turn_id(AgentChunkMetadata::default(), turn_id);
    emit_chunk_with_run_id_and_metadata(app, &chunk, AGENT_TYPE, run_id, &metadata);
}

async fn emit_notification_chunk_with_metadata(
    _inner: &Arc<Inner>,
    _flowix_thread_id: &str,
    run_id: &str,
    app: &tauri::AppHandle,
    chunk: AgentChunk,
    metadata: AgentChunkMetadata,
) {
    emit_chunk_with_run_id_and_metadata(app, &chunk, AGENT_TYPE, run_id, &metadata);
}

fn item_delta_metadata(params: &Value) -> AgentChunkMetadata {
    let item_id = params
        .get("itemId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string);
    item_metadata_from_id(item_id)
}

fn item_metadata(item: &Value) -> AgentChunkMetadata {
    let item_id = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string);
    let mut metadata = item_metadata_from_id(item_id);
    metadata.codex_turn_id = item
        .get("turnId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string);
    metadata.client_user_message_id = item
        .get("clientId")
        .and_then(Value::as_str)
        .map(str::to_string);
    metadata
}

fn item_metadata_from_id(item_id: Option<String>) -> AgentChunkMetadata {
    AgentChunkMetadata {
        message_id: item_id.clone(),
        source_message_id: item_id,
        ..AgentChunkMetadata::default()
    }
}

fn completed_agent_message(item: &Value) -> Option<CompletedAgentMessageCandidate> {
    if item.get("type").and_then(Value::as_str) != Some("agentMessage") {
        return None;
    }
    let message = CompletedAgentMessageCandidate {
        id: item
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .map(str::to_string),
        text: item
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    };
    (!message.text.trim().is_empty()).then_some(message)
}

async fn should_emit_completed_agent_message(
    messages: &Arc<Mutex<Vec<SeenCompletedAgentMessage>>>,
    item: &Value,
    turn_id: Option<&str>,
    terminal_occurrence: Option<usize>,
    metadata: &mut AgentChunkMetadata,
) -> bool {
    let Some(candidate) = completed_agent_message(item) else {
        return true;
    };
    let mut seen = messages.lock().await;
    let fallback_occurrence = candidate.id.is_none().then(|| {
        terminal_occurrence.unwrap_or_else(|| {
            seen.iter()
                .filter(|previous| previous.id.is_none() && previous.text == candidate.text)
                .count()
        })
    });
    let duplicate_id = candidate.id.as_deref().is_some_and(|candidate_id| {
        seen.iter()
            .any(|previous| previous.id.as_deref() == Some(candidate_id))
    });
    let terminal_duplicate = terminal_occurrence.is_some_and(|occurrence| {
        seen.iter().any(|previous| {
            previous.id.is_none()
                && previous.text == candidate.text
                && previous.fallback_occurrence == Some(occurrence)
        })
    });
    if duplicate_id || terminal_duplicate {
        return false;
    }

    if metadata.message_id.is_none() {
        metadata.message_id = candidate.id.clone().or_else(|| {
            let occurrence = fallback_occurrence.unwrap_or_default();
            turn_id.filter(|id| !id.trim().is_empty()).map(|turn_id| {
                codex_fallback_item_message_id(turn_id, "assistant", &candidate.text, occurrence)
            })
        });
    }
    seen.push(SeenCompletedAgentMessage {
        id: candidate.id,
        text: candidate.text,
        fallback_occurrence,
    });
    true
}

fn codex_fallback_agent_message_occurrence(
    items: &[Value],
    item_index: usize,
    turn_status: &str,
) -> usize {
    let Some(item) = items.get(item_index) else {
        return 0;
    };
    let Some(text) = item.get("text").and_then(Value::as_str) else {
        return 0;
    };
    let interrupted_turn = matches!(turn_status, "failed" | "interrupted" | "cancelled");
    items[..item_index]
        .iter()
        .filter(|previous| {
            if previous.get("type").and_then(Value::as_str) != Some("agentMessage")
                || previous
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| !id.trim().is_empty())
                || previous.get("text").and_then(Value::as_str) != Some(text)
            {
                return false;
            }
            let interrupted_item =
                previous
                    .get("status")
                    .and_then(Value::as_str)
                    .is_some_and(|status| {
                        matches!(
                            status,
                            "inProgress" | "failed" | "interrupted" | "cancelled"
                        )
                    });
            !(interrupted_turn && interrupted_item)
        })
        .count()
}

fn with_turn_id(mut metadata: AgentChunkMetadata, turn_id: Option<&str>) -> AgentChunkMetadata {
    metadata.codex_turn_id = turn_id
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string);
    metadata
}

fn tool_call_notification_chunk(
    thread_id: &str,
    item: &Value,
    turn_id: Option<&str>,
) -> Option<(AgentChunk, AgentChunkMetadata)> {
    let (id, name) = codex_tool_call_identity(item)?;
    let mut metadata = with_turn_id(item_metadata(item), turn_id);
    metadata.message_type = codex_custom_tool_message_type(item);
    Some((
        AgentChunk::ToolCall {
            thread_id: thread_id.to_string(),
            id,
            name,
            input: codex_tool_call_input(item),
        },
        metadata,
    ))
}

fn tool_result_notification_chunk(
    thread_id: &str,
    item: &Value,
    turn_id: Option<&str>,
) -> Option<(AgentChunk, AgentChunkMetadata)> {
    let (id, name) = codex_tool_result_identity(item)?;
    let result = codex_tool_result_value(item)?;
    let mut metadata = with_turn_id(item_metadata(item), turn_id);
    metadata.message_type = codex_custom_tool_message_type(item);
    Some((
        AgentChunk::ToolResult {
            thread_id: thread_id.to_string(),
            id,
            name,
            result,
        },
        metadata,
    ))
}

fn completed_message_chunk(
    thread_id: &str,
    item: &Value,
    turn_id: Option<&str>,
) -> Option<(AgentChunk, AgentChunkMetadata)> {
    let kind = item.get("type").and_then(Value::as_str)?;
    if kind == "contextCompaction" {
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .map(str::to_string)
            .or_else(|| {
                turn_id
                    .filter(|id| !id.trim().is_empty())
                    .map(|turn_id| codex_fallback_item_message_id(turn_id, "system", "", 0))
            })
            .unwrap_or_else(|| "codex-context-compaction".to_string());
        let mut metadata = item_metadata(item);
        metadata.codex_turn_id = turn_id
            .filter(|id| !id.trim().is_empty())
            .map(str::to_string);
        metadata.message_phase = Some("completed");
        metadata.content_mode = Some("snapshot");
        return Some((
            AgentChunk::ContextCompaction {
                thread_id: thread_id.to_string(),
                id,
            },
            metadata,
        ));
    }

    let raw_text = match kind {
        // Relay every completed userMessage item, not just steers. The
        // provider item id turns the optimistic `user-<run>` row into a
        // history-stable identity mid-turn (the frontend adopts it in
        // place), so completion reconciliation can anchor by id instead of
        // content fingerprints. Steer items additionally carry clientId so
        // the frontend can reconcile the pending composer row.
        "userMessage" => app_server_content_text(item.get("content")),
        "agentMessage" => item
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        "reasoning" => {
            let summary = app_server_content_text(item.get("summary"));
            if summary.is_empty() {
                app_server_content_text(item.get("content"))
            } else {
                summary
            }
        }
        _ => return None,
    };
    // Native commands are represented by `CodexCommand` below. Some server
    // versions echo the slash text as a completed user item; suppress that
    // echo so the product-owned command row is not duplicated.
    if kind == "userMessage"
        && (is_codex_native_command_text(&raw_text) || is_codex_goal_internal_context(&raw_text))
    {
        return None;
    }
    let text = if kind == "userMessage" {
        visible_user_text(&raw_text)
    } else {
        raw_text
    };
    if !has_visible_text(&text) {
        return None;
    }
    let chunk = if kind == "userMessage" {
        let user_id = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .unwrap_or(CODEX_MISSING_USER_ITEM_ID)
            .to_string();
        AgentChunk::UserMessage {
            thread_id: thread_id.to_string(),
            id: user_id,
            text,
            timestamp: chrono::Utc::now().timestamp_millis(),
            attachments: app_server_image_attachments(item.get("content")),
        }
    } else if kind == "agentMessage" {
        AgentChunk::Text {
            thread_id: thread_id.to_string(),
            text,
        }
    } else {
        AgentChunk::Reasoning {
            thread_id: thread_id.to_string(),
            text,
        }
    };
    let mut metadata = item_metadata(item);
    metadata.codex_turn_id = turn_id
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string);
    metadata.message_type = codex_message_type(item);
    // Completed item notifications do not repeat turnId in the item. The
    // caller fills it from the notification context before emitting.
    metadata.message_phase = Some("completed");
    metadata.content_mode = Some("snapshot");
    Some((chunk, metadata))
}

fn is_codex_native_command_text(text: &str) -> bool {
    let trimmed = text.trim_start();
    let lower = trimmed.to_ascii_lowercase();
    lower == "/compact"
        || lower.starts_with("/goal")
            && lower
                .as_bytes()
                .get(5)
                .is_none_or(|byte| byte.is_ascii_whitespace())
}

fn is_codex_goal_internal_context(text: &str) -> bool {
    text.trim_start()
        .starts_with("<codex_internal_context source=\"goal\">")
}

/// A newly-created goal turn has no persisted `/goal ...` user item. Codex
/// stores the user-provided objective inside a hidden internal-context item
/// instead. Reconstruct the product-owned command only for the first goal
/// turn (`Tokens used: 0`); later autonomous continuation turns carry the
/// same objective and must not create duplicate user commands.
fn initial_goal_objective(turn: &Value) -> Option<String> {
    if let Some(objective) = turn
        .get("flowixGoalObjective")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|objective| !objective.is_empty())
    {
        return Some(objective.to_string());
    }
    let text = turn
        .get("items")
        .and_then(Value::as_array)?
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("userMessage"))
        .map(|item| app_server_content_text(item.get("content")))
        .find(|text| is_codex_goal_internal_context(text))?;
    if !text.lines().any(|line| line.trim() == "- Tokens used: 0") {
        return None;
    }
    let start = text.find("<objective>")? + "<objective>".len();
    let end = text[start..].find("</objective>")? + start;
    let objective = text[start..end].trim();
    (!objective.is_empty()).then(|| objective.to_string())
}

fn annotate_goal_turn(turns: &mut [Value], response: &Value) {
    let goal = response.get("goal").unwrap_or(&Value::Null);
    let Some(objective) = goal
        .get("objective")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|objective| !objective.is_empty())
    else {
        return;
    };
    let Some(created_at) = goal.get("createdAt").and_then(Value::as_i64) else {
        return;
    };
    let updated_at = goal
        .get("updatedAt")
        .and_then(Value::as_i64)
        .unwrap_or(created_at);
    // Editing an existing goal retains its original createdAt. updatedAt is
    // written while the new autonomous turn is running, so its containing
    // turn is the authoritative owner of the latest `/goal ...` command.
    let updated_candidate = turns.iter().position(|turn| {
        let Some(started_at) = turn.get("startedAt").and_then(Value::as_i64) else {
            return false;
        };
        let completed_at = turn
            .get("completedAt")
            .and_then(Value::as_i64)
            .unwrap_or_else(|| started_at.saturating_add(5));
        updated_at >= started_at.saturating_sub(2) && updated_at <= completed_at.saturating_add(2)
    });
    // Before a goal's first status update, createdAt and turn/start are
    // emitted together. Keep a narrowly-bounded creation-time fallback.
    let candidate_index = updated_candidate.or_else(|| {
        turns
            .iter()
            .enumerate()
            .filter_map(|(index, turn)| {
                let started_at = turn.get("startedAt").and_then(Value::as_i64)?;
                let distance = started_at.abs_diff(created_at);
                (distance <= 5).then_some((distance, index))
            })
            .min_by_key(|(distance, _)| *distance)
            .map(|(_, index)| index)
    });
    let Some(Value::Object(turn)) = candidate_index.and_then(|index| turns.get_mut(index)) else {
        return;
    };
    turn.insert(
        "flowixGoalObjective".to_string(),
        Value::String(objective.to_string()),
    );
}

/// Translate Flowix permission names into the App Server sandbox object.
/// Keep this separate from the App Server v2 `permissions` profile API.
fn app_server_sandbox(permission: Option<&str>) -> Value {
    app_server_sandbox_with_roots(permission, &[])
}

fn app_server_sandbox_with_roots(permission: Option<&str>, writable_roots: &[String]) -> Value {
    match permission.map(str::trim) {
        Some("read-only") => json!({ "type": "readOnly" }),
        Some("danger-full-access" | "yolo") => json!({ "type": "dangerFullAccess" }),
        None | Some("workspace-write") => json!({
            "type": "workspaceWrite",
            "writableRoots": writable_roots,
            "networkAccess": false
        }),
        _ => json!({ "type": "readOnly" }),
    }
}

/// `thread/start` uses the legacy kebab-case sandbox field. Keep this mapping
/// separate from the object form used by `turn/start` and settings updates.
fn app_server_legacy_sandbox(permission: Option<&str>) -> &'static str {
    match permission.map(str::trim) {
        Some("read-only") => "read-only",
        Some("danger-full-access" | "yolo") => "danger-full-access",
        None | Some("workspace-write") => "workspace-write",
        _ => "read-only",
    }
}

fn app_server_approval_policy(permission: Option<&str>) -> &'static str {
    match permission.map(str::trim) {
        None | Some("workspace-write") => "on-request",
        _ => "never",
    }
}

#[cfg(test)]
mod tests;
