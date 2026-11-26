//! Notebook workspace IPC. All active data is stored in db/local.db.
use crate::{app::state::AppState, events as dispatcher};
use flowix_core::memo_file::NotebookWorkspaceSnapshot;
use tauri::{AppHandle, State};

pub(crate) const AGENT_WORKSPACE_CHANGED_EVENT: &str = "agent-workspace-changed";

#[tauri::command]
pub fn get_agent_workspace(state: State<AppState>) -> Result<NotebookWorkspaceSnapshot, String> {
    state
        .memo_file
        .read()
        .map_err(|_| "memo file lock poisoned".to_string())?
        .read_notebook_workspace()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn attach_notebook_directory(
    notebook_id: String,
    path: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<NotebookWorkspaceSnapshot, String> {
    update(&state, &app, &notebook_id, &path, true)
}

#[tauri::command]
pub fn detach_notebook_directory(
    notebook_id: String,
    path: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<NotebookWorkspaceSnapshot, String> {
    update(&state, &app, &notebook_id, &path, false)
}

#[tauri::command]
pub async fn pick_notebook_directory(
    notebook_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Option<NotebookWorkspaceSnapshot>, String> {
    // Reject an invalid scope before showing a picker or creating any state.
    if state
        .memo_file
        .read()
        .map_err(|_| "memo file lock poisoned")?
        .get_notebook_config_by_id(&notebook_id)
        .is_none()
    {
        return Err("notebook not found".into());
    }
    let Some(path) = super::dialog::select_directory(app.clone(), None).await else {
        return Ok(None);
    };
    update(&state, &app, &notebook_id, &path, true).map(Some)
}

fn update(
    state: &AppState,
    app: &AppHandle,
    notebook_id: &str,
    path: &str,
    attach: bool,
) -> Result<NotebookWorkspaceSnapshot, String> {
    let snapshot = state
        .memo_file
        .read()
        .map_err(|_| "memo file lock poisoned")?
        .update_notebook_add_dir(notebook_id, path, attach)
        .map_err(|e| e.to_string())?;
    dispatcher::emit_to(app, AGENT_WORKSPACE_CHANGED_EVENT, ());
    Ok(snapshot)
}
