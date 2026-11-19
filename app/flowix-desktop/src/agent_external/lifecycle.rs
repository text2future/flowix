//! Shared event lifecycle for external CLI runs.
//!
//! Vendor managers still own command construction, protocol parsing, session
//! mapping, and persistence format. This module fixes the common ordering and
//! one-shot rules for StreamStart, Error, and StreamEnd.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use async_trait::async_trait;

use super::shared::{emit_stream_end_once, ExternalWatchdogFinalizedRun};
use crate::agent_wire::{AgentChunk, AgentErrorDetails, AgentUserMessage};

#[async_trait]
pub trait ExternalLifecycleEmitter: Send + Sync {
    fn lifecycle_agent_type(&self) -> &'static str;

    /// Emit a non-terminal chunk and apply the runtime's persistence policy.
    /// Simple CLIs intentionally emit only; Codex has its own persistence
    /// adapter; Claude and Hermes use the standard external-event store.
    async fn emit_and_persist_lifecycle_chunk(
        &self,
        app_handle: &tauri::AppHandle,
        chunk: &AgentChunk,
        run_id: &str,
    );

    /// Persist a StreamEnd already emitted by `emit_stream_end_once`.
    /// Emit-only runtimes keep the default no-op implementation.
    async fn persist_emitted_stream_end(&self, _chunk: &AgentChunk, _run_id: &str) {}

    async fn emit_stream_start(
        &self,
        app_handle: &tauri::AppHandle,
        thread_id: &str,
        message: &AgentUserMessage,
        run_id: &str,
    ) {
        let chunk = stream_start_chunk(self.lifecycle_agent_type(), thread_id, message);
        self.emit_and_persist_lifecycle_chunk(app_handle, &chunk, run_id)
            .await;
    }

    /// Persist and emit the product-owned user row before StreamStart. The
    /// frontend already has the same id optimistically, so live delivery is an
    /// idempotent update while cold replay gains the missing user turn.
    async fn emit_user_message(
        &self,
        app_handle: &tauri::AppHandle,
        thread_id: &str,
        message: &AgentUserMessage,
        run_id: &str,
    ) {
        let chunk = user_message_chunk(thread_id, message, run_id);
        self.emit_and_persist_lifecycle_chunk(app_handle, &chunk, run_id)
            .await;
    }

    async fn emit_run_error(
        &self,
        app_handle: &tauri::AppHandle,
        thread_id: &str,
        message: String,
        run_id: &str,
    ) {
        let message = crate::agent_external::safe_user_error_message(&message);
        let error_details = crate::agent_external::classify_agent_error(&message, "runtime");
        self.emit_structured_run_error(app_handle, thread_id, message, error_details, run_id)
            .await;
    }

    /// Emit a provider failure that has already been classified at the
    /// protocol boundary. Keeping this separate from `emit_run_error` avoids
    /// losing status/request/quota semantics by parsing the message again at
    /// the lifecycle boundary.
    async fn emit_structured_run_error(
        &self,
        app_handle: &tauri::AppHandle,
        thread_id: &str,
        message: String,
        mut error_details: AgentErrorDetails,
        run_id: &str,
    ) {
        let message = crate::agent_external::safe_user_error_message(&message);
        if let Some(upstream_message) = error_details.upstream_message.as_deref() {
            error_details.upstream_message = Some(crate::agent_external::safe_user_error_message(
                upstream_message,
            ));
        }
        self.emit_and_persist_lifecycle_chunk(
            app_handle,
            &AgentChunk::Error {
                thread_id: thread_id.to_string(),
                message,
                error_details: Some(error_details),
            },
            run_id,
        )
        .await;
    }

    /// Finish a normal/error/stop path exactly once. The shared atomic flag is
    /// also held by the watchdog, so only one terminal path can win.
    async fn emit_stream_end(
        &self,
        app_handle: &tauri::AppHandle,
        thread_id: &str,
        run_id: &str,
        reason: Option<String>,
        stream_end_emitted: &Arc<AtomicBool>,
    ) -> bool {
        let chunk = AgentChunk::StreamEnd {
            thread_id: thread_id.to_string(),
            reason: reason.clone(),
            duration_ms: None,
        };
        if !emit_stream_end_once(
            app_handle,
            thread_id,
            run_id,
            self.lifecycle_agent_type(),
            reason,
            stream_end_emitted,
        ) {
            return false;
        }
        self.persist_emitted_stream_end(&chunk, run_id).await;
        true
    }

    /// The registry claims the one-shot flag before returning watchdog runs.
    /// Therefore this path emits Error first (when present), then StreamEnd,
    /// without attempting a second claim.
    async fn emit_watchdog_finalized(
        &self,
        app_handle: &tauri::AppHandle,
        finalized: &[ExternalWatchdogFinalizedRun],
    ) {
        for run in finalized {
            let run_id = run.run_id.as_deref().unwrap_or(run.thread_id.as_str());
            for chunk in watchdog_chunks(run) {
                self.emit_and_persist_lifecycle_chunk(app_handle, &chunk, run_id)
                    .await;
            }
        }
    }
}

fn stream_start_chunk(
    agent_type: &'static str,
    thread_id: &str,
    message: &AgentUserMessage,
) -> AgentChunk {
    AgentChunk::StreamStart {
        thread_id: thread_id.to_string(),
        model: message.model_for_runtime(agent_type).map(str::to_string),
        reasoning_effort: message
            .reasoning_effort_for_runtime(agent_type)
            .map(str::to_string),
    }
}

fn user_message_chunk(thread_id: &str, message: &AgentUserMessage, run_id: &str) -> AgentChunk {
    AgentChunk::UserMessage {
        thread_id: thread_id.to_string(),
        id: format!("user-{run_id}"),
        text: message
            .display_content
            .clone()
            .unwrap_or_else(|| message.content.clone()),
        timestamp: chrono::Utc::now().timestamp_millis(),
        attachments: message.message_attachments(),
    }
}

fn watchdog_chunks(run: &ExternalWatchdogFinalizedRun) -> Vec<AgentChunk> {
    let mut chunks = Vec::with_capacity(2);
    if let Some(reason) = &run.reason {
        chunks.push(AgentChunk::Error {
            thread_id: run.thread_id.clone(),
            message: reason.clone(),
            error_details: Some(crate::agent_external::classify_agent_error(
                reason, "watchdog",
            )),
        });
    }
    chunks.push(AgentChunk::StreamEnd {
        thread_id: run.thread_id.clone(),
        reason: run.reason.clone(),
        duration_ms: None,
    });
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watchdog_error_precedes_stream_end() {
        let chunks = watchdog_chunks(&ExternalWatchdogFinalizedRun {
            thread_id: "thread-1".to_string(),
            run_id: Some("run-1".to_string()),
            reason: Some("watchdog_idle_timeout_ms=1000".to_string()),
        });

        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::Error { .. }, AgentChunk::StreamEnd { .. }]
        ));
    }

    #[test]
    fn clean_watchdog_completion_emits_only_stream_end() {
        let chunks = watchdog_chunks(&ExternalWatchdogFinalizedRun {
            thread_id: "thread-1".to_string(),
            run_id: None,
            reason: None,
        });

        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::StreamEnd { reason: None, .. }]
        ));
    }

    #[test]
    fn user_message_chunk_uses_run_scoped_id_and_display_content() {
        let message = AgentUserMessage {
            content: "visible".to_string(),
            display_content: Some(
                "visible [图片](flowix://agent-image-attachment?path=%2Ftmp%2Fimage.png)"
                    .to_string(),
            ),
            llm_content: Some("visible with context".to_string()),
            image_paths: Vec::new(),
            run_id: None,
            system_reminder_directory: None,
            agent_type: Some("claudecode".to_string()),
            runtime_config: None,
            permission_mode: None,
            codex_model: None,
            codex_reasoning_effort: None,
            conversation_title: None,
        };

        assert!(matches!(
            user_message_chunk("thread-1", &message, "run-1"),
            AgentChunk::UserMessage { id, text, timestamp, .. }
                if id == "user-run-1"
                    && text == "visible [图片](flowix://agent-image-attachment?path=%2Ftmp%2Fimage.png)"
                    && timestamp > 0
        ));
    }
}
