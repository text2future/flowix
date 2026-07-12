use std::sync::Arc;

use futures::StreamExt;
use rllm::builder::{LLMBackend, LLMBuilder};
use rllm::chat::{ChatMessage as LlmChatMessage, StreamChunk, Tool};

use crate::providers::{
    OpenAICompatibleConfig, OpenAICompatibleProvider, OpenAICompatibleStreamItem,
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
    Rllm(Arc<dyn rllm::LLMProvider>),
}

impl AgentChatProvider {
    pub(super) async fn chat_with_tools(
        &self,
        messages: &[LlmChatMessage],
        tools: Option<&[Tool]>,
    ) -> Result<Box<dyn rllm::chat::ChatResponse>, rllm::error::LLMError> {
        match self {
            Self::OpenAICompatible(provider) => provider.chat_with_tools(messages, tools).await,
            Self::Rllm(provider) => provider.chat_with_tools(messages, tools).await,
        }
    }

    pub(super) async fn chat_stream_tagged(
        &self,
        messages: &[LlmChatMessage],
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
            Self::Rllm(provider) => match provider.chat_stream_with_tools(messages, tools).await {
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
                    let response = provider.chat_with_tools(messages, tools).await?;
                    let mut items = Vec::new();
                    if let Some(thinking) = response.thinking().filter(|s| !s.trim().is_empty()) {
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
                        // rllm::chat::Usage only exposes prompt/completion/total plus
                        // nested prompt/completion_tokens_details; fold old-protocol
                        // fields into new-protocol fields here so downstream code
                        // never sees prompt_tokens / completion_tokens.
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
            },
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
        FlowixProviderKind::OpenAICompatible => {
            // Enable reasoning_split to separate thinking from final response.
            let reasoning_split = config.model.contains("MiniMax");
            let provider = OpenAICompatibleProvider::new(
                OpenAICompatibleConfig::new(
                    config.effective_api_key(&config.provider),
                    &config.model,
                    &config.api_url,
                )
                .with_system(system_prompt)
                .with_reasoning_split(reasoning_split),
            );
            Ok(AgentChatProvider::OpenAICompatible(Arc::new(provider)))
        }
        kind => {
            let mut builder = LLMBuilder::new()
                .backend(match kind {
                    FlowixProviderKind::OpenAI => LLMBackend::OpenAI,
                    FlowixProviderKind::Anthropic => LLMBackend::Anthropic,
                    FlowixProviderKind::Google => LLMBackend::Google,
                    FlowixProviderKind::Ollama => LLMBackend::Ollama,
                    FlowixProviderKind::DeepSeek => LLMBackend::DeepSeek,
                    FlowixProviderKind::OpenRouter => LLMBackend::OpenRouter,
                    FlowixProviderKind::OpenAICompatible => unreachable!(),
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
