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

/// OpenAI provider 鍐呴儴娴佷簨浠?鈥?鎺ㄧ悊妯″瀷鐨?`reasoning_content` 涓庢櫘閫?`content`
/// 鍒嗗紑琛ㄨ揪, 閬垮厤鍐嶈蛋 "鍦?content 閲屽 `[REASONING]:` 鍓嶇紑" 鐨勫瓧绗︿覆鍗忚銆?/// rllm 鐨?`StreamChunk` 鍙兘 `Text(String)` 琛ㄨ揪鏂囨湰, 娌℃硶鍖哄垎涓ょ被鏂囨湰,
/// 鎵€浠ヨ繖閲屽紩鍏ヨ嚜宸辩殑 enum 鈹€鈹€ agent.rs 鐩存帴娑堣垂杩欏銆倀rait 璺緞鐨?/// `chat_stream_with_tools` 宸插簾寮?(unimplemented!); 璇ヨ矾寰勭殑 reasoning
/// 鍖呰 (`[REASONING]:` 鍓嶇紑鍥炲～) 璺熺潃鍒犳帀, 閬垮厤璇銆?
#[derive(Debug, Clone)]
pub enum OpenAICompatibleStreamItem {
    /// 鍔╂墜娴佸紡鍥炵瓟 (鏅€?content)
    Text(String),
    /// 鎺ㄧ悊妯″瀷鐨勬€濊€冭繃绋?(reasoning_content)
    Reasoning(String),
    /// LLM 鍙戝嚭宸ュ叿璋冪敤, 宸茶仛鍚堝畬 (id/call_type/function{name,arguments} 榻愬叏)
    ToolUseComplete { tool_call: LlmToolCall },
    /// 娴佹湯灏剧殑 token 璁℃暟 (OpenAI 鍗忚鍦ㄦ渶鍚庝竴涓?SSE chunk 鐨勯《灞?`usage` 瀛楁
    /// 鍗曠嫭閫? 涓嶆贩鍦?`choices` 閲?銆俙total_tokens` 鑷韩鏄?None 鏃舵暣鏉?Usage 涓?emit銆?    ///
    /// Compatibility: 鏃?provider 鍙姤 `prompt_tokens` / `completion_tokens`
    /// 鏃? SSE 瑙ｆ瀽灞備細 fallback 鍒?input/output;杩欓噷鍙壙杞芥柊鍗忚瀛楁,
    /// wire 褰㈢姸涓嶅啀閫忎紶 prompt/completion銆?
    Usage {
        total_tokens: u32,
        input_tokens: Option<u32>,
        cached_input_tokens: Option<u32>,
        output_tokens: Option<u32>,
        reasoning_output_tokens: Option<u32>,
        model_context_window: Option<u32>,
    },
    /// 娴佺粨鏉?(OpenAI `[DONE]` 鎴栨祦鑷劧鏂?
    Done {
        #[allow(dead_code)]
        stop_reason: String,
    },
}
