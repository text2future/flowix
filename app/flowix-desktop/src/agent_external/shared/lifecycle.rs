use super::*;

#[derive(Clone, Debug, Default)]
pub struct AgentChunkMetadata {
    pub codex_turn_id: Option<String>,
    pub message_id: Option<String>,
    /// Provider-native item/message id retained for diagnostics and future
    /// transcript imports. `message_id` is the Flowix canonical identity.
    pub source_message_id: Option<String>,
    /// Provider-owned display category for synthetic timeline messages. This
    /// is currently used by DSH goal round/wrap-up notices; it must not be
    /// inferred from the rendered text on the frontend.
    pub message_type: Option<&'static str>,
    pub client_user_message_id: Option<String>,
    pub message_phase: Option<&'static str>,
    pub content_mode: Option<&'static str>,
    pub source_timestamp: Option<i64>,
    pub source_sequence: Option<u64>,
    pub source_subsequence: Option<u32>,
    /// The event marks a boundary after which the current reasoning segment
    /// cannot continue. This is intentionally semantic rather than runtime
    /// specific so the frontend does not need to inspect `agentType`.
    pub reasoning_boundary: bool,
}

impl AgentChunkMetadata {
    fn apply_to_payload(&self, object: &mut serde_json::Map<String, Value>) {
        if let Some(turn_id) = self.codex_turn_id.as_ref() {
            object.insert("codex_turn_id".to_string(), Value::String(turn_id.clone()));
        }
        if let Some(message_id) = self.message_id.as_ref() {
            object.insert("message_id".to_string(), Value::String(message_id.clone()));
        }
        if let Some(source_message_id) = self.source_message_id.as_ref() {
            object.insert(
                "source_message_id".to_string(),
                Value::String(source_message_id.clone()),
            );
        }
        if let Some(message_type) = self.message_type {
            object.insert(
                "message_type".to_string(),
                Value::String(message_type.to_string()),
            );
        }
        if let Some(client_id) = self.client_user_message_id.as_ref() {
            object.insert(
                "client_user_message_id".to_string(),
                Value::String(client_id.clone()),
            );
        }
        if let Some(message_phase) = self.message_phase {
            object.insert(
                "message_phase".to_string(),
                Value::String(message_phase.to_string()),
            );
        }
        if let Some(content_mode) = self.content_mode {
            object.insert(
                "content_mode".to_string(),
                Value::String(content_mode.to_string()),
            );
        }
        if let Some(source_timestamp) = self.source_timestamp {
            object.insert(
                "source_timestamp".to_string(),
                Value::Number(source_timestamp.into()),
            );
        }
        if let Some(source_sequence) = self.source_sequence {
            object.insert(
                "source_sequence".to_string(),
                Value::Number(source_sequence.into()),
            );
        }
        if let Some(source_subsequence) = self.source_subsequence {
            object.insert(
                "source_subsequence".to_string(),
                Value::Number(source_subsequence.into()),
            );
        }
        if self.reasoning_boundary {
            object.insert("reasoning_boundary".to_string(), Value::Bool(true));
        }
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
    emit_chunk_with_run_id_and_metadata(
        app_handle,
        chunk,
        agent_type,
        run_id,
        &AgentChunkMetadata::default(),
    );
}

pub fn emit_chunk_with_run_id_and_metadata(
    app_handle: &tauri::AppHandle,
    chunk: &AgentChunk,
    agent_type: &'static str,
    run_id: &str,
    metadata: &AgentChunkMetadata,
) {
    let payload = match chunk_payload_value(chunk, agent_type, run_id, metadata) {
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

pub async fn persist_external_chunk(
    thread_manager: &Arc<ThreadManager>,
    agent_type: &'static str,
    chunk: &AgentChunk,
    run_id: &str,
    raw_json: Option<&str>,
) {
    persist_external_chunk_with_metadata(
        thread_manager,
        agent_type,
        chunk,
        run_id,
        raw_json,
        &AgentChunkMetadata::default(),
    )
    .await;
}

pub async fn persist_external_chunk_with_metadata(
    thread_manager: &Arc<ThreadManager>,
    agent_type: &'static str,
    chunk: &AgentChunk,
    run_id: &str,
    raw_json: Option<&str>,
    metadata: &AgentChunkMetadata,
) {
    persist_external_chunk_for_thread_with_metadata(
        thread_manager,
        agent_type,
        chunk.thread_id(),
        chunk,
        run_id,
        raw_json,
        metadata,
    )
    .await;
}

/// Persist a chunk under a product-owned thread while preserving the chunk's
/// delivery thread id in its normalized payload. External runtimes whose UI
/// identity changes from a local id to a vendor session id use this to avoid
/// splitting one conversation across multiple database owners.
pub async fn persist_external_chunk_for_thread_with_metadata(
    thread_manager: &Arc<ThreadManager>,
    agent_type: &'static str,
    storage_thread_id: &str,
    chunk: &AgentChunk,
    run_id: &str,
    raw_json: Option<&str>,
    metadata: &AgentChunkMetadata,
) {
    // Provider-owned histories are read from their external data source. The
    // local journal is retained only for Claude. Codex and DSH messages must
    // come from their provider history APIs; their live chunks are runtime
    // state only and must never become a second local transcript.
    if agent_type != "claude" {
        return;
    }
    let payload_json = match chunk_payload_json(chunk, agent_type, run_id, metadata) {
        Some(payload) => payload,
        None => return,
    };
    let event = NewAgentExternalEvent {
        runtime: agent_type.to_string(),
        thread_id: storage_thread_id.to_string(),
        normalized_json: payload_json,
        raw_json: raw_json
            .filter(|_| external_event_raw_json_enabled(agent_type))
            .map(str::to_string),
        created_at: None,
    };

    if let Err(err) = thread_manager.insert_agent_external_event(event).await {
        runtime_log::record_agent_event(
            "warn",
            "agent_events",
            "agent.event_persist_failed",
            "Failed to persist external agent stream event",
            Some(chunk.thread_id()),
            Some(agent_type),
            Some(serde_json::json!({
                "run_id": run_id,
                "chunk_kind": chunk.kind(),
                "error": err.to_string(),
            })),
        );
    }
}

pub async fn persist_and_emit_external_chunk(
    app_handle: &tauri::AppHandle,
    thread_manager: &Arc<ThreadManager>,
    agent_type: &'static str,
    chunk: &AgentChunk,
    run_id: &str,
    raw_json: Option<&str>,
) {
    persist_and_emit_external_chunk_with_metadata(
        app_handle,
        thread_manager,
        agent_type,
        chunk,
        run_id,
        raw_json,
        &AgentChunkMetadata::default(),
    )
    .await;
}

pub async fn persist_and_emit_external_chunk_with_metadata(
    app_handle: &tauri::AppHandle,
    thread_manager: &Arc<ThreadManager>,
    agent_type: &'static str,
    chunk: &AgentChunk,
    run_id: &str,
    raw_json: Option<&str>,
    metadata: &AgentChunkMetadata,
) {
    persist_external_chunk_with_metadata(
        thread_manager,
        agent_type,
        chunk,
        run_id,
        raw_json,
        metadata,
    )
    .await;
    emit_chunk_with_run_id_and_metadata(app_handle, chunk, agent_type, run_id, metadata);
}

fn chunk_payload_json(
    chunk: &AgentChunk,
    agent_type: &'static str,
    run_id: &str,
    metadata: &AgentChunkMetadata,
) -> Option<String> {
    let payload = chunk_payload_value(chunk, agent_type, run_id, metadata).ok()?;
    serde_json::to_string(&payload).ok()
}

pub(crate) fn chunk_payload_value(
    chunk: &AgentChunk,
    agent_type: &'static str,
    run_id: &str,
    metadata: &AgentChunkMetadata,
) -> Result<Value, serde_json::Error> {
    let mut payload = serde_json::to_value(chunk)?;
    if let Value::Object(object) = &mut payload {
        object.insert("run_id".to_string(), Value::String(run_id.to_string()));
        object.insert(
            "agent_type".to_string(),
            Value::String(agent_type.to_string()),
        );
        let canonical_metadata = canonical_chunk_metadata(agent_type, run_id, chunk, metadata);
        canonical_metadata.apply_to_payload(object);
        if let AgentChunk::UserMessage { id, .. } = chunk {
            object.insert("source_message_id".to_string(), Value::String(id.clone()));
            let canonical_id = canonical_message_id(agent_type, run_id, "user", id);
            object.insert("id".to_string(), Value::String(canonical_id.clone()));
            object.insert("message_id".to_string(), Value::String(canonical_id));
        }
    }
    Ok(payload)
}

/// Product-owned identity shared by external runtimes.
///
/// Codex is intentionally different: its app-server `itemId` is already
/// unique within a thread and is also the id returned by
/// `thread/turns/list`. Keep that provider id unchanged so live notifications
/// and history snapshots address the same rendered row. Other runtimes still
/// need a run-scoped canonical id because their provider ids are not
/// necessarily unique across a session.
pub fn canonical_message_id(
    agent_type: &str,
    run_id: &str,
    role: &str,
    source_message_id: &str,
) -> String {
    if source_message_id.starts_with("msg:") {
        return source_message_id.to_string();
    }
    if agent_type == "codex" && role != "error" {
        return source_message_id.to_string();
    }
    format!("msg:{agent_type}:{run_id}:{role}:{source_message_id}")
}

fn canonical_chunk_metadata(
    agent_type: &str,
    run_id: &str,
    chunk: &AgentChunk,
    metadata: &AgentChunkMetadata,
) -> AgentChunkMetadata {
    let mut canonical = metadata.clone();
    let (role, fallback_source) = match chunk {
        AgentChunk::Text { .. } => ("assistant", "stream".to_string()),
        AgentChunk::Reasoning { .. } => ("reasoning", "stream".to_string()),
        AgentChunk::ToolCall { id, .. } | AgentChunk::ToolResult { id, .. } => ("tool", id.clone()),
        AgentChunk::DshCommand { id, .. } => ("dsh-command", id.clone()),
        AgentChunk::CodexCommand { id, .. } => ("codex-command", id.clone()),
        AgentChunk::Error { .. } => ("error", "error".to_string()),
        _ => return canonical,
    };
    let source = metadata
        .source_message_id
        .clone()
        .or_else(|| metadata.message_id.clone())
        .unwrap_or_else(|| {
            // A real Codex item id is safe to use raw, but a missing item id
            // must not fall back to the shared "stream" marker. Otherwise
            // two runs on the same thread would address the same assistant
            // row. Keep the synthetic path run-scoped and let the existing
            // `msg:` idempotency guard preserve it end-to-end.
            if agent_type == "codex" {
                format!("msg:codex:{run_id}:{role}:{fallback_source}")
            } else {
                fallback_source
            }
        });
    canonical.source_message_id = Some(source.clone());
    canonical.message_id = Some(canonical_message_id(agent_type, run_id, role, &source));
    canonical
}

fn external_event_raw_json_enabled(agent_type: &str) -> bool {
    let agent_key = agent_type
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect::<String>();

    env_bool(&format!("FLOWIX_{agent_key}_RAW_JSON"))
        .or_else(|| env_bool(&format!("FLOWIX_{agent_key}_DIAGNOSTICS")))
        .or_else(|| env_bool("FLOWIX_EXTERNAL_AGENT_RAW_JSON"))
        .or_else(|| env_bool("FLOWIX_EXTERNAL_AGENT_DIAGNOSTICS"))
        .unwrap_or_else(default_raw_json_enabled)
}

pub(super) fn default_raw_json_enabled() -> bool {
    cfg!(debug_assertions)
}

fn env_bool(name: &str) -> Option<bool> {
    std::env::var(name).ok().map(|value| parse_env_bool(&value))
}

pub(super) fn parse_env_bool(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// Reason string `stop_chat` attaches to its `StreamEnd`. The frontend
/// (`run-lifecycle::USER_STOPPED_REASON`) maps this to `cancelled` status 鈹€鈹€
/// a user-initiated stop is never `failed` / `completed`. Kept in sync by name
/// + value; changing one side without the other breaks the status mapping.
pub const USER_STOPPED_REASON: &str = "user_stopped";

/// Atomically claim the "StreamEnd has been emitted" slot for a run. First
/// caller wins (`true`); everyone else (`stop_chat`, streaming tail, watchdog)
/// gets `false` and must skip. This is the single chokepoint that prevents
/// double `StreamEnd` 鈹€鈹€ there is no parallel "already emitted" bool.
pub fn claim_stream_end_once(stream_end_emitted: &Arc<AtomicBool>) -> bool {
    stream_end_emitted
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

/// Claim the slot via [`claim_stream_end_once`] and, on a win, emit
/// `AgentChunk::StreamEnd`. Returns whether this caller emitted.
///
/// Callers:
///   * `*CliManager::stop_chat` 鈹€鈹€ reason `Some(USER_STOPPED_REASON)`
///   * the streaming `tokio::spawn` tail 鈹€鈹€ reason `None` (clean) or the run error
///
/// The idle watchdog does NOT use this 鈹€鈹€ it must emit an `Error` chunk
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
                duration_ms: None,
            },
            agent_type,
            run_id,
        );
        true
    } else {
        false
    }
}

/// Pick the external-CLI session id for a `chat_stream` invocation.
///
/// Decision order (first hit wins):
///   * `external_session_id_hint` 鈥?when the frontend thread id is itself a
///     provider-format session id (e.g. a Codex / Claude UUID pasted as a
///     thread id, or an `codex-local-...` placeholder resolved to one),
///     resume that session.
///   * `mapped_session_id` 鈥?otherwise trust the SQLite
///     `thread_external_sessions` mapping created when the thread first ran.
///
/// If a CLI process already produced a session id for this thread, we
///     resume it instead of starting a new one.
///
/// UI locks cwd / workspace dirs at first message time, so cwd drift
/// mid-conversation can't happen; we don't gate resume on cwd anymore.
/// (The previous runtime_key check used to be the source of a silent
/// post-restart fork 鈥?the in-memory key was wiped, so the comparison
/// always mismatched and we started a fresh session every cold start.)
pub fn select_external_session_for_runtime(
    mapped_session_id: Option<String>,
    external_session_id_hint: Option<String>,
) -> Option<String> {
    external_session_id_hint.or(mapped_session_id)
}

/// Resolve the working directory for an external CLI run, freezing it on the
/// first turn so it never drifts mid-conversation.
///
/// Decision order:
///   1. An optional runtime-owned authoritative cwd (for example, the cwd in a
///      Claude resume file). It also repairs a stale persisted value.
///   2. `frozen_cwd` persisted in `agent_conversation_instances` on a prior
///      turn. After the first message the cwd stops tracking the live notebook.
///   3. The runtime-specific `resolver` (IPC `runtime_config.{runtime}.cwd`
///      -> session-file cwd for claude/codex -> `None`). No process-cwd
///      fallback: if nothing resolves we fail loudly instead of silently
///      launching the CLI in `/`.
///
/// On branch (3) the resolved cwd is persisted so every future turn takes
/// branch (2). Persistence is best-effort - a DB failure is logged but does
/// not abort the run (the cwd is still valid for this turn).
pub async fn resolve_and_freeze_runtime_cwd(
    thread_manager: &Arc<ThreadManager>,
    thread_id: &str,
    resolver: impl Fn(&AgentUserMessage, Option<&str>) -> Option<PathBuf>,
    message: &AgentUserMessage,
    session_id: Option<&str>,
    authoritative_cwd: Option<&std::path::Path>,
) -> Result<PathBuf, String> {
    if let Some(authoritative) = authoritative_cwd.filter(|cwd| cwd.is_dir()) {
        let authoritative = authoritative.to_path_buf();
        if thread_manager
            .read_frozen_cwd(thread_id)
            .await
            .ok()
            .flatten()
            .as_ref()
            != Some(&authoritative)
        {
            if let Err(err) = thread_manager
                .upsert_frozen_cwd(thread_id, &authoritative)
                .await
            {
                tracing::warn!("failed to persist authoritative cwd for {thread_id}: {err}");
            }
        }
        return Ok(authoritative);
    }
    if let Ok(Some(frozen)) = thread_manager.read_frozen_cwd(thread_id).await {
        if frozen.is_dir() {
            return Ok(frozen);
        }
    }
    let cwd = resolver(message, session_id)
        .filter(|c| c.is_dir())
        .ok_or_else(|| {
            "Agent working directory unavailable; open a notebook or pick a folder".to_string()
        })?;
    if let Err(err) = thread_manager.upsert_frozen_cwd(thread_id, &cwd).await {
        tracing::warn!("failed to persist frozen cwd for {thread_id}: {err}");
    }
    Ok(cwd)
}
