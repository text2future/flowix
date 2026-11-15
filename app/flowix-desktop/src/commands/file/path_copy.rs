//! IPC surface of [`flowix_core::file_copy`].
//!
//! Authorization (registered scopes, cross-notebook access) stays here because
//! it needs `AppState`; the copy itself — collision-free naming, symlink
//! refusal, private-state exclusion — lives in the core crate so the CLI can
//! copy into a notebook without reimplementing those rules.
use std::fs;
use std::path::Path;

use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use super::mutate::{file_mutation_error, validate_file_name};
use super::tree::is_browsable_scope;
use crate::app::state::AppState;
use crate::commands::helpers::{can_access_scoped_file, refresh_notebook_note_index};
use crate::lock_utils::read_lock;
use flowix_core::file_copy::{copy_target, copy_tree};

/// In-app file copying uses registered scopes, rather than a picker/drop grant.
#[tauri::command]
pub async fn copy_path(
    operation_id: Option<String>,
    window: WebviewWindow,
    source_path: String,
    target_directory_path: String,
    source_space_path: String,
    space_path: String,
    copy_suffix: String,
    app: AppHandle,
) -> Result<String, String> {
    super::super::document_operations::run("copy_path", operation_id, window.label().to_owned(), move || {
        let state = app.state::<AppState>();
        let source_scope = Path::new(&source_space_path);
        let target_scope = Path::new(&space_path);
        let source = Path::new(&source_path);
        let directory = Path::new(&target_directory_path);
        if !is_browsable_scope(source_scope, &state)
            || !is_browsable_scope(target_scope, &state)
            || !can_access_scoped_file(source, Some(&source_space_path), &state)
            || !can_access_scoped_file(directory, Some(&space_path), &state)
            || dunce::canonicalize(source).ok() == dunce::canonicalize(source_scope).ok()
        {
            return Err("FILE_PERMISSION_DENIED".into());
        }
        validate_file_name(&format!("copy{copy_suffix}"))?;
        if copy_suffix.trim().is_empty() || copy_suffix.len() > 64 {
            return Err("INVALID_FILE_NAME".into());
        }
        let metadata = fs::symlink_metadata(source).map_err(file_mutation_error)?;
        if metadata.file_type().is_symlink() || !(metadata.is_file() || metadata.is_dir()) {
            return Err("SOURCE_NOT_REGULAR_FILE".into());
        }
        let source = dunce::canonicalize(source).map_err(file_mutation_error)?;
        let directory = dunce::canonicalize(directory).map_err(file_mutation_error)?;
        if !directory.is_dir() { return Err("TARGET_NOT_DIRECTORY".into()); }
        if metadata.is_dir() && directory.starts_with(&source) {
            return Err("INVALID_MOVE_TARGET".into());
        }
        let target = copy_target(&source, &directory, &copy_suffix).map_err(file_mutation_error)?;
        if !can_access_scoped_file(&target, Some(&space_path), &state) {
            return Err("FILE_PERMISSION_DENIED".into());
        }
        let mf = read_lock(&state.memo_file, "memo_file");
        let ids = mf.notebook_ids_for_paths(&[&target]).map_err(file_mutation_error)?;
        let copy = || copy_tree(&source, &target);
        if ids.is_empty() {
            let _guard = mf.acquire_cross_process_write_lock().map_err(file_mutation_error)?;
            copy().map_err(file_mutation_error)?;
        } else {
            mf.with_registered_path_change(&[&target], "copy_path", copy).map_err(file_mutation_error)?;
        }
        // Projections are rebuildable. A refresh failure must not report the
        // durable copy as failed and invite the caller to duplicate it again.
        for id in ids {
            if metadata.is_dir() {
                if let Err(error) = mf.reconcile_note_index(&id) {
                    tracing::warn!(notebook_id = %id, "note index refresh after copy failed: {error}");
                }
                if let Err(error) = mf.reconcile_resources(&id) {
                    tracing::warn!(notebook_id = %id, "resource catalog refresh after copy failed: {error}");
                }
                flowix_core::collection_store::refresh_catalog_best_effort(&mf, &id);
            } else {
                refresh_notebook_note_index(&mf, &target);
                if let Some(config) = mf.get_notebook_config_by_id(&id) {
                    if let Ok(root) = dunce::canonicalize(&config.path) {
                        if let Ok(relative) = target.strip_prefix(&root) {
                            if let Err(error) = mf.refresh_indexed_resource_path(&id, &relative.to_string_lossy().replace('\\', "/")) {
                                tracing::warn!(notebook_id = %id, "resource refresh after copy failed: {error}");
                            }
                        }
                    }
                }
                flowix_core::collection_store::refresh_path(&mf, &target);
            }
            let _ = app.emit("file-management-changed", serde_json::json!({ "notebookId": id }));
        }
        Ok(target.to_string_lossy().into_owned())
    }).await
}
