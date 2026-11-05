use serde_json::Value;
use std::path::Path;
use tauri::State;

use super::skill_package::*;

use crate::commands::helpers::is_registered_notebook_root;
/// Return Codex metadata resolved for a registered notebook root.
#[tauri::command]
pub async fn codex_project_capabilities(
    cwd: String,
    force_reload: Option<bool>,
    state: State<'_, crate::app::state::AppState>,
) -> Result<Value, String> {
    let path = Path::new(&cwd);
    if !is_registered_notebook_root(path, &state) {
        return Err("Codex project must be a registered notebook".to_string());
    }
    state
        .codex_app_server
        .project_capabilities(path, force_reload.unwrap_or(false))
        .await
}

#[tauri::command]
pub async fn codex_project_skills(
    cwd: String,
    force_reload: Option<bool>,
    state: State<'_, crate::app::state::AppState>,
) -> Result<Value, String> {
    let path = registered_root(&cwd, &state)?;
    state
        .codex_app_server
        .project_skills(path, force_reload.unwrap_or(false))
        .await
}

fn registered_root<'a>(
    cwd: &'a str,
    state: &State<'_, crate::app::state::AppState>,
) -> Result<&'a Path, String> {
    let path = Path::new(cwd);
    if !is_registered_notebook_root(path, state) {
        return Err("Codex project must be a registered notebook".to_string());
    }
    Ok(path)
}

#[tauri::command]
pub async fn codex_project_config_write(
    cwd: String,
    edits: Value,
    expected_version: Option<String>,
    state: State<'_, crate::app::state::AppState>,
) -> Result<Value, String> {
    let path = registered_root(&cwd, &state)?;
    state
        .codex_app_server
        .write_project_config(path, edits, expected_version)
        .await
}

#[tauri::command]
pub async fn codex_skill_enabled_set(
    cwd: String,
    name: String,
    enabled: bool,
    state: State<'_, crate::app::state::AppState>,
) -> Result<Value, String> {
    registered_root(&cwd, &state)?;
    state
        .codex_app_server
        .set_skill_enabled(&name, enabled)
        .await
}

#[tauri::command]
pub async fn codex_plugin_installed_set(
    cwd: String,
    plugin_id: String,
    installed: bool,
    state: State<'_, crate::app::state::AppState>,
) -> Result<Value, String> {
    registered_root(&cwd, &state)?;
    state
        .codex_app_server
        .set_plugin_installed(&plugin_id, installed)
        .await
}

#[tauri::command]
pub async fn codex_mcp_reload(
    cwd: String,
    state: State<'_, crate::app::state::AppState>,
) -> Result<Value, String> {
    registered_root(&cwd, &state)?;
    state.codex_app_server.reload_mcp_servers().await
}

#[tauri::command]
pub async fn codex_project_mcp_upsert(
    cwd: String,
    name: String,
    definition: Value,
    expected_version: Option<String>,
    state: State<'_, crate::app::state::AppState>,
) -> Result<Value, String> {
    let path = registered_root(&cwd, &state)?;
    state
        .codex_app_server
        .upsert_project_mcp(path, &name, definition, expected_version)
        .await
}

#[tauri::command]
pub async fn codex_project_skill_write(
    cwd: String,
    name: String,
    description: String,
    instructions: String,
    display_name: Option<String>,
    skill_markdown: Option<String>,
    files: Option<Vec<ProjectSkillResourceFile>>,
    state: State<'_, crate::app::state::AppState>,
) -> Result<Value, String> {
    let root = registered_root(&cwd, &state)?;
    if name.is_empty()
        || name.len() > 64
        || !name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err("Skill name must use lowercase letters, numbers and '-'".to_string());
    }
    if description.len() > 500 || instructions.is_empty() || instructions.len() > 100_000 {
        return Err("Skill description or instructions exceed the allowed size".to_string());
    }
    let display_name = display_name.unwrap_or_else(|| name.clone());
    if display_name.trim().is_empty() || display_name.len() > 200 {
        return Err("Skill display name is invalid".to_string());
    }
    let content = if let Some(markdown) = skill_markdown {
        validate_source_skill_markdown(&name, &markdown)?;
        markdown
    } else {
        let yaml_description = serde_json::to_string(&description).map_err(|e| e.to_string())?;
        let yaml_display_name = serde_json::to_string(&display_name).map_err(|e| e.to_string())?;
        format!(
            "---\nname: {name}\ndisplay-name: {yaml_display_name}\ndescription: {yaml_description}\n---\n\n{}\n",
            instructions.trim()
        )
    };
    let resources = decode_skill_resources(files.unwrap_or_default())?;
    let path = write_project_skill_bundle(root, &name, &content, &resources)?;
    Ok(serde_json::json!({ "path": path }))
}

#[tauri::command]
pub async fn codex_project_skill_install_zip(
    cwd: String,
    name: String,
    archive: ProjectSkillArchive,
    state: State<'_, crate::app::state::AppState>,
) -> Result<Value, crate::commands::market_package::MarketInstallError> {
    let root = registered_root(&cwd, &state)?.to_path_buf();
    let url = validate_skill_archive_request(&name, &archive)?;
    let bytes =
        crate::commands::market_package::download_market_zip(url, MAX_SKILL_PACKAGE_BYTES).await?;
    let path = tokio::task::spawn_blocking(move || {
        install_project_skill_zip(&root, &name, &bytes, &archive)
    })
    .await
    .map_err(|error| format!("Skill ZIP installation failed: {error}"))??;
    Ok(serde_json::json!({ "path": path }))
}
