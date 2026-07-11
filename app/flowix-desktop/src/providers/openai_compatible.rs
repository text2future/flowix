//! OpenAI Chat Completions provider for rllm-compatible agent framework.
//!
//! This module provides a generic OpenAI-compatible provider that uses
//! the /v1/chat/completions endpoint, suitable for MiniMax, DeepSeek, and
//! other OpenAI-compatible APIs.

use base64::Engine;
use futures::stream::Stream;
use futures::StreamExt;
use image::GenericImageView;
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use rllm::chat::{ChatMessage as LlmChatMessage, ChatResponse, ChatRole, MessageType};
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
const MAX_IMAGE_DIMENSION: u32 = 1024;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES: usize = 50 * 1024 * 1024;

static MARKDOWN_IMAGE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"!\[[^\]]*\]\((?P<src>[^)\s]+(?:\s[^)]*)?)\)"#).unwrap());
static REMOTE_IMAGE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\bhttps?://[^\s<>()]+?\.(?:png|jpe?g)(?:\?[^\s<>()]*)?"#).unwrap()
});
static FILE_URL_IMAGE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\bfile:///[^\s<>()]+?\.(?:png|jpe?g)(?:\?[^\s<>()]*)?"#).unwrap()
});
static ASSET_URL_IMAGE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\basset://localhost/[^\s<>()]+?\.(?:png|jpe?g)(?:\?[^\s<>()]*)?"#).unwrap()
});
static WINDOWS_IMAGE_PATH_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)(?:^|[\s(])(?P<path>[A-Za-z]:[\\/][^\r\n<>"|?*]+?\.(?:png|jpe?g))(?:$|[\s),.!?;:])"#,
    )
    .unwrap()
});
static MARKDOWN_LINK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"\[[^\]]+\]\((?P<src>[^)\s]+(?:\s[^)]*)?)\)"#).unwrap());
static REMOTE_VIDEO_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\bhttps?://[^\s<>()]+?\.(?:mp4|mov|webm|m4v)(?:\?[^\s<>()]*)?"#).unwrap()
});
static FILE_URL_VIDEO_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\bfile:///[^\s<>()]+?\.(?:mp4|mov|webm|m4v)(?:\?[^\s<>()]*)?"#).unwrap()
});
static ASSET_URL_VIDEO_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\basset://localhost/[^\s<>()]+?\.(?:mp4|mov|webm|m4v)(?:\?[^\s<>()]*)?"#)
        .unwrap()
});
static WINDOWS_VIDEO_PATH_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)(?:^|[\s(])(?P<path>[A-Za-z]:[\\/][^\r\n<>"|?*]+?\.(?:mp4|mov|webm|m4v))(?:$|[\s),.!?;:])"#,
    )
    .unwrap()
});

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
        #[allow(dead_code)]
        input_tokens: Option<u32>,
        #[allow(dead_code)]
        cached_input_tokens: Option<u32>,
        #[allow(dead_code)]
        output_tokens: Option<u32>,
        #[allow(dead_code)]
        reasoning_output_tokens: Option<u32>,
        #[allow(dead_code)]
        model_context_window: Option<u32>,
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

// Request/Response types for OpenAI Chat Completions API
#[derive(Serialize)]
struct ChatMessageReq {
    role: String,
    /// OpenAI 允许 assistant 在携带 tool_calls 时 content 为 null / 缺省。
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<ChatMessageContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<LlmToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum ChatMessageContent {
    Text(String),
    Parts(Vec<ChatContentPart>),
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ChatContentPart {
    Text { text: String },
    ImageUrl { image_url: ImageUrlContent },
    VideoUrl { video_url: VideoUrlContent },
}

#[derive(Serialize)]
struct ImageUrlContent {
    url: String,
}

#[derive(Serialize)]
struct VideoUrlContent {
    url: String,
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
    input_tokens: Option<u32>,
    cached_input_tokens: Option<u32>,
    output_tokens: Option<u32>,
    reasoning_output_tokens: Option<u32>,
    model_context_window: Option<u32>,
    prompt_tokens_details: Option<PromptTokensDetails>,
    completion_tokens_details: Option<CompletionTokensDetails>,
    input_tokens_details: Option<PromptTokensDetails>,
    output_tokens_details: Option<CompletionTokensDetails>,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[allow(dead_code)]
struct PromptTokensDetails {
    cached_tokens: Option<u32>,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[allow(dead_code)]
struct CompletionTokensDetails {
    reasoning_tokens: Option<u32>,
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

fn text_content(text: impl Into<String>) -> ChatMessageContent {
    ChatMessageContent::Text(text.into())
}

fn extract_image_sources(content: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();

    for caps in MARKDOWN_IMAGE_RE.captures_iter(content) {
        if let Some(src) = caps.name("src") {
            let src = normalize_markdown_image_src(src.as_str());
            if is_supported_image_source(&src) && seen.insert(src.clone()) {
                out.push(src);
            }
        }
    }

    for mat in REMOTE_IMAGE_RE.find_iter(content) {
        let src = trim_bare_image_source(mat.as_str());
        if seen.insert(src.clone()) {
            out.push(src);
        }
    }

    for mat in FILE_URL_IMAGE_RE.find_iter(content) {
        let src = trim_bare_image_source(mat.as_str());
        if seen.insert(src.clone()) {
            out.push(src);
        }
    }

    for mat in ASSET_URL_IMAGE_RE.find_iter(content) {
        let src = trim_bare_image_source(mat.as_str());
        if seen.insert(src.clone()) {
            out.push(src);
        }
    }

    for caps in WINDOWS_IMAGE_PATH_RE.captures_iter(content) {
        if let Some(path) = caps.name("path") {
            let src = trim_bare_image_source(path.as_str());
            if seen.insert(src.clone()) {
                out.push(src);
            }
        }
    }

    out
}

fn extract_video_sources(content: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();

    for caps in MARKDOWN_LINK_RE.captures_iter(content) {
        if let Some(src) = caps.name("src") {
            let src = normalize_markdown_image_src(src.as_str());
            if is_supported_video_source(&src) && seen.insert(src.clone()) {
                out.push(src);
            }
        }
    }

    for mat in REMOTE_VIDEO_RE.find_iter(content) {
        let src = trim_bare_image_source(mat.as_str());
        if seen.insert(src.clone()) {
            out.push(src);
        }
    }

    for mat in FILE_URL_VIDEO_RE.find_iter(content) {
        let src = trim_bare_image_source(mat.as_str());
        if seen.insert(src.clone()) {
            out.push(src);
        }
    }

    for mat in ASSET_URL_VIDEO_RE.find_iter(content) {
        let src = trim_bare_image_source(mat.as_str());
        if seen.insert(src.clone()) {
            out.push(src);
        }
    }

    for caps in WINDOWS_VIDEO_PATH_RE.captures_iter(content) {
        if let Some(path) = caps.name("path") {
            let src = trim_bare_image_source(path.as_str());
            if seen.insert(src.clone()) {
                out.push(src);
            }
        }
    }

    out
}

fn normalize_markdown_image_src(src: &str) -> String {
    let trimmed = src.trim();
    let without_title = trimmed
        .split_once(" \"")
        .or_else(|| trimmed.split_once(" '"))
        .map(|(url, _)| url)
        .unwrap_or(trimmed)
        .trim();
    without_title
        .trim_matches('<')
        .trim_matches('>')
        .trim()
        .to_string()
}

fn trim_bare_image_source(src: &str) -> String {
    src.trim()
        .trim_end_matches(|c: char| {
            matches!(c, ')' | ']' | '}' | ',' | '.' | ';' | ':' | '!' | '?')
        })
        .to_string()
}

fn is_supported_image_source(src: &str) -> bool {
    let lower = src.to_ascii_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("file:///")
        || lower.starts_with("asset://localhost/")
    {
        return lower.contains(".png") || lower.contains(".jpg") || lower.contains(".jpeg");
    }
    is_supported_local_image_path(src)
}

fn is_supported_local_image_path(src: &str) -> bool {
    let lower = src.to_ascii_lowercase();
    (lower.ends_with(".png") || lower.ends_with(".jpg") || lower.ends_with(".jpeg"))
        && (Path::new(src).is_absolute()
            || src.starts_with(r"\\")
            || src.starts_with("//")
            || src.as_bytes().get(1) == Some(&b':'))
}

fn is_supported_video_source(src: &str) -> bool {
    let lower = src.to_ascii_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("file:///")
        || lower.starts_with("asset://localhost/")
    {
        return lower.contains(".mp4")
            || lower.contains(".mov")
            || lower.contains(".webm")
            || lower.contains(".m4v");
    }
    is_supported_local_video_path(src)
}

fn is_supported_local_video_path(src: &str) -> bool {
    let lower = src.to_ascii_lowercase();
    (lower.ends_with(".mp4")
        || lower.ends_with(".mov")
        || lower.ends_with(".webm")
        || lower.ends_with(".m4v"))
        && (Path::new(src).is_absolute()
            || src.starts_with(r"\\")
            || src.starts_with("//")
            || src.as_bytes().get(1) == Some(&b':'))
}

fn mime_from_source(src: &str) -> Option<&'static str> {
    let lower = src.to_ascii_lowercase();
    let path = lower.split('?').next().unwrap_or(&lower);
    if path.ends_with(".png") {
        Some("image/png")
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        Some("image/jpeg")
    } else {
        None
    }
}

fn video_mime_from_source(src: &str) -> Option<&'static str> {
    let lower = src.to_ascii_lowercase();
    let path = lower.split('?').next().unwrap_or(&lower);
    if path.ends_with(".mp4") || path.ends_with(".m4v") {
        Some("video/mp4")
    } else if path.ends_with(".mov") {
        Some("video/quicktime")
    } else if path.ends_with(".webm") {
        Some("video/webm")
    } else {
        None
    }
}

fn mime_from_content_type(content_type: Option<&str>) -> Option<&'static str> {
    let ct = content_type?.split(';').next()?.trim().to_ascii_lowercase();
    match ct.as_str() {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        _ => None,
    }
}

fn file_url_to_path(src: &str) -> Result<PathBuf, RllmError> {
    let url = reqwest::Url::parse(src)
        .map_err(|e| RllmError::HttpError(format!("invalid image file URL '{src}': {e}")))?;
    url.to_file_path()
        .map_err(|_| RllmError::HttpError(format!("invalid image file URL path '{src}'")))
}

fn asset_url_to_path(src: &str) -> Result<PathBuf, RllmError> {
    let url = reqwest::Url::parse(src)
        .map_err(|e| RllmError::HttpError(format!("invalid image asset URL '{src}': {e}")))?;
    if url.scheme() != "asset" || url.host_str() != Some("localhost") {
        return Err(RllmError::HttpError(format!(
            "unsupported image asset URL '{src}'"
        )));
    }

    let decoded = percent_decode(url.path()).map_err(|e| {
        RllmError::HttpError(format!("invalid percent-encoded asset URL '{src}': {e}"))
    })?;
    let path =
        if decoded.len() >= 4 && decoded.as_bytes()[0] == b'/' && decoded.as_bytes()[2] == b':' {
            &decoded[1..]
        } else {
            decoded.as_str()
        };
    Ok(PathBuf::from(path.replace('/', "\\")))
}

fn percent_decode(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err("truncated percent escape".to_string());
            }
            let hi = hex_value(bytes[i + 1]).ok_or_else(|| "invalid percent escape".to_string())?;
            let lo = hex_value(bytes[i + 2]).ok_or_else(|| "invalid percent escape".to_string())?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn encode_resized_image_data_url(
    source: &str,
    bytes: &[u8],
    mime_hint: Option<&str>,
) -> Result<String, RllmError> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(RllmError::HttpError(format!(
            "image '{source}' is too large: {} bytes exceeds {} bytes",
            bytes.len(),
            MAX_IMAGE_BYTES
        )));
    }

    let image = image::load_from_memory(bytes).map_err(|e| RllmError::ResponseFormatError {
        message: format!("failed to decode image '{source}'"),
        raw_response: e.to_string(),
    })?;
    let (width, height) = image.dimensions();
    let resized = if width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
        image.resize(
            MAX_IMAGE_DIMENSION,
            MAX_IMAGE_DIMENSION,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        image
    };

    let mime = mime_hint
        .or_else(|| mime_from_source(source))
        .unwrap_or("image/jpeg");
    let mut out = Cursor::new(Vec::new());
    match mime {
        "image/png" => resized.write_to(&mut out, image::ImageFormat::Png),
        _ => resized.write_to(&mut out, image::ImageFormat::Jpeg),
    }
    .map_err(|e| RllmError::JsonError(format!("failed to encode image '{source}': {e}")))?;

    let encoded = base64::engine::general_purpose::STANDARD.encode(out.into_inner());
    Ok(format!("data:{mime};base64,{encoded}"))
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
                        if let Some(usage) = response.usage {
                            if let Some(total) = usage.total_tokens {
                                queue.push_back(Ok(OpenAICompatibleStreamItem::Usage {
                                    total_tokens: total,
                                    prompt_tokens: usage.prompt_tokens,
                                    completion_tokens: usage.completion_tokens,
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
