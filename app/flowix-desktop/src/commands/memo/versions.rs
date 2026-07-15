// ==================== Versions ====================
//
// Memo version history IPC. Distinct from `creates` because versions are
// immutable snapshots keyed by `(memo_id, version_id)` rather than mutating
// the live memo state.

use std::fs;

use tauri::{AppHandle, State};

use crate::lock_utils::read_lock;
use flowix_core::memo_file::{MemoVersionMeta, MemoVersionSource};

use crate::app::state::AppState;
use crate::commands::helpers::start_security_bookmark_access;
use crate::watcher::runtime::mark_self_write_for;

use super::helpers::*;
use super::*;

#[tauri::command]
pub fn list_memo_versions(id: String, state: State<AppState>) -> Vec<MemoVersionMeta> {
    read_lock(&state.memo_file, "memo_file").list_memo_versions(&id)
}

#[tauri::command]
pub fn read_memo_version(id: String, version_id: String, state: State<AppState>) -> Option<String> {
    read_lock(&state.memo_file, "memo_file").read_memo_version(&id, &version_id)
}

#[tauri::command]
pub fn create_memo_version(
    id: String,
    source: Option<MemoVersionSource>,
    state: State<AppState>,
) -> Option<MemoVersionMeta> {
    let path = read_lock(&state.memo_file, "memo_file").find_memo_file_path(&id)?;
    start_security_bookmark_access(&state, &path);
    let content = fs::read_to_string(path).ok()?;
    match read_lock(&state.memo_file, "memo_file").create_memo_version(
        &id,
        &content,
        source.unwrap_or(MemoVersionSource::Manual),
    ) {
        Ok(version) => version,
        Err(e) => {
            eprintln!("[create_memo_version] failed for {id}: {e}");
            None
        }
    }
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn restore_memo_version(
    id: String,
    version_id: String,
    expectedContent: Option<String>,
    state: State<AppState>,
    app: AppHandle,
) -> Option<WriteDocumentResult> {
    let target_content =
        read_lock(&state.memo_file, "memo_file").read_memo_version(&id, &version_id)?;
    let before = read_memo_or_none(state.inner(), &id);
    let current_path = read_lock(&state.memo_file, "memo_file").find_memo_file_path(&id)?;
    start_security_bookmark_access(&state, &current_path);
    let current_content = fs::read_to_string(&current_path).ok()?;

    if let Some(expected) = expectedContent.as_deref() {
        if !cas_content_matches(&current_content, expected, &target_content) {
            eprintln!(
                "[restore_memo_version] CAS refused: key={} disk != expected",
                id
            );
            return None;
        }
    }

    if let Err(e) = read_lock(&state.memo_file, "memo_file").create_memo_version(
        &id,
        &current_content,
        MemoVersionSource::RestoreBackup,
    ) {
        eprintln!("[restore_memo_version] backup version failed for {id}: {e}");
        return None;
    }

    mark_self_write_for(&app, &current_path);
    match read_lock(&state.memo_file, "memo_file")
        .write_memo_renaming_on_title_change_global(&id, &target_content)
    {
        Ok(_) => {
            emit_updated_after_write(state.inner(), &app, &id, before);
            let final_path = read_lock(&state.memo_file, "memo_file").find_memo_file_path(&id)?;
            start_security_bookmark_access(&state, &final_path);
            let final_content = fs::read_to_string(&final_path).ok()?;
            Some(WriteDocumentResult {
                path: final_path.to_string_lossy().to_string(),
                content: final_content,
            })
        }
        Err(e) => {
            eprintln!("[restore_memo_version] restore failed for {id}: {e}");
            None
        }
    }
}

#[tauri::command]
pub fn delete_memo_version(id: String, version_id: String, state: State<AppState>) -> bool {
    read_lock(&state.memo_file, "memo_file").delete_memo_version(&id, &version_id)
}
