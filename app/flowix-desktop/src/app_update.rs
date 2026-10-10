use futures::future::{AbortHandle, Abortable};
use serde_json::json;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::UpdaterExt;

#[cfg(target_os = "windows")]
use std::fs::OpenOptions;
#[cfg(target_os = "windows")]
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::time::Duration;

#[derive(Default)]
pub struct AppUpdateState {
    active_download: Mutex<Option<AbortHandle>>,
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

/// Read and clear the result left by a quiet Windows NSIS update.
#[tauri::command]
pub fn consume_app_update_result(app: AppHandle) -> Option<AppUpdateInstallResult> {
    #[cfg(target_os = "windows")]
    {
        let path = app_update_result_path()?;
        let content = std::fs::read_to_string(&path).ok()?;
        let target_path = app_update_target_path()?;
        let target_version = std::fs::read_to_string(&target_path)
            .ok()
            .map(|value| value.trim().to_string());
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(target_path);
        let (status, message) = content.trim().split_once('|')?;
        let current_version = app.package_info().version.to_string();
        return match status {
            "success" if target_version.as_deref() == Some(current_version.as_str()) => {
                Some(AppUpdateInstallResult {
                    status: "success".to_string(),
                    message: None,
                })
            }
            "success" => Some(AppUpdateInstallResult {
                status: "failed".to_string(),
                message: Some(format!(
                    "Installer reported success for {}, but Flowix started as {current_version}.",
                    target_version.as_deref().unwrap_or("the requested version")
                )),
            }),
            "failed" => Some(AppUpdateInstallResult {
                status: "failed".to_string(),
                message: (!message.is_empty()).then(|| message.to_string()),
            }),
            "pending" => Some(AppUpdateInstallResult {
                status: "failed".to_string(),
                message: Some(format!(
                    "Installer did not report a completed update to {message}; Flowix started as {current_version}."
                )),
            }),
            _ => None,
        };
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        None
    }
}

#[cfg(target_os = "windows")]
fn app_update_result_path() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|path| path.join("Flowix").join("app-update-result.txt"))
}

#[cfg(target_os = "windows")]
fn app_update_target_path() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|path| path.join("Flowix").join("app-update-target.txt"))
}

#[cfg(target_os = "windows")]
fn write_pending_app_update_result(version: &str) -> Result<(), String> {
    let target_path =
        app_update_target_path().ok_or_else(|| "LOCALAPPDATA is unavailable".to_string())?;
    let parent = target_path
        .parent()
        .ok_or_else(|| "update target path has no parent directory".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create update target directory: {error}"))?;
    std::fs::write(target_path, version)
        .map_err(|error| format!("failed to persist update target version: {error}"))?;
    write_app_update_result("pending", version)
}

#[cfg(target_os = "windows")]
fn write_app_update_result(status: &str, message: &str) -> Result<(), String> {
    let path = app_update_result_path().ok_or_else(|| "LOCALAPPDATA is unavailable".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "update result path has no parent directory".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create update result directory: {error}"))?;
    std::fs::write(path, format!("{status}|{message}\n"))
        .map_err(|error| format!("failed to persist update result: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn write_pending_app_update_result(_version: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn write_app_update_result(_status: &str, _message: &str) -> Result<(), String> {
    Ok(())
}

fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let endpoint = match std::env::consts::OS {
        "macos" => "https://download.flowix.cc/updater/macos/latest.json",
        "windows" => "https://download.flowix.cc/updater/windows/latest.json",
        "linux" => "https://download.flowix.cc/updater/linux/latest.json",
        platform => return Err(format!("unsupported updater platform: {platform}")),
    };
    let endpoint = url::Url::parse(endpoint)
        .map_err(|error| format!("failed to parse updater endpoint: {error}"))?;
    app.updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| format!("failed to configure updater endpoint: {error}"))?
        .build()
        .map_err(|error| format!("failed to initialize updater: {error}"))
}

#[tauri::command]
pub async fn check_app_update(app: AppHandle) -> Result<Option<AppUpdateInfo>, String> {
    let update = updater(&app)?
        .check()
        .await
        .map_err(|error| format!("failed to check for update: {error}"))?;
    Ok(update.map(|update| AppUpdateInfo {
        current_version: update.current_version,
        version: update.version,
        // Unknown manifest fields are preserved by tauri-plugin-updater in
        // raw_json. Keep notifications enabled for older manifests.
        notify: update
            .raw_json
            .get("notify")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
        date: update.date.map(|date| date.to_string()),
        body: update.body,
    }))
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    state: State<'_, AppUpdateState>,
) -> Result<(), String> {
    {
        let active = state
            .active_download
            .lock()
            .map_err(|_| "application update state is unavailable".to_string())?;
        if active.is_some() {
            return Err("an application update is already downloading".to_string());
        }
    }

    let update = updater(&app)?
        .check()
        .await
        .map_err(|error| format!("failed to check for update: {error}"))?
        .ok_or_else(|| "no application update is available".to_string())?;
    let target_version = update.version.clone();

    let (abort_handle, abort_registration) = AbortHandle::new_pair();
    {
        let mut active = state
            .active_download
            .lock()
            .map_err(|_| "application update state is unavailable".to_string())?;
        if active.is_some() {
            return Err("an application update is already downloading".to_string());
        }
        *active = Some(abort_handle);
    }

    let download_app = app.clone();
    let downloaded_bytes = Arc::new(AtomicU64::new(0));
    let started = Arc::new(AtomicBool::new(false));
    let task = async move {
        let progress_bytes = downloaded_bytes.clone();
        let progress_started = started.clone();
        let bytes = update
            .download(
                |chunk_length, content_length| {
                    if !progress_started.swap(true, Ordering::Relaxed) {
                        let _ = download_app.emit(
                            "app-update-progress",
                            json!({
                                "phase": "started",
                                "contentLength": content_length,
                            }),
                        );
                    }
                    let downloaded = progress_bytes
                        .fetch_add(chunk_length as u64, Ordering::Relaxed)
                        + chunk_length as u64;
                    let _ = download_app.emit(
                        "app-update-progress",
                        json!({
                            "phase": "progress",
                            "downloadedBytes": downloaded,
                            "contentLength": content_length,
                        }),
                    );
                },
                || {
                    let _ = download_app.emit(
                        "app-update-progress",
                        json!({
                            "phase": "finished",
                            "downloadedBytes": progress_bytes.load(Ordering::Relaxed),
                        }),
                    );
                },
            )
            .await
            .map_err(|error| format!("failed to download update: {error}"))?;

        let _ = download_app.emit(
            "app-update-progress",
            json!({
                "phase": "installing",
                "downloadedBytes": progress_bytes.load(Ordering::Relaxed),
            }),
        );
        let _cli_update_guard = prepare_cli_for_update(&target_version)?;
        write_pending_app_update_result(&target_version)?;
        match update.install(bytes) {
            Ok(()) => Ok(()),
            Err(error) => {
                let message = format!("failed to install update: {error}");
                let _ = write_app_update_result("failed", &message);
                Err(message)
            }
        }
    };

    let result = Abortable::new(task, abort_registration).await;
    if let Ok(mut active) = state.active_download.lock() {
        *active = None;
    }

    match result {
        Ok(result) => result,
        Err(_) => Err("application update cancelled".to_string()),
    }
}

/// Prevent the bundled product CLI from keeping the NSIS update payload locked.
///
/// Windows does not allow the installer to replace an executable while another
/// process has it open. `flowix-cli` is intentionally a product-owned process,
/// so the updater closes only instances whose full executable path matches the
/// CLI next to the current Flowix executable. It never kills by image name.
struct CliUpdateGuard {
    #[cfg(target_os = "windows")]
    _update_lock: UpdateLock,
}

fn prepare_cli_for_update(target_version: &str) -> Result<CliUpdateGuard, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = target_version;
        return Ok(CliUpdateGuard {});
    }

    #[cfg(target_os = "windows")]
    {
        let update_lock = acquire_update_lock()?;
        let cli_path = current_cli_path()?;
        let log_dir = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| "LOCALAPPDATA is unavailable".to_string())?
            .join("Flowix");
        std::fs::create_dir_all(&log_dir)
            .map_err(|error| format!("failed to create update log directory: {error}"))?;
        flowix_installer_helper::log(
            &log_dir.join("app-update.log"),
            &format!(
                "installer-check-start version={target_version} source=app-updater target={}",
                cli_path.display()
            ),
        );
        flowix_installer_helper::close_target_cli(
            &cli_path,
            Duration::from_secs(10),
            Duration::from_millis(200),
            &log_dir.join("app-update.log"),
        )
        .map_err(|error| format!("failed to prepare Flowix CLI for update: {error:?}"))?;
        Ok(CliUpdateGuard {
            _update_lock: update_lock,
        })
    }
}

#[cfg(target_os = "windows")]
struct UpdateLock {
    _file: std::fs::File,
}

#[cfg(target_os = "windows")]
fn acquire_update_lock() -> Result<UpdateLock, String> {
    let dir = dirs::data_local_dir()
        .ok_or_else(|| "LOCALAPPDATA is unavailable".to_string())?
        .join("Flowix");
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create update lock directory: {error}"))?;
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(dir.join("update.lock"))
        .map_err(|error| format!("failed to open update lock: {error}"))?;
    fs2::FileExt::try_lock_exclusive(&file)
        .map_err(|_| "another Flowix update is already in progress".to_string())?;
    Ok(UpdateLock { _file: file })
}

#[cfg(target_os = "windows")]
fn current_cli_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe()
        .map_err(|error| format!("failed to resolve Flowix executable: {error}"))?;
    let parent = exe
        .parent()
        .ok_or_else(|| "Flowix executable has no parent directory".to_string())?;
    Ok(parent.join("flowix-cli.exe"))
}

#[tauri::command]
pub fn cancel_app_update(state: State<'_, AppUpdateState>) -> Result<bool, String> {
    let active = state
        .active_download
        .lock()
        .map_err(|_| "application update state is unavailable".to_string())?;
    if let Some(handle) = active.as_ref() {
        handle.abort();
        return Ok(true);
    }
    Ok(false)
}
