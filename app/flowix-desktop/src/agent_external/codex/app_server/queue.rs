//! 待发队列：用户在上一条还没跑完时继续说的话。
//!
//! 真正的队列由 Codex 持有，Flowix 这边只维护「队列条目 ↔ run / 乐观用户消息」的
//! 绑定。所以这里的每个写操作都要先在 provider 侧确认，再改本地绑定 —— 反过来会
//! 出现「界面显示排队、实际没排队」。

use super::*;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use serde_json::{Value, json};
use tokio::sync::Mutex;
use super::super::AGENT_TYPE;
use crate::agent_external::lifecycle::ExternalLifecycleEmitter;
use crate::agent_external::select_external_session_for_runtime;
use crate::agent_wire::AgentUserMessage;

impl CodexAppServerManager {
    pub(super) async fn resolve_queue_thread_id(&self, flowix_thread_id: &str) -> Result<String, String> {
        self.ensure_connection().await?;
        let stored = self
            .inner
            .thread_manager
            .get_external_session(flowix_thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        let codex_thread_id = select_external_session_for_runtime(stored, None)
            .ok_or_else(|| "Codex thread is not available for queue operations".to_string())?;
        self.request("thread/resume", json!({ "threadId": codex_thread_id }))
            .await?;
        Ok(codex_thread_id)
    }


    /// Add a Follow-up to Codex's persistent app-server queue.
    pub async fn queue_follow_up(
        self: &Arc<Self>,
        flowix_thread_id: &str,
        message: AgentUserMessage,
        client_user_message_id: String,
        app_handle: &tauri::AppHandle,
    ) -> Result<Value, String> {
        let codex_thread_id = self.resolve_queue_thread_id(flowix_thread_id).await?;
        let _queue_operation = lock_follow_up_operations(&self.inner, flowix_thread_id).await;
        *self.inner.app_handle.lock().await = Some(app_handle.clone());
        let run_id = message
            .run_id
            .clone()
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| crate::agent_external::resolve_run_id(flowix_thread_id, None));
        let mut message = message;
        message.run_id = Some(run_id.clone());
        upsert_queued_follow_up(
            &self.inner,
            QueuedCodexFollowUp {
                flowix_thread_id: flowix_thread_id.to_string(),
                codex_thread_id: codex_thread_id.clone(),
                queued_submission_id: None,
                client_user_message_id: client_user_message_id.clone(),
                message: message.clone(),
                run_id,
            },
        )
        .await;
        let input = codex_user_input(&message);
        let result = self
            .request(
                "thread/queue/add",
                json!({
                    "threadId": codex_thread_id.clone(),
                    "clientUserMessageId": client_user_message_id.clone(),
                    "input": input,
                }),
            )
            .await;
        match result {
            Ok(result) => {
                let queued_submission_id = result
                    .pointer("/queuedSubmission/id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(id) = queued_submission_id.as_deref() {
                    {
                        let mut by_thread = self.inner.queued_follow_ups.lock().await;
                        if let Some(queued) =
                            by_thread.get_mut(&codex_thread_id).and_then(|items| {
                                items.iter_mut().find(|item| {
                                    item.client_user_message_id == client_user_message_id
                                })
                            })
                        {
                            queued.queued_submission_id = Some(id.to_string());
                        }
                    }

                    let provider_is_idle = {
                        let mut active_turns = self.inner.active_turns.lock().await;
                        if active_turns.get(flowix_thread_id).is_some_and(|active| {
                            active.codex_thread_id == codex_thread_id
                                && active.stream_end_emitted.load(Ordering::Acquire)
                        }) {
                            active_turns.remove(flowix_thread_id);
                        }
                        !active_turns
                            .values()
                            .any(|active| active.codex_thread_id == codex_thread_id)
                    };
                    if provider_is_idle {
                        // The thread can become idle while this queue/add RPC
                        // is in flight. Start the provider's current queue
                        // head, which may be an older submission, instead of
                        // jumping directly to the item just added.
                        let queue_head = match self
                            .request(
                                "thread/queue/list",
                                json!({ "threadId": codex_thread_id.clone() }),
                            )
                            .await
                        {
                            Ok(queue) => {
                                remember_queued_follow_ups(
                                    &self.inner,
                                    flowix_thread_id,
                                    &codex_thread_id,
                                    &queue,
                                )
                                .await;
                                queued_follow_up_at_queue_head(
                                    flowix_thread_id,
                                    &codex_thread_id,
                                    &queue,
                                )
                            }
                            Err(error) => {
                                tracing::debug!(
                                    "Codex queue item accepted; could not inspect idle queue head: {error}"
                                );
                                None
                            }
                        };
                        if let Some(queue_head) = queue_head {
                            let head_id = queue_head.queued_submission_id.clone();
                            upsert_queued_follow_up(&self.inner, queue_head.clone()).await;
                            // Keep the message/run identity already
                            // associated with the Flowix optimistic row.
                            let head_message = if let Some(head_id) = head_id.as_deref() {
                                self.inner
                                    .queued_follow_ups
                                    .lock()
                                    .await
                                    .get(&codex_thread_id)
                                    .and_then(|items| {
                                        items.iter().find(|item| {
                                            item.queued_submission_id.as_deref() == Some(head_id)
                                        })
                                    })
                                    .map(|item| item.message.clone())
                            } else {
                                None
                            };
                            if let (Some(head_id), Some(head_message)) = (head_id, head_message) {
                                if let Err(error) = self
                                    .start_queued_follow_up(
                                        flowix_thread_id,
                                        &head_id,
                                        head_message,
                                        app_handle,
                                    )
                                    .await
                                {
                                    tracing::debug!(
                                        "Codex queue item accepted; deferred idle start: {error}"
                                    );
                                }
                            }
                        }
                    }
                }
                Ok(result)
            }
            Err(error) => {
                remove_queued_follow_up(
                    &self.inner,
                    &codex_thread_id,
                    None,
                    Some(&client_user_message_id),
                )
                .await;
                Err(error)
            }
        }
    }


    pub(super) async fn list_queued_follow_ups_unlocked(
        &self,
        flowix_thread_id: &str,
        codex_thread_id: &str,
    ) -> Result<Value, String> {
        let result = self
            .request("thread/queue/list", json!({ "threadId": codex_thread_id }))
            .await?;
        remember_queued_follow_ups(&self.inner, flowix_thread_id, codex_thread_id, &result).await;
        Ok(result)
    }


    /// Read Codex's persistent queue so UI state can be restored after reload.
    pub async fn list_queued_follow_ups(&self, flowix_thread_id: &str) -> Result<Value, String> {
        let codex_thread_id = self.resolve_queue_thread_id(flowix_thread_id).await?;
        let _queue_operation = lock_follow_up_operations(&self.inner, flowix_thread_id).await;
        let result = self
            .list_queued_follow_ups_unlocked(flowix_thread_id, &codex_thread_id)
            .await?;
        Ok(self.with_pending_steers(flowix_thread_id, result).await)
    }


    pub(super) async fn with_pending_steers(&self, flowix_thread_id: &str, mut result: Value) -> Value {
        let turns = self.inner.active_turns.lock().await;
        result["pendingDeliveries"] = json!(turns
            .get(flowix_thread_id)
            .filter(|turn| !turn.stream_end_emitted.load(Ordering::Acquire))
            .map(|turn| turn.pending_steers.clone())
            .unwrap_or_default());
        result
    }


    /// Restore an idle provider queue into the normal run lifecycle. This is
    /// separate from `list_queued_follow_ups`, which is also used for
    /// read-before-delete and stale-item reconciliation.
    pub async fn restore_queued_follow_ups(
        self: &Arc<Self>,
        flowix_thread_id: &str,
        app_handle: &tauri::AppHandle,
    ) -> Result<Value, String> {
        let codex_thread_id = self.resolve_queue_thread_id(flowix_thread_id).await?;
        let _queue_operation = lock_follow_up_operations(&self.inner, flowix_thread_id).await;
        let result = self
            .list_queued_follow_ups_unlocked(flowix_thread_id, &codex_thread_id)
            .await?;
        // Restored provider queues may have no active turn to trigger Codex's
        // automatic queue drain. Reconcile and start the provider queue head
        // here so the webview only hydrates state; it does not choose work.
        let provider_is_idle = {
            let mut active_turns = self.inner.active_turns.lock().await;
            if active_turns.get(flowix_thread_id).is_some_and(|active| {
                active.codex_thread_id == codex_thread_id
                    && active.stream_end_emitted.load(Ordering::Acquire)
            }) {
                active_turns.remove(flowix_thread_id);
            }
            !active_turns
                .values()
                .any(|active| active.codex_thread_id == codex_thread_id)
        };
        if provider_is_idle {
            if let Some(head) =
                queued_follow_up_at_queue_head(flowix_thread_id, &codex_thread_id, &result)
            {
                if let Some(queue_id) = head.queued_submission_id.as_deref() {
                    upsert_queued_follow_up(&self.inner, head.clone()).await;
                    if let Err(error) = self
                        .start_queued_follow_up(
                            flowix_thread_id,
                            queue_id,
                            head.message,
                            app_handle,
                        )
                        .await
                    {
                        tracing::debug!("Codex restored queue start deferred: {error}");
                    }
                }
            }
        }
        Ok(self.with_pending_steers(flowix_thread_id, result).await)
    }


    pub async fn delete_queued_follow_up(
        &self,
        flowix_thread_id: &str,
        queued_submission_id: &str,
    ) -> Result<Value, String> {
        let codex_thread_id = self.resolve_queue_thread_id(flowix_thread_id).await?;
        let _queue_operation = lock_follow_up_operations(&self.inner, flowix_thread_id).await;
        self.delete_queue_entry_with_retry(
            flowix_thread_id,
            &codex_thread_id,
            queued_submission_id,
        )
        .await?;
        Ok(json!({ "deleted": true }))
    }


    pub(super) async fn delete_queue_entry(
        &self,
        codex_thread_id: &str,
        queued_submission_id: &str,
    ) -> Result<Value, String> {
        let result = self
            .request(
                "thread/queue/delete",
                json!({
                    "threadId": codex_thread_id,
                    "queuedSubmissionId": queued_submission_id,
                }),
            )
            .await?;
        if result.get("deleted").and_then(Value::as_bool) == Some(true) {
            remove_queued_follow_up(
                &self.inner,
                &codex_thread_id,
                Some(queued_submission_id),
                None,
            )
            .await;
        }
        Ok(result)
    }


    pub(super) async fn delete_queue_entry_with_retry(
        &self,
        flowix_thread_id: &str,
        codex_thread_id: &str,
        queued_submission_id: &str,
    ) -> Result<(), String> {
        let first_error = match self
            .delete_queue_entry(codex_thread_id, queued_submission_id)
            .await
        {
            Ok(result) if result.get("deleted").and_then(Value::as_bool) == Some(true) => {
                return Ok(());
            }
            Ok(_) => "Codex queue delete did not confirm deletion".to_string(),
            Err(error) => error,
        };

        // A timed-out delete can still have succeeded remotely. Re-read before
        // retrying so a duplicate delivery cannot be queued by stale state.
        let queue = self
            .list_queued_follow_ups_unlocked(flowix_thread_id, codex_thread_id)
            .await?;
        let still_queued = queue
            .get("data")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    item.get("id").and_then(Value::as_str) == Some(queued_submission_id)
                })
            });
        if !still_queued {
            return Ok(());
        }

        match self
            .delete_queue_entry(codex_thread_id, queued_submission_id)
            .await
        {
            Ok(result) if result.get("deleted").and_then(Value::as_bool) == Some(true) => Ok(()),
            Ok(_) => Err(first_error),
            Err(_) => Err(first_error),
        }
    }


    /// Explicitly start one queued message while the thread is idle, such as
    /// when restoring a persisted queue into a new Flowix session.
    pub(super) async fn start_queued_follow_up(
        self: &Arc<Self>,
        flowix_thread_id: &str,
        queued_submission_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<Value, String> {
        *self.inner.app_handle.lock().await = Some(app_handle.clone());
        self.ensure_connection().await?;
        let flowix_thread_id = flowix_thread_id.to_string();
        let codex_thread_id = self.resolve_queue_thread_id(&flowix_thread_id).await?;
        let run_id = message
            .run_id
            .clone()
            .unwrap_or_else(|| crate::agent_external::resolve_run_id(&flowix_thread_id, None));
        let stream_end_emitted = Arc::new(AtomicBool::new(false));
        let completed_agent_messages = Arc::new(Mutex::new(Vec::new()));

        // `thread/queue/start` starts a real provider turn. Register it before
        // the RPC so app-server notifications can be associated with this
        // product thread and delivered through the normal run lifecycle.
        {
            let mut active_turns = self.inner.active_turns.lock().await;
            if active_turns.contains_key(&flowix_thread_id) {
                return Err("Codex already has an active turn for this thread".to_string());
            }
            active_turns.insert(
                flowix_thread_id.clone(),
                ActiveTurn {
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
                },
            );
        }
        self.emit_stream_start(app_handle, &flowix_thread_id, &message, &run_id)
            .await;

        let started = async {
            let result = self
                .request(
                    "thread/queue/start",
                    json!({
                        "threadId": codex_thread_id,
                        "queuedSubmissionId": queued_submission_id,
                    }),
                )
                .await?;
            let codex_turn_id = result
                .pointer("/turn/id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| "Codex app-server did not return a turn id".to_string())?
                .to_string();

            let _dispatch = self.inner.notification_dispatch.lock().await;
            let (should_interrupt, pending_notifications) = {
                let mut active_turns = self.inner.active_turns.lock().await;
                let Some(active) = active_turns
                    .get_mut(&flowix_thread_id)
                    .filter(|active| active.run_id == run_id)
                else {
                    return Ok(result);
                };
                active.codex_turn_id = codex_turn_id;
                active.turn_ready.notify_one();
                let pending = std::mem::take(&mut active.pending_notifications);
                let should_interrupt = active.cancel_requested && !active.codex_turn_id.is_empty();
                if should_interrupt {
                    active.cancel_requested = false;
                }
                (should_interrupt, pending)
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
            Ok::<Value, String>(result)
        }
        .await;

        match started {
            Ok(result) => {
                remove_queued_follow_up(
                    &self.inner,
                    &codex_thread_id,
                    Some(queued_submission_id),
                    None,
                )
                .await;
                Ok(result)
            }
            Err(error) => {
                // The queue can auto-start as the current turn ends, between
                // our list and explicit start calls. In that case its
                // notifications were buffered against this optimistic run.
                // Bind the actual started turn and replay them instead of
                // discarding the real response as a stale queue error.
                let _dispatch = self.inner.notification_dispatch.lock().await;
                let (started_turn, pending_notifications, active_for_end) = {
                    let mut active_turns = self.inner.active_turns.lock().await;
                    let active = active_turns
                        .get_mut(&flowix_thread_id)
                        .filter(|active| active.run_id == run_id);
                    if let Some(active) = active {
                        let started_turn_id = active
                            .pending_notifications
                            .iter()
                            .find(|notification| {
                                notification.get("method").and_then(Value::as_str)
                                    == Some("turn/started")
                                    && notification
                                        .pointer("/params/threadId")
                                        .and_then(Value::as_str)
                                        == Some(active.codex_thread_id.as_str())
                            })
                            .and_then(|notification| {
                                notification
                                    .pointer("/params/turnId")
                                    .or_else(|| notification.pointer("/params/turn/id"))
                                    .and_then(Value::as_str)
                            })
                            .map(str::to_string);
                        if let Some(turn_id) = started_turn_id {
                            active.codex_turn_id = turn_id.clone();
                            active.binding = TurnBinding::StartedNotification;
                            active.turn_ready.notify_one();
                            let pending = std::mem::take(&mut active.pending_notifications);
                            (
                                Some(turn_id),
                                pending,
                                Some(active.stream_end_emitted.clone()),
                            )
                        } else {
                            let active = active_turns.remove(&flowix_thread_id);
                            (None, Vec::new(), active.map(|turn| turn.stream_end_emitted))
                        }
                    } else {
                        (None, Vec::new(), None)
                    }
                };
                if let Some(turn_id) = started_turn {
                    for notification in pending_notifications {
                        dispatch_notification_inner(&self.inner, &notification).await;
                    }
                    drop(_dispatch);
                    remove_queued_follow_up(
                        &self.inner,
                        &codex_thread_id,
                        Some(queued_submission_id),
                        None,
                    )
                    .await;
                    return Ok(json!({
                        "turn": { "id": turn_id, "status": "inProgress" }
                    }));
                }
                drop(_dispatch);
                let active = {
                    let mut active_turns = self.inner.active_turns.lock().await;
                    if active_turns
                        .get(&flowix_thread_id)
                        .is_some_and(|active| active.run_id == run_id)
                    {
                        active_turns.remove(&flowix_thread_id)
                    } else {
                        None
                    }
                };
                if !stream_end_emitted.load(Ordering::Acquire) {
                    // Another window or a concurrent provider-side transition
                    // may have consumed this durable queue item. Close the
                    // optimistic run cleanly so the frontend can refresh the
                    // queue without showing a false model failure.
                    if !is_queue_start_conflict_error(&error) {
                        self.emit_run_error(app_handle, &flowix_thread_id, error.clone(), &run_id)
                            .await;
                    }
                    self.emit_stream_end(
                        app_handle,
                        &flowix_thread_id,
                        &run_id,
                        (!is_queue_start_conflict_error(&error)).then(|| error.clone()),
                        active
                            .as_ref()
                            .map(|turn| &turn.stream_end_emitted)
                            .or(active_for_end.as_ref())
                            .unwrap_or(&stream_end_emitted),
                    )
                    .await;
                }
                Err(error)
            }
        }
    }


    /// Deliver a selected Follow-up immediately. Runtime state is authoritative:
    /// steer an active chat, or start the queued submission when idle.
    pub async fn deliver_queued_follow_up_now(
        self: &Arc<Self>,
        flowix_thread_id: &str,
        queued_submission_id: &str,
        message: AgentUserMessage,
        client_user_message_id: String,
        app_handle: &tauri::AppHandle,
    ) -> Result<(), String> {
        let codex_thread_id = self.resolve_queue_thread_id(flowix_thread_id).await?;
        let _queue_operation = lock_follow_up_operations(&self.inner, flowix_thread_id).await;
        let queue = self
            .list_queued_follow_ups_unlocked(flowix_thread_id, &codex_thread_id)
            .await?;
        let target_is_queued = queue
            .get("data")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    item.get("id").and_then(Value::as_str) == Some(queued_submission_id)
                })
            });
        if !target_is_queued {
            return Err(format!(
                "queued submission not found: {queued_submission_id}"
            ));
        }
        let active_turn = {
            let active_turns = self.inner.active_turns.lock().await;
            let active = active_turns.get(flowix_thread_id);
            if active.is_some_and(|active| {
                active.client_user_message_id.as_deref() == Some(client_user_message_id.as_str())
                    && !active.stream_end_emitted.load(Ordering::Acquire)
            }) {
                return Err("Codex Follow-up already started".to_string());
            }
            active.is_some_and(|active| {
                active.command_id.is_none() && !active.stream_end_emitted.load(Ordering::Acquire)
            })
        };
        if !active_turn {
            self.start_queued_follow_up(
                flowix_thread_id,
                queued_submission_id,
                message,
                app_handle,
            )
            .await?;
            return Ok(());
        }

        self.steer_chat(
            flowix_thread_id,
            message,
            client_user_message_id,
            app_handle,
        )
        .await?;
        match self
            .delete_queue_entry_with_retry(flowix_thread_id, &codex_thread_id, queued_submission_id)
            .await
        {
            Ok(()) => Ok(()),
            Err(error) => Err(format!(
                "Codex Follow-up was steered but queue cleanup failed: {error}"
            )),
        }
    }

}
