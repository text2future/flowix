use std::collections::HashSet;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::Value;
use tokio::io::BufReader;

use super::events::{codex_event_to_chunks, is_transient_codex_reconnect_event};
use super::io::read_capped_line;
use super::runtime::{persist_and_emit_codex_chunk, persist_codex_chunk};
use super::{truncate_for_log, AGENT_TYPE, MAX_STDOUT_LINE_BYTES, MAX_TOOL_OUTPUT_CHARS};
use crate::agent_external::{emit_stream_end_once, ExternalRunRegistry};
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
    stream_end_emitted: Arc<AtomicBool>,
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
        // dev-only: 鎶婂瓙杩涚▼ stdout 鍘熷琛岄暅鍍忓埌 ~/.flowix/debug/, 1:1 杩樺師
        // vendor CLI 鍥炲寘渚涙帓闅溿€俽elease 鏋勫缓鍐?no-op, 涓嶈惤鐩樸€?        runtime_log::dump_debug_stdout_line(AGENT_TYPE, &thread_id, &run_id, line);
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
            let looks_like_event = looks_like_codex_json_event_line(line);
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
                    "looks_like_event": looks_like_event,
                    "line_preview": truncate_for_log(line),
                })),
            );
            if looks_like_event {
                continue;
            }
            let text = if line_chars > MAX_TOOL_OUTPUT_CHARS {
                let truncated: String = line.chars().take(MAX_TOOL_OUTPUT_CHARS).collect();
                format!("{truncated}\n...[truncated]")
            } else {
                format!("{line}\n")
            };
            persist_and_emit_codex_chunk(
                &app_handle,
                &thread_manager,
                &AgentChunk::Text {
                    thread_id: emit_thread_id.clone(),
                    text,
                },
                &run_id,
                Some(line),
            )
            .await;
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
                let chunk = AgentChunk::SessionResolved {
                    thread_id: thread_id.clone(),
                    session_id: session_id.clone(),
                };
                persist_and_emit_codex_chunk(
                    &app_handle,
                    &thread_manager,
                    &chunk,
                    &run_id,
                    Some(line),
                )
                .await;
                runs.set_session_id(&thread_id, Some(&run_id), session_id.clone())
                    .await;
            }
        }

        for chunk in codex_event_to_chunks(&emit_thread_id, &value) {
            persist_and_emit_codex_chunk(&app_handle, &thread_manager, &chunk, &run_id, Some(line))
                .await;
        }

        match codex_run_signal(&value) {
            CodexRunSignal::TerminalCompleted => {
                terminal_turn_seen = true;
                // turn.completed 的 usage 等 chunk 已在上一行 codex_event_to_chunks
                // 落库。terminal turn 即内容完整, 立刻发 StreamEnd (CAS 抢占, 与
                // stop_chat / watchdog 互斥) 并 persist 为该 run 最后一行事件,
                // 随后 break 丢弃 trailing (session_meta / compacted 等无 UI
                // payload 的 lifecycle 噪声)。UI 当场收尾, tail 后台继续 join
                // stderr + wait child 收尸, 不阻塞前端。
                let stream_end = AgentChunk::StreamEnd {
                    thread_id: emit_thread_id.clone(),
                    reason: None,
                };
                if emit_stream_end_once(
                    &app_handle,
                    &thread_id,
                    &run_id,
                    AGENT_TYPE,
                    None,
                    &stream_end_emitted,
                ) {
                    persist_codex_chunk(&thread_manager, &stream_end, &run_id, None).await;
                }
                break;
            }
            CodexRunSignal::TerminalFailed => {
                // turn.failed 不提前: 它需要 Error chunk + 失败 reason, 由
                // run_codex 末尾据 exit status 发 StreamEnd(reason)。提前发 None
                // 会把 failed 误标成 completed。
                terminal_turn_seen = true;
            }
            CodexRunSignal::Continue => {}
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

fn looks_like_codex_json_event_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with('{')
        && (trimmed.contains(r#""type":"item."#)
            || trimmed.contains(r#""type": "item."#)
            || trimmed.contains(r#""type":"event_msg""#)
            || trimmed.contains(r#""type": "event_msg""#)
            || trimmed.contains(r#""type":"turn."#)
            || trimmed.contains(r#""type": "turn."#)
            || trimmed.contains(r#""type":"thread."#)
            || trimmed.contains(r#""type": "thread."#)
            || trimmed.contains(r#""kind":"item."#)
            || trimmed.contains(r#""kind": "item."#))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CodexRunSignal {
    Continue,
    /// `turn.completed` / legacy `task_complete`: 成功完成, 内容已完整, 可立即
    /// 发 StreamEnd 收尾。
    TerminalCompleted,
    /// `turn.failed` (非 reconnect): 失败, 需 Error chunk + 失败 reason, 走原
    /// tail 路径, 不提前结束 (避免把 failed 误标成 completed)。
    TerminalFailed,
}

pub(crate) fn codex_run_signal(value: &Value) -> CodexRunSignal {
    if is_transient_codex_reconnect_event(value) {
        return CodexRunSignal::Continue;
    }
    let event_type = value
        .get("type")
        .or_else(|| value.get("kind"))
        .and_then(Value::as_str);
    if event_type == Some("turn.failed") {
        return CodexRunSignal::TerminalFailed;
    }
    if is_codex_task_complete(value) {
        return CodexRunSignal::TerminalCompleted;
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
        assert_eq!(
            codex_run_signal(&legacy),
            CodexRunSignal::TerminalCompleted
        );
        assert_eq!(
            codex_run_signal(&completed),
            CodexRunSignal::TerminalCompleted
        );
        assert_eq!(codex_run_signal(&failed), CodexRunSignal::TerminalFailed);
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

    #[test]
    fn detects_malformed_codex_event_lines() {
        let malformed = r#"{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":""C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'rg --files .'"}}"#;
        assert!(looks_like_codex_json_event_line(malformed));
        assert!(!looks_like_codex_json_event_line("plain stderr output"));
    }
}
