use std::collections::BTreeMap;

use rllm::{FunctionCall as LlmFunctionCall, ToolCall as LlmToolCall};

use super::types::ApiStreamToolCall;

#[derive(Default)]
pub(super) struct PendingToolCall {
    id: String,
    call_type: String,
    name: String,
    arguments: String,
}

/// In-flight tool calls within one assistant turn, keyed by the LLM-assigned
/// `index` on each `tool_calls` delta. BTreeMap (not HashMap) gives
/// deterministic ascending-order iteration when we flush at
/// `finish_reason == "tool_calls"` and at end-of-stream. The number of
/// parallel tool calls in a single turn is small (typically <= 4), so the
/// BTreeMap overhead is negligible.
pub(super) type PendingToolCalls = BTreeMap<usize, PendingToolCall>;

pub(super) fn merge_tool_call_delta(pending: &mut PendingToolCalls, calls: Vec<ApiStreamToolCall>) {
    for tc in calls {
        let idx = tc.index.unwrap_or(0);
        let entry = pending.entry(idx).or_default();
        if let Some(id) = tc.id {
            if !id.is_empty() {
                entry.id = id;
            }
        }
        if let Some(call_type) = tc.call_type {
            if !call_type.is_empty() {
                entry.call_type = call_type;
            }
        }
        if let Some(function) = tc.function {
            if let Some(name) = function.name {
                if !name.is_empty() {
                    entry.name = name;
                }
            }
            if let Some(arguments) = function.arguments {
                entry.arguments.push_str(&arguments);
            }
        }
    }
}

/// Drain all in-flight buckets into a sorted list of `LlmToolCall`s.
/// Half-formed buckets (empty `name`) are skipped. Used at both
/// `finish_reason == "tool_calls"` and at end-of-stream; the caller's
/// choice to wrap each result in `OpenAICompatibleStreamItem::ToolUseComplete`
/// is the only thing that differs between the two sites.
pub(super) fn flush_pending_tool_calls(pending: &mut PendingToolCalls) -> Vec<LlmToolCall> {
    let drained: Vec<(usize, PendingToolCall)> = pending
        .iter_mut()
        .map(|(k, v)| (*k, std::mem::take(v)))
        .collect();
    let mut out = Vec::with_capacity(drained.len());
    for (idx, p) in drained {
        if p.name.is_empty() {
            tracing::debug!(
                "[OpenAI] skipping half-formed tool_call bucket at index {}",
                idx
            );
            continue;
        }
        out.push(LlmToolCall {
            id: if p.id.is_empty() {
                format!("call_{}_{}", idx, chrono::Utc::now().timestamp_millis())
            } else {
                p.id
            },
            call_type: if p.call_type.is_empty() {
                "function".to_string()
            } else {
                p.call_type
            },
            function: LlmFunctionCall {
                name: p.name,
                arguments: p.arguments,
            },
        });
    }
    pending.clear();
    out
}

/// OpenAI provider 内部流事件 — 推理模型的 `reasoning_content` 与普通 `content`
/// 分开表达, 避免再走 "在 content 里塞 `[REASONING]:` 前缀" 的字符串协议。
/// rllm 的 `StreamChunk` 只能 `Text(String)` 表达文本, 没法区分两类文本,
/// 所以这里引入自己的 enum ── agent.rs 直接消费这套。trait 路径的
/// `chat_stream_with_tools` 已废弃 (unimplemented!); 该路径的 reasoning
/// 包装 (`[REASONING]:` 前缀回填) 跟着删掉, 避免误导。
#[derive(Debug, Clone)]
pub enum OpenAICompatibleStreamItem {
    /// 助手流式回答 (普通 content)
    Text(String),
    /// 推理模型的思考过程 (reasoning_content)
    Reasoning(String),
    /// LLM 发出工具调用, 已聚合完 (id/call_type/function{name,arguments} 齐全)
    ToolUseComplete { tool_call: LlmToolCall },
    /// 流末尾的 token 计数 (OpenAI 协议在最后一个 SSE chunk 的顶层 `usage` 字段
    /// 单独送, 不混在 `choices` 里)。`total_tokens` 自身是 None 时整条 Usage 不 emit。
    ///
    /// Compatibility: 旧 provider 只报 `prompt_tokens` / `completion_tokens`
    /// 时, SSE 解析层会 fallback 到 input/output;这里只承载新协议字段,
    /// wire 形状不再透传 prompt/completion。
    Usage {
        total_tokens: u32,
        input_tokens: Option<u32>,
        cached_input_tokens: Option<u32>,
        output_tokens: Option<u32>,
        reasoning_output_tokens: Option<u32>,
        model_context_window: Option<u32>,
    },
    /// 流结束 (OpenAI `[DONE]` 或流自然断)
    Done {
        #[allow(dead_code)]
        stop_reason: String,
    },
}
