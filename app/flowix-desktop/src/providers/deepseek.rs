use std::pin::Pin;

use futures::stream::Stream;
use rllm::chat::{ChatResponse, Tool};
use rllm::error::LLMError as RllmError;

use super::openai_compatible::{
    OpenAICompatibleChatMessage, OpenAICompatibleConfig, OpenAICompatibleProvider,
    OpenAICompatibleStreamItem,
};

#[derive(Debug, Clone)]
pub struct DeepSeekProvider {
    inner: OpenAICompatibleProvider,
}

impl DeepSeekProvider {
    pub fn new(config: OpenAICompatibleConfig) -> Self {
        Self {
            inner: OpenAICompatibleProvider::new(config.with_reasoning_content(true)),
        }
    }

    pub async fn chat_with_tools(
        &self,
        messages: &[OpenAICompatibleChatMessage],
        tools: Option<&[Tool]>,
    ) -> Result<Box<dyn ChatResponse>, RllmError> {
        self.inner.chat_with_tools(messages, tools).await
    }

    pub async fn chat_stream_tagged(
        &self,
        messages: &[OpenAICompatibleChatMessage],
        tools: Option<&[Tool]>,
    ) -> Result<
        Pin<Box<dyn Stream<Item = Result<OpenAICompatibleStreamItem, RllmError>> + Send>>,
        RllmError,
    > {
        self.inner.chat_stream_tagged(messages, tools).await
    }
}
