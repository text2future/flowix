//! Conversion of persisted Codex threads and items into Flowix history.
use super::*;

pub(super) fn app_server_thread_info(thread: &Value) -> Option<ThreadInfo> {
    let thread_id = thread.get("id")?.as_str()?.trim();
    if thread_id.is_empty() {
        return None;
    }
    let created_at = app_server_timestamp_millis(thread.get("createdAt").and_then(Value::as_i64));
    let updated_at = app_server_timestamp_millis(
        thread
            .get("updatedAt")
            .or_else(|| thread.get("recencyAt"))
            .and_then(Value::as_i64),
    )
    .max(created_at);
    Some(ThreadInfo {
        thread_id: thread_id.to_string(),
        agent_id: AgentId::new(AGENT_TYPE),
        title: thread
            .get("name")
            .or_else(|| thread.get("preview"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .unwrap_or("Codex Session")
            .to_string(),
        created_at,
        updated_at,
    })
}

pub(super) fn app_server_turn_messages(turns: &[Value]) -> Vec<ChatMessage> {
    app_server_turn_messages_with_offset(turns, 0)
}

pub(super) fn app_server_turn_messages_with_offset(
    turns: &[Value],
    turn_index_offset: usize,
) -> Vec<ChatMessage> {
    let mut messages = Vec::new();
    for (turn_offset, turn) in turns.iter().enumerate() {
        let turn_index = turn_index_offset + turn_offset;
        let turn_id = turn.get("id").and_then(Value::as_str).map(str::to_string);
        let turn_duration_ms = app_server_turn_duration_ms(turn);
        let turn_message_start = messages.len();
        let timestamp = app_server_timestamp_string(
            turn.get("startedAt")
                .or_else(|| turn.get("createdAt"))
                .and_then(Value::as_i64),
        );
        if let Some(objective) = initial_goal_objective(turn) {
            messages.push(app_server_goal_command_message(
                &objective,
                &timestamp,
                turn_index,
                turn_id.as_deref(),
            ));
        }
        let is_manual_compact_turn = is_manual_compact_turn(turn);
        let mut compact_command_emitted = false;
        for (item_index, item) in turn
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            if is_manual_compact_turn
                && !compact_command_emitted
                && item.get("type").and_then(Value::as_str) == Some("contextCompaction")
            {
                messages.push(app_server_compact_command_message(
                    item,
                    &timestamp,
                    turn_index,
                    item_index,
                    turn_id.as_deref(),
                ));
                compact_command_emitted = true;
            }
            if let Some(mut message) = app_server_item_message(
                item,
                &timestamp,
                turn_index,
                item_index,
                turn_id.as_deref(),
            ) {
                if matches!(message.role.as_str(), "assistant" | "reasoning") {
                    let item_terminal = item.get("status").and_then(Value::as_str)
                        .is_some_and(is_terminal_native_status);
                    let turn_terminal = turn.get("status").and_then(Value::as_str)
                        .is_some_and(is_terminal_native_status);
                    message.is_completed = Some(item_terminal || turn_terminal);
                }
                messages.push(message);
            }
        }
        if let Some(message) = app_server_turn_error_message(turn, &timestamp, turn_index) {
            messages.push(message);
        }
        if let Some(duration_ms) = turn_duration_ms {
            if let Some(message) = messages[turn_message_start..]
                .iter_mut()
                .rev()
                .find(|message| message.role == "assistant")
            {
                message.turn_duration_ms = Some(duration_ms);
            }
        }
    }
    messages
}

fn is_terminal_native_status(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "interrupted" | "cancelled")
}

/// A manual `/compact` is represented by Codex as a standalone turn whose
/// only persisted item is `contextCompaction` (some versions also echo a
/// `/compact` userMessage). Automatic compaction is emitted inside a normal
/// model turn, alongside ordinary user/assistant/tool items, and must remain
/// a system-only timeline marker.
pub(super) fn is_manual_compact_turn(turn: &Value) -> bool {
    let Some(items) = turn.get("items").and_then(Value::as_array) else {
        return false;
    };
    let mut has_context_compaction = false;
    for item in items {
        match item.get("type").and_then(Value::as_str) {
            Some("contextCompaction") => has_context_compaction = true,
            Some("userMessage") => {
                let text = app_server_content_text(item.get("content"));
                if !is_codex_compact_command(&text) {
                    return false;
                }
            }
            _ => return false,
        }
    }
    has_context_compaction
}

pub(super) fn app_server_compact_command_message(
    item: &Value,
    timestamp: &str,
    turn_index: usize,
    item_index: usize,
    turn_id: Option<&str>,
) -> ChatMessage {
    let source_id = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .or(turn_id)
        .map(str::to_string)
        .unwrap_or_else(|| format!("turn-{turn_index}-item-{item_index}"));
    let mut message =
        app_server_base_message(format!("codex-command-history-{source_id}"), timestamp);
    message.role = "user".to_string();
    message.message_type = Some(CODEX_COMMAND_MESSAGE_TYPE.to_string());
    message.content = "/compact".to_string();
    message.is_completed = Some(true);
    message.codex_turn_id = turn_id.map(str::to_string);
    message
}

pub(super) fn app_server_goal_command_message(
    objective: &str,
    timestamp: &str,
    turn_index: usize,
    turn_id: Option<&str>,
) -> ChatMessage {
    let source_id = turn_id
        .map(str::to_string)
        .unwrap_or_else(|| format!("turn-{turn_index}"));
    let mut message =
        app_server_base_message(format!("codex-command-history-goal-{source_id}"), timestamp);
    message.role = "user".to_string();
    message.message_type = Some(CODEX_COMMAND_MESSAGE_TYPE.to_string());
    message.content = format!("/goal {objective}");
    message.is_completed = Some(true);
    message.codex_turn_id = turn_id.map(str::to_string);
    message
}

pub(super) fn app_server_turn_duration_ms(turn: &Value) -> Option<u64> {
    turn.get("durationMs").and_then(Value::as_u64)
}

pub(super) fn app_server_turn_error_message(
    turn: &Value,
    timestamp: &str,
    turn_index: usize,
) -> Option<ChatMessage> {
    let status = turn
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let error = turn.get("error");
    let error_text = error.and_then(|value| {
        value
            .as_str()
            .or_else(|| value.get("message").and_then(Value::as_str))
    });
    let text = match (status, error_text) {
        ("failed", Some(message)) | ("interrupted", Some(message)) => message.to_string(),
        ("failed", None) => "Codex turn failed".to_string(),
        ("interrupted", None) => "Codex turn interrupted".to_string(),
        _ => return None,
    };
    let id = turn
        .get("id")
        .and_then(Value::as_str)
        .map(|id| format!("codex-turn-error-{id}"))
        .unwrap_or_else(|| format!("codex-turn-error-{turn_index}"));
    let mut message = app_server_base_message(id, timestamp);
    message.role = "assistant".to_string();
    message.content = text.clone();
    message.is_completed = Some(true);
    message.error_details = Some(crate::agent_external::classify_agent_error(
        &text,
        "app-server",
    ));
    Some(message)
}

pub(super) fn app_server_item_message(
    item: &Value,
    timestamp: &str,
    turn_index: usize,
    item_index: usize,
    turn_id: Option<&str>,
) -> Option<ChatMessage> {
    let kind = item.get("type")?.as_str()?;
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("codex-{turn_index}-{item_index}"));
    let mut message = app_server_base_message(id, timestamp);
    message.codex_turn_id = turn_id.map(str::to_string);
    message.message_type = codex_message_type(item).map(str::to_string);
    match kind {
        "userMessage" => {
            message.role = "user".to_string();
            message.attachments = Some(app_server_image_attachments(item.get("content")))
                .filter(|attachments| !attachments.is_empty());
            message.content = visible_user_text(&app_server_content_text(item.get("content")));
            if is_codex_native_command_text(&message.content)
                || is_codex_goal_internal_context(&message.content)
            {
                return None;
            }
        }
        "agentMessage" => {
            message.role = "assistant".to_string();
            message.content = item
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
        }
        "reasoning" => {
            let content = app_server_content_text(item.get("summary"));
            message.role = "reasoning".to_string();
            message.content = if content.is_empty() {
                app_server_content_text(item.get("content"))
            } else {
                content
            };
            if !has_visible_text(&message.content) {
                return None;
            }
            message.reasoning = Some(message.content.clone());
        }
        "contextCompaction" => {
            message.role = "system".to_string();
            message.message_type = Some(CONTEXT_COMPACTION_MESSAGE_TYPE.to_string());
        }
        "commandExecution"
        | "fileChange"
        | "mcpToolCall"
        | "dynamicToolCall"
        | "collabToolCall"
        | "collabAgentToolCall"
        | "webSearch"
        | "imageView"
        | "imageGeneration" => {
            message.role = "tool".to_string();
            message.tool_call_id = item.get("id").and_then(Value::as_str).map(str::to_string);
            message.tool_name = Some(app_server_tool_name(kind, item));
            message.tool_input = Some(item.clone());
            message.tool_data = serde_json::to_string(item).ok();
            message.content = app_server_tool_content(kind, item);
            message.is_completed = item
                .get("status")
                .and_then(Value::as_str)
                .map(|status| status != "inProgress");
        }
        _ => return None,
    }
    Some(message)
}

pub(super) fn has_visible_text(text: &str) -> bool {
    !text.trim().is_empty()
}

pub(super) fn app_server_base_message(id: String, timestamp: &str) -> ChatMessage {
    ChatMessage {
        id,
        role: String::new(),
        message_type: None,
        content: String::new(),
        llm_content: None,
        system_reminder_directory: None,
        timestamp: timestamp.to_string(),
        is_loading: None,
        tool_call_id: None,
        tool_name: None,
        tool_data: None,
        tool_input: None,
        tool_call: None,
        tool_result: None,
        tool_calls: None,
        reasoning: None,
        is_completed: None,
        error_details: None,
        is_collapsed: None,
        codex_turn_id: None,
        turn_duration_ms: None,
        source_sequence: None,
        attachments: None,
    }
}

pub(super) fn app_server_image_attachments(value: Option<&Value>) -> Vec<AgentMessageAttachment> {
    let Some(parts) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    parts
        .iter()
        .enumerate()
        .filter_map(|(index, part)| {
            let kind = part.get("type").and_then(Value::as_str)?;
            if kind != "localImage" && kind != "image" && kind != "input_image" {
                return None;
            }
            let path = part
                .get("path")
                .or_else(|| part.get("uri"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let name = part
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .or_else(|| {
                    std::path::Path::new(&path)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| format!("image-{}", index + 1));
            let mime_type = part
                .get("mimeType")
                .or_else(|| part.get("mediaType"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| {
                    match std::path::Path::new(&path)
                        .extension()
                        .and_then(|ext| ext.to_str())
                        .map(str::to_ascii_lowercase)
                        .as_deref()
                    {
                        Some("jpg" | "jpeg") => "image/jpeg",
                        Some("webp") => "image/webp",
                        Some("gif") => "image/gif",
                        _ => "image/png",
                    }
                    .to_string()
                });
            Some(AgentMessageAttachment {
                r#type: "input_image".to_string(),
                path,
                name,
                mime_type,
                detail: Some(
                    part.get("detail")
                        .and_then(Value::as_str)
                        .unwrap_or("high")
                        .to_string(),
                ),
            })
        })
        .collect()
}

pub(super) fn codex_message_type(item: &Value) -> Option<&'static str> {
    (item.get("phase").and_then(Value::as_str) == Some("commentary"))
        .then_some(CODEX_COMMENTARY_MESSAGE_TYPE)
}

pub(super) fn visible_user_text(content: &str) -> String {
    const MARKERS: [&str; 2] = ["<## context prompt ##>", "[flowix workspace context]"];
    let normalized = content.to_ascii_lowercase();
    let end = MARKERS
        .iter()
        .filter_map(|marker| normalized.find(marker))
        .min()
        .unwrap_or(content.len());
    content[..end].trim_end().to_string()
}

pub(super) fn app_server_content_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.to_string(),
        Some(Value::Object(object)) => object
            .get("text")
            .or_else(|| object.get("content"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| match part {
                Value::String(text) => Some(text.as_str()),
                _ => part
                    .get("text")
                    .or_else(|| part.get("content"))
                    .and_then(Value::as_str),
            })
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

pub(super) fn app_server_tool_name(kind: &str, _item: &Value) -> String {
    // Keep history projection in lockstep with `tool_identity`, which is used
    // by live item/* notifications. The command itself is input data, not the
    // tool name: using `/bin/zsh -lc pwd` here makes history choose a different
    // formatter from the live `command_execution` row.
    canonical_codex_tool_name(kind).unwrap_or(kind).to_string()
}

pub(super) fn app_server_tool_content(kind: &str, item: &Value) -> String {
    match kind {
        "commandExecution" => item
            .get("aggregatedOutput")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        "mcpToolCall"
        | "dynamicToolCall"
        | "collabToolCall"
        | "collabAgentToolCall"
        | "imageView" => item
            .get("result")
            .map(Value::to_string)
            .or_else(|| item.get("error").map(Value::to_string))
            .unwrap_or_default(),
        "imageGeneration" => {
            let status = item
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let failure = item
                .get("failure")
                .filter(|value| is_nonempty_tool_error(value))
                .or_else(|| {
                    item.get("error")
                        .filter(|value| is_nonempty_tool_error(value))
                });
            if let Some(failure) = failure {
                let reason = failure
                    .as_str()
                    .filter(|reason| !reason.trim().is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| failure.to_string());
                format!("[error] {reason}")
            } else if matches!(status, "failed" | "failure" | "error") {
                "[error] Image generation failed".to_string()
            } else {
                item.get("result").map(Value::to_string).unwrap_or_default()
            }
        }
        _ => item
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or(kind)
            .to_string(),
    }
}

fn is_nonempty_tool_error(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(message) => !message.trim().is_empty(),
        Value::Array(values) => !values.is_empty(),
        Value::Object(fields) => !fields.is_empty(),
        _ => true,
    }
}

pub(super) fn app_server_timestamp_millis(value: Option<i64>) -> i64 {
    let value = value.unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    if value.unsigned_abs() < 10_000_000_000 {
        value.saturating_mul(1000)
    } else {
        value
    }
}

pub(super) fn app_server_timestamp_string(value: Option<i64>) -> String {
    let millis = app_server_timestamp_millis(value);
    chrono::DateTime::from_timestamp_millis(millis)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}

pub(super) fn paginate_app_server_turns(
    turns: &[Value],
    before_sequence: Option<i64>,
    snapshot_sequence: Option<i64>,
    limit: i64,
) -> ThreadMessagesPage {
    let limit = limit.clamp(1, 1000) as usize;
    // A page cursor represents a turn boundary, never a flattened message
    // offset. This keeps user/reasoning/tool/final rows from one turn atomic.
    // snapshot_sequence pins later pages to the turn count seen by page one;
    // newly appended turns cannot shift an older-page cursor.
    let snapshot_end = snapshot_sequence
        .map(|sequence| sequence.max(0) as usize)
        .unwrap_or(turns.len())
        .min(turns.len());
    let end = before_sequence
        .map(|sequence| sequence.max(0) as usize)
        .unwrap_or(snapshot_end)
        .min(snapshot_end);
    let start = end.saturating_sub(limit);
    let complete_turn_ids = turns[start..end].iter().filter_map(|turn| {
        let status = turn.get("status").and_then(Value::as_str)?;
        if !is_terminal_native_status(status) { return None; }
        turn.get("id").and_then(Value::as_str).map(str::to_string)
    }).collect();
    ThreadMessagesPage {
        messages: app_server_turn_messages(&turns[start..end]),
        oldest_sequence: (start > 0).then_some(start as i64),
        has_more: start > 0,
        snapshot_sequence: Some(snapshot_end as i64),
        complete_turn_ids: Some(complete_turn_ids),
    }
}
