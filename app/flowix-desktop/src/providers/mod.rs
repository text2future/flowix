//! Providers module for rllm-compatible agent framework.
//!
//! This module contains implementations of chat providers for various LLM backends.
//! All providers implement rllm's ChatProvider trait for compatibility.

pub mod deepseek;
pub mod openai_compatible;
#[cfg(test)]
mod test_streaming;
pub mod tools;

pub use deepseek::DeepSeekProvider;
pub use openai_compatible::{
    OpenAICompatibleChatMessage, OpenAICompatibleConfig, OpenAICompatibleProvider,
    OpenAICompatibleStreamItem,
};
pub use tools::{execute_tool, get_all_tools, get_sub_agent_tools};
