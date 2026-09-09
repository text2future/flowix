use std::path::Path;

use flowix_core::memo_file::{notebook_path_from_relative, Memo, MemoFile};
use flowix_sync::{v2_content_hash, v2_local_content_diverged, SyncManager};

pub(super) fn delete_cloud_note_locked(
    memo_file: &MemoFile,
    sync: &SyncManager,
    notebook_id: &str,
    note_id: &str,
    before_delete: impl FnOnce(&Path),
) -> Result<Option<Memo>, String> {
    let Some(location) = memo_file
        .resolve_memo_location(note_id)
        .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    if location.notebook.id != notebook_id {
        return Err(format!("CLOUD_NOTE_ID_COLLISION: {note_id}"));
    }
    let path = notebook_path_from_relative(
        Path::new(&location.notebook.path),
        &location.memo.relative_path,
    )
    .unwrap_or_else(|_| Path::new(&location.notebook.path).join(&location.memo.filename));
    let local_hash = match std::fs::read(&path) {
        Ok(bytes) => Some(v2_content_hash(&bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
                "CLOUD_DELETE_READ_FAILED: {}: {error}",
                path.display()
            ))
        }
    };
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
    let memo = memo_file
        .read_memo_for_notebook_id(notebook_id, note_id)
        .ok_or_else(|| format!("CLOUD_NOTE_NOT_FOUND: {note_id}"))?;
    before_delete(&path);
    if memo_file
        .delete_memo_result_for_notebook_id(notebook_id, note_id)
        .map_err(|error| error.to_string())?
    {
        Ok(Some(memo))
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests;
