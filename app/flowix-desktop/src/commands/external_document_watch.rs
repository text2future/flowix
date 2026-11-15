//! IPC surface of [`crate::external_watch`].

use crate::app::state::AppState;
use crate::commands::external_document::exact_existing_external_path;
use crate::external_watch::ExternalDocumentWatchState;

#[tauri::command]
pub fn watch_external_document(
    window: tauri::WebviewWindow,
    watches: tauri::State<'_, ExternalDocumentWatchState>,
    app_state: tauri::State<'_, AppState>,
    file_path: String,
    #[allow(non_snake_case)] scopePath: Option<String>,
) -> Result<String, String> {
    let path =
        exact_existing_external_path(&file_path, scopePath.as_deref(), window.label(), &app_state)?;
    watches.watch(window.label(), path)
}

#[tauri::command]
pub fn unwatch_external_document(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ExternalDocumentWatchState>,
    lease_id: String,
) -> Result<(), String> {
    state.unwatch(window.label(), &lease_id)
}
