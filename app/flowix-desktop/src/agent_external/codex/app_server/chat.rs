//! 一条对话回合的提交与插话。
//!
//! `chat_stream` 负责把一条用户消息变成 provider 的一次 turn；`steer_chat` 是同一
//! turn 内的追加指令。队列语义不在这里（见 `queue`）。

use super::*;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use serde_json::{Value, json};
use tokio::sync::Mutex;
use super::super::AGENT_TYPE;
use crate::agent_external::lifecycle::ExternalLifecycleEmitter;
use crate::agent_external::USER_STOPPED_REASON;
use crate::agent_wire::AgentUserMessage;

impl CodexAppServerManager {
    pub async fn chat_stream(
        self: &Arc<Self>,
        flowix_thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, String> {
        *self.inner.app_handle.lock().await = Some(app_handle.clone());
        self.ensure_connection().await?;
        let flowix_thread_id = flowix_thread_id.to_string();
        let run_id = message
            .run_id
            .clone()
            .unwrap_or_else(|| crate::agent_external::resolve_run_id(&flowix_thread_id, None));
        if self
            .inner
            .active_turns
            .lock()
            .await
            .contains_key(&flowix_thread_id)
        {
            return Err("Codex already has an active turn for this thread".to_string());
        }
        // The web projection inserts the user row optimistically before this
        // request reaches the runtime. Codex's own userMessage item is the
        // acknowledgement/history source; emitting another synthetic user
        // event here creates a second visible row and has no provider id.
        self.emit_stream_start(app_handle, &flowix_thread_id, &message, &run_id)
            .await;

        let stream_end_emitted = Arc::new(AtomicBool::new(false));
        let completed_agent_messages = Arc::new(Mutex::new(Vec::new()));
        let started = async {
            let (codex_thread_id, cwd) = self.resolve_codex_thread(&flowix_thread_id, &message).await?;
            let approval = app_server_approval_policy(message.permission_mode_for_runtime(AGENT_TYPE));
            let workspace_roots = message.workspace_paths_for_runtime(AGENT_TYPE);
            let sandbox = app_server_sandbox_with_roots(
                message.permission_mode_for_runtime(AGENT_TYPE),
                &workspace_roots,
            );
            let mut input = vec![json!({ "type": "text", "text": message.llm_content.clone().unwrap_or_else(|| message.content.clone()) })];
            let mut attached_files = Vec::new();
            for path in message.image_paths.iter().filter(|path| std::path::Path::new(path).is_file()) {
                if is_image_attachment(path) {
                    input.push(json!({ "type": "localImage", "path": path }));
                } else {
                    attached_files.push(path.as_str());
                }
            }
            if !attached_files.is_empty() {
                let paths = attached_files.iter().map(|path| format!("- {path}")).collect::<Vec<_>>().join("\n");
                input.push(json!({ "type": "text", "text": format!("\n<attached_files>\n{paths}\n</attached_files>") }));
            }
            // App Server notifications are allowed to arrive before the
            // `turn/start` response. Register the run before sending the RPC
            // so the real `item/completed(userMessage)` acknowledgement is not
            // dropped during that window. `turn/started` (or the RPC result)
            // fills in the concrete turn id below.
            let cancelled_before_start = {
                let mut turns = self.inner.active_turns.lock().await;
                let cancelled = take_pending_cancellation(
                    &mut *self.inner.pending_cancellations.lock().await,
                    &flowix_thread_id,
                    &run_id,
                );
                if !cancelled {
                    turns.insert(flowix_thread_id.clone(), ActiveTurn {
                        flowix_thread_id: flowix_thread_id.clone(),
                        run_id: run_id.clone(),
                        client_user_message_id: None,
                        codex_thread_id: codex_thread_id.clone(),
                        codex_turn_id: String::new(),
                        binding: TurnBinding::StartResponse,
                        pending_notifications: Vec::new(),
                        dropped_notifications: 0,
                        turn_ready: Arc::new(tokio::sync::Notify::new()),
                        cancel_requested: false,
                        stopping: false,
                        command_id: None,
                        command: None,
                        app_handle: app_handle.clone(),
                        started_at: chrono::Utc::now().timestamp_millis(),
                        last_event_at: chrono::Utc::now().timestamp_millis(),
                        stream_end_emitted: stream_end_emitted.clone(),
                        completed_agent_messages: completed_agent_messages.clone(),
                        pending_steers: Vec::new(),
                    });
                }
                cancelled
            };
            if cancelled_before_start {
                self.emit_stream_end(
                    app_handle,
                    &flowix_thread_id,
                    &run_id,
                    Some(USER_STOPPED_REASON.to_string()),
                    &stream_end_emitted,
                ).await;
                return Ok(());
            }
            let mut turn_params = json!({
                "threadId": codex_thread_id,
                "input": input,
                "cwd": cwd,
                "model": message.codex_model_for_runtime(),
                "effort": message.codex_reasoning_effort_for_runtime(),
                "approvalPolicy": approval,
                "sandboxPolicy": sandbox
            });
            if let Some(service_tier) = message.codex_service_tier_for_runtime() {
                turn_params["serviceTier"] = json!(service_tier);
            }
            let result = self.request("turn/start", turn_params).await?;
            let codex_turn_id = result.pointer("/turn/id").and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| "Codex app-server did not return a turn id".to_string())?.to_string();
            // `turn/completed` can race the RPC response. Only update an
            // active run that still belongs to this invocation; never revive a
            // run that the notification path has already finalized.
            let _dispatch = self.inner.notification_dispatch.lock().await;
            let (should_interrupt, pending_notifications) = {
                let mut active_turns = self.inner.active_turns.lock().await;
                let active = active_turns
                    .get_mut(&flowix_thread_id)
                    .filter(|active| active.run_id == run_id);
                if let Some(active) = active {
                    active.codex_turn_id = codex_turn_id;
                    active.turn_ready.notify_one();
                    let pending = std::mem::take(&mut active.pending_notifications);
                    let should_interrupt =
                        active.cancel_requested && !active.codex_turn_id.is_empty();
                    if should_interrupt {
                        active.cancel_requested = false;
                    }
                    (should_interrupt, pending)
                } else {
                    (false, Vec::new())
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
                    .get(&flowix_thread_id)
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
            Ok::<(), String>(())
        }.await;
        if let Err(error) = started {
            let active = {
                let mut turns = self.inner.active_turns.lock().await;
                if turns
                    .get(&flowix_thread_id)
                    .is_some_and(|active| active.run_id == run_id)
                {
                    turns.remove(&flowix_thread_id)
                } else {
                    None
                }
            };
            // If the notification path already completed the turn, its
            // terminal event owns the run. Otherwise surface the RPC failure
            // and close the pre-registered lifecycle exactly once.
            if !stream_end_emitted.load(Ordering::Acquire) {
                self.emit_run_error(app_handle, &flowix_thread_id, error.clone(), &run_id)
                    .await;
                self.emit_stream_end(
                    app_handle,
                    &flowix_thread_id,
                    &run_id,
                    Some(error),
                    active
                        .as_ref()
                        .map(|turn| &turn.stream_end_emitted)
                        .unwrap_or(&stream_end_emitted),
                )
                .await;
            }
        }
        Ok(String::new())
    }


    pub async fn steer_chat(
        &self,
        flowix_thread_id: &str,
        message: AgentUserMessage,
        client_user_message_id: String,
        app_handle: &tauri::AppHandle,
    ) -> Result<(), String> {
        self.ensure_connection().await?;
        let (turn_ready, is_chat_starting) = self
            .inner
            .active_turns
            .lock()
            .await
            .get(flowix_thread_id)
            .map(|turn| {
                (
                    turn.turn_ready.clone(),
                    turn.binding == TurnBinding::StartResponse
                        && turn.codex_turn_id.is_empty()
                        && turn.command_id.is_none(),
                )
            })
            .ok_or_else(|| "Codex has no steerable active turn".to_string())?;
        if is_chat_starting {
            tokio::time::timeout(REQUEST_TIMEOUT, turn_ready.notified())
                .await
                .map_err(|_| "Codex turn did not become steerable in time".to_string())?;
        }
        let active = self
            .inner
            .active_turns
            .lock()
            .await
            .get(flowix_thread_id)
            .filter(|turn| turn.command_id.is_none() && !turn.codex_turn_id.is_empty())
            .map(|turn| (turn.codex_thread_id.clone(), turn.codex_turn_id.clone()))
            .ok_or_else(|| "Codex has no steerable active turn".to_string())?;
        let input = codex_user_input(&message);
        // Register before the RPC: item/completed can beat its response. An
        // acknowledgement removes the receipt and the response never recreates it.
        {
            let mut turns = self.inner.active_turns.lock().await;
            let turn = turns
                .get_mut(flowix_thread_id)
                .filter(|turn| {
                    turn.codex_turn_id == active.1
                        && !turn.stream_end_emitted.load(Ordering::Acquire)
                })
                .ok_or_else(|| "Codex has no steerable active turn".to_string())?;
            if turn
                .pending_steers
                .iter()
                .any(|item| item["clientUserMessageId"] == client_user_message_id)
            {
                return Err("Codex steering already submitted".to_string());
            }
            turn.pending_steers.push(json!({
                "id": client_user_message_id, "clientUserMessageId": client_user_message_id,
                "input": input, "content": message.content, "runId": turn.run_id,
                "queuedAt": chrono::Utc::now().timestamp_millis(),
                "deliveryStatus": "submitting"
            }));
        }
        let result = self
            .request(
                "turn/steer",
                json!({
                    "threadId": active.0,
                    "expectedTurnId": active.1,
                    "clientUserMessageId": client_user_message_id,
                    "input": input,
                }),
            )
            .await;
        {
            let mut turns = self.inner.active_turns.lock().await;
            if let Some(turn) = turns
                .get_mut(flowix_thread_id)
                .filter(|turn| turn.codex_turn_id == active.1)
            {
                finish_pending_steer(
                    &mut turn.pending_steers,
                    &client_user_message_id,
                    result.is_ok(),
                );
            }
        }
        result?;
        let _ = app_handle;
        Ok(())
    }

}
