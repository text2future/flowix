//! System metadata IPC 鈥?reads and writes `~/.flowix/boot/system.json`.
//!
//! Current scope is memo tag navigation state, grouped by notebook.

use tauri::State;

use crate::system_data::{NotebookTagSystemData, TagLayoutItem};

use crate::app::state::AppState;

#[tauri::command]
pub fn get_tag_system_metadata(
    notebook_id: String,
    state: State<AppState>,
) -> NotebookTagSystemData {
    state.system_data.get_tag_metadata(&notebook_id)
}

#[tauri::command]
pub fn set_tag_system_layout(
    notebook_id: String,
    layout: Vec<TagLayoutItem>,
    state: State<AppState>,
) -> Result<(), String> {
    state
        .system_data
        .set_tag_layout(&notebook_id, layout)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_tag_system_hidden(
    notebook_id: String,
    hidden: Vec<String>,
    state: State<AppState>,
) -> Result<(), String> {
    state
        .system_data
        .set_hidden_tags(&notebook_id, hidden)
        .map_err(|e| e.to_string())
}
