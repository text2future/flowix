use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tauri::{Emitter, Manager};

use crate::app::state::AppState;
use crate::commands::external_document::exact_existing_external_path;

const EXTERNAL_DOCUMENT_CHANGED_EVENT: &str = "external-document-changed";
const EVENT_SETTLE_DELAY: Duration = Duration::from_millis(120);
const REVISION_POLL_INTERVAL: Duration = Duration::from_millis(750);

#[derive(Debug, Clone)]
struct WatchLease {
    window_label: String,
    path: PathBuf,
}

#[derive(Debug, Default)]
struct WatchRegistry {
    leases: HashMap<String, WatchLease>,
    path_ref_counts: HashMap<PathBuf, usize>,
    generations: HashMap<String, u64>,
    revisions: HashMap<String, String>,
    delivering: HashSet<String>,
    delivery_epochs: HashMap<String, u64>,
    active_writes: HashMap<PathBuf, usize>,
    active_path_moves: HashMap<usize, PathBuf>,
    completed_writes: HashMap<PathBuf, (String, String, String)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalDocumentChangedPayload {
    path: String,
    kind: &'static str,
    revision: String,
    source: &'static str,
    #[serde(rename = "originWindowLabel", skip_serializing_if = "Option::is_none")]
    origin_window_label: Option<String>,
}

pub struct ExternalDocumentWatchState {
    registry: Arc<Mutex<WatchRegistry>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    next_id: AtomicUsize,
}

// A local move can spend time updating indexes after the filesystem rename.
// Keep old-path polls silent until its confirmed path mapping has been applied.
pub(crate) struct PathMoveGuard {
    registry: Arc<Mutex<WatchRegistry>>,
    id: usize,
}

impl Drop for PathMoveGuard {
    fn drop(&mut self) {
        if let Ok(mut registry) = self.registry.lock() {
            registry.active_path_moves.remove(&self.id);
        }
    }
}

fn watch_prefix(path: &Path) -> PathBuf {
    // Resolve the parent even after a move, retaining the old basename for
    // case-only renames on case-insensitive filesystems.
    path.parent()
        .and_then(|parent| dunce::canonicalize(parent).ok())
        .zip(path.file_name())
        .map(|(parent, name)| parent.join(name))
        .unwrap_or_else(|| path.to_path_buf())
}

pub(crate) fn begin_path_move(app: &tauri::AppHandle, path: &Path) -> Option<PathMoveGuard> {
    let state = app.try_state::<ExternalDocumentWatchState>()?;
    let path = watch_prefix(path);
    let mut registry = state.registry.lock().ok()?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    registry.active_path_moves.insert(id, path);
    Some(PathMoveGuard {
        registry: state.registry.clone(),
        id,
    })
}

/// Called by both local mutations and confirmed native rename pairs before
/// publishing the existing UI path-move event.
pub(crate) fn rebase_path(app: &tauri::AppHandle, previous: &Path, next: &Path) {
    if let Some(state) = app.try_state::<ExternalDocumentWatchState>() {
        state.rebase_path(&watch_prefix(previous), &watch_prefix(next));
    }
}

fn rebase_registry_paths(registry: &mut WatchRegistry, previous: &Path, next: &Path) {
    if previous == next {
        return;
    }
    let moved = registry
        .leases
        .iter()
        .filter_map(|(id, lease)| {
            let suffix = lease.path.strip_prefix(previous).ok()?;
            Some((id.clone(), next.join(suffix)))
        })
        .collect::<Vec<_>>();
    for (id, path) in moved {
        registry.leases.get_mut(&id).expect("existing lease").path = path;
        *registry.generations.entry(id.clone()).or_default() += 1;
        invalidate_delivery(registry, &id);
        // Preserve the last observed revision: a content change concurrent
        // with the move must still be delivered at the new path.
    }
    // A native rename can arrive before the local command finishes. Its
    // notification pause follows the prefix until the same guard is released.
    for prefix in registry.active_path_moves.values_mut() {
        if let Ok(suffix) = prefix.strip_prefix(previous) {
            *prefix = next.join(suffix);
        }
    }
    registry.path_ref_counts.clear();
    for lease in registry.leases.values() {
        *registry
            .path_ref_counts
            .entry(lease.path.clone())
            .or_default() += 1;
    }
}

impl ExternalDocumentWatchState {
    pub fn new(app: tauri::AppHandle) -> Self {
        let registry = Arc::new(Mutex::new(WatchRegistry::default()));
        let callback_registry = registry.clone();
        let callback_app = app.clone();
        let watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
            let Ok(event) = result else {
                return;
            };
            schedule_matching_notifications(&callback_app, &callback_registry, event);
        })
        .map_err(|error| {
            tracing::error!("[external-watch] failed to create watcher: {error}");
            error
        })
        .ok();

        spawn_revision_poll(app, registry.clone());

        Self {
            registry,
            watcher: Mutex::new(watcher),
            next_id: AtomicUsize::new(1),
        }
    }

    fn rebase_path(&self, previous: &Path, next: &Path) {
        let Ok(mut registry) = self.registry.lock() else {
            return;
        };
        if previous == next {
            return;
        }
        let old_paths = registry
            .path_ref_counts
            .keys()
            .cloned()
            .collect::<HashSet<_>>();
        let moved_paths = old_paths
            .iter()
            .filter_map(|path| {
                path.strip_prefix(previous)
                    .ok()
                    .map(|suffix| next.join(suffix))
            })
            .collect::<HashSet<_>>();
        rebase_registry_paths(&mut registry, previous, next);
        if moved_paths.is_empty() {
            return;
        }
        // Use the same registry -> watcher lock order as registration. Keep
        // lease changes and native watch changes together for concurrent opens.
        let Ok(mut watcher) = self.watcher.lock() else {
            return;
        };
        if let Some(watcher) = watcher.as_mut() {
            for path in &old_paths {
                if !registry.path_ref_counts.contains_key(path) {
                    watcher.unwatch(path).ok();
                }
            }
            for path in &moved_paths {
                watcher.unwatch(path).ok();
                if let Err(error) = watcher.watch(path, RecursiveMode::NonRecursive) {
                    // Revision polling remains available if native rebinding fails.
                    tracing::warn!(
                        "[external-watch] failed to watch moved path {}: {error}",
                        path.display()
                    );
                }
            }
        }
    }

    fn watch(&self, window_label: &str, path: PathBuf) -> Result<String, String> {
        let lease_id = format!(
            "external-watch:{}:{}",
            window_label,
            self.next_id.fetch_add(1, Ordering::Relaxed)
        );

        let mut registry = self
            .registry
            .lock()
            .map_err(|_| "external document watch registry poisoned".to_string())?;
        let first_for_path = !registry.path_ref_counts.contains_key(&path);
        if first_for_path {
            let mut watcher = self
                .watcher
                .lock()
                .map_err(|_| "external document watcher poisoned".to_string())?;
            watcher
                .as_mut()
                .ok_or_else(|| "external document watcher is unavailable".to_string())?
                .watch(&path, RecursiveMode::NonRecursive)
                .map_err(|error| format!("failed to watch {}: {error}", path.display()))?;
        }
        *registry.path_ref_counts.entry(path.clone()).or_insert(0) += 1;
        let initial_revision = file_revision(&path);
        registry.leases.insert(
            lease_id.clone(),
            WatchLease {
                window_label: window_label.to_string(),
                path: path.clone(),
            },
        );
        registry.generations.insert(lease_id.clone(), 0);
        registry
            .revisions
            .insert(lease_id.clone(), initial_revision);
        tracing::info!(
            "[external-watch] watching window={} path={}",
            window_label,
            path.display()
        );
        crate::runtime_log::record_event(
            "info",
            "external_watch.registered",
            format!("window={window_label} path={}", path.display()),
        );
        Ok(lease_id)
    }

    fn unwatch(&self, window_label: &str, lease_id: &str) -> Result<(), String> {
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| "external document watch registry poisoned".to_string())?;
        let Some(lease) = registry.leases.get(lease_id) else {
            return Ok(());
        };
        if lease.window_label != window_label {
            return Err("external document watch lease belongs to another window".to_string());
        }
        let lease = registry.leases.remove(lease_id).expect("checked above");
        registry.generations.remove(lease_id);
        registry.revisions.remove(lease_id);
        registry.delivering.remove(lease_id);
        registry.delivery_epochs.remove(lease_id);
        let path = decrement_path_ref_count(&mut registry, &lease.path);
        drop(registry);
        if let Some(path) = path {
            self.unwatch_path(&path);
        }
        Ok(())
    }


    pub fn begin_window_write(&self, app: &tauri::AppHandle, path: &Path) {
        // Both notebook and open-document watchers observe this same write.
        // Keep their self-write bookkeeping at one boundary.
        crate::watcher::runtime::mark_self_write_for(app, path);
        if let Ok(mut registry) = self.registry.lock() {
            *registry
                .active_writes
                .entry(path.to_path_buf())
                .or_default() += 1;
        }
    }

    pub fn finish_window_write(
        &self,
        app: &tauri::AppHandle,
        window_label: &str,
        path: &Path,
        saved_content: Option<&str>,
    ) {
        let saved = saved_content.is_some();
        if let Some(content) = saved_content {
            // Use the actual merged output, not the originally submitted draft.
            crate::watcher::runtime::mark_self_write_content_for(app, path, content.as_bytes());
        }
        let revision = file_revision(path);
        if let Ok(mut registry) = self.registry.lock() {
            if let Some(content) = saved_content {
                registry.completed_writes.insert(
                    path.to_path_buf(),
                    (window_label.to_string(), revision, content.to_string()),
                );
            }
            if let Some(count) = registry.active_writes.get_mut(path) {
                *count -= 1;
                if *count == 0 {
                    registry.active_writes.remove(path);
                }
            }
            if !registry.active_writes.contains_key(path) {
                if let Some((origin, written_revision, written_content)) =
                    registry.completed_writes.remove(path)
                {
                    // If another process changed the file after this save, let
                    // the ordinary watcher deliver that revision as external.
                    if written_revision == file_revision(path)
                        && std::fs::read_to_string(path).is_ok_and(|disk| disk == written_content)
                    {
                        let leases = registry
                            .leases
                            .iter()
                            .filter(|(_, lease)| lease.path == path)
                            .map(|(id, lease)| (id.clone(), lease.clone()))
                            .collect::<Vec<_>>();
                        for (id, lease) in leases {
                            invalidate_delivery(&mut registry, &id);
                            let delivered = lease.window_label == origin
                                || emit_external_document_changed(
                                    app,
                                    &lease,
                                    written_revision.clone(),
                                    "user_edit",
                                    Some(&origin),
                                );
                            if delivered {
                                registry.revisions.insert(id, written_revision.clone());
                            }
                        }
                    }
                }
            }
        }
        if saved && flowix_core::collection::is_collection_document_path(path) {
            if let Some(state) = app.try_state::<crate::app::state::AppState>() {
                let configs = state.memo_file.read().ok().and_then(|memo| memo.read_notebook_configs().ok()).unwrap_or_default();
                if let Some((config, relative)) = configs.iter().filter_map(|config| {
                    let root = Path::new(&config.path);
                    let relative = path.strip_prefix(root).ok()?;
                    if relative.starts_with("attachments") || relative.starts_with(".flowix") { return None; }
                    Some((config, relative))
                }).max_by_key(|(config, _)| Path::new(&config.path).components().count()) {
                    let ctx = crate::watcher::processor::NotebookWatchContext { notebook_id: config.id.clone(), root: PathBuf::from(&config.path) };
                    crate::watcher::processor::record_cloud_path_change(app, &ctx, &relative.to_string_lossy().replace('\\', "/"), false);
                }
            }
        }
        if saved {
            self.rebind_path(path);
        }
    }

    fn unwatch_path(&self, path: &Path) {
        if let Ok(mut watcher) = self.watcher.lock() {
            if let Some(watcher) = watcher.as_mut() {
                if let Err(error) = watcher.unwatch(path) {
                    tracing::warn!(
                        "[external-watch] failed to stop watching {}: {error}",
                        path.display()
                    );
                }
            }
        }
        let was_reopened = self
            .registry
            .lock()
            .is_ok_and(|registry| registry.path_ref_counts.contains_key(path));
        if was_reopened {
            self.rebind_path(path);
        }
    }

    fn rebind_path(&self, path: &Path) {
        let Ok(mut watcher) = self.watcher.lock() else {
            return;
        };
        let Some(watcher) = watcher.as_mut() else {
            return;
        };
        watcher.unwatch(path).ok();
        if let Err(error) = watcher.watch(path, RecursiveMode::NonRecursive) {
            tracing::warn!(
                "[external-watch] failed to rebind {}: {error}",
                path.display()
            );
        }
    }
}

fn spawn_revision_poll(app: tauri::AppHandle, registry: Arc<Mutex<WatchRegistry>>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(REVISION_POLL_INTERVAL).await;
            let leases = {
                let Ok(registry) = registry.lock() else {
                    continue;
                };
                registry
                    .leases
                    .iter()
                    .map(|(lease_id, lease)| (lease_id.clone(), lease.clone()))
                    .collect::<Vec<_>>()
            };
            for (lease_id, lease) in leases {
                emit_if_revision_changed(&app, &registry, &lease_id, &lease);
            }
        }
    });
}

fn emit_if_revision_changed(
    app: &tauri::AppHandle,
    registry: &Arc<Mutex<WatchRegistry>>,
    lease_id: &str,
    lease: &WatchLease,
) {
    // Serialize claim + emission with path rebasing. Otherwise a poll can
    // claim an old-path deletion, then emit it after the lease has moved.
    let Ok(mut registry) = registry.lock() else {
        return;
    };
    let revision = file_revision(&lease.path);
    if !try_claim_revision(&mut registry, lease_id, &lease.path, &revision) {
        return;
    }
    let delivery_epoch = registry.delivery_epochs[lease_id];
    let delivered = emit_external_document_changed(app, lease, revision.clone(), "external", None);
    complete_revision_delivery(&mut registry, lease_id, delivery_epoch, delivered, revision);
}

/// Pure state transition: mark a lease as "delivering" for a given revision.
///
/// Returns `true` when the caller now owns the right to emit; returns `false`
/// when the lease is gone, already observed, or currently being delivered.
/// Extracted so it can be unit-tested without an `AppHandle`.
fn try_claim_revision(
    registry: &mut WatchRegistry,
    lease_id: &str,
    lease_path: &Path,
    revision: &str,
) -> bool {
    if registry
        .active_path_moves
        .values()
        .any(|prefix| lease_path.starts_with(prefix))
        || registry.active_writes.contains_key(lease_path)
        || registry
            .leases
            .get(lease_id)
            .is_none_or(|current| current.path != lease_path)
        || registry.revisions.get(lease_id).map(String::as_str) == Some(revision)
        || registry.delivering.contains(lease_id)
    {
        return false;
    }
    registry.delivering.insert(lease_id.to_string());
    *registry
        .delivery_epochs
        .entry(lease_id.to_string())
        .or_default() += 1;
    true
}

fn invalidate_delivery(registry: &mut WatchRegistry, lease_id: &str) {
    *registry
        .delivery_epochs
        .entry(lease_id.to_string())
        .or_default() += 1;
    registry.delivering.remove(lease_id);
}

/// Pure state transition: finalize a previously claimed delivery.
///
/// On success the lease revision advances to the delivered revision, so the
/// next poll cycle will not re-emit. On failure the revision is intentionally
/// left unchanged so the next attempt can retry.
fn complete_revision_delivery(
    registry: &mut WatchRegistry,
    lease_id: &str,
    delivery_epoch: u64,
    delivered: bool,
    revision: String,
) {
    if registry.delivery_epochs.get(lease_id).copied() != Some(delivery_epoch) {
        return;
    }
    registry.delivering.remove(lease_id);
    if delivered && registry.leases.contains_key(lease_id) {
        registry.revisions.insert(lease_id.to_string(), revision);
    }
}

fn emit_external_document_changed(
    app: &tauri::AppHandle,
    lease: &WatchLease,
    revision: String,
    source: &'static str,
    origin_window_label: Option<&str>,
) -> bool {
    let exists = lease.path.is_file();
    let payload = ExternalDocumentChangedPayload {
        path: lease.path.to_string_lossy().to_string(),
        kind: if exists { "modified" } else { "deleted" },
        revision,
        source,
        origin_window_label: origin_window_label.map(str::to_string),
    };
    tracing::info!(
        "[external-watch] changed window={} kind={} path={}",
        lease.window_label,
        payload.kind,
        lease.path.display()
    );
    let Some(window) = app.get_webview_window(&lease.window_label) else {
        let message = format!(
            "external watcher target window is unavailable: label={} path={}",
            lease.window_label,
            lease.path.display()
        );
        tracing::warn!("[external-watch] {message}");
        crate::runtime_log::record_event("warn", "external_watch.window_missing", message);
        return false;
    };
    if let Err(error) = window.emit(EXTERNAL_DOCUMENT_CHANGED_EVENT, payload) {
        let message = format!(
            "external watcher emit failed: label={} path={} error={error}",
            lease.window_label,
            lease.path.display()
        );
        tracing::warn!("[external-watch] {message}");
        crate::runtime_log::record_event("warn", "external_watch.emit_failed", message);
        return false;
    }
    true
}

fn decrement_path_ref_count(registry: &mut WatchRegistry, path: &Path) -> Option<PathBuf> {
    let count = registry.path_ref_counts.get_mut(path)?;
    *count = count.saturating_sub(1);
    if *count == 0 {
        registry.path_ref_counts.remove(path);
        Some(path.to_path_buf())
    } else {
        None
    }
}

fn event_matches_watched_file(event_path: &Path, watched_path: &Path) -> bool {
    let normalized = dunce::canonicalize(event_path).unwrap_or_else(|_| event_path.to_path_buf());
    normalized == watched_path
}

fn schedule_matching_notifications(
    app: &tauri::AppHandle,
    registry: &Arc<Mutex<WatchRegistry>>,
    event: Event,
) {
    let pending = {
        let Ok(mut registry) = registry.lock() else {
            return;
        };
        let matching = registry
            .leases
            .iter()
            .filter(|(_, lease)| {
                event
                    .paths
                    .iter()
                    .any(|path| event_matches_watched_file(path, &lease.path))
            })
            .map(|(lease_id, _)| lease_id.clone())
            .collect::<Vec<_>>();
        matching
            .into_iter()
            .map(|lease_id| {
                let generation = registry.generations.entry(lease_id.clone()).or_insert(0);
                *generation += 1;
                (lease_id, *generation)
            })
            .collect::<Vec<_>>()
    };

    for (lease_id, generation) in pending {
        let app = app.clone();
        let registry = registry.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(EVENT_SETTLE_DELAY).await;
            let lease = {
                let Ok(registry) = registry.lock() else {
                    return;
                };
                if registry.generations.get(&lease_id) != Some(&generation) {
                    return;
                }
                let Some(lease) = registry.leases.get(&lease_id).cloned() else {
                    return;
                };
                lease
            };
            emit_if_revision_changed(&app, &registry, &lease_id, &lease);
        });
    }
}

fn file_revision(path: &Path) -> String {
    let Ok(metadata) = path.metadata() else {
        return "deleted".to_string();
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{}:{modified}", metadata.len())
}

#[tauri::command]
pub fn watch_external_document(
    window: tauri::WebviewWindow,
    watches: tauri::State<'_, ExternalDocumentWatchState>,
    app_state: tauri::State<'_, AppState>,
    file_path: String,
    #[allow(non_snake_case)] scopePath: Option<String>,
) -> Result<String, String> {
    let path =
        exact_existing_external_path(&file_path, scopePath.as_deref(), window.label(), &app_state)?;
    watches.watch(window.label(), path)
}

#[tauri::command]
pub fn unwatch_external_document(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ExternalDocumentWatchState>,
    lease_id: String,
) -> Result<(), String> {
    state.unwatch(window.label(), &lease_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn add_lease(registry: &mut WatchRegistry, id: &str, path: &Path) {
        registry.leases.insert(
            id.into(),
            WatchLease {
                window_label: id.into(),
                path: path.into(),
            },
        );
        *registry.path_ref_counts.entry(path.into()).or_default() += 1;
        registry.revisions.insert(id.into(), file_revision(path));
    }

    #[test]
    fn native_watch_is_rebound_to_the_moved_document() {
        let temp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(temp.path()).unwrap();
        let old = root.join("Old");
        let new = root.join("New");
        std::fs::create_dir(&old).unwrap();
        let old_note = old.join("note.md");
        let new_note = new.join("note.md");
        std::fs::write(&old_note, "original").unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = tx.send(event);
        })
        .unwrap();
        watcher
            .watch(&old_note, RecursiveMode::NonRecursive)
            .unwrap();
        let mut registry = WatchRegistry::default();
        add_lease(&mut registry, "main", &old_note);
        let state = ExternalDocumentWatchState {
            registry: Arc::new(Mutex::new(registry)),
            watcher: Mutex::new(Some(watcher)),
            next_id: AtomicUsize::new(2),
        };
        std::fs::rename(&old, &new).unwrap();
        state.rebase_path(&old, &new);
        std::fs::write(&new_note, "external change at the new path").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            let event = rx
                .recv_timeout(remaining)
                .expect("native event for the moved file")
                .unwrap();
            if event
                .paths
                .iter()
                .any(|path| event_matches_watched_file(path, &new_note))
            {
                break;
            }
        }
        assert_eq!(state.registry.lock().unwrap().leases["main"].path, new_note);
    }

    #[test]
    fn folder_move_preserves_revisions_and_rejects_stale_deletes_across_windows() {
        let temp = tempfile::tempdir().unwrap();
        let old = temp.path().join("Old");
        let new = temp.path().join("New");
        std::fs::create_dir_all(old.join("sub")).unwrap();
        let old_note = old.join("sub/note.md");
        let new_note = new.join("sub/note.md");
        std::fs::write(&old_note, "original").unwrap();
        let mut registry = WatchRegistry::default();
        add_lease(&mut registry, "main", &old_note);
        add_lease(&mut registry, "second", &old_note);
        let unrelated = temp.path().join("Old-other/note.md");
        add_lease(&mut registry, "other", &unrelated);
        // An already-registered destination must share its native watch.
        add_lease(&mut registry, "destination", &new_note);
        assert!(try_claim_revision(
            &mut registry,
            "main",
            &old_note,
            "stale"
        ));
        let stale_epoch = registry.delivery_epochs["main"];
        let observed = registry.revisions["main"].clone();

        std::fs::rename(&old, &new).unwrap();
        rebase_registry_paths(&mut registry, &old, &new);
        rebase_registry_paths(&mut registry, &old, &new); // duplicate native rename pair
        assert_eq!(registry.leases["main"].path, new_note);
        assert_eq!(registry.leases["second"].path, new_note);
        assert_eq!(registry.leases["other"].path, unrelated);
        assert_eq!(registry.path_ref_counts[&new_note], 3);
        assert!(!registry.path_ref_counts.contains_key(&old_note));
        assert!(!try_claim_revision(
            &mut registry,
            "main",
            &old_note,
            "deleted"
        ));
        complete_revision_delivery(&mut registry, "main", stale_epoch, true, "deleted".into());
        assert_eq!(registry.revisions["main"], observed);
        assert!(!try_claim_revision(
            &mut registry,
            "main",
            &new_note,
            &file_revision(&new_note)
        ));

        std::fs::write(&new_note, "genuine external content change").unwrap();
        let changed = file_revision(&new_note);
        assert!(try_claim_revision(
            &mut registry,
            "main",
            &new_note,
            &changed
        ));
        let epoch = registry.delivery_epochs["main"];
        complete_revision_delivery(&mut registry, "main", epoch, true, changed);
        std::fs::remove_file(&new_note).unwrap();
        assert!(try_claim_revision(
            &mut registry,
            "main",
            &new_note,
            &file_revision(&new_note)
        ));
        assert_eq!(decrement_path_ref_count(&mut registry, &new_note), None);
        assert_eq!(registry.path_ref_counts[&new_note], 2);
    }

    #[test]
    fn path_move_guard_defers_only_its_subtree_and_releases_on_failure() {
        let prefix = PathBuf::from("/notes/old");
        let note = prefix.join("note.md");
        let other = PathBuf::from("/notes/old-other/note.md");
        let registry = Arc::new(Mutex::new(WatchRegistry::default()));
        {
            let mut state = registry.lock().unwrap();
            add_lease(&mut state, "note", &note);
            add_lease(&mut state, "other", &other);
            state.active_path_moves.insert(1, prefix.clone());
            state.active_path_moves.insert(2, prefix.clone());
            assert!(!try_claim_revision(&mut state, "note", &note, "deleted"));
            assert!(try_claim_revision(&mut state, "other", &other, "changed"));
        }
        let outer = PathMoveGuard {
            registry: registry.clone(),
            id: 1,
        };
        let inner = PathMoveGuard {
            registry: registry.clone(),
            id: 2,
        };
        drop(inner);
        {
            let mut state = registry.lock().unwrap();
            assert_eq!(state.active_path_moves.len(), 1);
            let next = Path::new("/notes/new");
            rebase_registry_paths(&mut state, &prefix, next);
            assert_eq!(state.active_path_moves[&1], next);
            assert!(!try_claim_revision(
                &mut state,
                "note",
                &next.join("note.md"),
                "changed"
            ));
        }
        drop(outer); // also runs when a mutation returns an error
        let mut state = registry.lock().unwrap();
        assert!(state.active_path_moves.is_empty());
        assert!(try_claim_revision(
            &mut state,
            "note",
            Path::new("/notes/new/note.md"),
            "genuine-delete"
        ));
    }

    #[test]
    fn case_only_move_updates_the_lease_spelling() {
        let mut registry = WatchRegistry::default();
        add_lease(&mut registry, "note", Path::new("/notes/Old/a.md"));
        rebase_registry_paths(
            &mut registry,
            Path::new("/notes/Old"),
            Path::new("/notes/old"),
        );
        assert_eq!(registry.leases["note"].path, Path::new("/notes/old/a.md"));
    }

    #[test]
    fn file_reference_count_releases_only_the_last_lease() {
        let path = PathBuf::from("/tmp/flowix-external-watch/Reference.md");
        let mut registry = WatchRegistry::default();
        registry.path_ref_counts.insert(path.clone(), 2);

        assert_eq!(decrement_path_ref_count(&mut registry, &path), None);
        assert_eq!(registry.path_ref_counts.get(&path), Some(&1));
        assert_eq!(
            decrement_path_ref_count(&mut registry, &path),
            Some(path.clone())
        );
        assert!(!registry.path_ref_counts.contains_key(&path));
    }

    #[test]
    fn file_events_match_only_the_watched_external_document() {
        let watched = PathBuf::from("/tmp/flowix-external-watch/docs/Reference.md");

        assert!(event_matches_watched_file(&watched, &watched));
        assert!(!event_matches_watched_file(
            Path::new("/tmp/flowix-external-watch/docs/Other.md"),
            &watched,
        ));
        assert!(!event_matches_watched_file(
            Path::new("/tmp/flowix-external-watch/docs"),
            &watched,
        ));
    }

    #[test]
    fn try_claim_revision_marks_lease_delivering_once() {
        let path = PathBuf::from("/tmp/flowix-external-watch/docs/Reference.md");
        let mut registry = WatchRegistry::default();
        let lease_id = "lease-1".to_string();
        registry.leases.insert(
            lease_id.clone(),
            WatchLease {
                window_label: "main".to_string(),
                path: path.clone(),
            },
        );

        assert!(try_claim_revision(&mut registry, &lease_id, &path, "rev-a"));
        assert!(registry.delivering.contains(&lease_id));
        assert!(registry.revisions.get(&lease_id).is_none());

        // Second concurrent claim must be rejected while still delivering.
        assert!(!try_claim_revision(
            &mut registry,
            &lease_id,
            &path,
            "rev-a"
        ));

        // Already-observed revision must be rejected even if delivering is cleared.
        registry.delivering.remove(&lease_id);
        registry
            .revisions
            .insert(lease_id.clone(), "rev-a".to_string());
        assert!(!try_claim_revision(
            &mut registry,
            &lease_id,
            &path,
            "rev-a"
        ));
    }

    #[test]
    fn local_write_defers_file_notifications_until_write_settles() {
        let path = PathBuf::from("/tmp/flowix-external-watch/docs/Reference.md");
        let mut registry = WatchRegistry::default();
        registry.leases.insert(
            "lease".into(),
            WatchLease {
                window_label: "main".into(),
                path: path.clone(),
            },
        );
        registry.active_writes.insert(path.clone(), 1);
        assert!(!try_claim_revision(
            &mut registry,
            "lease",
            &path,
            "changed"
        ));
        registry.active_writes.remove(&path);
        assert!(try_claim_revision(&mut registry, "lease", &path, "changed"));
    }

    #[test]
    fn complete_revision_delivery_advances_only_on_success() {
        let path = PathBuf::from("/tmp/flowix-external-watch/docs/Reference.md");
        let mut registry = WatchRegistry::default();
        let lease_id = "lease-2".to_string();
        registry.leases.insert(
            lease_id.clone(),
            WatchLease {
                window_label: "main".to_string(),
                path,
            },
        );
        registry.delivering.insert(lease_id.clone());
        registry.delivery_epochs.insert(lease_id.clone(), 1);

        // Failed emit (window missing / emit error): revision is not committed,
        // so the next attempt can retry.
        complete_revision_delivery(&mut registry, &lease_id, 1, false, "rev-a".to_string());
        assert!(!registry.delivering.contains(&lease_id));
        assert!(registry.revisions.get(&lease_id).is_none());

        registry.delivering.insert(lease_id.clone());
        registry.delivery_epochs.insert(lease_id.clone(), 2);
        complete_revision_delivery(&mut registry, &lease_id, 2, true, "rev-b".to_string());
        assert_eq!(
            registry.revisions.get(&lease_id).map(String::as_str),
            Some("rev-b")
        );
    }

    #[test]
    fn old_delivery_cannot_overwrite_confirmed_local_revision() {
        let path = PathBuf::from("/tmp/flowix-external-watch/docs/Reference.md");
        let lease_id = "lease".to_string();
        let mut registry = WatchRegistry::default();
        registry.leases.insert(
            lease_id.clone(),
            WatchLease {
                window_label: "main".into(),
                path: path.clone(),
            },
        );
        assert!(try_claim_revision(&mut registry, &lease_id, &path, "old"));
        let old_epoch = registry.delivery_epochs[&lease_id];

        // The local save confirms a newer revision while the old emit is in flight.
        invalidate_delivery(&mut registry, &lease_id);
        registry.revisions.insert(lease_id.clone(), "local".into());
        complete_revision_delivery(&mut registry, &lease_id, old_epoch, true, "old".into());
        assert_eq!(registry.revisions[&lease_id], "local");

        assert!(try_claim_revision(&mut registry, &lease_id, &path, "new"));
        let new_epoch = registry.delivery_epochs[&lease_id];
        complete_revision_delivery(&mut registry, &lease_id, old_epoch, true, "old".into());
        assert!(registry.delivering.contains(&lease_id));
        complete_revision_delivery(&mut registry, &lease_id, new_epoch, true, "new".into());
        assert_eq!(registry.revisions[&lease_id], "new");
    }

    #[test]
    fn try_claim_revision_rejects_unknown_or_renamed_lease() {
        let original = PathBuf::from("/tmp/flowix-external-watch/docs/Old.md");
        let renamed = PathBuf::from("/tmp/flowix-external-watch/docs/New.md");
        let mut registry = WatchRegistry::default();
        registry.leases.insert(
            "lease-3".to_string(),
            WatchLease {
                window_label: "main".to_string(),
                path: original.clone(),
            },
        );

        assert!(!try_claim_revision(
            &mut registry,
            "missing",
            &original,
            "rev"
        ));
        assert!(!try_claim_revision(
            &mut registry,
            "lease-3",
            &renamed,
            "rev"
        ));
        assert!(!registry.delivering.contains("lease-3"));
    }
}
