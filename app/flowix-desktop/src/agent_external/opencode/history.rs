use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};

use super::command::build_opencode_acp_command;
use super::protocol;
use crate::agent_external::shared::{chunk_payload_value, read_capped_line, MAX_STDOUT_LINE_BYTES};
use crate::agent_external::AgentChunkMetadata;
use crate::agent_session::store::materialize_external_messages;
use crate::agent_session::{
    AgentExternalEvent, ChatMessage, ThreadInfo, ThreadManager, ThreadMessagesPage,
};
use crate::agent_types::AgentId;
use std::collections::HashMap;

const EXPORT_TIMEOUT: Duration = Duration::from_secs(30);
const ACP_INITIALIZE_ID: u64 = 1;
const ACP_REQUEST_ID: u64 = 2;

/// Read OpenCode's durable transcript through ACP `session/load`. The ACP
/// server replays the session as `session/update` notifications; nothing from
/// this read path is written into Flowix's event table.
pub async fn get_session_page(
    thread_manager: &std::sync::Arc<ThreadManager>,
    thread_id: &str,
    before_sequence: Option<i64>,
    limit: i64,
) -> Result<ThreadMessagesPage, String> {
    let session_id = thread_manager
        .get_external_session(thread_id, "opencode")
        .await
        .map_err(|error| error.to_string())?
        .unwrap_or_else(|| thread_id.to_string());
    let cwd = thread_manager
        .read_frozen_cwd(thread_id)
        .await
        .map_err(|error| error.to_string())?
        .or(find_session_cwd(&session_id).await)
        .unwrap_or_else(|| {
            std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
        });
    let updates = acp_load_session(&session_id, &cwd).await?;
    let turns = updates_to_turns(&session_id, updates)?;
    Ok(paginate_turns(turns, before_sequence, limit))
}

pub async fn list_sessions() -> Result<Vec<ThreadInfo>, String> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let result = acp_request(&cwd, protocol::session_list_request(), false).await?;
    Ok(result
        .get("sessions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|session| {
            let id = session.get("sessionId")?.as_str()?.to_string();
            let title = session
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("OpenCode session")
                .to_string();
            let updated_at = session
                .get("updatedAt")
                .and_then(Value::as_str)
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .map(|value| value.timestamp_millis())
                .unwrap_or_default();
            Some(ThreadInfo {
                thread_id: id,
                agent_id: AgentId("opencode".to_string()),
                title,
                created_at: updated_at,
                updated_at,
            })
        })
        .collect())
}

pub async fn delete_session(session_id: &str, cwd: &std::path::Path) -> Result<bool, String> {
    crate::agent_external::acp_lifecycle::delete_session(
        build_opencode_acp_command(cwd, Some("read-only"), None),
        session_id,
    )
    .await
}

pub async fn supported_models() -> Result<Vec<String>, String> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let result = acp_request(&cwd, protocol::new_session_request(".", &[]), true).await?;
    let models = result
        .get("configOptions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|option| option.get("id").and_then(Value::as_str) == Some("model"))
        .and_then(|option| option.get("options"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|option| option.get("value").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    Ok(models)
}

async fn acp_load_session(session_id: &str, cwd: &std::path::Path) -> Result<Vec<Value>, String> {
    let request = protocol::load_session_request(session_id, &cwd.to_string_lossy(), &[]);
    let (_, updates) = acp_exchange(cwd, request, true).await?;
    Ok(updates)
}

async fn find_session_cwd(session_id: &str) -> Option<std::path::PathBuf> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let result = acp_request(&cwd, protocol::session_list_request(), false)
        .await
        .ok()?;
    result
        .get("sessions")
        .and_then(Value::as_array)?
        .iter()
        .find(|session| session.get("sessionId").and_then(Value::as_str) == Some(session_id))
        .and_then(|session| session.get("cwd").and_then(Value::as_str))
        .map(std::path::PathBuf::from)
}

async fn acp_request(
    cwd: &std::path::Path,
    mut request: Value,
    close_session: bool,
) -> Result<Value, String> {
    let id = request
        .get("id")
        .and_then(Value::as_u64)
        .unwrap_or(ACP_REQUEST_ID);
    let (mut child, mut stdin, mut stdout) = acp_process(cwd).await?;
    let result = async {
        write_json(&mut stdin, &request).await?;
        let (result, _) = read_response(&mut stdout, &mut stdin, id, false).await?;
        if close_session {
            if let Some(session_id) = result.get("sessionId").and_then(Value::as_str) {
                request = protocol::close_session_request(session_id);
                write_json(&mut stdin, &request).await?;
                let close_id = request.get("id").and_then(Value::as_u64).unwrap_or(3);
                read_response(&mut stdout, &mut stdin, close_id, false).await?;
            }
        }
        Ok(result)
    }
    .await;
    let _ = child.kill().await;
    result
}

async fn acp_exchange(
    cwd: &std::path::Path,
    request: Value,
    collect_updates: bool,
) -> Result<(Value, Vec<Value>), String> {
    let id = request
        .get("id")
        .and_then(Value::as_u64)
        .unwrap_or(ACP_REQUEST_ID);
    let (mut child, mut stdin, mut stdout) = acp_process(cwd).await?;
    let result = async {
        write_json(&mut stdin, &request).await?;
        read_response(&mut stdout, &mut stdin, id, collect_updates).await
    }
    .await;
    let _ = child.kill().await;
    result
}

async fn acp_process(
    cwd: &std::path::Path,
) -> Result<(Child, ChildStdin, BufReader<tokio::process::ChildStdout>), String> {
    let mut command = build_opencode_acp_command(cwd, Some("read-only"), None);
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start OpenCode ACP: {error}"))?;
    let setup = async {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to capture OpenCode ACP stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture OpenCode ACP stdout".to_string())?;
        write_json(&mut stdin, &protocol::initialize_request()).await?;
        let mut stdout = BufReader::new(stdout);
        let _ = read_response(&mut stdout, &mut stdin, ACP_INITIALIZE_ID, false).await?;
        Ok::<_, String>((stdin, stdout))
    }
    .await;
    match setup {
        Ok((stdin, stdout)) => Ok((child, stdin, stdout)),
        Err(error) => {
            let _ = child.kill().await;
            Err(error)
        }
    }
}

async fn read_response(
    stdout: &mut BufReader<tokio::process::ChildStdout>,
    stdin: &mut ChildStdin,
    id: u64,
    collect_updates: bool,
) -> Result<(Value, Vec<Value>), String> {
    let mut updates = Vec::new();
    let response = tokio::time::timeout(EXPORT_TIMEOUT, async {
        loop {
            let Some((line, truncated)) = read_capped_line(stdout, MAX_STDOUT_LINE_BYTES).await?
            else {
                return Err(format!("OpenCode ACP closed before response {id}"));
            };
            if truncated {
                return Err("OpenCode ACP emitted an oversized JSON-RPC message".to_string());
            }
            let value: Value = serde_json::from_str(line.trim())
                .map_err(|error| format!("invalid OpenCode ACP JSON-RPC: {error}"))?;
            if let Some(server_response) = history_server_request_response(&value) {
                write_json(stdin, &server_response).await?;
                continue;
            }
            if collect_updates
                && value.get("method").and_then(Value::as_str) == Some("session/update")
            {
                updates.push(value.clone());
            }
            if let Some(result) = protocol::response_result(&value, id) {
                return result.map(|value| (value.clone(), updates));
            }
        }
    })
    .await
    .map_err(|_| "OpenCode ACP request timed out".to_string())??;
    Ok(response)
}

/// History reads never grant permissions. Still answer ACP server requests so
/// a provider-side permission prompt cannot deadlock a read-only session.
fn history_server_request_response(value: &Value) -> Option<Value> {
    if value.get("method").and_then(Value::as_str) == Some("session/request_permission") {
        let id = value.get("id")?.clone();
        let option_id = value
            .pointer("/params/options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|option| {
                matches!(
                    option.get("kind").and_then(Value::as_str),
                    Some("reject_once" | "reject_always")
                )
            })
            .and_then(|option| option.get("optionId"))
            .cloned();
        return Some(match option_id {
            Some(option_id) => serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "outcome": { "outcome": "selected", "optionId": option_id } }
            }),
            None => serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "outcome": { "outcome": "cancelled" } }
            }),
        });
    }
    protocol::unsupported_request_response(value)
}

async fn write_json(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    stdin
        .write_all(&bytes)
        .await
        .map_err(|error| error.to_string())?;
    stdin.flush().await.map_err(|error| error.to_string())
}

fn updates_to_turns(
    session_id: &str,
    updates: Vec<Value>,
) -> Result<Vec<Vec<ChatMessage>>, String> {
    let mut tool_inputs = HashMap::new();
    let mut events = Vec::new();
    let mut event_id = 1i64;
    let mut logical_message = 0usize;
    let mut needs_new_assistant = false;
    let event_time = chrono::Utc::now().timestamp_millis();
    for update in updates {
        let message_id = update.pointer("/params/messageId").and_then(Value::as_str);
        let session_update = update
            .pointer("/params/update/sessionUpdate")
            .and_then(Value::as_str);
        match session_update {
            Some("user_message_chunk") | Some("tool_call") => {
                logical_message += 1;
                needs_new_assistant = true;
            }
            Some("agent_message_chunk") | Some("agent_thought_chunk")
                if needs_new_assistant || logical_message == 0 =>
            {
                logical_message += 1;
                needs_new_assistant = false;
            }
            Some("tool_call_update") if protocol::is_terminal_tool_update(&update) => {
                needs_new_assistant = true;
            }
            _ => {}
        }
        let chunks = protocol::chunks_from_message(session_id, &update, &mut tool_inputs);
        for mut chunk in chunks {
            if let crate::agent_wire::AgentChunk::UserMessage { text, .. } = &mut chunk {
                *text = visible_user_text(text);
            }
            let logical_source = format!("acp-history-message-{logical_message}");
            let metadata = AgentChunkMetadata {
                message_id: message_id.map(str::to_string),
                source_message_id: match &chunk {
                    crate::agent_wire::AgentChunk::Text { .. }
                    | crate::agent_wire::AgentChunk::Reasoning { .. } => Some(logical_source),
                    _ => None,
                },
                message_phase: Some("completed"),
                ..AgentChunkMetadata::default()
            };
            let normalized = chunk_payload_value(&chunk, "opencode", "acp-history", &metadata)
                .map_err(|error| error.to_string())?;
            events.push(AgentExternalEvent {
                id: event_id,
                runtime: "opencode".to_string(),
                thread_id: session_id.to_string(),
                event_key: None,
                normalized_json: normalized.to_string(),
                raw_json: None,
                created_at: event_time + event_id,
            });
            event_id += 1;
        }
    }
    let messages = materialize_external_messages(events);
    let mut turns = Vec::new();
    for message in messages {
        if message.role == "user" && !turns.is_empty() {
            turns.push(Vec::new());
        }
        if turns.is_empty() {
            turns.push(Vec::new());
        }
        turns.last_mut().unwrap().push(message);
    }
    Ok(turns)
}

// Kept only as a parser regression fixture while older export snapshots remain
// useful for compatibility testing. Production history reads use ACP above.
#[cfg(test)]
fn export_to_turns(value: &Value) -> Vec<Vec<ChatMessage>> {
    let mut turns: Vec<Vec<ChatMessage>> = Vec::new();
    for message in value
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let info = message.get("info").unwrap_or(&Value::Null);
        let role = info.get("role").and_then(Value::as_str).unwrap_or_default();
        let message_id = info
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("opencode-message");
        let created_at = info
            .pointer("/time/created")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let parts = message
            .get("parts")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();

        if role == "user" {
            let content = parts
                .iter()
                .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            turns.push(vec![history_message(
                message_id.to_string(),
                "user",
                visible_user_text(&content),
                created_at,
            )]);
            continue;
        }
        if role != "assistant" {
            continue;
        }
        if turns.is_empty() {
            turns.push(Vec::new());
        }
        let turn = turns.last_mut().expect("turn initialized");
        for (index, part) in parts.iter().enumerate() {
            let part_type = part.get("type").and_then(Value::as_str);
            let part_id = part
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("{message_id}-part-{index}"));
            let timestamp = part
                .pointer("/time/start")
                .and_then(Value::as_i64)
                .unwrap_or(created_at);
            match part_type {
                Some("text") | Some("reasoning") => {
                    let content = part
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    if !content.is_empty() {
                        turn.push(history_message(
                            part_id,
                            if part_type == Some("reasoning") {
                                "reasoning"
                            } else {
                                "assistant"
                            },
                            content,
                            timestamp,
                        ));
                    }
                }
                Some("tool") => turn.push(tool_message(part_id, part, timestamp)),
                _ => {}
            }
        }
    }
    turns
}

#[cfg(test)]
fn tool_message(id: String, part: &Value, timestamp: i64) -> ChatMessage {
    let state = part.get("state").unwrap_or(&Value::Null);
    let status = state
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let result = state
        .get("output")
        .or_else(|| state.get("error"))
        .cloned()
        .unwrap_or(Value::Null);
    let content = result.as_str().map(str::to_string).unwrap_or_else(|| {
        if result.is_null() {
            String::new()
        } else {
            result.to_string()
        }
    });
    let mut message = history_message(id, "tool", content.clone(), timestamp);
    message.tool_call_id = part
        .get("callID")
        .and_then(Value::as_str)
        .map(str::to_string);
    message.tool_name = part.get("tool").and_then(Value::as_str).map(str::to_string);
    message.tool_input = state.get("input").cloned();
    message.tool_data = (!content.is_empty()).then_some(content);
    let completed = matches!(status, "completed" | "error" | "failed");
    message.is_loading = Some(!completed);
    message.is_completed = Some(completed);
    message
}

fn visible_user_text(content: &str) -> String {
    const MARKERS: [&str; 2] = ["\n<## CONTEXT PROMPT ##>", "\n\n[Flowix workspace context]"];
    let end = MARKERS
        .iter()
        .filter_map(|marker| content.find(marker))
        .min()
        .unwrap_or(content.len());
    content[..end].trim_end().to_string()
}

#[cfg(test)]
fn history_message(id: String, role: &str, content: String, timestamp: i64) -> ChatMessage {
    ChatMessage {
        id,
        role: role.to_string(),
        message_type: None,
        content,
        llm_content: None,
        system_reminder_directory: None,
        timestamp: chrono::DateTime::from_timestamp_millis(timestamp)
            .unwrap_or_default()
            .to_rfc3339(),
        is_loading: None,
        tool_call_id: None,
        tool_name: None,
        tool_data: None,
        tool_input: None,
        tool_call: None,
        tool_result: None,
        tool_calls: None,
        reasoning: None,
        is_completed: Some(true),
        error_details: None,
        is_collapsed: None,
        codex_turn_id: None,
        turn_duration_ms: None,
        source_sequence: None,
        attachments: None,
    }
}

fn paginate_turns(
    turns: Vec<Vec<ChatMessage>>,
    before_sequence: Option<i64>,
    limit: i64,
) -> ThreadMessagesPage {
    let total = turns.len();
    let end = before_sequence
        .map(|sequence| (sequence - 1).clamp(0, total as i64) as usize)
        .unwrap_or(total);
    let start = end.saturating_sub(limit.clamp(1, 50) as usize);
    ThreadMessagesPage {
        messages: turns[start..end].iter().flatten().cloned().collect(),
        oldest_sequence: (start < end).then_some((start + 1) as i64),
        has_more: start > 0,
        snapshot_sequence: None,
        complete_turn_ids: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_acp_updates_into_flowix_messages() {
        let updates = vec![
            serde_json::json!({
                "method": "session/update",
                "params": {
                    "messageId": "user-1",
                    "update": {
                        "sessionUpdate": "user_message_chunk",
                        "content": { "type": "text", "text": "hello\n<## CONTEXT PROMPT ##>\nprivate context" }
                    }
                }
            }),
            serde_json::json!({
                "method": "session/update",
                "params": {
                    "messageId": "assistant-1",
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": { "type": "text", "text": "world" }
                    }
                }
            }),
            serde_json::json!({
                "method": "session/update",
                "params": {
                    "messageId": "assistant-1",
                    "update": {
                        "sessionUpdate": "agent_thought_chunk",
                        "content": { "type": "text", "text": "thinking" }
                    }
                }
            }),
            serde_json::json!({
                "method": "session/update",
                "params": {
                    "messageId": "assistant-1",
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "call-1",
                        "title": "Read",
                        "rawInput": { "filePath": "README.md" }
                    }
                }
            }),
            serde_json::json!({
                "method": "session/update",
                "params": {
                    "messageId": "assistant-1",
                    "update": {
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": "call-1",
                        "status": "completed",
                        "title": "Read",
                        "rawOutput": "file contents"
                    }
                }
            }),
        ];

        let turns = updates_to_turns("session-1", updates).unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0][0].role, "user");
        assert_eq!(turns[0][0].content, "hello");
        assert_eq!(turns[0][1].role, "assistant");
        assert_eq!(turns[0][1].content, "world");
        assert_eq!(turns[0][2].role, "reasoning");
        assert_eq!(turns[0][2].content, "thinking");
        assert_eq!(turns[0][3].role, "tool");
        assert!(turns[0][3]
            .tool_call_id
            .as_deref()
            .is_some_and(|id| id.ends_with(":tool-call:call-1")));
        assert_eq!(
            turns[0][3].tool_input,
            Some(serde_json::json!({ "filePath": "README.md" }))
        );
        assert_eq!(turns[0][3].content, "file contents");
        assert_eq!(turns[0][3].is_completed, Some(true));
    }

    #[test]
    fn keeps_assistant_messages_separate_across_tool_turns_without_acp_ids() {
        let update = |extra: serde_json::Value| {
            serde_json::json!({
                "method": "session/update",
                "params": { "messageId": null, "update": extra }
            })
        };
        let updates = vec![
            update(
                serde_json::json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": "first" } }),
            ),
            update(
                serde_json::json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "first answer" } }),
            ),
            update(
                serde_json::json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": "second" } }),
            ),
            update(
                serde_json::json!({ "sessionUpdate": "tool_call", "toolCallId": "call-2", "title": "Read", "rawInput": { "filePath": "README.md" } }),
            ),
            update(
                serde_json::json!({ "sessionUpdate": "tool_call_update", "toolCallId": "call-2", "status": "completed", "title": "Read", "rawOutput": "ok" }),
            ),
            update(
                serde_json::json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "second answer" } }),
            ),
        ];
        let turns = updates_to_turns("session-1", updates).unwrap();
        assert_eq!(turns.len(), 2);
        assert!(turns[0]
            .iter()
            .any(|message| message.content == "first answer"));
        assert!(turns[1]
            .iter()
            .any(|message| message.content == "second answer"));
    }

    #[test]
    fn parses_export_parts_and_strips_injected_user_context() {
        let value = serde_json::json!({
            "messages": [
                {
                    "info": {"id": "user-1", "role": "user", "time": {"created": 1000}},
                    "parts": [{"type": "text", "text": "hello\n\n[Flowix workspace context]\ninternal"}]
                },
                {
                    "info": {"id": "assistant-1", "role": "assistant", "time": {"created": 2000}},
                    "parts": [
                        {"id": "reason-1", "type": "reasoning", "text": "think"},
                        {"id": "tool-1", "type": "tool", "tool": "read", "callID": "call-1", "state": {"status": "completed", "input": {"filePath": "/tmp/a"}, "output": "ok"}},
                        {"id": "text-1", "type": "text", "text": "done"}
                    ]
                }
            ]
        });
        let turns = export_to_turns(&value);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0][0].content, "hello");
        assert_eq!(turns[0][1].role, "reasoning");
        assert_eq!(turns[0][2].tool_call_id.as_deref(), Some("call-1"));
        assert_eq!(
            turns[0][2].tool_input.as_ref().unwrap()["filePath"],
            "/tmp/a"
        );
        assert_eq!(turns[0][3].content, "done");
    }

    #[test]
    fn paginates_complete_user_turns() {
        let turns = (0..3)
            .map(|index| {
                vec![history_message(
                    format!("u-{index}"),
                    "user",
                    index.to_string(),
                    0,
                )]
            })
            .collect();
        let latest = paginate_turns(turns, None, 2);
        assert_eq!(latest.messages[0].content, "1");
        assert_eq!(latest.oldest_sequence, Some(2));
        assert!(latest.has_more);
    }
}
