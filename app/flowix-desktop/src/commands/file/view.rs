//! 笔记本视图偏好（`.flowix/view-preferences.json`）的读写与随移动而 rebase。
//!
//! 文件里只剩 `defaultCreateFolder` 一项，但它是全仓唯一「不可从磁盘推导」的
//! 状态：目录改名/移动之后必须跟着改，否则新建笔记会悄悄落回根目录。所以两个
//! rebase 入口也留在这里，调用方只负责给出 source / target。
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::app::state::AppState;
use crate::commands::helpers::is_registered_notebook_root;
use crate::lock_utils::read_lock;
use flowix_core::memo_file::{FileManagementPolicy, MemoFile};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookFolderOption {
    pub relative_path: String,
    pub depth: usize,
}

/// Notebook-local view preferences. The former `fileManagement` policy
/// (user-configured index exclusions) has been removed; only the default
/// note folder remains. Unknown keys in existing `view-preferences.json`
/// files are ignored on read and dropped on the next write.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookViewPreferences {
    #[serde(default)]
    pub default_create_folder: Option<String>,
}

fn notebook_preferences_path(root: &Path) -> Result<std::path::PathBuf, String> {
    let flowix_dir = root.join(".flowix");
    match fs::symlink_metadata(&flowix_dir) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("INVALID_NOTEBOOK_CONFIG_DIRECTORY".to_string());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("inspect notebook config directory failed: {error}")),
    }
    Ok(flowix_dir.join("view-preferences.json"))
}

fn read_notebook_view_preferences(root: &Path) -> NotebookViewPreferences {
    let Ok(path) = notebook_preferences_path(root) else {
        return NotebookViewPreferences::default();
    };
    let Some(bytes) = (match fs::read(&path) {
        Ok(bytes) => Some(bytes),
        // Compatibility with the release that stored view preferences in the
        // same file as the notebook identity manifest.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::read(root.join(".flowix/notebook.json")).ok()
        }
        Err(_) => None,
    }) else {
        return NotebookViewPreferences::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

pub(crate) fn default_create_folder_for_notebook(root: &Path) -> Result<Option<String>, String> {
    flowix_core::memo_file::default_create_folder_for_notebook(root)
}

pub(crate) fn write_default_notebook_view_preferences(root: &Path) -> Result<(), String> {
    let path = notebook_preferences_path(root)?;
    fs::create_dir_all(path.parent().ok_or("INVALID_NOTEBOOK_CONFIG_DIRECTORY")?)
        .map_err(|error| format!("create notebook config directory failed: {error}"))?;
    let bytes = serde_json::to_vec_pretty(&NotebookViewPreferences::default())
        .map_err(|error| format!("serialize default notebook preferences failed: {error}"))?;
    flowix_core::memo_file::atomic_write_bytes(&path, &bytes)
        .map_err(|error| format!("write default notebook preferences failed: {error}"))
}

fn with_registered_notebook_change<T>(
    root: &Path,
    memo: &MemoFile,
    operation: &str,
    change: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    memo.with_registered_path_change(&[root], operation, || Ok(change()))
        .map_err(|error| error.to_string())?
}

fn normalize_default_create_folder(folder: Option<String>) -> Result<Option<String>, String> {
    let Some(folder) = folder else {
        return Ok(None);
    };
    let trimmed = folder.trim_matches('/');
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.contains('\\') || trimmed.contains('\0') {
        return Err("INVALID_NOTEBOOK_FOLDER_PREFERENCE".to_string());
    }
    let path = Path::new(trimmed);
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("INVALID_NOTEBOOK_FOLDER_PREFERENCE".to_string());
    }
    Ok(Some(path.to_string_lossy().replace('\\', "/")))
}

fn collect_notebook_folders(
    root: &Path,
    directory: &Path,
    policy: &FileManagementPolicy,
    folders: &mut Vec<NotebookFolderOption>,
) -> Result<(), String> {
    let entries = fs::read_dir(directory).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        // Only indexable folders can host new notes: anything the index skips
        // would make the created note disappear from every list.
        if policy.is_index_hidden_at(root, relative) {
            continue;
        }
        let relative_path = relative.to_string_lossy().replace('\\', "/");
        let depth = relative.components().count();
        folders.push(NotebookFolderOption {
            relative_path,
            depth,
        });
        collect_notebook_folders(root, &path, policy, folders)?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_notebook_folder_options(
    notebook_path: String,
    state: State<AppState>,
) -> Result<Vec<NotebookFolderOption>, String> {
    let root = Path::new(&notebook_path);
    if !is_registered_notebook_root(root, &state) {
        return Err("NOTEBOOK_NOT_REGISTERED".to_string());
    }
    let policy = FileManagementPolicy::from_notebook_root(root);
    let mut folders = Vec::new();
    collect_notebook_folders(root, root, &policy, &mut folders)?;
    folders.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(folders)
}

/// Bounded folder listing for sandboxed HTML pages. Keep filesystem traversal
/// off the command thread and disclose truncation rather than silently omitting
/// folders. The ordinary picker retains its existing full listing.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlNotebookFolders {
    folders: Vec<NotebookFolderOption>,
    default_relative_path: String,
    truncated: bool,
}

#[tauri::command]
pub async fn get_html_notebook_folders(
    notebook_path: String,
    state: State<'_, AppState>,
) -> Result<HtmlNotebookFolders, String> {
    if !is_registered_notebook_root(Path::new(&notebook_path), &state) {
        return Err("NOTEBOOK_NOT_REGISTERED".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(notebook_path);
        let default_relative_path = default_create_folder_for_notebook(&root)?.unwrap_or_default();
        let policy = FileManagementPolicy::from_notebook_root(&root);
        let mut pending = vec![root.clone()];
        let mut folders = Vec::new();
        let mut scanned = 0usize;
        let mut truncated = false;
        'scan: while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
                if scanned >= 5_000 || folders.len() >= 500 {
                    truncated = true;
                    break 'scan;
                }
                scanned += 1;
                let entry = entry.map_err(|error| error.to_string())?;
                let path = entry.path();
                let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
                if !metadata.is_dir() || metadata.file_type().is_symlink() { continue; }
                let relative = path.strip_prefix(&root).map_err(|error| error.to_string())?;
                if policy.is_index_hidden_at(&root, relative) { continue; }
                folders.push(NotebookFolderOption {
                    relative_path: relative.to_string_lossy().replace('\\', "/"),
                    depth: relative.components().count(),
                });
                pending.push(path);
            }
        }
        folders.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        Ok(HtmlNotebookFolders { folders, default_relative_path, truncated })
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn get_notebook_view_preferences(
    notebook_path: String,
    state: State<AppState>,
) -> Result<NotebookViewPreferences, String> {
    let root = Path::new(&notebook_path);
    if !is_registered_notebook_root(root, &state) {
        return Err("NOTEBOOK_NOT_REGISTERED".to_string());
    }
    Ok(read_notebook_view_preferences(root))
}

#[tauri::command]
pub fn set_notebook_view_preferences(
    notebook_path: String,
    preferences: NotebookViewPreferences,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let root = Path::new(&notebook_path);
    if !is_registered_notebook_root(root, &state) {
        return Err("NOTEBOOK_NOT_REGISTERED".to_string());
    }
    let root = fs::canonicalize(root)
        .map_err(|error| format!("resolve notebook directory failed: {error}"))?;
    let default_create_folder_changed = with_registered_notebook_change(
        &root,
        &read_lock(&state.memo_file, "memo_file"),
        "set_notebook_view_preferences",
        || {
            let previous_preferences = read_notebook_view_preferences(&root);
            let path = notebook_preferences_path(&root)?;
            let parent = path
                .parent()
                .expect("notebook preferences have a parent directory");
            fs::create_dir_all(parent)
                .map_err(|error| format!("create notebook config directory failed: {error}"))?;
            let preferences = NotebookViewPreferences {
                default_create_folder: normalize_default_create_folder(
                    preferences.default_create_folder,
                )?,
            };
            let bytes = serde_json::to_vec_pretty(&preferences)
                .map_err(|error| format!("serialize notebook preferences failed: {error}"))?;
            flowix_core::memo_file::atomic_write_bytes(&path, &bytes)
                .map_err(|error| format!("write notebook preferences failed: {error}"))?;
            Ok(previous_preferences.default_create_folder != preferences.default_create_folder)
        },
    )?;
    if default_create_folder_changed {
        let _ = app.emit(
            "notebook-view-preferences-changed",
            serde_json::json!({
                "notebookPath": notebook_path,
                "defaultCreateFolderChanged": true,
            }),
        );
    }
    Ok(())
}

/// Read, rebase and rewrite one notebook's view preferences. Returns the new
/// relative path when the stored default create folder actually moved.
pub(crate) fn rebase_notebook_default_create_folder(
    root: &Path,
    previous_relative: &str,
    next_relative: &str,
) -> Result<Option<String>, String> {
    let preferences = read_notebook_view_preferences(root);
    let Some(current) = preferences.default_create_folder.as_deref() else {
        return Ok(None);
    };
    let Some(rebased) =
        flowix_core::memo_file::rebase_default_create_folder_path(current, previous_relative, next_relative)
    else {
        return Ok(None);
    };
    let path = notebook_preferences_path(root)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create notebook config directory failed: {error}"))?;
    }
    let mut updated = preferences;
    updated.default_create_folder = Some(rebased.clone());
    let bytes = serde_json::to_vec_pretty(&updated)
        .map_err(|error| format!("serialize notebook preferences failed: {error}"))?;
    flowix_core::memo_file::atomic_write_bytes(&path, &bytes)
        .map_err(|error| format!("write notebook preferences failed: {error}"))?;
    Ok(Some(rebased))
}

/// Resolve `path` the same way notebook roots are resolved. The rename *source*
/// no longer exists once the move finished, so fall back to canonicalizing its
/// parent and keeping the caller-provided name. Without this, a root and a
/// rename target could disagree on trailing separators or symlinked prefixes and
/// `strip_prefix` would silently skip the notebook.
fn canonicalize_move_path(path: &Path) -> PathBuf {
    if let Ok(resolved) = dunce::canonicalize(path) {
        return resolved;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => match dunce::canonicalize(parent) {
            Ok(resolved) => resolved.join(name),
            Err(_) => path.to_path_buf(),
        },
        _ => path.to_path_buf(),
    }
}

/// A folder rename inside a notebook changes the *notebook-relative* path that
/// the "default note folder" preference stores. Without rebasing it, new notes
/// silently fall back to the notebook root and the tree loses its default-folder
/// marker. Unlike names, the preference is not derivable from disk, so every
/// directory move (notebook tree and access space alike) has to repair it here.
pub(crate) fn rebase_default_create_folder_for_move(
    mf: &MemoFile,
    source: &Path,
    target: &Path,
    app: &tauri::AppHandle,
) {
    if !target.is_dir() {
        return;
    }
    let source = canonicalize_move_path(source);
    let target = canonicalize_move_path(target);
    let Ok(configs) = mf.read_notebook_configs() else {
        crate::runtime_log::record_event(
            "warn",
            "notebook.default_create_folder.rebase",
            format!("cannot read notebook registry for {} -> {}", source.display(), target.display()),
        );
        return;
    };
    let mut matched = 0usize;
    for config in configs {
        let Ok(root) = dunce::canonicalize(&config.path) else {
            continue;
        };
        let (Ok(previous), Ok(next)) = (source.strip_prefix(&root), target.strip_prefix(&root))
        else {
            continue;
        };
        matched += 1;
        let previous = previous.to_string_lossy().replace('\\', "/");
        let next = next.to_string_lossy().replace('\\', "/");
        // A rename already holds the notebook's shared lock, so the guarded
        // write can be refused with "cannot upgrade notebook shared lock to
        // exclusive". The preference file lives inside the notebook's own config
        // directory, so fall back to writing it directly rather than leaving the
        // default folder pointing at a name that no longer exists.
        let outcome = mf.with_registered_path_change(
            &[root.as_path()],
            "rebase_default_create_folder",
            || {
                rebase_notebook_default_create_folder(&root, &previous, &next)
                    .map_err(std::io::Error::other)
            },
        );
        let rebased = match outcome {
            Ok(rebased) => rebased,
            Err(error) => {
                crate::runtime_log::record_event(
                    "warn",
                    "notebook.default_create_folder.rebase",
                    format!("guarded write refused for {}: {error}; writing directly", config.id),
                );
                match rebase_notebook_default_create_folder(&root, &previous, &next) {
                    Ok(rebased) => rebased,
                    Err(error) => {
                        crate::runtime_log::record_event(
                            "error",
                            "notebook.default_create_folder.rebase",
                            format!("cannot rebase {} ({previous} -> {next}): {error}", config.id),
                        );
                        continue;
                    }
                }
            }
        };
        let Some(rebased) = rebased else {
            crate::runtime_log::record_event(
                "info",
                "notebook.default_create_folder.rebase",
                format!("{} does not track {previous} (move {previous} -> {next})", config.id),
            );
            continue;
        };
        // Surfaces that cache the preference (tree marker, note creation
        // destination) only refresh on this event.
        let emitted = app.emit(
            "notebook-view-preferences-changed",
            serde_json::json!({
                "notebookPath": config.path,
                "defaultCreateFolderChanged": true,
            }),
        );
        crate::runtime_log::record_event(
            "info",
            "notebook.default_create_folder.rebase",
            format!(
                "{}: {previous} -> {next} => {rebased} (notified={})",
                config.id,
                emitted.is_ok()
            ),
        );
    }
    if matched == 0 {
        crate::runtime_log::record_event(
            "warn",
            "notebook.default_create_folder.rebase",
            format!(
                "no registered notebook covers {} -> {}",
                source.display(),
                target.display()
            ),
        );
    }
}
