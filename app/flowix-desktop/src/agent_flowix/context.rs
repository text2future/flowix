use rllm::chat::{ChatRole, MessageType};
use rllm::{FunctionCall, ToolCall as LlmToolCall};

use crate::agent_flowix::providers::OpenAICompatibleChatMessage;
use crate::agent_session::ChatMessage as ThreadChatMessage;

pub(super) const LLM_CONTEXT_RECENT_MESSAGES: usize = 80;
const LLM_CONTEXT_TOKEN_BUDGET: u32 = 48_000;
const LLM_CONTEXT_SUMMARY_PREVIEW_CHARS: usize = 4_000;
const LLM_CONTEXT_SUMMARY_ITEM_CHARS: usize = 320;
pub(super) const SUB_AGENT_CHARS_PER_TOKEN_ESTIMATE: u32 = 4;

pub(super) fn estimate_tokens_from_chars(chars: usize) -> u32 {
    let chars = chars as u32;
    chars.div_ceil(SUB_AGENT_CHARS_PER_TOKEN_ESTIMATE)
}

pub(super) fn estimate_llm_message_tokens(messages: &[OpenAICompatibleChatMessage]) -> u32 {
    messages
        .iter()
        .map(|m| {
            let mut chars = m.content.chars().count();
            match &m.message_type {
                MessageType::ToolResult(results) | MessageType::ToolUse(results) => {
                    chars += results
                        .iter()
                        .map(|r| r.function.arguments.chars().count())
                        .sum::<usize>();
                }
                _ => {}
            }
            estimate_tokens_from_chars(chars)
        })
        .sum()
}

pub(super) fn truncate_for_sub_agent(content: &str, max_chars: usize) -> String {
    if content.chars().count() <= max_chars {
        return content.to_string();
    }
    let truncated: String = content.chars().take(max_chars).collect();
    format!("{truncated}\n\n[truncated: original result was longer than {max_chars} characters]")
}

/// 把持久化行转回 rllm 的 ChatMessage。返回 None 表示该行不进 LLM 上下文
/// (reasoning / system / 残缺 tool 等待)。
///
/// 转换规则:
/// - user → User, content = llm_content ?? content, Text
/// - assistant 带 tool_calls → Assistant, content, ToolUse(反序列化的 Vec<ToolCall>)
/// - assistant 不带 tool_calls → Assistant, content, Text
/// - tool 带 tool_data → User(content = tool_data), ToolResult(vec![ToolCall{ id, function{name: "tool_result", arguments: tool_data }}])
/// - tool 不带 tool_data → None (避免给 LLM 看空 tool result)
/// - reasoning / system / 其它 → None
///
/// 工具结果用 `role: User` 包一层是 rllm 的约定 (它的 ChatRole 只有 User/Assistant),
/// provider 看 MessageType 而不是 role 决定发什么, 跟 rllm 自带参考实现 (llm crate 的
/// `providers/openai_compatible.rs`) 一致。
fn persisted_to_llm(m: crate::agent_session::ChatMessage) -> Option<OpenAICompatibleChatMessage> {
    match m.role.as_str() {
        "user" => Some(OpenAICompatibleChatMessage {
            role: ChatRole::User,
            content: m.llm_content.unwrap_or(m.content),
            message_type: MessageType::Text,
            reasoning: None,
        }),
        "assistant" => {
            let reasoning = m.reasoning.filter(|value| !value.trim().is_empty());
            let message_type = match m.tool_calls {
                Some(serde_json::Value::Array(arr)) => {
                    let calls: Vec<LlmToolCall> = arr
                        .into_iter()
                        .filter_map(|v| serde_json::from_value::<LlmToolCall>(v).ok())
                        .collect();
                    if calls.is_empty() {
                        MessageType::Text
                    } else {
                        MessageType::ToolUse(calls)
                    }
                }
                Some(serde_json::Value::Null) | None => MessageType::Text,
                // tool_calls 形状不预期 (非数组) — 当作普通文本, 不喂垃圾给 LLM
                _ => MessageType::Text,
            };
            Some(OpenAICompatibleChatMessage {
                role: ChatRole::Assistant,
                content: m.content,
                message_type,
                reasoning,
            })
        }
        "tool" => {
            let data = m.tool_data?;
            let call_id = m.tool_call_id?;
            Some(OpenAICompatibleChatMessage {
                role: ChatRole::User,
                content: data.clone(),
                message_type: MessageType::ToolResult(vec![LlmToolCall {
                    id: call_id,
                    call_type: "function".to_string(),
                    function: FunctionCall {
                        name: "tool_result".to_string(),
                        arguments: data,
                    },
                }]),
                reasoning: None,
            })
        }
        _ => None, // reasoning / system / end / 其它
    }
}

fn is_tool_result_message(message: &OpenAICompatibleChatMessage) -> bool {
    matches!(message.message_type, MessageType::ToolResult(_))
}

fn compact_summary_line(content: &str, max_chars: usize) -> String {
    truncate_for_sub_agent(
        &content.split_whitespace().collect::<Vec<_>>().join(" "),
        max_chars,
    )
}

fn summarize_omitted_thread_messages(
    messages: &[ThreadChatMessage],
) -> Option<OpenAICompatibleChatMessage> {
    if messages.is_empty() {
        return None;
    }

    let mut user_count = 0usize;
    let mut assistant_count = 0usize;
    let mut tool_count = 0usize;
    let mut other_count = 0usize;
    let mut samples = Vec::new();

    for message in messages {
        match message.role.as_str() {
            "user" => user_count += 1,
            "assistant" => assistant_count += 1,
            "tool" => tool_count += 1,
            _ => other_count += 1,
        }
    }

    for message in messages
        .iter()
        .rev()
        .filter(|m| matches!(m.role.as_str(), "user" | "assistant" | "tool"))
        .take(8)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        let label = match message.role.as_str() {
            "tool" => message.tool_name.as_deref().unwrap_or("tool"),
            role => role,
        };
        let body = match message.role.as_str() {
            "user" => message.llm_content.as_deref().unwrap_or(&message.content),
            "assistant" => &message.content,
            "tool" => message.tool_data.as_deref().unwrap_or(&message.content),
            _ => &message.content,
        };
        if body.trim().is_empty() {
            continue;
        }
        samples.push(format!(
            "- {label}: {}",
            compact_summary_line(body, LLM_CONTEXT_SUMMARY_ITEM_CHARS)
        ));
    }

    let sample_text = if samples.is_empty() {
        "- no text preview available".to_string()
    } else {
        samples.join("\n")
    };
    let summary = format!(
        "Earlier conversation was compacted to keep the model context bounded.\n\
         Omitted persisted rows: {} (user: {user_count}, assistant: {assistant_count}, tool: {tool_count}, other: {other_count}).\n\
         Recent omitted excerpts:\n{sample_text}\n\
         Use this as background only; the following messages are the authoritative recent context.",
        messages.len()
    );

    Some(OpenAICompatibleChatMessage {
        role: ChatRole::User,
        content: truncate_for_sub_agent(&summary, LLM_CONTEXT_SUMMARY_PREVIEW_CHARS),
        message_type: MessageType::Text,
        reasoning: None,
    })
}

pub(super) fn build_llm_context_window(
    messages: Vec<ThreadChatMessage>,
) -> Vec<OpenAICompatibleChatMessage> {
    let llm_rows: Vec<(usize, OpenAICompatibleChatMessage)> = messages
        .iter()
        .cloned()
        .enumerate()
        .filter_map(|(idx, message)| persisted_to_llm(message).map(|llm| (idx, llm)))
        .collect();

    if llm_rows.is_empty() {
        return Vec::new();
    }

    let total_tokens = estimate_llm_message_tokens(
        &llm_rows
            .iter()
            .map(|(_, message)| message.clone())
            .collect::<Vec<_>>(),
    );
    if llm_rows.len() <= LLM_CONTEXT_RECENT_MESSAGES && total_tokens <= LLM_CONTEXT_TOKEN_BUDGET {
        return llm_rows.into_iter().map(|(_, message)| message).collect();
    }

    let mut start = llm_rows.len();
    let mut selected_tokens = 0u32;
    while start > 0 {
        let next = &llm_rows[start - 1].1;
        let next_tokens = estimate_llm_message_tokens(std::slice::from_ref(next));
        let selected_count = llm_rows.len() - start;
        if selected_count > 0
            && (selected_count >= LLM_CONTEXT_RECENT_MESSAGES
                || selected_tokens.saturating_add(next_tokens) > LLM_CONTEXT_TOKEN_BUDGET)
        {
            break;
        }
        start -= 1;
        selected_tokens = selected_tokens.saturating_add(next_tokens);
    }

    while start > 0 && is_tool_result_message(&llm_rows[start].1) {
        start -= 1;
    }

    let first_persisted_idx = llm_rows[start].0;
    let mut out = Vec::new();
    if let Some(summary) = summarize_omitted_thread_messages(&messages[..first_persisted_idx]) {
        out.push(summary);
    }
    out.extend(llm_rows.into_iter().skip(start).map(|(_, message)| message));
    out
}
