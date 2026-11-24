//! 待发消息队列：上一条没跑完时继续说的话。
//!
//! 队列本身在 Pi 侧，Flowix 维护的是「排队文案 ↔ 后续 turn」的对应关系。提升为
//! steer（插话）时要把同一条消息从队列挪进当前 turn，否则界面上会同时出现「排队中」
//! 和「已插话」。

use super::*;

use std::sync::atomic::Ordering;

use serde_json::Value;
use tokio::time::Duration;

use crate::agent_wire::AgentUserMessage;

impl PiRpcManager {
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
}
