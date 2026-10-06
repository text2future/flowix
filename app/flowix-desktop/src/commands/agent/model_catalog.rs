// agent_supported_models) 与前�?invoke 不变�?// ─────────────────────────────────────────────────────────────────────────
use tauri::State;

/// Return the default picker value from the Codex App Server model catalog.
/// The literal fallback only keeps the existing UI usable when the catalog is
/// temporarily empty.
#[tauri::command]
pub async fn codex_default_model(
    state: State<'_, crate::app::state::AppState>,
) -> Result<String, String> {
    if let Some(model) = state
        .codex_app_server
        .supported_models()
        .await?
        .first()
        .cloned()
    {
        return Ok(model);
    }

    Ok("gpt-5.5".to_string())
}

/// Return runtime-supported model ids. Codex discovery is delegated to its
/// long-lived App Server; other runtimes keep their existing catalog sources.
#[tauri::command]
pub async fn agent_supported_models(
    agent_type: String,
    app: tauri::AppHandle,
    state: State<'_, crate::app::state::AppState>,
) -> Result<Vec<String>, String> {
    match agent_type.trim().to_ascii_lowercase().as_str() {
        "codex" => state.codex_app_server.supported_models().await,
        "opencode" => state.opencode.supported_models().await,
        "pi" => state.pi.supported_models(&app).await,
        "deepseek-harness" | "deepseek_harness" | "dsh" => {
            state.deepseek_harness.supported_models().await
        }
        _ => Ok(Vec::new()),
    }
}

/// Snapshot used by the Codex agent badge popover. The app-server owns the
/// account and rate-limit data; the optional thread id selects cached usage.
#[tauri::command]
pub async fn codex_runtime_info(
    thread_id: Option<String>,
    state: State<'_, crate::app::state::AppState>,
) -> Result<serde_json::Value, String> {
    state
        .codex_app_server
        .runtime_info(thread_id.as_deref())
        .await
}
