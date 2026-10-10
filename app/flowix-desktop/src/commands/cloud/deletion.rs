use std::path::Path;

use flowix_core::memo_file::{notebook_path_from_relative, Memo, MemoFile};
use flowix_sync::{v2_content_hash, v2_local_content_diverged, SyncManager};
use super::local_adapter::{cloud_conflict_copy_path, register_preserved_conflict_copy,
    safely_remove_conflict_file, ConflictFileOutcome};

pub(super) fn delete_cloud_note_locked(
    memo_file: &MemoFile,
    sync: &SyncManager,
    notebook_id: &str,
    note_id: &str,
    relative_path: &str,
    before_delete: impl FnOnce(&Path),
) -> Result<Option<Memo>, String> {
    // Cloud v2 note ids are path-derived; the local note is addressed by the
    // same relative path. Legacy id-based lookup is no longer supported.
    let memo = memo_file.find_memo_by_relative_path_for_notebook_id(notebook_id, relative_path);
    let Some(memo) = memo else { return Ok(None) };
    let notebook = memo_file.get_notebook_config_by_id(notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let path = notebook_path_from_relative(
        Path::new(&notebook.path),
        &memo.relative_path,
    )
    .unwrap_or_else(|_| Path::new(&notebook.path).join(&memo.filename));
    let local_bytes = match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
                "CLOUD_DELETE_READ_FAILED: {}: {error}",
                path.display()
            ))
        }
    };
    let local_hash = local_bytes.as_ref().map(|bytes| v2_content_hash(bytes));
    let baseline = sync
        .v2_note_state(note_id)
        .map_err(|error| error.to_string())?;
    let pending = sync
        .has_pending_v2_note_change(note_id)
        .map_err(|error| error.to_string())?;
    if v2_local_content_diverged(
        local_hash.as_deref(),
        baseline
            .as_ref()
            .and_then(|state| state.content_hash.as_deref()),
        pending,
    ) {
        return Err(format!(
            "CLOUD_DELETE_CONFLICT: local changes preserved: {}",
            path.display()
        ));
    }
    before_delete(&path);
    if let Some(expected) = local_bytes.as_deref() {
        let copy = cloud_conflict_copy_path(&path, note_id);
        match safely_remove_conflict_file(&path, expected, note_id, &copy)? {
            ConflictFileOutcome::Applied { preserved: None } => {},
            outcome => {
                let preserved = match outcome {
                    ConflictFileOutcome::Applied { preserved } | ConflictFileOutcome::Interrupted { preserved } => preserved,
                };
                if let Some(preserved) = preserved {
                    register_preserved_conflict_copy(memo_file, notebook_id,
                        Path::new(&notebook.path), &preserved, false)?;
                }
                return Err(format!("CLOUD_DELETE_CONFLICT: local changes preserved: {}", path.display()));
            }
        }
    }
    if !memo_file.prune_deleted_memo_for_notebook_id(notebook_id, &memo.relative_path, &memo.id)
        .map_err(|error| error.to_string())? {
        return Err(format!("CLOUD_DELETE_CONFLICT: path was recreated: {}", path.display()));
    }
    Ok(Some(memo))
}

#[cfg(test)]
mod tests;
