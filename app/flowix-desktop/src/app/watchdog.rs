use std::sync::Arc;

use crate::agent_external::claude::ClaudeCliManager;
use crate::agent_external::codex::CodexCliManager;
use crate::agent_external::hermes::HermesCliManager;
use crate::agent_external::simple_cli::SimpleCliManager;

const EXTERNAL_AGENT_WATCHDOG_INTERVAL_MS: u64 = 5_000;
const EXTERNAL_AGENT_DEFAULT_IDLE_TIMEOUT_MS: i64 = 30 * 60 * 1_000;

fn external_agent_watchdog_idle_timeout_ms() -> i64 {
    std::env::var("FLOWIX_EXTERNAL_AGENT_IDLE_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value >= 0)
        .unwrap_or(EXTERNAL_AGENT_DEFAULT_IDLE_TIMEOUT_MS)
}

/// Spawn the idle-watchdog that finalizes external-CLI runs which have gone
/// silent (no stdout event for `idle_timeout_ms`). The watchdog must cover
/// **every** external runtime -- a hung child in any vendor would otherwise
/// leak (its registry entry lingers, blocking future runs on that thread, and
/// on Unix its process group is never reaped).
#[allow(clippy::too_many_arguments)]
pub fn spawn_external_agent_watchdog(
    app_handle: tauri::AppHandle,
    codex_cli_manager: Arc<CodexCliManager>,
    claude_cli_manager: Arc<ClaudeCliManager>,
    hermes_cli_manager: Arc<HermesCliManager>,
    gemini_cli_manager: Arc<SimpleCliManager>,
    openclaw_cli_manager: Arc<SimpleCliManager>,
) {
    let idle_timeout_ms = external_agent_watchdog_idle_timeout_ms();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(
            EXTERNAL_AGENT_WATCHDOG_INTERVAL_MS,
        ));
        loop {
            interval.tick().await;
            let codex = codex_cli_manager
                .reap_inactive_runs(&app_handle, idle_timeout_ms)
                .await;
            let claude = claude_cli_manager
                .reap_inactive_runs(&app_handle, idle_timeout_ms)
                .await;
            let hermes = hermes_cli_manager
                .reap_inactive_runs(&app_handle, idle_timeout_ms)
                .await;
            let gemini = gemini_cli_manager
                .reap_inactive_runs(&app_handle, idle_timeout_ms)
                .await;
            let openclaw = openclaw_cli_manager
                .reap_inactive_runs(&app_handle, idle_timeout_ms)
                .await;
            let total = codex + claude + hermes + gemini + openclaw;
            if total > 0 {
                tracing::warn!(
                    "external agent watchdog finalized runs: codex={codex}, claude={claude}, hermes={hermes}, gemini={gemini}, openclaw={openclaw}, idle_timeout_ms={idle_timeout_ms}"
                );
            }
        }
    });
}
