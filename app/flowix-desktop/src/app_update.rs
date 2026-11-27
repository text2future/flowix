use futures::future::{AbortHandle, Abortable};
use serde_json::json;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::Update;
use tauri_plugin_updater::UpdaterExt;

#[path = "app_update_cache.rs"]
mod update_cache;
#[path = "app_update_download.rs"]
mod update_download;
#[path = "app_update_state.rs"]
mod update_state;
use self::update_cache::{prepare_update_package, PreparedUpdate, VerifiedUpdate};
use self::update_state::UpdatePhase;

#[derive(Clone, Default)]
pub struct AppUpdateState {
    active: Arc<Mutex<ActiveUpdate>>,
    check_lock: Arc<tokio::sync::Mutex<()>>,
    prepared: Arc<Mutex<Option<PreparedUpdate>>>,
}

#[derive(Default)]
struct ActiveUpdate {
    phase: UpdatePhase,
    abort: Option<AbortHandle>,
}

// Once installing, this guard belongs to the blocking worker. Dropping the
// awaiting command cannot allow another update while that worker is active.
struct ActiveUpdateGuard(Arc<Mutex<ActiveUpdate>>);

impl Drop for ActiveUpdateGuard {
    fn drop(&mut self) {
        *self.0.lock().unwrap_or_else(|error| error.into_inner()) = ActiveUpdate::default();
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub version: String,
    pub notify: bool,
    pub date: Option<String>,
    pub body: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInstallResult {
    pub status: String,
    pub message: Option<String>,
}

/// Consume the shared app/installer record; corrupt state remains available for diagnosis.
#[tauri::command]
pub fn consume_app_update_result(app: AppHandle) -> Option<AppUpdateInstallResult> {
    #[cfg(windows)]
    {
        let dir = crate::runtime_state::windows_state_dir().ok()?;
        return match flowix_installer_helper::update_result::consume(
            &dir,
            &app.package_info().version.to_string(),
        ) {
            Ok(result) => result.map(|r| AppUpdateInstallResult {
                status: r.status,
                message: r.message,
            }),
            Err(error) => {
                tracing::warn!("cannot consume application update result: {error}");
                None
            }
        };
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        None
    }
}

fn write_pending_app_update_result(version: &str, attempt_id: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        let dir = crate::runtime_state::windows_state_dir()?;
        flowix_installer_helper::update_result::begin(&dir, version, attempt_id)
            .map_err(|e| format!("failed to persist update state: {e}"))?;
    }
    let _ = (version, attempt_id);
    Ok(())
}

fn write_failed_app_update_result(
    version: &str,
    attempt_id: &str,
    message: &str,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let dir = crate::runtime_state::windows_state_dir()?;
        flowix_installer_helper::update_result::finish(
            &dir,
            version,
            Some(attempt_id),
            flowix_installer_helper::update_result::Status::Failed,
            message,
        )
        .map_err(|e| format!("failed to persist update result: {e}"))?;
    }
    let _ = (version, attempt_id, message);
    Ok(())
}

fn updater(
    app: &AppHandle,
    attempt_id: Option<&str>,
) -> Result<tauri_plugin_updater::Updater, String> {
    let endpoint = match std::env::consts::OS {
        "macos" => "https://download.flowix.cc/updater/macos/latest.json",
        "windows" => "https://download.flowix.cc/updater/windows/latest.json",
        "linux" => "https://download.flowix.cc/updater/linux/latest.json",
        platform => return Err(format!("unsupported updater platform: {platform}")),
    };
    let endpoint = url::Url::parse(endpoint)
        .map_err(|error| format!("failed to parse updater endpoint: {error}"))?;
    app.updater_builder()
        .installer_args(attempt_id.map(|id| format!("/FLOWIXATTEMPT={id}")))
        .timeout(std::time::Duration::from_secs(30))
        .endpoints(vec![endpoint])
        .map_err(|error| format!("failed to configure updater endpoint: {error}"))?
        .build()
        .map_err(|error| format!("failed to initialize updater: {error}"))
}

fn update_info(update: &Update) -> AppUpdateInfo {
    AppUpdateInfo {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        // Unknown manifest fields are preserved by tauri-plugin-updater in
        // raw_json. Keep notifications enabled for older manifests.
        notify: update
            .raw_json
            .get("notify")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
        date: update.date.as_ref().map(|date| date.to_string()),
        body: update.body.clone(),
    }
}

fn update_is_newer_than_current(update: &Update) -> Result<bool, String> {
    let version = semver::Version::parse(&update.version).map_err(|error| {
        format!(
            "invalid application update version {}: {error}",
            update.version
        )
    })?;
    let current_version = semver::Version::parse(&update.current_version).map_err(|error| {
        format!(
            "invalid current application version {}: {error}",
            update.current_version
        )
    })?;
    Ok(version > current_version)
}

fn ensure_update_is_idle(state: &AppUpdateState) -> Result<(), String> {
    let active = state
        .active
        .lock()
        .map_err(|_| "application update state is unavailable".to_string())?;
    if active.phase == UpdatePhase::Idle {
        Ok(())
    } else {
        Err("an application update is already in progress".to_string())
    }
}

async fn download_requested_update(
    app: &AppHandle,
    prepared_state: &Arc<Mutex<Option<PreparedUpdate>>>,
    version: &str,
) -> Result<VerifiedUpdate, String> {
    let attempt_id = uuid::Uuid::new_v4().to_string();
    let update = updater(app, Some(&attempt_id))?
        .check()
        .await
        .map_err(|error| format!("failed to check for update: {error}"))?
        .ok_or_else(|| "no application update is available".to_string())?;
    if !update_is_newer_than_current(&update)? {
        return Err(format!(
            "requested update {version} is not newer than the current application version"
        ));
    }
    if update.version != version {
        return Err(format!("requested update {version} is no longer available"));
    }

    let package = prepare_update_package(app, update, true, attempt_id).await?;
    *prepared_state
        .lock()
        .map_err(|_| "application update state is unavailable".to_string())? =
        Some(package.prepared());
    Ok(package)
}

#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    state: State<'_, AppUpdateState>,
) -> Result<Option<AppUpdateInfo>, String> {
    ensure_update_is_idle(state.inner())?;
    let _check_guard = state.check_lock.lock().await;
    ensure_update_is_idle(state.inner())?;

    let update = updater(&app, None)?
        .check()
        .await
        .map_err(|error| format!("failed to check for update: {error}"))?;
    let Some(update) = update else {
        *state
            .prepared
            .lock()
            .map_err(|_| "application update state is unavailable".to_string())? = None;
        return Ok(None);
    };

    if !update_is_newer_than_current(&update)? {
        *state
            .prepared
            .lock()
            .map_err(|_| "application update state is unavailable".to_string())? = None;
        return Ok(None);
    }

    Ok(Some(update_info(&update)))
}

/// Download and verify without installing or restarting the application.
#[tauri::command]
pub async fn download_app_update(
    app: AppHandle,
    version: String,
    state: State<'_, AppUpdateState>,
) -> Result<(), String> {
    let (abort_handle, abort_registration) = AbortHandle::new_pair();
    {
        let mut active = state
            .active
            .lock()
            .map_err(|_| "application update state is unavailable".to_string())?;
        if !active.phase.start() {
            return Err("an application update is already in progress".to_string());
        }
        active.abort = Some(abort_handle);
    }
    let _guard = ActiveUpdateGuard(state.active.clone());
    let task = async {
        let _check_guard = state.check_lock.lock().await;
        download_requested_update(&app, &state.prepared, &version).await?;
        Ok::<_, String>(())
    };
    Abortable::new(task, abort_registration)
        .await
        .map_err(|_| "application update cancelled".to_string())?
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    version: String,
    state: State<'_, AppUpdateState>,
) -> Result<(), String> {
    let (abort_handle, abort_registration) = AbortHandle::new_pair();
    {
        let mut active = state
            .active
            .lock()
            .map_err(|_| "application update state is unavailable".to_string())?;
        if !active.phase.start() {
            return Err("an application update is already in progress".to_string());
        }
        active.abort = Some(abort_handle);
    }
    let active_guard = ActiveUpdateGuard(state.active.clone());

    let download_app = app.clone();
    let check_lock = state.check_lock.clone();
    let prepared_state = state.prepared.clone();
    let task = async move {
        let package = {
            let _check_guard = check_lock.lock().await;
            let prepared = prepared_state
                .lock()
                .map_err(|_| "application update state is unavailable".to_string())?
                .clone()
                .filter(|prepared| prepared.version() == version);

            let cached = match prepared {
                Some(prepared) => prepared.read_verified(&download_app).await.ok(),
                None => None,
            };
            match cached {
                Some(package) => package,
                None => {
                    *prepared_state
                        .lock()
                        .map_err(|_| "application update state is unavailable".to_string())? = None;
                    download_requested_update(&download_app, &prepared_state, &version).await?
                }
            }
        };

        #[cfg(windows)]
        let document_guard =
            crate::commands::window_shutdown::prepare_for_update(&download_app).await?;
        #[cfg(not(windows))]
        let document_guard = ();
        Ok::<_, String>((package, document_guard))
    };

    let (package, document_guard) = Abortable::new(task, abort_registration)
        .await
        .map_err(|_| "application update cancelled".to_string())??;
    {
        let mut active = state
            .active
            .lock()
            .map_err(|_| "application update state is unavailable".to_string())?;
        // The cancel command uses this same mutex. A cancellation that won
        // just after the handshake must still prevent runtime teardown.
        if !active.phase.begin_install() {
            return Err("application update cancelled".to_string());
        }
        active.abort = None;
    }
    let _ = app.emit(
        "app-update-progress",
        json!({ "phase": "installing", "downloadedBytes": package.len() }),
    );

    tauri::async_runtime::spawn_blocking(move || {
        let _active_guard = active_guard;
        let _document_guard = document_guard;
        // Persist before teardown so a filesystem error leaves runtimes usable.
        let version = package.version().to_string();
        let attempt_id = package.attempt_id().to_string();
        write_pending_app_update_result(&version, &attempt_id)?;
        #[cfg(windows)]
        let _runtime_guard = crate::app::bootstrap::prepare_for_update(&app);
        match package.install() {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = write_failed_app_update_result(&version, &attempt_id, &error);
                Err(error)
            }
        }
    })
    .await
    .map_err(|error| format!("failed to prepare or install Flowix update: {error}"))?
}

#[tauri::command]
pub fn cancel_app_update(state: State<'_, AppUpdateState>) -> Result<bool, String> {
    let mut active = state
        .active
        .lock()
        .map_err(|_| "application update state is unavailable".to_string())?;
    if active.phase.cancel() {
        if let Some(handle) = active.abort.as_ref() {
            handle.abort();
        }
        return Ok(true);
    }
    Ok(false)
}
