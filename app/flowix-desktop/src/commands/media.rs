//! Media resource IPC.
//!
//! Media bytes stay in the notebook. User properties and resource identity are
//! stored in the notebook-local `.flowix/notebook.db`.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use flowix_core::memo_file::{
    media_kind_for_path, notebook_relative_path, MediaResource, MediaResourceKind,
    MediaResourcePage, MemoFile,
};

use crate::app::state::AppState;
use crate::lock_utils::read_lock;

use super::helpers::{can_access_scoped_file, start_security_bookmark_access};

fn registered_notebook_for_path(
    memo_file: &MemoFile,
    notebook_path: &Path,
) -> Result<(String, PathBuf), String> {
    let requested = dunce::canonicalize(notebook_path).map_err(|error| error.to_string())?;
    memo_file
        .read_notebook_configs()
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter_map(|config| {
            let root = dunce::canonicalize(&config.path).ok()?;
            requested.starts_with(&root).then_some((config.id, root))
        })
        .max_by_key(|(_, root)| root.components().count())
        .ok_or_else(|| "notebook is not registered".to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaResourceResponse {
    pub resource: MediaResource,
}

#[tauri::command]
pub fn list_media_resources_page(
    notebook_path: String,
    kinds: Vec<String>,
    cursor: Option<String>,
    limit: Option<usize>,
    state: State<AppState>,
) -> Result<MediaResourcePage, String> {
    let requested = dunce::canonicalize(&notebook_path).map_err(|error| error.to_string())?;
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let (notebook_id, root) = registered_notebook_for_path(&memo_file, &requested)?;
    if root != requested {
        return Err("media library must use a notebook root path".to_string());
    }
    let kinds = kinds
        .iter()
        .map(|kind| match kind.as_str() {
            "image" => Ok(MediaResourceKind::Image),
            "video" => Ok(MediaResourceKind::Video),
            _ => Err("invalid media kind".to_string()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if kinds.is_empty() {
        return Ok(MediaResourcePage { resources: Vec::new(), next_cursor: None, has_more: false });
    }
    let cursor = cursor
        .map(|value| {
            let (created_at, id) = value.split_once(':').ok_or("INVALID_CURSOR")?;
            let created_at = created_at.parse::<i64>().map_err(|_| "INVALID_CURSOR")?;
            if id.is_empty() || id.contains('\0') { return Err("INVALID_CURSOR"); }
            Ok((created_at, id.to_string()))
        })
        .transpose()?;
    memo_file
        .list_media_resources_page(&notebook_id, &kinds, cursor, limit.unwrap_or(60))
        .map_err(|error| error.to_string())
}

/// Read or create the notebook-local media index entry for a file.
#[tauri::command]
pub fn get_media_resource(
    file_path: String,
    notebook_path: String,
    state: State<AppState>,
) -> Result<MediaResourceResponse, String> {
    let file = dunce::canonicalize(&file_path).map_err(|error| error.to_string())?;
    let notebook = Path::new(&notebook_path);
    if !can_access_scoped_file(&file, Some(notebook_path.as_str()), &state) {
        return Err("media path is outside the notebook scope".to_string());
    }
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let (notebook_id, root) = registered_notebook_for_path(&memo_file, notebook)?;
    let kind =
        media_kind_for_path(&file).ok_or_else(|| "not an image or video file".to_string())?;
    let relative = notebook_relative_path(&root, &file)?;
    let resource = memo_file
        .ensure_media_resource(&notebook_id, &relative, kind, &file)
        .map_err(|error| error.to_string())?;
    start_security_bookmark_access(&state, &file);
    Ok(MediaResourceResponse { resource })
}

/// Save media properties directly in the notebook-local index database.
#[tauri::command]
pub fn update_media_resource(
    file_path: String,
    notebook_path: String,
    resource_id: String,
    properties: serde_json::Value,
    expected_properties_revision: Option<i64>,
    state: State<AppState>,
    app: AppHandle,
) -> Result<MediaResourceResponse, String> {
    let file = dunce::canonicalize(&file_path).map_err(|error| error.to_string())?;
    let notebook = Path::new(&notebook_path);
    if !can_access_scoped_file(&file, Some(notebook_path.as_str()), &state) {
        return Err("media path is outside the notebook scope".to_string());
    }
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let (notebook_id, root) = registered_notebook_for_path(&memo_file, notebook)?;
    let relative = notebook_relative_path(&root, &file)?;
    let resource = memo_file
        .ensure_media_resource(
            &notebook_id,
            &relative,
            media_kind_for_path(&file).ok_or_else(|| "not a media file".to_string())?,
            &file,
        )
        .map_err(|error| error.to_string())?;
    if resource.id != resource_id {
        return Err("media resource identity changed; reload and retry".to_string());
    }
    let updated = memo_file
        .update_media_resource_properties_if_revision(
            &notebook_id,
            &resource_id,
            &properties,
            expected_properties_revision,
        )
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "media resource disappeared".to_string())?;
    let _ = app.emit("media-properties-changed", serde_json::json!({ "notebookId": notebook_id }));
    Ok(MediaResourceResponse { resource: updated })
}

/// Delete a media file and retain its database row as a tombstone so a
/// temporary filesystem absence cannot immediately destroy its properties.
#[tauri::command]
pub fn delete_media_resource(
    file_path: String,
    notebook_path: String,
    state: State<AppState>,
) -> Result<bool, String> {
    let file = dunce::canonicalize(&file_path).map_err(|error| error.to_string())?;
    let notebook = Path::new(&notebook_path);
    if !can_access_scoped_file(&file, Some(notebook_path.as_str()), &state) {
        return Err("media path is outside the notebook scope".to_string());
    }
    let kind =
        media_kind_for_path(&file).ok_or_else(|| "not an image or video file".to_string())?;
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let (notebook_id, root) = registered_notebook_for_path(&memo_file, notebook)?;
    let relative = notebook_relative_path(&root, &file)?;
    let resource = memo_file
        .ensure_media_resource(&notebook_id, &relative, kind, &file)
        .map_err(|error| error.to_string())?;
    start_security_bookmark_access(&state, &file);
    memo_file
        .delete_file_for_notebook(&notebook_id, &file)
        .map_err(|error| error.to_string())?;
    if !memo_file
        .mark_media_resource_deleted(&notebook_id, &resource.id)
        .map_err(|error| error.to_string())?
    {
        return Err("media resource disappeared after file deletion".to_string());
    }
    Ok(true)
}
