//! Cross-command helpers for notebook switching, search indexing, path scope,
//! self-write suppression, and markdown parsing.

use crate::watcher::dispatcher;
use std::ffi::OsStr;
use std::path::Path;
use std::sync::{Arc, RwLock};

use tauri::{AppHandle, Manager, State};

use crate::fs_watcher::MemoWatcher;
use crate::lock_utils::{read_lock, write_lock};
use crate::path_scope::path_is_inside;

use super::AppState;

pub fn current_watcher(app: &AppHandle) -> Option<Arc<RwLock<MemoWatcher>>> {
    app.try_state::<Arc<RwLock<MemoWatcher>>>()
        .map(|s| s.inner().clone())
}

pub(crate) fn mark_self_write_for(app: &AppHandle, path: &Path) {
    if let Some(w) = current_watcher(app) {
        if let Ok(g) = w.read() {
            g.mark_self_write(path);
        }
    }
}

pub(crate) fn refresh_watcher_roots(state: &AppState, app: &AppHandle) {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let configs = memo_file
        .current_notebook_id_value()
        .and_then(|id| memo_file.get_notebook_config_by_id(&id))
        .into_iter()
        .collect();
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

pub(crate) fn force_rebuild_index(state: &AppState, app: &AppHandle) {
    write_lock(&state.search, "search").mark_unloaded();
    rebuild_index_in_background(state, app);
}

pub(crate) fn rebuild_index_in_background(state: &AppState, app: &AppHandle) {
    let app = app.clone();
    let nb = state
        .memo_file
        .read()
        .unwrap()
        .current_notebook_id_value()
        .unwrap_or_default();
    std::thread::spawn(move || {
        let st: tauri::State<AppState> = app.state();
        let mf = read_lock(&st.memo_file, "memo_file");
        let mut index = write_lock(&st.search, "search");
        flowix_core::search::rebuild_index_from_store(&mut index, &mf, nb);
        dispatcher::emit_to(&app, "search-index-ready", ());
    });
}

pub(crate) fn try_index_upsert(state: &AppState, id: &str) {
    let mf = read_lock(&state.memo_file, "memo_file");
    let mut idx = write_lock(&state.search, "search");
    let _ = flowix_core::search::upsert_index_from_store(&mut idx, &mf, id);
}

pub(crate) fn try_index_remove(state: &AppState, id: &str) {
    let mut idx = write_lock(&state.search, "search");
    let _ = flowix_core::search::remove_from_index(&mut idx, id);
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

pub(crate) fn strip_markdown_frontmatter(content: &str) -> &str {
    let Some(rest) = content.strip_prefix("---") else {
        return content;
    };
    let rest = rest
        .strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'));
    let Some(rest) = rest else {
        return content;
    };

    if let Some(index) = rest.find("\r\n---\r\n") {
        return &rest[index + "\r\n---\r\n".len()..];
    }
    if let Some(index) = rest.find("\n---\n") {
        return &rest[index + "\n---\n".len()..];
    }

    content
}

pub(crate) fn title_from_markdown_content(content: &str, fallback: &str) -> String {
    strip_markdown_frontmatter(content)
        .lines()
        .map(|line| line.trim())
        .find(|line| !line.is_empty())
        .map(|line| {
            line.trim_start_matches('#')
                .trim()
                .trim_matches(|c| matches!(c, '*' | '_' | '`'))
                .trim()
                .to_string()
        })
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| fallback.to_string())
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
