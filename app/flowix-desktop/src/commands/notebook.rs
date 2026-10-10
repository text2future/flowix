//! Notebook IPC —增删改查 + 切换当前 notebook�?//!
//! `set_current_notebook` �?`switch_notebook_and_rebuild` helper, 触发
//! watcher rebind + 磁盘对账 + 后台索引 rebuild�?//!
//! �?/ �?/ �?/ 清空 四个写操作都会同步更�?`agent_access` store
//! (`~/.flowix/agent-access.json`), 任何 entry 真改了之�?emit
//! `agent-access-changed` 事件, 其它窗口 React 树收到后从�?盘重�?load�?
use crate::events as dispatcher;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

use crate::lock_utils::{read_lock, write_lock};
use flowix_core::memo_file::{
    MemoFile, Notebook, NotebookConfig, NotebookSetupJob, NotebookSetupJobStatus,
};
use flowix_core::MemoService;
use flowix_sync::V2LocalNotebook;

use super::agent_access::AGENT_ACCESS_CHANGED_EVENT;
use super::helpers::{
    refresh_watcher_roots, switch_notebook_trusting_index, watch_created_notebook,
};
use crate::app::state::{AppState, NotebookImportStatus, NotebookImportStatusKind};

const NOTEBOOK_IMPORT_COMPLETE_EVENT: &str = "notebook-import-complete";
const NOTEBOOK_SETUP_STATUS_EVENT: &str = "notebook-setup-status";
/// 笔�?�?��表发生变�?(reorder / create / update / delete) �?emit, 其它窗口
/// store 监听�?reload。前�?TS 类型 `notebooks-changed` 事件 payload �?unit�?
pub(crate) const NOTEBOOKS_CHANGED_EVENT: &str = "notebooks-changed";
const NOTEBOOK_IMPORT_STATUS_EVENT: &str = "notebook-import-status";

fn emit_notebook_import_status(
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
    notebook: Notebook,
    memo_count: usize,
}

fn create_notebook_registry(
    name: &str,
    path: &str,
    icon: Option<String>,
    memo_file: &MemoFile,
) -> Result<NotebookConfig, String> {
    create_notebook_registry_with_id_and_template(name, path, icon, None, None, false, memo_file)
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

pub(crate) fn notebook_folder_has_content(path: &Path) -> Result<bool, String> {
    let entries = std::fs::read_dir(path)
        .map_err(|error| format!("NOTEBOOK_CONTENT_CHECK_FAILED: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("NOTEBOOK_CONTENT_CHECK_FAILED: {error}"))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if matches!(name.as_ref(), ".flowix" | ".DS_Store" | "Thumbs.db") {
            continue;
        }
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
pub fn get_default_notebook_path(name: String) -> Result<String, String> {
    default_notebook_path_without_create(name.trim())?
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "PATH_INVALID_UTF8".to_string())
}

#[tauri::command]
pub async fn confirm_notebook_preset_overwrite(app: AppHandle, message: String) -> Result<bool, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title("Flowix")
            .buttons(MessageDialogButtons::OkCancel)
            .blocking_show()
    })
    .await
    .map_err(|error| format!("CONFIRM_DIALOG_FAILED: {error}"))
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
    create_notebook_registry_with_id_and_template(
        name,
        path,
        icon,
        requested_id,
        None,
        false,
        memo_file,
    )
}

fn create_notebook_registry_with_id_and_template(
    name: &str,
    path: &str,
    icon: Option<String>,
    requested_id: Option<&str>,
    template_id: Option<&str>,
    overwrite_existing: bool,
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
    let mut configs = memo_file.read_notebook_configs().unwrap_or_default();
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
            let setup_job = template_id.map(|template_id| NotebookSetupJob {
                notebook_id: relocated.id.clone(),
                template_id: Some(template_id.to_string()),
                overwrite_existing,
                status: NotebookSetupJobStatus::Pending,
                stage: "template".to_string(),
                completed_files: 0,
                total_files: 0,
                message: None,
                report: None,
                updated_at: now,
            });
            memo_file
                .write_notebook_configs_with_setup_job(&configs, setup_job.as_ref())
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
    let setup_job = template_id.map(|template_id| NotebookSetupJob {
        notebook_id: config.id.clone(),
        template_id: Some(template_id.to_string()),
        overwrite_existing,
        status: NotebookSetupJobStatus::Pending,
        stage: "template".to_string(),
        completed_files: 0,
        total_files: 0,
        message: None,
        report: None,
        updated_at: now,
    });
    memo_file
        .write_notebook_configs_with_setup_job(&configs, setup_job.as_ref())
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

fn sync_notebook_agent_access(config: &NotebookConfig, state: &AppState, app: &AppHandle) {
    // 同�?往 agent_access 列表里加一�?(默�? enabled), 写盘后才�?    // 同�?完成 ── store 内部走原子写, 失败会回滚内存�?
    if state.agent_access.add_or_update_notebook(config) {
        dispatcher::emit_to(app, AGENT_ACCESS_CHANGED_EVENT, ());
    }
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
    if let Err(error) = switch_notebook_trusting_index(state, app, notebook_id.clone()) {
        if let Err(restore_error) = switch_notebook_trusting_index(state, app, previous_id) {
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
        if let Err(restore_error) = switch_notebook_trusting_index(state, app, previous_id) {
            tracing::error!(
                "[set_current_notebook] failed to restore previous notebook after persistence error: {restore_error}"
            );
        }
        return Err(error);
    }

    if let Some(notebook_id) = notebook_id.as_deref() {
        crate::commands::helpers::retry_notebook_watch(state, app, notebook_id);
    }
    Ok(())
}

fn activate_created_notebook(
    config: &NotebookConfig,
    state: &AppState,
    app: &AppHandle,
) -> Result<(), String> {
    set_current_notebook_inner(Some(config.id.clone()), state, app)?;
    // A newly registered root must be watched immediately; otherwise changes
    // made before the next app restart are invisible to the memo index.
    watch_created_notebook(state, app, config);
    tracing::info!("[create_notebook] selected notebook id={}", config.id);
    Ok(())
}

fn run_notebook_import(app: AppHandle, notebook_id: String, seed_onboarding_docs: bool) -> bool {
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
            memo_file
                .ensure_notebook_migrations(&notebook_id)
                .map_err(|error| format!("notebook import migration failed: {error}"))?;
            tracing::info!(
                "[create_notebook] import/reconcile start id={}",
                notebook_id
            );

            // Reconcile by explicit notebook ID. This keeps the background job
            // independent from whichever notebook the user currently views and
            // avoids switching the global MemoFile context from a worker thread.
            let report = memo_file.reconcile_note_index(&notebook_id)
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
            dispatcher::emit_to(&app, "flowix:path-note-changed", serde_json::json!({
                "notebookId": notebook_id,
                "relativePath": "",
                "deleted": false,
            }));
        }
        Ok::<(), String>(())
    })();

    crate::runtime_log::record_event(
        "info",
        "notebook.import.timing",
        format!("notebook={} total_ms={} success={}", notebook_id,
            started.elapsed().as_millis(), import_result.is_ok()),
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

fn persist_notebook_setup_job(
    state: &AppState,
    app: &AppHandle,
    job: NotebookSetupJob,
) -> Result<NotebookSetupJob, String> {
    read_lock(&state.memo_file, "memo_file")
        .write_notebook_setup_job(&job)
        .map_err(|error| format!("persist notebook setup status failed: {error}"))?;
    dispatcher::emit_to(app, NOTEBOOK_SETUP_STATUS_EVENT, job.clone());
    Ok(job)
}

fn finish_notebook_template_setup(app: AppHandle, mut job: NotebookSetupJob) {
    let state = app.state::<AppState>();
    let mut report = job.report.clone().unwrap_or_default();
    let result = (|| {
        if job.stage != "indexing" {
            let notebook_id = job.notebook_id.clone();
            let template_id = job
                .template_id
                .clone()
                .ok_or_else(|| "NOTEBOOK_TEMPLATE_NOT_SELECTED".to_string())?;
            let mut next_stage_job = job.clone();
            super::memo::creates::initialize_notebook_template_for_notebook(
                &notebook_id,
                &template_id,
                true,
                job.overwrite_existing,
                state.inner(),
                &app,
                |report| {
                    next_stage_job.stage = "indexing".to_string();
                    next_stage_job.completed_files = report.total_files;
                    next_stage_job.total_files = report.total_files;
                    next_stage_job.message = None;
                    next_stage_job.report = Some(report.clone());
                    next_stage_job.updated_at = chrono::Utc::now().timestamp_millis();
                    persist_notebook_setup_job(state.inner(), &app, next_stage_job.clone())
                        .map(|_| ())
                },
            )?;
            report = next_stage_job.report.clone().unwrap_or_default();
            job = next_stage_job;
        }

        emit_notebook_import_status(
            state.inner(),
            &app,
            &job.notebook_id,
            NotebookImportStatusKind::Started,
            None,
        );
        if !run_notebook_import(app.clone(), job.notebook_id.clone(), false) {
            let message = state
                .notebook_imports
                .lock()
                .ok()
                .and_then(|imports| imports.get(&job.notebook_id).and_then(|status| status.message.clone()))
                .unwrap_or_else(|| "NOTEBOOK_IMPORT_FAILED".to_string());
            return Err(message);
        }
        Ok(())
    })();

    job.updated_at = chrono::Utc::now().timestamp_millis();
    match result {
        Ok(()) => {
            job.report = Some(report.clone());
            if report.failed_files > 0 {
                job.status = NotebookSetupJobStatus::Partial;
                job.stage = "template".to_string();
            } else {
                job.status = NotebookSetupJobStatus::Completed;
                job.stage = "completed".to_string();
            }
            job.message = None;
        }
        Err(message) => {
            job.status = NotebookSetupJobStatus::Failed;
            if report.failed_files > 0 || job.stage != "indexing" {
                job.stage = "template".to_string();
            }
            job.report = Some(report);
            job.message = Some(message);
        }
    }
    if let Err(error) = persist_notebook_setup_job(state.inner(), &app, job.clone()) {
        tracing::error!("failed to persist notebook setup terminal state: {error}");
    }
    if let Ok(mut running) = state.notebook_template_initializations.lock() {
        running.remove(&job.notebook_id);
    };
}

#[tauri::command]
pub fn get_notebook_template_setup_status(
    notebook_id: String,
    state: State<AppState>,
) -> Result<Option<NotebookSetupJob>, String> {
    read_lock(&state.memo_file, "memo_file")
        .get_notebook_setup_job(&notebook_id)
        .map_err(|error| format!("read notebook setup status failed: {error}"))
}

/// Start or resume template preparation for an opened notebook. Failed and
/// partial jobs only restart when the user explicitly requests a retry.
#[tauri::command]
pub fn start_notebook_template_setup(
    notebook_id: String,
    retry: Option<bool>,
    app: AppHandle,
) -> Result<Option<NotebookSetupJob>, String> {
    let state = app.state::<AppState>();
    let mut running = state
        .notebook_template_initializations
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let Some(mut job) = memo_file
        .get_notebook_setup_job(&notebook_id)
        .map_err(|error| format!("read notebook setup status failed: {error}"))?
    else {
        return Ok(None);
    };
    drop(memo_file);

    if job.status == NotebookSetupJobStatus::Completed {
        return Ok(Some(job));
    }
    if matches!(job.status, NotebookSetupJobStatus::Partial | NotebookSetupJobStatus::Failed)
        && retry != Some(true)
    {
        return Ok(Some(job));
    }
    if job.status == NotebookSetupJobStatus::Partial && retry == Some(true) {
        job.status = NotebookSetupJobStatus::Pending;
        job.stage = "template".to_string();
        job.message = None;
        job.report = None;
    } else if job.status == NotebookSetupJobStatus::Failed && retry == Some(true) {
        job.status = NotebookSetupJobStatus::Pending;
        job.message = None;
        if job.stage != "indexing" {
            job.stage = "template".to_string();
            job.report = None;
        }
    }

    if !running.insert(notebook_id.clone()) {
        return Ok(Some(job));
    }

    job.status = NotebookSetupJobStatus::Running;
    job.message = None;
    job.updated_at = chrono::Utc::now().timestamp_millis();
    let job = match persist_notebook_setup_job(state.inner(), &app, job) {
        Ok(job) => job,
        Err(error) => {
            running.remove(&notebook_id);
            return Err(error);
        }
    };
    drop(running);

    std::thread::spawn({
        let app = app.clone();
        let job = job.clone();
        move || finish_notebook_template_setup(app, job)
    });
    Ok(Some(job))
}

#[tauri::command]
pub async fn get_notebooks(app: AppHandle) -> Result<Vec<NotebookListItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let configs = memo_file.read_notebook_configs().unwrap_or_default();
        let counts = MemoService::new(&memo_file)
            .notebook_note_counts(&configs)
            .unwrap_or_default();

        configs
            .into_iter()
            .map(|config| {
                let memo_count = counts.get(&config.id).copied().unwrap_or(0);
                NotebookListItem {
                    notebook: notebook_from_config(config),
                    memo_count,
                }
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|error| format!("notebook list task failed: {error}"))
}

#[tauri::command]
pub async fn create_notebook(
    name: String,
    path: Option<String>,
    icon: Option<String>,
    activate: Option<bool>,
    template_id: Option<String>,
    overwrite_existing: Option<bool>,
    app: AppHandle,
) -> Result<Notebook, String> {
    let started = std::time::Instant::now();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let trimmed_name = name.trim();
        if trimmed_name.is_empty() {
            return Err("INVALID_NAME".to_string());
        }
        if let Some(template_id) = template_id.as_deref() {
            super::memo::creates::validate_notebook_template_id(template_id)?;
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
        let has_bookmark_access = state
            .security_bookmarks
            .start_accessing_for_path(Path::new(trimmed_path));
        if !Path::new(trimmed_path).is_dir() {
            return Err("PATH_MISSING".to_string());
        }
        let notebook_path = Path::new(trimmed_path);
        let comparable_path = comparable_notebook_path(&normalize_notebook_path(trimmed_path));
        if read_lock(&state.memo_file, "memo_file")
            .read_notebook_configs()
            .unwrap_or_default()
            .iter()
            .any(|notebook| {
                comparable_notebook_path(&notebook.path) == comparable_path
            })
        {
            return Err("PATH_ALREADY_REGISTERED".to_string());
        }
        let overwrite_existing = overwrite_existing.unwrap_or(false);
        if template_id.is_some()
            && !overwrite_existing
            && notebook_folder_has_content(notebook_path)?
        {
            return Err("NOTEBOOK_PRESET_OVERWRITE_CONFIRM_REQUIRED".to_string());
        }
        if !has_bookmark_access {
            state
                .security_bookmarks
                .record_directory(Path::new(trimmed_path))
                .map_err(|e| format!("BOOKMARK_WRITE_FAILED: {e}"))?;
        }

        let config = {
            let memo_file = write_lock(&state.memo_file, "memo_file");
            create_notebook_registry_with_id_and_template(
                trimmed_name,
                trimmed_path,
                icon,
                None,
                template_id.as_deref(),
                overwrite_existing,
                &memo_file,
            )?
        };
        sync_notebook_agent_access(&config, state.inner(), &app);
        if activate.unwrap_or(true) {
            activate_created_notebook(&config, state.inner(), &app)?;
        } else {
            // The onboarding flow activates the notebook only after all steps are
            // complete. Keep the new root watched without changing global state.
            watch_created_notebook(state.inner(), &app, &config);
        }
        dispatcher::emit_to(&app, NOTEBOOKS_CHANGED_EVENT, ());

        Ok(notebook_from_config(config))
    })
    .await
    .map_err(|error| format!("notebook creation task failed: {error}"))?;
    crate::runtime_log::record_event(
        "info",
        "notebook.create.timing",
        format!("total_ms={} success={}", started.elapsed().as_millis(), result.is_ok()),
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
    let has_bookmark_access = state.security_bookmarks.start_accessing_for_path(directory);
    if !directory.is_dir() {
        return Err("PATH_MISSING".to_string());
    }
    if !cloud_restore_directory_is_empty(directory)? {
        return Err("PATH_NOT_EMPTY".to_string());
    }
    if !has_bookmark_access {
        state
            .security_bookmarks
            .record_directory(directory)
            .map_err(|e| format!("BOOKMARK_WRITE_FAILED: {e}"))?;
    }

    let config = {
        let memo_file = write_lock(&state.memo_file, "memo_file");
        create_notebook_registry_with_id(trimmed_name, trimmed_path, icon, Some(&id), &memo_file)?
    };
    sync_notebook_agent_access(&config, state.inner(), &app);
    activate_created_notebook(&config, state.inner(), &app)?;
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

    // 名字 / �?��变更都同步到 agent_access ── store �?��判定�?��真改�?
    if state.agent_access.add_or_update_notebook(&updated) {
        dispatcher::emit_to(&app, AGENT_ACCESS_CHANGED_EVENT, ());
    }
    refresh_watcher_roots(state.inner(), &app);
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
pub fn delete_notebook(id: String, state: State<AppState>, app: AppHandle) -> Result<bool, String> {
    let setup_guard = state
        .notebook_template_initializations
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if setup_guard.contains(&id) {
        return Err("NOTEBOOK_SETUP_IN_PROGRESS".to_string());
    }

    let (was_current, next_notebook_id) = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let _change_guard = memo_file.operation_locks()
            .notebook_change(&[&id], "remove_notebook_from_registry")
            .map_err(|error| format!("NOTEBOOK_BUSY: {error}"))?;
        let mut configs = memo_file.read_notebook_configs().unwrap_or_default();

        let index = match configs.iter().position(|c| c.id == id) {
            Some(idx) => idx,
            None => return Err("NOTEBOOK_NOT_FOUND".to_string()),
        };
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
    drop(setup_guard);

    // Keep the native operation context and the persisted selection valid even
    // when the deletion is initiated outside the main Webview. The frontend
    // performs the same transition for its workspace state, but the backend
    // must not retain an id that has just been removed.
    if was_current {
        if let Err(error) =
            set_current_notebook_inner(next_notebook_id.clone(), state.inner(), &app)
        {
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
        }
    }

    if let Err(error) = state.cloud_sync.record_v2_notebook_delete(&id) {
        tracing::warn!("failed to persist cloud notebook deletion {id}: {error}");
    } else {
        crate::commands::cloud::schedule_notebook_sync(app.clone(), id.clone());
    }

    // 同�?把�?应的 agent_access entry 也删�? 状态栏�?文件权限"子菜�?    // 会少一�?── 用户没主动去勾�? 不应该留�??儿在那里�?
    if state.agent_access.remove_notebook(&id) {
        dispatcher::emit_to(&app, AGENT_ACCESS_CHANGED_EVENT, ());
    }
    refresh_watcher_roots(state.inner(), &app);
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
    let setup_guard = state
        .notebook_template_initializations
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !setup_guard.is_empty() {
        return Err("NOTEBOOK_SETUP_IN_PROGRESS".to_string());
    }

    let memo_file = read_lock(&state.memo_file, "memo_file");
    let configs = memo_file.read_notebook_configs().unwrap_or_default();
    let ids: Vec<&str> = configs.iter().map(|config| config.id.as_str()).collect();
    let _change_guard = if ids.is_empty() {
        None
    } else {
        Some(memo_file.operation_locks().notebook_change(&ids, "clear_notebooks")
            .map_err(|error| format!("NOTEBOOK_BUSY: {error}"))?)
    };
    let current_ids: std::collections::HashSet<String> = memo_file
        .read_notebook_configs().map_err(|error| error.to_string())?
        .into_iter().map(|config| config.id).collect();
    if current_ids != ids.iter().map(|id| (*id).to_owned()).collect() {
        return Err("NOTEBOOK_REGISTRY_CHANGED".to_string());
    }
    let before_ids: std::collections::HashSet<String> =
        configs.iter().map(|c| c.id.clone()).collect();

    let ok = memo_file.write_notebook_configs(&[]).is_ok();
    drop(_change_guard);
    drop(memo_file);
    drop(setup_guard);

    // 把�?清掉的非默�? notebook �?access 列表里也清掉, 然后 emit 一欰�?
    let mut any_removed = false;
    for id in before_ids {
        if let Err(error) = state.cloud_sync.record_v2_notebook_delete(&id) {
            tracing::warn!("failed to persist cleared cloud notebook {id}: {error}");
        } else {
            crate::commands::cloud::schedule_notebook_sync(app.clone(), id.clone());
        }
        if state.agent_access.remove_notebook(&id) {
            any_removed = true;
        }
    }
    if any_removed {
        dispatcher::emit_to(&app, AGENT_ACCESS_CHANGED_EVENT, ());
    }
    refresh_watcher_roots(state.inner(), &app);
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
    fn preset_content_check_ignores_metadata_but_detects_existing_folders() {
        let root = temp_root();
        fs::create_dir_all(root.join(".flowix")).expect("create notebook metadata directory");
        fs::write(root.join(".flowix/notebook.json"), "{}").expect("write notebook metadata");
        fs::create_dir_all(root.join("empty-folder")).expect("create empty folder");
        assert!(notebook_folder_has_content(&root).expect("inspect existing folder"));

        fs::create_dir_all(root.join("projects/nested")).expect("create nested folders");
        fs::write(root.join("projects/nested/Note.md"), "existing note")
            .expect("write existing note");
        assert!(notebook_folder_has_content(&root).expect("inspect populated notebook"));
        let _ = fs::remove_dir_all(root);
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
