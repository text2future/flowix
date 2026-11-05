//! Cross-command helpers for notebook switching, path scope, and markdown parsing.

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::config::{path_is_inside, path_is_inside_reserved_directory};
use crate::lock_utils::read_lock;
use crate::watcher::runtime::current_watcher;

use crate::app::state::AppState;
use flowix_core::memo_file::{notebook_relative_path, MemoFile, NotebookConfig};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationFailure {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl FileOperationFailure {
    pub fn code(code: &str) -> Self {
        Self {
            code: code.to_string(),
            message: None,
        }
    }
}

impl From<String> for FileOperationFailure {
    fn from(value: String) -> Self {
        let (code, message) = value.split_once(": ").unwrap_or((value.as_str(), ""));
        Self {
            code: code.to_string(),
            message: (!message.is_empty()).then(|| message.to_string()),
        }
    }
}

impl From<&str> for FileOperationFailure {
    fn from(value: &str) -> Self {
        Self::from(value.to_string())
    }
}

impl From<flowix_core::FlowixError> for FileOperationFailure {
    fn from(error: flowix_core::FlowixError) -> Self {
        use flowix_core::FlowixError;

        match error {
            FlowixError::Io(error) => {
                let code = match error.kind() {
                    std::io::ErrorKind::AlreadyExists => "FILE_EXISTS",
                    std::io::ErrorKind::NotFound => "FILE_NOT_FOUND",
                    std::io::ErrorKind::PermissionDenied => "FILE_PERMISSION_DENIED",
                    _ => "FILE_OPERATION_FAILED",
                };
                Self {
                    code: code.to_string(),
                    message: Some(error.to_string()),
                }
            }
            FlowixError::NotFound(message) => Self {
                code: "FILE_NOT_FOUND".to_string(),
                message: Some(message),
            },
            FlowixError::PermissionDenied(message) => Self {
                code: "FILE_PERMISSION_DENIED".to_string(),
                message: Some(message),
            },
            FlowixError::InvalidInput(message) => Self {
                code: "INVALID_MOVE_TARGET".to_string(),
                message: Some(message),
            },
            error => Self {
                code: "FILE_OPERATION_FAILED".to_string(),
                message: Some(error.to_string()),
            },
        }
    }
}

pub(crate) fn record_created_notebook_access(
    state: &AppState,
    app: &AppHandle,
    config: &NotebookConfig,
) {
    state
        .security_bookmarks
        .record_accessible_directory(Path::new(&config.path));
    let is_current = {
        read_lock(&state.memo_file, "memo_file")
            .current_notebook_id_value()
            .as_deref()
            == Some(config.id.as_str())
    };
    if is_current {
        refresh_current_notebook_watcher(state, app);
    }
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
        // Only paths the file tree hides are refused here. Markdown inside a
        // tree-visible hidden folder stays openable and savable; it is kept out
        // of note indexes by the index policy instead of being unreadable.
        if memo_file
            .file_management_policy(&notebook.id)
            .is_tree_hidden_at(&root, relative)
        {
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

fn rebind_current_notebook_watcher_locked(state: &AppState, app: &AppHandle) -> Option<String> {
    // The notebook transition lock serializes this snapshot with selection
    // changes. Drop the MemoFile read guard before taking the watcher lock.
    let (active_id, active_config) = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let active_id = memo_file.current_notebook_id_value();
        let active_config = active_id
            .as_deref()
            .and_then(|notebook_id| memo_file.get_notebook_config_by_id(notebook_id));
        (active_id, active_config)
    };
    let Some(watcher) = current_watcher(app) else {
        return None;
    };
    let Ok(mut guard) = watcher.write() else {
        return None;
    };
    guard.rebind_current_notebook(
        app.clone(),
        active_id.as_deref(),
        active_config,
    );
    active_id.filter(|notebook_id| guard.is_watching(notebook_id))
}

pub(crate) fn rebind_current_notebook_watcher_while_transition_locked(
    state: &AppState,
    app: &AppHandle,
) -> Option<String> {
    rebind_current_notebook_watcher_locked(state, app)
}

pub(crate) fn refresh_current_notebook_watcher(state: &AppState, app: &AppHandle) {
    let active_id = {
        let _transition = state
            .notebook_transition
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        rebind_current_notebook_watcher_locked(state, app)
    };
    // The rebind has a short gap. Reconcile only the root that actually
    // attached, so inactive notebooks are never pulled into watcher work.
    if let Some(notebook_id) = active_id {
        state.notebook_background.request(&notebook_id, false, true);
    }
}



pub(crate) fn switch_notebook_trusting_index(
    state: &AppState,
    notebook_id: Option<String>,
) -> Result<(), String> {
    switch_notebook(state, notebook_id)
}

fn switch_notebook(state: &AppState, notebook_id: Option<String>) -> Result<(), String> {
    let prev = read_lock(&state.memo_file, "memo_file").current_notebook_id_value();
    if let Some(target_id) = notebook_id.as_deref() {
        let target_path = read_lock(&state.memo_file, "memo_file")
            .get_notebook_config_by_id(target_id)
            .map(|config| std::path::PathBuf::from(config.path))
            .ok_or_else(|| format!("notebook {target_id} not found"))?;
        state
            .security_bookmarks
            .record_accessible_directory(&target_path);
        if !target_path.is_dir() {
            return Err(format!(
                "notebook {target_id} path is missing: {}",
                target_path.display()
            ));
        }
    }

    if prev == notebook_id {
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

    Ok(())
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
    state.security_bookmarks.start_accessing_for_path(path);
    let allowed = is_registered_notebook_path(path, state)
        || is_attached_notebook_directory(path, state)
        || state.document_access.contains(window, path);
    if allowed && path.is_dir() {
        state.security_bookmarks.record_accessible_directory(path);
    }
    allowed
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
        || is_attached_notebook_directory_with_state(root, state))
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

/// External file scopes come from enabled notebook mounts in local.db.
pub(crate) fn is_attached_notebook_directory(path: &Path, state: &State<AppState>) -> bool {
    is_attached_notebook_directory_with_state(path, state.inner())
}

pub(crate) fn is_attached_notebook_directory_with_state(path: &Path, state: &AppState) -> bool {
    let memo = read_lock(&state.memo_file, "memo_file");
    memo.attached_directory_paths()
        .map(|roots| roots.iter().any(|root| path_is_inside(path, root)))
        .unwrap_or(false)
}
