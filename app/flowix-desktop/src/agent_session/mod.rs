//! Agent session store 鈥?chat thread persistence, external-runtime session
//! mapping, and agent-conversation metadata, all backed by a single
//! SQLite database (one `Mutex<Connection>` in `store::ThreadManager`).
//!
//! File layout:
//! - `error` 鈥?`ThreadError` enum
//! - `types` 鈥?pure data: `ChatMessage`, `ThreadInfo`, `Thread`, `ThreadMessagesPage`,
//!   plus the `AgentConversation*` family
//! - `store` 鈥?`ThreadManager` + every SQL
//!   impl + migrations + row mappers
//!   (kept as one `impl` block because all tables share the same connection)
//! - `tests` 鈥?unit tests against an in-memory `ThreadManager`
//!
//! The split was driven by `threads.rs` reaching 1456 lines as a single
//! file while carrying three distinct domains (chat / external-session /
//! agent-conversation). The split separates types from behavior but
//! preserves the single-connection facade, so cross-table transactions
//! like `delete_thread_with_agent_conversations` keep working without
//! any new coupling.

pub mod error;
pub mod store;
pub mod types;

// Re-export at the agent_session:: namespace so callers can write
// `crate::agent_session::ChatMessage` without dropping into `types`.
pub use error::*;
pub use store::*;
pub use types::*;

#[cfg(test)]
mod tests;
