//! External agent runtimes —后�?用来�?AI 对话的两杤���?
//!
//! - **sidecar CLI** (`claude` / `codex` / `hermes` / `claude` / `codex` / `hermes`): 鏈湴
//!   spawn 一�?binary 子进�? �?stdout 按�?解析�?`AgentChunk`�?//!   三个 vendor 各有�?���?session 文件 (分别�?`~/.claude/` / `~/.codex/` /
//!   `~/.hermes/`), 由各�?�� `history` 子模块�?取�?//! - **in-process LLM provider** (`agent::factory`): �?HTTP 流式协�?�?//!
//! �?��块只收拢 sidecar 这一杰��所�?sidecar 共享 `shared::ExternalRunRegistry`
//! (child 进程注册�?+ watchdog) �?`shared::emit_chunk_with_run_id` (统一
//! �?run_id 写到 chunk payload 顶层)�?//!
//! 入口模块就两�? `shared` �?��正的 cross-runtime 工具, 其余每个 runtime
//! 都是 `cli + history` (history �?��有�?�?session 文件�?vendor 里有意义)�?
pub(crate) mod acp_lifecycle;
pub mod claude;
pub mod cli_resolver;
pub mod codex;
pub mod deepseek_harness;
pub mod hermes;
pub mod lifecycle;
pub mod node;
pub mod opencode;
pub mod pi;
pub mod runtime_registry;
pub mod shared;

/// Process-wide lock for tests that temporarily modify environment variables.
///
/// Rust tests in different modules run concurrently in one process. Keeping a
/// mutex inside each module does not protect `PATH`, `SHELL`, or provider env
/// vars from tests in sibling modules, so every external-agent test shares this
/// single lock.
#[cfg(test)]
static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub(crate) fn acquire_test_env_lock() -> std::sync::MutexGuard<'static, ()> {
    let guard = TEST_ENV_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    // 注册表是进程�?static, 跨测试会串味 ── 拿到锁后先清�?None, 保证每个
    // Tests start from pure detection behavior unless they explicitly seed the registry.
    cli_resolver::reset_external_cli_registry_for_test();
    guard
}

// Re-export cross-runtime helpers at the crate root so callers can write
// `crate::agent_external::ExternalRunRegistry` without dropping into
// `shared`. Per-runtime APIs (ClaudeCliManager etc.) live on the
// submodules.
pub use shared::{
    append_workspace_context, canonical_message_id, canonicalize_imported_messages,
    classify_agent_error, default_thread_title, emit_chunk_with_run_id,
    emit_chunk_with_run_id_and_metadata, persist_and_emit_external_chunk, persist_external_chunk,
    persist_external_chunk_for_thread_with_metadata, provider_error_from_json,
    provider_error_from_text, read_capped_line, read_stderr_to_string, read_to_string,
    redact_sensitive_text, resolve_and_freeze_runtime_cwd, resolve_external_failure,
    resolve_run_id, safe_user_error_message, select_external_session_for_runtime, truncate_chars,
    truncate_for_log, AgentChunkMetadata, ExternalRunRegistry, StreamingEmitBuffer,
    MAX_STDERR_CHARS, MAX_STDOUT_LINE_BYTES, MAX_USER_ERROR_CHARS, STREAM_FLUSH_INTERVAL,
    STREAM_FLUSH_MAX_BYTES, USER_STOPPED_REASON,
};
