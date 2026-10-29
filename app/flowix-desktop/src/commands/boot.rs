use serde::Serialize;
use std::sync::Arc;
use tauri::{Manager, State};

use crate::app::startup::{StartupPhase, StartupStatus};
use crate::app::state::AppState;
use crate::device_registration::DeviceRegistry;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootFeatures {
    pub experimental: bool,
    pub is_introduct_displayed: bool,
}

#[tauri::command]
pub fn get_boot_features(registry: State<'_, Arc<DeviceRegistry>>) -> BootFeatures {
    BootFeatures {
        experimental: registry.experimental(),
        is_introduct_displayed: registry.is_introduct_displayed(),
    }
}

#[tauri::command]
pub fn set_boot_intro_displayed(registry: State<'_, Arc<DeviceRegistry>>) -> Result<(), String> {
    registry.set_introduct_displayed(true)
}

#[tauri::command]
pub fn get_version_initialization_completed(
    registry: State<'_, Arc<DeviceRegistry>>,
) -> Result<bool, String> {
    if !crate::commands::product::is_dev_build() {
        return Err(
            "version initialization settings are only available in a development build".to_string(),
        );
    }
    Ok(registry.is_version_initialization_complete())
}

#[tauri::command]
pub fn set_version_initialization_completed(
    completed: bool,
    registry: State<'_, Arc<DeviceRegistry>>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !crate::commands::product::is_dev_build() {
        return Err(
            "version initialization settings are only available in a development build".to_string(),
        );
    }
    if matches!(
        state.startup.status().phase,
        StartupPhase::Pending | StartupPhase::Running
    ) {
        return Err("version initialization cannot be edited while startup is running".to_string());
    }
    registry.set_version_initialization_completed(completed)
}

#[tauri::command]
pub fn get_startup_status(state: State<'_, AppState>) -> StartupStatus {
    state.startup.status()
}

#[tauri::command]
pub async fn wait_for_startup_status_change(
    previous: StartupStatus,
    app: tauri::AppHandle,
) -> StartupStatus {
    let startup = app.state::<AppState>().startup.clone();
    tauri::async_runtime::spawn_blocking(move || {
        startup.wait_for_status_change(&previous, std::time::Duration::from_secs(10))
    })
    .await
    .unwrap_or_else(|error| {
        tracing::warn!("startup status wait task failed: {error}");
        app.state::<AppState>().startup.status()
    })
}

#[tauri::command]
pub fn get_startup_notebook_id(state: State<'_, AppState>) -> Option<String> {
    crate::lock_utils::read_lock(&state.memo_file, "memo_file").current_notebook_id_value()
}

#[tauri::command]
pub fn notify_startup_interactive(state: State<'_, AppState>) {
    state.startup.mark_interactive();
}

#[tauri::command]
pub fn record_startup_stage(
    state: State<'_, AppState>,
    stage: String,
    frontend_elapsed_ms: u64,
    startup_attempt_id: String,
) {
    const ALLOWED: &[&str] = &[
        "native-ready",
        "notebook-selected",
        "first-workspace-paint",
        "stage3-admitted",
        "workspace-restore-settled",
        "workspace-restore-superseded",
        "foreground-degraded-paint",
        "foreground-failed-paint",
    ];
    // Keep task-event identifiers bounded; task IDs contain only ASCII letters
    // and separators.
    let task_event = stage.starts_with("task:")
        && stage.len() <= 96
        && stage
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b))
        && [":start", ":complete", ":failed"]
            .iter()
            .any(|suffix| stage.ends_with(*suffix));
    if !ALLOWED.contains(&stage.as_str()) && !task_event {
        return;
    }
    if startup_attempt_id.len() > 64 || !startup_attempt_id.is_ascii() {
        return;
    }
    crate::runtime_log::record_event(
        "info",
        "startup.stage",
        serde_json::json!({
            "stage": stage,
            "source": "frontend",
            "elapsedMs": state.startup.elapsed_ms(),
            "frontendElapsedMs": frontend_elapsed_ms,
            "startupAttemptId": startup_attempt_id,
        })
        .to_string(),
    );
}

/// Persist an uncaught frontend error into the app log.
///
/// The WebView console is not captured anywhere, so an unhandled rejection or a
/// window error would otherwise leave no trace behind (`GlobalErrorToaster`
/// only turns it into a generic toast). Callers already have a fallback UI or a
/// toast; this is the diagnostic channel that makes the failure nameable.
#[tauri::command]
pub fn record_frontend_error(kind: String, message: String, stack: Option<String>) {
    if !matches!(kind.as_str(), "error" | "rejection" | "boundary") {
        return;
    }
    let clamped = |value: &str, max: usize| value.chars().take(max).collect::<String>();
    crate::runtime_log::record_event(
        "error",
        "frontend.uncaught",
        serde_json::json!({
            "kind": kind,
            "message": clamped(&message, 400),
            "stack": clamped(stack.as_deref().unwrap_or_default(), 2000),
        })
        .to_string(),
    );
}

#[tauri::command]
pub async fn wait_for_startup_ready(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().startup.wait_until_ready())
        .await
        .map_err(|error| format!("startup wait task failed: {error}"))?
}

#[tauri::command]
pub fn retry_startup(state: State<'_, AppState>) -> Result<(), String> {
    state.startup.request_retry()
}
