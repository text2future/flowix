// ==================== Versions ====================
//
// Memo version history IPC. Distinct from `creates` because versions are
// immutable snapshots keyed by `(memo_id, version_id)` rather than mutating
// the live memo state.

use std::fs;

use tauri::{AppHandle, State};

use crate::lock_utils::read_lock;
use flowix_core::memo_file::{FileWriteOutcome, IsMd, MemoVersionMeta, MemoVersionSource, PathVersionMeta};
use flowix_core::MemoService;

use crate::app::state::AppState;
use crate::commands::helpers::start_security_bookmark_access;
use crate::watcher::runtime::mark_self_write_for;

use super::helpers::*;
use super::*;

fn path_archive_document(state: &AppState, notebook_id: &str, relative_path: &str) -> Option<std::path::PathBuf> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let notebook = memo_file.get_notebook_config_by_id(notebook_id)?;
    let root = std::path::PathBuf::from(notebook.path).canonicalize().ok()?;
    let relative = std::path::Path::new(relative_path);
    if relative.is_absolute() || !relative.is_md()
        || relative.components().any(|part| !matches!(part, std::path::Component::Normal(_))) {
        return None;
    }
    let path = root.join(relative).canonicalize().ok()?;
    (path.starts_with(root) && path.is_file()).then_some(path)
}

#[tauri::command]
pub fn list_path_versions(notebook_id: String, relative_path: String, state: State<AppState>) -> Vec<PathVersionMeta> {
    read_lock(&state.memo_file, "memo_file").list_path_versions(&notebook_id, &relative_path)
}

#[tauri::command]
pub fn create_path_version(notebook_id: String, relative_path: String, source: Option<MemoVersionSource>, state: State<AppState>) -> Option<PathVersionMeta> {
    let path = path_archive_document(&state, &notebook_id, &relative_path)?;
    start_security_bookmark_access(&state, &path);
    let content = fs::read_to_string(path).ok()?;
    read_lock(&state.memo_file, "memo_file")
        .create_path_version(&notebook_id, &relative_path, &content, source.unwrap_or(MemoVersionSource::Manual))
        .ok()?
}

#[tauri::command]
pub fn restore_path_version(notebook_id: String, relative_path: String, version_id: String,
    expected_content: Option<String>, state: State<AppState>, app: AppHandle) -> Option<String> {
    let path = path_archive_document(&state, &notebook_id, &relative_path)?;
    start_security_bookmark_access(&state, &path);
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let target = memo_file.read_path_version(&notebook_id, &relative_path, &version_id)?;
    let current = fs::read_to_string(&path).ok()?;
    if expected_content.as_deref().is_some_and(|expected| expected != current) { return None; }
    memo_file.create_path_version(&notebook_id, &relative_path, &current, MemoVersionSource::RestoreBackup).ok()?;
    match memo_file.write_file_if_matches(&path, &target, Some(&current)).ok()? {
        FileWriteOutcome::Saved => {
            mark_self_write_for(&app, &path);
            crate::commands::helpers::refresh_notebook_note_index(&memo_file, &path);
            Some(target)
        },
        _ => None,
    }
}

#[tauri::command]
pub fn list_memo_versions(id: String, state: State<AppState>) -> Vec<MemoVersionMeta> {
    MemoService::new(&read_lock(&state.memo_file, "memo_file")).list_memo_versions(&id)
}

#[tauri::command]
pub fn read_memo_version(id: String, version_id: String, state: State<AppState>) -> Option<String> {
    MemoService::new(&read_lock(&state.memo_file, "memo_file")).read_memo_version(&id, &version_id)
}

#[tauri::command]
pub fn create_memo_version(
    id: String,
    source: Option<MemoVersionSource>,
    state: State<AppState>,
) -> Option<MemoVersionMeta> {
    let path = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .resolve_memo(&id)
        .ok()?
        .path;
    start_security_bookmark_access(&state, &path);
    let content = fs::read_to_string(path).ok()?;
    match MemoService::new(&read_lock(&state.memo_file, "memo_file")).create_memo_version(
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
    file_path: String,
    version_id: String,
    expectedContent: Option<String>,
    state: State<AppState>,
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Option<WriteDocumentResult> {
    if !std::path::Path::new(&file_path).is_absolute() {
        return None;
    }
    let resolved = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .resolve_memo(&file_path)
        .ok()?;
    if resolved.id != id {
        return None;
    }
    let target_content = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .read_memo_version(&id, &version_id)?;
    let before = read_memo_or_none(state.inner(), &id);
    let current_path = resolved.path;
    start_security_bookmark_access(&state, &current_path);
    let result = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        MemoService::new(&memo_file).save_memo_with_receipt(
            &file_path,
            &target_content,
            false,
            |resolved, current| {
                if resolved.id != id {
                    return Err(flowix_core::FlowixError::Conflict(
                        "document at path was replaced".into(),
                    ));
                }
                if expectedContent.as_deref().is_some_and(|expected| {
                    !cas_content_matches(current, expected, &target_content)
                }) {
                    return Err(flowix_core::FlowixError::Conflict(format!(
                        "memo {id} changed on disk"
                    )));
                }
                memo_file.create_memo_version(&id, current, MemoVersionSource::RestoreBackup)?;
                mark_self_write_for(&app, &resolved.path);
                Ok(())
            },
        )
    };
    match result {
        Ok(receipt) => {
            start_security_bookmark_access(&state, &receipt.edited.path);
            emit_saved_memo_receipt(&app, receipt, before, window.label())
        }
        Err(e) => {
            eprintln!("[restore_memo_version] restore failed for {id}: {e}");
            None
        }
    }
}

#[tauri::command]
pub fn delete_memo_version(id: String, version_id: String, state: State<AppState>) -> bool {
    MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .delete_memo_version(&id, &version_id)
}
