use std::collections::{HashMap, HashSet};
mod coordinator;
mod deletion;
mod google_login;
mod local_adapter;
pub(crate) use coordinator::{
    schedule_notebook_sync, schedule_notebook_sync_observation, start_cloud_sync_polling,
};
pub(crate) use google_login::GoogleCallback;
use google_login::PendingGoogleLogin;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use chrono::Utc;
use flowix_core::memo_file::{notebook_path_from_relative, notebook_relative_path, IsMd};
use flowix_sync::{
    v2_content_hash, v2_local_content_diverged, AccountDeletionOutcome, AccountDeletionState,
    CloudAiCreditBalance, CloudCheckout, CloudMembership, CloudNotebook, CloudOrder,
    CloudOrderCheck, CloudProduct, CloudState, CloudSubscription, SyncError, V2AccountSyncReport,
    V2LocalNote, V2LocalNotebook, V2RemoteApply, V2SyncedNotebook,
};
use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

static GOOGLE_OAUTH_LOGIN: Lazy<Mutex<Option<PendingGoogleLogin>>> = Lazy::new(|| Mutex::new(None));

use crate::app::state::AppState;
use crate::lock_utils::read_lock;

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
            if code == "MEMBERSHIP_REQUIRED"
                || code == "STORAGE_QUOTA_EXCEEDED"
                || code == "ACCOUNT_DELETED_RESTORABLE" =>
        {
            // Codes the UI must branch on keep their details (`restorableUntil`
            // for a deleted account, quota numbers for storage). Everything
            // else stays a plain message.
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

#[tauri::command]
pub fn cloud_get_state(state: State<AppState>) -> Result<CloudState, String> {
    state.cloud_sync.account().state().map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_register(
    email: String,
    password: String,
    display_name: String,
    state: State<'_, AppState>,
) -> Result<CloudState, String> {
    state
        .cloud_sync.account()
        .register(email.trim(), &password, display_name.trim())
        .await
        .map_err(sync_error)?;
    let next_state = state.cloud_sync.account().state().map_err(sync_error)?;
    Ok(next_state)
}

#[tauri::command]
pub async fn cloud_login(
    email: String,
    password: String,
    restore_deleted: Option<bool>,
    state: State<'_, AppState>,
) -> Result<CloudState, String> {
    state
        .cloud_sync.account()
        .login_with_restore(email.trim(), &password, restore_deleted.unwrap_or(false))
        .await
        .map_err(cloud_error)?;
    let next_state = state.cloud_sync.account().state().map_err(sync_error)?;
    Ok(next_state)
}

/// Where this account stands in its deletion lifecycle, including the real
/// grace deadline. The client asks before offering a destructive action so the
/// wording comes from the server rather than a hardcoded "30 days".
#[tauri::command]
pub async fn cloud_account_deletion(
    state: State<'_, AppState>,
) -> Result<AccountDeletionState, String> {
    state
        .cloud_sync.account()
        .deletion_state()
        .await
        .map_err(sync_error)
}

/// The account export document, untyped: it is a snapshot meant to be written
/// to disk, not a contract this client renders field by field.
#[tauri::command]
pub async fn cloud_export_account(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state
        .cloud_sync.account()
        .export_account()
        .await
        .map_err(sync_error)
}

/// Start deleting the signed-in account.
///
/// Deletion revokes every server session, so the local side has nothing left to
/// revoke — the account service clears authentication, the sync database and
/// the persisted refresh token itself. The only extra work here is dropping the
/// PI provider, which holds an access credential that no longer exists.
#[tauri::command]
pub async fn cloud_delete_account(
    app: AppHandle,
    confirm_email: String,
    state: State<'_, AppState>,
) -> Result<AccountDeletionOutcome, String> {
    let pi = state.pi.clone();
    let api_base = state.cloud_environment.api_base().to_string();
    let credential_generation = state.cloud_sync.account().ai_credential_session_generation();
    let outcome = state
        .cloud_sync.account()
        .delete_account(confirm_email.trim())
        .await
        .map_err(sync_error)?;
    if let Err(error) = pi
        .disconnect_cloud_model_provider(&app, &api_base, credential_generation)
        .await
    {
        // The account is already gone server-side; a provider that fails to
        // disconnect must not turn a completed deletion into an error.
        tracing::warn!("failed to disconnect cloud model provider after account deletion: {error}");
    }
    if let Ok(next_state) = state.cloud_sync.account().state() {
        emit_cloud_state(&app, &next_state);
    }
    Ok(outcome)
}

#[tauri::command]
pub async fn cloud_sign_in_with_apple(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<CloudState, String> {
    let challenge = state
        .cloud_sync.account()
        .apple_challenge()
        .await
        .map_err(sync_error)?;
    let authorization = crate::apple_sign_in::authorize(window, challenge).await?;
    state
        .cloud_sync.account()
        .sign_in_with_apple(&authorization)
        .await
        .map_err(sync_error)?;
    let next_state = state.cloud_sync.account().state().map_err(sync_error)?;
    Ok(next_state)
}

#[tauri::command]
pub async fn cloud_start_google_sign_in(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use sha2::{Digest, Sha256};

    let app_state = app.state::<AppState>();
    let generation = app_state.cloud_sync.account().begin_google_sign_in();
    let cloud_api_base = app_state.cloud_environment.api_base();
    let state = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let code_verifier = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let code_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
    {
        *GOOGLE_OAUTH_LOGIN.lock().unwrap_or_else(|p| p.into_inner()) = Some(
            PendingGoogleLogin::new(state.clone(), code_verifier, generation),
        );
    }
    let mut url = url::Url::parse(&format!("{cloud_api_base}/v1/auth/google/start"))
        .map_err(|error| error.to_string())?;
    let mut query = url.query_pairs_mut();
    query
        .append_pair(
            "mode",
            if option_env!("FLOWIX_DEV_MODE") == Some("1") {
                "desktop-dev"
            } else {
                "desktop"
            },
        )
        .append_pair("state", &state)
        .append_pair("code_challenge", &code_challenge);
    let client_platform = match std::env::consts::OS {
        "macos" => Some("macos"),
        "windows" => Some("windows"),
        _ => None,
    };
    if let Some(client_platform) = client_platform {
        query.append_pair("clientPlatform", client_platform);
    }
    query.append_pair("clientVersion", &app.package_info().version.to_string());
    drop(query);
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| error.to_string())
}

pub(crate) async fn complete_google_deep_link(
    app: AppHandle,
    callback: GoogleCallback,
) -> Result<(), String> {
    match callback {
        GoogleCallback::Success {
            code,
            state: oauth_state,
        } => {
            let claimed = {
                let mut pending = GOOGLE_OAUTH_LOGIN.lock().unwrap_or_else(|p| p.into_inner());
                let attempt = pending.as_mut().ok_or_else(|| {
                    "No Google sign-in is pending in this App; start sign-in again here".to_string()
                })?;
                attempt.claim(&oauth_state).map_err(str::to_string)?
            };
            let Some((code_verifier, generation)) = claimed else {
                return Ok(());
            };
            let app_state = app.state::<AppState>();
            app_state
                .cloud_sync.account()
                .sign_in_with_google_desktop(&code, &oauth_state, &code_verifier, generation)
                .await
                .map_err(sync_error)?;
            if let Err(error) = crate::commands::window::open_preferences_window_inner(
                &app,
                &app_state,
                Some("cloudSync"),
            ) {
                tracing::warn!(
                    "Google sign-in succeeded but account preferences could not open: {error}"
                );
            }
            Ok(())
        }
        GoogleCallback::Failure {
            error,
            state: oauth_state,
        } => {
            let accepted = {
                let mut pending = GOOGLE_OAUTH_LOGIN.lock().unwrap_or_else(|p| p.into_inner());
                let Some(attempt) = pending.as_mut() else {
                    return Ok(());
                };
                attempt
                    .claim_failure(&oauth_state)
                    .map_err(str::to_string)?
            };
            if accepted {
                let _ = app.emit("cloud-google-auth-error", error);
            }
            Ok(())
        }
    }
}

#[tauri::command]
pub async fn cloud_link_apple(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<CloudState, String> {
    let challenge = state
        .cloud_sync.account()
        .apple_challenge()
        .await
        .map_err(sync_error)?;
    let authorization = crate::apple_sign_in::authorize(window, challenge).await?;
    let next_state = state
        .cloud_sync.account()
        .link_apple(&authorization)
        .await
        .map_err(sync_error)?;
    Ok(next_state)
}

#[tauri::command]
pub async fn cloud_logout(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CloudState, String> {
    let pi = state.pi.clone();
    let api_base = state.cloud_environment.api_base().to_string();
    let pending_logout = state.cloud_sync.account().begin_logout();
    let logout_generation = state.cloud_sync.account().ai_credential_session_generation();
    let next_state = state.cloud_sync.account().state().map_err(sync_error);
    let pi_cleanup = async {
        match &next_state {
            Ok(next_state) if !next_state.authenticated => {
                pi.disconnect_cloud_model_provider(&app, &api_base, logout_generation)
                    .await
            }
            _ => Ok(()),
        }
    };
    let logout = state.cloud_sync.account().finish_logout(pending_logout);
    let (pi_cleanup, logout_result) = tokio::join!(pi_cleanup, logout);
    let next_state = next_state?;
    pi_cleanup?;
    logout_result.map_err(sync_error)?;
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
    notebooks_result.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_link_notebook(
    notebook_id: String,
    cloud_notebook_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<V2SyncedNotebook, String> {
    state.cloud_sync.account().require_sync_access().map_err(cloud_error)?;
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
    let link = link_result.map_err(cloud_error)?;
    if let Ok(next_state) = state.cloud_sync.account().state() {
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
    if enabled { state.cloud_sync.account().require_sync_access().map_err(cloud_error)?; }
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
    let link = link_result.map_err(cloud_error)?;
    if let Ok(next_state) = state.cloud_sync.account().state() {
        emit_cloud_state(&app, &next_state);
    }
    Ok(link)
}

#[tauri::command]
pub async fn cloud_refresh_membership(
    state: State<'_, AppState>,
) -> Result<CloudMembership, String> {
    let membership_result = state.cloud_sync.account().refresh_membership().await;
    membership_result.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_ai_credit_balance(
    state: State<'_, AppState>,
) -> Result<CloudAiCreditBalance, String> {
    state
        .cloud_sync.account()
        .ai_credit_balance()
        .await
        .map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_pi_model_catalog(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/v1/ai/model-catalog", state.cloud_environment.api_base().trim_end_matches('/'));
    reqwest::Client::new()
        .get(url)
        .timeout(std::time::Duration::from_secs(15))
        .send().await.map_err(|error| error.to_string())?
        .error_for_status().map_err(|error| error.to_string())?
        .json().await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cloud_pi_model_availability(
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state
        .cloud_sync.account()
        .ai_model_availability()
        .await
        .map(|availability| availability.enabled)
        .map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_refresh_pi_model_provider_at_startup(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let api_base = state.cloud_environment.api_base().trim_end_matches('/');
    state
        .pi
        .refresh_cloud_model_provider_at_startup(&app, api_base)
        .await
}

#[tauri::command]
pub async fn cloud_refresh_pi_model_provider(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let api_base = state.cloud_environment.api_base().trim_end_matches('/');
    state.pi.refresh_cloud_model_provider(&app, api_base).await
}

#[tauri::command]
pub async fn cloud_list_products(
    region: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<CloudProduct>, String> {
    let region = match region.as_deref() {
        Some("mainland") => "mainland",
        _ => "non_mainland",
    };
    state.cloud_sync.account().products(region).await.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_list_billing_orders(
    state: State<'_, AppState>,
) -> Result<Vec<CloudOrder>, String> {
    state.cloud_sync.account().billing_orders().await.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_check_billing_order(
    order_id: String,
    state: State<'_, AppState>,
) -> Result<CloudOrderCheck, String> {
    state
        .cloud_sync.account()
        .check_billing_order(&order_id)
        .await
        .map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_list_subscriptions(
    state: State<'_, AppState>,
) -> Result<Vec<CloudSubscription>, String> {
    state.cloud_sync.account().subscriptions().await.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_cancel_subscription(
    subscription_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .cloud_sync.account()
        .cancel_subscription(&subscription_id)
        .await
        .map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_create_checkout(
    product_id: String,
    state: State<'_, AppState>,
) -> Result<CloudCheckout, String> {
    let idempotency_key = format!("desktop-{}", uuid::Uuid::new_v4());
    let checkout_result = state
        .cloud_sync.account()
        .create_checkout(&product_id, &idempotency_key)
        .await;
    checkout_result.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_submit_feedback(
    device_id: String,
    kind: String,
    content: String,
    app_version: String,
    platform: String,
    attachments: Vec<serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .cloud_sync.account()
        .submit_feedback(
            &device_id,
            &kind,
            &content,
            &app_version,
            &platform,
            &attachments,
        )
        .await
        .map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_sync_now(
    notebook_id: Option<String>,
    app: AppHandle,
) -> Result<CloudSyncResult, String> {
    coordinator::sync_now(notebook_id, app).await
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
    let _guard = memo_file
        .operation_locks()
        .notebook_change(&[&notebook_id], "restore_local_path_version")
        .map_err(sync_error)?;
    let notebook = memo_file
        .get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let root = Path::new(&notebook.path);
    let attachment = relative_path.starts_with("attachments/");
    if !attachment && !Path::new(&relative_path).is_md() {
        return Err("CLOUD_HISTORY_INVALID_PATH".into());
    }
    let path = local_adapter::safe_cloud_file_path(root, &relative_path, attachment)?;
    let target = memo_file
        .read_path_version_bytes(&notebook_id, &relative_path, &version_id)
        .ok_or_else(|| "CLOUD_HISTORY_VERSION_NOT_FOUND".to_string())?;
    if !attachment && std::str::from_utf8(&target).is_err() {
        return Err("CLOUD_HISTORY_INVALID_MARKDOWN".into());
    }
    let current = match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(sync_error(error)),
    };
    if current.as_deref() == Some(target.as_slice()) {
        return Ok(());
    }
    if let Some(bytes) = current.as_deref() {
        memo_file
            .create_path_version_bytes(
                &notebook_id,
                &relative_path,
                bytes,
                flowix_core::memo_file::MemoVersionSource::RestoreBackup,
            )
            .map_err(sync_error)?;
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(sync_error)?;
    }
    let fallback = local_adapter::cloud_conflict_copy_path(&path, &format!("restore-{version_id}"));
    match local_adapter::safely_replace_cloud_file(
        &path,
        current.as_deref(),
        &target,
        &format!("restore-{version_id}"),
        &fallback,
    )? {
        local_adapter::ConflictFileOutcome::Applied { preserved: None } => {}
        outcome => {
            let preserved = match outcome {
                local_adapter::ConflictFileOutcome::Applied { preserved }
                | local_adapter::ConflictFileOutcome::Interrupted { preserved } => preserved,
            };
            if let Some(preserved) = preserved {
                local_adapter::register_preserved_conflict_copy(
                    &memo_file,
                    &notebook_id,
                    root,
                    &preserved,
                    attachment,
                )?;
            }
            return Err("CLOUD_HISTORY_LOCAL_CHANGED".into());
        }
    }
    crate::watcher::runtime::mark_self_write_content_for(&app, &path, &target);
    // The disk write has committed. Ensure sync observes it even if an index
    // or media refresh below fails after the watcher self-write marker.
    schedule_notebook_sync_observation(app.clone(), notebook_id.clone(), true);
    if attachment {
        memo_file
            .refresh_indexed_resource_path(&notebook_id, &relative_path)
            .map_err(sync_error)?;
        let _ = app.emit(
            "media-properties-changed",
            serde_json::json!({ "notebookId": notebook_id }),
        );
    } else {
        memo_file
            .refresh_note_path(&notebook_id, &relative_path)
            .map_err(sync_error)?;
        crate::commands::path_change::NotebookPathInvalidated::new(
            notebook_id.clone(),
            relative_path.clone(),
        )
        .emit(&app);
    }
    Ok(())
}

#[tauri::command]
pub fn cloud_list_conflicts(
    notebook_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let notebook = memo_file
        .get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let notes = match memo_file.read_note_entries(&notebook_id) {
        Ok(notes) => notes,
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
            memo_file
                .reconcile_note_index_blocking(&notebook_id)
                .map_err(|error| error.to_string())?;
            memo_file
                .read_note_entries(&notebook_id)
                .map_err(|error| error.to_string())?
        }
        Err(error) => return Err(error.to_string()),
    };
    let mut paths: Vec<String> = notes
        .into_iter()
        .filter(|note| note.relative_path.contains("(Flowix conflict "))
        .map(|note| note.relative_path)
        .collect();
    let mut attachments = Vec::new();
    let root = Path::new(&notebook.path);
    local_adapter::scan_cloud_attachments(root, &root.join("attachments"), &mut attachments)?;
    for path in attachments {
        let relative = flowix_core::memo_file::notebook_relative_path(root, &path)?;
        if relative.contains("(Flowix conflict ") {
            paths.push(relative);
        }
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
    let _guard = memo_file
        .operation_locks()
        .notebook_change(&[&notebook_id], "resolve_markdown_conflict")
        .map_err(sync_error)?;
    let notebook = memo_file
        .get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let root = Path::new(&notebook.path);
    let original = local_adapter::safe_cloud_note_path(root, &relative_path)?;
    let copy = local_adapter::safe_cloud_note_path(root, &conflict_path)?;
    let note_id = flowix_sync::v2_path_note_id(&notebook_id, &relative_path);
    if !conflict_path.contains("(Flowix conflict ")
        || original.parent() != copy.parent()
        || original == copy
    {
        return Err("CLOUD_INVALID_CONFLICT_COPY".into());
    }
    if !copy.is_file() {
        return Err("CLOUD_CONFLICT_COPY_MISSING".to_string());
    }
    let copy_bytes = std::fs::read(&copy).map_err(sync_error)?;
    local_adapter::record_rejected_cloud_version(
        &memo_file,
        &notebook_id,
        root,
        &original,
        &copy_bytes,
    )?;
    if use_local {
        let current = match std::fs::read(&original) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(sync_error(error)),
        };
        let chosen = copy_bytes.clone();
        let baseline = state
            .cloud_sync
            .v2_note_state(&note_id)
            .map_err(sync_error)?
            .ok_or_else(|| "CLOUD_CONFLICT_ORIGINAL_NOT_SYNCED".to_string())?;
        let current_hash = current.as_ref().map(|bytes| v2_content_hash(bytes));
        if baseline.deleted != current.is_none()
            || baseline.content_hash.as_deref() != current_hash.as_deref()
            || state
                .cloud_sync
                .has_pending_v2_note_change(&note_id)
                .map_err(sync_error)?
        {
            return Err("CLOUD_CONFLICT_ORIGINAL_CHANGED".into());
        }
        if let Some(current) = current.as_ref() {
            let stem = original
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("Note");
            let backup = original.with_file_name(format!(
                "{stem} (Flowix before conflict resolve {}).md",
                baseline.revision
            ));
            if !backup.exists() {
                flowix_core::memo_file::atomic_create_bytes(&backup, &current)
                    .map_err(sync_error)?;
                let backup_relative =
                    flowix_core::memo_file::notebook_relative_path(root, &backup)?;
                memo_file
                    .refresh_note_path(&notebook_id, &backup_relative)
                    .map_err(sync_error)?;
                state
                    .cloud_sync
                    .record_v2_local_change(
                        &notebook_id,
                        &flowix_sync::v2_path_note_id(&notebook_id, &backup_relative),
                        flowix_sync::LocalChangeKind::Put,
                        &v2_content_hash(&current),
                    )
                    .map_err(sync_error)?;
            } else if std::fs::read(&backup).map_err(sync_error)? != *current {
                return Err("CLOUD_CONFLICT_BACKUP_COLLISION".into());
            }
        }
        if let Some(parent) = original.parent() {
            std::fs::create_dir_all(parent).map_err(sync_error)?;
        }
        crate::watcher::runtime::mark_self_write_for(&app, &original);
        let preserved_path =
            local_adapter::cloud_conflict_copy_path(&original, &format!("resolve-{note_id}"));
        match local_adapter::safely_replace_cloud_file(
            &original,
            current.as_deref(),
            &chosen,
            &format!("resolve-{note_id}"),
            &preserved_path,
        )? {
            local_adapter::ConflictFileOutcome::Applied { preserved: None } => {}
            outcome => {
                let preserved = match outcome {
                    local_adapter::ConflictFileOutcome::Applied { preserved }
                    | local_adapter::ConflictFileOutcome::Interrupted { preserved } => preserved,
                };
                if let Some(preserved) = preserved {
                    local_adapter::register_preserved_conflict_copy(
                        &memo_file,
                        &notebook_id,
                        root,
                        &preserved,
                        false,
                    )?;
                }
                return Err("CLOUD_CONFLICT_ORIGINAL_CHANGED".into());
            }
        }
        memo_file
            .refresh_note_path(&notebook_id, &relative_path)
            .map_err(sync_error)?;
        crate::commands::path_change::NotebookPathInvalidated::new(
            notebook_id.clone(),
            relative_path.clone(),
        )
        .emit(&app);
        state
            .cloud_sync
            .record_v2_local_change(
                &notebook_id,
                &note_id,
                flowix_sync::LocalChangeKind::Put,
                &v2_content_hash(&chosen),
            )
            .map_err(sync_error)?;
    }
    crate::watcher::runtime::mark_self_write_for(&app, &copy);
    let copy_note_id = flowix_sync::v2_path_note_id(&notebook_id, &conflict_path);
    let preserved_path =
        local_adapter::cloud_conflict_copy_path(&copy, &format!("remove-{copy_note_id}"));
    match local_adapter::safely_remove_conflict_file(
        &copy,
        &copy_bytes,
        &format!("remove-{copy_note_id}"),
        &preserved_path,
    )? {
        local_adapter::ConflictFileOutcome::Applied { preserved: None } => {}
        outcome => {
            let preserved = match outcome {
                local_adapter::ConflictFileOutcome::Applied { preserved }
                | local_adapter::ConflictFileOutcome::Interrupted { preserved } => preserved,
            };
            if let Some(preserved) = preserved {
                local_adapter::register_preserved_conflict_copy(
                    &memo_file,
                    &notebook_id,
                    root,
                    &preserved,
                    false,
                )?;
            }
            return Err("CLOUD_CONFLICT_COPY_CHANGED".into());
        }
    }
    if copy.exists() {
        return Err("CLOUD_CONFLICT_COPY_CHANGED".into());
    }
    memo_file
        .refresh_note_path(&notebook_id, &conflict_path)
        .map_err(sync_error)?;
    state
        .cloud_sync
        .record_v2_local_change(
            &notebook_id,
            &copy_note_id,
            flowix_sync::LocalChangeKind::Delete,
            "deleted",
        )
        .map_err(sync_error)?;
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
    let _guard = memo_file
        .operation_locks()
        .notebook_change(&[&notebook_id], "resolve_attachment_conflict")
        .map_err(sync_error)?;
    let notebook = memo_file
        .get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let root = Path::new(&notebook.path);
    let original = local_adapter::safe_cloud_file_path(root, &relative_path, true)?;
    let copy = local_adapter::safe_cloud_file_path(root, &conflict_path, true)?;
    if !conflict_path.contains("(Flowix conflict ")
        || original.parent() != copy.parent()
        || original == copy
    {
        return Err("CLOUD_INVALID_CONFLICT_COPY".into());
    }
    let chosen = std::fs::read(&copy).map_err(sync_error)?;
    local_adapter::record_rejected_cloud_version(
        &memo_file,
        &notebook_id,
        root,
        &original,
        &chosen,
    )?;
    if use_local {
        let note_id = flowix_sync::v2_path_note_id(&notebook_id, &relative_path);
        let current = match std::fs::read(&original) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(sync_error(error)),
        };
        let baseline = state
            .cloud_sync
            .v2_note_state(&note_id)
            .map_err(sync_error)?
            .ok_or_else(|| "CLOUD_CONFLICT_ORIGINAL_NOT_SYNCED".to_string())?;
        let current_hash = current.as_ref().map(|bytes| v2_content_hash(bytes));
        if baseline.deleted != current.is_none()
            || baseline.content_hash.as_deref() != current_hash.as_deref()
            || state
                .cloud_sync
                .has_pending_v2_note_change(&note_id)
                .map_err(sync_error)?
        {
            return Err("CLOUD_CONFLICT_ORIGINAL_CHANGED".into());
        }
        if let Some(current) = current.as_ref() {
            let stem = original
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("attachment");
            let extension = original
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            let backup_name = if extension.is_empty() {
                format!(
                    "{stem} (Flowix before conflict resolve {})",
                    baseline.revision
                )
            } else {
                format!(
                    "{stem} (Flowix before conflict resolve {}).{extension}",
                    baseline.revision
                )
            };
            let backup = original.with_file_name(backup_name);
            if !backup.exists() {
                flowix_core::memo_file::atomic_create_bytes(&backup, &current)
                    .map_err(sync_error)?;
                let backup_relative =
                    flowix_core::memo_file::notebook_relative_path(root, &backup)?;
                if flowix_core::memo_file::resource_kind_for_path(&backup).is_some() {
                    memo_file
                        .refresh_indexed_resource_path(&notebook_id, &backup_relative)
                        .map_err(sync_error)?;
                }
                state
                    .cloud_sync
                    .record_v2_local_change(
                        &notebook_id,
                        &flowix_sync::v2_path_note_id(&notebook_id, &backup_relative),
                        flowix_sync::LocalChangeKind::Put,
                        &v2_content_hash(&current),
                    )
                    .map_err(sync_error)?;
            } else if std::fs::read(&backup).map_err(sync_error)? != *current {
                return Err("CLOUD_CONFLICT_BACKUP_COLLISION".into());
            }
        }
        crate::watcher::runtime::mark_self_write_for(&app, &original);
        let preserved_path =
            local_adapter::cloud_conflict_copy_path(&original, &format!("resolve-{note_id}"));
        match local_adapter::safely_replace_cloud_file(
            &original,
            current.as_deref(),
            &chosen,
            &format!("resolve-{note_id}"),
            &preserved_path,
        )? {
            local_adapter::ConflictFileOutcome::Applied { preserved: None } => {}
            outcome => {
                let preserved = match outcome {
                    local_adapter::ConflictFileOutcome::Applied { preserved }
                    | local_adapter::ConflictFileOutcome::Interrupted { preserved } => preserved,
                };
                if let Some(preserved) = preserved {
                    local_adapter::register_preserved_conflict_copy(
                        &memo_file,
                        &notebook_id,
                        root,
                        &preserved,
                        true,
                    )?;
                }
                return Err("CLOUD_CONFLICT_ORIGINAL_CHANGED".into());
            }
        }
        crate::watcher::runtime::mark_self_write_for(&app, &original);
        if flowix_core::memo_file::resource_kind_for_path(&original).is_some() {
            memo_file
                .refresh_indexed_resource_path(&notebook_id, &relative_path)
                .map_err(sync_error)?;
        }
        state
            .cloud_sync
            .record_v2_local_change(
                &notebook_id,
                &note_id,
                flowix_sync::LocalChangeKind::Put,
                &v2_content_hash(&chosen),
            )
            .map_err(sync_error)?;
    }
    crate::watcher::runtime::mark_self_write_for(&app, &copy);
    let preserved_path =
        local_adapter::cloud_conflict_copy_path(&copy, &format!("remove-{conflict_path}"));
    match local_adapter::safely_remove_conflict_file(
        &copy,
        &chosen,
        &format!("remove-{conflict_path}"),
        &preserved_path,
    )? {
        local_adapter::ConflictFileOutcome::Applied { preserved: None } => {}
        outcome => {
            let preserved = match outcome {
                local_adapter::ConflictFileOutcome::Applied { preserved }
                | local_adapter::ConflictFileOutcome::Interrupted { preserved } => preserved,
            };
            if let Some(preserved) = preserved {
                local_adapter::register_preserved_conflict_copy(
                    &memo_file,
                    &notebook_id,
                    root,
                    &preserved,
                    true,
                )?;
            }
            return Err("CLOUD_CONFLICT_COPY_CHANGED".into());
        }
    }
    if flowix_core::memo_file::resource_kind_for_path(&copy).is_some() {
        memo_file
            .refresh_indexed_resource_path(&notebook_id, &conflict_path)
            .map_err(sync_error)?;
    }
    state
        .cloud_sync
        .record_v2_local_change(
            &notebook_id,
            &flowix_sync::v2_path_note_id(&notebook_id, &conflict_path),
            flowix_sync::LocalChangeKind::Delete,
            "deleted",
        )
        .map_err(sync_error)?;
    drop(_guard);
    drop(memo_file);
    let _ = app.emit(
        "media-properties-changed",
        serde_json::json!({ "notebookId": notebook_id }),
    );
    schedule_notebook_sync_observation(app, notebook_id, true);
    Ok(())
}
