use std::collections::{HashMap, HashSet};
mod coordinator;
mod deletion;
mod local_adapter;
pub(crate) use coordinator::{
    schedule_notebook_sync, schedule_notebook_sync_observation, start_cloud_sync_polling,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use chrono::Utc;
use flowix_core::memo_file::{
    notebook_path_from_relative, IsMd,
};
use flowix_sync::{
    v2_content_hash, v2_local_content_diverged, CloudCheckout,
    CloudMembership, CloudNotebook, CloudProduct, CloudState, SyncError, V2AccountSyncReport,
    V2LocalNote, V2LocalNotebook, V2RemoteApply, V2SyncedNotebook,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;
use once_cell::sync::Lazy;

static GOOGLE_OAUTH_VERIFIERS: Lazy<Mutex<HashMap<String, (Instant, String)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

use crate::app::state::AppState;
use crate::lock_utils::read_lock;
use crate::memo_events::{self, MemoChangeSource, MemoDerivedChanged, MemoEvent};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncResult {
    pub notebooks: usize,
    pub uploaded: usize,
    pub deleted: usize,
    pub downloaded: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncStatus {
    pub notebook_id: String,
    pub run_id: String,
    pub state: String,
    pub phase: String,
    pub uploaded: usize,
    pub deleted: usize,
    pub downloaded: usize,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub last_error: Option<String>,
}

impl CloudSyncStatus {
    fn new(notebook_id: &str, run_id: &str, state: &str, phase: &str, started_at: i64) -> Self {
        Self {
            notebook_id: notebook_id.to_string(),
            run_id: run_id.to_string(),
            state: state.to_string(),
            phase: phase.to_string(),
            uploaded: 0,
            deleted: 0,
            downloaded: 0,
            started_at,
            finished_at: None,
            last_error: None,
        }
    }
}

fn sync_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn cloud_error(error: SyncError) -> String {
    match error {
        SyncError::Api { code, details, .. }
            if code == "MEMBERSHIP_REQUIRED" || code == "STORAGE_QUOTA_EXCEEDED" =>
        {
            format!("{code}:{}", details.unwrap_or(serde_json::Value::Null))
        }
        other => other.to_string(),
    }
}

fn emit_sync_status(app: &AppHandle, status: &CloudSyncStatus) {
    let _ = app.emit("cloud-sync-status-changed", status);
}

fn emit_cloud_state(app: &AppHandle, state: &CloudState) {
    let _ = app.emit("cloud-state-changed", state);
}

fn persist_rotated_token(state: &AppState) -> Result<(), String> {
    state.cloud_sync.with_current_refresh_token(|token| {
        if let Some(token) = token {
            state
                .user_config
                .save_cloud_refresh_token(token)
                .map_err(sync_error)?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn cloud_get_state(state: State<AppState>) -> Result<CloudState, String> {
    state.cloud_sync.state().map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_register(
    email: String,
    password: String,
    display_name: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<CloudState, String> {
    state
        .cloud_sync
        .register(email.trim(), &password, display_name.trim())
        .await
        .map_err(sync_error)?;
    persist_rotated_token(state.inner())?;
    let next_state = state.cloud_sync.state().map_err(sync_error)?;
    emit_cloud_state(&app, &next_state);
    Ok(next_state)
}

#[tauri::command]
pub async fn cloud_login(
    email: String,
    password: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<CloudState, String> {
    state
        .cloud_sync
        .login(email.trim(), &password)
        .await
        .map_err(sync_error)?;
    persist_rotated_token(state.inner())?;
    let next_state = state.cloud_sync.state().map_err(sync_error)?;
    emit_cloud_state(&app, &next_state);
    Ok(next_state)
}

#[tauri::command]
pub async fn cloud_sign_in_with_apple(
    window: WebviewWindow,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<CloudState, String> {
    let challenge = state
        .cloud_sync
        .apple_challenge()
        .await
        .map_err(sync_error)?;
    let authorization = crate::apple_sign_in::authorize(window, challenge).await?;
    state
        .cloud_sync
        .sign_in_with_apple(&authorization)
        .await
        .map_err(sync_error)?;
    persist_rotated_token(state.inner())?;
    let next_state = state.cloud_sync.state().map_err(sync_error)?;
    emit_cloud_state(&app, &next_state);
    Ok(next_state)
}

#[tauri::command]
pub async fn cloud_start_google_sign_in(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use sha2::{Digest, Sha256};

    let state = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let code_verifier = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let code_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
    {
        let mut verifiers = GOOGLE_OAUTH_VERIFIERS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        verifiers.retain(|_, (created_at, _)| created_at.elapsed() < Duration::from_secs(300));
        verifiers.insert(state.clone(), (Instant::now(), code_verifier));
    }
    let mut url = url::Url::parse(&format!(
        "{}/v1/auth/google/start",
        flowix_sync::DEFAULT_CLOUD_API_BASE
    ))
    .map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("mode", "desktop")
        .append_pair("state", &state)
        .append_pair("code_challenge", &code_challenge);
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| error.to_string())
}

pub(crate) async fn complete_google_deep_link(
    app: AppHandle,
    code: String,
    oauth_state: String,
) -> Result<(), String> {
    let code_verifier = GOOGLE_OAUTH_VERIFIERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&oauth_state)
        .map(|(_, verifier)| verifier)
        .ok_or_else(|| "Google sign-in expired; please try again".to_string())?;
    let state = app.state::<AppState>();
    state
        .cloud_sync
        .sign_in_with_google_desktop(&code, &oauth_state, &code_verifier)
        .await
        .map_err(sync_error)?;
    persist_rotated_token(state.inner())?;
    let next_state = state.cloud_sync.state().map_err(sync_error)?;
    emit_cloud_state(&app, &next_state);
    Ok(())
}

#[tauri::command]
pub async fn cloud_link_apple(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<CloudState, String> {
    let challenge = state
        .cloud_sync
        .apple_challenge()
        .await
        .map_err(sync_error)?;
    let authorization = crate::apple_sign_in::authorize(window, challenge).await?;
    let next_state = state
        .cloud_sync
        .link_apple(&authorization)
        .await
        .map_err(sync_error)?;
    persist_rotated_token(state.inner())?;
    Ok(next_state)
}

#[tauri::command]
pub async fn cloud_logout(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<CloudState, String> {
    let logout_result = state
        .cloud_sync
        .logout_with_cleanup(|| {
            state
                .user_config
                .delete_cloud_refresh_token()
                .map_err(|error| SyncError::InvalidState(error.to_string()))
        })
        .await
        .map_err(sync_error);
    let next_state = state.cloud_sync.state().map_err(sync_error)?;
    emit_cloud_state(&app, &next_state);
    logout_result?;
    Ok(next_state)
}

#[tauri::command]
pub fn cloud_get_notebook_state(
    notebook_id: String,
    state: State<AppState>,
) -> Result<Option<V2SyncedNotebook>, String> {
    state
        .cloud_sync
        .v2_notebook(&notebook_id)
        .map_err(sync_error)
}

#[tauri::command]
pub fn cloud_list_notebook_states(state: State<AppState>) -> Result<Vec<V2SyncedNotebook>, String> {
    state.cloud_sync.v2_enabled_notebooks().map_err(sync_error)
}

#[tauri::command]
pub fn cloud_list_pending_file_operation_counts(
    state: State<AppState>,
) -> Result<HashMap<String, i64>, String> {
    state
        .cloud_sync
        .v2_pending_file_operation_counts()
        .map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_list_notebooks(
    state: State<'_, AppState>,
) -> Result<Vec<CloudNotebook>, String> {
    let notebooks_result = state.cloud_sync.v2_remote_notebooks().await;
    persist_rotated_token(state.inner())?;
    notebooks_result.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_link_notebook(
    notebook_id: String,
    cloud_notebook_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<V2SyncedNotebook, String> {
    if notebook_id != cloud_notebook_id {
        return Err("CLOUD_NOTEBOOK_ID_MISMATCH".to_string());
    }
    let config = read_lock(&state.memo_file, "memo_file")
        .get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let link_result = state.cloud_sync.set_v2_notebook_enabled(
        &V2LocalNotebook {
            id: config.id,
            name: config.name,
            icon: config.icon,
            sort_order: config.sort,
        },
        true,
    );
    persist_rotated_token(state.inner())?;
    let link = link_result.map_err(cloud_error)?;
    if let Ok(next_state) = state.cloud_sync.state() {
        emit_cloud_state(&app, &next_state);
    }
    Ok(link)
}

#[tauri::command]
pub async fn cloud_set_notebook_enabled(
    notebook_id: String,
    enabled: bool,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<V2SyncedNotebook, String> {
    let config = read_lock(&state.memo_file, "memo_file")
        .get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let link_result = state.cloud_sync.set_v2_notebook_enabled(
        &V2LocalNotebook {
            id: config.id,
            name: config.name,
            icon: config.icon,
            sort_order: config.sort,
        },
        enabled,
    );
    persist_rotated_token(state.inner())?;
    let link = link_result.map_err(cloud_error)?;
    if let Ok(next_state) = state.cloud_sync.state() {
        emit_cloud_state(&app, &next_state);
    }
    Ok(link)
}

#[tauri::command]
pub async fn cloud_refresh_membership(
    state: State<'_, AppState>,
) -> Result<CloudMembership, String> {
    let membership_result = state.cloud_sync.refresh_membership().await;
    persist_rotated_token(state.inner())?;
    membership_result.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_list_products(state: State<'_, AppState>) -> Result<Vec<CloudProduct>, String> {
    state.cloud_sync.products().await.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_create_checkout(
    product_id: String,
    state: State<'_, AppState>,
) -> Result<CloudCheckout, String> {
    let idempotency_key = format!("desktop-{}", uuid::Uuid::new_v4());
    let checkout_result = state
        .cloud_sync
        .create_checkout(&product_id, &idempotency_key)
        .await;
    persist_rotated_token(state.inner())?;
    checkout_result.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_sync_now(
    notebook_id: Option<String>,
    app: AppHandle,
) -> Result<CloudSyncResult, String> {
    coordinator::sync_now(notebook_id, app).await
}

#[tauri::command]
pub async fn cloud_note_history(
    notebook_id: String,
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<flowix_sync::V2History, String> {
    let note_id = flowix_sync::v2_path_note_id(&notebook_id, &relative_path);
    let history = state.cloud_sync.v2_history(&note_id).await.map_err(sync_error)?;
    if history.notebook_id != notebook_id || history.note_id != note_id {
        return Err("CLOUD_HISTORY_ID_MISMATCH".into());
    }
    Ok(history)
}

#[tauri::command]
pub fn list_local_path_archives(
    state: State<'_, AppState>,
) -> Vec<flowix_core::memo_file::PathArchiveSummary> {
    read_lock(&state.memo_file, "memo_file").list_path_archives()
}

#[tauri::command]
pub fn restore_local_path_version(
    notebook_id: String,
    relative_path: String,
    version_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let _guard = memo_file.acquire_cross_process_write_lock().map_err(sync_error)?;
    let notebook = memo_file.get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let root = Path::new(&notebook.path);
    let attachment = relative_path.starts_with("attachments/");
    if !attachment && !Path::new(&relative_path).is_md() {
        return Err("CLOUD_HISTORY_INVALID_PATH".into());
    }
    let path = local_adapter::safe_cloud_file_path(root, &relative_path, attachment)?;
    let target = memo_file.read_path_version_bytes(&notebook_id, &relative_path, &version_id)
        .ok_or_else(|| "CLOUD_HISTORY_VERSION_NOT_FOUND".to_string())?;
    if !attachment && std::str::from_utf8(&target).is_err() {
        return Err("CLOUD_HISTORY_INVALID_MARKDOWN".into());
    }
    let current = match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(sync_error(error)),
    };
    if current.as_deref() == Some(target.as_slice()) { return Ok(()); }
    if let Some(bytes) = current.as_deref() {
        memo_file.create_path_version_bytes(
            &notebook_id, &relative_path, bytes,
            flowix_core::memo_file::MemoVersionSource::RestoreBackup,
        ).map_err(sync_error)?;
    }
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(sync_error)?; }
    let fallback = local_adapter::cloud_conflict_copy_path(&path, &format!("restore-{version_id}"));
    match local_adapter::safely_replace_cloud_file(
        &path, current.as_deref(), &target, &format!("restore-{version_id}"), &fallback,
    )? {
        local_adapter::ConflictFileOutcome::Applied { preserved: None } => {},
        outcome => {
            let preserved = match outcome {
                local_adapter::ConflictFileOutcome::Applied { preserved }
                | local_adapter::ConflictFileOutcome::Interrupted { preserved } => preserved,
            };
            if let Some(preserved) = preserved {
                local_adapter::register_preserved_conflict_copy(&memo_file, &notebook_id, root, &preserved, attachment)?;
            }
            return Err("CLOUD_HISTORY_LOCAL_CHANGED".into());
        }
    }
    crate::watcher::runtime::mark_self_write_content_for(&app, &path, &target);
    // The disk write has committed. Ensure sync observes it even if an index
    // or media refresh below fails after the watcher self-write marker.
    schedule_notebook_sync_observation(app.clone(), notebook_id.clone(), true);
    if attachment {
        memo_file.refresh_media_resource_path(&notebook_id, &relative_path).map_err(sync_error)?;
        let _ = app.emit("media-properties-changed", serde_json::json!({ "notebookId": notebook_id }));
    } else {
        let updated = memo_file.register_existing_file_for_notebook_id(&notebook_id, &path).map_err(sync_error)?;
        memo_events::emit(&app, MemoEvent::Updated {
            id: updated.id.clone(), path: path.to_string_lossy().into_owned(),
            notebook_id: notebook_id.clone(),
            derived_changed: MemoDerivedChanged { tags: true, todos: true, agents: true },
            memo: updated, source: MemoChangeSource::CloudSync,
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn cloud_preview_note_revision(
    notebook_id: String,
    relative_path: String,
    revision: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let lower_path = relative_path.to_ascii_lowercase();
    if !lower_path.ends_with(".md") && !lower_path.ends_with(".markdown") {
        return Err("CLOUD_PREVIEW_MARKDOWN_ONLY".into());
    }
    let note_id = flowix_sync::v2_path_note_id(&notebook_id, &relative_path);
    let (history, bytes) = state.cloud_sync.v2_historical_bytes(&note_id, &revision).await.map_err(sync_error)?;
    if history.notebook_id != notebook_id || history.note_id != note_id {
        return Err("CLOUD_HISTORY_ID_MISMATCH".into());
    }
    if bytes.len() > 2 * 1024 * 1024 { return Err("CLOUD_PREVIEW_TOO_LARGE".into()); }
    String::from_utf8(bytes).map_err(|_| "CLOUD_PREVIEW_NOT_UTF8".into())
}

#[tauri::command]
pub fn cloud_list_conflicts(
    notebook_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let notebook = memo_file.get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let mut paths: Vec<String> = memo_file.read_all_memos_for_notebook_id(Some(&notebook_id))
        .into_iter()
        .filter(|memo| memo.relative_path.contains("(Flowix conflict "))
        .map(|memo| memo.relative_path)
        .collect();
    let mut attachments = Vec::new();
    let root = Path::new(&notebook.path);
    local_adapter::scan_cloud_attachments(root, &root.join("attachments"), &mut attachments)?;
    for path in attachments {
        let relative = flowix_core::memo_file::notebook_relative_path(root, &path)?;
        if relative.contains("(Flowix conflict ") { paths.push(relative); }
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

#[tauri::command]
pub fn cloud_resolve_markdown_conflict(
    notebook_id: String,
    relative_path: String,
    conflict_path: String,
    use_local: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let _guard = memo_file.acquire_cross_process_write_lock().map_err(sync_error)?;
    let notebook = memo_file.get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let root = Path::new(&notebook.path);
    let original = local_adapter::safe_cloud_note_path(root, &relative_path)?;
    let copy = local_adapter::safe_cloud_note_path(root, &conflict_path)?;
    if !conflict_path.contains("(Flowix conflict ") || original.parent() != copy.parent()
        || original == copy {
        return Err("CLOUD_INVALID_CONFLICT_COPY".into());
    }
    let copy_memo = memo_file.find_memo_by_relative_path_for_notebook_id(&notebook_id, &conflict_path)
        .ok_or_else(|| "CLOUD_CONFLICT_COPY_MISSING".to_string())?;
    let copy_bytes = std::fs::read(&copy).map_err(sync_error)?;
    local_adapter::record_rejected_cloud_version(
        &memo_file, &notebook_id, root, &original, &copy_bytes,
    )?;
    if use_local {
        let note_id = flowix_sync::v2_path_note_id(&notebook_id, &relative_path);
        let current = match std::fs::read(&original) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(sync_error(error)),
        };
        let chosen = copy_bytes.clone();
        let baseline = state.cloud_sync.v2_note_state(&note_id).map_err(sync_error)?
            .ok_or_else(|| "CLOUD_CONFLICT_ORIGINAL_NOT_SYNCED".to_string())?;
        let current_hash = current.as_ref().map(|bytes| v2_content_hash(bytes));
        if baseline.deleted != current.is_none()
            || baseline.content_hash.as_deref() != current_hash.as_deref()
            || state.cloud_sync.has_pending_v2_note_change(&note_id).map_err(sync_error)? {
            return Err("CLOUD_CONFLICT_ORIGINAL_CHANGED".into());
        }
        if let Some(current) = current.as_ref() {
            let stem = original.file_stem().and_then(|value| value.to_str()).unwrap_or("Note");
            let backup = original.with_file_name(format!("{stem} (Flowix before conflict resolve {}).md", baseline.revision));
            if !backup.exists() {
                flowix_core::memo_file::atomic_create_bytes(&backup, &current).map_err(sync_error)?;
                memo_file.register_existing_file_for_notebook_id(&notebook_id, &backup).map_err(sync_error)?;
                let backup_relative = flowix_core::memo_file::notebook_relative_path(root, &backup)?;
                state.cloud_sync.record_v2_local_change(&notebook_id,
                    &flowix_sync::v2_path_note_id(&notebook_id, &backup_relative),
                    flowix_sync::LocalChangeKind::Put, &v2_content_hash(&current)).map_err(sync_error)?;
            } else if std::fs::read(&backup).map_err(sync_error)? != *current {
                return Err("CLOUD_CONFLICT_BACKUP_COLLISION".into());
            }
        }
        if let Some(parent) = original.parent() { std::fs::create_dir_all(parent).map_err(sync_error)?; }
        crate::watcher::runtime::mark_self_write_for(&app, &original);
        let preserved_path = local_adapter::cloud_conflict_copy_path(&original, &format!("resolve-{note_id}"));
        match local_adapter::safely_replace_cloud_file(&original, current.as_deref(), &chosen,
            &format!("resolve-{note_id}"), &preserved_path)? {
            local_adapter::ConflictFileOutcome::Applied { preserved: None } => {},
            outcome => {
                let preserved = match outcome {
                    local_adapter::ConflictFileOutcome::Applied { preserved }
                    | local_adapter::ConflictFileOutcome::Interrupted { preserved } => preserved,
                };
                if let Some(preserved) = preserved {
                    local_adapter::register_preserved_conflict_copy(&memo_file, &notebook_id,
                        root, &preserved, false)?;
                }
                return Err("CLOUD_CONFLICT_ORIGINAL_CHANGED".into());
            }
        }
        let updated = memo_file.register_existing_file_for_notebook_id(&notebook_id, &original).map_err(sync_error)?;
        memo_events::emit(&app, MemoEvent::Updated {
            id: updated.id.clone(), path: original.to_string_lossy().into_owned(),
            notebook_id: notebook_id.clone(),
            derived_changed: MemoDerivedChanged { tags: true, todos: true, agents: true },
            memo: updated, source: MemoChangeSource::CloudSync,
        });
        state.cloud_sync.record_v2_local_change(&notebook_id, &note_id,
            flowix_sync::LocalChangeKind::Put, &v2_content_hash(&chosen)).map_err(sync_error)?;
    }
    crate::watcher::runtime::mark_self_write_for(&app, &copy);
    let preserved_path = local_adapter::cloud_conflict_copy_path(&copy, &format!("remove-{}", copy_memo.id));
    match local_adapter::safely_remove_conflict_file(&copy, &copy_bytes,
        &format!("remove-{}", copy_memo.id), &preserved_path)? {
        local_adapter::ConflictFileOutcome::Applied { preserved: None } => {},
        outcome => {
            let preserved = match outcome {
                local_adapter::ConflictFileOutcome::Applied { preserved }
                | local_adapter::ConflictFileOutcome::Interrupted { preserved } => preserved,
            };
            if let Some(preserved) = preserved {
                local_adapter::register_preserved_conflict_copy(&memo_file, &notebook_id,
                    root, &preserved, false)?;
            }
            return Err("CLOUD_CONFLICT_COPY_CHANGED".into());
        }
    }
    if !memo_file.prune_deleted_memo_for_notebook_id(&notebook_id, &conflict_path, &copy_memo.id)
        .map_err(sync_error)? {
        return Err("CLOUD_CONFLICT_COPY_CHANGED".into());
    }
    state.cloud_sync.record_v2_local_change(&notebook_id,
        &flowix_sync::v2_path_note_id(&notebook_id, &conflict_path),
        flowix_sync::LocalChangeKind::Delete, "deleted").map_err(sync_error)?;
    drop(_guard);
    drop(memo_file);
    schedule_notebook_sync_observation(app, notebook_id, true);
    Ok(())
}

#[tauri::command]
pub fn cloud_resolve_attachment_conflict(
    notebook_id: String,
    relative_path: String,
    conflict_path: String,
    use_local: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let _guard = memo_file.acquire_cross_process_write_lock().map_err(sync_error)?;
    let notebook = memo_file.get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let root = Path::new(&notebook.path);
    let original = local_adapter::safe_cloud_file_path(root, &relative_path, true)?;
    let copy = local_adapter::safe_cloud_file_path(root, &conflict_path, true)?;
    if !conflict_path.contains("(Flowix conflict ") || original.parent() != copy.parent()
        || original == copy {
        return Err("CLOUD_INVALID_CONFLICT_COPY".into());
    }
    let chosen = std::fs::read(&copy).map_err(sync_error)?;
    local_adapter::record_rejected_cloud_version(
        &memo_file, &notebook_id, root, &original, &chosen,
    )?;
    if use_local {
        let note_id = flowix_sync::v2_path_note_id(&notebook_id, &relative_path);
        let current = match std::fs::read(&original) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(sync_error(error)),
        };
        let baseline = state.cloud_sync.v2_note_state(&note_id).map_err(sync_error)?
            .ok_or_else(|| "CLOUD_CONFLICT_ORIGINAL_NOT_SYNCED".to_string())?;
        let current_hash = current.as_ref().map(|bytes| v2_content_hash(bytes));
        if baseline.deleted != current.is_none()
            || baseline.content_hash.as_deref() != current_hash.as_deref()
            || state.cloud_sync.has_pending_v2_note_change(&note_id).map_err(sync_error)? {
            return Err("CLOUD_CONFLICT_ORIGINAL_CHANGED".into());
        }
        if let Some(current) = current.as_ref() {
            let stem = original.file_stem().and_then(|value| value.to_str()).unwrap_or("attachment");
            let extension = original.extension().and_then(|value| value.to_str()).unwrap_or("");
            let backup_name = if extension.is_empty() {
                format!("{stem} (Flowix before conflict resolve {})", baseline.revision)
            } else {
                format!("{stem} (Flowix before conflict resolve {}).{extension}", baseline.revision)
            };
            let backup = original.with_file_name(backup_name);
            if !backup.exists() {
                flowix_core::memo_file::atomic_create_bytes(&backup, &current).map_err(sync_error)?;
                let backup_relative = flowix_core::memo_file::notebook_relative_path(root, &backup)?;
                if flowix_core::memo_file::media_kind_for_path(&backup).is_some() {
                    memo_file.refresh_media_resource_path(&notebook_id, &backup_relative).map_err(sync_error)?;
                }
                state.cloud_sync.record_v2_local_change(&notebook_id,
                    &flowix_sync::v2_path_note_id(&notebook_id, &backup_relative),
                    flowix_sync::LocalChangeKind::Put, &v2_content_hash(&current)).map_err(sync_error)?;
            } else if std::fs::read(&backup).map_err(sync_error)? != *current {
                return Err("CLOUD_CONFLICT_BACKUP_COLLISION".into());
            }
        }
        crate::watcher::runtime::mark_self_write_for(&app, &original);
        let preserved_path = local_adapter::cloud_conflict_copy_path(&original, &format!("resolve-{note_id}"));
        match local_adapter::safely_replace_cloud_file(&original, current.as_deref(), &chosen,
            &format!("resolve-{note_id}"), &preserved_path)? {
            local_adapter::ConflictFileOutcome::Applied { preserved: None } => {},
            outcome => {
                let preserved = match outcome {
                    local_adapter::ConflictFileOutcome::Applied { preserved }
                    | local_adapter::ConflictFileOutcome::Interrupted { preserved } => preserved,
                };
                if let Some(preserved) = preserved {
                    local_adapter::register_preserved_conflict_copy(&memo_file, &notebook_id,
                        root, &preserved, true)?;
                }
                return Err("CLOUD_CONFLICT_ORIGINAL_CHANGED".into());
            }
        }
        crate::watcher::runtime::mark_self_write_for(&app, &original);
        if flowix_core::memo_file::media_kind_for_path(&original).is_some() {
            memo_file.refresh_media_resource_path(&notebook_id, &relative_path).map_err(sync_error)?;
        }
        state.cloud_sync.record_v2_local_change(&notebook_id, &note_id,
            flowix_sync::LocalChangeKind::Put, &v2_content_hash(&chosen)).map_err(sync_error)?;
    }
    crate::watcher::runtime::mark_self_write_for(&app, &copy);
    let preserved_path = local_adapter::cloud_conflict_copy_path(&copy, &format!("remove-{conflict_path}"));
    match local_adapter::safely_remove_conflict_file(&copy, &chosen,
        &format!("remove-{conflict_path}"), &preserved_path)? {
        local_adapter::ConflictFileOutcome::Applied { preserved: None } => {},
        outcome => {
            let preserved = match outcome {
                local_adapter::ConflictFileOutcome::Applied { preserved }
                | local_adapter::ConflictFileOutcome::Interrupted { preserved } => preserved,
            };
            if let Some(preserved) = preserved {
                local_adapter::register_preserved_conflict_copy(&memo_file, &notebook_id,
                    root, &preserved, true)?;
            }
            return Err("CLOUD_CONFLICT_COPY_CHANGED".into());
        }
    }
    if flowix_core::memo_file::media_kind_for_path(&copy).is_some() {
        memo_file.refresh_media_resource_path(&notebook_id, &conflict_path).map_err(sync_error)?;
    }
    state.cloud_sync.record_v2_local_change(&notebook_id,
        &flowix_sync::v2_path_note_id(&notebook_id, &conflict_path),
        flowix_sync::LocalChangeKind::Delete, "deleted").map_err(sync_error)?;
    drop(_guard);
    drop(memo_file);
    let _ = app.emit("media-properties-changed", serde_json::json!({ "notebookId": notebook_id }));
    schedule_notebook_sync_observation(app, notebook_id, true);
    Ok(())
}

#[tauri::command]
pub async fn cloud_restore_note_revision(
    notebook_id: String,
    relative_path: String,
    revision: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let note_id = flowix_sync::v2_path_note_id(&notebook_id, &relative_path);
    let (history, bytes) = state.cloud_sync.v2_historical_bytes(&note_id, &revision).await.map_err(sync_error)?;
    if history.notebook_id != notebook_id || history.note_id != note_id {
        return Err("CLOUD_HISTORY_ID_MISMATCH".into());
    }
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let _guard = memo_file.acquire_cross_process_write_lock().map_err(sync_error)?;
    let notebook = memo_file.get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let root = Path::new(&notebook.path);
    let attachment = relative_path.starts_with("attachments/");
    let path = local_adapter::safe_cloud_file_path(root, &relative_path, attachment)?;
    let current = match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(sync_error(error)),
    };
    let baseline = state.cloud_sync.v2_note_state(&note_id).map_err(sync_error)?
        .ok_or_else(|| "CLOUD_RESTORE_NO_LOCAL_BASE".to_string())?;
    let current_hash = current.as_ref().map(|bytes| v2_content_hash(bytes));
    if baseline.deleted != current.is_none()
        || baseline.content_hash.as_deref() != current_hash.as_deref()
        || state.cloud_sync.has_pending_v2_note_change(&note_id).map_err(sync_error)? {
        return Err("CLOUD_RESTORE_LOCAL_CHANGED: save or resolve local edits first".into());
    }
    if current.as_deref() == Some(bytes.as_slice()) { return Ok(()); }
    if let Some(current) = current.as_ref() {
        let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("Note");
        let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("");
        let backup_name = if extension.is_empty() {
            format!("{stem} (Flowix before restore {})", revision)
        } else {
            format!("{stem} (Flowix before restore {}).{extension}", revision)
        };
        let backup = path.with_file_name(backup_name);
        if !backup.exists() {
            flowix_core::memo_file::atomic_create_bytes(&backup, &current).map_err(sync_error)?;
            if !attachment {
                memo_file.register_existing_file_for_notebook_id(&notebook_id, &backup).map_err(sync_error)?;
            }
            let backup_relative = flowix_core::memo_file::notebook_relative_path(root, &backup)?;
            if attachment && flowix_core::memo_file::media_kind_for_path(&backup).is_some() {
                memo_file.refresh_media_resource_path(&notebook_id, &backup_relative).map_err(sync_error)?;
            }
            state.cloud_sync.record_v2_local_change(&notebook_id,
                &flowix_sync::v2_path_note_id(&notebook_id, &backup_relative),
                flowix_sync::LocalChangeKind::Put, &v2_content_hash(&current)).map_err(sync_error)?;
        } else if std::fs::read(&backup).map_err(sync_error)? != *current {
            return Err("CLOUD_RESTORE_BACKUP_COLLISION".into());
        }
    }
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(sync_error)?; }
    crate::watcher::runtime::mark_self_write_for(&app, &path);
    let conflict_copy = local_adapter::cloud_conflict_copy_path(&path, &format!("restore-{revision}"));
    match local_adapter::safely_replace_cloud_file(&path, current.as_deref(), &bytes,
        &format!("restore-{revision}"), &conflict_copy)? {
        local_adapter::ConflictFileOutcome::Applied { preserved: None } => {},
        outcome => {
            let preserved = match outcome {
                local_adapter::ConflictFileOutcome::Applied { preserved }
                | local_adapter::ConflictFileOutcome::Interrupted { preserved } => preserved,
            };
            if let Some(preserved) = preserved {
                local_adapter::register_preserved_conflict_copy(&memo_file, &notebook_id,
                    root, &preserved, attachment)?;
            }
            return Err("CLOUD_RESTORE_LOCAL_CHANGED: local file preserved".into());
        }
    }
    if attachment {
        crate::watcher::runtime::mark_self_write_for(&app, &path);
        if flowix_core::memo_file::media_kind_for_path(&path).is_some() {
            memo_file.refresh_media_resource_path(&notebook_id, &relative_path).map_err(sync_error)?;
        }
        let _ = app.emit("media-properties-changed", serde_json::json!({ "notebookId": notebook_id }));
    } else {
        let updated = memo_file.register_existing_file_for_notebook_id(&notebook_id, &path).map_err(sync_error)?;
        memo_events::emit(&app, MemoEvent::Updated {
            id: updated.id.clone(), path: path.to_string_lossy().into_owned(),
            notebook_id: notebook_id.clone(),
            derived_changed: MemoDerivedChanged { tags: true, todos: true, agents: true },
            memo: updated, source: MemoChangeSource::CloudSync,
        });
    }
    state.cloud_sync.record_v2_local_change(
        &notebook_id, &note_id, flowix_sync::LocalChangeKind::Put,
        &v2_content_hash(&bytes),
    ).map_err(sync_error)?;
    drop(_guard);
    drop(memo_file);
    schedule_notebook_sync_observation(app, notebook_id, true);
    Ok(())
}
