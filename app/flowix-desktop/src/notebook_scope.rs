//! Scope predicates over a `MemoFile`: "is this path inside a notebook we are
//! allowed to touch?"
//!
//! These answer the same question the command layer asks when it authorizes an
//! IPC call, but they take the registry directly instead of a Tauri `AppState`,
//! so subsystems that are not IPC commands — the file-browser watcher, the
//! external-document watcher — can ask it without reaching into `commands::`.
//!
//! `commands::helpers` keeps the `&AppState` wrappers and delegates here, so
//! there is exactly one definition of each rule.
use flowix_core::memo_file::MemoFile;
use flowix_core::path_scope::path_is_inside;
use std::path::Path;

/// The path resolves inside a registered notebook root.
pub(crate) fn is_registered_notebook_path_in(memo: &MemoFile, path: &Path) -> bool {
    memo.registered_notebook_paths()
        .iter()
        .any(|root| path_is_inside(path, root))
}

/// The path *is* a registered notebook root (equality both ways, so a file
/// inside a notebook does not count as the notebook itself).
pub(crate) fn is_registered_notebook_root_in(memo: &MemoFile, path: &Path) -> bool {
    memo.registered_notebook_paths()
        .iter()
        .any(|root| path_is_inside(path, root) && path_is_inside(root, path))
}

/// The path resolves inside a directory attached to the current notebook
/// (a linked folder rather than a notebook of its own).
pub(crate) fn is_attached_notebook_directory_in(memo: &MemoFile, path: &Path) -> bool {
    memo.attached_directory_paths()
        .map(|roots| roots.iter().any(|root| path_is_inside(path, root)))
        .unwrap_or(false)
}
