use std::path::Path;
use std::sync::{Arc, RwLock};

use tauri::{AppHandle, Manager};

use crate::watcher::manager::MemoWatcher;
use flowix_core::memo_file::atomic_write_bytes;

/// Read a fresh registry snapshot without acquiring AppState's MemoFile lock.
/// Call under the notebook transition lock so the selected ID and binding use
/// one coherent transition. Document operations hold the MemoFile lock while
/// recording self-writes, so keep this registry read independent of that lock.
/// The facade uses the current registry path and does not run legacy migrations.
pub(crate) fn read_registered_notebooks(
    config_dir: &Path,
) -> std::io::Result<Vec<flowix_core::memo_file::NotebookConfig>> {
    flowix_core::memo_file::MemoFile::new(config_dir.to_path_buf()).read_notebook_configs()
}

/// Reconcile only the roots that actually attached.
#[cfg(test)]
pub(crate) fn reconcile_bound_roots(
    watcher: &MemoWatcher,
    configs: &[flowix_core::memo_file::NotebookConfig],
    background: &crate::app::notebook_background::NotebookBackground,
) {
    for config in configs {
        if watcher.is_watching(&config.id) {
            background.request(&config.id, false, true);
        }
    }
}

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

pub(crate) fn mark_self_write_content_for(app: &AppHandle, path: &Path, content: &[u8]) {
    if let Some(w) = current_watcher(app) {
        if let Ok(g) = w.read() {
            g.mark_self_write_content(path, content);
        }
    }
}

pub(crate) fn mark_self_write_missing_for(app: &AppHandle, path: &Path) {
    if let Some(w) = current_watcher(app) {
        if let Ok(g) = w.read() {
            g.mark_self_write_missing(path);
        }
    }
}

/// Announce the folder a backend command is about to create a document in.
/// Call this before writing the file so the native create event is recognized
/// even when it reaches the watcher first.
pub(crate) fn mark_self_create_dir_for(app: &AppHandle, dir: &Path) {
    if let Some(w) = current_watcher(app) {
        if let Ok(g) = w.read() {
            g.mark_self_create_dir(dir);
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use flowix_core::memo_file::{MemoFile, NotebookConfig};

    fn notebook(root: &Path) -> NotebookConfig {
        NotebookConfig {
            id: "notebook".into(), name: "Notebook".into(), icon: None,
            path: root.to_string_lossy().into_owned(), is_default: false,
            sort: 0, created_at: 1, updated_at: 1,
        }
    }

    #[test]
    fn registry_snapshot_observes_updates_from_another_facade() {
        let temp = tempfile::tempdir().unwrap();
        let memo = MemoFile::new(temp.path().to_path_buf());
        let mut config = notebook(&temp.path().join("book"));
        memo.write_notebook_configs(&[config.clone()]).unwrap();
        assert_eq!(read_registered_notebooks(temp.path()).unwrap()[0].name, "Notebook");
        config.name = "Renamed".into();
        memo.write_notebook_configs(&[config]).unwrap();
        assert_eq!(read_registered_notebooks(temp.path()).unwrap()[0].name, "Renamed");
        memo.write_notebook_configs(&[]).unwrap();
        assert!(read_registered_notebooks(temp.path()).unwrap().is_empty());
    }

    #[test]
    fn registry_snapshot_under_watcher_lock_does_not_wait_for_global_memo_lock() {
        let temp = tempfile::tempdir().unwrap();
        let memo = Arc::new(RwLock::new(MemoFile::new(temp.path().to_path_buf())));
        memo.read().unwrap().write_notebook_configs(&[notebook(&temp.path().join("book"))]).unwrap();
        let watcher = Arc::new(RwLock::new(MemoWatcher::new(memo.clone())));
        let held_memo = memo.write().unwrap();
        let config_dir = temp.path().to_path_buf();
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _binding = watcher.write().unwrap();
            tx.send(read_registered_notebooks(&config_dir).map(|configs| configs.len())).unwrap();
        });
        let snapshot = rx.recv_timeout(std::time::Duration::from_secs(3));
        // Release before asserting/joining so a regression cannot strand a thread.
        drop(held_memo);
        worker.join().unwrap();
        assert_eq!(snapshot.unwrap().unwrap(), 1);
    }

    #[test]
    fn unreadable_registry_is_an_error_not_an_empty_snapshot_or_rebuild() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("db")).unwrap();
        let db = temp.path().join("db/local.db");
        std::fs::write(&db, b"invalid database").unwrap();
        assert!(read_registered_notebooks(temp.path()).is_err());
        assert_eq!(std::fs::read(db).unwrap(), b"invalid database");
    }
}
