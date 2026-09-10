use std::path::Path;

use serde_json::Value;
use tauri::State;

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
    let folder = root.join(".agents").join("skills").join(&name);
    std::fs::create_dir_all(&folder)
        .map_err(|e| format!("failed to create project Skill folder: {e}"))?;
    if !crate::config::path_is_inside(&folder, root) {
        return Err("project Skill folder resolves outside the notebook".to_string());
    }
    if folder.join("SKILL.md").exists() {
        return Err("a project Skill with this name already exists".to_string());
    }
    let yaml_description = serde_json::to_string(&description).map_err(|e| e.to_string())?;
    let content = format!(
        "---\nname: {name}\ndescription: {yaml_description}\n---\n\n{}\n",
        instructions.trim()
    );
    std::fs::write(folder.join("SKILL.md"), content)
        .map_err(|e| format!("failed to write project Skill: {e}"))?;
    Ok(serde_json::json!({ "path": folder.join("SKILL.md") }))
}
