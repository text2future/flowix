//! IPC surface of [`flowix_core::notebook_template`].
//!
//! Each command resolves the registered notebook root and delegates; the
//! extraction rules and the install lock live in the core crate.
use flowix_core::notebook_template::{
    install_template_zip, installed_template_ids, installed_template_marker,
    validate_template_archive_request, validate_template_id, NotebookTemplateArchive,
};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::State;

const MAX_TEMPLATE_PACKAGE_BYTES: usize = 24 * 1024 * 1024;

#[tauri::command]
pub async fn notebook_template_install_zip(
    cwd: String,
    template_id: String,
    archive: NotebookTemplateArchive,
    state: State<'_, crate::app::state::AppState>,
) -> Result<Value, crate::commands::market_package::MarketInstallError> {
    let root = super::helpers::is_registered_notebook_root(Path::new(&cwd), &state)
        .then(|| PathBuf::from(&cwd))
        .ok_or_else(|| "Notebook template install requires a registered notebook".to_string())?;
    let url = validate_template_archive_request(&template_id, &archive)?;
    let bytes =
        crate::commands::market_package::download_market_zip(url, MAX_TEMPLATE_PACKAGE_BYTES)
            .await?;
    let requested_id = template_id.clone();
    let installed_path = tokio::task::spawn_blocking(move || {
        install_template_zip(&root, &template_id, &bytes, &archive)
    })
    .await
    .map_err(|error| format!("Notebook template installation failed: {error}"))??;
    Ok(serde_json::json!({ "path": installed_path, "templateId": requested_id }))
}

#[tauri::command]
pub fn notebook_template_is_installed(
    cwd: String,
    template_id: String,
    state: State<'_, crate::app::state::AppState>,
) -> Result<bool, String> {
    validate_template_id(&template_id)?;
    let root = super::helpers::is_registered_notebook_root(Path::new(&cwd), &state)
        .then(|| PathBuf::from(&cwd))
        .ok_or_else(|| "Notebook template lookup requires a registered notebook".to_string())?;
    installed_template_marker(&root, &template_id)
}

#[tauri::command]
pub fn notebook_template_list_installed(
    cwd: String,
    state: State<'_, crate::app::state::AppState>,
) -> Result<Vec<String>, String> {
    let root = super::helpers::is_registered_notebook_root(Path::new(&cwd), &state)
        .then(|| PathBuf::from(&cwd))
        .ok_or_else(|| "Notebook template lookup requires a registered notebook".to_string())?;
    installed_template_ids(&root)
}
