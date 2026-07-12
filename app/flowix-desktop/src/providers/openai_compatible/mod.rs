//! OpenAI Chat Completions provider for rllm-compatible agent framework.
//!
//! This module provides a generic OpenAI-compatible provider that uses
//! the /v1/chat/completions endpoint, suitable for MiniMax, DeepSeek, and
//! other OpenAI-compatible APIs.

mod constants;
mod media;
mod retry;
mod stream;
mod types;

pub use stream::OpenAICompatibleStreamItem;

use futures::stream::Stream;
use futures::StreamExt;
use reqwest::Client;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use rllm::chat::{ChatMessage as LlmChatMessage, ChatResponse, ChatRole, MessageType};
use rllm::error::LLMError as RllmError;
use rllm::ToolCall as LlmToolCall;

use self::constants::{
    DEFAULT_REQUEST_WALLCLOCK_SECS, DEFAULT_STREAM_WALLCLOCK_SECS, MAX_IMAGE_BYTES,
    MAX_INITIAL_REQUEST_ATTEMPTS, MAX_VIDEO_BYTES,
};
use self::media::{
    asset_url_to_path, encode_resized_image_data_url, extract_image_sources, extract_video_sources,
    file_url_to_path, mime_from_content_type, mime_from_source, video_mime_from_source,
};
use self::retry::{format_reqwest_error, is_retryable_status, retry_delay};
use self::stream::{flush_pending_tool_calls, merge_tool_call_delta, PendingToolCalls};
use self::types::{
    text_content, ApiStreamChunk, ChatCompletionsRequest, ChatCompletionsResponse, ChatContentPart,
    ChatMessageContent, ChatMessageReq, FunctionSchema, ImageUrlContent, ToolReq, VideoUrlContent,
};

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
    pub multimodal_user_content: bool,
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
            multimodal_user_content: false,
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

    pub fn with_multimodal_user_content(mut self, enabled: bool) -> Self {
        self.multimodal_user_content = enabled;
        self
    }
}

/// OpenAI-compatible provider using /v1/chat/completions endpoint.
/// 流式入口走 [`Self::chat_stream_tagged`] ── 拿结构化 `OpenAICompatibleStreamItem`
/// (reasoning / text 分离, 无 `[REASONING]:` 字符串前缀)。非流式走
/// [`Self::chat_with_tools`] ── `AgentChatProvider::chat_with_tools` 在
/// Rllm 流式不支持时降级到非流式时调。
#[derive(Debug, Clone)]
pub struct OpenAICompatibleProvider {
    config: Arc<OpenAICompatibleConfig>,
    client: Client,
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

    /// 非流式 chat completion ── 给 `AgentChatProvider::chat_with_tools`
    /// fallback 路径用 (Rllm 分支流式不支持时降级到非流式)。agent.rs:192
    /// 直接 `provider.chat_with_tools(...)` 调用, 不走 rllm trait dispatch。
    pub async fn chat_with_tools(
        &self,
        messages: &[LlmChatMessage],
        tools: Option<&[rllm::chat::Tool]>,
    ) -> Result<Box<dyn ChatResponse>, RllmError> {
        if self.config.api_key.is_empty() {
            return Err(RllmError::AuthError("Missing API key".to_string()));
        }

        let msgs = self.prepare_messages(messages).await?;

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
                .header("Accept", "application/json")
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

    async fn load_image_data_url(&self, source: &str) -> Result<String, RllmError> {
        if source.to_ascii_lowercase().starts_with("http://")
            || source.to_ascii_lowercase().starts_with("https://")
        {
            let response = self
                .client
                .get(source)
                .timeout(Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| RllmError::HttpError(format_reqwest_error(&e)))?;

            if !response.status().is_success() {
                return Err(RllmError::HttpError(format!(
                    "failed to download image '{source}': HTTP {}",
                    response.status()
                )));
            }

            if let Some(len) = response.content_length() {
                if len as usize > MAX_IMAGE_BYTES {
                    return Err(RllmError::HttpError(format!(
                        "image '{source}' is too large: {len} bytes exceeds {MAX_IMAGE_BYTES} bytes"
                    )));
                }
            }

            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let bytes = response
                .bytes()
                .await
                .map_err(|e| RllmError::HttpError(format_reqwest_error(&e)))?;
            let mime = mime_from_content_type(content_type.as_deref())
                .or_else(|| mime_from_source(source));
            return encode_resized_image_data_url(source, &bytes, mime);
        }

        let path = if source.to_ascii_lowercase().starts_with("file:///") {
            file_url_to_path(source)?
        } else if source
            .to_ascii_lowercase()
            .starts_with("asset://localhost/")
        {
            asset_url_to_path(source)?
        } else {
            PathBuf::from(source)
        };
        let bytes = tokio::fs::read(&path).await.map_err(|e| {
            RllmError::HttpError(format!(
                "failed to read local image '{}': {e}",
                path.display()
            ))
        })?;
        encode_resized_image_data_url(source, &bytes, mime_from_source(source))
    }

    async fn load_video_url(&self, source: &str) -> Result<String, RllmError> {
        let lower = source.to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            return Ok(source.to_string());
        }

        let path = if lower.starts_with("file:///") {
            file_url_to_path(source)?
        } else if lower.starts_with("asset://localhost/") {
            asset_url_to_path(source)?
        } else {
            PathBuf::from(source)
        };
        let metadata = tokio::fs::metadata(&path).await.map_err(|e| {
            RllmError::HttpError(format!(
                "failed to stat local video '{}': {e}",
                path.display()
            ))
        })?;
        if metadata.len() as usize > MAX_VIDEO_BYTES {
            return Err(RllmError::HttpError(format!(
                "video '{}' is too large: {} bytes exceeds {} bytes",
                path.display(),
                metadata.len(),
                MAX_VIDEO_BYTES
            )));
        }
        let bytes = tokio::fs::read(&path).await.map_err(|e| {
            RllmError::HttpError(format!(
                "failed to read local video '{}': {e}",
                path.display()
            ))
        })?;
        let mime = video_mime_from_source(source).unwrap_or("video/mp4");
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        Ok(format!("data:{mime};base64,{encoded}"))
    }

    async fn prepare_user_content(&self, content: &str) -> Result<ChatMessageContent, RllmError> {
        if !self.config.multimodal_user_content {
            return Ok(text_content(content));
        }

        let image_sources = extract_image_sources(content);
        let video_sources = extract_video_sources(content);
        if image_sources.is_empty() && video_sources.is_empty() {
            return Ok(text_content(content));
        }

        let mut parts = Vec::with_capacity(image_sources.len() + video_sources.len() + 1);
        parts.push(ChatContentPart::Text {
            text: content.to_string(),
        });
        for source in image_sources {
            let data_url = self.load_image_data_url(&source).await?;
            parts.push(ChatContentPart::ImageUrl {
                image_url: ImageUrlContent { url: data_url },
            });
        }
        for source in video_sources {
            let url = self.load_video_url(&source).await?;
            parts.push(ChatContentPart::VideoUrl {
                video_url: VideoUrlContent { url },
            });
        }
        Ok(ChatMessageContent::Parts(parts))
    }

    async fn prepare_messages(
        &self,
        messages: &[LlmChatMessage],
    ) -> Result<Vec<ChatMessageReq>, RllmError> {
        let mut result: Vec<ChatMessageReq> = Vec::with_capacity(messages.len() + 1);

        // Add system message if configured
        if let Some(system) = &self.config.system {
            result.push(ChatMessageReq {
                role: "system".to_string(),
                content: Some(text_content(system.clone())),
                tool_calls: None,
                tool_call_id: None,
            });
        }

        // OpenAI requires each tool result to immediately follow its assistant
        // tool call. Persisted history can contain orphaned or incomplete tool
        // rows after retries/cancellations, so sanitize at the provider edge.
        let mut index = 0;
        while index < messages.len() {
            let msg = &messages[index];
            match &msg.message_type {
                MessageType::ToolUse(calls) => {
                    let mut consumed_results = 0;
                    let mut candidate_results: Vec<LlmToolCall> = Vec::new();
                    let mut lookahead = index + 1;

                    while lookahead < messages.len() {
                        match &messages[lookahead].message_type {
                            MessageType::ToolResult(results) => {
                                candidate_results.extend(results.iter().cloned());
                                consumed_results += 1;
                                lookahead += 1;
                            }
                            _ => break,
                        }
                    }

                    let matched_results: Vec<LlmToolCall> = calls
                        .iter()
                        .filter_map(|call| {
                            candidate_results
                                .iter()
                                .find(|result| result.id == call.id)
                                .cloned()
                        })
                        .collect();

                    if matched_results.len() != calls.len() {
                        tracing::warn!(
                            "[OpenAI] Skipping incomplete tool call exchange before request"
                        );
                        index += 1 + consumed_results;
                        continue;
                    }

                    let content = if msg.content.is_empty() {
                        None
                    } else {
                        Some(text_content(msg.content.clone()))
                    };
                    result.push(ChatMessageReq {
                        role: "assistant".to_string(),
                        content,
                        tool_calls: Some(calls.clone()),
                        tool_call_id: None,
                    });
                    for r in matched_results {
                        result.push(ChatMessageReq {
                            role: "tool".to_string(),
                            content: Some(text_content(r.function.arguments.clone())),
                            tool_calls: None,
                            tool_call_id: Some(r.id.clone()),
                        });
                    }
                    index += 1 + consumed_results;
                }
                MessageType::ToolResult(_) => {
                    tracing::warn!("[OpenAI] Skipping orphan tool result before request");
                    index += 1;
                }
                MessageType::Text => {
                    let content = if matches!(msg.role, ChatRole::User) {
                        self.prepare_user_content(&msg.content).await?
                    } else {
                        text_content(msg.content.clone())
                    };
                    result.push(ChatMessageReq {
                        role: Self::role_to_str(&msg.role).to_string(),
                        content: Some(content),
                        tool_calls: None,
                        tool_call_id: None,
                    });
                    index += 1;
                }
                _ => {
                    // Image/Audio/Pdf/ImageURL: 当前应用未使用, 跳过避免悄悄丢消息。
                    tracing::warn!(
                        "[OpenAI] Skipping unsupported MessageType variant in prepare_messages"
                    );
                    index += 1;
                }
            }
        }

        Ok(result)
    }

    /// 内部分流式方法, 产 [`OpenAICompatibleStreamItem`]。agent.rs 用这个方法 ——
    /// 它需要把 `reasoning_content` 与 `content` 区分开, 然后构造
    /// [`crate::agent::AgentChunk`] 发给前端。这是 OpenAICompatibleProvider
    /// 唯一保留的流式入口; rllm trait 上的 `chat_stream_with_tools` 已
    /// `unimplemented!()` (无活跃消费者, 见 impl 注释)。
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

        let msgs = self.prepare_messages(messages).await?;

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
                        //
                        // Compatibility fallback: 旧 provider 只报
                        // `prompt_tokens` / `completion_tokens` 时,在 SSE 解析层
                        // 把它们 fallback 到 `input_tokens` / `output_tokens`,
                        // 这样下游 chunk 协议不再携带 prompt/completion 字段。
                        if let Some(usage) = response.usage {
                            if let Some(total) = usage.total_tokens {
                                queue.push_back(Ok(OpenAICompatibleStreamItem::Usage {
                                    total_tokens: total,
                                    input_tokens: usage.input_tokens.or(usage.prompt_tokens),
                                    cached_input_tokens: usage.cached_input_tokens.or_else(|| {
                                        usage
                                            .input_tokens_details
                                            .as_ref()
                                            .and_then(|details| details.cached_tokens)
                                            .or_else(|| {
                                                usage
                                                    .prompt_tokens_details
                                                    .as_ref()
                                                    .and_then(|details| details.cached_tokens)
                                            })
                                    }),
                                    output_tokens: usage.output_tokens.or(usage.completion_tokens),
                                    reasoning_output_tokens: usage.reasoning_output_tokens.or_else(
                                        || {
                                            usage
                                                .output_tokens_details
                                                .as_ref()
                                                .and_then(|details| details.reasoning_tokens)
                                                .or_else(|| {
                                                    usage
                                                        .completion_tokens_details
                                                        .as_ref()
                                                        .and_then(|details| {
                                                            details.reasoning_tokens
                                                        })
                                                })
                                        },
                                    ),
                                    model_context_window: usage.model_context_window,
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
    use std::io::Cursor;

    use image::GenericImageView;
    use rllm::FunctionCall as LlmFunctionCall;

    use super::constants::MAX_IMAGE_DIMENSION;
    use super::types::{ApiStreamFunction, ApiStreamToolCall};
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

    fn llm_tool_call(id: &str, name: &str, args: &str) -> LlmToolCall {
        LlmToolCall {
            id: id.to_string(),
            call_type: "function".to_string(),
            function: LlmFunctionCall {
                name: name.to_string(),
                arguments: args.to_string(),
            },
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

    #[test]
    fn extracts_markdown_remote_file_url_and_windows_image_paths() {
        let content = concat!(
            "看图 ![remote](https://example.com/a.png?x=1) ",
            "裸链 https://example.com/b.jpg, ",
            "file:///D:/imgs/c.jpeg ",
            "![asset](asset://localhost/C%3A%5CUsers%5CAdministrator%5CDocuments%5Cflowix%2Fattachments%5CSnipaste.png) ",
            "本地 D:\\imgs\\nested dir\\d.png"
        );
        let sources = extract_image_sources(content);
        assert_eq!(
            sources,
            vec![
                "https://example.com/a.png?x=1",
                "asset://localhost/C%3A%5CUsers%5CAdministrator%5CDocuments%5Cflowix%2Fattachments%5CSnipaste.png",
                "https://example.com/b.jpg",
                "file:///D:/imgs/c.jpeg",
                "D:\\imgs\\nested dir\\d.png",
            ]
        );
    }

    #[test]
    fn extracts_markdown_remote_file_url_and_windows_video_paths() {
        let content = concat!(
            "video [remote](https://example.com/a.mp4?x=1) ",
            "bare https://example.com/b.webm, ",
            "file:///D:/videos/c.mov ",
            "asset://localhost/C%3A%5CUsers%5CAdministrator%5CVideos%2Fd.m4v ",
            "local D:\\videos\\nested dir\\e.mp4"
        );
        let sources = extract_video_sources(content);
        assert_eq!(
            sources,
            vec![
                "https://example.com/a.mp4?x=1",
                "https://example.com/b.webm",
                "file:///D:/videos/c.mov",
                "asset://localhost/C%3A%5CUsers%5CAdministrator%5CVideos%2Fd.m4v",
                "D:\\videos\\nested dir\\e.mp4",
            ]
        );
    }

    #[test]
    fn asset_url_decodes_to_windows_path() {
        let path = asset_url_to_path(
            "asset://localhost/C%3A%5CUsers%5CAdministrator%5CDocuments%5Cflowix%2Fattachments%5CSnipaste_2026-05-11_19-53-54.png",
        )
        .unwrap();
        assert_eq!(
            path.display().to_string(),
            "C:\\Users\\Administrator\\Documents\\flowix\\attachments\\Snipaste_2026-05-11_19-53-54.png"
        );
    }

    #[test]
    fn resizes_image_to_max_1024_before_base64_encoding() {
        let image = image::DynamicImage::new_rgb8(2000, 1200);
        let mut input = Cursor::new(Vec::new());
        image.write_to(&mut input, image::ImageFormat::Png).unwrap();

        let data_url =
            encode_resized_image_data_url("local.png", &input.into_inner(), Some("image/png"))
                .unwrap();
        let (_, encoded) = data_url.split_once(',').unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let output = image::load_from_memory(&decoded).unwrap();
        let (width, height) = output.dimensions();
        assert!(width <= MAX_IMAGE_DIMENSION);
        assert!(height <= MAX_IMAGE_DIMENSION);
        assert_eq!((width, height), (1024, 614));
    }

    #[tokio::test]
    async fn prepare_messages_keeps_complete_tool_exchange() {
        let provider = OpenAICompatibleProvider::new(OpenAICompatibleConfig::new(
            "test-key",
            "test-model",
            "https://example.com/v1",
        ));
        let call = llm_tool_call("call_1", "read", r#"{"path":"a.md"}"#);
        let messages = provider
            .prepare_messages(&[
                LlmChatMessage {
                    role: ChatRole::Assistant,
                    content: String::new(),
                    message_type: MessageType::ToolUse(vec![call.clone()]),
                },
                LlmChatMessage {
                    role: ChatRole::User,
                    content: r#"{"content":"ok"}"#.to_string(),
                    message_type: MessageType::ToolResult(vec![llm_tool_call(
                        "call_1",
                        "tool_result",
                        r#"{"content":"ok"}"#,
                    )]),
                },
            ])
            .await
            .unwrap();

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "assistant");
        assert_eq!(messages[0].tool_calls.as_ref().unwrap()[0].id, call.id);
        assert_eq!(messages[1].role, "tool");
        assert_eq!(messages[1].tool_call_id.as_deref(), Some("call_1"));
    }

    #[tokio::test]
    async fn prepare_messages_skips_orphan_tool_result() {
        let provider = OpenAICompatibleProvider::new(OpenAICompatibleConfig::new(
            "test-key",
            "test-model",
            "https://example.com/v1",
        ));
        let messages = provider
            .prepare_messages(&[
                LlmChatMessage {
                    role: ChatRole::User,
                    content: r#"{"content":"orphan"}"#.to_string(),
                    message_type: MessageType::ToolResult(vec![llm_tool_call(
                        "call_orphan",
                        "tool_result",
                        r#"{"content":"orphan"}"#,
                    )]),
                },
                LlmChatMessage {
                    role: ChatRole::User,
                    content: "continue".to_string(),
                    message_type: MessageType::Text,
                },
            ])
            .await
            .unwrap();

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "user");
        assert!(messages[0].tool_call_id.is_none());
    }

    #[tokio::test]
    async fn prepare_messages_skips_incomplete_tool_exchange() {
        let provider = OpenAICompatibleProvider::new(OpenAICompatibleConfig::new(
            "test-key",
            "test-model",
            "https://example.com/v1",
        ));
        let messages = provider
            .prepare_messages(&[
                LlmChatMessage {
                    role: ChatRole::Assistant,
                    content: String::new(),
                    message_type: MessageType::ToolUse(vec![llm_tool_call(
                        "call_1",
                        "read",
                        r#"{"path":"a.md"}"#,
                    )]),
                },
                LlmChatMessage {
                    role: ChatRole::User,
                    content: "interrupted".to_string(),
                    message_type: MessageType::Text,
                },
                LlmChatMessage {
                    role: ChatRole::User,
                    content: r#"{"content":"late"}"#.to_string(),
                    message_type: MessageType::ToolResult(vec![llm_tool_call(
                        "call_1",
                        "tool_result",
                        r#"{"content":"late"}"#,
                    )]),
                },
            ])
            .await
            .unwrap();

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "user");
        assert!(messages[0].tool_calls.is_none());
    }

    #[tokio::test]
    async fn local_markdown_image_stays_text_by_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sample.png");
        let image = image::DynamicImage::new_rgb8(16, 16);
        image.save(&path).unwrap();

        let provider = OpenAICompatibleProvider::new(OpenAICompatibleConfig::new(
            "test-key",
            "test-model",
            "https://example.com/v1",
        ));
        let message = LlmChatMessage {
            role: ChatRole::User,
            content: format!("描述这张图 ![sample]({})", path.display()),
            message_type: MessageType::Text,
        };
        let messages = provider.prepare_messages(&[message]).await.unwrap();
        let value = serde_json::to_value(&messages[0]).unwrap();
        let content = value.get("content").and_then(|v| v.as_str()).unwrap();
        assert!(content.contains(&path.display().to_string()));
    }

    #[tokio::test]
    async fn local_markdown_image_becomes_openai_multimodal_content_when_enabled() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sample.png");
        let image = image::DynamicImage::new_rgb8(16, 16);
        image.save(&path).unwrap();

        let provider = OpenAICompatibleProvider::new(
            OpenAICompatibleConfig::new("test-key", "test-model", "https://example.com/v1")
                .with_multimodal_user_content(true),
        );
        let message = LlmChatMessage {
            role: ChatRole::User,
            content: format!("鎻忚堪杩欏紶鍥?![sample]({})", path.display()),
            message_type: MessageType::Text,
        };
        let messages = provider.prepare_messages(&[message]).await.unwrap();
        let value = serde_json::to_value(&messages[0]).unwrap();
        let content = value.get("content").and_then(|v| v.as_array()).unwrap();
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "image_url");
        assert!(content[1]["image_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }

    #[tokio::test]
    async fn remote_video_becomes_openai_multimodal_content_when_enabled() {
        let provider = OpenAICompatibleProvider::new(
            OpenAICompatibleConfig::new("test-key", "test-model", "https://example.com/v1")
                .with_multimodal_user_content(true),
        );
        let message = LlmChatMessage {
            role: ChatRole::User,
            content: "describe this video https://example.com/demo.mp4?token=1".to_string(),
            message_type: MessageType::Text,
        };
        let messages = provider.prepare_messages(&[message]).await.unwrap();
        let value = serde_json::to_value(&messages[0]).unwrap();
        let content = value.get("content").and_then(|v| v.as_array()).unwrap();
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "video_url");
        assert_eq!(
            content[1]["video_url"]["url"],
            "https://example.com/demo.mp4?token=1"
        );
    }

    #[tokio::test]
    async fn local_video_becomes_data_url_when_enabled() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sample.mp4");
        std::fs::write(&path, b"fake mp4 bytes").unwrap();

        let provider = OpenAICompatibleProvider::new(
            OpenAICompatibleConfig::new("test-key", "test-model", "https://example.com/v1")
                .with_multimodal_user_content(true),
        );
        let message = LlmChatMessage {
            role: ChatRole::User,
            content: format!("describe this video [sample]({})", path.display()),
            message_type: MessageType::Text,
        };
        let messages = provider.prepare_messages(&[message]).await.unwrap();
        let value = serde_json::to_value(&messages[0]).unwrap();
        let content = value.get("content").and_then(|v| v.as_array()).unwrap();
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "video_url");
        assert!(content[1]["video_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:video/mp4;base64,"));
    }
}
