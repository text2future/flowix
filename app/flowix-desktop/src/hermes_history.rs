use chrono::{DateTime, TimeZone, Utc};
use serde_json::Value;
use std::collections::HashMap;
use tokio::process::Command;
use uuid::Uuid;

use crate::agent::AgentId;
use crate::threads::{ChatMessage, ThreadInfo, ThreadMessagesPage};

const AGENT_TYPE: &str = "hermes";

#[derive(Default)]
struct ParsedSession {
    session_id: String,
    title: Option<String>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
    messages: Vec<ChatMessage>,
}

pub fn is_hermes_session_id(text: &str) -> bool {
    let value = text.trim();
    !value.is_empty()
        && !value.starts_with("hermes-local-")
        && value.len() >= 8
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':'))
}

pub async fn list_sessions() -> Result<Vec<ThreadInfo>, String> {
    match export_sessions(None).await {
        Ok(text) => {
            let mut sessions = parse_export(&text);
            if !sessions.is_empty() {
                return Ok(thread_infos_from_sessions(&mut sessions));
            }
        }
        Err(err) => {
            tracing::debug!("[HermesHistory] sessions export failed, falling back to list: {err}");
        }
    }

    let output = run_hermes(["sessions", "list"]).await?;
    Ok(parse_sessions_list(&output))
}

pub async fn get_session(session_id: &str) -> Result<Vec<ChatMessage>, String> {
    Ok(session_messages(session_id).await?.0)
}

pub async fn get_session_page(
    session_id: &str,
    before_sequence: Option<i64>,
    limit: i64,
) -> Result<ThreadMessagesPage, String> {
    let (messages, _) = session_messages(session_id).await?;
    Ok(page_from_messages(messages, before_sequence, limit))
}

pub async fn most_recent_session_since(started_at_ms: i64) -> Result<Option<String>, String> {
    let sessions = list_sessions().await?;
    Ok(sessions
        .into_iter()
        .filter(|session| session.updated_at >= started_at_ms.saturating_sub(5_000))
        .max_by_key(|session| session.updated_at)
        .map(|session| session.thread_id))
}

async fn session_messages(
    session_id: &str,
) -> Result<(Vec<ChatMessage>, Option<ThreadInfo>), String> {
    let text = export_sessions(Some(session_id)).await?;
    let mut sessions = parse_export(&text);
    let session = sessions
        .remove(session_id)
        .or_else(|| sessions.into_values().next())
        .ok_or_else(|| format!("Hermes session not found: {session_id}"))?;
    let info = thread_info_from_session(&session);
    Ok((session.messages, Some(info)))
}

async fn export_sessions(session_id: Option<&str>) -> Result<String, String> {
    let temp = tempfile::Builder::new()
        .prefix("flowix-hermes-history-")
        .suffix(".jsonl")
        .tempfile()
        .map_err(|e| format!("failed to create Hermes export temp file: {e}"))?;
    let path = temp.path().to_path_buf();
    drop(temp);

    let mut args = vec!["sessions".to_string(), "export".to_string()];
    args.push(path.to_string_lossy().to_string());
    if let Some(session_id) = session_id.filter(|s| !s.trim().is_empty()) {
        args.push("--session-id".to_string());
        args.push(session_id.to_string());
    }

    let output = run_hermes(args.iter().map(String::as_str)).await;
    let text = match output {
        Ok(stdout) => {
            let file_text = tokio::fs::read_to_string(&path).await.unwrap_or_default();
            if file_text.trim().is_empty() {
                stdout
            } else {
                file_text
            }
        }
        Err(err) => {
            let _ = tokio::fs::remove_file(&path).await;
            return Err(err);
        }
    };
    let _ = tokio::fs::remove_file(&path).await;
    Ok(text)
}

async fn run_hermes<'a>(args: impl IntoIterator<Item = &'a str>) -> Result<String, String> {
    let mut cmd = Command::new(crate::hermes_cli::resolve_hermes_binary());
    crate::process_window::hide_command_window(&mut cmd);
    cmd.args(args);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("failed to run Hermes CLI: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Hermes CLI exited with status {}", output.status)
        } else {
            format!("Hermes CLI exited with status {}: {stderr}", output.status)
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn parse_export(text: &str) -> HashMap<String, ParsedSession> {
    let values = parse_json_values(text);
    let mut sessions: HashMap<String, ParsedSession> = HashMap::new();
    for (index, value) in values.iter().enumerate() {
        let session_id = extract_session_id(value)
            .unwrap_or_else(|| format!("hermes-export-session-{}", index + 1));
        let entry = sessions
            .entry(session_id.clone())
            .or_insert_with(|| ParsedSession {
                session_id: session_id.clone(),
                ..ParsedSession::default()
            });

        if let Some(title) = extract_first_string(value, &["title", "name", "summary"]) {
            if !title.trim().is_empty() {
                entry.title = Some(title);
            }
        }
        if let Some(ts) =
            extract_timestamp_ms(value, &["created_at", "createdAt", "timestamp", "ts"])
        {
            entry.created_at = Some(entry.created_at.map_or(ts, |prev| prev.min(ts)));
            entry.updated_at = Some(entry.updated_at.map_or(ts, |prev| prev.max(ts)));
        }
        if let Some(ts) = extract_timestamp_ms(value, &["updated_at", "updatedAt"]) {
            entry.updated_at = Some(entry.updated_at.map_or(ts, |prev| prev.max(ts)));
        }
        if let Some(message) = value_to_message(value, index) {
            let message_ts = timestamp_to_ms(&message.timestamp).unwrap_or_else(now_ms);
            entry.created_at = Some(
                entry
                    .created_at
                    .map_or(message_ts, |prev| prev.min(message_ts)),
            );
            entry.updated_at = Some(
                entry
                    .updated_at
                    .map_or(message_ts, |prev| prev.max(message_ts)),
            );
            if entry.title.is_none() && message.role == "user" {
                entry.title = Some(default_title(&message.content));
            }
            entry.messages.push(message);
        }
    }
    sessions
}

fn parse_json_values(text: &str) -> Vec<Value> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(trimmed) {
        return items;
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return vec![value];
    }
    trimmed
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .collect()
}

fn value_to_message(value: &Value, index: usize) -> Option<ChatMessage> {
    let role = extract_role(value)?;
    let content = extract_content(value);
    let has_tool = extract_first_string(value, &["tool_name", "toolName", "name"]).is_some()
        || extract_nested(value, &["tool", "name"])
            .and_then(Value::as_str)
            .is_some();
    if content.trim().is_empty() && role != "tool" && !has_tool {
        return None;
    }
    let timestamp = extract_timestamp(value).unwrap_or_else(|| Utc::now().to_rfc3339());
    let tool_name = extract_first_string(value, &["tool_name", "toolName", "name"]).or_else(|| {
        extract_nested(value, &["tool", "name"])
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    let tool_call_id = extract_first_string(
        value,
        &["tool_call_id", "toolCallId", "tool_use_id", "toolUseId"],
    );
    let tool_input = extract_nested(value, &["input"])
        .or_else(|| extract_nested(value, &["tool", "input"]))
        .cloned();
    let tool_calls = extract_nested(value, &["tool_calls"])
        .or_else(|| extract_nested(value, &["toolCalls"]))
        .cloned();

    Some(ChatMessage {
        id: extract_first_string(value, &["id", "message_id", "messageId"])
            .unwrap_or_else(|| format!("hermes_{}_{}", index, Uuid::new_v4())),
        role,
        content: content.clone(),
        llm_content: Some(content),
        system_reminder_directory: None,
        timestamp,
        is_loading: None,
        tool_call_id,
        tool_name,
        tool_data: None,
        tool_input,
        tool_calls,
        reasoning: extract_reasoning(value),
        is_completed: None,
        is_collapsed: None,
    })
}

fn extract_role(value: &Value) -> Option<String> {
    let role = extract_first_string(value, &["role"])
        .or_else(|| {
            extract_nested(value, &["message", "role"])
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| {
            if extract_first_string(
                value,
                &["tool_call_id", "toolCallId", "tool_use_id", "toolUseId"],
            )
            .is_some()
            {
                Some("tool".to_string())
            } else {
                None
            }
        })?;
    let normalized = role.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "human" => Some("user".to_string()),
        "ai" | "model" => Some("assistant".to_string()),
        "user" | "assistant" | "system" | "tool" | "reasoning" => Some(normalized),
        _ => None,
    }
}

fn extract_content(value: &Value) -> String {
    extract_first_string(value, &["content", "text", "output"])
        .or_else(|| value.get("content").map(content_value_to_string))
        .or_else(|| extract_nested(value, &["message", "content"]).map(content_value_to_string))
        .unwrap_or_default()
}

fn content_value_to_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .or_else(|| extract_first_string(item, &["text", "content", "output"]))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(_) => {
            extract_first_string(value, &["text", "content", "output"]).unwrap_or_default()
        }
        _ => String::new(),
    }
}

fn extract_session_id(value: &Value) -> Option<String> {
    extract_first_string(
        value,
        &[
            "session_id",
            "sessionId",
            "conversation_id",
            "conversationId",
        ],
    )
    .or_else(|| {
        extract_nested(value, &["session", "id"])
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

fn extract_reasoning(value: &Value) -> Option<String> {
    extract_first_string(value, &["reasoning", "thinking"])
}

fn extract_timestamp(value: &Value) -> Option<String> {
    for key in [
        "timestamp",
        "created_at",
        "createdAt",
        "updated_at",
        "updatedAt",
        "ts",
    ] {
        if let Some(raw) = value.get(key) {
            if let Some(text) = raw.as_str() {
                if !text.trim().is_empty() {
                    return Some(normalize_timestamp_string(text));
                }
            }
            if let Some(ms) = raw
                .as_i64()
                .or_else(|| raw.as_u64().and_then(|v| i64::try_from(v).ok()))
            {
                return Some(timestamp_ms_to_rfc3339(normalize_epoch_ms(ms)));
            }
        }
    }
    extract_nested(value, &["message", "timestamp"])
        .and_then(Value::as_str)
        .map(normalize_timestamp_string)
}

fn extract_timestamp_ms(value: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| {
        value.get(*key).and_then(|raw| {
            raw.as_i64()
                .or_else(|| raw.as_u64().and_then(|v| i64::try_from(v).ok()))
                .map(normalize_epoch_ms)
                .or_else(|| raw.as_str().and_then(timestamp_to_ms))
        })
    })
}

fn extract_first_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn extract_nested<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))
}

fn normalize_timestamp_string(text: &str) -> String {
    timestamp_to_ms(text)
        .map(timestamp_ms_to_rfc3339)
        .unwrap_or_else(|| text.to_string())
}

fn timestamp_to_ms(text: &str) -> Option<i64> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(text) {
        return Some(dt.timestamp_millis());
    }
    text.parse::<i64>().ok().map(normalize_epoch_ms)
}

fn normalize_epoch_ms(value: i64) -> i64 {
    if value.abs() < 10_000_000_000 {
        value.saturating_mul(1000)
    } else {
        value
    }
}

fn timestamp_ms_to_rfc3339(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339()
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn parse_sessions_list(text: &str) -> Vec<ThreadInfo> {
    let now = now_ms();
    text.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty()
                || trimmed.to_ascii_lowercase().contains("session") && trimmed.contains("---")
            {
                return None;
            }
            let id = trimmed.split_whitespace().find(|part| {
                is_hermes_session_id(part.trim_matches(|c: char| c == ',' || c == '|'))
            })?;
            let id = id.trim_matches(|c: char| c == ',' || c == '|').to_string();
            let title = trimmed
                .replace(&id, "")
                .replace('|', " ")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            Some(ThreadInfo {
                thread_id: id,
                agent_id: AgentId(AGENT_TYPE.to_string()),
                title: if title.is_empty() {
                    "Hermes Agent session".to_string()
                } else {
                    title
                },
                created_at: now,
                updated_at: now,
                runtime_config: None,
            })
        })
        .collect()
}

fn thread_infos_from_sessions(sessions: &mut HashMap<String, ParsedSession>) -> Vec<ThreadInfo> {
    let mut infos = sessions
        .values()
        .map(thread_info_from_session)
        .collect::<Vec<_>>();
    infos.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    infos
}

fn thread_info_from_session(session: &ParsedSession) -> ThreadInfo {
    let now = now_ms();
    ThreadInfo {
        thread_id: session.session_id.clone(),
        agent_id: AgentId(AGENT_TYPE.to_string()),
        title: session
            .title
            .clone()
            .filter(|title| !title.trim().is_empty())
            .unwrap_or_else(|| "Hermes Agent session".to_string()),
        created_at: session.created_at.unwrap_or(now),
        updated_at: session.updated_at.unwrap_or(now),
        runtime_config: None,
    }
}

fn page_from_messages(
    messages: Vec<ChatMessage>,
    before_sequence: Option<i64>,
    limit: i64,
) -> ThreadMessagesPage {
    let limit = limit.clamp(1, 1000) as usize;
    let indexed = messages
        .into_iter()
        .enumerate()
        .map(|(index, message)| (index as i64 + 1, message))
        .collect::<Vec<_>>();
    let cutoff = before_sequence.unwrap_or(i64::MAX);
    let mut page = indexed
        .iter()
        .rev()
        .filter(|(sequence, _)| *sequence < cutoff)
        .take(limit)
        .cloned()
        .collect::<Vec<_>>();
    page.reverse();
    let oldest_sequence = page.first().map(|(sequence, _)| *sequence);
    let has_more = oldest_sequence
        .map(|oldest| indexed.iter().any(|(sequence, _)| *sequence < oldest))
        .unwrap_or(false);
    ThreadMessagesPage {
        messages: page.into_iter().map(|(_, message)| message).collect(),
        oldest_sequence,
        has_more,
    }
}

fn default_title(content: &str) -> String {
    let title = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        "Hermes Agent session".to_string()
    } else {
        title.chars().take(28).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_jsonl_export_into_sessions() {
        let text = r#"
{"type":"metadata","session_id":"abc12345","title":"Saved title","created_at":"2026-07-03T01:00:00Z"}
{"session_id":"abc12345","role":"user","content":"hello hermes","timestamp":"2026-07-03T01:00:01Z"}
{"session_id":"abc12345","role":"assistant","content":[{"text":"hi"}],"timestamp":"2026-07-03T01:00:02Z"}
"#;
        let mut sessions = parse_export(text);
        let infos = thread_infos_from_sessions(&mut sessions);
        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].thread_id, "abc12345");
        assert_eq!(infos[0].title, "Saved title");
        let session = sessions.get("abc12345").unwrap();
        assert_eq!(session.messages.len(), 2);
        assert_eq!(session.messages[1].content, "hi");
    }

    #[test]
    fn derives_title_from_first_user_message() {
        let text = r#"[{"sessionId":"sid_9999","role":"user","content":"  fix   bug now  ","timestamp":1783040400000}]"#;
        let mut sessions = parse_export(text);
        let infos = thread_infos_from_sessions(&mut sessions);
        assert_eq!(infos[0].title, "fix bug now");
    }

    #[test]
    fn pages_messages_with_sequence_cursor() {
        let messages = (1..=5)
            .map(|i| ChatMessage {
                id: i.to_string(),
                role: "user".to_string(),
                content: i.to_string(),
                llm_content: None,
                system_reminder_directory: None,
                timestamp: Utc::now().to_rfc3339(),
                is_loading: None,
                tool_call_id: None,
                tool_name: None,
                tool_data: None,
                tool_input: None,
                tool_calls: None,
                reasoning: None,
                is_completed: None,
                is_collapsed: None,
            })
            .collect::<Vec<_>>();
        let first = page_from_messages(messages.clone(), None, 2);
        assert_eq!(first.messages[0].content, "4");
        assert_eq!(first.oldest_sequence, Some(4));
        assert!(first.has_more);
        let second = page_from_messages(messages, first.oldest_sequence, 2);
        assert_eq!(second.messages[0].content, "2");
        assert_eq!(second.messages[1].content, "3");
    }

    #[test]
    fn parses_sessions_list_fallback() {
        let infos = parse_sessions_list("abc12345  My Hermes session\n");
        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].thread_id, "abc12345");
    }
}
