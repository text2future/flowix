//! IPC surface of [`crate::file_watch`].
//!
//! Both commands are thin: they authorize the root against the registered
//! notebooks and then hand the lease to the watcher subsystem.
use crate::app::state::AppState;
use crate::commands::helpers::{
    is_attached_notebook_directory_with_state, is_registered_notebook_path_with_state,
};
use crate::file_watch::FileBrowserWatchState;
use std::path::PathBuf;

#[tauri::command]
pub fn watch_file_browser_root(
    window: tauri::WebviewWindow,
    watches: tauri::State<'_, FileBrowserWatchState>,
    app_state: tauri::State<'_, AppState>,
    root_path: String,
) -> Result<String, String> {
    let path = PathBuf::from(&root_path);
    if !path.is_dir()
        || (!is_registered_notebook_path_with_state(&path, &app_state)
            && !is_attached_notebook_directory_with_state(&path, &app_state))
    {
        return Err(format!(
            "file browser root is not accessible: {}",
            path.display()
        ));
    }
    watches.watch(window.label(), path)
}

#[tauri::command]
pub fn unwatch_file_browser_root(
    window: tauri::WebviewWindow,
    watches: tauri::State<'_, FileBrowserWatchState>,
    lease_id: String,
) -> Result<(), String> {
    watches.unwatch(window.label(), &lease_id)
}
