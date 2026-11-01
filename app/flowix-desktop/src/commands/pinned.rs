//! Pinned entry IPC.
//!
//! The pinned section mixes notes, indexed documents, and collections in one
//! list ordered by creation time, so the query lives in core and this command
//! only guards notebook scope and paging bounds.

use flowix_core::memo_file::PinnedEntryPage;
use tauri::{Manager, State};

use crate::app::state::AppState;
use crate::lock_utils::read_lock;

const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 500;

#[tauri::command]
pub async fn list_pinned_entries(
    notebook_id: String,
    cursor: Option<String>,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<PinnedEntryPage, String> {
    let memo = state.memo_file.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let memo = read_lock(&memo, "memo_file");
        let _guard = memo
            .operation_locks()
            .notebook_read(&notebook_id, "list_pinned_entries")
            .map_err(|error| error.to_string())?;
        memo.list_pinned_entries(
            &notebook_id,
            cursor.as_deref(),
            limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT),
        )
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}
