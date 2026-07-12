mod history;

// History API ── 读 ~/.claude/projects/<encoded>/*.jsonl, 转成 ChatMessage 流。
pub use history::{get_session, is_claude_session_id, list_sessions};

// CLI runtime ── spawn `claude` binary 子进程, stdout 按行解析, 通过 shared::emit_chunk_with_run_id
// 投递 AgentChunk。
pub mod cli;
pub use cli::ClaudeCliManager;
