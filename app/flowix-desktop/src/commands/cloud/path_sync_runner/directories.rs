//! Reconciles local directory structure with remote directory markers.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

use flowix_core::memo_file::is_syncable_notebook_directory_path;
use flowix_sync::v4::{CloudDirectoryMarker, V4DirectoryState};

use super::super::v4_adapter::MemoLocalStore;
use super::MAX_VISIBLE_FAILURES;
use crate::app::state::AppState;

const DIRECTORY_DELETE_CONFIRM_WINDOW_MS: i64 = flowix_sync::reconcile::DELETE_CONFIRM_WINDOW_MS;

pub(super) async fn sync_directories(
    state: &AppState,
    notebook_id: &str,
    local: &MemoLocalStore,
    local_directories: &[(String, String, i64)],
) -> Result<(bool, Vec<String>), String> {
    let (remote, server_now) = state
        .cloud_sync
        .v4_remote_directories(notebook_id)
        .await
        .map_err(|error| format!("CLOUD_DIRECTORY_LIST_FAILED: {notebook_id}: {error}"))?;
    let saved = state
        .cloud_sync
        .v4_directory_states(notebook_id)
        .map_err(|error| format!("CLOUD_DIRECTORY_STATE_READ_FAILED: {notebook_id}: {error}"))?;
    let old_states: HashMap<String, V4DirectoryState> = saved
        .into_iter()
        .filter(|state| is_syncable_notebook_directory_path(Path::new(&state.path)))
        .map(|state| (state.path.clone(), state))
        .collect();
    let local_dirs: BTreeMap<String, (String, i64)> = local_directories
        .iter()
        .filter(|(key, _, _)| is_syncable_notebook_directory_path(Path::new(key)))
        .map(|(key, display, mtime)| (key.clone(), (display.clone(), *mtime)))
        .collect();
    let mut excluded_remote_paths = Vec::new();
    let mut remote_dirs = HashMap::new();
    for (marker, modified) in remote {
        if is_syncable_notebook_directory_path(Path::new(&marker.path)) {
            remote_dirs.insert(marker.path.clone(), (marker, modified));
        } else {
            excluded_remote_paths.push(marker.path);
        }
    }
    let mut paths = BTreeSet::new();
    paths.extend(local_dirs.keys().cloned());
    paths.extend(remote_dirs.keys().cloned());
    paths.extend(old_states.keys().cloned());
    let mut paths: Vec<String> = paths.into_iter().collect();
    // Delete nested folders first so an empty parent can be removed afterward.
    paths.sort_by(|left, right| {
        right
            .matches('/')
            .count()
            .cmp(&left.matches('/').count())
            .then_with(|| right.cmp(left))
    });
    let mut next_states = Vec::new();
    let mut changed_local_tree = false;

    for path in paths {
        let local_dir = local_dirs.get(&path);
        let previous = old_states.get(&path);
        let remote_dir = remote_dirs.get(&path);
        let local_mtime = local_dir.map(|(_, mtime)| *mtime).unwrap_or_default();
        let local_display = local_dir
            .map(|(display, _)| display.as_str())
            .unwrap_or(&path);

        match (local_dir, remote_dir) {
            (Some(_), None) => {
                let marker = CloudDirectoryMarker {
                    schema: 1,
                    path: path.clone(),
                    deleted: false,
                };
                if let Some(modified) = state
                    .cloud_sync
                    .v4_put_directory_marker(notebook_id, &marker)
                    .await
                    .map_err(|error| format!("CLOUD_DIRECTORY_WRITE_FAILED: {path}: {error}"))?
                {
                    next_states.push(V4DirectoryState {
                        path,
                        last_synced_at: modified,
                        deleted: false,
                        local_mtime_millis: local_mtime,
                        pending_since: None,
                    });
                }
            }
            (Some(_), Some((marker, modified))) if marker.deleted => {
                let remote_is_new = previous.is_some_and(|old| *modified > old.last_synced_at);
                let previously_deleted = previous.is_some_and(|old| old.deleted);
                if remote_is_new && !previously_deleted {
                    if local
                        .remove_empty_directory(local_display)
                        .map_err(|error| {
                            format!("CLOUD_DIRECTORY_REMOVE_FAILED: {path}: {error}")
                        })?
                    {
                        changed_local_tree = true;
                        next_states.push(V4DirectoryState {
                            path,
                            last_synced_at: *modified,
                            deleted: true,
                            local_mtime_millis: local_mtime,
                            pending_since: None,
                        });
                    } else {
                        let present = CloudDirectoryMarker {
                            schema: 1,
                            path: path.clone(),
                            deleted: false,
                        };
                        if let Some(written) = state
                            .cloud_sync
                            .v4_put_directory_marker(notebook_id, &present)
                            .await
                            .map_err(|error| {
                                format!("CLOUD_DIRECTORY_WRITE_FAILED: {path}: {error}")
                            })?
                        {
                            next_states.push(V4DirectoryState {
                                path,
                                last_synced_at: written,
                                deleted: false,
                                local_mtime_millis: local_mtime,
                                pending_since: None,
                            });
                        }
                    }
                } else {
                    let present = CloudDirectoryMarker {
                        schema: 1,
                        path: path.clone(),
                        deleted: false,
                    };
                    if let Some(written) = state
                        .cloud_sync
                        .v4_put_directory_marker(notebook_id, &present)
                        .await
                        .map_err(|error| format!("CLOUD_DIRECTORY_WRITE_FAILED: {path}: {error}"))?
                    {
                        next_states.push(V4DirectoryState {
                            path,
                            last_synced_at: written,
                            deleted: false,
                            local_mtime_millis: local_mtime,
                            pending_since: None,
                        });
                    }
                }
            }
            (Some(_), Some((_, modified))) => {
                next_states.push(V4DirectoryState {
                    path,
                    last_synced_at: *modified,
                    deleted: false,
                    local_mtime_millis: local_mtime,
                    pending_since: None,
                });
            }
            (None, Some((marker, modified))) if marker.deleted => {
                next_states.push(V4DirectoryState {
                    path,
                    last_synced_at: *modified,
                    deleted: true,
                    local_mtime_millis: 0,
                    pending_since: None,
                });
            }
            (None, Some((_marker, modified))) => {
                let local_deleted = previous.is_some_and(|old| *modified <= old.last_synced_at);
                if local_deleted {
                    let already_deleted = previous.is_some_and(|old| old.deleted);
                    let pending_since = previous.and_then(|old| old.pending_since).or(server_now);
                    let confirmed = already_deleted
                        || server_now.zip(pending_since).is_some_and(|(now, since)| {
                            now.saturating_sub(since) >= DIRECTORY_DELETE_CONFIRM_WINDOW_MS
                        });
                    if confirmed {
                        let tombstone = CloudDirectoryMarker {
                            schema: 1,
                            path: path.clone(),
                            deleted: true,
                        };
                        if let Some(written) = state
                            .cloud_sync
                            .v4_put_directory_marker(notebook_id, &tombstone)
                            .await
                            .map_err(|error| {
                                format!("CLOUD_DIRECTORY_WRITE_FAILED: {path}: {error}")
                            })?
                        {
                            next_states.push(V4DirectoryState {
                                path,
                                last_synced_at: written,
                                deleted: true,
                                local_mtime_millis: 0,
                                pending_since: None,
                            });
                        }
                    } else {
                        next_states.push(V4DirectoryState {
                            path,
                            last_synced_at: previous
                                .map(|old| old.last_synced_at)
                                .unwrap_or(*modified),
                            deleted: false,
                            local_mtime_millis: 0,
                            pending_since,
                        });
                    }
                } else {
                    local.ensure_directory(&path).map_err(|error| {
                        format!("CLOUD_DIRECTORY_CREATE_FAILED: {path}: {error}")
                    })?;
                    changed_local_tree = true;
                    next_states.push(V4DirectoryState {
                        path,
                        last_synced_at: *modified,
                        deleted: false,
                        local_mtime_millis: 0,
                        pending_since: None,
                    });
                }
            }
            (None, None) => {
                if previous.is_some_and(|old| !old.deleted) {
                    let pending_since = previous.and_then(|old| old.pending_since).or(server_now);
                    let confirmed = server_now.zip(pending_since).is_some_and(|(now, since)| {
                        now.saturating_sub(since) >= DIRECTORY_DELETE_CONFIRM_WINDOW_MS
                    });
                    if confirmed {
                        let tombstone = CloudDirectoryMarker {
                            schema: 1,
                            path: path.clone(),
                            deleted: true,
                        };
                        if let Some(written) = state
                            .cloud_sync
                            .v4_put_directory_marker(notebook_id, &tombstone)
                            .await
                            .map_err(|error| {
                                format!("CLOUD_DIRECTORY_WRITE_FAILED: {path}: {error}")
                            })?
                        {
                            next_states.push(V4DirectoryState {
                                path,
                                last_synced_at: written,
                                deleted: true,
                                local_mtime_millis: 0,
                                pending_since: None,
                            });
                        }
                    } else {
                        next_states.push(V4DirectoryState {
                            path,
                            last_synced_at: previous.unwrap().last_synced_at,
                            deleted: false,
                            local_mtime_millis: 0,
                            pending_since,
                        });
                    }
                }
            }
        }
    }
    state
        .cloud_sync
        .v4_save_directory_states(notebook_id, &next_states)
        .map_err(|error| format!("CLOUD_DIRECTORY_STATE_WRITE_FAILED: {notebook_id}: {error}"))?;
    excluded_remote_paths.sort();
    excluded_remote_paths.dedup();
    let total_excluded = excluded_remote_paths.len();
    let mut errors: Vec<String> = excluded_remote_paths
        .into_iter()
        .take(MAX_VISIBLE_FAILURES)
        .map(|path| {
            format!("CLOUD_DIRECTORY_PATH_EXCLUDED: {path} is not syncable notebook content")
        })
        .collect();
    if total_excluded > MAX_VISIBLE_FAILURES {
        errors.push(format!(
            "CLOUD_DIRECTORY_PATH_EXCLUDED: {total_excluded} remote directory markers were excluded"
        ));
    }
    Ok((changed_local_tree, errors))
}
