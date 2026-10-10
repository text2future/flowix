use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::Mutex;

use super::command::build_opencode_acp_command;
use super::protocol;
use super::AGENT_TYPE;
use crate::agent_external::lifecycle::ExternalLifecycleEmitter;
use crate::agent_external::{
    append_workspace_context, emit_chunk_with_run_id, read_capped_line, read_to_string,
    resolve_and_freeze_runtime_cwd, truncate_for_log, AgentChunkMetadata, ExternalRunRegistry,
    MAX_STDOUT_LINE_BYTES, USER_STOPPED_REASON,
};
use crate::agent_session::ThreadManager;
use crate::agent_wire::{AgentChunk, AgentUserMessage, RunInfo};
use crate::runtime_log;

const APP_EXIT_REASON: &str = "app_exit";
const MODEL_CACHE_TTL: Duration = Duration::from_secs(60);

#[derive(Clone)]
struct AcpControl {
    run_id: String,
    stdin: Arc<Mutex<ChildStdin>>,
    session_id: Arc<Mutex<Option<String>>>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum AcpReadPhase {
    Initialize,
    SessionSetup,
    Prompt,
}

#[derive(Default)]
struct OpenCodeTurnEvents {
    events: Vec<CompactedOpenCodeEvent>,
    assistant_index: Option<usize>,
    reasoning_index: Option<usize>,
    next_id: usize,
}

struct CompactedOpenCodeEvent {
    chunk: AgentChunk,
    metadata: AgentChunkMetadata,
}

impl OpenCodeTurnEvents {
    fn observe(&mut self, chunk: &AgentChunk, run_id: &str) {
        match chunk {
            AgentChunk::Text { thread_id, text } if !text.is_empty() => {
                self.complete_reasoning();
                if let Some(index) = self.assistant_index {
                    if let AgentChunk::Text { text: content, .. } = &mut self.events[index].chunk {
                        content.push_str(text);
                    }
                } else {
                    let index = self.push_text_event(run_id, thread_id, "assistant", text.clone());
                    self.assistant_index = Some(index);
                }
            }
            AgentChunk::Reasoning { thread_id, text } if !text.is_empty() => {
                self.assistant_index = None;
                if let Some(index) = self.reasoning_index {
                    if let AgentChunk::Reasoning { text: content, .. } =
                        &mut self.events[index].chunk
                    {
                        content.push_str(text);
                    }
                } else {
                    let index = self.push_text_event(run_id, thread_id, "reasoning", text.clone());
                    self.reasoning_index = Some(index);
                }
            }
            AgentChunk::ToolCall {
                id, name, input, ..
            } => {
                self.close_streaming_rows();
                if let Some(event) = self.events.iter_mut().rev().find(|event| {
                    matches!(
                        &event.chunk,
                        AgentChunk::ToolCall { id: existing_id, .. } if existing_id == id
                    )
                }) {
                    if let AgentChunk::ToolCall {
                        name: existing_name,
                        input: existing_input,
                        ..
                    } = &mut event.chunk
                    {
                        *existing_name = name.clone();
                        *existing_input = input.clone();
                    }
                    return;
                }
                self.events.push(CompactedOpenCodeEvent {
                    chunk: chunk.clone(),
                    metadata: AgentChunkMetadata::default(),
                });
            }
            AgentChunk::ToolResult { id, .. } => {
                self.close_streaming_rows();
                if let Some(event) = self.events.iter_mut().rev().find(|event| {
                    matches!(
                        &event.chunk,
                        AgentChunk::ToolResult { id: existing_id, .. } if existing_id == id
                    )
                }) {
                    event.chunk = chunk.clone();
                    return;
                }
                self.events.push(CompactedOpenCodeEvent {
                    chunk: chunk.clone(),
                    metadata: AgentChunkMetadata::default(),
                });
            }
            _ => {}
        }
    }

    fn finish(mut self) -> Vec<CompactedOpenCodeEvent> {
        self.close_streaming_rows();
        self.events
    }

    fn push_text_event(
        &mut self,
        run_id: &str,
        thread_id: &str,
        role: &str,
        content: String,
    ) -> usize {
        self.next_id += 1;
        let index = self.events.len();
        let chunk = if role == "reasoning" {
            AgentChunk::Reasoning {
                thread_id: thread_id.to_string(),
                text: content,
            }
        } else {
            AgentChunk::Text {
                thread_id: thread_id.to_string(),
                text: content,
            }
        };
        self.events.push(CompactedOpenCodeEvent {
            chunk,
            metadata: AgentChunkMetadata {
                message_id: Some(format!("opencode-{run_id}-{role}-{}", self.next_id)),
                message_phase: Some("updated"),
                content_mode: Some("snapshot"),
                ..AgentChunkMetadata::default()
            },
        });
        index
    }

    fn complete_reasoning(&mut self) {
        if let Some(index) = self.reasoning_index.take() {
            self.events[index].metadata.message_phase = Some("completed");
        }
    }

    fn close_streaming_rows(&mut self) {
        if let Some(index) = self.assistant_index.take() {
            self.events[index].metadata.message_phase = Some("completed");
        }
        self.complete_reasoning();
    }
}

impl AcpReadPhase {
    fn emits_current_turn(self) -> bool {
        self == Self::Prompt
    }
}

pub struct OpenCodeAcpManager {
    thread_manager: Arc<ThreadManager>,
    runs: ExternalRunRegistry,
    controls: Mutex<HashMap<String, AcpControl>>,
    model_cache: Mutex<Option<(Instant, Vec<String>)>>,
}

#[async_trait::async_trait]
impl ExternalLifecycleEmitter for OpenCodeAcpManager {
    fn lifecycle_agent_type(&self) -> &'static str {
        AGENT_TYPE
    }

    async fn emit_and_persist_lifecycle_chunk(
        &self,
        app_handle: &tauri::AppHandle,
        chunk: &AgentChunk,
        run_id: &str,
    ) {
        emit_chunk_with_run_id(app_handle, chunk, AGENT_TYPE, run_id);
    }

    async fn persist_emitted_stream_end(&self, _chunk: &AgentChunk, _run_id: &str) {
        // OpenCode owns the durable transcript; Flowix only consumes ACP
        // history when the conversation is reopened.
    }
}

impl OpenCodeAcpManager {
    pub fn new(thread_manager: Arc<ThreadManager>) -> Self {
        Self {
            thread_manager,
            runs: ExternalRunRegistry::new(AGENT_TYPE, "OpenCode ACP"),
            controls: Mutex::new(HashMap::new()),
            model_cache: Mutex::new(None),
        }
    }

    pub async fn list_threads(&self) -> Result<Vec<crate::agent_session::ThreadInfo>, String> {
        let sessions = super::history::list_sessions().await?;
        let bindings = self
            .thread_manager
            .list_external_session_bindings(AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        // Listing provider history must be read-only. Materializing every ACP
        // session here used to create `legacy-ses_...` agent instances, so a
        // lifecycle refresh made unrelated OpenCode sessions appear as empty
        // Flowix conversations. Existing bindings still expose product ids;
        // unbound provider history keeps its native session id until opened.
        Ok(sessions
            .into_iter()
            .map(|mut session| {
                if let Some(product_id) = bindings.get(&session.thread_id) {
                    session.thread_id = product_id.clone();
                }
                session
            })
            .collect())
    }

    pub async fn delete_thread(&self, thread_id: &str) -> Result<bool, String> {
        let session_id = self
            .thread_manager
            .get_external_session(thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?
            .unwrap_or_else(|| thread_id.to_string());
        let cwd = crate::agent_external::acp_lifecycle::cwd_or_current(
            self.thread_manager
                .read_frozen_cwd(thread_id)
                .await
                .map_err(|error| error.to_string())?,
        );
        super::history::delete_session(&session_id, &cwd).await
    }

    pub async fn supported_models(&self) -> Result<Vec<String>, String> {
        {
            let cache = self.model_cache.lock().await;
            if let Some((loaded_at, models)) = cache.as_ref() {
                if loaded_at.elapsed() < MODEL_CACHE_TTL {
                    return Ok(models.clone());
                }
            }
        }
        let models = super::history::supported_models().await?;
        *self.model_cache.lock().await = Some((Instant::now(), models.clone()));
        Ok(models)
    }

    pub async fn get_thread_messages_page(
        &self,
        thread_id: &str,
        before_sequence: Option<i64>,
        limit: i64,
    ) -> Result<crate::agent_session::ThreadMessagesPage, String> {
        super::history::get_session_page(&self.thread_manager, thread_id, before_sequence, limit)
            .await
    }

    pub async fn chat_stream(
        self: &Arc<Self>,
        thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, String> {
        let thread_id = thread_id.to_string();
        let start = self
            .runs
            .reserve_start(&thread_id, message.run_id.as_deref())
            .await?;
        let manager = self.clone();
        let app_handle = app_handle.clone();
        let run_id = start.run_id;
        let stream_end_emitted = start.stream_end_emitted;

        tokio::spawn(async move {
            manager
                .emit_user_message(&app_handle, &thread_id, &message, &run_id)
                .await;
            manager
                .emit_stream_start(&app_handle, &thread_id, &message, &run_id)
                .await;
            let result = manager
                .run_acp(
                    &thread_id,
                    &run_id,
                    message,
                    &app_handle,
                    stream_end_emitted.clone(),
                )
                .await;
            let cancelled = manager.runs.start_cancelled(&thread_id, &run_id).await;
            manager.runs.release_start(&thread_id, &run_id).await;
            let reason = if cancelled {
                Some(USER_STOPPED_REASON.to_string())
            } else { match result {
                Ok(()) => None,
                Err(error) => {
                    manager
                        .emit_run_error(&app_handle, &thread_id, error.clone(), &run_id)
                        .await;
                    Some(error)
                }
            }};
            let mut controls = manager.controls.lock().await;
            if controls.get(&thread_id).is_some_and(|control| control.run_id == run_id) {
                controls.remove(&thread_id);
            }
            drop(controls);
            manager
                .emit_stream_end(
                    &app_handle,
                    &thread_id,
                    &run_id,
                    reason,
                    &stream_end_emitted,
                )
                .await;
        });

        Ok(String::new())
    }

    pub async fn stop_chat(
        &self,
        thread_id: &str,
        run_id: Option<&str>,
        app_handle: &tauri::AppHandle,
    ) -> bool {
        let mapped_thread_id = self
            .thread_manager
            .find_thread_by_external_session(thread_id, AGENT_TYPE)
            .await
            .ok()
            .flatten();
        let control = {
            let controls = self.controls.lock().await;
            controls.get(thread_id).cloned().or_else(|| {
                mapped_thread_id
                    .as_deref()
                    .and_then(|mapped| controls.get(mapped).cloned())
            })
        };
        if let Some(control) = control.filter(|control| run_id.is_none() || run_id == Some(control.run_id.as_str())) {
            if let Some(session_id) = control.session_id.lock().await.clone() {
                let _ = write_message(&control.stdin, &protocol::cancel_notification(&session_id))
                    .await;
            }
        }

        let mut stopped = match self
            .runs
            .stop_run(thread_id, thread_id, run_id, "OpenCode ACP")
            .await {
                Ok(stopped) => stopped,
                Err(unconfirmed) => {
                    tracing::warn!("[OpenCode ACP] stop still unconfirmed for run {}", unconfirmed.run_id);
                    return false;
                }
            };
        if stopped.is_none() {
            if let Some(mapped) = mapped_thread_id.as_deref() {
                stopped = match self
                    .runs
                    .stop_run(mapped, thread_id, run_id, "OpenCode ACP")
                    .await {
                        Ok(stopped) => stopped,
                        Err(unconfirmed) => {
                            tracing::warn!("[OpenCode ACP] stop still unconfirmed for run {}", unconfirmed.run_id);
                            return false;
                        }
                    };
            }
        }
        let stopped = if let Some(stopped) = stopped {
            stopped
        } else {
            let lookup = mapped_thread_id.as_deref().unwrap_or(thread_id);
            if self.runs.cancel_start(lookup, run_id).await { return true; }
            match self.runs.stop_run(lookup, thread_id, run_id, "OpenCode ACP").await {
                Ok(Some(stopped)) => stopped,
                _ => return false,
            }
        };
        let mut controls = self.controls.lock().await;
        if controls.get(thread_id).is_some_and(|control| control.run_id == stopped.run_id) {
            controls.remove(thread_id);
        }
        if let Some(mapped) = mapped_thread_id {
            if controls.get(&mapped).is_some_and(|control| control.run_id == stopped.run_id) {
                controls.remove(&mapped);
            }
        }
        drop(controls);
        self.emit_stream_end(
            app_handle,
            thread_id,
            &stopped.run_id,
            Some(USER_STOPPED_REASON.to_string()),
            &stopped.stream_end_emitted,
        )
        .await;
        true
    }

    pub async fn running_threads(&self) -> HashMap<String, RunInfo> {
        self.runs.running_threads().await
    }

    pub async fn stop_all(&self) -> usize {
        self.controls.lock().await.clear();
        let (count, _finalized) = self
            .runs
            .kill_all_finalized("OpenCode ACP", APP_EXIT_REASON)
            .await;
        count
    }

    pub async fn reap_inactive_runs(
        &self,
        app_handle: &tauri::AppHandle,
        idle_timeout_ms: i64,
    ) -> usize {
        let finalized = self
            .runs
            .reap_inactive(idle_timeout_ms, "OpenCode ACP")
            .await;
        if !finalized.is_empty() {
            let mut controls = self.controls.lock().await;
            for run in &finalized {
                controls.remove(&run.thread_id);
            }
        }
        self.emit_watchdog_finalized(app_handle, &finalized).await;
        finalized.len()
    }

    async fn run_acp(
        &self,
        thread_id: &str,
        run_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
        stream_end_emitted: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let stored_session = self
            .thread_manager
            .get_external_session(thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        let reverse_mapping = if stored_session.is_none() {
            self.thread_manager
                .find_thread_by_external_session(thread_id, AGENT_TYPE)
                .await
                .map_err(|error| error.to_string())?
        } else {
            None
        };
        let mapped_session =
            select_resumable_session(thread_id, stored_session, reverse_mapping.is_some());
        let product_thread_id = reverse_mapping.as_deref().unwrap_or(thread_id);
        let cwd = resolve_and_freeze_runtime_cwd(
            &self.thread_manager,
            product_thread_id,
            |message, _| {
                message
                    .cwd_for_runtime(AGENT_TYPE)
                    .map(PathBuf::from)
                    .filter(|path| path.is_dir())
            },
            &message,
            mapped_session.as_deref(),
            None,
        )
        .await?;
        let additional_directories = normalized_additional_directories(
            &cwd,
            &message.workspace_paths_for_runtime(AGENT_TYPE),
        );
        let permission_mode = message
            .permission_mode_for_runtime(AGENT_TYPE)
            .map(str::to_string);
        let model = message.model_for_runtime(AGENT_TYPE).map(str::to_string);
        let workspace_paths = message.workspace_paths_for_runtime(AGENT_TYPE);
        let user_prompt = message
            .llm_content
            .clone()
            .unwrap_or(message.content.clone());
        let prompt = append_workspace_context(&user_prompt, &cwd, &workspace_paths);
        let mut turn_events = OpenCodeTurnEvents::default();
        let mut child =
            build_opencode_acp_command(&cwd, permission_mode.as_deref(), model.as_deref())
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|error| format!("failed to start OpenCode ACP: {error}"))?;
        let child_pid = child.id();
        let stdin =
            Arc::new(Mutex::new(child.stdin.take().ok_or_else(|| {
                "failed to capture OpenCode ACP stdin".to_string()
            })?));
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture OpenCode ACP stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "failed to capture OpenCode ACP stderr".to_string())?;
        let session_slot = Arc::new(Mutex::new(None));

        if let Err(mut duplicate) = self
            .runs
            .insert_reserved(
                thread_id.to_string(),
                child,
                run_id,
                stream_end_emitted,
            )
            .await
        {
            let _ = duplicate.kill().await;
            return Err("OpenCode ACP is already running for this thread".to_string());
        }
        self.controls.lock().await.insert(
            thread_id.to_string(),
            AcpControl {
                run_id: run_id.to_string(),
                stdin: stdin.clone(),
                session_id: session_slot.clone(),
            },
        );

        runtime_log::record_agent_event(
            "info",
            "opencode_acp",
            "opencode.acp_spawned",
            "OpenCode ACP process started",
            Some(thread_id),
            Some(AGENT_TYPE),
            Some(serde_json::json!({
                "child_pid": child_pid,
                "cwd": cwd,
                "session_mode": if mapped_session.is_some() { "load" } else { "new" },
                "session_id": mapped_session,
                "additional_directories": additional_directories,
                "permission_mode": permission_mode,
                "model": model,
            })),
        );

        let stderr_task = tokio::spawn(read_to_string(BufReader::new(stderr)));
        let mut stdout = BufReader::new(stdout);
        let mut tool_names = HashMap::new();
        let mut tool_inputs = HashMap::new();
        let mut allowed_roots = vec![cwd.clone()];
        allowed_roots.extend(additional_directories.iter().map(PathBuf::from));

        let protocol_result = async {
            write_message(&stdin, &protocol::initialize_request()).await?;
            let initialize_result = self
                .read_until_response(
                    thread_id,
                    run_id,
                    permission_mode.as_deref(),
                    app_handle,
                    &stdin,
                    &mut stdout,
                    protocol::INITIALIZE_ID,
                    AcpReadPhase::Initialize,
                    &allowed_roots,
                    &mut tool_names,
                    &mut tool_inputs,
                    &mut turn_events,
                )
                .await?;
            let negotiated_protocol = initialize_result
                .get("protocolVersion")
                .and_then(Value::as_u64);
            if negotiated_protocol != Some(protocol::PROTOCOL_VERSION) {
                return Err(format!(
                    "OpenCode ACP negotiated unsupported protocol version: {}",
                    negotiated_protocol
                        .map(|version| version.to_string())
                        .unwrap_or_else(|| "missing".to_string())
                ));
            }
            let can_load_session = initialize_result
                .pointer("/agentCapabilities/loadSession")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let resumable_session = mapped_session.as_deref().filter(|_| can_load_session);

            let cwd_text = cwd.to_string_lossy().to_string();
            let session_request = if let Some(session_id) = resumable_session {
                protocol::load_session_request(session_id, &cwd_text, &additional_directories)
            } else {
                protocol::new_session_request(&cwd_text, &additional_directories)
            };
            write_message(&stdin, &session_request).await?;
            let session_result = self
                .read_until_response(
                    thread_id,
                    run_id,
                    permission_mode.as_deref(),
                    app_handle,
                    &stdin,
                    &mut stdout,
                    protocol::SESSION_ID,
                    AcpReadPhase::SessionSetup,
                    &allowed_roots,
                    &mut tool_names,
                    &mut tool_inputs,
                    &mut turn_events,
                )
                .await?;
            let session_id = protocol::session_id_from_result(&session_result)
                .or_else(|| resumable_session.map(str::to_string))
                .ok_or_else(|| "OpenCode ACP did not return a session id".to_string())?;
            *session_slot.lock().await = Some(session_id.clone());
            self.runs
                .set_session_id(thread_id, Some(run_id), session_id.clone())
                .await;
            self.thread_manager
                .upsert_external_session(
                    thread_id,
                    AGENT_TYPE,
                    &session_id,
                    Some(session_result.clone()),
                )
                .await
                .map_err(|error| error.to_string())?;
            self.emit_and_persist_lifecycle_chunk(
                app_handle,
                &AgentChunk::SessionResolved {
                    thread_id: thread_id.to_string(),
                    session_id: session_id.clone(),
                },
                run_id,
            )
            .await;

            write_message(
                &stdin,
                &protocol::prompt_request(&session_id, &prompt, &message.image_paths),
            )
            .await?;
            self.read_until_response(
                thread_id,
                run_id,
                permission_mode.as_deref(),
                app_handle,
                &stdin,
                &mut stdout,
                protocol::PROMPT_ID,
                AcpReadPhase::Prompt,
                &allowed_roots,
                &mut tool_names,
                &mut tool_inputs,
                &mut turn_events,
            )
            .await?;
            Ok(())
        }
        .await;

        // Turn events were emitted as ACP notifications arrived. The
        // accumulator is only retained for in-memory compaction/ordering;
        // do not replay it here or the UI would receive every event twice.
        let _ = turn_events.finish();

        let mut controls = self.controls.lock().await;
        if controls.get(thread_id).is_some_and(|control| control.run_id == run_id) {
            controls.remove(thread_id);
        }
        drop(controls);
        if let Err(unconfirmed) = self.runs.stop_run(thread_id, thread_id, Some(run_id), "OpenCode ACP").await {
            tracing::warn!("[OpenCode ACP] normal cleanup unconfirmed for run {}", unconfirmed.run_id);
            return Err("StopUnconfirmed: OpenCode ACP process exit was not confirmed".to_string());
        }
        let stderr_text = stderr_task
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        if !stderr_text.trim().is_empty() {
            runtime_log::record_agent_event(
                "info",
                "opencode_acp",
                "opencode.acp_stderr",
                "OpenCode ACP wrote diagnostic output",
                Some(thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({
                    "stderr_preview": truncate_for_log(stderr_text.trim())
                })),
            );
        }
        match protocol_result {
            Ok(()) => Ok(()),
            Err(error) => {
                let stderr = stderr_text.trim();
                if stderr.is_empty() || error.contains(stderr) {
                    Err(error)
                } else {
                    // ACP responses are authoritative, but OpenCode may put
                    // the provider's HTTP/auth/rate-limit explanation only on
                    // stderr. Preserve the protocol error first and append a
                    // bounded diagnostic tail so the shared classifier and UI
                    // can expose the upstream reason without dumping logs.
                    Err(format!(
                        "{error}\nOpenCode stderr: {}",
                        truncate_for_log(stderr)
                    ))
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn read_until_response(
        &self,
        thread_id: &str,
        run_id: &str,
        permission_mode: Option<&str>,
        app_handle: &tauri::AppHandle,
        stdin: &Arc<Mutex<ChildStdin>>,
        stdout: &mut BufReader<tokio::process::ChildStdout>,
        response_id: u64,
        phase: AcpReadPhase,
        allowed_roots: &[PathBuf],
        tool_names: &mut HashMap<String, String>,
        tool_inputs: &mut HashMap<String, Value>,
        turn_events: &mut OpenCodeTurnEvents,
    ) -> Result<Value, String> {
        loop {
            let Some((line, truncated)) = read_capped_line(stdout, MAX_STDOUT_LINE_BYTES).await?
            else {
                return Err(format!(
                    "OpenCode ACP closed before responding to request {response_id}"
                ));
            };
            self.runs.touch(thread_id, Some(run_id)).await;
            if truncated {
                return Err("OpenCode ACP emitted an oversized JSON-RPC message".to_string());
            }
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(line)
                .map_err(|error| format!("invalid OpenCode ACP JSON-RPC: {error}"))?;

            if let Some(response) =
                protocol::permission_response(&value, permission_mode, allowed_roots)
            {
                write_message(stdin, &response).await?;
                continue;
            }
            if let Some(response) = protocol::unsupported_request_response(&value) {
                write_message(stdin, &response).await?;
                continue;
            }
            if !phase.emits_current_turn() {
                if let Some(result) = protocol::response_result(&value, response_id) {
                    return result.cloned();
                }
                continue;
            }
            for mut chunk in protocol::chunks_from_message(thread_id, &value, tool_inputs) {
                remember_tool_name(&mut chunk, tool_names);
                turn_events.observe(&chunk, run_id);
                emit_chunk_with_run_id(app_handle, &chunk, AGENT_TYPE, run_id);
            }
            if let Some(result) = protocol::response_result(&value, response_id) {
                return result.cloned();
            }
        }
    }
}

fn remember_tool_name(chunk: &mut AgentChunk, tool_names: &mut HashMap<String, String>) {
    match chunk {
        AgentChunk::ToolCall { id, name, .. } => {
            if let Some(original) = tool_names.get(id) {
                *name = original.clone();
            } else {
                tool_names.insert(id.clone(), name.clone());
            }
        }
        AgentChunk::ToolResult { id, name, .. } => {
            if let Some(original) = tool_names.get(id) {
                *name = original.clone();
            }
        }
        _ => {}
    }
}

fn select_resumable_session(
    thread_id: &str,
    stored_session: Option<String>,
    thread_id_is_external_session: bool,
) -> Option<String> {
    stored_session.or_else(|| thread_id_is_external_session.then(|| thread_id.to_string()))
}

async fn write_message(stdin: &Arc<Mutex<ChildStdin>>, message: &Value) -> Result<(), String> {
    let mut serialized = serde_json::to_vec(message).map_err(|error| error.to_string())?;
    serialized.push(b'\n');
    let mut stdin = stdin.lock().await;
    stdin
        .write_all(&serialized)
        .await
        .map_err(|error| format!("failed to write OpenCode ACP message: {error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("failed to flush OpenCode ACP message: {error}"))
}

fn normalized_additional_directories(cwd: &std::path::Path, paths: &[String]) -> Vec<String> {
    let cwd = cwd
        .to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .to_string();
    let mut seen = std::collections::HashSet::new();
    paths
        .iter()
        .map(|path| path.trim().trim_end_matches(['/', '\\']).to_string())
        .filter(|path| !path.is_empty() && path != &cwd)
        .filter(|path| std::path::Path::new(path).is_dir())
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resumes_when_frontend_uses_the_canonical_session_id() {
        assert_eq!(
            select_resumable_session("session-123", None, true).as_deref(),
            Some("session-123")
        );
    }

    #[test]
    fn stored_product_mapping_wins_over_thread_id_hint() {
        assert_eq!(
            select_resumable_session("product-thread", Some("session-456".into()), false)
                .as_deref(),
            Some("session-456")
        );
    }

    #[test]
    fn only_prompt_phase_emits_current_turn_chunks() {
        assert!(!AcpReadPhase::Initialize.emits_current_turn());
        assert!(!AcpReadPhase::SessionSetup.emits_current_turn());
        assert!(AcpReadPhase::Prompt.emits_current_turn());
    }

    #[test]
    fn completed_tool_update_reuses_the_original_name() {
        let mut names = HashMap::new();
        let mut call = AgentChunk::ToolCall {
            thread_id: "thread".into(),
            id: "call-1".into(),
            name: "Read file".into(),
            input: Value::Null,
        };
        remember_tool_name(&mut call, &mut names);
        let mut result = AgentChunk::ToolResult {
            thread_id: "thread".into(),
            id: "call-1".into(),
            name: "C:\\workspace\\example.txt".into(),
            result: Value::Null,
        };
        remember_tool_name(&mut result, &mut names);
        assert!(matches!(
            result,
            AgentChunk::ToolResult { name, .. } if name == "Read file"
        ));
    }

    #[test]
    fn completed_tool_call_update_reuses_the_original_name() {
        let mut names = HashMap::new();
        let mut initial = AgentChunk::ToolCall {
            thread_id: "thread".into(),
            id: "call-1".into(),
            name: "read".into(),
            input: serde_json::json!({}),
        };
        remember_tool_name(&mut initial, &mut names);

        let mut completed = AgentChunk::ToolCall {
            thread_id: "thread".into(),
            id: "call-1".into(),
            name: "C:\\workspace\\example.txt".into(),
            input: serde_json::json!({ "filePath": "C:\\workspace\\example.txt" }),
        };
        remember_tool_name(&mut completed, &mut names);

        assert!(matches!(
            completed,
            AgentChunk::ToolCall { name, input, .. }
                if name == "read"
                    && input["filePath"] == "C:\\workspace\\example.txt"
        ));
    }

    #[test]
    fn turn_events_compact_stream_chunks_into_snapshot_rows() {
        let mut turn = OpenCodeTurnEvents::default();
        let chunks = [
            AgentChunk::Reasoning {
                thread_id: "thread".into(),
                text: "inspect ".into(),
            },
            AgentChunk::Reasoning {
                thread_id: "thread".into(),
                text: "files".into(),
            },
            AgentChunk::ToolCall {
                thread_id: "thread".into(),
                id: "call-1".into(),
                name: "read".into(),
                input: serde_json::json!({ "filePath": "/workspace/README.md" }),
            },
            AgentChunk::ToolResult {
                thread_id: "thread".into(),
                id: "call-1".into(),
                name: "read".into(),
                result: serde_json::json!({ "content": "hello" }),
            },
            AgentChunk::Text {
                thread_id: "thread".into(),
                text: "The project ".into(),
            },
            AgentChunk::Text {
                thread_id: "thread".into(),
                text: "is ready.".into(),
            },
        ];
        for chunk in &chunks {
            turn.observe(chunk, "run-1");
        }

        let events = turn.finish();
        assert_eq!(
            events
                .iter()
                .map(|event| event.chunk.kind())
                .collect::<Vec<_>>(),
            vec!["reasoning", "tool_call", "tool_result", "text"]
        );
        assert!(matches!(
            &events[0].chunk,
            AgentChunk::Reasoning { text, .. } if text == "inspect files"
        ));
        assert_eq!(events[0].metadata.content_mode, Some("snapshot"));
        assert_eq!(events[0].metadata.message_phase, Some("completed"));
        assert!(matches!(
            &events[1].chunk,
            AgentChunk::ToolCall { id, input, .. }
                if id == "call-1" && input["filePath"] == "/workspace/README.md"
        ));
        assert!(matches!(
            &events[3].chunk,
            AgentChunk::Text { text, .. } if text == "The project is ready."
        ));
        assert_eq!(events[3].metadata.content_mode, Some("snapshot"));
        assert_eq!(events[3].metadata.message_phase, Some("completed"));
    }
}
