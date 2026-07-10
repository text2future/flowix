//! Codex-specific thin re-export layer for the cross-vendor session helpers in
//! `crate::external_run`. The cross-vendor helpers were carved out of this
//! module so Claude (and future external CLIs) can reuse the same
//! drift-detection logic. Older imports of
//! `codex::session::CodexSessionManager` / `select_codex_session_for_runtime`
//! keep working through these aliases.

pub use crate::external_run::ExternalSessionManager;

/// Backwards-compatible type alias so existing call sites keep building.
#[allow(dead_code)]
pub type CodexSessionManager = ExternalSessionManager;

use crate::codex_history::is_codex_session_id;

/// Codex-flavoured wrapper that supplies the `external_session_id_hint` from
/// `is_codex_session_id(thread_id)` so call sites don't have to compute it
/// themselves. Implementation delegates to the shared
/// `select_external_session_for_runtime`.
pub fn select_codex_session_for_runtime(
    mapped_session_id: Option<String>,
    thread_id: &str,
    runtime_key: Option<&str>,
    previous_runtime_key: Option<&str>,
) -> Option<String> {
    let hint = is_codex_session_id(thread_id).then(|| thread_id.to_string());
    crate::external_run::select_external_session_for_runtime(
        mapped_session_id,
        hint,
        runtime_key,
        previous_runtime_key,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::external_run::ExternalSessionManager;

    #[test]
    fn manager_keeps_state_per_thread() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let manager = ExternalSessionManager::new();
            assert!(manager.previous_runtime_key("t").await.is_none());
            manager
                .record_runtime_key("t", "cwd|extra".to_string())
                .await;
            assert_eq!(
                manager.previous_runtime_key("t").await.as_deref(),
                Some("cwd|extra")
            );
        });
    }
}
