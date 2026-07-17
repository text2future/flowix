// ==================== Deletes ====================

use std::path::Path;

use tauri::{AppHandle, State};

use crate::lock_utils::read_lock;
use crate::memo_events::{self, MemoDerivedChanged, MemoEvent};

use crate::app::search_index::{force_rebuild_index, try_index_remove};
use crate::app::state::AppState;
use crate::watcher::runtime::mark_self_write_for;
use flowix_core::MemoService;

use super::helpers::*;

#[tauri::command]
pub fn delete_memo(id: String, state: State<AppState>, app: AppHandle) -> bool {
    try_index_remove(state.inner(), &id);
    let before = read_memo_or_none(state.inner(), &id);
    let notebook_id = notebook_id_for_memo(state.inner(), &id);
    let abs_path = abs_path_for(state.inner(), &id);
    // Mark before deleting so the watcher suppresses our own remove event.
    if !abs_path.is_empty() {
        mark_self_write_for(&app, Path::new(&abs_path));
    }
    let ok = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .delete_memo(&id)
        .map(|deleted| deleted.file_removed)
        .unwrap_or(false);
    if ok {
        let derived_changed = before
            .as_ref()
            .map(MemoDerivedChanged::from_deleted)
            .unwrap_or_default();
        memo_events::emit(
            &app,
            MemoEvent::Deleted {
                id,
                path: abs_path,
                notebook_id,
                derived_changed,
            },
        );
    }
    ok
}

#[tauri::command]
pub fn clear_memos(notebook_id: Option<String>, state: State<AppState>, app: AppHandle) -> bool {
    let mut deleted_paths: Vec<(String, String, String, MemoDerivedChanged)> = Vec::new();
    let success = {
        let memos = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
            .list_memos_filtered(notebook_id.as_deref(), "all", "createdAt", None);
        let mut success = true;
        for memo in memos {
            let (abs_path, resolved_notebook_id) =
                MemoService::new(&read_lock(&state.memo_file, "memo_file"))
                    .resolve_memo(&memo.id)
                    .map(|resolved| (resolved.path.display().to_string(), resolved.notebook.id))
                    .unwrap_or_default();
            if !abs_path.is_empty() {
                mark_self_write_for(&app, Path::new(&abs_path));
            }
            if !MemoService::new(&read_lock(&state.memo_file, "memo_file"))
                .delete_memo(&memo.id)
                .map(|deleted| deleted.file_removed)
                .unwrap_or(false)
            {
                success = false;
                continue;
            }
            let deleted_notebook_id = notebook_id.clone().unwrap_or(resolved_notebook_id);
            let derived_changed = MemoDerivedChanged::from_deleted(&memo);
            deleted_paths.push((memo.id, abs_path, deleted_notebook_id, derived_changed));
        }
        success
    };
    if success {
        force_rebuild_index(state.inner(), &app);
    }
    for (id, path, notebook_id, derived_changed) in &deleted_paths {
        memo_events::emit(
            &app,
            MemoEvent::Deleted {
                id: id.clone(),
                path: path.clone(),
                notebook_id: notebook_id.clone(),
                derived_changed: derived_changed.clone(),
            },
        );
    }
    success
}
