//! IPC surface of [`crate::skill_market_ui`].

use crate::app::state::AppState;
use crate::skill_market_ui::{ensure_entry_path, SkillMarketUiPage};
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub async fn ensure_skill_market_ui(
    app: AppHandle,
    state: State<'_, AppState>,
    language: String,
) -> Result<SkillMarketUiPage, String> {
    let cloud_base = state.cloud_environment.api_base().to_string();
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("resolve Flowix data directory: {error}"))?
        .join("skill-market-ui")
        .join(state.cloud_environment.name());
    ensure_entry_path(cloud_base, root, &language).await
}
