//! Codex-specific runtime helpers kept inside the `codex` module because they
//! gate on a Codex-named env var. The shared `emit_chunk_with_run_id` and
//! `resolve_run_id` helpers now live in `crate::external_run`; we re-export
//! them here so existing `use crate::codex::runtime::…` call sites stay
//! compiling.

pub use crate::external_run::{emit_chunk_with_run_id, resolve_run_id};

pub fn diagnostics_enabled() -> bool {
    std::env::var("FLOWIX_CODEX_DIAGNOSTICS")
        .map(|value| {
            let value = value.trim().to_ascii_lowercase();
            value == "1" || value == "true" || value == "yes" || value == "on"
        })
        .unwrap_or(false)
}
