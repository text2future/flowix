use std::collections::HashSet;
mod coordinator;
mod google_login;
mod local_adapter;
mod path_sync_runner;
mod path_sync_adapter;
pub(crate) use coordinator::{
    invalidate_notebook_selection, notebook_selection_changed, schedule_notebook_sync,
    schedule_notebook_sync_observation, schedule_pending_notebook_deletions,
    start_cloud_sync_polling,
};
pub(crate) use google_login::GoogleCallback;
use google_login::PendingGoogleLogin;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use chrono::Utc;
use flowix_core::memo_file::IsMd;
use flowix_sync::{
    AccountDeletionOutcome, AccountDeletionState, CloudAiCreditBalance, CloudCheckout,
    CloudMembership, CloudNoteShareLink, CloudNotebook, CloudOrder, CloudOrderCheck, CloudProduct,
    CloudState, CloudSubscription, PasswordResetCodeRequest, PathNotebookLink,
    PathNotebookMetadata, RegistrationCodeRequest, RegistrationCodeResend, SyncError,
};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
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

/// The active sync backend's capabilities. This is deliberately separate from
/// account state: a local S3 remote can sync without an account session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStorageAccess {
    /// `official` or `customS3`.
    pub target: &'static str,
    /// Identity of the S3 Remote selected when this process started.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    pub configured: bool,
    pub can_read: bool,
    pub can_upload: bool,
    pub can_delete: bool,
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
    pub progress_completed: Option<usize>,
    pub progress_total: Option<usize>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub last_error: Option<String>,
    /// The engine that produced these numbers, currently `path`.
    pub engine: Option<String>,
    /// The path engine accepted writes. False means the account is over quota
    /// or its membership lapsed: downloads still happen, publishes wait.
    pub writable: Option<bool>,
    /// The path engine was allowed to delete. False during the window after a
    /// fresh bind, after a bucket change, or when the server's clock is
    /// untrusted — a deletion needs all three to be trustworthy.
    pub allows_deletes: Option<bool>,
    pub deletion_deferred: Option<bool>,
    /// Paths the pass held back because applying the batch would delete this
    /// device's copies (the cloud already recorded the deletions).
    pub mass_deletion_local: Option<usize>,
    /// Paths the pass held back because applying the batch would delete the
    /// cloud copies, leaving no other source for them.
    pub mass_deletion_remote: Option<usize>,
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
            progress_completed: None,
            progress_total: None,
            started_at,
            finished_at: None,
            last_error: None,
            engine: None,
            writable: None,
            allows_deletes: None,
            deletion_deferred: None,
            mass_deletion_local: None,
            mass_deletion_remote: None,
        }
    }
}

fn sync_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn cloud_error(error: SyncError) -> String {
    match error {
        SyncError::Api { code, .. } if code == "NOTE_NOT_SYNCED" => code,
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
pub fn cloud_get_storage_access(state: State<AppState>) -> CloudStorageAccess {
    match state.cloud_sync.remote_kind() {
        flowix_sync::remote::RemoteKind::S3Compatible => {
            let configured = state.cloud_sync.remote_is_configured();
            let profile_id = state.cloud_sync.remote_profile_id();
            CloudStorageAccess {
                target: "customS3",
                profile_id,
                configured,
                can_read: configured,
                can_upload: configured,
                can_delete: configured,
            }
        }
        flowix_sync::remote::RemoteKind::OfficialCloud => {
            let access = state.cloud_sync.account().sync_access();
            CloudStorageAccess {
                target: "official",
                profile_id: None,
                configured: true,
                can_read: access.can_read,
                can_upload: access.can_upload,
                can_delete: access.can_delete,
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomS3Input {
    remote: flowix_sync::remote::S3Remote,
    #[serde(default)]
    profile_id: Option<String>,
    access_key_id: String,
    secret_access_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomS3ProfileInput {
    profile: crate::config::user::CloudStorageProfile,
    access_key_id: String,
    secret_access_key: String,
}

#[tauri::command]
pub fn cloud_get_storage_config(
    state: State<AppState>,
) -> Result<crate::config::user::CloudStorageSettings, String> {
    state
        .user_config
        .get_cloud_storage_settings()
        .map_err(sync_error)
}

#[tauri::command]
pub fn cloud_select_storage_target(
    target: crate::config::user::CloudStorageTarget,
    state: State<'_, AppState>,
) -> Result<crate::config::user::CloudStorageSettings, String> {
    state
        .user_config
        .select_cloud_storage_target(target)
        .map_err(sync_error)
}

#[tauri::command]
pub fn cloud_delete_custom_s3_profile(
    profile_id: String,
    state: State<'_, AppState>,
) -> Result<crate::config::user::CloudStorageSettings, String> {
    state
        .user_config
        .delete_custom_s3_profile(&profile_id)
        .map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_check_custom_s3(
    input: CustomS3Input,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (access_key_id, secret_access_key) = if input.access_key_id.trim().is_empty()
        && input.secret_access_key.is_empty()
    {
        let profile_id = input
            .profile_id
            .as_deref()
            .ok_or_else(|| "S3 credentials are required".to_string())?;
        let credentials = state
            .user_config
            .load_custom_s3_profile_credentials(profile_id)
            .map_err(sync_error)?
            .ok_or_else(|| "saved S3 credentials are unavailable".to_string())?;
        let candidate = input
            .remote
            .open(&credentials.access_key_id, &credentials.secret_access_key)
            .map_err(sync_error)?;
        if candidate.backend_id != credentials.backend_id
            || candidate.bucket != credentials.bucket
            || candidate.region != credentials.region
            || candidate.prefix != credentials.prefix
        {
            return Err(
                "re-enter the S3 credentials after changing the endpoint or storage scope".into(),
            );
        }
        (credentials.access_key_id, credentials.secret_access_key)
    } else if input.access_key_id.trim().is_empty() || input.secret_access_key.is_empty() {
        return Err("both S3 credentials must be provided together".into());
    } else {
        (input.access_key_id, input.secret_access_key)
    };

    input
        .remote
        .check_read_access(&reqwest::Client::new(), &access_key_id, &secret_access_key)
        .await
        .map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_save_custom_s3_profile(
    input: CustomS3ProfileInput,
    state: State<'_, AppState>,
) -> Result<crate::config::user::CloudStorageSettings, String> {
    if !input.access_key_id.trim().is_empty() || !input.secret_access_key.is_empty() {
        input
            .profile
            .remote
            .check_read_access(
                &reqwest::Client::new(),
                &input.access_key_id,
                &input.secret_access_key,
            )
            .await
            .map_err(sync_error)?;
    }
    state
        .user_config
        .save_custom_s3_profile(
            input.profile,
            &input.access_key_id,
            &input.secret_access_key,
        )
        .map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_update_account_region(
    region: String,
    state: State<'_, AppState>,
) -> Result<CloudState, String> {
    state
        .cloud_sync
        .account()
        .update_account_region(&region)
        .await
        .map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_request_password_reset_code(
    email: String,
    email_language: String,
    state: State<'_, AppState>,
) -> Result<PasswordResetCodeRequest, String> {
    state
        .cloud_sync
        .account()
        .request_password_reset_code(email.trim(), &email_language)
        .await
        .map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_confirm_password_reset_code(
    email: String,
    code: String,
    new_password: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .cloud_sync
        .account()
        .confirm_password_reset_code(email.trim(), code.trim(), &new_password)
        .await
        .map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_request_registration_code(
    email: String,
    password: String,
    display_name: String,
    email_language: String,
    state: State<'_, AppState>,
) -> Result<RegistrationCodeRequest, String> {
    state
        .cloud_sync
        .account()
        .request_registration_code(
            email.trim(),
            &password,
            display_name.trim(),
            &email_language,
        )
        .await
        .map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_resend_registration_code(
    email: String,
    state: State<'_, AppState>,
) -> Result<RegistrationCodeResend, String> {
    state
        .cloud_sync
        .account()
        .resend_registration_code(email.trim())
        .await
        .map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_confirm_registration(
    email: String,
    code: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<CloudState, String> {
    state
        .cloud_sync
        .account()
        .confirm_registration(email.trim(), code.trim(), &password)
        .await
        .map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_login(
    email: String,
    password: String,
    restore_deleted: Option<bool>,
    state: State<'_, AppState>,
) -> Result<CloudState, String> {
    state
        .cloud_sync
        .account()
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
        .cloud_sync
        .account()
        .deletion_state()
        .await
        .map_err(sync_error)
}

/// The account export document, untyped: it is a snapshot meant to be written
/// to disk, not a contract this client renders field by field.
#[tauri::command]
pub async fn cloud_export_account(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    state
        .cloud_sync
        .account()
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
    let credential_generation = state
        .cloud_sync
        .account()
        .ai_credential_session_generation();
    let outcome = state
        .cloud_sync
        .account()
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
    account_region: String,
    state: State<'_, AppState>,
) -> Result<CloudState, String> {
    let challenge = state
        .cloud_sync
        .account()
        .apple_challenge()
        .await
        .map_err(sync_error)?;
    let authorization = crate::apple_sign_in::authorize(window, challenge).await?;
    state
        .cloud_sync
        .account()
        .sign_in_with_apple(&authorization, &account_region)
        .await
        .map_err(sync_error)?;
    let next_state = state.cloud_sync.account().state().map_err(sync_error)?;
    Ok(next_state)
}

#[tauri::command]
pub async fn cloud_start_google_sign_in(
    app: AppHandle,
    account_region: String,
) -> Result<(), String> {
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
        .append_pair("code_challenge", &code_challenge)
        .append_pair("accountRegion", &account_region);
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
                .cloud_sync
                .account()
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
        .cloud_sync
        .account()
        .apple_challenge()
        .await
        .map_err(sync_error)?;
    let authorization = crate::apple_sign_in::authorize(window, challenge).await?;
    let next_state = state
        .cloud_sync
        .account()
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
    let logout_generation = state
        .cloud_sync
        .account()
        .ai_credential_session_generation();
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
) -> Result<Option<PathNotebookLink>, String> {
    state
        .cloud_sync
        .path_notebook(&notebook_id)
        .map_err(sync_error)
}

#[tauri::command]
pub fn cloud_list_notebook_states(state: State<AppState>) -> Result<Vec<PathNotebookLink>, String> {
    state
        .cloud_sync
        .path_enabled_notebooks()
        .map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_list_notebooks(
    state: State<'_, AppState>,
) -> Result<Vec<CloudNotebook>, String> {
    let notebooks_result = state.cloud_sync.remote_notebooks().await;
    notebooks_result.map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_link_notebook(
    notebook_id: String,
    cloud_notebook_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<PathNotebookLink, String> {
    state
        .cloud_sync
        .require_remote_access()
        .map_err(cloud_error)?;
    if notebook_id != cloud_notebook_id {
        return Err("CLOUD_NOTEBOOK_ID_MISMATCH".to_string());
    }
    let config = read_lock(&state.memo_file, "memo_file")
        .get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let link_result = state.cloud_sync.set_path_notebook_enabled(
        &PathNotebookMetadata {
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
) -> Result<PathNotebookLink, String> {
    if enabled {
        state
            .cloud_sync
            .require_remote_access()
            .map_err(cloud_error)?;
    }
    let config = read_lock(&state.memo_file, "memo_file")
        .get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let link_result = state.cloud_sync.set_path_notebook_enabled(
        &PathNotebookMetadata {
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
        .cloud_sync
        .account()
        .ai_credit_balance()
        .await
        .map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_pi_model_catalog(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let url = format!(
        "{}/v1/ai/model-catalog",
        state.cloud_environment.api_base().trim_end_matches('/')
    );
    reqwest::Client::new()
        .get(url)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cloud_pi_model_availability(state: State<'_, AppState>) -> Result<bool, String> {
    state
        .cloud_sync
        .account()
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
    state
        .cloud_sync
        .account()
        .products(region)
        .await
        .map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_list_billing_orders(
    state: State<'_, AppState>,
) -> Result<Vec<CloudOrder>, String> {
    state
        .cloud_sync
        .account()
        .billing_orders()
        .await
        .map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_check_billing_order(
    order_id: String,
    state: State<'_, AppState>,
) -> Result<CloudOrderCheck, String> {
    state
        .cloud_sync
        .account()
        .check_billing_order(&order_id)
        .await
        .map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_list_subscriptions(
    state: State<'_, AppState>,
) -> Result<Vec<CloudSubscription>, String> {
    state
        .cloud_sync
        .account()
        .subscriptions()
        .await
        .map_err(sync_error)
}

#[tauri::command]
pub async fn cloud_cancel_subscription(
    subscription_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .cloud_sync
        .account()
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
        .cloud_sync
        .account()
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
        .cloud_sync
        .account()
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

/// Answers the bulk-deletion prompt for one notebook.
///
/// `restore = false` is "continue": the next pass applies the batch the user
/// just saw. `restore = true` is "undo": the paths are forgotten, which puts
/// them back from whichever side still has them — a path deleted here is
/// downloaded from the cloud, a path deleted in the cloud is uploaded again.
/// Either way a pass is kicked off immediately, because the answer is only
/// useful if it lands before the next ten-second poll.
#[tauri::command]
pub async fn cloud_resolve_mass_deletion(
    notebook_id: String,
    restore: bool,
    app: AppHandle,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    if restore {
        let paths = path_sync_runner::latest_summary(&notebook_id)
            .map(|summary| summary.mass_deletion.paths)
            .unwrap_or_default();
        if paths.is_empty() {
            // The batch is gone (another pass already resolved it, or the app
            // restarted). Nothing to undo — but do not report a sync either.
            return Err("CLOUD_MASS_DELETION_GONE".to_string());
        }
        state
            .cloud_sync
            .restore_paths(&notebook_id, &paths)
            .map_err(cloud_error)?;
    } else {
        state.cloud_sync.allow_next_mass_deletion(&notebook_id);
    }
    coordinator::sync_now(Some(notebook_id), app).await.map(|_| ())
}

#[tauri::command]
pub async fn cloud_create_folder_share_link(
    notebook_id: String,
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<CloudNoteShareLink, String> {
    if state.cloud_sync.remote_kind() != flowix_sync::remote::RemoteKind::OfficialCloud {
        return Err("CLOUD_SHARE_OFFICIAL_REQUIRED".into());
    }
    state
        .cloud_sync
        .path_notebook(&notebook_id)
        .map_err(sync_error)?
        .filter(|link| link.enabled)
        .ok_or_else(|| "CLOUD_SHARE_SYNC_REQUIRED".to_string())?;
    state
        .cloud_sync
        .require_remote_access()
        .map_err(cloud_error)?;
    if !relative_path.is_empty()
        && !flowix_core::memo_file::is_syncable_notebook_directory_path(Path::new(&relative_path))
    {
        return Err("CLOUD_SHARE_INVALID_FOLDER".into());
    }
    let notebook = read_lock(&state.memo_file, "memo_file")
        .get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let mut folder = Path::new(&notebook.path).to_path_buf();
    for component in Path::new(&relative_path).components() {
        let std::path::Component::Normal(name) = component else {
            return Err("CLOUD_SHARE_INVALID_FOLDER".into());
        };
        folder.push(name);
        if std::fs::symlink_metadata(&folder)
            .map_err(sync_error)?
            .file_type()
            .is_symlink()
        {
            return Err("CLOUD_SHARE_INVALID_FOLDER".into());
        }
    }
    if !folder.is_dir() {
        return Err("CLOUD_SHARE_INVALID_FOLDER".into());
    }
    state
        .cloud_sync
        .account()
        .create_folder_share_link(&notebook_id, &relative_path)
        .await
        .map_err(cloud_error)
}

#[tauri::command]
pub async fn cloud_create_note_share_link(
    notebook_id: String,
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<CloudNoteShareLink, String> {
    if state.cloud_sync.remote_kind() != flowix_sync::remote::RemoteKind::OfficialCloud {
        return Err("CLOUD_SHARE_OFFICIAL_REQUIRED".into());
    }
    state
        .cloud_sync
        .path_notebook(&notebook_id)
        .map_err(sync_error)?
        .filter(|link| link.enabled)
        .ok_or_else(|| "CLOUD_SHARE_SYNC_REQUIRED".to_string())?;
    state
        .cloud_sync
        .require_remote_access()
        .map_err(cloud_error)?;

    let relative = Path::new(&relative_path);
    if !relative.is_md() || !flowix_core::memo_file::is_syncable_notebook_file_path(relative) {
        return Err("CLOUD_SHARE_INVALID_NOTE".into());
    }
    let notebook = read_lock(&state.memo_file, "memo_file")
        .get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let note_path = local_adapter::safe_cloud_note_path(Path::new(&notebook.path), &relative_path)?;
    let metadata = std::fs::metadata(&note_path).map_err(sync_error)?;
    if !metadata.is_file() {
        return Err("CLOUD_SHARE_INVALID_NOTE".into());
    }
    if metadata.len() > 5 * 1024 * 1024 {
        return Err("CLOUD_SHARE_NOTE_TOO_LARGE".into());
    }
    let bytes = std::fs::read(note_path).map_err(sync_error)?;
    let content_hash = flowix_sync::apply::content_hash(&bytes);
    state
        .cloud_sync
        .account()
        .create_note_share_link(&notebook_id, &relative_path, &content_hash)
        .await
        .map_err(cloud_error)
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
    let collection = !attachment
        && flowix_core::collection::is_collection_document_path(Path::new(&relative_path));
    if !attachment && !collection && !Path::new(&relative_path).is_md() {
        return Err("CLOUD_HISTORY_INVALID_PATH".into());
    }
    let path = if collection {
        local_adapter::safe_cloud_collection_path(root, &relative_path)?
    } else {
        local_adapter::safe_cloud_file_path(root, &relative_path, attachment)?
    };
    let target = memo_file
        .read_path_version_bytes(&notebook_id, &relative_path, &version_id)
        .ok_or_else(|| "CLOUD_HISTORY_VERSION_NOT_FOUND".to_string())?;
    if !attachment && !collection && std::str::from_utf8(&target).is_err() {
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
            if let Some(preserved) = preserved.filter(|_| !collection) {
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
    if collection {
        drop(_guard);
        flowix_core::collection_store::refresh_path(&memo_file, &path);
        let _ = app.emit(
            "file-management-changed",
            serde_json::json!({"notebookId": notebook_id, "notebookPath": notebook.path}),
        );
        let _ = app.emit("collection-changed", serde_json::json!({"notebookId": notebook_id, "notebookPath": notebook.path, "relativePath": relative_path}));
    } else if attachment {
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
        crate::events::path_change::NotebookPathInvalidated::new(
            notebook_id.clone(),
            relative_path.clone(),
        )
        .emit(&app);
    }
    Ok(())
}
