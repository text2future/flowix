use std::sync::Arc;

use crate::external_runtime::claude::ClaudeCliManager;
use crate::external_runtime::codex::CodexCliManager;

const EXTERNAL_AGENT_WATCHDOG_INTERVAL_MS: u64 = 5_000;
const EXTERNAL_AGENT_DEFAULT_IDLE_TIMEOUT_MS: i64 = 30 * 60 * 1_000;

fn external_agent_watchdog_idle_timeout_ms() -> i64 {
    std::env::var("FLOWIX_EXTERNAL_AGENT_IDLE_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value >= 0)
        .unwrap_or(EXTERNAL_AGENT_DEFAULT_IDLE_TIMEOUT_MS)
}

pub fn spawn_external_agent_watchdog(
    app_handle: tauri::AppHandle,
    codex_cli_manager: Arc<CodexCliManager>,
    claude_cli_manager: Arc<ClaudeCliManager>,
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
            if codex + claude > 0 {
                tracing::warn!(
                    "external agent watchdog finalized runs: codex={codex}, claude={claude}, idle_timeout_ms={idle_timeout_ms}"
                );
            }
        }
    });
}
