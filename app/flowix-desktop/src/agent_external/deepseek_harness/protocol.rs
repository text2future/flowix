use serde_json::{json, Value};

use crate::agent_external::AgentChunkMetadata;
use crate::agent_wire::{AgentChunk, UsageInfo};

/// Codex-compatible DSH App Server protocol marker. This is intentionally
/// separate from the legacy Flowix host protocol: App Server connections are
/// initialized per JSON-RPC client and use thread/turn notifications directly.
pub const APP_SERVER_PROTOCOL_VERSION: u64 = 1;

/// Returns whether the App Server transport has been selected for this
/// process. Keeping this decision in one place prevents the request builder,
/// manager, and process factory from drifting during the migration.
pub fn app_initialize_request(id: u64, client_version: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": APP_SERVER_PROTOCOL_VERSION,
            "clientInfo": { "name": "flowix-desktop", "version": client_version },
            "capabilities": {}
        }
    })
}

pub fn app_thread_start_request(
    id: u64,
    flowix_thread_id: &str,
    cwd: &str,
    workspace_paths: &[String],
    provider: &str,
    model: &str,
    agent_preset: &str,
    permission_mode: &str,
) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "thread/start",
        "params": {
            // The App Server owns the DSH session identity. `flowixThreadId`
            // is correlation metadata only; it must never be reused as the
            // provider-owned `threadId`/session id.
            "flowixThreadId": flowix_thread_id, "cwd": cwd, "workspacePaths": workspace_paths,
            "provider": provider, "model": model, "agentPreset": agent_preset,
            "permissionMode": permission_mode
        }
    })
}

pub fn app_thread_resume_request(
    id: u64,
    thread_id: &str,
    provider: &str,
    model: &str,
    agent_preset: &str,
    permission_mode: &str,
) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "thread/resume",
        "params": {
            "threadId": thread_id, "provider": provider, "model": model,
            "agentPreset": agent_preset, "permissionMode": permission_mode
        }
    })
}

pub fn app_turn_start_request(id: u64, thread_id: &str, input: impl Into<Value>) -> Value {
    let input = input.into();
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "turn/start",
        "params": { "threadId": thread_id, "input": input }
    })
}

pub fn app_turn_steer_request(
    id: u64,
    thread_id: &str,
    input: impl Into<Value>,
    client_message_id: &str,
) -> Value {
    let input = input.into();
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "turn/steer",
        "params": {
            "threadId": thread_id,
            "input": input,
            "clientMessageId": client_message_id,
        }
    })
}

pub fn app_turn_interrupt_request(id: u64, thread_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "turn/interrupt",
        "params": { "threadId": thread_id }
    })
}

pub fn app_thread_events_request(
    id: u64,
    thread_id: &str,
    after_sequence: Option<i64>,
    limit: i64,
) -> Value {
    let mut params = json!({ "threadId": thread_id, "limit": limit.clamp(1, 1000) });
    if let Some(sequence) = after_sequence.filter(|value| *value >= -1) {
        params["afterSeq"] = json!(sequence);
    }
    json!({ "jsonrpc": "2.0", "id": id, "method": "thread/events/list", "params": params })
}

pub fn app_runtime_dispose_request(id: u64, thread_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "thread/close",
        "params": { "threadId": thread_id }
    })
}

pub fn app_thread_archive_request(id: u64, session_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "thread/archive",
        "params": { "threadId": session_id }
    })
}

pub fn app_thread_command_request(id: u64, session_id: &str, command: &str) -> Value {
    app_thread_command_request_with_attachments(id, session_id, command, &[])
}

pub fn app_thread_command_request_with_attachments(
    id: u64,
    session_id: &str,
    command: &str,
    attachments: &[Value],
) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "thread/command",
        "params": { "threadId": session_id, "command": command, "attachments": attachments }
    })
}

pub fn app_thread_skills_request(id: u64, session_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "thread/skills",
        "params": { "threadId": session_id }
    })
}

pub fn app_session_usage_request(id: u64, session_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "flowix/session/usage",
        "params": { "sessionId": session_id }
    })
}

pub fn app_session_history_request(
    id: u64,
    session_id: &str,
    before_sequence: Option<i64>,
    snapshot_sequence: Option<i64>,
    limit: i64,
) -> Value {
    let mut params = json!({
        "sessionId": session_id,
        "limit": limit.clamp(1, 50)
    });
    if let Some(before_sequence) = before_sequence.filter(|value| *value >= 0) {
        params["beforeSequence"] = json!(before_sequence);
    }
    if let Some(snapshot_sequence) = snapshot_sequence.filter(|value| *value >= 0) {
        params["snapshotSequence"] = json!(snapshot_sequence);
    }
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/history",
        "params": params
    })
}

pub fn model_catalog_request(id: u64) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "model/catalog", "params": {} })
}

pub fn plugins_catalog_request(id: u64) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "flowix/plugins/list", "params": {} })
}

pub fn credential_status_request(id: u64, reference: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "credential/read", "params": { "reference": reference } })
}

pub fn credential_set_request(id: u64, reference: &str, value: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "credential/set", "params": { "reference": reference, "value": value } })
}

pub fn credential_delete_request(id: u64, reference: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "credential/unset", "params": { "reference": reference } })
}

pub fn model_settings_describe_request(id: u64) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "model/config/read", "params": {} })
}

pub fn model_settings_upsert_request(
    id: u64,
    route: &str,
    profile: &crate::config::DeepSeekHarnessProviderSettings,
    expected_revision: u64,
) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "model/config/upsert", "params": { "route": route, "profile": profile, "expectedRevision": expected_revision } })
}

pub fn model_settings_remove_request(id: u64, route: &str, expected_revision: u64) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "model/config/remove", "params": { "route": route, "expectedRevision": expected_revision } })
}

pub fn model_discover_request(
    id: u64,
    provider: Option<&str>,
    base_url: &str,
    api: &str,
    api_key: Option<&str>,
) -> Value {
    // dsh-llm's discovery contract spells this field `baseURL` (capital URL).
    // Keep the wire name aligned with LlmModelDiscoveryRequest; `baseUrl` is
    // silently ignored by the runtime and makes non-catalog providers look
    // like a no-op when the user clicks Test or Save.
    let mut params = json!({ "baseURL": base_url, "api": api });
    if let Some(provider) = provider {
        params["provider"] = json!(provider);
    }
    if let Some(api_key) = api_key.filter(|value| !value.trim().is_empty()) {
        params["apiKey"] = json!(api_key);
    }
    json!({ "jsonrpc": "2.0", "id": id, "method": "model/discover", "params": params })
}

pub fn response_result(message: &Value) -> Option<Result<Value, String>> {
    message.get("id")?;
    if let Some(error) = message.get("error") {
        return Some(Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("dsh-host request failed")
            .to_string()));
    }
    Some(Ok(message.get("result").cloned().unwrap_or(Value::Null)))
}

pub fn event_route(message: &Value) -> Option<(String, String)> {
    if message.get("method").and_then(Value::as_str) != Some("run.event") {
        return None;
    }
    Some((
        message.pointer("/params/threadId")?.as_str()?.to_string(),
        message.pointer("/params/runId")?.as_str()?.to_string(),
    ))
}

/// Return the Thread associated with a direct App Server notification. Unlike
/// the legacy `run.event` envelope, App Server notifications carry the thread
/// id directly in `params` and may omit a run id (for example status changes).
pub fn app_server_event_route(message: &Value) -> Option<String> {
    let method = message.get("method").and_then(Value::as_str)?;
    if !matches!(
        method,
        "thread/status/changed"
            | "thread/started"
            | "thread/resumed"
            | "turn/started"
            | "turn/completed"
            | "item/started"
            | "item/completed"
            | "item/agentMessage/delta"
            | "goal/changed"
            | "warning"
    ) {
        return None;
    }
    message
        .pointer("/params/threadId")
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub enum AdaptedEvent {
    Chunk(AgentChunk),
    ChunkWithMetadata(AgentChunk, AgentChunkMetadata),
    Completed(Option<String>),
    Ignore,
}

/// Some OpenAI-compatible reasoning models do not expose a separate
/// `reasoning_content` stream. They wrap the reasoning in `<think>...</think>`
/// inside ordinary assistant text instead. Keep this normalization at the
/// Harness boundary so live rendering and persisted history use the same role.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ThinkingSegment {
    Text(String),
    Reasoning(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ThinkingMode {
    Text,
    Reasoning,
}

pub(crate) struct ThinkingTagParser {
    mode: ThinkingMode,
    pending: String,
}

impl ThinkingTagParser {
    pub(crate) fn new() -> Self {
        Self {
            mode: ThinkingMode::Text,
            pending: String::new(),
        }
    }

    pub(crate) fn push(&mut self, text: &str) -> Vec<ThinkingSegment> {
        if text.is_empty() {
            return Vec::new();
        }
        self.pending.push_str(text);
        self.drain_pending()
    }

    /// Flush a partial tag at a protocol boundary as literal content while
    /// preserving the current thinking mode for the next text delta.
    pub(crate) fn flush_pending(&mut self) -> Vec<ThinkingSegment> {
        if self.pending.is_empty() {
            return Vec::new();
        }
        let text = std::mem::take(&mut self.pending);
        vec![self.segment(text)]
    }

    /// Flush the final unterminated segment and reset for a future run.
    pub(crate) fn finish(&mut self) -> Vec<ThinkingSegment> {
        let segments = self.flush_pending();
        self.mode = ThinkingMode::Text;
        segments
    }

    fn drain_pending(&mut self) -> Vec<ThinkingSegment> {
        let mut segments = Vec::new();
        loop {
            let marker = match self.mode {
                ThinkingMode::Text => "<think>",
                ThinkingMode::Reasoning => "</think>",
            };
            if let Some(index) = self.pending.find(marker) {
                if index > 0 {
                    let before = self.pending[..index].to_string();
                    segments.push(self.segment(before));
                }
                self.pending.drain(..index + marker.len());
                self.mode = match self.mode {
                    ThinkingMode::Text => ThinkingMode::Reasoning,
                    ThinkingMode::Reasoning => ThinkingMode::Text,
                };
                continue;
            }

            let keep = longest_marker_prefix_suffix(&self.pending, marker);
            if keep == 0 {
                let text = std::mem::take(&mut self.pending);
                if !text.is_empty() {
                    segments.push(self.segment(text));
                }
            } else {
                let emit_len = self.pending.len() - keep;
                if emit_len > 0 {
                    let text = self.pending[..emit_len].to_string();
                    self.pending.drain(..emit_len);
                    segments.push(self.segment(text));
                }
            }
            break;
        }
        segments
    }

    fn segment(&self, text: String) -> ThinkingSegment {
        match self.mode {
            ThinkingMode::Text => ThinkingSegment::Text(text),
            ThinkingMode::Reasoning => ThinkingSegment::Reasoning(text),
        }
    }
}

fn longest_marker_prefix_suffix(value: &str, marker: &str) -> usize {
    (1..marker.len())
        .rev()
        .find(|length| value.ends_with(&marker[..*length]))
        .unwrap_or(0)
}

pub fn adapt_event(message: &Value, delivery_thread_id: &str) -> AdaptedEvent {
    // Direct App Server notifications are not wrapped in the legacy
    // `params.event` envelope. Normalize the common streaming boundaries here
    // so the existing projector can consume both transports during rollout.
    if message.pointer("/params/event").is_none() {
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let thread_id = delivery_thread_id.to_string();
        return match method {
            "item/agentMessage/delta" => {
                let Some(text) = message.pointer("/params/delta").and_then(Value::as_str) else {
                    return AdaptedEvent::Ignore;
                };
                let message_id = message
                    .pointer("/params/itemId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let source_sequence = message.pointer("/params/sourceSeq").and_then(Value::as_u64);
                let source_subsequence = message
                    .pointer("/params/sourceSubsequence")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok());
                AdaptedEvent::ChunkWithMetadata(
                    AgentChunk::Text {
                        thread_id,
                        text: text.to_string(),
                    },
                    AgentChunkMetadata {
                        codex_turn_id: message
                            .pointer("/params/turnId")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        message_id: message_id.clone(),
                        source_message_id: message_id,
                        message_phase: Some("updated"),
                        content_mode: Some("delta"),
                        source_sequence,
                        source_subsequence,
                        ..AgentChunkMetadata::default()
                    },
                )
            }
            "turn/completed" => {
                let status = message
                    .pointer("/params/turn/status")
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                let reason = match status {
                    "completed" => "completed".to_string(),
                    "cancelled" => "cancelled".to_string(),
                    failed => message
                        .pointer("/params/turn/error/message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| failed.to_string()),
                };
                AdaptedEvent::Completed(Some(reason))
            }
            "item/started" | "item/completed" => {
                let item = message.pointer("/params/item").unwrap_or(&Value::Null);
                let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
                let id = item
                    .get("callId")
                    .or_else(|| item.get("id"))
                    .and_then(Value::as_str);
                let Some(id) = id else {
                    return AdaptedEvent::Ignore;
                };
                // DSH's userMessage is the durable turn boundary, just like
                // Codex's app-server userMessage item. Relay the completed
                // item with its provider identity so the frontend can adopt
                // the optimistic row and history can reconcile by id.
                if method == "item/completed" && item_type == "userMessage" {
                    let text =
                        app_server_content_text(item.get("content").or_else(|| item.get("text")));
                    let message_type = item.get("messageType").and_then(Value::as_str).and_then(
                        |value| match value {
                            "goal-round" => Some("goal-round"),
                            "goal-complete" => Some("goal-complete"),
                            "goal-blocked" => Some("goal-blocked"),
                            _ => None,
                        },
                    );
                    let trimmed = text.trim_start();
                    // DSH may persist workspace instructions as synthetic
                    // userMessage items. They are not user turns and must
                    // not reach the conversation projection. The real user
                    // item is still relayed and adopts the optimistic row.
                    if trimmed.is_empty()
                        || trimmed.starts_with("<system-reminder>")
                        || trimmed.starts_with("Current runtime context.")
                    {
                        return AdaptedEvent::Ignore;
                    }
                    let turn_id = message
                        .pointer("/params/turnId")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    return AdaptedEvent::ChunkWithMetadata(
                        AgentChunk::UserMessage {
                            thread_id,
                            id: id.to_string(),
                            text,
                            timestamp: chrono::Utc::now().timestamp_millis(),
                        },
                        AgentChunkMetadata {
                            codex_turn_id: turn_id,
                            message_id: Some(id.to_string()),
                            source_message_id: Some(id.to_string()),
                            message_type,
                            message_phase: Some("completed"),
                            content_mode: Some("snapshot"),
                            ..AgentChunkMetadata::default()
                        },
                    );
                }
                // A completed DSH assistant turn may be delivered as a
                // durable `agentMessage` snapshot without any preceding
                // streaming delta. This is the normal path for short
                // responses (and for replay-compatible App Server hosts).
                // Preserve the provider item id so the frontend can merge a
                // snapshot with any deltas that did arrive.
                if method == "item/completed" && item_type == "agentMessage" {
                    let text =
                        app_server_content_text(item.get("content").or_else(|| item.get("text")));
                    if text.trim().is_empty() {
                        return AdaptedEvent::Ignore;
                    }
                    return AdaptedEvent::ChunkWithMetadata(
                        AgentChunk::Text { thread_id, text },
                        AgentChunkMetadata {
                            message_id: Some(id.to_string()),
                            source_message_id: Some(id.to_string()),
                            message_phase: Some("completed"),
                            content_mode: Some("snapshot"),
                            ..AgentChunkMetadata::default()
                        },
                    );
                }
                let name = item
                    .get("toolName")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string();
                match (method, item_type) {
                    ("item/started", "toolCall") => AdaptedEvent::Chunk(AgentChunk::ToolCall {
                        thread_id,
                        id: id.to_string(),
                        name,
                        input: item.get("input").cloned().unwrap_or_else(|| json!({})),
                    }),
                    ("item/completed", "toolResult") => {
                        AdaptedEvent::Chunk(AgentChunk::ToolResult {
                            thread_id,
                            id: id.to_string(),
                            name,
                            result: item.get("result").cloned().unwrap_or(Value::Null),
                        })
                    }
                    _ => AdaptedEvent::Ignore,
                }
            }
            _ => AdaptedEvent::Ignore,
        };
    }
    let Some(event) = message.pointer("/params/event") else {
        return AdaptedEvent::Ignore;
    };
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let thread_id = delivery_thread_id.to_string();
    match event_type {
        "session.resolved" => event
            .get("sessionId")
            .and_then(Value::as_str)
            .map(|session_id| {
                AdaptedEvent::Chunk(AgentChunk::SessionResolved {
                    thread_id,
                    session_id: session_id.to_string(),
                })
            })
            .unwrap_or(AdaptedEvent::Ignore),
        "assistant.delta" => text_chunk(event, thread_id, false),
        "reasoning.delta" => text_chunk(event, thread_id, true),
        "tool.started" => {
            let Some(id) = event.get("id").and_then(Value::as_str) else {
                return AdaptedEvent::Ignore;
            };
            let name = event.get("name").and_then(Value::as_str).unwrap_or("tool");
            AdaptedEvent::Chunk(AgentChunk::ToolCall {
                thread_id,
                id: id.to_string(),
                name: name.to_string(),
                input: event.get("input").cloned().unwrap_or_else(|| json!({})),
            })
        }
        "tool.completed" => {
            let Some(id) = event.get("id").and_then(Value::as_str) else {
                return AdaptedEvent::Ignore;
            };
            let name = event.get("name").and_then(Value::as_str).unwrap_or("tool");
            AdaptedEvent::Chunk(AgentChunk::ToolResult {
                thread_id,
                id: id.to_string(),
                name: name.to_string(),
                result: event.get("result").cloned().unwrap_or(Value::Null),
            })
        }
        "usage" => {
            let input = u32_field(event, "inputTokens");
            let cache_read = u32_field(event, "cacheReadTokens");
            let cache_write = u32_field(event, "cacheWriteTokens");
            let cached = match (cache_read, cache_write) {
                (None, None) => None,
                // `cached_input_tokens` is the cache-hit/read portion. Cache
                // writes are not hits and must not be presented as such.
                (read, _) => read,
            };
            let output = u32_field(event, "outputTokens");
            let reasoning = u32_field(event, "reasoningTokens");
            AdaptedEvent::Chunk(AgentChunk::Usage {
                thread_id,
                model_id: event
                    .get("modelId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_string),
                last_run_at: Some(chrono::Utc::now().timestamp_millis()),
                usage: Some(UsageInfo {
                    input_tokens: input,
                    cached_input_tokens: cached,
                    output_tokens: output,
                    reasoning_output_tokens: reasoning,
                    total_tokens: Some(
                        input
                            .unwrap_or(0)
                            .saturating_add(cache_read.unwrap_or(0))
                            .saturating_add(cache_write.unwrap_or(0))
                            .saturating_add(output.unwrap_or(0)),
                    ),
                    model_context_window: u32_field(event, "contextWindow"),
                    context_used_tokens: u32_field(event, "contextTokens"),
                }),
                status_info: None,
            })
        }
        "run.error" => AdaptedEvent::Chunk(AgentChunk::Error {
            thread_id,
            message: visible_error_message(event),
            error_details: Some(crate::agent_external::classify_agent_error(
                &visible_error_message(event),
                "protocol",
            )),
        }),
        "run.completed" => AdaptedEvent::Completed(
            event
                .get("reason")
                .and_then(Value::as_str)
                .map(str::to_string),
        ),
        _ => AdaptedEvent::Ignore,
    }
}

fn app_server_content_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        Some(value) => value
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        None => String::new(),
    }
}

fn text_chunk_value(text: &str, thread_id: String, reasoning: bool) -> AdaptedEvent {
    if reasoning {
        AdaptedEvent::Chunk(AgentChunk::Reasoning {
            thread_id,
            text: text.to_string(),
        })
    } else {
        AdaptedEvent::Chunk(AgentChunk::Text {
            thread_id,
            text: text.to_string(),
        })
    }
}

fn visible_error_message(event: &Value) -> String {
    let message = event
        .get("message")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("DeepSeek Harness run failed");
    let code = event
        .get("code")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    match code {
        Some(code) => format!("[{code}] {message}"),
        None => message.to_string(),
    }
}

fn text_chunk(event: &Value, thread_id: String, reasoning: bool) -> AdaptedEvent {
    let Some(text) = event.get("text").and_then(Value::as_str) else {
        return AdaptedEvent::Ignore;
    };
    if reasoning {
        AdaptedEvent::Chunk(AgentChunk::Reasoning {
            thread_id,
            text: text.to_string(),
        })
    } else {
        AdaptedEvent::Chunk(AgentChunk::Text {
            thread_id,
            text: text.to_string(),
        })
    }
}

fn u32_field(value: &Value, key: &str) -> Option<u32> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::DeepSeekHarnessProviderSettings;

    #[test]
    fn model_discovery_uses_llm_base_url_wire_name() {
        let request = model_discover_request(
            7,
            Some("acme-gateway"),
            "https://gateway.example/v1",
            "openai-completions",
            Some("probe-key"),
        );
        assert_eq!(request["params"]["baseURL"], "https://gateway.example/v1");
        assert!(request["params"].get("baseUrl").is_none());
        assert_eq!(request["params"]["provider"], "acme-gateway");
        assert_eq!(request["params"]["api"], "openai-completions");
        assert_eq!(request["params"]["apiKey"], "probe-key");
        assert!(request["params"].get("apiKeyEnv").is_none());
    }

    #[test]
    fn model_settings_upsert_keeps_profile_under_expected_route() {
        let profile = DeepSeekHarnessProviderSettings::default();
        let request = model_settings_upsert_request(8, "acme-gateway", &profile, 3);
        assert_eq!(request["method"], "model/config/upsert");
        assert_eq!(request["params"]["route"], "acme-gateway");
        assert_eq!(request["params"]["expectedRevision"], 3);
    }

    #[test]
    fn maps_host_delta_to_agent_chunk() {
        let event = json!({
            "method": "run.event",
            "params": { "event": { "type": "assistant.delta", "text": "hello" } }
        });
        assert!(matches!(
            adapt_event(&event, "thread-1"),
            AdaptedEvent::Chunk(AgentChunk::Text { text, .. }) if text == "hello"
        ));
    }

    #[test]
    fn relays_completed_app_server_user_item_with_turn_identity() {
        let event = json!({
            "method": "item/completed",
            "params": {
                "threadId": "dsh-session",
                "turnId": "turn-2",
                "item": {
                    "id": "user-item-2",
                    "type": "userMessage",
                    "content": [{ "type": "text", "text": "second prompt" }]
                }
            }
        });
        let AdaptedEvent::ChunkWithMetadata(AgentChunk::UserMessage { id, text, .. }, metadata) =
            adapt_event(&event, "thread-1")
        else {
            panic!("expected a provider user item");
        };
        assert_eq!(id, "user-item-2");
        assert_eq!(text, "second prompt");
        assert_eq!(metadata.message_id.as_deref(), Some("user-item-2"));
        assert_eq!(metadata.codex_turn_id.as_deref(), Some("turn-2"));
        assert_eq!(metadata.message_phase, Some("completed"));
        assert_eq!(metadata.content_mode, Some("snapshot"));
    }

    #[test]
    fn relays_dsh_goal_message_type_as_metadata() {
        let event = json!({
            "method": "item/completed",
            "params": {
                "threadId": "dsh-session",
                "turnId": "turn-2",
                "item": {
                    "id": "goal-round-1",
                    "type": "userMessage",
                    "messageType": "goal-round",
                    "text": "目标执行中：在吗（第 1/256 轮）"
                }
            }
        });
        let AdaptedEvent::ChunkWithMetadata(_, metadata) = adapt_event(&event, "thread-1") else {
            panic!("expected a provider goal item");
        };
        assert_eq!(metadata.message_type, Some("goal-round"));
    }

    #[test]
    fn relays_completed_app_server_agent_item_as_snapshot() {
        let event = json!({
            "method": "item/completed",
            "params": {
                "threadId": "dsh-session",
                "turnId": "turn-2",
                "item": {
                    "id": "assistant-item-2",
                    "type": "agentMessage",
                    "content": [{ "type": "text", "text": "你好！有什么可以帮你的吗？" }]
                }
            }
        });
        let AdaptedEvent::ChunkWithMetadata(AgentChunk::Text { text, .. }, metadata) =
            adapt_event(&event, "thread-1")
        else {
            panic!("expected a provider assistant snapshot");
        };
        assert_eq!(text, "你好！有什么可以帮你的吗？");
        assert_eq!(metadata.message_id.as_deref(), Some("assistant-item-2"));
        assert_eq!(
            metadata.source_message_id.as_deref(),
            Some("assistant-item-2")
        );
        assert_eq!(metadata.message_phase, Some("completed"));
        assert_eq!(metadata.content_mode, Some("snapshot"));
    }

    #[test]
    fn maps_app_server_text_delta_with_stable_item_metadata() {
        let event = json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "dsh-session",
                "turnId": "dsh-session-turn-2",
                "itemId": "dsh-session-assistant-stream-attempt-1",
                "sourceSubsequence": 7,
                "delta": "hello"
            }
        });
        let AdaptedEvent::ChunkWithMetadata(AgentChunk::Text { text, .. }, metadata) =
            adapt_event(&event, "thread-1")
        else {
            panic!("expected an assistant text delta");
        };
        assert_eq!(text, "hello");
        assert_eq!(
            metadata.message_id.as_deref(),
            Some("dsh-session-assistant-stream-attempt-1")
        );
        assert_eq!(
            metadata.source_message_id.as_deref(),
            Some("dsh-session-assistant-stream-attempt-1")
        );
        assert_eq!(
            metadata.codex_turn_id.as_deref(),
            Some("dsh-session-turn-2")
        );
        assert_eq!(metadata.message_phase, Some("updated"));
        assert_eq!(metadata.content_mode, Some("delta"));
        assert_eq!(metadata.source_subsequence, Some(7));
    }

    #[test]
    fn splits_think_tags_even_when_they_cross_text_deltas() {
        let mut parser = ThinkingTagParser::new();
        let mut segments = parser.push("<thi");
        segments.extend(parser.push("nk>think").into_iter());
        segments.extend(parser.push("ing</think>answer").into_iter());
        segments.extend(parser.finish());

        assert_eq!(
            segments,
            vec![
                ThinkingSegment::Reasoning("think".to_string()),
                ThinkingSegment::Reasoning("ing".to_string()),
                ThinkingSegment::Text("answer".to_string()),
            ]
        );
    }

    #[test]
    fn keeps_unclosed_think_content_as_reasoning() {
        let mut parser = ThinkingTagParser::new();
        assert_eq!(
            parser.push("<think>still thinking"),
            vec![ThinkingSegment::Reasoning("still thinking".to_string())]
        );
        assert_eq!(parser.finish(), Vec::<ThinkingSegment>::new());
    }

    #[test]
    fn maps_host_usage_to_flowix_usage() {
        let event = json!({
            "method": "run.event",
            "params": { "event": { "type": "usage", "modelId": "deepseek-chat", "inputTokens": 2, "cacheReadTokens": 3, "cacheWriteTokens": 4, "contextTokens": 1200, "contextWindow": 4000, "outputTokens": 5 } }
        });
        assert!(matches!(
            adapt_event(&event, "thread-1"),
            AdaptedEvent::Chunk(AgentChunk::Usage {
                usage: Some(UsageInfo {
                    cached_input_tokens: Some(3),
                    total_tokens: Some(14),
                    context_used_tokens: Some(1200),
                    model_context_window: Some(4000),
                    ..
                }),
                model_id: Some(model_id),
                ..
            }) if model_id == "deepseek-chat"
        ));
    }

    #[test]
    fn keeps_run_error_code_visible_to_the_user() {
        let event = json!({
            "method": "run.event",
            "params": {
                "event": {
                    "type": "run.error",
                    "message": "Request timed out.",
                    "code": "TIMEOUT"
                }
            }
        });
        assert!(matches!(
            adapt_event(&event, "thread-1"),
            AdaptedEvent::Chunk(AgentChunk::Error { message, .. })
                if message == "[TIMEOUT] Request timed out."
        ));
    }

    #[test]
    fn builds_a_bounded_session_history_request() {
        let request = app_session_history_request(9, "session-1", Some(42), Some(100), 500);
        assert_eq!(
            request.get("method").and_then(Value::as_str),
            Some("session/history")
        );
        assert_eq!(
            request.pointer("/params/sessionId").and_then(Value::as_str),
            Some("session-1")
        );
        assert_eq!(
            request
                .pointer("/params/beforeSequence")
                .and_then(Value::as_i64),
            Some(42)
        );
        assert_eq!(
            request
                .pointer("/params/snapshotSequence")
                .and_then(Value::as_i64),
            Some(100)
        );
        assert_eq!(
            request.pointer("/params/limit").and_then(Value::as_i64),
            Some(50)
        );
    }

    #[test]
    fn builds_app_server_history_and_usage_methods() {
        assert_eq!(
            app_session_history_request(1, "session-1", None, None, 10)
                .get("method")
                .and_then(Value::as_str),
            Some("session/history")
        );
        assert_eq!(
            app_session_usage_request(2, "session-1")
                .get("method")
                .and_then(Value::as_str),
            Some("flowix/session/usage")
        );
        assert_eq!(
            app_runtime_dispose_request(3, "thread-1")["method"],
            "thread/close"
        );
        assert_eq!(
            app_thread_archive_request(4, "session-1")["method"],
            "thread/archive"
        );
    }

    #[test]
    fn builds_direct_app_server_requests() {
        let initialize = app_initialize_request(1, "1.2.3");
        assert_eq!(initialize["method"], "initialize");
        assert_eq!(
            initialize
                .pointer("/params/clientInfo/name")
                .and_then(Value::as_str),
            Some("flowix-desktop")
        );

        let start = app_thread_start_request(
            2,
            "thread-1",
            "/tmp",
            &["/tmp".to_string()],
            "deepseek",
            "deepseek-chat",
            "standard",
            "read-only",
        );
        assert_eq!(start["method"], "thread/start");
        assert_eq!(start.pointer("/params/threadId"), None);
        assert_eq!(
            start
                .pointer("/params/flowixThreadId")
                .and_then(Value::as_str),
            Some("thread-1")
        );
        assert_eq!(
            start.pointer("/params/provider").and_then(Value::as_str),
            Some("deepseek")
        );

        let turn = app_turn_start_request(3, "thread-1", "hello");
        assert_eq!(turn["method"], "turn/start");
        assert_eq!(
            turn.pointer("/params/input").and_then(Value::as_str),
            Some("hello")
        );

        let interrupt = app_turn_interrupt_request(4, "thread-1");
        assert_eq!(interrupt["method"], "turn/interrupt");
    }

    #[test]
    fn routes_direct_app_server_notifications_by_thread() {
        let event = json!({
            "jsonrpc": "2.0",
            "method": "item/agentMessage/delta",
            "params": { "threadId": "thread-9", "delta": "hi" }
        });
        assert_eq!(app_server_event_route(&event).as_deref(), Some("thread-9"));

        let goal_change = json!({
            "jsonrpc": "2.0",
            "method": "goal/changed",
            "params": { "threadId": "thread-9", "sourceSeq": 12, "change": { "operation": "complete" } }
        });
        assert_eq!(
            app_server_event_route(&goal_change).as_deref(),
            Some("thread-9")
        );

        let unrelated = json!({ "jsonrpc": "2.0", "method": "server/ping", "params": {} });
        assert!(app_server_event_route(&unrelated).is_none());
    }
}
