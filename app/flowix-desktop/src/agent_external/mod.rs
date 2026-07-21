//! External agent runtimes 鈥?鍚庣鐢ㄦ潵璺?AI 瀵硅瘽鐨勪袱鏉¤矾寰?
//!
//! - **sidecar CLI** (`claude` / `codex` / `hermes` / `simple_cli`): 鏈湴
//!   spawn 涓€涓?binary 瀛愯繘绋? 鎶?stdout 鎸夎瑙ｆ瀽鎴?`AgentChunk`銆?//!   涓変釜 vendor 鍚勬湁鐙珛鐨?session 鏂囦欢 (鍒嗗埆钀?`~/.claude/` / `~/.codex/` /
//!   `~/.hermes/`), 鐢卞悇鑷殑 `history` 瀛愭ā鍧楄鍙栥€?//! - **in-process LLM provider** (`agent::factory`): 璧?HTTP 娴佸紡鍗忚銆?//!
//! 鏈ā鍧楀彧鏀舵嫝 sidecar 杩欎竴鏉°€傛墍鏈?sidecar 鍏变韩 `shared::ExternalRunRegistry`
//! (child 杩涚▼娉ㄥ唽琛?+ watchdog) 鍜?`shared::emit_chunk_with_run_id` (缁熶竴
//! 鎶?run_id 鍐欏埌 chunk payload 椤跺眰)銆?//!
//! 鍏ュ彛妯″潡灏变袱灞? `shared` 鏄湡姝ｇ殑 cross-runtime 宸ュ叿, 鍏朵綑姣忎釜 runtime
//! 閮芥槸 `cli + history` (history 鍙湪鏈夌鐩?session 鏂囦欢鐨?vendor 閲屾湁鎰忎箟)銆?
pub mod claude;
pub mod cli_resolver;
pub mod codex;
pub mod hermes;
pub mod node;
pub mod shared;
pub mod simple_cli;

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
    // 娉ㄥ唽琛ㄦ槸杩涚▼绾?static, 璺ㄦ祴璇曚細涓插懗 鈹€鈹€ 鎷垮埌閿佸悗鍏堟竻鍥?None, 淇濊瘉姣忎釜
    // 娴嬭瘯閮戒粠绾嚱鏁版帰娴嬭涓鸿捣姝ャ€傛祴璇曡嫢瑕侀獙璇?registry 璇箟, 鍦ㄩ攣鍐呰嚜琛?set銆?    cli_resolver::reset_external_cli_registry_for_test();
    guard
}

// Re-export cross-runtime helpers at the crate root so callers can write
// `crate::agent_external::ExternalRunRegistry` without dropping into
// `shared`. Per-runtime APIs (ClaudeCliManager etc.) live on the
// submodules.
pub use shared::{
    emit_chunk_with_run_id, emit_stream_end_once, kill_child_tree, persist_and_emit_external_chunk,
    persist_external_chunk, read_capped_line, read_stderr_to_string, resolve_run_id,
    select_external_session_for_runtime, ExternalRunRegistry, StreamingEmitBuffer,
    MAX_STDOUT_LINE_BYTES, STREAM_FLUSH_INTERVAL, STREAM_FLUSH_MAX_BYTES, USER_STOPPED_REASON,
};
