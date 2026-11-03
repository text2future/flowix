//! Notebook lifecycle and device-local registration in db/local.db.
use crate::events as dispatcher;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::lock_utils::{read_lock, write_lock};
use flowix_core::memo_file::{MemoFile, Notebook, NotebookConfig};
use flowix_sync::V2LocalNotebook;

use super::agent_workspace::AGENT_WORKSPACE_CHANGED_EVENT;
use super::helpers::{
    record_created_notebook_access, refresh_current_notebook_watcher,
    switch_notebook_trusting_index,
};
use crate::app::state::{AppState, NotebookImportStatus, NotebookImportStatusKind};

const NOTEBOOK_IMPORT_COMPLETE_EVENT: &str = "notebook-import-complete";
/// 笔�?�?��表发生变�?(reorder / create / update / delete) �?emit, 其它窗口
/// store 监听�?reload。前�?TS 类型 `notebooks-changed` 事件 payload �?unit�?
pub(crate) const NOTEBOOKS_CHANGED_EVENT: &str = "notebooks-changed";
const NOTEBOOK_IMPORT_STATUS_EVENT: &str = "notebook-import-status";

pub(crate) fn emit_notebook_import_status(
    state: &AppState,
    app: &AppHandle,
    notebook_id: &str,
    status: NotebookImportStatusKind,
    message: Option<String>,
) {
    let payload = NotebookImportStatus {
        notebook_id: notebook_id.to_string(),
        status,
        message,
    };
    if let Ok(mut imports) = state.notebook_imports.lock() {
        imports.insert(notebook_id.to_string(), payload.clone());
    }
    dispatcher::emit_to(app, NOTEBOOK_IMPORT_STATUS_EVENT, payload);
}

fn notebook_path_missing(path: &str) -> bool {
    path.trim().is_empty() || !Path::new(path).is_dir()
}

fn normalize_notebook_icon(icon: Option<String>) -> Option<String> {
    icon.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_notebook_path(path: &str) -> String {
    if path.ends_with('/') || path.ends_with('\\') {
        path.to_string()
    } else {
        format!("{}/", path)
    }
}

fn record_notebook_metadata_change(state: &AppState, app: &AppHandle, config: &NotebookConfig) {
    let notebook = V2LocalNotebook {
        id: config.id.clone(),
        name: config.name.clone(),
        icon: config.icon.clone(),
        sort_order: config.sort,
    };
    match state.cloud_sync.record_v2_notebook_change(&notebook) {
        Ok(true) => crate::commands::cloud::schedule_notebook_sync(app.clone(), config.id.clone()),
        Ok(false) => {}
        Err(error) => tracing::warn!(
            "failed to persist cloud notebook metadata change {}: {error}",
            config.id
        ),
    }
}

fn comparable_notebook_path(path: &str) -> String {
    path.trim_end_matches(|c| c == '/' || c == '\\')
        .to_ascii_lowercase()
}

fn is_valid_notebook_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn generate_notebook_id() -> String {
    format!("nb_{}", uuid::Uuid::now_v7())
}

fn notebook_from_config(config: NotebookConfig) -> Notebook {
    Notebook {
        missing: notebook_path_missing(&config.path),
        id: config.id,
        name: config.name,
        icon: config.icon.unwrap_or_default(),
        path: config.path,
        created_at: config.created_at,
        updated_at: config.updated_at,
        is_default: config.is_default,
        sort: config.sort,
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookListItem {
    #[serde(flatten)]
    notebook: NotebookConfig,
    pinned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    memo_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    missing: Option<bool>,
}

fn create_notebook_registry(
    name: &str,
    path: &str,
    icon: Option<String>,
    memo_file: &MemoFile,
) -> Result<NotebookConfig, String> {
    create_notebook_registry_with_id(name, path, icon, None, memo_file)
}

fn default_notebook_path_without_create(name: &str) -> Result<PathBuf, String> {
    let safe_name: String = name
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let safe_name = safe_name.trim().trim_matches('.');
    if safe_name.is_empty() {
        return Err("INVALID_NAME".to_string());
    }
    let documents = dirs::document_dir()
        .or_else(|| dirs::home_dir().map(|home| home.join("Documents")))
        .ok_or_else(|| "DOCUMENTS_DIR_UNAVAILABLE".to_string())?;
    Ok(documents.join("flowix").join(safe_name))
}

fn default_notebook_path(name: &str) -> Result<PathBuf, String> {
    let path = default_notebook_path_without_create(name)?;
    std::fs::create_dir_all(&path).map_err(|error| format!("PATH_CREATE_FAILED: {error}"))?;
    Ok(path)
}

#[tauri::command]
pub fn get_default_notebook_path(name: String) -> Result<String, String> {
    default_notebook_path_without_create(name.trim())?
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "PATH_INVALID_UTF8".to_string())
}

/// Resolve and create a product-owned default notebook directory. This is a
/// separate command because the preview command above intentionally has no
/// filesystem side effect.
#[tauri::command]
pub async fn ensure_default_notebook_path(name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        default_notebook_path(name.trim())?
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| "PATH_INVALID_UTF8".to_string())
    })
    .await
    .map_err(|error| format!("default notebook path task failed: {error}"))?
}

fn create_notebook_registry_with_id(
    name: &str,
    path: &str,
    icon: Option<String>,
    requested_id: Option<&str>,
    memo_file: &MemoFile,
) -> Result<NotebookConfig, String> {
    let now = chrono::Utc::now().timestamp_millis();
    let normalized_path = normalize_notebook_path(path);
    let comparable_path = comparable_notebook_path(&normalized_path);
    let normalized_icon = normalize_notebook_icon(icon);

    tracing::info!(
        "[create_notebook] start name={} path={}",
        name,
        normalized_path
    );

    // 创建顺序: 1) 先�?现有 configs 验证�?��不冲�? 2) �?next sort;
    // 3) 组�? NotebookConfig 写盘。sort �?MAX(sort)+10 让新行落到末�?    // (ORDER BY sort ASC), 不取 len �?���?reorder �?sort �?��疏的�?
    let mut configs = memo_file
        .read_notebook_configs()
        .map_err(|error| format!("INDEX_READ_FAILED: {error}"))?;
    if configs
        .iter()
        .any(|notebook| comparable_notebook_path(&notebook.path) == comparable_path)
    {
        return Err("PATH_ALREADY_REGISTERED".to_string());
    }
    let manifest_id = MemoFile::read_notebook_manifest(Path::new(&normalized_path))
        .map_err(|error| format!("NOTEBOOK_MANIFEST_READ_FAILED: {error}"))?
        .map(|manifest| manifest.notebook_id);
    if let (Some(requested), Some(manifest)) = (requested_id, manifest_id.as_deref()) {
        if requested != manifest {
            return Err("NOTEBOOK_MANIFEST_ID_CONFLICT".to_string());
        }
    }
    let requested_id = requested_id.or(manifest_id.as_deref());
    let id = if let Some(id) = requested_id {
        if !is_valid_notebook_id(id) {
            return Err("INVALID_NOTEBOOK_ID".to_string());
        }
        if let Some(existing) = configs.iter_mut().find(|notebook| notebook.id == id) {
            if Path::new(&existing.path).is_dir() {
                return Err("NOTEBOOK_ID_ALREADY_REGISTERED".to_string());
            }
            existing.path = normalized_path.clone();
            existing.name = name.to_string();
            existing.icon = normalized_icon.clone();
            existing.updated_at = now;
            let relocated = existing.clone();
            memo_file
                .write_notebook_configs(&configs)
                .map_err(|error| format!("INDEX_WRITE_FAILED: {error}"))?;
            return Ok(relocated);
        }
        id.to_string()
    } else {
        loop {
            let candidate = generate_notebook_id();
            if configs.iter().all(|notebook| notebook.id != candidate) {
                break candidate;
            }
        }
    };
    let next_sort = memo_file
        .next_notebook_sort()
        .map_err(|e| format!("INDEX_READ_FAILED: {e}"))?;
    let config = NotebookConfig {
        id: id.clone(),
        name: name.to_string(),
        icon: normalized_icon,
        path: normalized_path,
        is_default: false,
        sort: next_sort,
        created_at: now,
        updated_at: now,
    };
    configs.push(config.clone());
    memo_file
        .write_notebook_configs(&configs)
        .map_err(|e| format!("INDEX_WRITE_FAILED: {e}"))?;

    tracing::info!("[create_notebook] registry written id={}", id);
    Ok(config)
}

fn cloud_restore_directory_is_empty(path: &Path) -> Result<bool, String> {
    let entries = std::fs::read_dir(path).map_err(|error| format!("PATH_READ_FAILED: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("PATH_READ_FAILED: {error}"))?;
        let name = entry.file_name();
        if matches!(name.to_str(), Some(".DS_Store" | ".localized")) {
            continue;
        }
        return Ok(false);
    }
    Ok(true)
}

fn notify_notebook_workspace_changed(app: &AppHandle) {
    dispatcher::emit_to(app, AGENT_WORKSPACE_CHANGED_EVENT, ());
}

fn set_current_notebook_inner(
    notebook_id: Option<String>,
    state: &AppState,
    app: &AppHandle,
) -> Result<(), String> {
    // Every caller, including notebook create/delete fallback paths, uses the
    // same serialized transition. The lock covers the complete operation so
    // a second request cannot observe a half-switched MemoFile/search pair.
    state.startup.wait_until_ready()?;
    let _transition = state
        .notebook_transition
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let previous_id = read_lock(&state.memo_file, "memo_file").current_notebook_id_value();

    // Fast path for ordinary switching: trust memo index and avoid synchronous
    // disk reconciliation. Search index rebuild is lazy, triggered by search.
    if let Err(error) = switch_notebook_trusting_index(state, notebook_id.clone()) {
        if let Err(restore_error) = switch_notebook_trusting_index(state, previous_id) {
            tracing::error!(
                "[set_current_notebook] failed to restore previous notebook after switch error: {restore_error}"
            );
        }
        return Err(error);
    }

    if let Err(error) = read_lock(&state.memo_file, "memo_file")
        .write_selected_notebook_id(notebook_id.as_deref())
        .map_err(|error| format!("persist selected notebook failed: {error}"))
    {
        // Keep the process-local and persisted selection aligned if the second
        // half of the switch fails. The original error remains authoritative.
        if let Err(restore_error) = switch_notebook_trusting_index(state, previous_id) {
            tracing::error!(
                "[set_current_notebook] failed to restore previous notebook after persistence error: {restore_error}"
            );
        }
        return Err(error);
    }

    let active_watcher_id =
        crate::commands::helpers::rebind_current_notebook_watcher_while_transition_locked(
            state, app,
        );
    drop(_transition);
    if let Some(notebook_id) = notebook_id.as_deref() {
        state.notebook_background.prioritize(notebook_id);
    }
    if let Some(notebook_id) = active_watcher_id {
        state.notebook_background.request(&notebook_id, true, true);
    }
    Ok(())
}

fn activate_created_notebook(
    config: &NotebookConfig,
    state: &AppState,
    app: &AppHandle,
) -> Result<(), String> {
    set_current_notebook_inner(Some(config.id.clone()), state, app)?;
    tracing::info!("[create_notebook] selected notebook id={}", config.id);
    Ok(())
}

pub(crate) fn run_notebook_import(
    app: AppHandle,
    notebook_id: String,
    seed_onboarding_docs: bool,
) -> bool {
    let started = std::time::Instant::now();
    tracing::info!(
        "[create_notebook] background import start id={}",
        notebook_id
    );
    let app_state = app.state::<AppState>();

    let import_result = (|| {
        let mut index_changed = false;
        let mut onboarding_docs_seeded = false;
        {
            let memo_file = read_lock(&app_state.memo_file, "memo_file");
            match memo_file.has_legacy_notebook_internal_data(&notebook_id) {
                Ok(true) => {
                    if let Err(error) = memo_file.ensure_notebook_structure_migration(&notebook_id)
                    {
                        tracing::warn!(notebook = %notebook_id, %error, "legacy plugin artifact migration deferred");
                    }
                }
                Ok(false) => {}
                Err(error) => {
                    tracing::warn!(notebook = %notebook_id, %error, "legacy plugin artifact check deferred")
                }
            }
            tracing::info!(
                "[create_notebook] import/reconcile start id={}",
                notebook_id
            );

            // Reconcile by explicit notebook ID. This keeps the background job
            // independent from whichever notebook the user currently views and
            // avoids switching the global MemoFile context from a worker thread.
            let report = memo_file
                .reconcile_note_index(&notebook_id)
                .map_err(|error| format!("notebook path reconciliation failed: {error}"))?;
            index_changed = report.added + report.updated + report.removed > 0;
            tracing::info!(
                "[create_notebook] path reconciliation done id={} added={} updated={} removed={}",
                notebook_id,
                report.added,
                report.updated,
                report.removed
            );

            if seed_onboarding_docs {
                tracing::info!("[create_notebook] seed onboarding start id={}", notebook_id);
                match memo_file.seed_onboarding_docs_for_notebook_id(&notebook_id) {
                    Ok(true) => {
                        onboarding_docs_seeded = true;
                        tracing::info!("[create_notebook] seeded onboarding documents");
                    }
                    Ok(false) => tracing::debug!(
                        "[create_notebook] onboarding documents skipped (notebook already has documents)"
                    ),
                    Err(error) => return Err(format!("seed onboarding documents failed: {error}")),
                }
            }
        };
        if index_changed || onboarding_docs_seeded {
            dispatcher::emit_to(
                &app,
                "flowix:path-note-changed",
                serde_json::json!({
                    "notebookId": notebook_id,
                    "relativePath": "",
                    "deleted": false,
                }),
            );
        }
        Ok::<(), String>(())
    })();

    crate::runtime_log::record_event(
        "info",
        "notebook.import.timing",
        format!(
            "notebook={} total_ms={} success={}",
            notebook_id,
            started.elapsed().as_millis(),
            import_result.is_ok()
        ),
    );
    if let Err(error) = import_result {
        tracing::warn!("[create_notebook] background import failed: {error}");
        emit_notebook_import_status(
            app_state.inner(),
            &app,
            &notebook_id,
            NotebookImportStatusKind::Failed,
            Some(error),
        );
        return false;
    }
    emit_notebook_import_status(
        app_state.inner(),
        &app,
        &notebook_id,
        NotebookImportStatusKind::Completed,
        None,
    );
    dispatcher::emit_to(&app, NOTEBOOK_IMPORT_COMPLETE_EVENT, notebook_id);
    tracing::info!("[create_notebook] import complete emitted");
    true
}

fn spawn_notebook_import(app: AppHandle, notebook_id: String) {
    std::thread::spawn(move || run_notebook_import(app, notebook_id, true));
}

#[tauri::command]
pub async fn get_notebooks(app: AppHandle) -> Result<Vec<NotebookListItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let configs = memo_file
            .read_notebook_configs()
            .map_err(|error| error.to_string())?;
        let pinned_ids = memo_file
            .read_notebook_pin_states()
            .map_err(|error| error.to_string())?;
        // Metadata-only read: no path probes, count queries or filesystem scans.
        Ok::<_, String>(
            configs
                .into_iter()
                .map(|config| {
                    let cached = state.notebook_background.snapshot(&config.id);
                    NotebookListItem {
                        pinned: pinned_ids.contains(&config.id),
                        memo_count: cached.as_ref().and_then(|status| status.memo_count),
                        missing: cached.as_ref().and_then(|status| status.missing),
                        notebook: config,
                    }
                })
                .collect::<Vec<_>>(),
        )
    })
    .await
    .map_err(|error| format!("notebook list task failed: {error}"))?
}

#[tauri::command]
pub fn set_notebook_pinned(
    notebook_id: String,
    pinned: bool,
    state: State<AppState>,
    app: AppHandle,
) -> Result<bool, String> {
    let memo_file = write_lock(&state.memo_file, "memo_file");
    let changed = memo_file
        .set_notebook_pinned(&notebook_id, pinned)
        .map_err(|error| format!("INDEX_WRITE_FAILED: {error}"))?;
    drop(memo_file);
    if changed {
        dispatcher::emit_to(&app, NOTEBOOKS_CHANGED_EVENT, ());
    }
    Ok(changed)
}

#[tauri::command]
pub fn get_notebook_background_status(
    state: State<AppState>,
) -> Vec<crate::app::notebook_background::NotebookBackgroundStatus> {
    state.notebook_background.statuses()
}

#[tauri::command]
pub fn get_notebook_media_maintenance_status(
    state: State<AppState>,
) -> Vec<crate::app::notebook_background::NotebookMediaMaintenanceStatus> {
    state.notebook_background.media_statuses()
}

#[tauri::command]
pub fn request_notebook_media_maintenance(
    notebook_id: String,
    app: AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    let status = state
        .notebook_background
        .request_media(&notebook_id)
        .ok_or_else(|| "媒体维护队列已停止".to_string())?;
    let _ = app.emit(crate::app::notebook_background::MEDIA_EVENT, status);
    Ok(())
}

#[tauri::command]
pub fn request_notebook_refresh(notebook_id: String, state: State<AppState>) {
    state.notebook_background.request(&notebook_id, true, true);
}

#[tauri::command]
pub async fn create_notebook(
    name: String,
    path: Option<String>,
    icon: Option<String>,
    activate: Option<bool>,
    app: AppHandle,
) -> Result<Notebook, String> {
    let started = std::time::Instant::now();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let trimmed_name = name.trim();
        if trimmed_name.is_empty() {
            return Err("INVALID_NAME".to_string());
        }
        let default_path;
        let trimmed_path = match path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            Some(path) => path,
            None => {
                default_path = default_notebook_path(trimmed_name)?;
                default_path
                    .to_str()
                    .ok_or_else(|| "PATH_INVALID_UTF8".to_string())?
            }
        };
        if !Path::new(trimmed_path).is_dir() {
            return Err("PATH_MISSING".to_string());
        }
        let comparable_path = comparable_notebook_path(&normalize_notebook_path(trimmed_path));
        if read_lock(&state.memo_file, "memo_file")
            .read_notebook_configs()
            .unwrap_or_default()
            .iter()
            .any(|notebook| comparable_notebook_path(&notebook.path) == comparable_path)
        {
            return Err("PATH_ALREADY_REGISTERED".to_string());
        }
        // Also handles dependency deletion while the window stayed open.
        state.user_config.ensure_runtime_storage()?;
        let config = {
            let memo_file = write_lock(&state.memo_file, "memo_file");
            create_notebook_registry_with_id(trimmed_name, trimmed_path, icon, None, &memo_file)?
        };
        notify_notebook_workspace_changed(&app);
        if activate.unwrap_or(true) {
            activate_created_notebook(&config, state.inner(), &app)?;
        } else {
            // The onboarding flow activates the notebook only after all steps are
            // complete. Register its directory access now; the watcher attaches
            // when the notebook becomes the selected one.
            record_created_notebook_access(state.inner(), &app, &config);
        }
        dispatcher::emit_to(&app, NOTEBOOKS_CHANGED_EVENT, ());

        Ok(notebook_from_config(config))
    })
    .await
    .map_err(|error| format!("notebook creation task failed: {error}"))?;
    if let Err(error) = &result {
        crate::runtime_log::record_event("error", "notebook.create.failed", error);
    }
    crate::runtime_log::record_event(
        "info",
        "notebook.create.timing",
        format!(
            "total_ms={} success={}",
            started.elapsed().as_millis(),
            result.is_ok()
        ),
    );
    result
}

/// Start importing an ordinary local notebook after the frontend has applied
/// the newly created notebook to its local selection state. Keeping this as a
/// separate command closes the event race where the worker could finish before
/// the frontend had selected the returned notebook.
#[tauri::command]
pub fn start_notebook_import(
    notebook_id: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let exists = read_lock(&state.memo_file, "memo_file")
        .get_notebook_config_by_id(&notebook_id)
        .is_some();
    if !exists {
        return Err("NOTEBOOK_NOT_FOUND".to_string());
    }

    // The command is idempotent while a job is running. This also prevents a
    // double click or duplicate IPC request from importing the same notebook
    // concurrently and racing its index updates.
    let already_running = state
        .notebook_imports
        .lock()
        .map(|imports| {
            imports
                .get(&notebook_id)
                .is_some_and(|status| matches!(status.status, NotebookImportStatusKind::Started))
        })
        .unwrap_or(false);
    if already_running {
        return Ok(());
    }

    emit_notebook_import_status(
        state.inner(),
        &app,
        &notebook_id,
        NotebookImportStatusKind::Started,
        None,
    );
    spawn_notebook_import(app, notebook_id);
    Ok(())
}

#[tauri::command]
pub fn get_notebook_import_status(
    notebook_id: String,
    state: State<AppState>,
) -> Option<NotebookImportStatus> {
    state
        .notebook_imports
        .lock()
        .ok()
        .and_then(|imports| imports.get(&notebook_id).cloned())
}

/// Register an empty local mount for a Cloud notebook while preserving the
/// Cloud notebook's immutable identity. Unlike ordinary notebook creation,
/// this path intentionally skips onboarding seeding and background disk import
/// so the first synchronization starts from a clean local snapshot.
#[tauri::command]
pub fn create_notebook_from_cloud(
    id: String,
    name: String,
    path: String,
    icon: Option<String>,
    activate: Option<bool>,
    state: State<AppState>,
    app: AppHandle,
) -> Result<Notebook, String> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("INVALID_NAME".to_string());
    }
    let trimmed_path = path.trim();
    if trimmed_path.is_empty() {
        return Err("INVALID_PATH".to_string());
    }
    if !is_valid_notebook_id(&id) {
        return Err("INVALID_NOTEBOOK_ID".to_string());
    }

    let directory = Path::new(trimmed_path);
    if !directory.is_dir() {
        return Err("PATH_MISSING".to_string());
    }
    if !cloud_restore_directory_is_empty(directory)? {
        return Err("PATH_NOT_EMPTY".to_string());
    }
    let config = {
        let memo_file = write_lock(&state.memo_file, "memo_file");
        create_notebook_registry_with_id(trimmed_name, trimmed_path, icon, Some(&id), &memo_file)?
    };
    notify_notebook_workspace_changed(&app);
    if activate.unwrap_or(true) {
        activate_created_notebook(&config, state.inner(), &app)?;
    } else {
        record_created_notebook_access(state.inner(), &app, &config);
    }
    dispatcher::emit_to(&app, NOTEBOOKS_CHANGED_EVENT, ());

    Ok(notebook_from_config(config))
}

#[tauri::command]
pub fn update_notebook(
    id: String,
    name: Option<String>,
    icon: Option<String>,
    state: State<AppState>,
    app: AppHandle,
) -> Option<Notebook> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let mut configs = memo_file.read_notebook_configs().ok()?;

    let index = configs.iter().position(|c| c.id == id)?;

    if let Some(n) = name {
        configs[index].name = n;
    }
    if let Some(i) = icon {
        configs[index].icon = normalize_notebook_icon(Some(i));
    }
    configs[index].updated_at = chrono::Utc::now().timestamp_millis();

    memo_file.write_notebook_configs(&configs).ok()?;

    let updated = configs[index].clone();
    drop(memo_file);

    notify_notebook_workspace_changed(&app);
    record_notebook_metadata_change(state.inner(), &app, &updated);

    Some(Notebook {
        id: updated.id,
        name: updated.name,
        missing: notebook_path_missing(&updated.path),
        path: updated.path,
        icon: updated.icon.unwrap_or_default(),
        created_at: updated.created_at,
        updated_at: updated.updated_at,
        is_default: updated.is_default,
        sort: updated.sort,
    })
}

#[tauri::command]
pub fn set_notebook_primary_directory(
    id: String,
    path: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<Notebook, String> {
    state.startup.wait_until_ready()?;
    let updated = {
        let _transition = state
            .notebook_transition
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let memo_file = write_lock(&state.memo_file, "memo_file");
        let _change_guard = memo_file
            .operation_locks()
            .notebook_change(&[id.as_str()], "set_notebook_primary_directory")
            .map_err(|error| format!("NOTEBOOK_BUSY: {error}"))?;
        memo_file
            .set_notebook_primary_directory(&id, &path)
            .map_err(|error| format!("PRIMARY_DIRECTORY_UPDATE_FAILED: {error}"))?
    };

    record_created_notebook_access(state.inner(), &app, &updated);
    notify_notebook_workspace_changed(&app);
    dispatcher::emit_to(&app, NOTEBOOKS_CHANGED_EVENT, ());
    Ok(notebook_from_config(updated))
}

#[tauri::command]
pub fn delete_notebook(
    id: String,
    delete_local_files: bool,
    state: State<AppState>,
    app: AppHandle,
) -> Result<bool, String> {
    let (was_current, next_notebook_id) = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let _change_guard = memo_file
            .operation_locks()
            .notebook_change(&[&id], "remove_notebook_from_registry")
            .map_err(|error| format!("NOTEBOOK_BUSY: {error}"))?;
        let mut configs = memo_file
            .read_notebook_configs()
            .map_err(|error| error.to_string())?;

        let index = match configs.iter().position(|c| c.id == id) {
            Some(idx) => idx,
            None => return Err("NOTEBOOK_NOT_FOUND".to_string()),
        };
        if delete_local_files {
            let notebook_root = match std::fs::canonicalize(&configs[index].path) {
                Ok(root) => Some(root),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(format!("NOTEBOOK_PATH_INVALID: {error}")),
            };
            if let Some(notebook_root) = notebook_root {
                if !notebook_root.is_dir() || notebook_root.parent().is_none() {
                    return Err("NOTEBOOK_PATH_INVALID".to_string());
                }
                // A notebook may be configured inside another notebook (or
                // vice versa). Do not let deleting one registered root erase another.
                for other in configs.iter().filter(|config| config.id != id) {
                    if let Ok(other_root) = std::fs::canonicalize(&other.path) {
                        if notebook_root.starts_with(&other_root)
                            || other_root.starts_with(&notebook_root)
                        {
                            return Err("NOTEBOOK_PATH_OVERLAPS_ANOTHER_NOTEBOOK".to_string());
                        }
                    }
                }
                std::fs::remove_dir_all(&notebook_root)
                    .map_err(|error| format!("NOTEBOOK_FILES_DELETE_FAILED: {error}"))?;
            }
        }

        let was_current = memo_file.current_notebook_id_value().as_deref() == Some(id.as_str());
        configs.remove(index);
        let next_notebook_id = if was_current {
            configs.first().map(|config| config.id.clone())
        } else {
            None
        };

        memo_file
            .write_notebook_configs(&configs)
            .map_err(|e| format!("INDEX_WRITE_FAILED: {e}"))?;
        (was_current, next_notebook_id)
    };
    // Keep the native operation context and the persisted selection valid even
    // when the deletion is initiated outside the main Webview. The frontend
    // performs the same transition for its workspace state, but the backend
    // must not retain an id that has just been removed.
    let selection_transition_completed = if was_current {
        match set_current_notebook_inner(next_notebook_id.clone(), state.inner(), &app) {
            Ok(()) => true,
            Err(error) => {
                tracing::error!(
                    deleted_notebook = %id,
                    next_notebook = ?next_notebook_id,
                    %error,
                    "failed to select first remaining notebook after deletion"
                );
                // `set_current_notebook_inner` may fail while running migrations;
                // still repair the cross-process selection record so a restart
                // cannot resurrect the deleted notebook.
                if let Err(persist_error) = read_lock(&state.memo_file, "memo_file")
                    .write_selected_notebook_id(next_notebook_id.as_deref())
                {
                    tracing::error!(%persist_error, "failed to persist deletion fallback notebook");
                }
                false
            }
        }
    } else {
        false
    };

    if let Err(error) = state.cloud_sync.record_v2_notebook_delete(&id) {
        tracing::warn!("failed to persist cloud notebook deletion {id}: {error}");
    } else {
        crate::commands::cloud::schedule_notebook_sync(app.clone(), id.clone());
    }

    notify_notebook_workspace_changed(&app);
    if was_current && !selection_transition_completed {
        refresh_current_notebook_watcher(state.inner(), &app);
    }
    dispatcher::emit_to(&app, NOTEBOOKS_CHANGED_EVENT, ());
    Ok(true)
}

/// Reorder 客户�?��来的 sort 列表�?///
/// - 前�?�?`Vec<NotebookSortEntry>` 表达 "新顺�? 这个 id �?sort 应是这个�?�?/// - 不在该列表中�?notebook id 保留�?sort 不动 (后�?不擅�?��排未参与 reorder 的�?)�?/// - 写入事务; 失败回滚并返�?`Err(String)`, �?IPC 约定错�?�?String�?/// - 写完返回最�?`Vec<Notebook>`, 前�? store 直接 setState 即可�?/// - 跨窗口事�? `NOTEBOOKS_CHANGED_EVENT` 让其它窗�?reload�?
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookSortEntry {
    pub id: String,
    pub sort: i64,
}

#[tauri::command]
pub fn reorder_notebooks(
    order: Vec<NotebookSortEntry>,
    state: State<AppState>,
    app: AppHandle,
) -> Result<Vec<Notebook>, String> {
    let memo_file = write_lock(&state.memo_file, "memo_file");

    // 防御: order 为空直接 no-op (前�?�?��空数组时保留�?��一�? 不动磁盘)�?
    if order.is_empty() {
        let configs = memo_file
            .read_notebook_configs()
            .map_err(|e| format!("INDEX_READ_FAILED: {e}"))?;
        return Ok(configs.into_iter().map(notebook_from_config).collect());
    }

    // 把�?户�?发来�?(id, sort) 合并到现�?NotebookConfig: 保留每个 notebook
    // �?name / icon / path / is_default / created_at / updated_at, 仅�?�?sort�?    // �?��现在 order 里的 notebook 保持�?sort (后�?不擅�?���?�?
    let mut configs = memo_file
        .read_notebook_configs()
        .map_err(|e| format!("INDEX_READ_FAILED: {e}"))?;
    let sort_map: std::collections::HashMap<&str, i64> = order
        .iter()
        .map(|entry| (entry.id.as_str(), entry.sort))
        .collect();
    for config in configs.iter_mut() {
        if let Some(new_sort) = sort_map.get(config.id.as_str()) {
            config.sort = *new_sort;
            config.updated_at = chrono::Utc::now().timestamp_millis();
        }
    }
    memo_file
        .write_notebook_configs(&configs)
        .map_err(|e| format!("INDEX_WRITE_FAILED: {e}"))?;

    // read_notebook_configs 内部会回�?memo_file 缓存; 再�?一次拿�?ORDER BY sort 的最新顺序�?
    let updated = memo_file
        .read_notebook_configs()
        .map_err(|e| format!("INDEX_READ_FAILED: {e}"))?;
    drop(memo_file);

    for config in &updated {
        if sort_map.contains_key(config.id.as_str()) {
            record_notebook_metadata_change(state.inner(), &app, config);
        }
    }
    let notebooks: Vec<Notebook> = updated.into_iter().map(notebook_from_config).collect();

    // 跨窗口同�? 让其它窗�?reload。NOTEBOOKS_CHANGED_EVENT �?dispatcher::emit_to
    // Notify other windows; the caller updates its own store from the IPC result.
    dispatcher::emit_to(&app, NOTEBOOKS_CHANGED_EVENT, ());
    Ok(notebooks)
}

#[tauri::command]
pub fn clear_notebooks(state: State<AppState>, app: AppHandle) -> Result<bool, String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let configs = memo_file
        .read_notebook_configs()
        .map_err(|error| error.to_string())?;
    let ids: Vec<&str> = configs.iter().map(|config| config.id.as_str()).collect();
    let _change_guard = if ids.is_empty() {
        None
    } else {
        Some(
            memo_file
                .operation_locks()
                .notebook_change(&ids, "clear_notebooks")
                .map_err(|error| format!("NOTEBOOK_BUSY: {error}"))?,
        )
    };
    let current_ids: std::collections::HashSet<String> = memo_file
        .read_notebook_configs()
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|config| config.id)
        .collect();
    if current_ids != ids.iter().map(|id| (*id).to_owned()).collect() {
        return Err("NOTEBOOK_REGISTRY_CHANGED".to_string());
    }
    let before_ids: std::collections::HashSet<String> =
        configs.iter().map(|c| c.id.clone()).collect();

    let ok = memo_file.write_notebook_configs(&[]).is_ok();
    drop(_change_guard);
    drop(memo_file);
    // 把�?清掉的非默�? notebook �?access 列表里也清掉, 然后 emit 一欰�?
    for id in before_ids {
        if let Err(error) = state.cloud_sync.record_v2_notebook_delete(&id) {
            tracing::warn!("failed to persist cleared cloud notebook {id}: {error}");
        } else {
            crate::commands::cloud::schedule_notebook_sync(app.clone(), id.clone());
        }
    }
    notify_notebook_workspace_changed(&app);
    refresh_current_notebook_watcher(state.inner(), &app);
    Ok(ok)
}

#[tauri::command]
pub async fn set_current_notebook(
    notebook_id: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        set_current_notebook_inner(notebook_id, state.inner(), &app)
    })
    .await
    .map_err(|error| format!("notebook switch task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_root() -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!(
            "flowix-notebook-command-test-{}-{}-{}",
            std::process::id(),
            n,
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create temp root");
        root
    }

    fn memo_file_for_test(root: &std::path::Path) -> MemoFile {
        let config_dir = root.join("config");
        fs::create_dir_all(&config_dir).expect("create config dir");
        MemoFile::new(config_dir)
    }

    #[test]
    fn notebook_list_distinguishes_unknown_statistics_from_a_known_empty_index() {
        let config = NotebookConfig {
            id: "offline".into(),
            name: "Offline".into(),
            icon: None,
            path: "/unavailable/notebook".into(),
            is_default: false,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        };
        let unknown = serde_json::to_value(NotebookListItem {
            notebook: config.clone(),
            pinned: false,
            memo_count: None,
            missing: None,
        })
        .unwrap();
        assert!(unknown.get("memoCount").is_none());
        assert!(unknown.get("missing").is_none());
        let empty = serde_json::to_value(NotebookListItem {
            notebook: config,
            pinned: false,
            memo_count: Some(0),
            missing: Some(false),
        })
        .unwrap();
        assert_eq!(empty["memoCount"], 0);
    }

    #[test]
    fn notebook_import_status_serializes_as_frontend_contract() {
        let value = serde_json::to_value(NotebookImportStatus {
            notebook_id: "nb_test".to_string(),
            status: NotebookImportStatusKind::Completed,
            message: None,
        })
        .expect("status payload serializes");

        assert_eq!(
            value,
            serde_json::json!({
                "notebookId": "nb_test",
                "status": "completed",
                "message": null,
            })
        );
    }

    #[test]
    fn notebook_import_failed_status_includes_message() {
        let value = serde_json::to_value(NotebookImportStatus {
            notebook_id: "nb_test".to_string(),
            status: NotebookImportStatusKind::Failed,
            message: Some("disk import failed".to_string()),
        })
        .expect("status payload serializes");

        assert_eq!(value["status"], "failed");
        assert_eq!(value["message"], "disk import failed");
    }

    #[test]
    fn notebook_path_missing_reflects_directory_presence() {
        let root = temp_root();
        let missing_path = root.join("missing");
        let file_path = root.join("notebook.md");
        fs::write(&file_path, "# not a notebook directory").expect("write file");

        assert!(!notebook_path_missing(root.to_str().expect("utf8 root")));
        assert!(notebook_path_missing(
            missing_path.to_str().expect("utf8 missing path")
        ));
        assert!(notebook_path_missing(
            file_path.to_str().expect("utf8 file path")
        ));
        assert!(notebook_path_missing("  "));
    }

    #[test]
    fn create_notebook_registry_normalizes_path_and_icon_then_persists() {
        let root = temp_root();
        let notebook_dir = root.join("My Notebook");
        fs::create_dir_all(&notebook_dir).expect("create notebook dir");
        let memo_file = memo_file_for_test(&root);

        let config = create_notebook_registry(
            "Research",
            notebook_dir.to_str().expect("utf8 path"),
            Some("  ".to_string()),
            &memo_file,
        )
        .expect("create registry");

        assert_eq!(config.name, "Research");
        assert_eq!(config.icon, None);
        assert!(config.path.ends_with('/'));
        assert_eq!(config.is_default, false);

        let configs = memo_file.read_notebook_configs().expect("read configs");
        assert_eq!(configs.len(), 1);
        assert_eq!(configs[0].id, config.id);
        assert_eq!(configs[0].path, config.path);
    }

    #[test]
    fn missing_runtime_dependencies_allow_notebook_creation() {
        let temp = tempfile::tempdir().unwrap();
        let config_dir = temp.path().join("config");
        let memo = MemoFile::new(config_dir.clone());
        memo.initialize_registry_storage().unwrap();
        memo.mark_local_migration_completed("config_local_migrations_v1")
            .unwrap();
        fs::create_dir_all(config_dir.join("boot")).unwrap();
        fs::write(
            config_dir.join("boot/boot.json"),
            "{\"versionInitialization\":{\"completed\":true}}",
        )
        .unwrap();
        fs::remove_dir_all(config_dir.join("db")).unwrap();
        // Keep the same in-memory MemoFile, as with an already open Dev window.
        assert!(memo.read_notebook_configs().unwrap().is_empty());
        assert!(memo.read_selected_notebook_id().unwrap().is_none());
        assert!(memo.read_notebook_workspace().unwrap().notebooks.is_empty());
        let path = temp.path().join("new-notebook");
        fs::create_dir_all(&path).unwrap();
        let created = create_notebook_registry("New", path.to_str().unwrap(), None, &memo).unwrap();
        assert_eq!(memo.read_notebook_configs().unwrap()[0].id, created.id);
        assert!(config_dir.join("boot/boot.json").exists());
    }

    #[test]
    fn new_notebook_ids_use_uuid_v7() {
        let id = generate_notebook_id();
        let uuid = uuid::Uuid::parse_str(id.strip_prefix("nb_").expect("notebook prefix"))
            .expect("valid UUID");

        assert_eq!(uuid.get_version_num(), 7);
        assert!(is_valid_notebook_id(&id));
    }

    #[test]
    fn cloud_notebook_registry_preserves_remote_id() {
        let root = temp_root();
        let notebook_dir = root.join("Cloud Notebook");
        fs::create_dir_all(&notebook_dir).expect("create notebook dir");
        let memo_file = memo_file_for_test(&root);

        let config = create_notebook_registry_with_id(
            "Cloud",
            notebook_dir.to_str().expect("utf8 path"),
            None,
            Some("nb_legacy_123"),
            &memo_file,
        )
        .expect("create cloud notebook registry");

        assert_eq!(config.id, "nb_legacy_123");
    }

    #[test]
    fn cloud_restore_requires_an_empty_directory() {
        let root = temp_root();
        let notebook_dir = root.join("Restore");
        fs::create_dir_all(&notebook_dir).expect("create notebook dir");
        assert!(cloud_restore_directory_is_empty(&notebook_dir).unwrap());

        fs::write(notebook_dir.join(".DS_Store"), []).expect("write Finder metadata");
        assert!(cloud_restore_directory_is_empty(&notebook_dir).unwrap());

        fs::write(notebook_dir.join("Existing.md"), "# Existing").expect("write note");
        assert!(!cloud_restore_directory_is_empty(&notebook_dir).unwrap());
    }

    #[test]
    fn create_notebook_registry_rejects_duplicate_path_without_changing_registry() {
        let root = temp_root();
        let notebook_dir = root.join("Duplicate");
        fs::create_dir_all(&notebook_dir).expect("create notebook dir");
        let memo_file = memo_file_for_test(&root);
        let path_without_slash = notebook_dir.to_str().expect("utf8 path");
        let path_with_slash = format!("{}/", path_without_slash);

        let first = create_notebook_registry(
            "First",
            path_without_slash,
            Some("book".to_string()),
            &memo_file,
        )
        .expect("first registry");
        let second = create_notebook_registry("Second", &path_with_slash, None, &memo_file);

        assert!(matches!(
            second,
            Err(error) if error == "PATH_ALREADY_REGISTERED"
        ));
        let configs = memo_file.read_notebook_configs().expect("read configs");
        assert_eq!(configs.len(), 1);
        assert_eq!(configs[0].id, first.id);
        assert_eq!(configs[0].name, "First");
    }
}
