//! DSH discovery and Flowix plugin integration commands.

use crate::app::state::AppState;
use crate::events as dispatcher;
use std::path::PathBuf;
use tauri::State;

pub const DSH_RUNTIME_STATUS_CHANGED_EVENT: &str = "dsh-runtime-status-changed";

fn emit_runtime_status(app: &tauri::AppHandle, status: &crate::dsh::DshStatus) {
    let _ = dispatcher::emit_to(app, DSH_RUNTIME_STATUS_CHANGED_EVENT, status);
}

#[tauri::command]
pub fn dsh_status(state: State<'_, AppState>) -> crate::dsh::DshStatus {
    let selected = state
        .user_config
        .get_preference()
        .dsh_cli_path
        .map(PathBuf::from);
    crate::dsh::set_user_selected_cli(selected);
    crate::dsh::status()
}

#[tauri::command]
pub async fn dsh_select_cli_path(app: tauri::AppHandle) -> Option<String> {
    use std::sync::mpsc;
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = mpsc::channel();
    let handle = app.clone();
    tokio::task::spawn_blocking(move || {
        let result = handle
            .dialog()
            .file()
            .set_title("Select DSH executable")
            .blocking_pick_file()
            .map(|path| path.to_string());
        let _ = tx.send(result);
    });
    rx.recv().ok().flatten()
}

#[tauri::command]
pub fn dsh_set_cli_path(
    path: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<crate::dsh::DshStatus, String> {
    let path = PathBuf::from(path);
    if !crate::dsh::is_valid_cli_path(&path) {
        return Err("所选路径不是可执行的 DSH CLI".to_string());
    }
    state
        .user_config
        .patch_preference(serde_json::json!({"dshCliPath": path.to_string_lossy()}))
        .map_err(|error| error.to_string())?;
    crate::dsh::set_user_selected_cli(Some(path));
    let status = crate::dsh::status();
    emit_runtime_status(&app, &status);
    Ok(status)
}

/// Install the Flowix App Server profile after the user requests it from
/// Preferences. Runtime discovery at startup is read-only and never installs.
#[tauri::command]
pub async fn dsh_install_appserver_profile(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<crate::dsh::DshStatus, String> {
    state
        .deepseek_harness
        .ensure_hosts_replaceable()
        .await
        .map_err(|error| format!("stop DSH before installing App Server: {error}"))?;
    state.deepseek_harness.invalidate_hosts().await?;
    let install_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::dsh::install_appserver_profile(&install_app)
    })
    .await
    .map_err(|error| format!("DSH App Server installer task failed: {error}"))??;
    if let Err(error) = state.deepseek_harness.dsh_model_configs().await {
        let _ = state.deepseek_harness.invalidate_hosts().await;
        return Err(format!("DSH App Server 安装后连接检查失败：{error}"));
    }
    let status = crate::dsh::status();
    emit_runtime_status(&app, &status);
    Ok(status)
}

#[tauri::command]
pub async fn dsh_manage_profile_plugin(
    action: String,
    package: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.deepseek_harness.invalidate_hosts().await?;
    // Materialize the Flowix-owned profile bundles before the official CLI
    // sees this profile. Otherwise upstream initializes an unknown profile
    // without the Flowix bridge and independent memory bundle.
    state.deepseek_harness.plugin_catalog().await?;
    state.deepseek_harness.invalidate_hosts().await?;
    let dsh_home = state.user_config.dsh_dir();
    tauri::async_runtime::spawn_blocking(move || {
        crate::dsh::run_profile_plugin(&dsh_home, &action, package.as_deref())
    })
    .await
    .map_err(|error| format!("DSH plugin task failed: {error}"))?
}
