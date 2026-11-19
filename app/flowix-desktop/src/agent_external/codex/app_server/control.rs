//! 控制面：审批应答、线程设置、斜杠命令。
//!
//! 斜杠命令是唯一「Flowix 自己造 turn」的路径，因此它同时承担 run 注册、消息写入
//! 与错误收口 —— 和普通对话走的是同一套 run 语义，只是发起方不同。

use super::*;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use serde_json::{Value, json};
use tokio::sync::Mutex;
use super::super::AGENT_TYPE;
use crate::agent_external::lifecycle::ExternalLifecycleEmitter;
use crate::agent_external::{
    USER_STOPPED_REASON,
    emit_chunk_with_run_id,
    select_external_session_for_runtime,
};
use crate::agent_wire::{AgentChunk, AgentRuntimeConfig, AgentUserMessage};

impl CodexAppServerManager {
    /// Reply to a server-initiated JSON-RPC request with its original id.
    /// RequestId is kept as JSON text for compatibility with numeric and
    /// string ids emitted by different app-server versions.
    pub async fn respond_to_server_request(
        &self,
        request_id: &str,
        result: Value,
    ) -> Result<(), String> {
        let mut pending = self.inner.pending_approvals.lock().await;
        let Some(index) = pending
            .iter()
            .position(|request| request.request_id == request_id)
        else {
            return Err("Codex approval request is no longer pending".to_string());
        };
        pending.remove(index);
        drop(pending);
        let id = serde_json::from_str::<Value>(request_id)
            .map_err(|_| "Invalid Codex approval request id".to_string())?;
        self.write(json!({ "id": id, "result": result })).await
    }


    pub async fn pending_approval_requests(&self) -> Vec<CodexApprovalRequest> {
        self.inner.pending_approvals.lock().await.clone()
    }


    /// Apply settings to an existing Codex thread. These settings affect the
    /// next turn and preserve the conversation history.
    pub async fn update_thread_settings(
        &self,
        flowix_thread_id: &str,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
        permission_mode: Option<&str>,
    ) -> Result<(), String> {
        self.ensure_connection().await?;
        let stored = self
            .inner
            .thread_manager
            .get_external_session(flowix_thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        let codex_thread_id = select_external_session_for_runtime(stored, None)
            .ok_or_else(|| "Codex thread has not been started".to_string())?;
        let mut settings = serde_json::Map::new();
        if let Some(model) = model.filter(|value| !value.trim().is_empty() && *value != "inherit") {
            settings.insert("model".into(), json!(model));
        }
        if let Some(effort) =
            reasoning_effort.filter(|value| !value.trim().is_empty() && *value != "inherit")
        {
            settings.insert("reasoningEffort".into(), json!(effort));
        }
        if let Some(permission) = permission_mode {
            settings.insert("sandboxPolicy".into(), app_server_sandbox(Some(permission)));
        }
        if settings.is_empty() {
            return Ok(());
        }
        settings.insert("threadId".into(), json!(codex_thread_id));
        self.request("thread/settings/update", Value::Object(settings).into())
            .await?;
        Ok(())
    }


    /// Execute a Codex-native composer command without sending the slash text
    /// through `turn/start`. The TUI handles these commands locally; Flowix
    /// must call the equivalent App Server method explicitly.
    pub async fn execute_slash_command(
        self: &Arc<Self>,
        flowix_thread_id: &str,
        command: &str,
        runtime_config: Option<AgentRuntimeConfig>,
        provided_run_id: Option<&str>,
        provided_command_id: Option<&str>,
        app_handle: &tauri::AppHandle,
    ) -> Result<Value, String> {
        // Capture the command's logical position before any connection,
        // session lookup, or RPC work can delay the terminal event.
        let started_at = chrono::Utc::now().timestamp_millis();
        self.ensure_connection().await?;
        *self.inner.app_handle.lock().await = Some(app_handle.clone());
        if self
            .inner
            .active_turns
            .lock()
            .await
            .contains_key(flowix_thread_id)
        {
            return Err("Codex already has active work for this thread".to_string());
        }
        let stored = self
            .inner
            .thread_manager
            .get_external_session(flowix_thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        let command = command.trim();
        let run_id = provided_run_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| crate::agent_external::resolve_run_id(flowix_thread_id, None));
        let message = AgentUserMessage {
            content: command.to_string(),
            display_content: None,
            llm_content: None,
            image_paths: Vec::new(),
            run_id: Some(run_id.clone()),
            system_reminder_directory: None,
            agent_type: Some(AGENT_TYPE.to_string()),
            runtime_config,
            permission_mode: None,
            codex_model: None,
            codex_reasoning_effort: None,
            conversation_title: None,
        };
        let codex_thread_id = match select_external_session_for_runtime(stored, None) {
            Some(codex_thread_id) => codex_thread_id,
            None => {
                self.resolve_codex_thread(flowix_thread_id, &message)
                    .await?
                    .0
            }
        };

        let command_id = provided_command_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("codex-command-{}", uuid::Uuid::new_v4()));
        let waits_for_provider_turn =
            is_codex_compact_command(command) || is_codex_goal_mutation_command(command);
        let ended = Arc::new(AtomicBool::new(false));
        let completed_agent_messages = Arc::new(Mutex::new(Vec::new()));
        // Native commands can either be an immediate thread operation or
        // return/start a provider turn. `/goal` is a mutation RPC whose
        // response is followed by an autonomous provider turn, as shown by
        // Codex's `thread_goal_updated -> task_started` event sequence. Keep
        // an empty turn id temporarily: `turn/started` can arrive before the
        // command RPC response and fills it in. Register before emitting the
        // optimistic lifecycle events so an immediate stop cannot miss it.
        let cancelled_before_start = {
            let mut turns = self.inner.active_turns.lock().await;
            let cancelled = take_pending_cancellation(
                &mut *self.inner.pending_cancellations.lock().await,
                flowix_thread_id,
                &run_id,
            );
            if !cancelled {
                turns.insert(
                    flowix_thread_id.to_string(),
                    ActiveTurn {
                        flowix_thread_id: flowix_thread_id.to_string(),
                        run_id: run_id.clone(),
                        client_user_message_id: None,
                        codex_thread_id: codex_thread_id.clone(),
                        codex_turn_id: String::new(),
                        binding: TurnBinding::StartedNotification,
                        pending_notifications: Vec::new(),
                        dropped_notifications: 0,
                        turn_ready: Arc::new(tokio::sync::Notify::new()),
                        cancel_requested: false,
                        stopping: false,
                        command_id: Some(command_id.clone()),
                        command: Some(command.to_string()),
                        app_handle: app_handle.clone(),
                        started_at,
                        last_event_at: chrono::Utc::now().timestamp_millis(),
                        stream_end_emitted: ended.clone(),
                        completed_agent_messages: completed_agent_messages.clone(),
                        pending_steers: Vec::new(),
                    },
                );
            }
            cancelled
        };
        if cancelled_before_start {
            self.emit_codex_command(
                app_handle,
                flowix_thread_id,
                &run_id,
                &command_id,
                command,
                started_at,
                "cancelled",
                Some("Command interrupted".to_string()),
            )
            .await;
            self.emit_stream_end(
                app_handle,
                flowix_thread_id,
                &run_id,
                Some(USER_STOPPED_REASON.to_string()),
                &ended,
            )
            .await;
            return Ok(json!({ "cancelled": true }));
        }
        self.emit_codex_command(
            app_handle,
            flowix_thread_id,
            &run_id,
            &command_id,
            command,
            started_at,
            "pending",
            None,
        )
        .await;
        self.emit_stream_start(app_handle, flowix_thread_id, &message, &run_id)
            .await;

        let result = match self.execute_slash_request(&codex_thread_id, command).await {
            Ok(result) => result,
            Err(error) => {
                let mut turns = self.inner.active_turns.lock().await;
                if turns
                    .get(flowix_thread_id)
                    .is_some_and(|active| active.run_id == run_id)
                {
                    turns.remove(flowix_thread_id);
                }
                drop(turns);
                // A stop can win while the command RPC is still pending. In
                // that case stop_chat already emitted the cancelled command
                // and stream end; do not overwrite them with an RPC error.
                if !ended.load(Ordering::Acquire) {
                    self.emit_codex_command(
                        app_handle,
                        flowix_thread_id,
                        &run_id,
                        &command_id,
                        command,
                        started_at,
                        "error",
                        Some(error.clone()),
                    )
                    .await;
                    self.emit_run_error(app_handle, flowix_thread_id, error.clone(), &run_id)
                        .await;
                    self.emit_stream_end(
                        app_handle,
                        flowix_thread_id,
                        &run_id,
                        Some(error.clone()),
                        &ended,
                    )
                    .await;
                }
                return Err(error);
            }
        };

        let response_turn_id = result
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .map(str::to_string);
        let _dispatch = self.inner.notification_dispatch.lock().await;
        let (has_provider_turn, should_interrupt, pending_notifications) = {
            let mut active_turns = self.inner.active_turns.lock().await;
            let active = active_turns
                .get_mut(flowix_thread_id)
                .filter(|active| active.run_id == run_id);
            if let Some(active) = active {
                if active.codex_turn_id.is_empty() {
                    if let Some(turn_id) = response_turn_id {
                        active.codex_turn_id = turn_id;
                        active.turn_ready.notify_one();
                    }
                }
                let pending = if active.codex_turn_id.is_empty() {
                    Vec::new()
                } else {
                    std::mem::take(&mut active.pending_notifications)
                };
                let should_interrupt = active.cancel_requested && !active.codex_turn_id.is_empty();
                if should_interrupt {
                    // Only one path should schedule the interrupt. The
                    // notification path performs the same handoff for a
                    // turn/started event that beats this RPC response.
                    active.cancel_requested = false;
                }
                (!active.codex_turn_id.is_empty(), should_interrupt, pending)
            } else {
                (false, false, Vec::new())
            }
        };
        for notification in pending_notifications {
            dispatch_notification_inner(&self.inner, &notification).await;
        }
        drop(_dispatch);
        if should_interrupt {
            let active = self
                .inner
                .active_turns
                .lock()
                .await
                .get(flowix_thread_id)
                .filter(|active| active.run_id == run_id)
                .map(|active| (active.codex_thread_id.clone(), active.codex_turn_id.clone()));
            if let Some((codex_thread_id, codex_turn_id)) = active {
                let _ = self
                    .request(
                        "turn/interrupt",
                        json!({ "threadId": codex_thread_id, "turnId": codex_turn_id }),
                    )
                    .await;
            }
        }
        // A command may finish its provider turn before the request response
        // is delivered. In that case the notification path already emitted
        // the terminal command/stream events and there is nothing left to do.
        if !has_provider_turn && ended.load(Ordering::Acquire) {
            return Ok(result);
        }
        // `thread/compact/start` and `thread/goal/set` return before the
        // asynchronous provider turn is announced. Keep their command row
        // pending even if `turn/started` has not arrived yet; otherwise the
        // next notification would be dropped as a late event. Read/clear
        // operations remain synchronous and are finalized from their RPC
        // response.
        if !has_provider_turn && !waits_for_provider_turn {
            let mut turns = self.inner.active_turns.lock().await;
            if turns
                .get(flowix_thread_id)
                .is_some_and(|active| active.run_id == run_id)
            {
                turns.remove(flowix_thread_id);
            }
            drop(turns);
            self.emit_codex_command(
                app_handle,
                flowix_thread_id,
                &run_id,
                &command_id,
                command,
                started_at,
                "success",
                codex_command_result_text(command, &result),
            )
            .await;
            self.emit_stream_end(app_handle, flowix_thread_id, &run_id, None, &ended)
                .await;
        }
        Ok(result)
    }


    pub(super) async fn emit_codex_command(
        &self,
        app_handle: &tauri::AppHandle,
        thread_id: &str,
        run_id: &str,
        command_id: &str,
        command: &str,
        timestamp: i64,
        status: &str,
        result: Option<String>,
    ) {
        let chunk = AgentChunk::CodexCommand {
            thread_id: thread_id.to_string(),
            id: command_id.to_string(),
            command: command.to_string(),
            status: status.to_string(),
            result,
            timestamp,
        };
        emit_chunk_with_run_id(app_handle, &chunk, AGENT_TYPE, run_id);
    }


    pub(super) async fn execute_slash_request(
        &self,
        codex_thread_id: &str,
        command: &str,
    ) -> Result<Value, String> {
        if is_codex_compact_command(command) {
            return self
                .request(
                    "thread/compact/start",
                    json!({ "threadId": codex_thread_id }),
                )
                .await;
        }
        let lower = command.to_ascii_lowercase();
        let rest = lower
            .strip_prefix("/goal")
            .filter(|rest| rest.chars().next().is_none_or(char::is_whitespace))
            .map(|_| command[5..].trim())
            .ok_or_else(|| format!("Unsupported Codex slash command: {command}"))?;
        if rest.is_empty() || rest.eq_ignore_ascii_case("get") {
            return self
                .request("thread/goal/get", json!({ "threadId": codex_thread_id }))
                .await;
        }
        if rest.eq_ignore_ascii_case("clear") {
            return self
                .request("thread/goal/clear", json!({ "threadId": codex_thread_id }))
                .await;
        }
        if rest.eq_ignore_ascii_case("pause") || rest.eq_ignore_ascii_case("resume") {
            let current = self
                .request("thread/goal/get", json!({ "threadId": codex_thread_id }))
                .await?;
            let goal = current.get("goal").cloned().unwrap_or(Value::Null);
            let objective = goal
                .get("objective")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "No Codex goal is currently set".to_string())?;
            let status = if rest.eq_ignore_ascii_case("pause") {
                "paused"
            } else {
                "active"
            };
            return self
                .request(
                    "thread/goal/set",
                    json!({
                        "threadId": codex_thread_id,
                        "objective": objective,
                        "status": status,
                        "tokenBudget": goal.get("tokenBudget").cloned().unwrap_or(Value::Null)
                    }),
                )
                .await;
        }
        let objective = rest
            .strip_prefix("edit ")
            .or_else(|| rest.strip_prefix("set "))
            .unwrap_or(rest)
            .trim();
        if objective.is_empty() || objective.len() > 4_000 {
            return Err("Codex goal objective must contain 1–4000 characters".to_string());
        }
        self.request(
            "thread/goal/set",
            json!({
                "threadId": codex_thread_id,
                "objective": objective,
                "status": "active"
            }),
        )
        .await
    }
}
