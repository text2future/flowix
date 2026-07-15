use std::collections::HashSet;
use std::sync::Arc;

use tokio::io::BufReader;

use super::events::parse_claude_stdout_line;
use super::{truncate_for_log, AGENT_TYPE};
use crate::agent_external::{
    emit_chunk_with_run_id, read_capped_line, ExternalRunRegistry, MAX_STDOUT_LINE_BYTES,
};
use crate::agent_flowix::AgentChunk;
use crate::agent_session::ThreadManager;
use crate::runtime_log;

pub(crate) async fn read_claude_stdout<R>(
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
    while let Some((raw, truncated_by_reader)) =
        read_capped_line(&mut reader, MAX_STDOUT_LINE_BYTES).await?
    {
        if truncated_by_reader {
            runtime_log::record_agent_event(
                "warn",
                "claude_stdout",
                "claude.stdout_line_truncated",
                "Claude stdout line exceeded reader limit and was truncated",
                Some(&thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({
                    "run_id": run_id,
                    "line_bytes_limit": MAX_STDOUT_LINE_BYTES,
                    "line_preview": truncate_for_log(raw.trim()),
                })),
            );
        }
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        runs.touch(&thread_id, Some(&run_id)).await;

        let parsed = parse_claude_stdout_line(&thread_id, line);
        let value = match parsed.value {
            Some(value) => value,
            None => {
                let line_chars = line.chars().count();
                runtime_log::record_agent_event(
                    "warn",
                    "claude_stdout",
                    "claude.stdout_non_json",
                    "Claude stdout emitted a non-JSON line",
                    Some(&thread_id),
                    Some(AGENT_TYPE),
                    Some(serde_json::json!({
                        "run_id": run_id,
                        "line_chars": line_chars,
                        "line_preview": truncate_for_log(line),
                    })),
                );
                emit_chunk_with_run_id(
                    &app_handle,
                    &AgentChunk::Text {
                        thread_id: thread_id.clone(),
                        text: format!("{line}\n"),
                    },
                    AGENT_TYPE,
                    &run_id,
                );
                continue;
            }
        };

        if let Some(session_id) = parsed.session_id {
            if seen_sessions.insert(session_id.clone()) {
                runtime_log::record_agent_event(
                    "info",
                    "claude_stdout",
                    "claude.session_resolved",
                    "Claude Code reported a session id",
                    Some(&thread_id),
                    Some(AGENT_TYPE),
                    Some(serde_json::json!({
                        "run_id": run_id,
                        "session_id": session_id,
                    })),
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
                        "claude_stdout",
                        "claude.session_persist_failed",
                        "Failed to persist Claude external session mapping",
                        Some(&thread_id),
                        Some(AGENT_TYPE),
                        Some(serde_json::json!({
                            "run_id": run_id,
                            "session_id": session_id,
                            "error": err.to_string(),
                        })),
                    );
                    tracing::warn!(
                        "[ClaudeCli] failed to persist external session mapping for {thread_id}: {err}"
                    );
                }
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

        for chunk in parsed.chunks {
            emit_chunk_with_run_id(&app_handle, &chunk, AGENT_TYPE, &run_id);
        }
    }
    runtime_log::record_agent_event(
        "info",
        "claude_stdout",
        "claude.stdout_eof",
        "Claude stdout reached EOF",
        Some(&thread_id),
        Some(AGENT_TYPE),
        None,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_for_log_marks_long_output() {
        let text = "x".repeat(2050);
        let truncated = truncate_for_log(&text);

        assert!(truncated.ends_with("\n...[truncated]"));
        assert_eq!(
            truncated
                .trim_end_matches("\n...[truncated]")
                .chars()
                .count(),
            2048
        );
    }
}
