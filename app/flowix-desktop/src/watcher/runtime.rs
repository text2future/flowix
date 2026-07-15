use std::path::Path;
use std::sync::{Arc, RwLock};

use tauri::{AppHandle, Manager};

use crate::watcher::manager::MemoWatcher;

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
