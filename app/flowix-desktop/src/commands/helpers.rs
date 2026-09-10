//! Cross-command helpers for notebook switching, path scope, and markdown parsing.

use std::path::Path;

use tauri::{AppHandle, State};

use crate::app::search_index::rebuild_index_in_background;
use crate::config::path_is_inside;
use crate::lock_utils::{read_lock, write_lock};
use crate::watcher::runtime::current_watcher;

use crate::app::state::AppState;

pub(crate) fn start_security_bookmark_access(state: &AppState, path: &Path) {
    state.security_bookmarks.start_accessing_for_path(path);
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
        if let Ok(mut g) = watcher.write() {
            g.rebind_all(app.clone(), configs);
        }
    }
}

pub(crate) fn switch_notebook_importing_disk_as_new(
    state: &AppState,
    app: &AppHandle,
    notebook_id: Option<String>,
) -> Result<(), String> {
    switch_notebook(state, app, notebook_id, ReconcileMode::ImportAsNew, true)
}

pub(crate) fn switch_notebook_trusting_index(
    state: &AppState,
    app: &AppHandle,
    notebook_id: Option<String>,
) -> Result<(), String> {
    switch_notebook(state, app, notebook_id, ReconcileMode::Skip, false)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReconcileMode {
    Skip,
    ImportAsNew,
}

fn switch_notebook(
    state: &AppState,
    app: &AppHandle,
    notebook_id: Option<String>,
    reconcile_mode: ReconcileMode,
    rebuild_search_now: bool,
) -> Result<(), String> {
    let prev = read_lock(&state.memo_file, "memo_file").current_notebook_id_value();
    let idx_nb = state
        .search
        .read()
        .unwrap_or_else(|poisoned| {
            tracing::error!("search read lock poisoned, recovering");
            poisoned.into_inner()
        })
        .current_notebook()
        .map(str::to_string);
    let idx_loaded = read_lock(&state.search, "search").is_loaded();

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

    if prev == notebook_id && idx_nb == notebook_id && idx_loaded {
        if let Some(notebook_id) = notebook_id.as_deref() {
            let notebook_path = {
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
                memo_file
                    .get_notebook_config_by_id(notebook_id)
                    .map(|notebook| notebook.path)
            };
            if let Some(notebook_path) = notebook_path {
                crate::plugin::migrate_notebook_data(
                    notebook_id,
                    Path::new(&notebook_path),
                    &state.memo_file,
                    Some(app),
                )?;
            }
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
        let moved_files = {
            let memo_file = read_lock(&state.memo_file, "memo_file");
            memo_file
                .ensure_notebook_structure_migration(notebook_id)
                .map_err(|error| format!("notebook structure migration failed: {error}"))?
        };
        if moved_files > 0 {
            tracing::info!(
                notebook = %notebook_id,
                moved_files,
                "notebook structure migrations completed"
            );
        }
    }

    match reconcile_mode {
        ReconcileMode::Skip => {}
        ReconcileMode::ImportAsNew => {
            let _ = state
                .memo_file
                .read()
                .unwrap_or_else(|poisoned| {
                    tracing::error!("memo_file read lock poisoned, recovering");
                    poisoned.into_inner()
                })
                .reconcile_with_disk_bidirectional_as_new()
                .map_err(|e| format!("reconcile_with_disk_bidirectional_as_new failed: {e}"))?;
        }
    }

    if let Some(notebook_id) = notebook_id.as_deref() {
        let notebook_path = {
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
            memo_file
                .get_notebook_config_by_id(notebook_id)
                .map(|notebook| notebook.path)
        };
        if let Some(notebook_path) = notebook_path {
            crate::plugin::migrate_notebook_data(
                notebook_id,
                Path::new(&notebook_path),
                &state.memo_file,
                Some(app),
            )?;
        }
    }

    if rebuild_search_now {
        rebuild_index_in_background(state, app);
    } else {
        write_lock(&state.search, "search").mark_unloaded();
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
    memo_file.registered_notebook_paths().iter().any(|root| {
        path_is_inside(path, root) && path_is_inside(root, path)
    })
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
    let Some(space_path) = space_path else {
        return false;
    };
    let root = Path::new(space_path);
    (is_registered_notebook_path_with_state(root, state)
        || is_agent_access_folder_with_state(root, state))
        && path_is_inside(file_path, root)
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

pub(crate) fn synthesize_minimal_memo(id: &str) -> flowix_core::memo_file::Memo {
    flowix_core::memo_file::Memo {
        id: id.to_string(),
        filename: String::new(),
        relative_path: String::new(),
        preview: String::new(),
        thumbnail: None,
        tags: vec![],
        todos: vec![],
        agents: vec![],
        created_at: 0,
        updated_at: 0,
        favorited: false,
        icon: None,
        colors: vec![],
        properties: serde_json::json!({}),
    }
}
