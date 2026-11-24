// ==================== Deletes ====================

use std::path::Path;

use tauri::{AppHandle, State};

use crate::lock_utils::read_lock;

use crate::app::state::AppState;
use crate::watcher::runtime::mark_self_write_for;
use flowix_core::NoteService;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeleteMemoOutcome {
    Deleted,
    MissingCleaned,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PruneMissingMemoOutcome {
    Present,
    MissingCleaned,
}

fn emit_deleted_path(app: &AppHandle, notebook_id: &str, relative_path: &str) {
    crate::events::path_change::NotebookPathDeleted::new(
        notebook_id.to_string(),
        relative_path.to_string(),
    )
    .emit(app);
}

fn delete_note_path_internal(
    file_path: &Path,
    state: &AppState,
    app: &AppHandle,
    prune_only: bool,
) -> Result<Option<DeleteMemoOutcome>, String> {
    if !file_path.is_absolute() {
        return Err("absolute note path required".into());
    }
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let (notebook_id, relative_path) =
        super::helpers::notebook_note_address(&memo_file, file_path)?
            .ok_or_else(|| "note path is outside a notebook or is not Markdown".to_string())?;
    let artifact_path =
        match crate::artifact::path_for_note(&notebook_id, &relative_path, &state.memo_file) {
            Ok(path) => path,
            Err(error) => {
                tracing::warn!(
                    notebook_id,
                    relative_path,
                    "skip plugin artifact cleanup while deleting pointer note: {error}"
                );
                None
            }
        };
    let absolute_path = file_path.to_path_buf();
    let deleted = if prune_only {
        if !memo_file
            .prune_missing_note_by_path(&notebook_id, &relative_path)
            .map_err(|error| error.to_string())?
        {
            return Ok(None);
        }
        false
    } else {
        mark_self_write_for(app, &absolute_path);
        NoteService::new(&memo_file)
            .delete(&notebook_id, &relative_path)
            .map_err(|error| error.to_string())?
    };
    drop(memo_file);
    let outcome = if deleted {
        DeleteMemoOutcome::Deleted
    } else {
        DeleteMemoOutcome::MissingCleaned
    };

    crate::commands::document_list::remove_table_note_records(
        &read_lock(&state.memo_file, "memo_file"),
        &notebook_id,
        &relative_path,
    );

    if let Some(artifact_path) = artifact_path {
        if let Err(error) = crate::artifact::remove_path(&artifact_path) {
            tracing::warn!(path = %artifact_path.display(), "plugin artifact cleanup failed: {error}");
        }
    }
    emit_deleted_path(app, &notebook_id, &relative_path);
    Ok(Some(outcome))
}

#[tauri::command]
pub fn delete_memo(
    file_path: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<DeleteMemoOutcome, String> {
    let outcome = delete_note_path_internal(Path::new(&file_path), state.inner(), &app, false)?
        .ok_or_else(|| "note deletion did not complete".to_string())?;
    Ok(outcome)
}

#[tauri::command]
pub fn prune_missing_memo(
    file_path: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<PruneMissingMemoOutcome, String> {
    let outcome = delete_note_path_internal(Path::new(&file_path), state.inner(), &app, true)?;
    if outcome.is_some() {
        Ok(PruneMissingMemoOutcome::MissingCleaned)
    } else {
        Ok(PruneMissingMemoOutcome::Present)
    }
}
