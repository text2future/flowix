// ==================== Versions ====================
//
// Path-addressed version history IPC.

use std::fs;

use tauri::{AppHandle, State};

use crate::lock_utils::read_lock;
use flowix_core::memo_file::{atomic_write_bytes, FileLockIntent, IsMd, MemoVersionSource, PathVersionMeta};

use crate::app::state::AppState;
use crate::commands::helpers::start_security_bookmark_access;
use crate::watcher::runtime::mark_self_write_for;


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
    let memo_file = read_lock(&state.memo_file, "memo_file");
    memo_file.with_file_write(&notebook_id, &path, FileLockIntent::Existing,
        "create_path_version", |locked_path| {
            let content = fs::read_to_string(locked_path)?;
            memo_file.create_path_version(&notebook_id, &relative_path, &content,
                source.unwrap_or(MemoVersionSource::Manual))
        }).ok()?
}

#[tauri::command]
pub fn restore_path_version(notebook_id: String, relative_path: String, version_id: String,
    expected_content: Option<String>, state: State<AppState>, app: AppHandle) -> Option<String> {
    let path = path_archive_document(&state, &notebook_id, &relative_path)?;
    start_security_bookmark_access(&state, &path);
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let target = memo_file.read_path_version(&notebook_id, &relative_path, &version_id)?;
    let restored = memo_file.with_file_write(&notebook_id, &path, FileLockIntent::Existing,
        "restore_path_version", |locked_path| {
            let current = fs::read_to_string(locked_path)?;
            if expected_content.as_deref().is_some_and(|expected| expected != current) {
                return Ok(false);
            }
            memo_file.create_path_version(&notebook_id, &relative_path, &current,
                MemoVersionSource::RestoreBackup)?;
            atomic_write_bytes(locked_path, target.as_bytes())?;
            Ok(true)
        }).ok()?;
    if !restored { return None; }
    mark_self_write_for(&app, &path);
    crate::commands::helpers::refresh_notebook_note_index(&memo_file, &path);
    Some(target)
}
