//! Cross-command helpers for notebook switching, path scope, and markdown parsing.

use std::path::Path;

use tauri::{AppHandle, Emitter, State};

use crate::config::{path_is_inside, path_is_inside_reserved_directory};
use crate::lock_utils::{read_lock, write_lock};
use crate::watcher::runtime::current_watcher;

use crate::app::state::AppState;
use flowix_core::memo_file::{
    notebook_relative_path, MemoFile, NotebookConfig,
};

pub(crate) fn watch_created_notebook(state: &AppState, app: &AppHandle, config: &NotebookConfig) {
    start_security_bookmark_access(state, Path::new(&config.path));
    if let Some(watcher) = current_watcher(app) {
        if let Ok(mut guard) = watcher.write() {
            if guard.add_notebook_root(config) {
                return;
            }
        }
    }
    refresh_watcher_roots(state, app);
}

pub(crate) fn start_security_bookmark_access(state: &AppState, path: &Path) {
    state.security_bookmarks.start_accessing_for_path(path);
}

/// Resolve a notebook-relative Markdown address without consulting the legacy
/// memo ID table. `None` means the path is outside notebooks or is not Markdown.
pub(crate) fn notebook_note_address(
    memo_file: &MemoFile,
    path: &Path,
) -> Result<Option<(String, String)>, String> {
    let requested = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mut notebooks = memo_file
        .read_notebook_configs()
        .map_err(|error| error.to_string())?;
    notebooks.sort_by_key(|notebook| std::cmp::Reverse(notebook.path.len()));
    for notebook in notebooks {
        let configured_root = Path::new(&notebook.path);
        let root =
            dunce::canonicalize(configured_root).unwrap_or_else(|_| configured_root.to_path_buf());
        let Ok(relative_path) = notebook_relative_path(&root, &requested) else {
            continue;
        };
        let relative = Path::new(&relative_path);
        if memo_file.file_management_policy(&notebook.id).is_index_ignored_at(&root, relative) {
            return Err("document path is inside an ignored notebook directory".into());
        }
        if !relative
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown")
            })
        {
            return Ok(None);
        }
        return Ok(Some((notebook.id, relative_path)));
    }
    Ok(None)
}

/// Refresh one Markdown path's rebuildable projection after generic file I/O.
/// Filesystem mutations already completed, so index errors are reported and
/// left for watcher/startup reconciliation instead of changing their outcome.
pub(crate) fn refresh_notebook_note_index(memo_file: &MemoFile, path: &Path) {
    match notebook_note_address(memo_file, path) {
        Ok(Some((notebook_id, relative_path))) => {
            if let Err(error) = memo_file.refresh_note_path(&notebook_id, &relative_path) {
                tracing::warn!(
                    notebook_id,
                    relative_path,
                    "notebook note changed but V2 index refresh failed: {error}"
                );
            }
        }
        Ok(None) => {}
        Err(error) => tracing::warn!(
            path = %path.display(),
            "could not resolve notebook path for V2 index refresh: {error}"
        ),
    }
}

pub(crate) fn refresh_watcher_roots(state: &AppState, app: &AppHandle) {
    let configs = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        memo_file.read_notebook_configs().unwrap_or_default()
    };
    for config in &configs {
        start_security_bookmark_access(state, Path::new(&config.path));
    }
    if let Some(watcher) = current_watcher(app) {
        if let Ok(mut guard) = watcher.write() {
            guard.rebind_all(app.clone(), configs.clone());
        }
    }
    // A full rebind has a short gap. Reconcile once after binding so changes
    // made during that gap are included even if no filesystem event arrives.
    let memo_file = read_lock(&state.memo_file, "memo_file");
    for config in &configs {
        match memo_file.reconcile_note_index(&config.id) {
            Ok(report) if report.added + report.updated + report.removed > 0 => {
                let _ = app.emit("flowix:path-note-changed", serde_json::json!({
                    "notebookId": config.id, "relativePath": "", "deleted": false,
                }));
            }
            Err(error) => tracing::warn!(notebook_id = %config.id, "watcher rebind reconciliation failed: {error}"),
            _ => {}
        }
    }
}

pub(crate) fn retry_notebook_watch(state: &AppState, app: &AppHandle, notebook_id: &str) {
    let Some(config) =
        read_lock(&state.memo_file, "memo_file").get_notebook_config_by_id(notebook_id)
    else {
        return;
    };
    let Some(watcher) = current_watcher(app) else {
        return;
    };
    let Ok(mut watcher) = watcher.write() else {
        return;
    };
    if watcher.is_watching(notebook_id) {
        return;
    }
    start_security_bookmark_access(state, Path::new(&config.path));
    if !watcher.add_notebook_root(&config) {
        tracing::warn!(notebook_id, "notebook watch retry failed");
        return;
    }
    drop(watcher);
    match read_lock(&state.memo_file, "memo_file").reconcile_note_index(notebook_id) {
        Ok(report) if report.added + report.updated + report.removed > 0 => {
            let _ = app.emit("flowix:path-note-changed", serde_json::json!({
                "notebookId": notebook_id, "relativePath": "", "deleted": false,
            }));
        }
        Err(error) => tracing::warn!(notebook_id, "notebook watch retry reconciliation failed: {error}"),
        _ => {}
    }
}

pub(crate) fn set_notebook_watching_suspended(app: &AppHandle, notebook_id: &str, suspended: bool) {
    if let Some(watcher) = current_watcher(app) {
        if let Ok(mut watcher) = watcher.write() {
            watcher.set_notebook_suspended(notebook_id, suspended);
        }
    }
}

pub(crate) fn refresh_notebook_watcher(state: &AppState, app: &AppHandle, notebook_id: &str) {
    let config = read_lock(&state.memo_file, "memo_file").get_notebook_config_by_id(notebook_id);
    if let (Some(config), Some(watcher)) = (config, current_watcher(app)) {
        if let Ok(mut watcher) = watcher.write() {
            if watcher.refresh_notebook_root(&config) {
                return;
            }
        }
    }
    // Startup and watcher failures still use the established full recovery path.
    refresh_watcher_roots(state, app);
}

pub(crate) fn switch_notebook_trusting_index(
    state: &AppState,
    app: &AppHandle,
    notebook_id: Option<String>,
) -> Result<(), String> {
    switch_notebook(state, app, notebook_id)
}

fn switch_notebook(
    state: &AppState,
    app: &AppHandle,
    notebook_id: Option<String>,
) -> Result<(), String> {
    let prev = read_lock(&state.memo_file, "memo_file").current_notebook_id_value();
    if let Some(target_id) = notebook_id.as_deref() {
        let target_path = read_lock(&state.memo_file, "memo_file")
            .get_notebook_config_by_id(target_id)
            .map(|config| std::path::PathBuf::from(config.path))
            .ok_or_else(|| format!("notebook {target_id} not found"))?;
        start_security_bookmark_access(state, &target_path);
        if !target_path.is_dir() {
            return Err(format!(
                "notebook {target_id} path is missing: {}",
                target_path.display()
            ));
        }
    }

    if prev == notebook_id {
        if let Some(notebook_id) = notebook_id.as_deref() {
            {
                let memo_file = read_lock(&state.memo_file, "memo_file");
                let report = memo_file
                    .ensure_notebook_migrations(notebook_id)
                    .map_err(|error| format!("notebook migration failed: {error}"))?;
                tracing::debug!(
                    notebook = %notebook_id,
                    moved_files = report.moved_files,
                    rebuilt_tags = report.rebuilt_tags,
                    "notebook migrations checked"
                );
            };
        }
        return Ok(());
    }

    state
        .memo_file
        .write()
        .unwrap_or_else(|poisoned| {
            tracing::error!("memo_file write lock poisoned, recovering");
            poisoned.into_inner()
        })
        .set_current_notebook(notebook_id.clone());

    if let Some(notebook_id) = notebook_id.as_deref() {
        {
            let memo_file = read_lock(&state.memo_file, "memo_file");
            let report = memo_file
                .ensure_notebook_migrations(notebook_id)
                .map_err(|error| format!("notebook migration failed: {error}"))?;
            if report.moved_files > 0 || report.rebuilt_tags > 0 {
                tracing::info!(
                    notebook = %notebook_id,
                    moved_files = report.moved_files,
                    rebuilt_tags = report.rebuilt_tags,
                    "notebook migrations completed"
                );
            }
        };
    }

    Ok(())
}

pub(crate) fn is_markdown_file_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown"))
        .unwrap_or(false)
        && path.is_file()
}

pub fn markdown_paths_from_args(args: impl IntoIterator<Item = String>) -> Vec<String> {
    args.into_iter()
        .filter_map(|arg| {
            let path = Path::new(&arg);
            if is_markdown_file_path(path) {
                Some(path.to_string_lossy().to_string())
            } else {
                None
            }
        })
        .collect()
}

pub(crate) fn is_registered_notebook_path(path: &Path, state: &State<AppState>) -> bool {
    is_registered_notebook_path_with_state(path, state.inner())
}

pub(crate) fn is_registered_notebook_root(path: &Path, state: &State<AppState>) -> bool {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    memo_file
        .registered_notebook_paths()
        .iter()
        .any(|root| path_is_inside(path, root) && path_is_inside(root, path))
}

pub(crate) fn is_registered_notebook_path_with_state(path: &Path, state: &AppState) -> bool {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    memo_file
        .registered_notebook_paths()
        .iter()
        .any(|root| path_is_inside(path, root))
}

pub(crate) fn can_access_document_path(path: &Path, window: &str, state: &State<AppState>) -> bool {
    is_registered_notebook_path(path, state)
        || is_agent_access_folder(path, state)
        || state.document_access.contains(window, path)
}

pub(crate) fn can_access_scoped_file(
    file_path: &Path,
    space_path: Option<&str>,
    state: &State<AppState>,
) -> bool {
    can_access_scoped_file_with_state(file_path, space_path, state.inner())
}

pub(crate) fn can_access_scoped_file_with_state(
    file_path: &Path,
    space_path: Option<&str>,
    state: &AppState,
) -> bool {
    if is_internal_notebook_path_with_state(file_path, state) {
        return false;
    }
    let Some(space_path) = space_path else {
        return false;
    };
    let root = Path::new(space_path);
    (is_registered_notebook_path_with_state(root, state)
        || is_agent_access_folder_with_state(root, state))
        && path_is_inside(file_path, root)
}

/// The notebook's .flowix directory is application-owned data, never a
/// user-facing file. Keep this check below the generic scope helpers so hidden
/// directory preferences cannot make the database and internal artifacts
/// mutable.
pub(crate) fn is_internal_notebook_path(path: &Path, state: &State<AppState>) -> bool {
    is_internal_notebook_path_with_state(path, state.inner())
}

pub(crate) fn is_internal_notebook_path_with_state(path: &Path, state: &AppState) -> bool {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    memo_file
        .read_notebook_configs()
        .unwrap_or_default()
        .iter()
        .any(|config| path_is_inside_reserved_directory(path, Path::new(&config.path), ".flowix"))
}

/// 侧栏"资料"文件夹作用域 ── agent access 配置里登记的 folder entry。
/// `get_file_tree` / `read_file` 等文件树 IPC 用它放行用户添加的资料
/// 文件夹 (这些目录不在注册笔记本列表里, `is_registered_notebook_path`
/// 对它们返回 false)。
pub(crate) fn is_agent_access_folder(path: &Path, state: &State<AppState>) -> bool {
    is_agent_access_folder_with_state(path, state.inner())
}

pub(crate) fn is_agent_access_folder_with_state(path: &Path, state: &AppState) -> bool {
    let config = state.agent_access.get_config();
    config.entries.iter().any(|entry| {
        entry.kind == crate::config::AgentAccessKind::Folder
            && entry.enabled
            && path_is_inside(path, Path::new(&entry.path))
    })
}
