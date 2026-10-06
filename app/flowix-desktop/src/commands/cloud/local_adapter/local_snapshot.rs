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
    let memo_file = read_lock(&state.memo_file, "memo_file");
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
        for memo in memo_file.read_all_memos_for_notebook_id(Some(&config.id)) {
            let cloud_id = flowix_sync::v2_path_note_id(&config.id, &memo.relative_path);
            if dirty_note_ids
                .as_ref()
                .is_some_and(|ids| !ids.contains(&cloud_id))
            {
                continue;
            }
            let path = notebook_path_from_relative(Path::new(&config.path), &memo.relative_path)
                .unwrap_or_else(|_| PathBuf::from(&config.path).join(&memo.filename));
            let content = std::fs::read(&path)
                .map_err(|error| format!("READ_NOTE_FAILED {}: {error}", path.display()))?;
            notes.push(V2LocalNote {
                id: cloud_id,
                notebook_id: config.id.clone(),
                filename: memo.relative_path,
                content,
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
        notebooks.push(V2LocalNotebook {
            id: config.id,
            name: config.name,
            icon: config.icon,
            sort_order: config.sort,
        });
    }
    Ok((notebooks, notes))
}
