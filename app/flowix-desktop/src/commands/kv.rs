//! Notebook-scoped metadata IPC.
//!
//! Tag navigation state is stored in each notebook's `.flowix/system.json`.
//! The legacy global system store is read only to migrate a notebook the first
//! time it is accessed.

use std::collections::HashMap;
use std::path::PathBuf;

use tauri::State;

use crate::app::state::AppState;
use crate::system_data::{NotebookTagSystemData, SystemFile, TagLayoutItem, TagSystemData};

#[tauri::command]
pub fn get_tag_system_metadata(
    notebook_id: String,
    state: State<AppState>,
) -> NotebookTagSystemData {
    load_notebook_system(&notebook_id, &state)
        .map(|file| {
            file.tag
                .notebooks
                .get(&notebook_id)
                .cloned()
                .unwrap_or_default()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub fn set_tag_system_layout(
    notebook_id: String,
    layout: Vec<TagLayoutItem>,
    state: State<AppState>,
) -> Result<(), String> {
    let mut file = load_notebook_system(&notebook_id, &state)?;
    let notebook = file.tag.notebooks.entry(notebook_id.clone()).or_default();
    notebook.order = layout.iter().map(|item| item.id.clone()).collect();
    notebook.layout = layout;
    persist_notebook_system(&notebook_id, &state, &file)
}

#[tauri::command]
pub fn set_tag_system_hidden(
    notebook_id: String,
    hidden: Vec<String>,
    state: State<AppState>,
) -> Result<(), String> {
    let mut file = load_notebook_system(&notebook_id, &state)?;
    file.tag
        .notebooks
        .entry(notebook_id.clone())
        .or_default()
        .hidden = hidden;
    persist_notebook_system(&notebook_id, &state, &file)
}

/// Write the MRU pinned list for one parent. An empty list removes that key.
#[tauri::command]
pub fn set_tag_system_pinned(
    notebook_id: String,
    parent_id: String,
    pinned: Vec<String>,
    state: State<AppState>,
) -> Result<(), String> {
    let mut file = load_notebook_system(&notebook_id, &state)?;
    let notebook = file.tag.notebooks.entry(notebook_id.clone()).or_default();
    let key = if parent_id.is_empty() {
        ""
    } else {
        parent_id.as_str()
    };
    if pinned.is_empty() {
        notebook.pinned_by_parent.remove(key);
    } else {
        notebook.pinned_by_parent.insert(key.to_string(), pinned);
    }
    persist_notebook_system(&notebook_id, &state, &file)
}

fn notebook_root(notebook_id: &str, state: &State<AppState>) -> Result<PathBuf, String> {
    state
        .memo_file
        .read()
        .map_err(|_| "memo file lock poisoned".to_string())?
        .get_notebook_config_by_id(notebook_id)
        .map(|config| PathBuf::from(config.path))
        .ok_or_else(|| format!("notebook not found: {notebook_id}"))
}

fn load_notebook_system(notebook_id: &str, state: &State<AppState>) -> Result<SystemFile, String> {
    let root = notebook_root(notebook_id, state)?;
    if let Some(file) =
        crate::system_data::SystemData::read_notebook(&root).map_err(|error| error.to_string())?
    {
        return Ok(file);
    }
    let legacy = state.system_data.get_tag_metadata(notebook_id);
    let mut notebooks = HashMap::new();
    notebooks.insert(notebook_id.to_string(), legacy);
    let file = SystemFile {
        tag: TagSystemData { notebooks },
    };
    crate::system_data::SystemData::write_notebook(&root, &file)
        .map_err(|error| error.to_string())?;
    Ok(file)
}

fn persist_notebook_system(
    notebook_id: &str,
    state: &State<AppState>,
    file: &SystemFile,
) -> Result<(), String> {
    let root = notebook_root(notebook_id, state)?;
    crate::system_data::SystemData::write_notebook(&root, file).map_err(|error| error.to_string())
}
