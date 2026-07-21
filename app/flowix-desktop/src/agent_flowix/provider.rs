use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::StreamExt;
use rllm::builder::{LLMBackend, LLMBuilder};
use rllm::chat::{ChatRole, MessageType, StreamChunk, Tool};
use rllm::error::LLMError;
use serde::{Deserialize, Serialize};

use crate::agent_flowix::providers::{
    DeepSeekProvider, OpenAICompatibleChatMessage, OpenAICompatibleConfig,
    OpenAICompatibleProvider, OpenAICompatibleStreamItem,
};
use crate::config::AiModelConfig;

use super::wire::AgentError;

#[derive(Clone)]
pub struct AgentInstance {
    pub(super) provider: AgentChatProvider,
    pub(super) tools: Vec<Tool>,
}

#[derive(Clone)]
pub(super) enum AgentChatProvider {
    OpenAICompatible(Arc<OpenAICompatibleProvider>),
    DeepSeek(Arc<DeepSeekProvider>),
    Rllm(Arc<dyn rllm::LLMProvider>),
}

impl AgentChatProvider {
    pub(super) async fn chat_with_tools(
        &self,
        messages: &[OpenAICompatibleChatMessage],
        tools: Option<&[Tool]>,
    ) -> Result<Box<dyn rllm::chat::ChatResponse>, rllm::error::LLMError> {
        match self {
            Self::OpenAICompatible(provider) => provider.chat_with_tools(messages, tools).await,
            Self::DeepSeek(provider) => provider.chat_with_tools(messages, tools).await,
            Self::Rllm(provider) => {
                let llm_messages = messages
                    .iter()
                    .map(OpenAICompatibleChatMessage::to_llm_message)
                    .collect::<Vec<_>>();
                provider.chat_with_tools(&llm_messages, tools).await
            }
        }
    }

    pub(super) async fn chat_stream_tagged(
        &self,
        messages: &[OpenAICompatibleChatMessage],
        tools: Option<&[Tool]>,
    ) -> Result<
        std::pin::Pin<
            Box<
                dyn futures::Stream<
                        Item = Result<OpenAICompatibleStreamItem, rllm::error::LLMError>,
                    > + Send,
            >,
        >,
        rllm::error::LLMError,
    > {
        match self {
            Self::OpenAICompatible(provider) => provider.chat_stream_tagged(messages, tools).await,
            Self::DeepSeek(provider) => provider.chat_stream_tagged(messages, tools).await,
            Self::Rllm(provider) => {
                let llm_messages = messages
                    .iter()
                    .map(OpenAICompatibleChatMessage::to_llm_message)
                    .collect::<Vec<_>>();
                match provider.chat_stream_with_tools(&llm_messages, tools).await {
                    Ok(stream) => Ok(Box::pin(stream.filter_map(|item| async move {
                        match item {
                            Ok(StreamChunk::Text(text)) => {
                                Some(Ok(OpenAICompatibleStreamItem::Text(text)))
                            }
                            Ok(StreamChunk::ToolUseComplete { tool_call, .. }) => {
                                Some(Ok(OpenAICompatibleStreamItem::ToolUseComplete {
                                    tool_call,
                                }))
                            }
                            Ok(StreamChunk::Done { stop_reason }) => {
                                Some(Ok(OpenAICompatibleStreamItem::Done { stop_reason }))
                            }
                            Ok(StreamChunk::ToolUseStart { .. })
                            | Ok(StreamChunk::ToolUseInputDelta { .. }) => None,
                            Err(err) => Some(Err(err)),
                        }
                    }))),
                    Err(err) if is_streaming_with_tools_unsupported(&err) => {
                        let response = provider.chat_with_tools(&llm_messages, tools).await?;
                        let mut items = Vec::new();
                        if let Some(thinking) = response.thinking().filter(|s| !s.trim().is_empty())
                        {
                            items.push(Ok(OpenAICompatibleStreamItem::Reasoning(thinking)));
                        }
                        if let Some(text) = response.text().filter(|s| !s.is_empty()) {
                            items.push(Ok(OpenAICompatibleStreamItem::Text(text)));
                        }
                        if let Some(tool_calls) = response.tool_calls() {
                            items.extend(tool_calls.into_iter().map(|tool_call| {
                                Ok(OpenAICompatibleStreamItem::ToolUseComplete { tool_call })
                            }));
                        }
                        if let Some(usage) = response.usage() {
                            let cached_input = usage
                                .prompt_tokens_details
                                .as_ref()
                                .and_then(|d| d.cached_tokens);
                            let reasoning_output = usage
                                .completion_tokens_details
                                .as_ref()
                                .and_then(|d| d.reasoning_tokens);
                            items.push(Ok(OpenAICompatibleStreamItem::Usage {
                                total_tokens: usage.total_tokens,
                                input_tokens: Some(usage.prompt_tokens),
                                cached_input_tokens: cached_input,
                                output_tokens: Some(usage.completion_tokens),
                                reasoning_output_tokens: reasoning_output,
                                model_context_window: None,
                            }));
                        }
                        items.push(Ok(OpenAICompatibleStreamItem::Done {
                            stop_reason: "stop".to_string(),
                        }));
                        Ok(Box::pin(futures::stream::iter(items)))
                    }
                    Err(err) => Err(err),
                }
            }
        }
    }
}

fn is_streaming_with_tools_unsupported(err: &rllm::error::LLMError) -> bool {
    let text = err.to_string();
    text.contains("Streaming with tools not supported")
        || text.contains("streaming with tools not supported")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum FlowixProviderKind {
    OpenAI,
    OpenAICompatible,
    Anthropic,
    Google,
    Ollama,
    DeepSeek,
    OpenRouter,
}

pub(super) fn provider_kind(provider: &str) -> FlowixProviderKind {
    let normalized: String = provider
        .chars()
        .filter(|ch| !ch.is_whitespace() && *ch != '-' && *ch != '_')
        .flat_map(char::to_lowercase)
        .collect();

    match normalized.as_str() {
        "openai" | "openairesponses" | "openairesponsesapi" | "responsesapi" => {
            FlowixProviderKind::OpenAI
        }
        "openaichatcompletions" | "openaicompatible" | "compatible" => {
            FlowixProviderKind::OpenAICompatible
        }
        "anthropic" | "claude" => FlowixProviderKind::Anthropic,
        "google" | "gemini" => FlowixProviderKind::Google,
        "ollama" => FlowixProviderKind::Ollama,
        "deepseek" => FlowixProviderKind::DeepSeek,
        "openrouter" => FlowixProviderKind::OpenRouter,
        _ => FlowixProviderKind::OpenAICompatible,
    }
}

pub(super) fn build_chat_provider(
    config: &AiModelConfig,
    system_prompt: String,
    tools: &[Tool],
) -> Result<AgentChatProvider, AgentError> {
    match provider_kind(&config.provider) {
        FlowixProviderKind::OpenAICompatible | FlowixProviderKind::OpenRouter => {
            // Enable reasoning_split to separate thinking from final response.
            let reasoning_split = config.model.contains("MiniMax");
            let api_url = if matches!(
                provider_kind(&config.provider),
                FlowixProviderKind::OpenRouter
            ) && config.api_url.trim().is_empty()
            {
                "https://openrouter.ai/api/v1"
            } else {
                config.api_url.trim()
            };
            let provider = OpenAICompatibleProvider::new(
                OpenAICompatibleConfig::new(
                    config.effective_api_key(&config.provider),
                    &config.model,
                    api_url,
                )
                .with_system(system_prompt)
                .with_reasoning_split(reasoning_split),
            );
            Ok(AgentChatProvider::OpenAICompatible(Arc::new(provider)))
        }
        FlowixProviderKind::DeepSeek => {
            let provider = DeepSeekProvider::new(
                OpenAICompatibleConfig::new(
                    config.effective_api_key(&config.provider),
                    &config.model,
                    &config.api_url,
                )
                .with_system(system_prompt),
            );
            Ok(AgentChatProvider::DeepSeek(Arc::new(provider)))
        }
        kind => {
            let mut builder = LLMBuilder::new()
                .backend(match kind {
                    FlowixProviderKind::OpenAI => LLMBackend::OpenAI,
                    FlowixProviderKind::Anthropic => LLMBackend::Anthropic,
                    FlowixProviderKind::Google => LLMBackend::Google,
                    FlowixProviderKind::Ollama => LLMBackend::Ollama,
                    FlowixProviderKind::DeepSeek
                    | FlowixProviderKind::OpenAICompatible
                    | FlowixProviderKind::OpenRouter => {
                        unreachable!("handled by OpenAICompatible branch above")
                    }
                })
                .model(config.model.trim())
                .system(system_prompt)
                .max_tokens(4096);

            let effective_key = config.effective_api_key(&config.provider);
            if !effective_key.trim().is_empty() {
                builder = builder.api_key(effective_key.trim());
            }
            if !config.api_url.trim().is_empty() {
                builder = builder.base_url(config.api_url.trim());
            }

            let _ = tools;
            builder
                .build()
                .map(Arc::from)
                .map(AgentChatProvider::Rllm)
                .map_err(|err| AgentError::LlmProvider(err.to_string()))
        }
    }
}

// 鈹€鈹€鈹€ Connection probe 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
//
// `probe_chat` is a one-shot connectivity check used by the Preferences UI
// "Test Connection" button and by `Save` (which probes first, then writes).
// It deliberately bypasses `AgentManager`'s cached `AgentInstance` so:
//   1. each probe reflects *exactly* the `AiModelConfig` the user is editing,
//      not whatever instance was last built for an active chat thread;
//   2. failed probes don't poison the cached instance.
//
// On error we don't propagate `LLMError` directly 鈥?the IPC boundary sticks
// to JSON-friendly types, and the UI benefits from a coarse error kind
// (auth vs network vs model-not-found vs ...) so it can pick the right hint.

/// Semantic error category for a failed probe. Front-end uses this to pick a
/// user-facing message instead of surfacing the raw transport error.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TestConnectionErrorKind {
    /// `AiModelConfig` itself is missing fields (provider / model / apiKey / apiUrl).
    BadConfig,
    /// `provider_kind` couldn't classify the configured provider string.
    UnsupportedProvider,
    /// 401 / 403, or `LLMError::AuthError` outright.
    AuthFailed,
    /// 404: model id unknown, or endpoint path wrong.
    NotFound,
    /// 429: rate-limited by the upstream provider.
    RateLimited,
    /// 5xx: provider side outage.
    ServerError,
    /// 4xx other than 401/403/404/429: typically a bad request body
    /// (e.g. malformed model id).
    BadRequest,
    /// DNS / TCP / TLS failure surfaced from reqwest.
    NetworkUnreachable,
    /// Provider returned a body that isn't valid JSON.
    InvalidResponse,
    /// Catch-all for `RetryExceeded` / `ProviderError` / `Generic` / etc.
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionError {
    pub kind: TestConnectionErrorKind,
    /// Raw error message for the developer console / toast detail.
    /// Format: `"[<LLMError variant>] <rllm Display>"`.
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionResult {
    pub ok: bool,
    pub latency_ms: u64,
    /// The model id that was actually probed. Echoed back so the UI can
    /// confirm "you tested *this* model", not whatever happens to be cached.
    pub model_id: String,
    /// First up-to-80 chars of the model's text response. Empty when the
    /// model only emitted reasoning / tool_calls (no final text).
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<TestConnectionError>,
}

/// Hard cap on a probe round-trip. The OpenAICompatible path internally
/// retries up to 3 脳 120s before giving up (see
/// `providers/openai_compatible/constants.rs`), which is fine for an actual
/// chat but unacceptable for a "Test connection" button 鈥?the user expects
/// a quick verdict. We wrap the *outer* call with `PROBE_TIMEOUT_SECS` so a
/// hung upstream can't pin both UI buttons indefinitely.
const PROBE_TIMEOUT_SECS: u64 = 30;

/// Max chars of an error message we ship to the frontend. Anything beyond
/// this is truncated so a misconfigured proxy returning a multi-KB HTML
/// 500 page doesn't bloat the IPC payload / toast.
const SANITIZE_MAX_CHARS: usize = 500;

/// One-shot connectivity probe.
///
/// `pub(crate)` because only `commands::settings::test_ai_connection` calls
/// it; the rest of the agent module still uses `build_chat_provider` +
/// cached `AgentInstance` for production chats.
///
/// **Total function**: this must *always* return `TestConnectionResult`
/// and never propagate errors out of the IPC boundary. The frontend
/// `catch` block on `invoke` only fires when the command itself panics;
/// that path wraps as `{ kind: 'other' }`. Adding `?` here or unwrap'ing
/// a `None` would silently break the contract.
pub(crate) async fn probe_chat(config: &AiModelConfig) -> TestConnectionResult {
    let start = Instant::now();
    let model_id = config.model.trim().to_string();

    // 1. Zero-cost preflight 鈥?don't burn a request round-trip on
    //    obviously wrong config (missing key, bad URL scheme, ...).
    if let Some(err) = precheck(config) {
        return TestConnectionResult {
            ok: false,
            latency_ms: start.elapsed().as_millis() as u64,
            model_id,
            summary: String::new(),
            error: Some(err),
        };
    }

    // 2. Build a one-shot provider. Skipping `ensure_instance` is
    //    intentional 鈥?see the module-level comment.
    let provider = match build_chat_provider(config, String::new(), &[]) {
        Ok(p) => p,
        Err(err) => {
            return TestConnectionResult {
                ok: false,
                latency_ms: start.elapsed().as_millis() as u64,
                model_id,
                summary: String::new(),
                error: Some(TestConnectionError {
                    kind: TestConnectionErrorKind::UnsupportedProvider,
                    message: sanitize(&format!("[BuildProvider] {err}")),
                }),
            };
        }
    };

    // 3. Send the smallest possible prompt. `chat_with_tools(..., None)`
    //    hits the same code path on every backend 鈥?no tool-specific
    //    routing to worry about.
    let messages = [OpenAICompatibleChatMessage {
        role: ChatRole::User,
        content: "ping".to_string(),
        message_type: MessageType::Text,
        reasoning: None,
    }];

    let send = provider.chat_with_tools(&messages, None);
    let outcome = match tokio::time::timeout(Duration::from_secs(PROBE_TIMEOUT_SECS), send).await {
        Ok(res) => Outcome::Finished(res),
        Err(_elapsed) => Outcome::TimedOut,
    };

    let latency_ms = start.elapsed().as_millis() as u64;

    match outcome {
        Outcome::Finished(Ok(resp)) => {
            let summary = resp
                .text()
                .map(|t| t.chars().take(80).collect::<String>())
                .unwrap_or_default();
            TestConnectionResult {
                ok: true,
                latency_ms,
                model_id,
                summary,
                error: None,
            }
        }
        Outcome::Finished(Err(err)) => TestConnectionResult {
            ok: false,
            latency_ms,
            model_id,
            summary: String::new(),
            error: Some(classify_error(&err)),
        },
        Outcome::TimedOut => TestConnectionResult {
            ok: false,
            latency_ms,
            model_id,
            summary: String::new(),
            error: Some(TestConnectionError {
                kind: TestConnectionErrorKind::NetworkUnreachable,
                message: sanitize(&format!(
                    "[Timeout] no response within {PROBE_TIMEOUT_SECS}s"
                )),
            }),
        },
    }
}

/// Internal outcome of the timed-out `chat_with_tools` call.
enum Outcome {
    Finished(Result<Box<dyn rllm::chat::ChatResponse>, LLMError>),
    TimedOut,
}

/// Pure validation 鈥?no I/O. Mirrors what `save` *should* reject on its
/// own (the front-end also does this, but we re-check here so a malicious
/// or buggy caller can't bypass).
///
/// **Cross-file invariant**: the rules here are *deliberately duplicated*
/// in `app/flowix-web/features/preferences/sections/agent.tsx::
/// validateBeforeSave` so the front-end can fail-fast on obvious mistakes
/// without burning an HTTP round-trip. If you add a rule here, mirror it
/// in `validateBeforeSave` too 鈥?otherwise the front-end will let through
/// a config this function rejects.
fn precheck(config: &AiModelConfig) -> Option<TestConnectionError> {
    if config.provider.trim().is_empty() {
        return Some(TestConnectionError {
            kind: TestConnectionErrorKind::BadConfig,
            message: "provider is empty".to_string(),
        });
    }
    if config.model.trim().is_empty() {
        return Some(TestConnectionError {
            kind: TestConnectionErrorKind::BadConfig,
            message: "model is empty".to_string(),
        });
    }
    let url = config.api_url.trim();
    if !url.is_empty() && !(url.starts_with("http://") || url.starts_with("https://")) {
        return Some(TestConnectionError {
            kind: TestConnectionErrorKind::BadConfig,
            message: format!("api_url must start with http:// or https://, got {url:?}"),
        });
    }
    // Ollama (local) and self-described OpenAI-compatible endpoints
    // usually don't need a key; everything else does.
    let kind = provider_kind(&config.provider);
    let key_required = !matches!(
        kind,
        FlowixProviderKind::Ollama | FlowixProviderKind::OpenAICompatible
    );
    if key_required && config.effective_api_key(&config.provider).trim().is_empty() {
        return Some(TestConnectionError {
            kind: TestConnectionErrorKind::BadConfig,
            message: "api_key is empty".to_string(),
        });
    }
    // Ollama / OpenAI-compatible self-host have *no* default base URL 鈥?    // unlike OpenAI/Anthropic/etc. which `LLMBuilder` falls back to. An
    // empty `api_url` here would produce a request to `"/chat/completions"`
    // (no host), surfacing as a confusing `NetworkUnreachable` instead of
    // a clear "you forgot the URL" message.
    let url_required = matches!(
        kind,
        FlowixProviderKind::Ollama | FlowixProviderKind::OpenAICompatible
    );
    if url_required && url.is_empty() {
        return Some(TestConnectionError {
            kind: TestConnectionErrorKind::BadConfig,
            message: "api_url is empty (required for Ollama / OpenAI-compatible)".to_string(),
        });
    }
    None
}

/// Strip newlines (multi-line errors blow up single-line toasts) and
/// truncate to `SANITIZE_MAX_CHARS` chars (multi-KB error bodies from
/// misconfigured proxies shouldn't bloat the IPC payload).
///
/// Treats `\r\n` as a single line break (so we get one space, not two)
/// before collapsing every `\n` / `\r` to a space.
fn sanitize(msg: &str) -> String {
    let normalized = msg.replace("\r\n", "\n");
    let collapsed: String = normalized
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    let trimmed = collapsed.trim();
    let mut chars = trimmed.chars();
    let head: String = chars.by_ref().take(SANITIZE_MAX_CHARS).collect();
    if chars.next().is_some() {
        format!("{head}鈥?(truncated)")
    } else {
        head
    }
}

/// Map `LLMError` 鈫?`TestConnectionErrorKind`.
///
/// Several LLMError variants embed a child error message 鈥?`RetryExceeded`
/// wraps the last attempt's Display, and rllm backends for Anthropic /
/// Google / DeepSeek may stuff status info into `ProviderError` or
/// `Generic`. We try `classify_status_string` on the inner text first
/// before falling back to `Other`, so 429 / 5xx / 401 messages survive
/// the wrapper chain.
///
/// **Why we don't just use `format!("[{head}] {err}")`**: `LLMError`'s
/// `Display`
/// impl embeds `raw_response` for `ResponseFormatError` 鈥?that
/// field can be hundreds of KB of upstream HTML. We extract the safe
/// fields per-variant instead of relying on Display.
fn classify_error(err: &LLMError) -> TestConnectionError {
    let (kind, head, body) = match err {
        LLMError::AuthError(msg) => (
            TestConnectionErrorKind::AuthFailed,
            "AuthError",
            msg.clone(),
        ),
        LLMError::HttpError(msg) => (
            TestConnectionErrorKind::NetworkUnreachable,
            "HttpError",
            msg.clone(),
        ),
        LLMError::InvalidRequest(msg) => (
            TestConnectionErrorKind::BadRequest,
            "InvalidRequest",
            msg.clone(),
        ),
        LLMError::JsonError(msg) => (
            TestConnectionErrorKind::InvalidResponse,
            "JsonError",
            msg.clone(),
        ),
        LLMError::ResponseFormatError {
            message,
            raw_response,
        } => {
            // `raw_response` is the full upstream body 鈥?never ship it to
            // the frontend, but always log it so a dev chasing a bad
            // upstream can find it.
            if !raw_response.is_empty() {
                eprintln!(
                    "[probe_chat] ResponseFormatError raw_response ({} bytes): {}",
                    raw_response.len(),
                    raw_response
                );
            }
            (
                classify_status_string(message).unwrap_or(TestConnectionErrorKind::Other),
                "ResponseFormatError",
                message.clone(),
            )
        }
        LLMError::RetryExceeded {
            attempts,
            last_error,
        } => (
            classify_status_string(last_error).unwrap_or(TestConnectionErrorKind::Other),
            "RetryExceeded",
            format!("after {attempts} attempts: {last_error}"),
        ),
        LLMError::ProviderError(msg) => (
            classify_status_string(msg).unwrap_or(TestConnectionErrorKind::Other),
            "ProviderError",
            msg.clone(),
        ),
        LLMError::Generic(msg) => (
            classify_status_string(msg).unwrap_or(TestConnectionErrorKind::Other),
            "Generic",
            msg.clone(),
        ),
        LLMError::ToolConfigError(msg) => {
            // This means *we* built a bad tool schema 鈥?a config bug on
            // the Flowix side, not anything the user did. Tell them the
            // form is wrong so they don't blame the provider.
            (
                TestConnectionErrorKind::BadConfig,
                "ToolConfigError",
                msg.clone(),
            )
        }
    };
    TestConnectionError {
        kind,
        message: sanitize(&format!("[{head}] {body}")),
    }
}

/// Try to pull a leading HTTP status out of `message` and map it to a
/// `TestConnectionErrorKind`. Returns `None` when no usable status is
/// present 鈥?callers should fall back to their default kind.
fn classify_status_string(message: &str) -> Option<TestConnectionErrorKind> {
    let head = message
        .split(|c: char| !c.is_ascii_digit())
        .find(|s| !s.is_empty())
        .and_then(|s| s.parse::<u16>().ok());
    match head {
        Some(401) | Some(403) => Some(TestConnectionErrorKind::AuthFailed),
        Some(404) => Some(TestConnectionErrorKind::NotFound),
        Some(429) => Some(TestConnectionErrorKind::RateLimited),
        Some(s) if (500..600).contains(&s) => Some(TestConnectionErrorKind::ServerError),
        Some(s) if (400..500).contains(&s) => Some(TestConnectionErrorKind::BadRequest),
        _ => None,
    }
}

#[cfg(test)]
mod probe_tests {
    use super::*;

    fn cfg(provider: &str, model: &str, api_url: &str, api_key: &str) -> AiModelConfig {
        let mut api_keys = std::collections::HashMap::new();
        api_keys.insert(provider.to_string(), api_key.to_string());
        AiModelConfig {
            provider: provider.to_string(),
            model: model.to_string(),
            api_url: api_url.to_string(),
            api_keys,
            max_total_tokens: 180_000,
        }
    }

    // 鈹€鈹€鈹€ precheck 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    #[test]
    fn precheck_rejects_empty_provider() {
        let err = precheck(&cfg("", "m", "", "k")).unwrap();
        assert_eq!(err.kind, TestConnectionErrorKind::BadConfig);
        assert!(err.message.contains("provider"));
    }

    #[test]
    fn precheck_rejects_empty_model() {
        let err = precheck(&cfg("OpenAI", "", "", "k")).unwrap();
        assert_eq!(err.kind, TestConnectionErrorKind::BadConfig);
        assert!(err.message.contains("model"));
    }

    #[test]
    fn precheck_rejects_whitespace_only_model() {
        // Same outcome as empty 鈥?`trim()` should normalise.
        let err = precheck(&cfg("OpenAI", "   ", "", "k")).unwrap();
        assert_eq!(err.kind, TestConnectionErrorKind::BadConfig);
        assert!(err.message.contains("model"));
    }

    #[test]
    fn precheck_rejects_bad_url_scheme() {
        let err = precheck(&cfg("OpenAI", "m", "ftp://x", "k")).unwrap();
        assert_eq!(err.kind, TestConnectionErrorKind::BadConfig);
        assert!(err.message.contains("api_url"));
    }

    #[test]
    fn precheck_rejects_empty_key_for_openai() {
        let err = precheck(&cfg("OpenAI", "m", "", "")).unwrap();
        assert_eq!(err.kind, TestConnectionErrorKind::BadConfig);
        assert!(err.message.contains("api_key"));
    }

    #[test]
    fn precheck_allows_empty_key_for_ollama() {
        assert!(precheck(&cfg("Ollama", "qwen", "http://localhost:11434", "")).is_none());
    }

    #[test]
    fn precheck_rejects_empty_url_for_ollama() {
        // Ollama has no default base URL 鈥?empty api_url would POST to
        // "/chat/completions" with no host. Reject up-front.
        let err = precheck(&cfg("Ollama", "qwen", "", "")).unwrap();
        assert_eq!(err.kind, TestConnectionErrorKind::BadConfig);
        assert!(err.message.contains("api_url"));
    }

    #[test]
    fn precheck_rejects_empty_url_for_openai_compatible() {
        let err = precheck(&cfg("OpenAI Compatible", "m", "", "")).unwrap();
        assert_eq!(err.kind, TestConnectionErrorKind::BadConfig);
        assert!(err.message.contains("api_url"));
    }

    #[test]
    fn precheck_allows_empty_url_for_anthropic() {
        // Anthropic / OpenAI / etc. all have default base URLs the rllm
        // builder fills in, so empty api_url is fine.
        assert!(precheck(&cfg("Anthropic", "claude", "", "sk-test")).is_none());
    }

    // 鈹€鈹€鈹€ classify_status_string 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    #[test]
    fn classify_status_string_recognises_known_codes() {
        assert_eq!(
            classify_status_string("API error 401: ..."),
            Some(TestConnectionErrorKind::AuthFailed)
        );
        assert_eq!(
            classify_status_string("API error 403: ..."),
            Some(TestConnectionErrorKind::AuthFailed)
        );
        assert_eq!(
            classify_status_string("API error 404: ..."),
            Some(TestConnectionErrorKind::NotFound)
        );
        assert_eq!(
            classify_status_string("API error 429: ..."),
            Some(TestConnectionErrorKind::RateLimited)
        );
        assert_eq!(
            classify_status_string("API error 502: ..."),
            Some(TestConnectionErrorKind::ServerError)
        );
        assert_eq!(
            classify_status_string("API error 400: ..."),
            Some(TestConnectionErrorKind::BadRequest)
        );
    }

    #[test]
    fn classify_status_string_returns_none_when_no_leading_status() {
        assert_eq!(classify_status_string("totally unrelated message"), None);
        assert_eq!(classify_status_string(""), None);
        assert_eq!(classify_status_string("API error"), None);
    }

    // 鈹€鈹€鈹€ classify_error 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    #[test]
    fn classify_error_autherror_maps_to_auth_failed() {
        let err = LLMError::AuthError("bad token".to_string());
        let te = classify_error(&err);
        assert_eq!(te.kind, TestConnectionErrorKind::AuthFailed);
        assert!(te.message.starts_with("[AuthError]"));
    }

    #[test]
    fn classify_error_httperror_maps_to_network_unreachable() {
        let err = LLMError::HttpError("connection refused".to_string());
        let te = classify_error(&err);
        assert_eq!(te.kind, TestConnectionErrorKind::NetworkUnreachable);
    }

    #[test]
    fn classify_error_response_format_with_429_maps_to_rate_limited() {
        let err = LLMError::ResponseFormatError {
            message: "API error 429: rate-limited".to_string(),
            raw_response: "{\"error\": \"too many requests\"}".to_string(),
        };
        let te = classify_error(&err);
        assert_eq!(te.kind, TestConnectionErrorKind::RateLimited);
        // raw_response must NOT leak into the user-bound message.
        assert!(!te.message.contains("too many"));
    }

    #[test]
    fn classify_error_retry_exceeded_recovers_inner_status() {
        let err = LLMError::RetryExceeded {
            attempts: 3,
            last_error: "API error 502: bad gateway".to_string(),
        };
        let te = classify_error(&err);
        assert_eq!(te.kind, TestConnectionErrorKind::ServerError);
        assert!(te.message.contains("RetryExceeded"));
    }

    #[test]
    fn classify_error_provider_error_recovers_inner_status() {
        let err = LLMError::ProviderError("status 404 model not found".to_string());
        let te = classify_error(&err);
        assert_eq!(te.kind, TestConnectionErrorKind::NotFound);
    }

    #[test]
    fn classify_error_generic_falls_back_when_no_status() {
        let err = LLMError::Generic("weird upstream failure".to_string());
        let te = classify_error(&err);
        assert_eq!(te.kind, TestConnectionErrorKind::Other);
    }

    #[test]
    fn classify_error_tool_config_is_bad_config_not_other() {
        let err = LLMError::ToolConfigError("schema mismatch".to_string());
        let te = classify_error(&err);
        assert_eq!(te.kind, TestConnectionErrorKind::BadConfig);
    }

    // 鈹€鈹€鈹€ sanitize 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    #[test]
    fn sanitize_strips_newlines() {
        let out = sanitize("line1\nline2\r\nline3");
        assert_eq!(out, "line1 line2 line3");
    }

    #[test]
    fn sanitize_truncates_long_input() {
        let huge = "a".repeat(SANITIZE_MAX_CHARS + 50);
        let out = sanitize(&huge);
        assert!(out.starts_with(&"a".repeat(SANITIZE_MAX_CHARS)));
        assert!(out.ends_with("鈥?(truncated)"));
    }

    #[test]
    fn sanitize_passes_through_short_input() {
        let out = sanitize("ok");
        assert_eq!(out, "ok");
    }

    #[test]
    fn provider_kind_routes_deepseek_label_to_deepseek_provider() {
        assert_eq!(provider_kind("DeepSeek"), FlowixProviderKind::DeepSeek);
        assert_eq!(provider_kind("deepseek"), FlowixProviderKind::DeepSeek);
    }

    #[test]
    fn provider_kind_routes_builtin_provider_labels() {
        assert_eq!(provider_kind("Anthropic"), FlowixProviderKind::Anthropic);
        assert_eq!(provider_kind("Gemini"), FlowixProviderKind::Google);
        assert_eq!(provider_kind("Ollama"), FlowixProviderKind::Ollama);
        assert_eq!(provider_kind("OpenRouter"), FlowixProviderKind::OpenRouter);
    }

    #[test]
    fn build_chat_provider_supports_builtin_provider_labels() {
        let anthropic = build_chat_provider(
            &cfg("Anthropic", "claude-test", "", "sk-test"),
            String::new(),
            &[],
        )
        .expect("anthropic provider builds");
        assert!(matches!(anthropic, AgentChatProvider::Rllm(_)));

        let gemini = build_chat_provider(
            &cfg("Gemini", "gemini-test", "", "gemini-key"),
            String::new(),
            &[],
        )
        .expect("gemini provider builds");
        assert!(matches!(gemini, AgentChatProvider::Rllm(_)));

        let ollama = build_chat_provider(
            &cfg("Ollama", "qwen-test", "http://localhost:11434", ""),
            String::new(),
            &[],
        )
        .expect("ollama provider builds");
        assert!(matches!(ollama, AgentChatProvider::Rllm(_)));

        let openrouter = build_chat_provider(
            &cfg("OpenRouter", "openai/gpt-test", "", "openrouter-key"),
            String::new(),
            &[],
        )
        .expect("openrouter provider builds");
        assert!(matches!(openrouter, AgentChatProvider::OpenAICompatible(_)));
    }
}
