use super::*;

const FULL_LOCAL_SNAPSHOT_INTERVAL_MS: i64 = 5 * 60 * 1_000;
pub(super) static LAST_FULL_LOCAL_SNAPSHOT_AT: AtomicI64 = AtomicI64::new(0);
static LAST_FULL_LOCAL_SNAPSHOT_BY_NOTEBOOK: OnceLock<std::sync::Mutex<HashMap<String, i64>>> =
    OnceLock::new();

pub(crate) fn record_full_local_snapshot(notebook_scope: Option<&str>) {
    let now = Utc::now().timestamp_millis();
    if let Some(scope) = notebook_scope {
        let snapshots = LAST_FULL_LOCAL_SNAPSHOT_BY_NOTEBOOK
            .get_or_init(|| std::sync::Mutex::new(HashMap::new()));
        snapshots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(scope.to_string(), now);
    } else {
        LAST_FULL_LOCAL_SNAPSHOT_AT.store(now, Ordering::SeqCst);
    }
}

/// Discover collection documents without following symlinks or entering private
/// notebook directories. An incomplete scan must never be treated as a snapshot.
pub(crate) fn scan_cloud_collections(root: &Path) -> Result<Vec<PathBuf>, String> {
    let policy = flowix_core::memo_file::FileManagementPolicy::from_notebook_root(root);
    let mut pending = vec![root.to_path_buf()];
    let mut found = Vec::new();
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory).map_err(sync_error)? {
            let entry = entry.map_err(sync_error)?;
            let path = entry.path();
            let relative = path.strip_prefix(root).map_err(sync_error)?;
            let kind = entry.file_type().map_err(sync_error)?;
            if kind.is_symlink() || relative.starts_with("attachments") || relative.starts_with(".flowix") || policy.is_index_hidden_at(root, relative) {
                continue;
            }
            if kind.is_dir() {
                pending.push(path);
            } else if kind.is_file() && flowix_core::collection::is_collection_document_path(relative) {
                found.push(path);
            }
        }
    }
    found.sort();
    Ok(found)
}

#[cfg(test)]
mod collection_scan_tests {
    use super::*;

    #[test]
    fn finds_only_visible_collection_documents() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("folder")).unwrap();
        std::fs::create_dir(root.path().join(".flowix")).unwrap();
        std::fs::write(root.path().join("folder/.index.yaml"), "collection").unwrap();
        std::fs::write(root.path().join("tasks.table.yaml"), "collection").unwrap();
        std::fs::write(root.path().join("ordinary.yaml"), "other").unwrap();
        std::fs::write(root.path().join(".flowix/private.table.yaml"), "private").unwrap();
        let paths = scan_cloud_collections(root.path()).unwrap();
        assert_eq!(paths, vec![root.path().join("folder/.index.yaml"), root.path().join("tasks.table.yaml")]);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_collection_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("hidden.table.yaml"), "outside").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("linked")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("hidden.table.yaml"), root.path().join("linked.table.yaml")).unwrap();
        assert!(scan_cloud_collections(root.path()).unwrap().is_empty());
    }
}

pub(crate) fn scan_cloud_attachments(
    root: &Path,
    directory: &Path,
    output: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if !directory.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(directory).map_err(sync_error)? {
        let entry = entry.map_err(sync_error)?;
        let path = entry.path();
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let metadata = std::fs::symlink_metadata(&path).map_err(sync_error)?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            scan_cloud_attachments(root, &path, output)?;
        } else if metadata.is_file() && path.starts_with(root) {
            output.push(path);
        }
    }
    Ok(())
}

pub(crate) fn should_run_full_local_snapshot(
    state: &AppState,
    notebook_scope: Option<&str>,
) -> Result<bool, String> {
    let enabled = state
        .cloud_sync
        .v2_enabled_notebooks()
        .map_err(sync_error)?;
    let now = Utc::now().timestamp_millis();
    let all_last = LAST_FULL_LOCAL_SNAPSHOT_AT.load(Ordering::SeqCst);
    if let Some(scope) = notebook_scope {
        let scoped_last = LAST_FULL_LOCAL_SNAPSHOT_BY_NOTEBOOK
            .get()
            .and_then(|snapshots| {
                snapshots
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .get(scope)
                    .copied()
            })
            .unwrap_or(0);
        let last = all_last.max(scoped_last);
        let interval_elapsed =
            last == 0 || now.saturating_sub(last) >= FULL_LOCAL_SNAPSHOT_INTERVAL_MS;
        return Ok(enabled
            .iter()
            .find(|notebook| notebook.notebook_id == scope)
            .is_some_and(|notebook| notebook.bootstrap_required || interval_elapsed));
    }
    if enabled.is_empty() {
        return Ok(false);
    }
    if enabled.iter().any(|notebook| notebook.bootstrap_required) {
        return Ok(true);
    }
    Ok(all_last == 0 || now.saturating_sub(all_last) >= FULL_LOCAL_SNAPSHOT_INTERVAL_MS)
}

pub(crate) fn v2_account_snapshot(
    state: &AppState,
    full_scan: bool,
    notebook_scope: Option<&str>,
) -> Result<(Vec<V2LocalNotebook>, Vec<V2LocalNote>), String> {
    let enabled: std::collections::HashSet<String> = state
        .cloud_sync
        .v2_enabled_notebooks()
        .map_err(sync_error)?
        .into_iter()
        .map(|notebook| notebook.notebook_id)
        .collect();
    let dirty_note_ids = if full_scan {
        None
    } else {
        Some(state.cloud_sync.v2_dirty_note_ids().map_err(sync_error)?)
    };
    // A complete sync snapshot may scan files. It must not hold the global
    // facade lock needed by foreground notebook switching.
    let memo_file = flowix_core::memo_file::MemoFile::new(state.user_config.config_dir().clone());
    let configs = memo_file.read_notebook_configs().map_err(sync_error)?;
    let mut notebooks = Vec::new();
    let mut notes = Vec::new();
    for config in configs
        .into_iter()
        .filter(|config| enabled.contains(&config.id))
        .filter(|config| notebook_scope.is_none_or(|scope| config.id == scope))
    {
        let root = Path::new(&config.path);
        if !root.is_dir() {
            return Err(format!("CLOUD_NOTEBOOK_UNAVAILABLE: {}", root.display()));
        }
        if full_scan {
            memo_file.reconcile_notebook_with_disk_bidirectional(&config.id)?;
        }
        let indexed_notes = match memo_file.read_note_entries(&config.id) {
            Ok(notes) => notes,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                memo_file
                    .reconcile_note_index_blocking(&config.id)
                    .map_err(|error| error.to_string())?;
                memo_file
                    .read_note_entries(&config.id)
                    .map_err(|error| error.to_string())?
            }
            Err(error) => return Err(error.to_string()),
        };
        for note in indexed_notes {
            let cloud_id = flowix_sync::v2_path_note_id(&config.id, &note.relative_path);
            if dirty_note_ids
                .as_ref()
                .is_some_and(|ids| !ids.contains(&cloud_id))
            {
                continue;
            }
            let path = if flowix_core::memo_file::FileManagementPolicy::is_user_data_path(Path::new(&note.relative_path)) {
                safe_cloud_note_path(root, &note.relative_path)?
            } else {
                notebook_path_from_relative(root, &note.relative_path)?
            };
            let content = std::fs::read(&path)
                .map_err(|error| format!("READ_NOTE_FAILED {}: {error}", path.display()))?;
            notes.push(V2LocalNote {
                id: cloud_id,
                notebook_id: config.id.clone(),
                filename: note.relative_path,
                content,
                attachments: Vec::new(),
            });
        }
        for path in scan_cloud_collections(root)? {
            let relative_path = flowix_core::memo_file::notebook_relative_path(root, &path)?;
            let cloud_id = flowix_sync::v2_path_note_id(&config.id, &relative_path);
            if dirty_note_ids.as_ref().is_some_and(|ids| !ids.contains(&cloud_id)) {
                continue;
            }
            let path = safe_cloud_collection_path(root, &relative_path)?;
            notes.push(V2LocalNote {
                id: cloud_id,
                notebook_id: config.id.clone(),
                filename: relative_path,
                content: std::fs::read(&path).map_err(sync_error)?,
                attachments: Vec::new(),
            });
        }
        let mut attachment_paths = Vec::new();
        scan_cloud_attachments(root, &root.join("attachments"), &mut attachment_paths)?;
        for path in attachment_paths {
            let relative_path = flowix_core::memo_file::notebook_relative_path(root, &path)?;
            let cloud_id = flowix_sync::v2_path_note_id(&config.id, &relative_path);
            if dirty_note_ids
                .as_ref()
                .is_some_and(|ids| !ids.contains(&cloud_id))
            {
                continue;
            }
            notes.push(V2LocalNote {
                id: cloud_id,
                notebook_id: config.id.clone(),
                filename: relative_path,
                content: std::fs::read(&path).map_err(sync_error)?,
                attachments: Vec::new(),
            });
        }
        if full_scan && state.cloud_sync.v2_notebook(&config.id).map_err(sync_error)?
            .is_some_and(|notebook| notebook.enabled && !notebook.bootstrap_required)
        {
            let moving: HashSet<_> = state.cloud_sync.v2_pending_moves().map_err(sync_error)?
                .into_iter().filter(|movement| movement.notebook_id == config.id)
                .map(|movement| movement.from_note_id).collect();
            for prior in state.cloud_sync.v2_all_note_states().map_err(sync_error)?.into_iter()
                .filter(|item| item.notebook_id == config.id && !item.deleted && !moving.contains(&item.note_id)
                    && flowix_core::collection::is_collection_document_path(Path::new(&item.filename)))
            {
                let Ok(path) = safe_cloud_collection_path(root, &prior.filename) else { continue };
                match std::fs::symlink_metadata(path) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        state.cloud_sync.record_v2_local_change(&config.id, &prior.note_id, flowix_sync::LocalChangeKind::Delete, "deleted").map_err(sync_error)?;
                    }
                    Err(error) => return Err(sync_error(error)),
                    Ok(_) => {},
                }
            }
        }
        notebooks.push(V2LocalNotebook {
            id: config.id,
            name: config.name,
            icon: config.icon,
            sort_order: config.sort,
        });
    }
    Ok((notebooks, notes))
}
