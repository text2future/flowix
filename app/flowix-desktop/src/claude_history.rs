use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use crate::agent::AgentId;
use crate::threads::{ChatMessage, ThreadInfo};

const AGENT_TYPE: &str = "claude";

pub async fn list_sessions() -> Result<Vec<ThreadInfo>, String> {
    tokio::task::spawn_blocking(list_claude_sessions)
        .await
        .map_err(|e| e.to_string())?
}

pub async fn get_session(session_id: &str) -> Result<Vec<ChatMessage>, String> {
    let session_id = session_id.to_string();
    tokio::task::spawn_blocking(move || read_claude_session_messages(&session_id))
        .await
        .map_err(|e| e.to_string())?
}

pub fn is_claude_session_id(text: &str) -> bool {
    // 必须显式拒绝 "claude-local-agent-inst-<ts>-<seq>" 等前端 thread id
    // 占位符 ── 这些字符串长度 ≥ 32 且包含 5 个 dash, 老版宽松判断会把
    // 它们当成 session id 透传给 Claude CLI 的 --resume, 但 CLI 是 UUID
    // 严格校验: "Provided value ... is not a UUID and does not match any
    // session title"。
    let value = text.trim();
    if value.is_empty() || value.starts_with("claude-local-") {
        return false;
    }
    // Claude Code 真 session id 是 UUID ── 36 字符, 4 个 dash, 其余全是
    // ASCII 十六进制位。 同时也兼容 Claude 后续可能的非 UUID 格式
    // (例如未来他们换 ULID/base32), 通过长度 + dash 计数宽放, 仍是合法
    // 的"长得像 id 字符串"。
    let dash_count = value.chars().filter(|c| *c == '-').count();
    value.len() >= 32 && dash_count == 4
}

#[derive(Default)]
struct ClaudeSessionDraft {
    id: String,
    title: Option<String>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
}

fn list_claude_sessions() -> Result<Vec<ThreadInfo>, String> {
    let mut sessions: BTreeMap<String, ClaudeSessionDraft> = BTreeMap::new();

    for path in claude_session_files()? {
        if let Ok(meta) = read_claude_session_meta(&path) {
            let draft = sessions.entry(meta.id.clone()).or_default();
            draft.id = meta.id;
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
                agent_id: AgentId::new(AGENT_TYPE),
                title: draft
                    .title
                    .filter(|t| !t.trim().is_empty())
                    .unwrap_or_else(|| "Claude Code Session".to_string()),
                created_at,
                updated_at: draft.updated_at.unwrap_or(created_at),
            }
        })
        .collect::<Vec<_>>();
    list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(list)
}

fn read_claude_session_messages(session_id: &str) -> Result<Vec<ChatMessage>, String> {
    let path = find_claude_session_file(session_id)?
        .ok_or_else(|| format!("Claude Code session not found: {session_id}"))?;
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut messages = Vec::new();

    for (idx, line) in text.lines().enumerate() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        for message in value_to_chat_messages(session_id, idx, &value) {
            append_claude_history_message(&mut messages, message);
        }
    }

    Ok(messages)
}

fn append_claude_history_message(messages: &mut Vec<ChatMessage>, message: ChatMessage) {
    let is_tool_result = message.role == "tool"
        && message.tool_name.as_deref() == Some("tool_result")
        && message.tool_call_id.as_deref().is_some();
    if !is_tool_result {
        messages.push(message);
        return;
    }

    let Some(tool_call_id) = message.tool_call_id.as_deref() else {
        messages.push(message);
        return;
    };
    if let Some(existing) = messages
        .iter_mut()
        .rev()
        .find(|m| m.role == "tool" && m.tool_call_id.as_deref() == Some(tool_call_id))
    {
        existing.content = message.content;
        existing.tool_data = message.tool_data;
        existing.is_loading = Some(false);
    } else {
        messages.push(message);
    }
}

struct SessionMeta {
    id: String,
    title: Option<String>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
}

fn read_claude_session_meta(path: &Path) -> Result<SessionMeta, String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut id = session_id_from_filename(path);
    let mut title = None;
    let mut created_at = None;
    let mut updated_at = None;

    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        id = extract_session_id(&value).or(id);
        if let Some(ts) = extract_timestamp_millis(&value) {
            created_at = created_at.or(Some(ts));
            updated_at = Some(ts);
        }
        if title.is_none() && value.get("type").and_then(Value::as_str) == Some("user") {
            if let Some(text) = message_content_to_text(&value) {
                title = Some(truncate_title(&text.replace('\n', " ")));
            }
        }
    }

    let id = id.ok_or_else(|| "missing Claude Code session id".to_string())?;
    Ok(SessionMeta {
        id,
        title,
        created_at,
        updated_at,
    })
}

fn value_to_chat_messages(session_id: &str, idx: usize, value: &Value) -> Vec<ChatMessage> {
    let role = match value.get("type").and_then(Value::as_str) {
        Some("user") => "user",
        Some("assistant") => "assistant",
        _ => value
            .get("message")
            .and_then(|m| m.get("role"))
            .and_then(Value::as_str)
            .unwrap_or_default(),
    };
    if role != "user" && role != "assistant" {
        return Vec::new();
    }
    let timestamp = extract_timestamp(value);
    let mut messages = Vec::new();

    if let Some(content) = message_content(value) {
        if let Some(parts) = content.as_array() {
            let mut text = String::new();
            let skip_user_text_blocks = should_skip_user_text_blocks(role, parts);
            for (part_idx, part) in parts.iter().enumerate() {
                let part_type = part.get("type").and_then(Value::as_str).unwrap_or_default();
                match part_type {
                    "tool_use" => {
                        if !text.trim().is_empty() {
                            messages.push(base_message(
                                format!("{session_id}-{idx}-{role}-text-{}", messages.len()),
                                role,
                                std::mem::take(&mut text),
                                timestamp.clone(),
                            ));
                        }
                        messages.push(tool_call_message(
                            session_id, idx, part_idx, part, &timestamp,
                        ));
                    }
                    "tool_result" => {
                        if !skip_user_text_blocks && !text.trim().is_empty() {
                            messages.push(base_message(
                                format!("{session_id}-{idx}-{role}-text-{}", messages.len()),
                                role,
                                std::mem::take(&mut text),
                                timestamp.clone(),
                            ));
                        }
                        messages.push(tool_result_message(
                            session_id, idx, part_idx, part, &timestamp,
                        ));
                    }
                    _ => {
                        if skip_user_text_blocks && part_type == "text" {
                            continue;
                        }
                        if let Some(part_text) = part
                            .get("text")
                            .or_else(|| part.get("content"))
                            .and_then(Value::as_str)
                        {
                            text.push_str(part_text);
                        }
                    }
                }
            }
            if !text.trim().is_empty() {
                messages.push(base_message(
                    format!("{session_id}-{idx}-{role}-text-{}", messages.len()),
                    role,
                    text,
                    timestamp,
                ));
            }
            return messages;
        }
    }

    let Some(content) = message_content_to_text(value) else {
        return Vec::new();
    };
    if content.trim().is_empty() {
        return Vec::new();
    }
    vec![base_message(
        format!("{session_id}-{idx}-{role}"),
        role,
        content,
        timestamp,
    )]
}

fn should_skip_user_text_blocks(role: &str, parts: &[Value]) -> bool {
    role == "user"
        && !parts.is_empty()
        && parts.iter().all(|part| {
            matches!(
                part.get("type").and_then(Value::as_str).unwrap_or_default(),
                "text" | "tool_result"
            )
        })
}

fn message_content_to_text(value: &Value) -> Option<String> {
    if let Some(text) = value.get("content").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    let content = message_content(value)?;
    content_blocks_to_text(content)
}

fn message_content(value: &Value) -> Option<&Value> {
    value
        .get("message")
        .and_then(|m| m.get("content"))
        .or_else(|| value.get("content"))
}

fn content_blocks_to_text(content: &Value) -> Option<String> {
    match content {
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

fn base_message(id: String, role: &str, content: String, timestamp: String) -> ChatMessage {
    ChatMessage {
        id,
        role: role.to_string(),
        content,
        llm_content: None,
        system_reminder_directory: None,
        timestamp,
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

fn tool_call_message(
    session_id: &str,
    idx: usize,
    part_idx: usize,
    part: &Value,
    timestamp: &str,
) -> ChatMessage {
    let id = part
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("claude_tool")
        .to_string();
    let name = part
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("tool")
        .to_string();
    let mut message = base_message(
        format!("{session_id}-{idx}-tool-call-{part_idx}"),
        "tool",
        String::new(),
        timestamp.to_string(),
    );
    message.tool_call_id = Some(id);
    message.tool_name = Some(name);
    message.tool_input = Some(part.get("input").cloned().unwrap_or(Value::Null));
    message.is_loading = Some(false);
    message
}

fn tool_result_message(
    session_id: &str,
    idx: usize,
    part_idx: usize,
    part: &Value,
    timestamp: &str,
) -> ChatMessage {
    let id = part
        .get("tool_use_id")
        .or_else(|| part.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("claude_tool")
        .to_string();
    let result = claude_tool_result_content(part);
    let result_content =
        serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string());
    let mut message = base_message(
        format!("{session_id}-{idx}-tool-result-{part_idx}"),
        "tool",
        result_content.clone(),
        timestamp.to_string(),
    );
    message.tool_call_id = Some(id);
    message.tool_name = Some("tool_result".to_string());
    message.tool_data = Some(result_content);
    message.is_loading = Some(false);
    message
}

fn claude_tool_result_content(part: &Value) -> Value {
    let Some(content) = part.get("content") else {
        return claude_tool_result_envelope(part.clone(), part);
    };
    let content = match content {
        Value::String(text) => serde_json::json!({ "content": text }),
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
            if text.trim().is_empty() {
                serde_json::json!({ "content": content })
            } else {
                serde_json::json!({ "content": text })
            }
        }
        _ => serde_json::json!({ "content": content }),
    };
    claude_tool_result_envelope(content, part)
}

fn claude_tool_result_envelope(mut value: Value, source: &Value) -> Value {
    if let Some(is_error) = source.get("is_error").and_then(Value::as_bool) {
        match &mut value {
            Value::Object(map) => {
                map.insert("is_error".to_string(), Value::Bool(is_error));
            }
            _ => {
                value = serde_json::json!({
                    "content": value,
                    "is_error": is_error,
                });
            }
        }
    }
    value
}

fn claude_session_files() -> Result<Vec<PathBuf>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(Vec::new());
    };
    let config_root = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"));
    let root = config_root.join("projects");
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

fn find_claude_session_file(session_id: &str) -> Result<Option<PathBuf>, String> {
    for path in claude_session_files()? {
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.contains(session_id))
            .unwrap_or(false)
        {
            return Ok(Some(path));
        }
    }
    for path in claude_session_files()? {
        if read_claude_session_meta(&path)
            .map(|meta| meta.id == session_id)
            .unwrap_or(false)
        {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

fn extract_session_id(value: &Value) -> Option<String> {
    for key in ["session_id", "sessionId", "uuid"] {
        if let Some(id) = value.get(key).and_then(Value::as_str) {
            return Some(id.to_string());
        }
    }
    value
        .get("message")
        .and_then(|m| extract_session_id(m))
        .or_else(|| {
            value
                .get("parentUuid")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

fn session_id_from_filename(path: &Path) -> Option<String> {
    path.file_stem()?.to_str().map(str::to_string)
}

fn extract_timestamp(value: &Value) -> String {
    if let Some(timestamp) = value.get("timestamp").and_then(Value::as_str) {
        timestamp.to_string()
    } else {
        chrono::Utc::now().to_rfc3339()
    }
}

fn extract_timestamp_millis(value: &Value) -> Option<i64> {
    value
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|text| {
            chrono::DateTime::parse_from_rfc3339(text)
                .ok()
                .map(|dt| dt.timestamp_millis())
        })
}

fn truncate_title(text: &str) -> String {
    let trimmed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.chars().count() <= 40 {
        trimmed
    } else {
        format!("{}...", trimmed.chars().take(40).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_claude_session_ids() {
        assert!(is_claude_session_id("019ed38f-e9e3-7b61-8be3-80a40788d6e3"));
        assert!(!is_claude_session_id("claude-local-1"));
    }

    #[test]
    fn rejects_local_claude_thread_ids() {
        // 回归 ── 这条字符串长度 ≥ 32 且含 5 个 dash, 老版宽松规则会误判为
        // "是真的 session id", 把 `claude-local-agent-inst-...` 当真实 UUID
        // 透传给 Claude CLI 的 --resume。 CLI 是 UUID 严格校验, 报错:
        // "Provided value ... is not a UUID and does not match any session
        // title"。 修正后必须以 `claude-local-` 前缀直接拒掉。
        assert!(!is_claude_session_id(
            "claude-local-agent-inst-1783828675847-3"
        ));
        assert!(!is_claude_session_id(
            "claude-local-agent-inst-1783828675847-100"
        ));
        // 空白 + 短字符串 ── 老版意外匹配的 corner。
        assert!(!is_claude_session_id(""));
        assert!(!is_claude_session_id("   "));
    }

    #[test]
    fn maps_assistant_message_to_chat_message() {
        let value = serde_json::json!({
            "type": "assistant",
            "timestamp": "2026-06-29T01:00:00Z",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "hello" }]
            }
        });
        let messages = value_to_chat_messages("session_1", 0, &value);
        let message = messages.first().expect("message");
        assert_eq!(message.role, "assistant");
        assert_eq!(message.content, "hello");
    }

    #[test]
    fn maps_tool_blocks_to_tool_messages() {
        let assistant = serde_json::json!({
            "type": "assistant",
            "timestamp": "2026-06-29T01:00:00Z",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "Read",
                    "input": { "file_path": "README.md" }
                }]
            }
        });
        let messages = value_to_chat_messages("session_1", 0, &assistant);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "tool");
        assert_eq!(messages[0].tool_call_id.as_deref(), Some("toolu_1"));
        assert_eq!(messages[0].tool_name.as_deref(), Some("Read"));
        assert_eq!(
            messages[0]
                .tool_input
                .as_ref()
                .and_then(|v| v.get("file_path")),
            Some(&serde_json::json!("README.md"))
        );

        let user = serde_json::json!({
            "type": "user",
            "timestamp": "2026-06-29T01:00:01Z",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "content": "file contents"
                }]
            }
        });
        let messages = value_to_chat_messages("session_1", 1, &user);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "tool");
        assert_eq!(messages[0].tool_call_id.as_deref(), Some("toolu_1"));
        assert_eq!(messages[0].tool_name.as_deref(), Some("tool_result"));
        assert!(messages[0].content.contains("file contents"));
        assert_eq!(messages[0].is_loading, Some(false));
    }

    #[test]
    fn merges_tool_result_into_existing_tool_message() {
        let assistant = serde_json::json!({
            "type": "assistant",
            "timestamp": "2026-06-29T01:00:00Z",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "Read",
                    "input": { "file_path": "README.md" }
                }]
            }
        });
        let user = serde_json::json!({
            "type": "user",
            "timestamp": "2026-06-29T01:00:01Z",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "content": "file contents",
                    "is_error": true
                }]
            }
        });

        let mut messages = Vec::new();
        for message in value_to_chat_messages("session_1", 0, &assistant) {
            append_claude_history_message(&mut messages, message);
        }
        for message in value_to_chat_messages("session_1", 1, &user) {
            append_claude_history_message(&mut messages, message);
        }

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "tool");
        assert_eq!(messages[0].tool_call_id.as_deref(), Some("toolu_1"));
        assert_eq!(messages[0].tool_name.as_deref(), Some("Read"));
        assert!(messages[0].content.contains("file contents"));
        assert!(messages[0].content.contains("is_error"));
        assert_eq!(messages[0].is_loading, Some(false));
    }

    #[test]
    fn skips_user_text_only_skill_injection_messages() {
        let user = serde_json::json!({
            "type": "user",
            "timestamp": "2026-06-29T01:00:01Z",
            "message": {
                "role": "user",
                "content": [{
                    "type": "text",
                    "text": "Base directory for this skill: /tmp/verify\n\nskill body"
                }]
            }
        });

        let messages = value_to_chat_messages("session_1", 1, &user);
        assert!(messages.is_empty());
    }

    #[test]
    fn skips_user_text_when_mixed_only_with_tool_result() {
        let user = serde_json::json!({
            "type": "user",
            "timestamp": "2026-06-29T01:00:01Z",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "Base directory for this skill: /tmp/verify\n\nskill body"
                    },
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": "loaded"
                    }
                ]
            }
        });

        let messages = value_to_chat_messages("session_1", 1, &user);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "tool");
        assert_eq!(messages[0].tool_call_id.as_deref(), Some("toolu_1"));
        assert!(messages[0].content.contains("loaded"));
        assert!(!messages[0]
            .content
            .contains("Base directory for this skill"));
    }

    #[test]
    fn keeps_user_array_text_when_other_block_types_are_present() {
        let user = serde_json::json!({
            "type": "user",
            "timestamp": "2026-06-29T01:00:01Z",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "real user text"
                    },
                    {
                        "type": "image",
                        "source": { "type": "base64", "media_type": "image/png", "data": "abc" }
                    }
                ]
            }
        });

        let messages = value_to_chat_messages("session_1", 1, &user);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "real user text");
    }
}
