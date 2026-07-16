//! Cross-command helpers for notebook switching, path scope, and markdown parsing.

use std::ffi::OsStr;
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
        memo_file
            .current_notebook_id_value()
            .and_then(|id| memo_file.get_notebook_config_by_id(&id))
            .into_iter()
            .collect()
    };
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
        return Ok(());
    }

    state
        .memo_file
        .write()
        .unwrap_or_else(|poisoned| {
            tracing::error!("memo_file write lock poisoned, recovering");
            poisoned.into_inner()
        })
        .set_current_notebook(notebook_id);
    refresh_watcher_roots(state, app);

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
    let memo_file = read_lock(&state.memo_file, "memo_file");
    memo_file
        .registered_notebook_paths()
        .iter()
        .any(|root| path_is_inside(path, root))
}

fn is_markdown_like(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown"))
        .unwrap_or(false)
}

pub(crate) fn can_access_document_path(path: &Path, state: &State<AppState>) -> bool {
    is_registered_notebook_path(path, state) || is_markdown_like(path)
}

pub(crate) fn can_access_scoped_file(
    file_path: &Path,
    space_path: Option<&str>,
    state: &State<AppState>,
) -> bool {
    let Some(space_path) = space_path else {
        return false;
    };
    let root = Path::new(space_path);
    is_registered_notebook_path(root, state) && path_is_inside(file_path, root)
}

pub(crate) fn synthesize_minimal_memo(id: &str) -> flowix_core::memo_file::Memo {
    flowix_core::memo_file::Memo {
        id: id.to_string(),
        filename: String::new(),
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
