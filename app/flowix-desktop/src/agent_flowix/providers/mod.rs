//! Providers module for rllm-compatible agent framework.
//!
//! This module contains implementations of chat providers for various LLM backends.
//! All providers implement rllm's ChatProvider trait for compatibility.

pub mod deepseek;
pub mod openai_compatible;
#[cfg(test)]
mod test_streaming;

pub use deepseek::DeepSeekProvider;
pub use openai_compatible::{
    OpenAICompatibleChatMessage, OpenAICompatibleConfig, OpenAICompatibleProvider,
    OpenAICompatibleStreamItem,
};
