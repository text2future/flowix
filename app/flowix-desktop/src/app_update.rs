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
use std::path::{Path, PathBuf};
#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

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
        let _cli_update_guard = prepare_cli_for_update()?;
        update
            .install(bytes)
            .map_err(|error| format!("failed to install update: {error}"))
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

fn prepare_cli_for_update() -> Result<CliUpdateGuard, String> {
    #[cfg(not(target_os = "windows"))]
    {
        return Ok(CliUpdateGuard {});
    }

    #[cfg(target_os = "windows")]
    {
        let update_lock = acquire_update_lock()?;
        let cli_path = current_cli_path()?;
        let pids = matching_cli_processes(&cli_path)?;

        for pid in pids {
            terminate_process(pid)?;
        }

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let remaining = matching_cli_processes(&cli_path)?;
            if remaining.is_empty() {
                return Ok(CliUpdateGuard {
                    _update_lock: update_lock,
                });
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "cannot update while flowix-cli is still running (pid: {})",
                    remaining
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
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

#[cfg(target_os = "windows")]
fn matching_cli_processes(target: &Path) -> Result<Vec<u32>, String> {
    use windows::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };

    let target = normalize_path(target);
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
        .map_err(|error| format!("failed to enumerate processes: {error}"))?;
    if snapshot == INVALID_HANDLE_VALUE {
        return Err("failed to create process snapshot".to_string());
    }

    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut result = Vec::new();
    let mut has_entry = unsafe { Process32FirstW(snapshot, &mut entry).is_ok() };
    while has_entry {
        let pid = entry.th32ProcessID;
        if pid != 0 {
            let access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;
            if let Ok(process) = unsafe { OpenProcess(access, false, pid) } {
                let mut buffer = vec![0u16; 32_768];
                let mut length = buffer.len() as u32;
                let matches = unsafe {
                    QueryFullProcessImageNameW(
                        process,
                        PROCESS_NAME_FORMAT(0),
                        windows::core::PWSTR(buffer.as_mut_ptr()),
                        &mut length,
                    )
                    .is_ok()
                } && normalize_path(Path::new(&String::from_utf16_lossy(
                    &buffer[..length as usize],
                ))) == target;
                unsafe {
                    let _ = CloseHandle(process);
                }
                if matches {
                    result.push(pid);
                }
            }
        }
        has_entry = unsafe { Process32NextW(snapshot, &mut entry).is_ok() };
    }
    unsafe {
        let _ = CloseHandle(snapshot);
    }
    Ok(result)
}

#[cfg(target_os = "windows")]
fn terminate_process(pid: u32) -> Result<(), String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    let access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE;
    let process = unsafe { OpenProcess(access, false, pid) }
        .map_err(|error| format!("failed to open flowix-cli process {pid}: {error}"))?;
    let terminated = unsafe { TerminateProcess(process, 1).is_ok() };
    if !terminated {
        unsafe {
            let _ = CloseHandle(process);
        }
        return Err(format!("failed to terminate flowix-cli process {pid}"));
    }
    unsafe { WaitForSingleObject(process, 5_000) };
    unsafe {
        let _ = CloseHandle(process);
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn normalize_path(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
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
