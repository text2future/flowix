//! Active file-browser directory watcher.
//!
//! The file browser is intentionally different from the memo watcher and the
//! external-document watcher: it watches one recursive root only while the
//! corresponding browser-column surface is mounted.  Native events are
//! coalesced into affected parent directories before they cross the IPC
//! boundary.

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

use crate::app::state::AppState;
use crate::commands::helpers::{
    is_agent_access_folder_with_state, is_registered_notebook_path_with_state,
    start_security_bookmark_access,
};
use crate::config::path_is_inside;

const FILE_BROWSER_DIRECTORIES_CHANGED_EVENT: &str = "file-browser-directories-changed";
const DEBOUNCE_DELAY: Duration = Duration::from_millis(180);

#[derive(Debug, Clone)]
struct WatchLease {
    window_label: String,
    root_path: PathBuf,
    ignore_hidden: bool,
    ignore_agents: bool,
}

#[derive(Debug, Default)]
struct WatchRegistry {
    leases: HashMap<String, WatchLease>,
    root_ref_counts: HashMap<PathBuf, usize>,
}

#[derive(Debug, Clone)]
struct DirectoryChangeNotice {
    lease_id: String,
    directories: Vec<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileBrowserDirectoriesChangedPayload {
    lease_id: String,
    root_path: String,
    directories: Vec<String>,
}

pub struct FileBrowserWatchState {
    registry: Arc<Mutex<WatchRegistry>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    next_lease: AtomicUsize,
}

impl FileBrowserWatchState {
    pub fn new(app: tauri::AppHandle) -> Self {
        let registry = Arc::new(Mutex::new(WatchRegistry::default()));
        let callback_registry = registry.clone();
        let (change_tx, change_rx) = mpsc::channel::<DirectoryChangeNotice>();
        let callback_tx = change_tx.clone();
        let watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
            let Ok(event) = result else {
                return;
            };
            schedule_directory_changes(&callback_registry, &callback_tx, event);
        })
        .map_err(|error| {
            tracing::error!("[file-browser-watch] failed to create watcher: {error}");
            error
        })
        .ok();

        spawn_change_dispatcher(app, registry.clone(), change_rx);

        Self {
            registry,
            watcher: Mutex::new(watcher),
            next_lease: AtomicUsize::new(1),
        }
    }

    fn watch(
        &self,
        window_label: &str,
        root_path: PathBuf,
        ignore_hidden: bool,
        ignore_agents: bool,
    ) -> Result<String, String> {
        let lease_id = format!(
            "file-browser-watch:{}:{}",
            window_label,
            self.next_lease.fetch_add(1, Ordering::Relaxed)
        );

        let mut registry = self
            .registry
            .lock()
            .map_err(|_| "file browser watch registry poisoned".to_string())?;
        let first_for_root = !registry.root_ref_counts.contains_key(&root_path);
        if first_for_root {
            let mut watcher = self
                .watcher
                .lock()
                .map_err(|_| "file browser watcher poisoned".to_string())?;
            watcher
                .as_mut()
                .ok_or_else(|| "file browser watcher is unavailable".to_string())?
                .watch(&root_path, RecursiveMode::Recursive)
                .map_err(|error| format!("failed to watch {}: {error}", root_path.display()))?;
        }

        *registry
            .root_ref_counts
            .entry(root_path.clone())
            .or_insert(0) += 1;
        registry.leases.insert(
            lease_id.clone(),
            WatchLease {
                window_label: window_label.to_string(),
                root_path: root_path.clone(),
                ignore_hidden,
                ignore_agents,
            },
        );
        tracing::info!(
            "[file-browser-watch] watching window={} root={}",
            window_label,
            root_path.display()
        );
        Ok(lease_id)
    }

    fn unwatch(&self, window_label: &str, lease_id: &str) -> Result<(), String> {
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| "file browser watch registry poisoned".to_string())?;
        let Some(lease) = registry.leases.get(lease_id) else {
            return Ok(());
        };
        if lease.window_label != window_label {
            return Err("file browser watch lease belongs to another window".to_string());
        }
        let lease = registry.leases.remove(lease_id).expect("checked above");
        let root_to_unwatch = decrement_root_ref_count(&mut registry, &lease.root_path);
        drop(registry);

        if let Some(root_path) = root_to_unwatch {
            let mut watcher = self
                .watcher
                .lock()
                .map_err(|_| "file browser watcher poisoned".to_string())?;
            if let Some(watcher) = watcher.as_mut() {
                watcher.unwatch(&root_path).map_err(|error| {
                    format!("failed to stop watching {}: {error}", root_path.display())
                })?;
            }
        }
        Ok(())
    }
}

fn decrement_root_ref_count(registry: &mut WatchRegistry, root_path: &Path) -> Option<PathBuf> {
    let count = registry.root_ref_counts.get_mut(root_path)?;
    *count = count.saturating_sub(1);
    if *count == 0 {
        registry.root_ref_counts.remove(root_path);
        Some(root_path.to_path_buf())
    } else {
        None
    }
}

fn schedule_directory_changes(
    registry: &Arc<Mutex<WatchRegistry>>,
    tx: &Sender<DirectoryChangeNotice>,
    event: Event,
) {
    if !matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    ) {
        return;
    }
    let Ok(registry) = registry.lock() else {
        return;
    };
    for (lease_id, lease) in &registry.leases {
        let directories = event
            .paths
            .iter()
            .filter(|path| !should_ignore_path(path, lease))
            .filter_map(|path| affected_directory(path, &lease.root_path))
            .collect::<HashSet<_>>();
        if directories.is_empty() {
            continue;
        }
        let _ = tx.send(DirectoryChangeNotice {
            lease_id: lease_id.clone(),
            directories: directories.into_iter().collect(),
        });
    }
}

fn is_agents_file(path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()) == Some("AGENTS.md")
}

fn should_ignore_path(path: &Path, lease: &WatchLease) -> bool {
    (lease.ignore_agents && is_agents_file(path))
        || (lease.ignore_hidden && has_hidden_component(path, &lease.root_path))
}

/// Test hidden-directory membership relative to the watched root. Hidden
/// files at the root are intentionally not part of this check; the notebook
/// tree's hidden-file policy is about directories and their descendants.
fn has_hidden_component(path: &Path, root_path: &Path) -> bool {
    let canonical_path = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let canonical_root = dunce::canonicalize(root_path).unwrap_or_else(|_| root_path.to_path_buf());
    let Ok(relative) = canonical_path.strip_prefix(&canonical_root) else {
        return false;
    };
    relative.components().any(|component| {
        matches!(component, Component::Normal(name) if name.to_string_lossy().starts_with('.'))
    })
}

/// Return the directory whose direct children need to be reread.
///
/// For normal file changes this is simply the file's parent.  If a remove or
/// rename event points into a directory that has already disappeared, walk up
/// to the nearest existing directory so a collapsed/deleted subtree still
/// causes its visible parent to reconcile.
fn affected_directory(path: &Path, root_path: &Path) -> Option<PathBuf> {
    if !path_is_inside(path, root_path) {
        return None;
    }

    let mut candidate = if path == root_path {
        root_path.to_path_buf()
    } else {
        path.parent()?.to_path_buf()
    };
    while !candidate.exists() && candidate != root_path {
        candidate = candidate.parent()?.to_path_buf();
    }
    if path_is_inside(&candidate, root_path) {
        Some(candidate)
    } else {
        None
    }
}

fn spawn_change_dispatcher(
    app: tauri::AppHandle,
    registry: Arc<Mutex<WatchRegistry>>,
    rx: Receiver<DirectoryChangeNotice>,
) {
    let _ = thread::Builder::new()
        .name("flowix-file-browser-watch".to_string())
        .spawn(move || dispatch_directory_changes(app, registry, rx));
}

fn dispatch_directory_changes(
    app: tauri::AppHandle,
    registry: Arc<Mutex<WatchRegistry>>,
    rx: Receiver<DirectoryChangeNotice>,
) {
    let mut pending = HashMap::<String, HashSet<PathBuf>>::new();

    loop {
        let first = match rx.recv() {
            Ok(notice) => notice,
            Err(_) => return,
        };
        pending
            .entry(first.lease_id)
            .or_default()
            .extend(first.directories);

        let deadline = Instant::now() + DEBOUNCE_DELAY;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match rx.recv_timeout(remaining) {
                Ok(notice) => {
                    pending
                        .entry(notice.lease_id)
                        .or_default()
                        .extend(notice.directories);
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }

        let changes = std::mem::take(&mut pending);
        for (lease_id, directories) in changes {
            emit_directory_changes(&app, &registry, &lease_id, directories);
        }
    }
}

fn emit_directory_changes(
    app: &tauri::AppHandle,
    registry: &Arc<Mutex<WatchRegistry>>,
    lease_id: &str,
    directories: HashSet<PathBuf>,
) {
    let Some((window_label, root_path)) = registry.lock().ok().and_then(|registry| {
        registry
            .leases
            .get(lease_id)
            .map(|lease| (lease.window_label.clone(), lease.root_path.clone()))
    }) else {
        return;
    };

    let mut directories = directories.into_iter().collect::<Vec<_>>();
    directories.sort();
    let payload = FileBrowserDirectoriesChangedPayload {
        lease_id: lease_id.to_string(),
        root_path: root_path.to_string_lossy().to_string(),
        directories: directories
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect(),
    };

    let Some(window) = app.get_webview_window(&window_label) else {
        return;
    };
    if let Err(error) = window.emit(FILE_BROWSER_DIRECTORIES_CHANGED_EVENT, payload) {
        tracing::warn!(
            "[file-browser-watch] failed to emit window={} error={error}",
            window_label
        );
    }
}

#[tauri::command]
pub fn watch_file_browser_root(
    window: tauri::WebviewWindow,
    watches: tauri::State<'_, FileBrowserWatchState>,
    app_state: tauri::State<'_, AppState>,
    root_path: String,
    ignore_hidden: Option<bool>,
    ignore_agents: Option<bool>,
) -> Result<String, String> {
    let path = PathBuf::from(&root_path);
    start_security_bookmark_access(&app_state, &path);
    if !path.is_dir()
        || (!is_registered_notebook_path_with_state(&path, &app_state)
            && !is_agent_access_folder_with_state(&path, &app_state))
    {
        return Err(format!(
            "file browser root is not accessible: {}",
            path.display()
        ));
    }
    watches.watch(
        window.label(),
        path,
        ignore_hidden.unwrap_or(false),
        ignore_agents.unwrap_or(true),
    )
}

#[tauri::command]
pub fn unwatch_file_browser_root(
    window: tauri::WebviewWindow,
    watches: tauri::State<'_, FileBrowserWatchState>,
    lease_id: String,
) -> Result<(), String> {
    watches.unwatch(window.label(), &lease_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn affected_directory_rejects_parent_escape() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("allowed");
        std::fs::create_dir(&root).unwrap();
        assert_eq!(affected_directory(&root.join("../outside.md"), &root), None);
    }

    #[cfg(unix)]
    #[test]
    fn affected_directory_rejects_outside_symlink_targets() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("allowed");
        let outside = directory.path().join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        assert_eq!(affected_directory(&root.join("link/note.md"), &root), None);
    }

    #[test]
    fn decrement_root_ref_count_releases_only_the_last_lease() {
        let root = PathBuf::from("/tmp/flowix-file-browser-watch");
        let mut registry = WatchRegistry::default();
        registry.root_ref_counts.insert(root.clone(), 2);

        assert_eq!(decrement_root_ref_count(&mut registry, &root), None);
        assert_eq!(
            decrement_root_ref_count(&mut registry, &root),
            Some(root.clone())
        );
        assert!(!registry.root_ref_counts.contains_key(&root));
    }

    #[test]
    fn affected_directory_uses_parent_for_file_changes() {
        let temp = tempdir().expect("create temp directory");
        let root = temp.path().to_path_buf();
        let parent = root.join("docs");
        std::fs::create_dir_all(&parent).expect("create test directory");
        let file = parent.join("note.md");

        assert_eq!(affected_directory(&file, &root), Some(parent.clone()));
    }

    #[test]
    fn affected_directory_bubbles_removed_subtree_to_existing_parent() {
        let temp = tempdir().expect("create temp directory");
        let root = temp.path().to_path_buf();
        let parent = root.join("docs");
        std::fs::create_dir_all(&parent).expect("create test directory");
        let removed_child = parent.join("gone").join("note.md");

        assert_eq!(
            affected_directory(&removed_child, &root),
            Some(parent.clone())
        );
    }

    #[test]
    fn affected_directory_uses_parent_for_new_directory() {
        let temp = tempdir().expect("create temp directory");
        let root = temp.path().to_path_buf();
        let new_directory = root.join("new-folder");
        std::fs::create_dir_all(&new_directory).expect("create test directory");

        assert_eq!(affected_directory(&new_directory, &root), Some(root));
    }

    #[test]
    fn recognizes_agents_file() {
        let temp = tempdir().expect("create temp directory");
        let agents = temp.path().join("AGENTS.md");
        assert!(is_agents_file(&agents));
        assert!(!is_agents_file(&temp.path().join("notes.md")));
    }

    #[test]
    fn hidden_directory_membership_is_relative_to_the_watch_root() {
        let temp = tempdir().expect("create temp directory");
        let root = temp.path().join("notebook");
        let hidden = root.join(".codex").join("skills").join("SKILL.md");
        std::fs::create_dir_all(hidden.parent().expect("hidden parent"))
            .expect("create hidden directory");
        std::fs::write(&hidden, "skill").expect("create hidden file");
        assert!(has_hidden_component(&hidden, &root));
        assert!(!has_hidden_component(&root.join("visible.md"), &root));
    }

    #[test]
    fn hidden_path_filter_is_enabled_per_lease() {
        let temp = tempdir().expect("create temp directory");
        let root = temp.path().join("notebook");
        let hidden = root.join(".agent").join("skills").join("skill.md");
        std::fs::create_dir_all(hidden.parent().expect("hidden parent"))
            .expect("create hidden directory");
        std::fs::write(&hidden, "skill").expect("create hidden file");
        let notebook_lease = WatchLease {
            window_label: "notebook".to_string(),
            root_path: root.clone(),
            ignore_hidden: true,
            ignore_agents: true,
        };
        let browser_lease = WatchLease {
            window_label: "browser".to_string(),
            root_path: root,
            ignore_hidden: false,
            ignore_agents: false,
        };

        assert!(should_ignore_path(&hidden, &notebook_lease));
        assert!(!should_ignore_path(&hidden, &browser_lease));
        let agents = temp.path().join("notebook").join("AGENTS.md");
        assert!(should_ignore_path(&agents, &notebook_lease));
        assert!(!should_ignore_path(&agents, &browser_lease));
    }
}
