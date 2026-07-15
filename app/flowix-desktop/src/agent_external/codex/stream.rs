use std::collections::HashSet;
use std::sync::Arc;

use serde_json::Value;
use tokio::io::BufReader;

use super::events::{codex_event_to_chunks, is_transient_codex_reconnect_event};
use super::io::read_capped_line;
use super::runtime::emit_chunk_with_run_id;
use super::{truncate_for_log, AGENT_TYPE, MAX_STDOUT_LINE_BYTES, MAX_TOOL_OUTPUT_CHARS};
use crate::agent_external::ExternalRunRegistry;
use crate::agent_flowix::AgentChunk;
use crate::agent_session::ThreadManager;
use crate::runtime_log;

pub(crate) async fn read_codex_stdout<R>(
    thread_id: String,
    run_id: String,
    app_handle: tauri::AppHandle,
    thread_manager: Arc<tokio::sync::RwLock<ThreadManager>>,
    runs: ExternalRunRegistry,
    reader: BufReader<R>,
) -> Result<(), String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut reader = reader;
    let mut seen_sessions = HashSet::new();
    let mut emit_thread_id = thread_id.clone();
    let mut terminal_turn_seen = false;
    while let Some((line, line_truncated_by_reader)) =
        read_capped_line(&mut reader, MAX_STDOUT_LINE_BYTES).await?
    {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        runs.touch(&thread_id, Some(&run_id)).await;
        if line_truncated_by_reader {
            runtime_log::record_agent_event(
                "warn",
                "codex_stdout",
                "codex.stdout_line_truncated",
                "Codex stdout line exceeded reader limit and was truncated",
                Some(&thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({
                    "line_bytes_limit": MAX_STDOUT_LINE_BYTES,
                    "line_preview": truncate_for_log(line),
                })),
            );
        }

        let Ok(value) = serde_json::from_str::<Value>(line) else {
            let line_chars = line.chars().count();
            runtime_log::record_agent_event(
                "warn",
                "codex_stdout",
                "codex.stdout_non_json",
                "Codex stdout emitted a non-JSON line",
                Some(&thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({
                    "line_chars": line_chars,
                    "line_truncated": line_chars > MAX_TOOL_OUTPUT_CHARS || line_truncated_by_reader,
                    "line_truncated_by_reader": line_truncated_by_reader,
                    "line_preview": truncate_for_log(line),
                })),
            );
            let text = if line_chars > MAX_TOOL_OUTPUT_CHARS {
                let truncated: String = line.chars().take(MAX_TOOL_OUTPUT_CHARS).collect();
                format!("{truncated}\n...[truncated]")
            } else {
                format!("{line}\n")
            };
            emit_chunk_with_run_id(
                &app_handle,
                &AgentChunk::Text {
                    thread_id: emit_thread_id.clone(),
                    text,
                },
                AGENT_TYPE,
                &run_id,
            );
            continue;
        };

        log_codex_stdout_event(&thread_id, line, &value);

        if let Some(session_id) = extract_session_id(&value) {
            if seen_sessions.insert(session_id.clone()) {
                runtime_log::record_agent_event(
                    "info",
                    "codex_stdout",
                    "codex.session_resolved",
                    "Codex reported a session id",
                    Some(&thread_id),
                    Some(AGENT_TYPE),
                    Some(serde_json::json!({ "session_id": session_id })),
                );
                let manager = thread_manager.read().await;
                if let Err(err) = manager
                    .upsert_external_session(
                        &thread_id,
                        AGENT_TYPE,
                        &session_id,
                        Some(value.clone()),
                    )
                    .await
                {
                    runtime_log::record_agent_event(
                        "warn",
                        "codex_stdout",
                        "codex.session_persist_failed",
                        "Failed to persist Codex external session mapping",
                        Some(&thread_id),
                        Some(AGENT_TYPE),
                        Some(serde_json::json!({
                            "session_id": session_id,
                            "error": err.to_string(),
                        })),
                    );
                    tracing::warn!(
                        "[CodexCli] failed to persist external session mapping for {thread_id}: {err}"
                    );
                }
                emit_thread_id = thread_id.clone();
                emit_chunk_with_run_id(
                    &app_handle,
                    &AgentChunk::SessionResolved {
                        thread_id: thread_id.clone(),
                        session_id: session_id.clone(),
                    },
                    AGENT_TYPE,
                    &run_id,
                );
                runs.set_session_id(&thread_id, Some(&run_id), session_id.clone())
                    .await;
            }
        }

        for chunk in codex_event_to_chunks(&emit_thread_id, &value) {
            emit_chunk_with_run_id(&app_handle, &chunk, AGENT_TYPE, &run_id);
        }

        if codex_run_signal(&value).is_terminal_turn() {
            terminal_turn_seen = true;
        }
    }

    runtime_log::record_agent_event(
        "info",
        "codex_stdout",
        "codex.stdout_eof",
        "Codex stdout reached EOF",
        Some(&thread_id),
        Some(AGENT_TYPE),
        Some(serde_json::json!({
            "terminal_turn_seen": terminal_turn_seen,
        })),
    );
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CodexRunSignal {
    Continue,
    TerminalTurn,
}

impl CodexRunSignal {
    fn is_terminal_turn(self) -> bool {
        matches!(self, Self::TerminalTurn)
    }
}

pub(crate) fn codex_run_signal(value: &Value) -> CodexRunSignal {
    if is_transient_codex_reconnect_event(value) {
        return CodexRunSignal::Continue;
    }
    if is_codex_task_complete(value) {
        return CodexRunSignal::TerminalTurn;
    }
    CodexRunSignal::Continue
}

pub(crate) fn is_codex_task_complete(value: &Value) -> bool {
    let event_type = value
        .get("type")
        .or_else(|| value.get("kind"))
        .and_then(Value::as_str);
    if matches!(event_type, Some("turn.completed" | "turn.failed")) {
        return true;
    }
    if event_type != Some("event_msg") {
        return false;
    }
    value
        .get("payload")
        .and_then(|payload| payload.get("type"))
        .and_then(Value::as_str)
        == Some("task_complete")
}

fn log_codex_stdout_event(thread_id: &str, line: &str, value: &Value) {
    let event_type = value
        .get("type")
        .or_else(|| value.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let item_type = value
        .get("item")
        .and_then(|item| item.get("type"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let item_id = value
        .get("item")
        .and_then(|item| item.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let command = value
        .get("item")
        .and_then(|item| item.get("command"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let output_chars = value
        .get("item")
        .and_then(|item| item.get("aggregated_output"))
        .and_then(Value::as_str)
        .map(|output| output.chars().count());

    runtime_log::record_agent_event(
        "info",
        "codex_stdout",
        "codex.stdout_event",
        "Codex stdout JSON event received",
        Some(thread_id),
        Some(AGENT_TYPE),
        Some(serde_json::json!({
            "event_type": event_type,
            "item_type": item_type,
            "item_id": item_id,
            "line_chars": line.chars().count(),
            "command": truncate_for_log(command),
            "aggregated_output_chars": output_chars,
        })),
    );
}

pub(crate) fn extract_session_id(value: &Value) -> Option<String> {
    let event_type = value
        .get("type")
        .or_else(|| value.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();

    for key in [
        "session_id",
        "sessionId",
        "conversation_id",
        "conversationId",
        "thread_id",
        "threadId",
    ] {
        if let Some(id) = value.get(key).and_then(Value::as_str) {
            return Some(id.to_string());
        }
    }

    if event_type.contains("session") {
        if let Some(id) = value.get("id").and_then(Value::as_str) {
            return Some(id.to_string());
        }
    }

    find_nested_session_id(value)
}

fn find_nested_session_id(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            for key in ["session_id", "sessionId", "thread_id", "threadId"] {
                if let Some(id) = map.get(key).and_then(Value::as_str) {
                    return Some(id.to_string());
                }
            }
            map.values().find_map(find_nested_session_id)
        }
        Value::Array(items) => items.iter().find_map(find_nested_session_id),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_task_complete_and_turn_terminal_events() {
        let legacy = serde_json::json!({
            "type": "event_msg",
            "payload": { "type": "task_complete" }
        });
        let completed = serde_json::json!({ "type": "turn.completed" });
        let failed = serde_json::json!({
            "type": "turn.failed",
            "error": { "message": "stream disconnected before completion" }
        });

        assert!(is_codex_task_complete(&legacy));
        assert_eq!(codex_run_signal(&completed), CodexRunSignal::TerminalTurn);
        assert_eq!(codex_run_signal(&failed), CodexRunSignal::TerminalTurn);
    }

    #[test]
    fn reconnecting_turn_failed_is_not_terminal() {
        let reconnecting = serde_json::json!({
            "type": "turn.failed",
            "error": { "message": "stream disconnected before completion; Reconnecting..." }
        });

        assert!(is_codex_task_complete(&reconnecting));
        assert_eq!(codex_run_signal(&reconnecting), CodexRunSignal::Continue);
    }

    #[test]
    fn extracts_nested_session_id_from_stream_event() {
        let value = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "session": {
                    "thread_id": "019ed38f-e9e3-7b61-8be3-80a40788d6e3"
                }
            }
        });

        assert_eq!(
            extract_session_id(&value).as_deref(),
            Some("019ed38f-e9e3-7b61-8be3-80a40788d6e3")
        );
    }
}
