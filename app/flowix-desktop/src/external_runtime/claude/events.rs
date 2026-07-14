use serde_json::Value;

use crate::agent::AgentChunk;

pub(crate) struct ParsedClaudeStdoutLine {
    pub value: Option<Value>,
    pub session_id: Option<String>,
    pub chunks: Vec<AgentChunk>,
}

pub(crate) fn parse_claude_stdout_line(thread_id: &str, line: &str) -> ParsedClaudeStdoutLine {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return ParsedClaudeStdoutLine {
            value: None,
            session_id: None,
            chunks: vec![AgentChunk::Text {
                thread_id: thread_id.to_string(),
                text: format!("{line}\n"),
            }],
        };
    };

    let session_id = extract_session_id(&value);
    let chunks = claude_event_to_chunks(thread_id, &value);

    ParsedClaudeStdoutLine {
        value: Some(value),
        session_id,
        chunks,
    }
}

pub(crate) fn claude_event_to_chunks(thread_id: &str, value: &Value) -> Vec<AgentChunk> {
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();

    if event_type == "assistant" {
        let mut chunks = Vec::new();
        if let Some(content) = value
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        {
            for block in content {
                match block
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                {
                    "text" => {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            if !text.trim().is_empty() {
                                chunks.push(AgentChunk::Text {
                                    thread_id: thread_id.to_string(),
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                    "thinking" => {
                        if let Some(text) = block
                            .get("thinking")
                            .or_else(|| block.get("text"))
                            .and_then(Value::as_str)
                        {
                            if !text.trim().is_empty() {
                                chunks.push(AgentChunk::Reasoning {
                                    thread_id: thread_id.to_string(),
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                    "tool_use" => {
                        let id = block
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("claude_tool")
                            .to_string();
                        let name = block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string();
                        chunks.push(AgentChunk::ToolCall {
                            thread_id: thread_id.to_string(),
                            id,
                            name,
                            input: block.get("input").cloned().unwrap_or(Value::Null),
                        });
                    }
                    _ => {}
                }
            }
        }
        return chunks;
    }

    if event_type == "user" {
        let mut chunks = Vec::new();
        if let Some(content) = value
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        {
            for block in content {
                if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                let id = block
                    .get("tool_use_id")
                    .or_else(|| block.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("claude_tool")
                    .to_string();
                chunks.push(AgentChunk::ToolResult {
                    thread_id: thread_id.to_string(),
                    id,
                    name: String::new(),
                    result: claude_tool_result_value(block),
                });
            }
        }
        return chunks;
    }

    if event_type == "result" {
        return Vec::new();
    }

    if event_type == "system" {
        if value.get("subtype").and_then(Value::as_str) == Some("error") {
            if let Some(text) = first_string(value, &["message", "error"]) {
                return vec![AgentChunk::Error {
                    thread_id: thread_id.to_string(),
                    message: text,
                }];
            }
        }
        return Vec::new();
    }

    if let Some(text) = first_string(value, &["delta", "text", "content"]) {
        if !text.trim().is_empty() {
            return vec![AgentChunk::Text {
                thread_id: thread_id.to_string(),
                text,
            }];
        }
    }

    Vec::new()
}

fn claude_tool_result_value(block: &Value) -> Value {
    let Some(content) = block.get("content") else {
        return claude_tool_result_envelope(block.clone(), block);
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
    claude_tool_result_envelope(content, block)
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

fn extract_session_id(value: &Value) -> Option<String> {
    for key in ["session_id", "sessionId", "uuid"] {
        if let Some(id) = value.get(key).and_then(Value::as_str) {
            return Some(id.to_string());
        }
    }
    value.get("message").and_then(extract_session_id)
}

fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str) {
            return Some(text.to_string());
        }
    }

    match value {
        Value::Object(map) => map.values().find_map(|v| first_string(v, keys)),
        Value::Array(items) => items.iter().find_map(|v| first_string(v, keys)),
        _ => None,
    }
}
