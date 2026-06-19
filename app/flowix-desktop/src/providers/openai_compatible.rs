//! OpenAI Chat Completions provider for rllm-compatible agent framework.
//!
//! This module provides a generic OpenAI-compatible provider that uses
//! the /v1/chat/completions endpoint, suitable for MiniMax, DeepSeek, and
//! other OpenAI-compatible APIs.

use async_trait::async_trait;
use futures::stream::Stream;
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use rllm::chat::{
    ChatMessage as LlmChatMessage, ChatProvider, ChatResponse, ChatRole, MessageType, StreamChunk,
};
use rllm::error::LLMError as RllmError;
use rllm::{FunctionCall as LlmFunctionCall, ToolCall as LlmToolCall};

#[derive(Default)]
struct PendingToolCall {
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
type PendingToolCalls = BTreeMap<usize, PendingToolCall>;

const DEFAULT_STREAM_WALLCLOCK_SECS: u64 = 10 * 60;
const DEFAULT_REQUEST_WALLCLOCK_SECS: u64 = 2 * 60;
const MAX_INITIAL_REQUEST_ATTEMPTS: usize = 3;

/// Apply one delta of `tool_calls` chunks to the in-flight map. Each call
/// is routed into the bucket for its `index` (defaulting to 0 if the
/// provider omits the field on a single-call response). Repeated deltas
/// for the same `index` accumulate `arguments` chunks; `id` / `call_type`
/// / `name` overwrite on each non-empty delta.
fn merge_tool_call_delta(pending: &mut PendingToolCalls, calls: Vec<ApiStreamToolCall>) {
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
fn flush_pending_tool_calls(pending: &mut PendingToolCalls) -> Vec<LlmToolCall> {
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
/// 所以这里引入自己的 enum ── agent.rs 直接消费这套, rllm trait 路径由
/// [`OpenAICompatibleProvider::chat_stream_with_tools`] 包装回 `StreamChunk` 保持兼容。
#[derive(Debug, Clone)]
pub enum OpenAICompatibleStreamItem {
    /// 助手流式回答 (普通 content)
    Text(String),
    /// 推理模型的思考过程 (reasoning_content)
    Reasoning(String),
    /// LLM 发出工具调用, 已聚合完 (id/call_type/function{name,arguments} 齐全)
    ToolUseComplete { tool_call: LlmToolCall },
    /// 流末尾的 token 计数 (OpenAI 协议在最后一个 SSE chunk 的顶层 `usage` 字段
    /// 单独送, 不混在 `choices` 里)。`prompt_tokens` / `completion_tokens` 为 None
    /// 表示网关未单独报告 (例如 stream_options.include_usage 未开) ── 这种情况
    /// 仍可凭 `total_tokens` 兜底。`total_tokens` 自身是 None 时整条 Usage 不 emit。
    ///
    /// `prompt_tokens` / `completion_tokens` 今天只透传不消费 (agent 只读
    /// `total_tokens` 做预算熔断) ── 留着是为将来 "显示本次对话用量" / 分项计费
    /// 提示铺路, 避免 wire 形状来回改。
    Usage {
        total_tokens: u32,
        #[allow(dead_code)]
        prompt_tokens: Option<u32>,
        #[allow(dead_code)]
        completion_tokens: Option<u32>,
    },
    /// 流结束 (OpenAI `[DONE]` 或流自然断)
    Done { stop_reason: String },
}

// ============================================================================
// OpenAI Provider Implementation (using rllm traits)
// ============================================================================

/// Configuration for the OpenAI-compatible provider.
#[derive(Debug, Clone)]
pub struct OpenAICompatibleConfig {
    pub api_key: String,
    pub model: String,
    pub base_url: String,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub system: Option<String>,
    pub timeout_seconds: Option<u64>,
    pub reasoning_split: Option<bool>,
}

impl OpenAICompatibleConfig {
    pub fn new(
        api_key: impl Into<String>,
        model: impl Into<String>,
        base_url: impl Into<String>,
    ) -> Self {
        Self {
            api_key: api_key.into(),
            model: model.into(),
            base_url: base_url.into(),
            max_tokens: None,
            temperature: None,
            system: None,
            timeout_seconds: None,
            reasoning_split: None,
        }
    }

    #[allow(dead_code)]
    pub fn with_max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = Some(max_tokens);
        self
    }

    #[allow(dead_code)]
    pub fn with_temperature(mut self, temperature: f32) -> Self {
        self.temperature = Some(temperature);
        self
    }

    pub fn with_system(mut self, system: impl Into<String>) -> Self {
        self.system = Some(system.into());
        self
    }

    #[allow(dead_code)]
    pub fn with_timeout(mut self, timeout_seconds: u64) -> Self {
        self.timeout_seconds = Some(timeout_seconds);
        self
    }

    pub fn with_reasoning_split(mut self, reasoning_split: bool) -> Self {
        self.reasoning_split = Some(reasoning_split);
        self
    }
}

/// OpenAI-compatible provider using /v1/chat/completions endpoint.
/// Implements rllm's ChatProvider trait for compatibility.
#[derive(Debug, Clone)]
pub struct OpenAICompatibleProvider {
    config: Arc<OpenAICompatibleConfig>,
    client: Client,
}

// Request/Response types for OpenAI Chat Completions API
#[derive(Serialize)]
struct ChatMessageReq {
    role: String,
    /// OpenAI 允许 assistant 在携带 tool_calls 时 content 为 null / 缺省。
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<LlmToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
}

#[derive(Serialize)]
struct ChatCompletionsRequest {
    model: String,
    messages: Vec<ChatMessageReq>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<ToolReq>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_split: Option<bool>,
}

#[derive(Serialize)]
struct ToolReq {
    #[serde(rename = "type")]
    tool_type: String,
    function: FunctionSchema,
}

#[derive(Serialize)]
struct FunctionSchema {
    name: String,
    description: String,
    parameters: serde_json::Value,
}

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
struct ChatCompletionsResponse {
    choices: Vec<Choice>,
    #[serde(default)]
    usage: Option<Usage>,
}

#[derive(Deserialize, Debug)]
struct Choice {
    message: Message,
}

#[derive(Deserialize, Debug)]
struct Message {
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<MessageToolCall>>,
}

#[derive(Deserialize, Debug)]
struct MessageToolCall {
    id: String,
    #[serde(rename = "type")]
    call_type: String,
    function: FunctionCall,
}

#[derive(Deserialize, Debug)]
struct FunctionCall {
    name: String,
    arguments: String,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[allow(dead_code)]
struct Usage {
    prompt_tokens: Option<u32>,
    completion_tokens: Option<u32>,
    total_tokens: Option<u32>,
}

// Streaming response types (for parsing SSE from OpenAI API)
#[derive(Deserialize, Debug, Clone)]
#[allow(dead_code)]
struct ApiStreamChunk {
    choices: Vec<ApiStreamChoice>,
    #[serde(default)]
    usage: Option<Usage>,
}

#[derive(Deserialize, Debug, Clone)]
#[allow(dead_code)]
struct ApiStreamChoice {
    delta: ApiStreamDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
#[allow(dead_code)]
struct ApiStreamDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ApiStreamToolCall>>,
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default)]
    reasoning_details: Option<Vec<ReasoningDetail>>,
}

#[derive(Deserialize, Debug, Clone)]
#[allow(dead_code)]
struct ReasoningDetail {
    #[serde(rename = "type")]
    detail_type: Option<String>,
    id: Option<String>,
    format: Option<String>,
    index: Option<usize>,
    text: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
struct ApiStreamToolCall {
    /// The LLM-assigned position of this tool call within the current
    /// assistant turn. Required to disambiguate parallel `tool_calls`
    /// emitted in a single delta — without it we cannot tell which call
    /// an `id` / `name` / `arguments` chunk belongs to and would clobber
    /// them into one bucket. The OpenAI spec guarantees `index` is unique
    /// and stable within a turn (0, 1, 2, ...). Some providers omit it on
    /// single-tool-call responses, so we default to 0.
    #[serde(default)]
    index: Option<usize>,
    id: Option<String>,
    #[serde(rename = "type")]
    call_type: Option<String>,
    function: Option<ApiStreamFunction>,
}

#[derive(Deserialize, Debug, Clone)]
struct ApiStreamFunction {
    name: Option<String>,
    arguments: Option<String>,
}

impl std::fmt::Display for ChatCompletionsResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "ChatCompletionsResponse {{ choices: {} }}",
            self.choices.len()
        )
    }
}

impl ChatResponse for ChatCompletionsResponse {
    fn text(&self) -> Option<String> {
        self.choices.first().and_then(|c| c.message.content.clone())
    }

    fn tool_calls(&self) -> Option<Vec<LlmToolCall>> {
        let calls = self.choices.first()?.message.tool_calls.as_ref()?;

        Some(
            calls
                .iter()
                .map(|c| LlmToolCall {
                    id: c.id.clone(),
                    call_type: c.call_type.clone(),
                    function: LlmFunctionCall {
                        name: c.function.name.clone(),
                        arguments: c.function.arguments.clone(),
                    },
                })
                .collect(),
        )
    }
}

/// reqwest::Error 的 `Display` 对 `Kind::Decode` 只写
/// "error decoding response body" 这种误导性文案, 真正的根因
/// (TimedOut / connection reset / TLS handshake failure / connect
/// timeout 等) 藏在 `source()` 链里。手工拼一遍, 上层
/// `synthesize_llm_unavailable` 才能区分 60s 总超时和真断网。
///
/// 例如把 60s `Client::timeout()` 改拆成 `connect_timeout` + 较长的
/// `read_timeout` 之后, 真正超时的链会显示成
/// `"error decoding response body <- request or response body error
///   <- operation timed out"`, 不再是孤零零的 "error decoding"。
fn format_reqwest_error(e: &reqwest::Error) -> String {
    let mut chain = e.to_string();
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        chain.push_str(" <- ");
        chain.push_str(&s.to_string());
        source = s.source();
    }
    chain
}

fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

fn retry_delay(attempt: usize) -> Duration {
    Duration::from_millis(match attempt {
        0 => 400,
        1 => 1_000,
        _ => 2_000,
    })
}

impl OpenAICompatibleProvider {
    pub fn new(config: OpenAICompatibleConfig) -> Self {
        // 用 `connect_timeout` 限制握手, `read_timeout` 容忍长流式生成期间
        // 单帧空闲 — 之前一个 60s `Client::timeout()` 是**总**超时, 推理
        // 模型首字节慢 + 大 payload write 工具下一轮 reload 三者一叠加就
        // 容易在流还没开始时就被截断, 错误还会被 reqwest 的 `Kind::Decode`
        // 包装成误导性的 "error decoding response body"。
        //
        // 不再设总超时: `read_timeout(120s)` 在每个 frame 收到时重置, 长
        // 生成只要持续吐 chunk 就不会触发; 真要兜底可在调用方按 cycle
        // 加 wall-clock cap, 不应该在这一层硬切。
        let client = Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .read_timeout(std::time::Duration::from_secs(120))
            .build()
            .expect("Failed to build reqwest Client");
        Self {
            config: Arc::new(config),
            client,
        }
    }

    #[allow(dead_code)]
    pub fn with_client(client: Client, config: OpenAICompatibleConfig) -> Self {
        Self {
            config: Arc::new(config),
            client,
        }
    }

    fn build_url(&self) -> String {
        let base = self.config.base_url.trim_end_matches('/');
        format!("{}/chat/completions", base)
    }

    fn role_to_str(role: &ChatRole) -> &'static str {
        match role {
            ChatRole::User => "user",
            ChatRole::Assistant => "assistant",
        }
    }

    fn prepare_messages(&self, messages: &[LlmChatMessage]) -> Vec<ChatMessageReq> {
        let mut result: Vec<ChatMessageReq> = Vec::with_capacity(messages.len() + 1);

        // Add system message if configured
        if let Some(system) = &self.config.system {
            result.push(ChatMessageReq {
                role: "system".to_string(),
                content: Some(system.clone()),
                tool_calls: None,
                tool_call_id: None,
            });
        }

        // Convert messages. ToolResult 会展开成多条 role:"tool" 消息
        // (一条对应 Vec 里的一个 ToolCall, 携带 tool_call_id 关联之前的 tool_use)。
        for msg in messages {
            match &msg.message_type {
                MessageType::ToolResult(results) => {
                    for r in results {
                        result.push(ChatMessageReq {
                            role: "tool".to_string(),
                            content: Some(r.function.arguments.clone()),
                            tool_calls: None,
                            tool_call_id: Some(r.id.clone()),
                        });
                    }
                }
                MessageType::ToolUse(calls) => {
                    let content = if msg.content.is_empty() {
                        None
                    } else {
                        Some(msg.content.clone())
                    };
                    result.push(ChatMessageReq {
                        role: "assistant".to_string(),
                        content,
                        tool_calls: Some(calls.clone()),
                        tool_call_id: None,
                    });
                }
                MessageType::Text => {
                    result.push(ChatMessageReq {
                        role: Self::role_to_str(&msg.role).to_string(),
                        content: Some(msg.content.clone()),
                        tool_calls: None,
                        tool_call_id: None,
                    });
                }
                _ => {
                    // Image/Audio/Pdf/ImageURL: 当前应用未使用, 跳过避免悄悄丢消息。
                    tracing::warn!(
                        "[OpenAI] Skipping unsupported MessageType variant in prepare_messages"
                    );
                }
            }
        }

        result
    }

    /// 内部分流式方法, 产 [`OpenAICompatibleStreamItem`]。agent.rs 用这个方法 ——
    /// 它需要把 `reasoning_content` 与 `content` 区分开, 然后构造
    /// [`crate::agent::AgentChunk`] 发给前端。
    /// rllm trait 路径 [`Self::chat_stream_with_tools`] 走 `StreamChunk`,
    /// 用 `.map` 把它包回去; reasoning 重新加回 `[REASONING]:` 前缀以保持
    /// trait 路径兼容性 (虽然 agent 不再走)。
    pub async fn chat_stream_tagged(
        &self,
        messages: &[LlmChatMessage],
        tools: Option<&[rllm::chat::Tool]>,
    ) -> Result<
        Pin<Box<dyn Stream<Item = Result<OpenAICompatibleStreamItem, RllmError>> + Send>>,
        RllmError,
    > {
        if self.config.api_key.is_empty() {
            return Err(RllmError::AuthError("Missing API key".to_string()));
        }

        let msgs = self.prepare_messages(messages);

        // Convert rllm Tools to OpenAI tool format
        let tool_requests = tools.map(|tools| {
            tools
                .iter()
                .map(|t| ToolReq {
                    tool_type: "function".to_string(),
                    function: FunctionSchema {
                        name: t.function.name.clone(),
                        description: t.function.description.clone(),
                        parameters: t.function.parameters.clone(),
                    },
                })
                .collect()
        });

        let request = ChatCompletionsRequest {
            model: self.config.model.clone(),
            messages: msgs,
            max_tokens: self.config.max_tokens,
            temperature: self.config.temperature,
            stream: true,
            tools: tool_requests,
            reasoning_split: self.config.reasoning_split,
        };

        let url = self.build_url();
        let body =
            serde_json::to_string(&request).map_err(|e| RllmError::JsonError(e.to_string()))?;
        tracing::debug!("[OpenAI] Request body: {}", body);

        let timeout = Duration::from_secs(
            self.config
                .timeout_seconds
                .unwrap_or(DEFAULT_STREAM_WALLCLOCK_SECS),
        );
        let mut last_retryable_error: Option<RllmError> = None;
        let mut response = None;
        for attempt in 0..MAX_INITIAL_REQUEST_ATTEMPTS {
            let req = self
                .client
                .post(&url)
                .bearer_auth(&self.config.api_key)
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream")
                .timeout(timeout)
                .body(body.clone());

            match req.send().await {
                Ok(resp) if resp.status().is_success() => {
                    response = Some(resp);
                    break;
                }
                Ok(resp) => {
                    let status = resp.status();
                    let raw_response = resp.text().await.unwrap_or_default();
                    let err = RllmError::ResponseFormatError {
                        message: format!("API error {}", status.as_u16()),
                        raw_response,
                    };
                    if is_retryable_status(status) && attempt + 1 < MAX_INITIAL_REQUEST_ATTEMPTS {
                        tracing::warn!(
                            "[OpenAI] retrying stream request after retryable status {} (attempt {}/{})",
                            status.as_u16(),
                            attempt + 1,
                            MAX_INITIAL_REQUEST_ATTEMPTS
                        );
                        last_retryable_error = Some(err);
                        tokio::time::sleep(retry_delay(attempt)).await;
                        continue;
                    }
                    return Err(err);
                }
                Err(e) => {
                    let err = RllmError::HttpError(format_reqwest_error(&e));
                    if attempt + 1 < MAX_INITIAL_REQUEST_ATTEMPTS {
                        tracing::warn!(
                            "[OpenAI] retrying stream request after send error (attempt {}/{}): {}",
                            attempt + 1,
                            MAX_INITIAL_REQUEST_ATTEMPTS,
                            e
                        );
                        last_retryable_error = Some(err);
                        tokio::time::sleep(retry_delay(attempt)).await;
                        continue;
                    }
                    return Err(err);
                }
            }
        }
        let response = response.ok_or_else(|| {
            last_retryable_error.unwrap_or_else(|| {
                RllmError::HttpError("stream request failed before response".to_string())
            })
        })?;

        let stream = futures::stream::unfold(
            (
                response.bytes_stream(),
                String::new(),
                PendingToolCalls::new(),
                VecDeque::<Result<OpenAICompatibleStreamItem, RllmError>>::new(),
            ),
            |(mut byte_stream, mut sse_buffer, mut pending, mut queue)| async move {
                // Helper: convert one fully-formed tool call into the
                // stream-item shape and queue it. Wraps the per-call
                // event format so the `for tc in flush_pending_tool_calls(...)`
                // loops below stay one-liners.
                let enqueue = |q: &mut VecDeque<_>, tool_call: LlmToolCall| {
                    q.push_back(Ok(OpenAICompatibleStreamItem::ToolUseComplete {
                        tool_call,
                    }));
                };

                if let Some(item) = queue.pop_front() {
                    return Some((item, (byte_stream, sse_buffer, pending, queue)));
                }

                while let Some(chunk) = byte_stream.next().await {
                    let bytes = match chunk {
                        Ok(bytes) => bytes,
                        Err(e) => {
                            return Some((
                                Err(RllmError::HttpError(format_reqwest_error(&e))),
                                (byte_stream, sse_buffer, pending, queue),
                            ));
                        }
                    };

                    let text = String::from_utf8_lossy(&bytes).to_string();
                    tracing::debug!("[OpenAI] Received bytes, text length: {}", text.len());
                    sse_buffer.push_str(&text);

                    while let Some(newline_index) = sse_buffer.find('\n') {
                        let line: String = sse_buffer.drain(..=newline_index).collect();
                        let line = line.trim();
                        if !line.starts_with("data: ") {
                            continue;
                        }

                        let json_str = line.trim_start_matches("data: ").trim();
                        if json_str == "[DONE]" {
                            tracing::debug!("[OpenAI] Stream done");
                            queue.push_back(Ok(OpenAICompatibleStreamItem::Done {
                                stop_reason: "stop".to_string(),
                            }));
                            continue;
                        }

                        let Ok(response) = serde_json::from_str::<ApiStreamChunk>(json_str) else {
                            tracing::debug!("[OpenAI] Failed to parse stream JSON: {}", json_str);
                            continue;
                        };

                        for choice in response.choices {
                            let delta = choice.delta;

                            if let Some(reasoning) = delta.reasoning_content {
                                if !reasoning.is_empty() {
                                    tracing::debug!("[OpenAI] Got reasoning chunk: {}", reasoning);
                                    queue.push_back(Ok(OpenAICompatibleStreamItem::Reasoning(
                                        reasoning,
                                    )));
                                }
                            }

                            if let Some(content) = delta.content {
                                if !content.is_empty() {
                                    tracing::debug!("[OpenAI] Got text chunk: {}", content);
                                    queue.push_back(Ok(OpenAICompatibleStreamItem::Text(content)));
                                }
                            }

                            if let Some(tool_calls) = delta.tool_calls {
                                merge_tool_call_delta(&mut pending, tool_calls);
                            }

                            if choice.finish_reason.as_deref() == Some("tool_calls")
                                && !pending.is_empty()
                            {
                                // Drain ALL buckets in ascending index order.
                                // This is the parallel-call fix: emit one
                                // ToolUseComplete per index so the agent sees
                                // N independent tool calls.
                                for tc in flush_pending_tool_calls(&mut pending) {
                                    enqueue(&mut queue, tc);
                                }
                            }
                        }

                        // Token 用量在流末尾单独送 (顶层 `usage`, 不在 choices 里)。
                        // 之前 `Usage` 字段在 ApiStreamChunk 解析但从未被读取 ──
                        // 现在透传给 agent.rs 做跨 cycle 累加 + 预算熔断。
                        // total_tokens 为 None (网关没填) 时不 emit, 避免把
                        // `Some(Usage { total_tokens: 0, .. })` 当成 0 token 计入。
                        if let Some(usage) = response.usage {
                            if let Some(total) = usage.total_tokens {
                                queue.push_back(Ok(OpenAICompatibleStreamItem::Usage {
                                    total_tokens: total,
                                    prompt_tokens: usage.prompt_tokens,
                                    completion_tokens: usage.completion_tokens,
                                }));
                            }
                        }
                    }

                    if let Some(item) = queue.pop_front() {
                        return Some((item, (byte_stream, sse_buffer, pending, queue)));
                    }
                }

                // Tail flush: stream ended without an explicit
                // finish_reason="tool_calls" (network cut, provider quirk).
                // Emit any half-complete buckets so they aren't silently
                // dropped.
                if !pending.is_empty() {
                    for tc in flush_pending_tool_calls(&mut pending) {
                        enqueue(&mut queue, tc);
                    }
                    if let Some(item) = queue.pop_front() {
                        return Some((item, (byte_stream, sse_buffer, pending, queue)));
                    }
                }

                None
            },
        );

        Ok(Box::pin(stream))
    }
}

#[async_trait]
impl ChatProvider for OpenAICompatibleProvider {
    async fn chat(&self, messages: &[LlmChatMessage]) -> Result<Box<dyn ChatResponse>, RllmError> {
        self.chat_with_tools(messages, None).await
    }

    async fn chat_with_tools(
        &self,
        messages: &[LlmChatMessage],
        tools: Option<&[rllm::chat::Tool]>,
    ) -> Result<Box<dyn ChatResponse>, RllmError> {
        if self.config.api_key.is_empty() {
            return Err(RllmError::AuthError("Missing API key".to_string()));
        }

        let msgs = self.prepare_messages(messages);

        // Convert rllm Tools to OpenAI tool format
        let tool_requests = tools.map(|tools| {
            tools
                .iter()
                .map(|t| ToolReq {
                    tool_type: "function".to_string(),
                    function: FunctionSchema {
                        name: t.function.name.clone(),
                        description: t.function.description.clone(),
                        parameters: t.function.parameters.clone(),
                    },
                })
                .collect()
        });

        let request = ChatCompletionsRequest {
            model: self.config.model.clone(),
            messages: msgs,
            max_tokens: self.config.max_tokens,
            temperature: self.config.temperature,
            stream: false,
            tools: tool_requests,
            reasoning_split: self.config.reasoning_split,
        };

        let url = self.build_url();
        let timeout = Duration::from_secs(
            self.config
                .timeout_seconds
                .unwrap_or(DEFAULT_REQUEST_WALLCLOCK_SECS),
        );
        let mut last_retryable_error: Option<RllmError> = None;
        let mut response = None;
        for attempt in 0..MAX_INITIAL_REQUEST_ATTEMPTS {
            let req = self
                .client
                .post(&url)
                .bearer_auth(&self.config.api_key)
                .header("Content-Type", "application/json")
                .timeout(timeout)
                .json(&request);

            match req.send().await {
                Ok(resp) if resp.status().is_success() => {
                    response = Some(resp);
                    break;
                }
                Ok(resp) => {
                    let status = resp.status();
                    let raw_response = resp.text().await.unwrap_or_default();
                    let err = RllmError::ResponseFormatError {
                        message: format!("API error {}", status.as_u16()),
                        raw_response,
                    };
                    if is_retryable_status(status) && attempt + 1 < MAX_INITIAL_REQUEST_ATTEMPTS {
                        tracing::warn!(
                            "[OpenAI] retrying request after retryable status {} (attempt {}/{})",
                            status.as_u16(),
                            attempt + 1,
                            MAX_INITIAL_REQUEST_ATTEMPTS
                        );
                        last_retryable_error = Some(err);
                        tokio::time::sleep(retry_delay(attempt)).await;
                        continue;
                    }
                    return Err(err);
                }
                Err(e) => {
                    let err = RllmError::HttpError(format_reqwest_error(&e));
                    if attempt + 1 < MAX_INITIAL_REQUEST_ATTEMPTS {
                        tracing::warn!(
                            "[OpenAI] retrying request after send error (attempt {}/{}): {}",
                            attempt + 1,
                            MAX_INITIAL_REQUEST_ATTEMPTS,
                            e
                        );
                        last_retryable_error = Some(err);
                        tokio::time::sleep(retry_delay(attempt)).await;
                        continue;
                    }
                    return Err(err);
                }
            }
        }
        let response = response.ok_or_else(|| {
            last_retryable_error.unwrap_or_else(|| {
                RllmError::HttpError("request failed before response".to_string())
            })
        })?;

        let chat_response: ChatCompletionsResponse = response
            .json()
            .await
            .map_err(|e| RllmError::JsonError(e.to_string()))?;

        Ok(Box::new(chat_response))
    }

    async fn chat_stream_with_tools(
        &self,
        messages: &[LlmChatMessage],
        tools: Option<&[rllm::chat::Tool]>,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<StreamChunk, RllmError>> + Send>>, RllmError> {
        // rllm 兼容包装 ── agent 不再走 trait 路径, 改用 [`Self::chat_stream_tagged`]
        // 直接拿到 `OpenAICompatibleStreamItem` (reasoning 单独成项, 无字符串前缀)。
        // 这里把 tagged 流映射回 rllm `StreamChunk`, reasoning 重新加回
        // `[REASONING]:` 前缀以保持老消费者兼容。
        let tagged = self.chat_stream_tagged(messages, tools).await?;
        let mapped = tagged.filter_map(|item| async move {
            // rllm 的 `StreamChunk` 没有 Usage 变体 ── agent 走
            // `chat_stream_tagged` 路径消费 Usage 做预算熔断, 这条 rllm 兼容
            // 路径当前无活跃消费者, 静默 drop Usage chunk (不要 emit 一个
            // `Done` 出来, 那会让 rllm 消费者以为流提前结束)。
            match item {
                Ok(OpenAICompatibleStreamItem::Usage { total_tokens, .. }) => {
                    tracing::debug!(
                        "[OpenAI] rllm-compat path dropping Usage chunk ({} tokens)",
                        total_tokens
                    );
                    None
                }
                Ok(other) => Some(Ok(match other {
                    OpenAICompatibleStreamItem::Text(text) => StreamChunk::Text(text),
                    OpenAICompatibleStreamItem::Reasoning(text) => {
                        StreamChunk::Text(format!("[REASONING]: {}", text))
                    }
                    OpenAICompatibleStreamItem::ToolUseComplete { tool_call } => {
                        StreamChunk::ToolUseComplete {
                            index: 0,
                            tool_call,
                        }
                    }
                    OpenAICompatibleStreamItem::Done { stop_reason } => {
                        StreamChunk::Done { stop_reason }
                    }
                    // 上面 filter_map 已 drop, 这里穷举性需要再覆盖一次
                    OpenAICompatibleStreamItem::Usage { .. } => unreachable!(),
                })),
                Err(e) => Some(Err(e)),
            }
        });
        Ok(Box::pin(mapped))
    }
}

#[cfg(test)]
mod tests {
    //! Regression tests for the parallel `tool_calls` parser.
    //!
    //! The pre-fix parser used a single `PendingToolCall` bucket and ignored
    //! the LLM-assigned `index` field, so when the LLM emitted N parallel
    //! `tool_calls` in one delta they were all clobbered into one bucket —
    //! their `arguments` strings concatenated and only the last `id`
    //! survived. The gateway then rejected the next turn with 400
    //! "invalid function arguments json string".
    //!
    //! These tests exercise the same `merge_tool_call_delta` /
    //! `flush_pending_tool_calls` free functions the runtime `unfold`
    //! closure calls, so a fix in one propagates to the other.
    use super::*;

    fn tc(index: usize, id: &str, name: &str, args: &str) -> ApiStreamToolCall {
        ApiStreamToolCall {
            index: Some(index),
            id: Some(id.to_string()),
            call_type: Some("function".to_string()),
            function: Some(ApiStreamFunction {
                name: Some(name.to_string()),
                arguments: Some(args.to_string()),
            }),
        }
    }

    fn tc_args(index: usize, args: &str) -> ApiStreamToolCall {
        ApiStreamToolCall {
            index: Some(index),
            id: None,
            call_type: None,
            function: Some(ApiStreamFunction {
                name: None,
                arguments: Some(args.to_string()),
            }),
        }
    }

    #[test]
    fn parallel_tool_calls_get_their_own_buckets() {
        // Simulate two parallel `read` tool_calls in one assistant turn:
        //  - index 0: id "call_A", args streaming
        //  - index 1: id "call_B", args streaming
        // Each call's args should land in its own bucket, NOT be concatenated.
        let mut pending = PendingToolCalls::new();
        merge_tool_call_delta(
            &mut pending,
            vec![
                tc(0, "call_A", "read", r#"{"#),
                tc(1, "call_B", "read", r#"{"#),
            ],
        );
        merge_tool_call_delta(
            &mut pending,
            vec![
                tc_args(0, r#""path":"a.md"}"#),
                tc_args(1, r#""path":"b.md"}"#),
            ],
        );
        let calls = flush_pending_tool_calls(&mut pending);

        assert_eq!(
            calls.len(),
            2,
            "expected 2 parallel tool calls, got {:?}",
            calls
        );
        assert_eq!(calls[0].id, "call_A");
        assert_eq!(calls[0].function.name, "read");
        assert_eq!(calls[0].function.arguments, r#"{"path":"a.md"}"#);
        assert_eq!(calls[1].id, "call_B");
        assert_eq!(calls[1].function.name, "read");
        assert_eq!(calls[1].function.arguments, r#"{"path":"b.md"}"#);

        // The cardinal regression check: pre-fix both buckets would have
        // ended up with the same concatenated string.
        assert_ne!(
            calls[0].function.arguments, calls[1].function.arguments,
            "arguments were collapsed — index keying is broken"
        );
    }

    #[test]
    fn single_tool_call_still_works_when_index_omitted() {
        // Some providers omit `index` on single-tool-call responses.
        // The parser must default to index 0 so the call still lands in
        // a known bucket.
        let mut pending = PendingToolCalls::new();
        let mut call = tc(0, "call_X", "available_dirs", "{}");
        call.index = None; // simulate provider that omits the field
        merge_tool_call_delta(&mut pending, vec![call]);
        let calls = flush_pending_tool_calls(&mut pending);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_X");
        assert_eq!(calls[0].function.arguments, "{}");
    }

    #[test]
    fn half_formed_buckets_are_skipped_at_flush() {
        // A bucket with no `name` (only a stray `id`) should be dropped
        // rather than emitted as a `ToolUseComplete` with empty function
        // name, which would crash the agent's tool dispatch.
        let mut pending = PendingToolCalls::new();
        merge_tool_call_delta(
            &mut pending,
            vec![ApiStreamToolCall {
                index: Some(0),
                id: Some("call_stray".to_string()),
                call_type: None,
                function: None,
            }],
        );
        let calls = flush_pending_tool_calls(&mut pending);
        assert!(
            calls.is_empty(),
            "half-formed bucket must be skipped, got {:?}",
            calls
        );
    }

    #[test]
    fn three_parallel_calls_round_trip() {
        // Three calls in one turn — guards the upper end of the parallel
        // path. Order of emission must be ascending index.
        let mut pending = PendingToolCalls::new();
        merge_tool_call_delta(
            &mut pending,
            vec![
                tc(2, "call_C", "read", r#"{"id":"c"}"#),
                tc(0, "call_A", "read", r#"{"id":"a"}"#),
                tc(1, "call_B", "read", r#"{"id":"b"}"#),
            ],
        );
        let calls = flush_pending_tool_calls(&mut pending);
        assert_eq!(calls.len(), 3);
        // BTreeMap iterates in key order, so index 0 emits first.
        assert_eq!(calls[0].id, "call_A");
        assert_eq!(calls[1].id, "call_B");
        assert_eq!(calls[2].id, "call_C");
    }
}
