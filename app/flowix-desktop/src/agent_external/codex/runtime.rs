//! Codex-specific runtime helpers kept inside the `codex` module because they
//! gate on a Codex-named env var. The shared `emit_chunk_with_run_id` and
//! `resolve_run_id` helpers now live in `crate::agent_external`; we re-export
//! them here so existing `use crate::agent_external::codex::runtime::鈥 call
//! sites stay compiling.

pub use crate::agent_external::{emit_chunk_with_run_id, resolve_run_id};

use std::sync::Arc;

use crate::agent_flowix::AgentChunk;
use crate::agent_session::ThreadManager;

pub fn diagnostics_enabled() -> bool {
    std::env::var("FLOWIX_CODEX_DIAGNOSTICS")
        .map(|value| {
            let value = value.trim().to_ascii_lowercase();
            value == "1" || value == "true" || value == "yes" || value == "on"
        })
        .unwrap_or_else(|_| cfg!(debug_assertions))
}

pub async fn persist_codex_chunk(
    thread_manager: &Arc<tokio::sync::RwLock<ThreadManager>>,
    chunk: &AgentChunk,
    run_id: &str,
    raw_json: Option<&str>,
) {
    crate::agent_external::persist_external_chunk(
        thread_manager,
        super::AGENT_TYPE,
        chunk,
        run_id,
        raw_json,
    )
    .await;
}

pub async fn persist_and_emit_codex_chunk(
    app_handle: &tauri::AppHandle,
    thread_manager: &Arc<tokio::sync::RwLock<ThreadManager>>,
    chunk: &AgentChunk,
    run_id: &str,
    raw_json: Option<&str>,
) {
    persist_codex_chunk(thread_manager, chunk, run_id, raw_json).await;
    emit_chunk_with_run_id(app_handle, chunk, super::AGENT_TYPE, run_id);
}
