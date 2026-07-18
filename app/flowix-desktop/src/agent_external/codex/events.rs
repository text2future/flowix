use serde_json::Value;

use crate::agent_flowix::{AgentChunk, StatusInfo, UsageInfo};

use super::tool_events::{
    looks_like_unknown_tool_event, tool_event_definition, tool_event_id, tool_event_name,
    CodexToolEventDefinition, CodexToolEventMode,
};
use super::{truncate_chars, MAX_UI_OUTPUT_PREVIEW_CHARS};

// Codex stdout event policy.
//
// Events converted into AgentChunk:
// - Official JSONL schema:
//   - item.started + item.type=command_execution -> ToolCall
//   - item.completed + item.type=command_execution -> ToolResult
//   - item.completed + item.type=agent_message/message -> Text
//   - item.started/item.completed + item.type=reasoning -> Reasoning
//   - item.started/item.completed + item.type=function_call/custom_tool_call -> ToolCall
//   - item.started/item.completed + item.type=function_call_output/custom_tool_call_output -> ToolResult
//   - turn.completed.usage -> Usage
//   - turn.failed/error -> Error, except transient reconnect/progress events
// - Legacy/internal schema:
//   - event_msg:agent_message -> Text
//   - event_msg:token_count -> Usage
//   - turn_context -> Usage metadata snapshot (model/context window only)
//   - response_item:reasoning/function_call/custom_tool_call/function_call_output/custom_tool_call_output
//     -> Reasoning/ToolCall/ToolResult
//
// Events intentionally ignored here:
// - thread.started: handled in codex_cli.rs as SessionResolved, not as a UI chunk.
// - turn.started/session_meta/compacted: lifecycle markers with no visible UI payload.
// - event_msg:task_started/task_complete/user_message/patch_apply_end/context_compacted:
//   lifecycle/noise; task_complete is handled in codex_cli.rs for stream_end.
// - response_item:message: skipped to avoid duplicate assistant text when event_msg:agent_message
//   carries the same output in older Codex streams.
#[derive(Debug)]
enum CodexEvent {
    /// Metadata-only event emitted into run state.
    Lifecycle {
        usage: Option<UsageSnapshot>,
    },
    Reasoning {
        text: String,
    },
    Text {
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        id: String,
        name: String,
        result: Value,
    },
    ToolComplete {
        id: String,
        name: String,
        input: Value,
        result: Value,
    },
    Error {
        message: String,
    },
    Unknown,
}

/// Token usage snapshot emitted by Codex `event_msg:token_count`.
/// Internal representation that aggregates `event_msg:token_count`,
/// `turn.completed.usage`, and `turn_context` payload — used to build the
/// wire-format [`UsageInfo`] + [`StatusInfo`] + top-level metadata chunks.
///
/// `prompt_tokens` / `completion_tokens` are kept here as parse-time helpers
/// but never reach the wire: they are folded into `input_tokens` /
/// `output_tokens` at construction time (Codex already reports new-protocol
/// fields, so the fold is a no-op in practice; the fields stay for parity
/// with the parse helpers and to absorb legacy/internal Codex payloads).
#[derive(Debug, Clone)]
struct UsageSnapshot {
    input_tokens: Option<u32>,
    cached_input_tokens: Option<u32>,
    output_tokens: Option<u32>,
    reasoning_output_tokens: Option<u32>,
    model_context_window: Option<u32>,
    model_id: Option<String>,
    codex_plan_type: Option<String>,
    codex_used_percent: Option<f64>,
    codex_resets_at: Option<i64>,
    last_run_at: Option<i64>,
    total_tokens: u32,
}

pub fn codex_event_to_chunks(thread_id: &str, value: &Value) -> Vec<AgentChunk> {
    match parse_codex_event(value) {
        CodexEvent::Lifecycle { usage: None } | CodexEvent::Unknown => Vec::new(),
        CodexEvent::Lifecycle { usage: Some(usage) } => {
            // 通用 metadata 协议 ── 透传给前端, 累加到 run / thread。
            // token 字段走嵌套 `UsageInfo`,codex plan 信息走嵌套 `StatusInfo`,
            // model_id / last_run_at 留在顶层。
            vec![AgentChunk::Usage {
                thread_id: thread_id.to_string(),
                model_id: usage.model_id,
                last_run_at: usage.last_run_at,
                usage: Some(UsageInfo {
                    input_tokens: usage.input_tokens,
                    cached_input_tokens: usage.cached_input_tokens,
                    output_tokens: usage.output_tokens,
                    reasoning_output_tokens: usage.reasoning_output_tokens,
                    total_tokens: Some(usage.total_tokens),
                    model_context_window: usage.model_context_window,
                }),
                status_info: Some(StatusInfo {
                    codex_plan_type: usage.codex_plan_type,
                    codex_used_percent: usage.codex_used_percent,
                    codex_resets_at: usage.codex_resets_at,
                }),
            }]
        }
        CodexEvent::Reasoning { text } => vec![AgentChunk::Reasoning {
            thread_id: thread_id.to_string(),
            text,
        }],
        CodexEvent::Text { text } => vec![AgentChunk::Text {
            thread_id: thread_id.to_string(),
            text,
        }],
        CodexEvent::ToolCall { id, name, input } => vec![AgentChunk::ToolCall {
            thread_id: thread_id.to_string(),
            id,
            name,
            input,
        }],
        CodexEvent::ToolResult { id, name, result } => vec![AgentChunk::ToolResult {
            thread_id: thread_id.to_string(),
            id,
            name,
            result,
        }],
        CodexEvent::ToolComplete {
            id,
            name,
            input,
            result,
        } => vec![
            AgentChunk::ToolCall {
                thread_id: thread_id.to_string(),
                id: id.clone(),
                name: name.clone(),
                input,
            },
            AgentChunk::ToolResult {
                thread_id: thread_id.to_string(),
                id,
                name,
                result,
            },
        ],
        CodexEvent::Error { message } => vec![AgentChunk::Error {
            thread_id: thread_id.to_string(),
            message,
        }],
    }
}

fn parse_codex_event(value: &Value) -> CodexEvent {
    let event_type = value
        .get("type")
        .or_else(|| value.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();

    match event_type.as_str() {
        "event_msg" => parse_codex_event_msg(value),
        "error" => first_string(value, &["message", "error"])
            .filter(|message| !message.trim().is_empty())
            .filter(|message| !is_transient_codex_status_message(message))
            .map(|message| CodexEvent::Error { message })
            .unwrap_or(CodexEvent::Unknown),
        "turn.failed" => parse_turn_failed(value),
        "item.started" | "item.completed" => parse_codex_item_event(value, &event_type),
        "turn_context" => {
            let payload = event_payload(value);
            CodexEvent::Lifecycle {
                usage: Some(UsageSnapshot {
                    input_tokens: None,
                    cached_input_tokens: None,
                    output_tokens: None,
                    reasoning_output_tokens: None,
                    model_context_window: number_u32(
                        payload,
                        &["model_context_window", "context_window"],
                    ),
                    model_id: first_string(payload, &["model_id", "modelId", "model"]),
                    codex_plan_type: None,
                    codex_used_percent: None,
                    codex_resets_at: None,
                    last_run_at: parse_event_timestamp_millis(value),
                    total_tokens: 0,
                }),
            }
        }
        "response_item" => parse_codex_response_item(value),
        "turn.completed" => value
            .get("usage")
            .map(|usage| CodexEvent::Lifecycle {
                usage: Some(usage_from_token_count(value, usage)),
            })
            .unwrap_or(CodexEvent::Unknown),
        "thread.started" | "turn.started" | "session_meta" | "compacted" => CodexEvent::Unknown,
        _ => CodexEvent::Unknown,
    }
}

fn parse_codex_event_msg(value: &Value) -> CodexEvent {
    let payload = event_payload(value);
    let payload_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();

    match payload_type.as_str() {
        "token_count" => CodexEvent::Lifecycle {
            usage: Some(usage_from_token_count(value, payload)),
        },
        "agent_message" => first_string(payload, &["message", "text", "content"])
            .filter(|text| !text.trim().is_empty())
            .map(|text| CodexEvent::Text { text })
            .unwrap_or(CodexEvent::Unknown),
        "task_started" | "task_complete" | "user_message" | "context_compacted" => {
            CodexEvent::Unknown
        }
        _ => {
            if let Some(definition) = tool_event_definition(&payload_type) {
                tool_complete_from_payload(payload, &payload_type, Some(definition))
            } else if looks_like_unknown_tool_event(&payload_type, payload) {
                tool_complete_from_payload(payload, &payload_type, None)
            } else {
                CodexEvent::Unknown
            }
        }
    }
}

fn parse_codex_response_item(value: &Value) -> CodexEvent {
    let payload = value
        .get("payload")
        .or_else(|| value.get("item"))
        .unwrap_or(value);
    let item_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();

    let non_tool_event = match item_type.as_str() {
        "reasoning" => first_string(payload, &["summary", "text", "content", "message"])
            .filter(|text| !text.trim().is_empty())
            .map(|text| CodexEvent::Reasoning { text })
            .unwrap_or(CodexEvent::Unknown),
        "message" => CodexEvent::Unknown,
        _ => {
            if let Some(definition) = tool_event_definition(&item_type) {
                return tool_event_from_response_item(payload, &item_type, definition);
            }
            if looks_like_unknown_tool_event(&item_type, payload) {
                return tool_complete_from_payload(payload, &item_type, None);
            }
            CodexEvent::Unknown
        }
    };
    non_tool_event
}

fn tool_event_from_response_item(
    payload: &Value,
    item_type: &str,
    definition: CodexToolEventDefinition,
) -> CodexEvent {
    match definition.mode {
        CodexToolEventMode::Call => tool_call_from_response_item(payload, item_type),
        CodexToolEventMode::Result => tool_result_from_response_item(payload, item_type),
        CodexToolEventMode::Lifecycle | CodexToolEventMode::Complete => {
            tool_complete_from_payload(payload, item_type, Some(definition))
        }
    }
}

fn parse_codex_item_event(value: &Value, event_type: &str) -> CodexEvent {
    let payload = value
        .get("item")
        .or_else(|| value.get("payload").and_then(|payload| payload.get("item")))
        .or_else(|| value.get("payload"))
        .unwrap_or(value);
    let item_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();

    let non_tool_event = match item_type.as_str() {
        "agent_message" | "message" => message_text(payload)
            .filter(|text| !text.trim().is_empty())
            .map(|text| CodexEvent::Text { text })
            .unwrap_or(CodexEvent::Unknown),
        "reasoning" => first_string(payload, &["summary", "text", "content", "message"])
            .filter(|text| !text.trim().is_empty())
            .map(|text| CodexEvent::Reasoning { text })
            .unwrap_or(CodexEvent::Unknown),
        _ => {
            if let Some(definition) = tool_event_definition(&item_type) {
                return tool_event_from_item_envelope(
                    payload,
                    &item_type,
                    event_type,
                    Some(definition),
                );
            }
            if looks_like_unknown_tool_event(&item_type, payload) {
                return tool_event_from_item_envelope(payload, &item_type, event_type, None);
            }
            CodexEvent::Unknown
        }
    };
    non_tool_event
}

fn tool_event_from_item_envelope(
    payload: &Value,
    item_type: &str,
    event_type: &str,
    definition: Option<CodexToolEventDefinition>,
) -> CodexEvent {
    let mode = definition
        .map(|definition| definition.mode)
        .unwrap_or(CodexToolEventMode::Complete);
    match mode {
        CodexToolEventMode::Call => tool_call_from_response_item(payload, item_type),
        CodexToolEventMode::Result => tool_result_from_response_item(payload, item_type),
        CodexToolEventMode::Lifecycle if event_type == "item.started" => {
            tool_call_from_payload(payload, item_type, definition)
        }
        CodexToolEventMode::Lifecycle => tool_result_from_payload(payload, item_type, definition),
        CodexToolEventMode::Complete if event_type == "item.started" => {
            tool_call_from_payload(payload, item_type, definition)
        }
        CodexToolEventMode::Complete => tool_complete_from_payload(payload, item_type, definition),
    }
}

fn parse_turn_failed(value: &Value) -> CodexEvent {
    let payload = event_payload(value);
    first_string(payload, &["message", "error"])
        .or_else(|| first_string(value, &["message", "error"]))
        .filter(|message| !message.trim().is_empty())
        .filter(|message| !is_transient_codex_status_message(message))
        .map(|message| CodexEvent::Error { message })
        .unwrap_or(CodexEvent::Unknown)
}

pub fn is_transient_codex_reconnect_event(value: &Value) -> bool {
    let event_type = value
        .get("type")
        .or_else(|| value.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(event_type.as_str(), "turn.failed" | "error" | "event_msg") {
        return false;
    }
    let payload = event_payload(value);
    first_string(payload, &["message", "error", "text", "content"])
        .or_else(|| first_string(value, &["message", "error", "text", "content"]))
        .as_deref()
        .map(is_transient_codex_status_message)
        .unwrap_or(false)
}

fn is_transient_codex_status_message(message: &str) -> bool {
    let normalized = message.trim().to_ascii_lowercase();
    normalized.contains("reconnecting")
        || normalized.contains("reconnect")
        || normalized.contains("retrying")
        || normalized.contains("temporarily unavailable")
}

fn message_text(payload: &Value) -> Option<String> {
    if let Some(role) = payload.get("role").and_then(Value::as_str) {
        if role != "assistant" {
            return None;
        }
    }

    if let Some(text) = payload
        .get("text")
        .or_else(|| payload.get("message"))
        .and_then(Value::as_str)
        .map(str::to_string)
    {
        return Some(text);
    }

    let content = payload.get("content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    if let Some(items) = content.as_array() {
        let parts: Vec<String> = items
            .iter()
            .filter_map(|item| first_string(item, &["text", "content"]))
            .filter(|text| !text.trim().is_empty())
            .collect();
        if !parts.is_empty() {
            return Some(parts.join(""));
        }
    }
    None
}

fn event_payload(value: &Value) -> &Value {
    value.get("payload").unwrap_or(value)
}

fn usage_from_token_count(value: &Value, payload: &Value) -> UsageSnapshot {
    let input = number_u32(payload, &["input_tokens", "input", "prompt_tokens"]);
    let output = number_u32(payload, &["output_tokens", "output", "completion_tokens"]);
    let reasoning_output = number_u32(
        payload,
        &["reasoning_output_tokens", "reasoning_tokens", "reasoning"],
    );
    let total = number_u32(payload, &["total_tokens", "total"])
        .or_else(|| checked_sum_u32(&[input, output, reasoning_output]))
        .unwrap_or(0);

    UsageSnapshot {
        input_tokens: input,
        cached_input_tokens: number_u32(payload, &["cached_input_tokens", "cached_tokens"]),
        output_tokens: output,
        reasoning_output_tokens: reasoning_output,
        model_context_window: number_u32(payload, &["model_context_window", "context_window"]),
        model_id: first_string(payload, &["model_id", "modelId", "model"]),
        codex_plan_type: first_string(payload, &["codex_plan_type", "plan_type", "plan"]),
        codex_used_percent: number_f64(
            payload,
            &["codex_used_percent", "used_percent", "usage_percent"],
        ),
        codex_resets_at: number_i64(payload, &["codex_resets_at", "resets_at", "reset_at"]),
        last_run_at: parse_event_timestamp_millis(value),
        total_tokens: total,
    }
}

fn tool_call_from_response_item(payload: &Value, item_type: &str) -> CodexEvent {
    tool_call_from_payload(payload, item_type, tool_event_definition(item_type))
}

fn tool_result_from_response_item(payload: &Value, item_type: &str) -> CodexEvent {
    tool_result_from_payload(payload, item_type, tool_event_definition(item_type))
}

fn tool_call_from_payload(
    payload: &Value,
    item_type: &str,
    definition: Option<CodexToolEventDefinition>,
) -> CodexEvent {
    let id = tool_event_id(payload, item_type);
    let name = tool_event_name(payload, definition, item_type);
    let input = tool_input_payload(payload, item_type);

    CodexEvent::ToolCall { id, name, input }
}

fn tool_result_from_payload(
    payload: &Value,
    item_type: &str,
    definition: Option<CodexToolEventDefinition>,
) -> CodexEvent {
    let id = tool_event_id(payload, item_type);
    let name = tool_event_name(payload, definition, item_type);
    let result = tool_result_payload(tool_output_payload(payload, item_type));

    CodexEvent::ToolResult { id, name, result }
}

fn tool_complete_from_payload(
    payload: &Value,
    item_type: &str,
    definition: Option<CodexToolEventDefinition>,
) -> CodexEvent {
    CodexEvent::ToolComplete {
        id: tool_event_id(payload, item_type),
        name: tool_event_name(payload, definition, item_type),
        input: tool_input_payload(payload, item_type),
        result: tool_result_payload(tool_output_payload(payload, item_type)),
    }
}

fn tool_input_payload(payload: &Value, item_type: &str) -> Value {
    if matches!(
        item_type,
        "mcp_tool_call" | "mcp_tool_call_end" | "dynamic_tool_call"
    ) {
        let invocation = payload.get("invocation");
        let tool = payload
            .get("tool")
            .or_else(|| payload.get("tool_name"))
            .or_else(|| payload.get("name"))
            .or_else(|| invocation.and_then(|value| value.get("tool")))
            .cloned()
            .unwrap_or(Value::Null);
        let server = payload
            .get("server")
            .or_else(|| invocation.and_then(|value| value.get("server")))
            .cloned()
            .unwrap_or(Value::Null);
        let arguments = payload
            .get("arguments")
            .or_else(|| payload.get("input"))
            .or_else(|| invocation.and_then(|value| value.get("arguments")))
            .map(normalize_json_value)
            .unwrap_or(Value::Null);
        return serde_json::json!({
            "tool": tool,
            "server": server,
            "arguments": arguments,
        });
    }
    if matches!(item_type, "file_change" | "patch_apply_end") {
        return serde_json::json!({
            "changes": payload.get("changes").cloned().unwrap_or(Value::Null)
        });
    }
    if let Some(command) = payload.get("command") {
        return serde_json::json!({ "command": command });
    }
    for key in [
        "arguments",
        "input",
        "params",
        "action",
        "query",
        "prompt",
        "changes",
    ] {
        if let Some(value) = payload.get(key) {
            return normalize_json_value(value);
        }
    }
    fallback_tool_payload(payload, item_type)
}

fn tool_output_payload(payload: &Value, item_type: &str) -> Value {
    for key in [
        "output",
        "aggregated_output",
        "result",
        "content",
        "changes",
    ] {
        if let Some(value) = payload.get(key) {
            return normalize_json_value(value);
        }
    }
    fallback_tool_payload(payload, item_type)
}

fn fallback_tool_payload(payload: &Value, item_type: &str) -> Value {
    let raw = payload.to_string();
    let raw_chars = raw.chars().count();
    serde_json::json!({
        "codex_item_type": item_type,
        "raw_payload_chars": raw_chars,
        "raw_payload_truncated": raw_chars > MAX_UI_OUTPUT_PREVIEW_CHARS,
        "raw_payload_preview": truncate_chars(&raw, MAX_UI_OUTPUT_PREVIEW_CHARS),
    })
}

fn tool_result_payload(value: Value) -> Value {
    let text_output = match &value {
        Value::String(output) => Some(output.clone()),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .or_else(|| item.get("content"))
                        .and_then(Value::as_str)
                })
                .collect::<Vec<_>>();
            (!parts.is_empty()).then(|| parts.join(""))
        }
        _ => None,
    };
    if let Some(output) = text_output {
        let output_chars = output.chars().count();
        let output_truncated = output_chars > MAX_UI_OUTPUT_PREVIEW_CHARS;
        return serde_json::json!({
            "output_chars": output_chars,
            "output_truncated": output_truncated,
            "output_preview": truncate_chars(&output, MAX_UI_OUTPUT_PREVIEW_CHARS),
        });
    }
    value
}

fn normalize_json_value(value: &Value) -> Value {
    value
        .as_str()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .unwrap_or_else(|| value.clone())
}

fn number_u32(value: &Value, keys: &[&str]) -> Option<u32> {
    for key in keys {
        if let Some(n) = value.get(*key).and_then(Value::as_u64) {
            if let Ok(n) = u32::try_from(n) {
                return Some(n);
            }
        }
        if let Some(n) = value
            .get(*key)
            .and_then(Value::as_i64)
            .and_then(|n| u32::try_from(n).ok())
        {
            return Some(n);
        }
    }
    None
}

fn number_i64(value: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_i64))
}

fn number_f64(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_f64))
}

fn checked_sum_u32(values: &[Option<u32>]) -> Option<u32> {
    let mut total = 0u32;
    let mut has_value = false;
    for value in values.iter().flatten() {
        has_value = true;
        total = total.checked_add(*value)?;
    }
    has_value.then_some(total)
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

fn parse_event_timestamp_millis(value: &Value) -> Option<i64> {
    let timestamp = value.get("timestamp").or_else(|| {
        value
            .get("payload")
            .and_then(|payload| payload.get("timestamp"))
    })?;
    if let Some(text) = timestamp.as_str() {
        return chrono::DateTime::parse_from_rfc3339(text)
            .map(|dt| dt.timestamp_millis())
            .ok();
    }
    if let Some(n) = timestamp.as_i64() {
        return Some(if n < 10_000_000_000 {
            n.saturating_mul(1000)
        } else {
            n
        });
    }
    if let Some(n) = timestamp.as_f64() {
        let millis = if n < 10_000_000_000.0 { n * 1000.0 } else { n };
        return Some(millis as i64);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_codex_command_execution_to_lightweight_tool_chunks() {
        let started = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "call_id": "call_0",
                "name": "command_execution",
                "arguments": {
                    "command": "powershell -Command 'echo congratulations'"
                }
            }
        });
        let completed = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "call_id": "call_0",
                "name": "command_execution",
                "output": "congratulations\r\n"
            }
        });

        let start_chunks = codex_event_to_chunks("thread_1", &started);
        assert!(matches!(
            start_chunks.as_slice(),
            [AgentChunk::ToolCall { name, input, .. }]
                if name == "command_execution"
                    && input.get("command").and_then(Value::as_str)
                        == Some("powershell -Command 'echo congratulations'")
        ));

        let complete_chunks = codex_event_to_chunks("thread_1", &completed);
        assert!(matches!(
            complete_chunks.as_slice(),
            [AgentChunk::ToolResult { name, result, .. }]
                if name == "command_execution"
                    && result.get("output_preview").and_then(Value::as_str)
                        == Some("congratulations\r\n")
        ));
    }

    #[test]
    fn truncates_large_codex_command_output_in_ui_chunks() {
        let large_output = "x".repeat(super::MAX_UI_OUTPUT_PREVIEW_CHARS + 10);
        let completed = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "call_id": "call_large",
                "name": "command_execution",
                "output": large_output
            }
        });

        let chunks = codex_event_to_chunks("thread_1", &completed);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolResult { result, .. }]
                if result.get("output_truncated").and_then(Value::as_bool) == Some(true)
                    && result.get("output_preview")
                        .and_then(Value::as_str)
                        .map(|text| text.ends_with("...[truncated]"))
                        == Some(true)
        ));
    }

    #[test]
    fn preserves_names_for_current_codex_function_tools() {
        for name in [
            "list_mcp_resources",
            "list_mcp_resource_templates",
            "read_mcp_resource",
            "get_goal",
            "create_goal",
            "update_goal",
            "apply_patch",
            "view_image",
            "exec_command",
            "update_plan",
        ] {
            let value = serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "call_id": format!("call_{name}"),
                    "name": name,
                    "arguments": "{}"
                }
            });
            assert!(matches!(
                codex_event_to_chunks("thread_1", &value).as_slice(),
                [AgentChunk::ToolCall { name: actual, .. }] if actual == name
            ));
        }
    }

    #[test]
    fn preserves_structured_and_failure_outputs_for_function_tools() {
        let cases = [
            (
                "list_mcp_resources",
                serde_json::json!({
                    "resources": [{
                        "server": "docs",
                        "uri": "resource://guide",
                        "metadata": { "nested": { "depth": 3 } }
                    }]
                })
                .to_string(),
            ),
            ("list_mcp_resource_templates", "[]".to_string()),
            (
                "get_goal",
                serde_json::json!({ "status": "none" }).to_string(),
            ),
            ("view_image", "SVG preview is not supported".to_string()),
            (
                "view_image",
                serde_json::json!({
                    "detail": "high",
                    "image_url": "data:image/png;base64,preview"
                })
                .to_string(),
            ),
        ];

        for (index, (name, output)) in cases.into_iter().enumerate() {
            let value = serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "function_call_output",
                    "call_id": format!("call_{index}"),
                    "name": name,
                    "output": output
                }
            });
            let chunks = codex_event_to_chunks("thread_1", &value);
            assert!(matches!(
                chunks.as_slice(),
                [AgentChunk::ToolResult { result, .. }]
                    if result.is_object() || result.is_array()
            ));
        }
    }

    #[test]
    fn maps_codex_agent_message_to_text_chunk() {
        let value = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "agent_message",
                "message": "`echo congratulations` output: congratulations"
            }
        });
        let chunks = codex_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::Text { text, .. }] if text.contains("congratulations")
        ));
    }

    #[test]
    fn maps_new_codex_item_completed_message_to_text_chunk() {
        let value = serde_json::json!({
            "type": "item.completed",
            "item": {
                "type": "agent_message",
                "text": "FLOWIX_CODEX_EVENT_DIAGNOSTIC_OK"
            }
        });
        let chunks = codex_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::Text { text, .. }] if text.contains("FLOWIX_CODEX_EVENT_DIAGNOSTIC_OK")
        ));
    }

    #[test]
    fn maps_new_codex_item_started_command_execution_to_tool_call() {
        let value = serde_json::json!({
            "type": "item.started",
            "item": {
                "id": "item_1",
                "type": "command_execution",
                "command": "bash -lc ls",
                "status": "in_progress"
            }
        });
        let chunks = codex_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolCall { id, name, input, .. }]
                if id == "item_1"
                    && name == "command_execution"
                    && input.get("command").and_then(Value::as_str) == Some("bash -lc ls")
        ));
    }

    #[test]
    fn maps_official_command_aggregated_output_to_tool_result() {
        let value = serde_json::json!({
            "type": "item.completed",
            "item": {
                "id": "item_1",
                "type": "command_execution",
                "command": "/bin/zsh -lc pwd",
                "aggregated_output": "/tmp/project\n",
                "exit_code": 0,
                "status": "completed"
            }
        });
        let chunks = codex_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolResult { id, name, result, .. }]
                if id == "item_1"
                    && name == "command_execution"
                    && result.get("output_preview").and_then(Value::as_str)
                        == Some("/tmp/project\n")
        ));
    }

    #[test]
    fn flattens_custom_tool_content_blocks_for_live_tool_result() {
        let value = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call_output",
                "call_id": "call_exec_1",
                "output": [
                    { "type": "input_text", "text": "Script completed\n" },
                    { "type": "input_text", "text": "/tmp/project\n" }
                ]
            }
        });
        let chunks = codex_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolResult { id, result, .. }]
                if id == "call_exec_1"
                    && result.get("output_preview").and_then(Value::as_str)
                        == Some("Script completed\n/tmp/project\n")
        ));
    }

    #[test]
    fn maps_registered_mcp_lifecycle_events() {
        let started = serde_json::json!({
            "type": "item.started",
            "item": {
                "id": "mcp_1",
                "type": "mcp_tool_call",
                "tool_name": "read_document",
                "arguments": { "id": "doc_1" },
                "status": "in_progress"
            }
        });
        let completed = serde_json::json!({
            "type": "item.completed",
            "item": {
                "id": "mcp_1",
                "type": "mcp_tool_call",
                "tool_name": "read_document",
                "arguments": { "id": "doc_1" },
                "result": { "content": "document body" },
                "status": "completed"
            }
        });

        assert!(matches!(
            codex_event_to_chunks("thread_1", &started).as_slice(),
            [AgentChunk::ToolCall { id, name, input, .. }]
                if id == "mcp_1"
                    && name == "mcp_tool_call"
                    && input.get("tool").and_then(Value::as_str) == Some("read_document")
        ));
        assert!(matches!(
            codex_event_to_chunks("thread_1", &completed).as_slice(),
            [AgentChunk::ToolResult { id, name, .. }]
                if id == "mcp_1" && name == "mcp_tool_call"
        ));
    }

    #[test]
    fn maps_real_event_msg_tool_end_shapes_with_specific_inputs() {
        let mcp = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "mcp_tool_call_end",
                "call_id": "exec-mcp-1",
                "invocation": {
                    "server": "codex",
                    "tool": "list_mcp_resources",
                    "arguments": {}
                },
                "result": { "Ok": { "content": [] } }
            }
        });
        let mcp_chunks = codex_event_to_chunks("thread_1", &mcp);
        assert!(matches!(
            mcp_chunks.as_slice(),
            [AgentChunk::ToolCall { name, input, .. }, AgentChunk::ToolResult { .. }]
                if name == "mcp_tool_call"
                    && input.get("tool").and_then(Value::as_str)
                        == Some("list_mcp_resources")
                    && input.get("server").and_then(Value::as_str) == Some("codex")
        ));

        let patch = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "patch_apply_end",
                "call_id": "patch-1",
                "success": true,
                "changes": {
                    "/tmp/probe.svg": { "type": "add" }
                }
            }
        });
        let patch_chunks = codex_event_to_chunks("thread_1", &patch);
        assert!(matches!(
            patch_chunks.as_slice(),
            [AgentChunk::ToolCall { name, input, .. }, AgentChunk::ToolResult { .. }]
                if name == "file_change"
                    && input.get("changes")
                        .and_then(|changes| changes.get("/tmp/probe.svg"))
                        .is_some()
        ));
    }

    #[test]
    fn unknown_event_msg_tool_end_uses_complete_fallback() {
        let value = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "future_tool_end",
                "call_id": "future-1",
                "name": "future_connector",
                "arguments": { "query": "hello" },
                "result": { "content": "world" }
            }
        });
        let chunks = codex_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolCall { name, .. }, AgentChunk::ToolResult { .. }]
                if name == "future_connector"
        ));
    }

    #[test]
    fn maps_real_codex_file_change_lifecycle_shape() {
        let started = serde_json::json!({
            "type": "item.started",
            "item": {
                "id": "item_1",
                "type": "file_change",
                "changes": [{ "path": "/tmp/probe.txt", "kind": "add" }],
                "status": "in_progress"
            }
        });
        let completed = serde_json::json!({
            "type": "item.completed",
            "item": {
                "id": "item_1",
                "type": "file_change",
                "changes": [{ "path": "/tmp/probe.txt", "kind": "add" }],
                "status": "completed"
            }
        });

        assert!(matches!(
            codex_event_to_chunks("thread_1", &started).as_slice(),
            [AgentChunk::ToolCall { id, name, input, .. }]
                if id == "item_1"
                    && name == "file_change"
                    && input.get("changes").and_then(Value::as_array).is_some()
        ));
        assert!(matches!(
            codex_event_to_chunks("thread_1", &completed).as_slice(),
            [AgentChunk::ToolResult { id, name, result, .. }]
                if id == "item_1"
                    && name == "file_change"
                    && result.as_array().is_some()
        ));
    }

    #[test]
    fn unknown_tool_shaped_response_item_gets_generic_complete_chunks() {
        let value = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "future_connector_call",
                "call_id": "future_1",
                "name": "future_connector",
                "arguments": { "query": "hello" },
                "result": { "status": "ok" }
            }
        });

        let chunks = codex_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [
                AgentChunk::ToolCall { id: call_id, name: call_name, .. },
                AgentChunk::ToolResult { id: result_id, name: result_name, .. }
            ] if call_id == "future_1"
                && result_id == "future_1"
                && call_name == "future_connector"
                && result_name == "future_connector"
        ));
    }

    #[test]
    fn unknown_non_tool_item_stays_hidden() {
        let value = serde_json::json!({
            "type": "item.completed",
            "item": {
                "type": "thread_settings_applied",
                "model": "gpt-5"
            }
        });
        assert!(codex_event_to_chunks("thread_1", &value).is_empty());
    }

    #[test]
    fn maps_new_codex_turn_completed_usage_to_usage_chunk() {
        let value = serde_json::json!({
            "type": "turn.completed",
            "usage": {
                "input_tokens": 24763,
                "cached_input_tokens": 24448,
                "output_tokens": 122,
                "reasoning_output_tokens": 0
            }
        });
        let chunks = codex_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::Usage {
                usage: Some(crate::agent_types::UsageInfo {
                    input_tokens: Some(24763),
                    cached_input_tokens: Some(24448),
                    output_tokens: Some(122),
                    reasoning_output_tokens: Some(0),
                    total_tokens: Some(24885),
                    ..
                }),
                ..
            }]
        ));
    }

    #[test]
    fn maps_official_codex_jsonl_fixture_to_ui_chunks() {
        let fixture = [
            r#"{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}"#,
            r#"{"type":"turn.started"}"#,
            r#"{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs, sdk, and examples directories."}}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}"#,
        ];
        let chunks: Vec<AgentChunk> = fixture
            .iter()
            .flat_map(|line| {
                let value: Value = serde_json::from_str(line).expect("fixture line is valid JSON");
                codex_event_to_chunks("thread_1", &value)
            })
            .collect();

        assert_eq!(chunks.len(), 3);
        assert!(matches!(
            &chunks[0],
            AgentChunk::ToolCall { id, name, input, .. }
                if id == "item_1"
                    && name == "command_execution"
                    && input.get("command").and_then(Value::as_str) == Some("bash -lc ls")
        ));
        assert!(matches!(
            &chunks[1],
            AgentChunk::Text { text, .. }
                if text == "Repo contains docs, sdk, and examples directories."
        ));
        assert!(matches!(
            &chunks[2],
            AgentChunk::Usage {
                usage: Some(crate::agent_types::UsageInfo {
                    input_tokens: Some(24763),
                    cached_input_tokens: Some(24448),
                    output_tokens: Some(122),
                    reasoning_output_tokens: Some(0),
                    total_tokens: Some(24885),
                    ..
                }),
                ..
            }
        ));
    }

    #[test]
    fn skips_transient_codex_reconnect_errors() {
        let error = serde_json::json!({
            "type": "error",
            "message": "Reconnecting..."
        });
        let failed = serde_json::json!({
            "type": "turn.failed",
            "error": {
                "message": "stream disconnected before completion; retrying"
            }
        });

        assert!(is_transient_codex_reconnect_event(&error));
        assert!(codex_event_to_chunks("thread_1", &error).is_empty());
        assert!(is_transient_codex_reconnect_event(&failed));
        assert!(codex_event_to_chunks("thread_1", &failed).is_empty());
    }

    #[test]
    fn maps_new_codex_error_events_to_error_chunks() {
        let error = serde_json::json!({
            "type": "error",
            "message": "fatal transport error"
        });
        let failed = serde_json::json!({
            "type": "turn.failed",
            "error": {
                "message": "stream disconnected before completion"
            }
        });

        let error_chunks = codex_event_to_chunks("thread_1", &error);
        assert!(matches!(
            error_chunks.as_slice(),
            [AgentChunk::Error { message, .. }] if message.contains("fatal transport")
        ));

        let failed_chunks = codex_event_to_chunks("thread_1", &failed);
        assert!(matches!(
            failed_chunks.as_slice(),
            [AgentChunk::Error { message, .. }] if message.contains("stream disconnected")
        ));
    }

    #[test]
    fn maps_codex_token_count_to_usage_chunk() {
        let value = serde_json::json!({
            "type": "event_msg",
            "timestamp": 1_756_468_800,
            "payload": {
                "type": "token_count",
                "input_tokens": 100,
                "cached_input_tokens": 40,
                "output_tokens": 20,
                "reasoning_output_tokens": 5,
                "total_tokens": 125,
                "model_context_window": 400000,
                "codex_plan_type": "pro",
                "codex_used_percent": 22.0,
                "codex_resets_at": 1_756_555_200
            }
        });
        let chunks = codex_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::Usage {
                usage: Some(crate::agent_types::UsageInfo {
                    input_tokens: Some(100),
                    cached_input_tokens: Some(40),
                    output_tokens: Some(20),
                    reasoning_output_tokens: Some(5),
                    total_tokens: Some(125),
                    model_context_window: Some(400000),
                    ..
                }),
                status_info: Some(crate::agent_types::StatusInfo {
                    codex_plan_type,
                    codex_used_percent,
                    codex_resets_at: Some(1_756_555_200),
                    ..
                }),
                last_run_at: Some(1_756_468_800_000),
                ..
            }] if codex_plan_type.as_deref() == Some("pro")
                && codex_used_percent == &Some(22.0)
        ));
    }

    #[test]
    fn skips_unlisted_codex_events() {
        let value = serde_json::json!({
            "type": "item.completed",
            "item": {
                "type": "unknown_item",
                "text": "legacy duplicate"
            }
        });
        let chunks = codex_event_to_chunks("thread_1", &value);
        assert!(chunks.is_empty());
    }

    #[test]
    fn maps_codex_web_search_call_to_web_search_tool_call() {
        let value = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "call_id": "ws_1",
                "name": "web_search",
                "arguments": {
                    "query": "Flowix Codex web search"
                }
            }
        });
        let chunks = codex_event_to_chunks("thread_1", &value);
        assert!(matches!(
            chunks.as_slice(),
            [AgentChunk::ToolCall { name, input, .. }]
                if name == "web_search"
                    && input.get("query").and_then(Value::as_str) == Some("Flowix Codex web search")
        ));
    }
}
