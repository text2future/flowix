use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use crate::agent::AgentId;
use crate::threads::{ChatMessage, ThreadInfo};

const RUNTIME: &str = "codex";

pub async fn list_sessions() -> Result<Vec<ThreadInfo>, String> {
    tokio::task::spawn_blocking(list_codex_sessions)
        .await
        .map_err(|e| e.to_string())?
}

pub async fn get_session(session_id: &str) -> Result<Vec<ChatMessage>, String> {
    let session_id = session_id.to_string();
    tokio::task::spawn_blocking(move || read_codex_session_messages(&session_id))
        .await
        .map_err(|e| e.to_string())?
}

pub fn is_codex_session_id(text: &str) -> bool {
    text.len() >= 32 && text.chars().filter(|c| *c == '-').count() >= 4
}

#[derive(Default)]
struct CodexSessionDraft {
    id: String,
    title: Option<String>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
    path: Option<PathBuf>,
}

fn list_codex_sessions() -> Result<Vec<ThreadInfo>, String> {
    let mut sessions: BTreeMap<String, CodexSessionDraft> = BTreeMap::new();

    for item in read_codex_history_items()? {
        let draft = sessions.entry(item.session_id.clone()).or_default();
        draft.id = item.session_id;
        draft.title = Some(item.text);
        draft.updated_at = Some(item.ts);
        draft.created_at = draft.created_at.or(Some(item.ts));
    }

    for path in codex_session_files()? {
        if let Ok(meta) = read_codex_session_meta(&path) {
            let draft = sessions.entry(meta.id.clone()).or_default();
            draft.id = meta.id;
            draft.path = Some(path);
            draft.created_at = draft.created_at.or(meta.created_at);
            draft.updated_at = draft.updated_at.max(meta.updated_at).or(meta.created_at);
            if draft
                .title
                .as_ref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
            {
                draft.title = meta.title;
            }
        }
    }

    let mut list = sessions
        .into_values()
        .filter(|draft| !draft.id.trim().is_empty())
        .map(|draft| {
            let created_at = draft
                .created_at
                .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
            ThreadInfo {
                thread_id: draft.id,
                agent_id: AgentId::new(RUNTIME),
                title: draft
                    .title
                    .filter(|t| !t.trim().is_empty())
                    .unwrap_or_else(|| "Codex Session".to_string()),
                created_at,
                updated_at: draft.updated_at.unwrap_or(created_at),
            }
        })
        .collect::<Vec<_>>();
    list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(list)
}

fn read_codex_session_messages(session_id: &str) -> Result<Vec<ChatMessage>, String> {
    let path = find_codex_session_file(session_id)?
        .ok_or_else(|| format!("Codex session not found: {session_id}"))?;
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut messages = Vec::new();
    let mut seen_user_messages = HashSet::new();

    for (idx, line) in text.lines().enumerate() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let timestamp = value
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let top_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let payload = value.get("payload").unwrap_or(&value);

        if top_type == "event_msg" {
            if let Some(message) = event_msg_to_chat_message(session_id, idx, &timestamp, payload) {
                if message.role == "user" && !seen_user_messages.insert(message.content.clone()) {
                    continue;
                }
                messages.push(message);
            }
            continue;
        }

        if top_type != "response_item" {
            continue;
        }

        if let Some(message) = response_item_to_chat_message(session_id, idx, &timestamp, payload) {
            if message.role == "user" {
                if message.content.starts_with("<environment_context>") {
                    continue;
                }
                if !seen_user_messages.insert(message.content.clone()) {
                    continue;
                }
            }
            if message.role == "tool" && message.id.starts_with("tool-result-") {
                if let Some(call_id) = message.tool_call_id.as_deref() {
                    if let Some(existing) =
                        messages.iter_mut().rev().find(|m: &&mut ChatMessage| {
                            m.role == "tool" && m.tool_call_id.as_deref() == Some(call_id)
                        })
                    {
                        existing.content = message.content.clone();
                        existing.tool_data = message.tool_data.clone();
                        existing.is_loading = Some(false);
                        continue;
                    }
                }
            }
            messages.push(message);
        }
    }

    Ok(messages)
}

struct HistoryItem {
    session_id: String,
    text: String,
    ts: i64,
}

fn read_codex_history_items() -> Result<Vec<HistoryItem>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(Vec::new());
    };
    let path = home.join(".codex").join("history.jsonl");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(session_id) = value.get("session_id").and_then(Value::as_str) else {
            continue;
        };
        let text = value
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("Codex Session")
            .replace('\n', " ");
        let ts = value
            .get("ts")
            .and_then(Value::as_i64)
            .map(normalize_epoch_millis)
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
        items.push(HistoryItem {
            session_id: session_id.to_string(),
            text: truncate_title(&text),
            ts,
        });
    }
    Ok(items)
}

struct SessionMeta {
    id: String,
    title: Option<String>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
}

fn read_codex_session_meta(path: &Path) -> Result<SessionMeta, String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut id = None;
    let mut title = None;
    let mut created_at = None;
    let mut updated_at = None;

    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(ts) = value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_timestamp_millis)
        {
            created_at = created_at.or(Some(ts));
            updated_at = Some(ts);
        }
        match value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "session_meta" => {
                let payload = value.get("payload").unwrap_or(&value);
                id = payload
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or(id);
                if let Some(ts) = payload
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(parse_timestamp_millis)
                {
                    created_at = created_at.or(Some(ts));
                }
            }
            "response_item" => {
                if title.is_none() {
                    let payload = value.get("payload").unwrap_or(&value);
                    if payload.get("type").and_then(Value::as_str) == Some("message")
                        && payload.get("role").and_then(Value::as_str) == Some("user")
                    {
                        if let Some(text) = content_parts_to_text(payload.get("content")) {
                            if !text.starts_with("<environment_context>") {
                                title = Some(truncate_title(&text.replace('\n', " ")));
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let id = id
        .or_else(|| session_id_from_filename(path))
        .ok_or_else(|| "missing Codex session id".to_string())?;
    Ok(SessionMeta {
        id,
        title,
        created_at,
        updated_at,
    })
}

fn response_item_to_chat_message(
    session_id: &str,
    idx: usize,
    timestamp: &str,
    payload: &Value,
) -> Option<ChatMessage> {
    let item_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match item_type {
        "message" => {
            let role = payload
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if role != "user" && role != "assistant" {
                return None;
            }
            let content = content_parts_to_text(payload.get("content"))?;
            if content.trim().is_empty() {
                return None;
            }
            Some(base_message(
                format!("{session_id}-{idx}-{role}"),
                role,
                content,
                timestamp,
            ))
        }
        "function_call" => {
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let call_id = payload
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or(name)
                .to_string();
            let input = payload
                .get("arguments")
                .and_then(Value::as_str)
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .unwrap_or_else(|| payload.clone());
            let mut message =
                base_message(format!("tool-{call_id}"), "tool", String::new(), timestamp);
            message.tool_call_id = Some(call_id);
            message.tool_name = Some(name.to_string());
            message.tool_input = Some(input);
            message.is_loading = Some(true);
            Some(message)
        }
        "function_call_output" => {
            let call_id = payload
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            let output = payload
                .get("output")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| payload.to_string());
            let data = serde_json::json!({ "output": output });
            let data_text =
                serde_json::to_string_pretty(&data).unwrap_or_else(|_| data.to_string());
            let mut message = base_message(
                format!("tool-result-{call_id}"),
                "tool",
                data_text.clone(),
                timestamp,
            );
            message.tool_call_id = Some(call_id);
            message.tool_name = Some("tool_result".to_string());
            message.tool_data = Some(data_text);
            message.is_loading = Some(false);
            Some(message)
        }
        "reasoning" => {
            let summary = payload
                .get("summary")
                .and_then(Value::as_array)
                .and_then(|items| {
                    let text = items
                        .iter()
                        .filter_map(|item| item.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n");
                    (!text.trim().is_empty()).then_some(text)
                })?;
            let mut message = base_message(
                format!("{session_id}-{idx}-reasoning"),
                "reasoning",
                summary,
                timestamp,
            );
            message.is_completed = Some(true);
            Some(message)
        }
        _ => None,
    }
}

fn event_msg_to_chat_message(
    session_id: &str,
    idx: usize,
    timestamp: &str,
    payload: &Value,
) -> Option<ChatMessage> {
    match payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "user_message" => payload.get("message").and_then(Value::as_str).map(|text| {
            base_message(
                format!("{session_id}-{idx}-user-event"),
                "user",
                text.to_string(),
                timestamp,
            )
        }),
        _ => None,
    }
}

fn base_message(id: String, role: &str, content: String, timestamp: &str) -> ChatMessage {
    ChatMessage {
        id,
        role: role.to_string(),
        content,
        llm_content: None,
        system_reminder_directory: None,
        timestamp: if timestamp.is_empty() {
            chrono::Utc::now().to_rfc3339()
        } else {
            timestamp.to_string()
        },
        is_loading: None,
        tool_call_id: None,
        tool_name: None,
        tool_data: None,
        tool_input: None,
        tool_calls: None,
        reasoning: None,
        is_completed: None,
        is_collapsed: None,
    }
}

fn content_parts_to_text(content: Option<&Value>) -> Option<String> {
    match content? {
        Value::String(text) => Some(text.to_string()),
        Value::Array(parts) => {
            let text = parts
                .iter()
                .filter_map(|part| {
                    part.get("text")
                        .or_else(|| part.get("content"))
                        .and_then(Value::as_str)
                })
                .collect::<Vec<_>>()
                .join("");
            (!text.trim().is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn codex_session_files() -> Result<Vec<PathBuf>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(Vec::new());
    };
    let root = home.join(".codex").join("sessions");
    if !root.exists() {
        return Ok(Vec::new());
    }
    Ok(WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .collect())
}

fn find_codex_session_file(session_id: &str) -> Result<Option<PathBuf>, String> {
    for path in codex_session_files()? {
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.contains(session_id))
            .unwrap_or(false)
        {
            return Ok(Some(path));
        }
    }
    for path in codex_session_files()? {
        if read_codex_session_meta(&path)
            .map(|meta| meta.id == session_id)
            .unwrap_or(false)
        {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

fn session_id_from_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let parts = stem.rsplit('-').take(5).collect::<Vec<_>>();
    if parts.len() == 5 {
        Some(parts.into_iter().rev().collect::<Vec<_>>().join("-"))
    } else {
        None
    }
}

fn truncate_title(text: &str) -> String {
    let trimmed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.chars().count() <= 40 {
        trimmed
    } else {
        format!("{}...", trimmed.chars().take(40).collect::<String>())
    }
}

fn normalize_epoch_millis(ts: i64) -> i64 {
    if ts < 10_000_000_000 {
        ts * 1000
    } else {
        ts
    }
}

fn parse_timestamp_millis(text: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_codex_session_ids() {
        assert!(is_codex_session_id("019ed38f-e9e3-7b61-8be3-80a40788d6e3"));
        assert!(!is_codex_session_id("thread_1781665906"));
    }

    #[test]
    fn extracts_session_id_from_rollout_filename() {
        let path =
            PathBuf::from("rollout-2026-06-17T11-11-24-019ed38f-e9e3-7b61-8be3-80a40788d6e3.jsonl");
        assert_eq!(
            session_id_from_filename(&path).as_deref(),
            Some("019ed38f-e9e3-7b61-8be3-80a40788d6e3")
        );
    }

    #[test]
    fn maps_response_item_function_call_to_tool_message() {
        let payload = serde_json::json!({
            "type": "function_call",
            "name": "shell_command",
            "arguments": "{\"command\":\"echo congratulations\"}",
            "call_id": "call_1"
        });
        let message =
            response_item_to_chat_message("session_1", 3, "2026-06-17T03:11:36Z", &payload)
                .expect("tool message");
        assert_eq!(message.role, "tool");
        assert_eq!(message.tool_call_id.as_deref(), Some("call_1"));
        assert_eq!(message.tool_name.as_deref(), Some("shell_command"));
        assert_eq!(
            message.tool_input.as_ref().and_then(|v| v.get("command")),
            Some(&serde_json::json!("echo congratulations"))
        );
        assert_eq!(message.is_loading, Some(true));
    }
}
