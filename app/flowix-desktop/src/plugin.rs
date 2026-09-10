//! Declaration-driven plugin discovery and artifact handling.
//!
//! Plugins are intentionally hosted by Flowix in the first phase. A plugin
//! can describe its UI and output format, but it cannot execute arbitrary
//! code. This keeps `~/.flowix/plugin/` safe to scan while leaving room for a
//! sandboxed runtime later.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Emitter;

use crate::app::paths::get_user_config_dir;
use crate::config::path_is_inside;
use crate::lock_utils::read_lock;

mod artifact;
mod lifecycle;
mod manifest;

use artifact::{
    artifact_document, output_file_path, parse_plugin_output, pointer_document,
    PluginArtifactPointer, PluginNoteFrontmatter,
};
#[cfg(test)]
use artifact::{clean_markdown, parse_html, parse_json, parse_mindmap_markdown};
pub(crate) use lifecycle::PluginRunCoordinator;
use manifest::{validate_manifest, PluginDefinition, PluginManifest, PluginParser, PluginRuntime};

const MINDMAP_MANIFEST: &str = flowix_plugin_runtime::MINDMAP_MANIFEST;
const MINDMAP_SKILL: &str = flowix_plugin_runtime::MINDMAP_SKILL;
const WEBPAGE_MANIFEST: &str = flowix_plugin_runtime::WEBPAGE_MANIFEST;
const WEBPAGE_SKILL: &str = flowix_plugin_runtime::WEBPAGE_SKILL;

fn is_builtin_plugin_id(id: &str) -> bool {
    matches!(id, "mindmap" | "webpage")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDescriptor {
    pub manifest: PluginManifest,
    pub installed_path: String,
    pub skill: String,
    pub is_system: bool,
    pub enabled: bool,
    pub permissions: Vec<String>,
    pub integrity_status: String,
    #[serde(skip)]
    definition: PluginDefinition,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDiagnostic {
    pub plugin_id: Option<String>,
    pub path: String,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalogSnapshot {
    pub plugins: Vec<PluginDescriptor>,
    pub diagnostics: Vec<PluginDiagnostic>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct PluginStateFile {
    #[serde(default)]
    disabled: HashSet<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginArtifact {
    pub plugin_id: String,
    pub path: String,
    pub name: String,
    pub created_at: String,
    pub format: String,
    pub renderer: String,
    pub content: Option<String>,
    pub note_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRunStarted {
    pub run_id: String,
    pub prepared_prompt: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRunEvent {
    pub run_id: String,
    pub plugin_id: String,
    pub status: String,
    pub agent_type: String,
    pub artifact: Option<PluginArtifact>,
    pub error: Option<String>,
    pub content: Option<String>,
}

pub fn emit_catalog_changed(app_handle: &tauri::AppHandle) -> Result<(), String> {
    app_handle
        .emit("plugin-catalog-changed", ())
        .map_err(|e| format!("emit plugin catalog event: {e}"))
}

pub fn emit_run_event(app_handle: &tauri::AppHandle, event: PluginRunEvent) -> Result<(), String> {
    app_handle
        .emit("plugin-run", event)
        .map_err(|e| format!("emit plugin run event: {e}"))
}

fn plugin_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory is unavailable".to_string())?;
    let root = get_user_config_dir(&home).join("plugin");
    fs::create_dir_all(&root).map_err(|e| format!("create plugin directory: {e}"))?;
    let metadata = fs::symlink_metadata(&root)
        .map_err(|error| format!("inspect plugin directory: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("plugin directory must be a real directory".into());
    }
    Ok(root)
}

fn plugin_state_path() -> Result<PathBuf, String> {
    Ok(plugin_root()?.join("state.json"))
}

fn read_plugin_state_result() -> Result<PluginStateFile, String> {
    let path = plugin_state_path()?;
    match fs::read_to_string(&path) {
        Ok(raw) => {
            serde_json::from_str(&raw).map_err(|error| format!("parse plugin state: {error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(PluginStateFile::default())
        }
        Err(error) => Err(format!("read plugin state: {error}")),
    }
}

fn write_plugin_state(state: &PluginStateFile) -> Result<(), String> {
    let path = plugin_state_path()?;
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("serialize plugin state: {error}"))?;
    flowix_core::memo_file::atomic_write_bytes(&path, &bytes)
        .map_err(|error| format!("write plugin state: {error}"))
}

pub fn ensure_builtin_plugins() -> Result<(), String> {
    let root = plugin_root()?;
    ensure_builtin_plugin(&root, "mindmap", MINDMAP_MANIFEST, MINDMAP_SKILL)?;
    ensure_builtin_plugin(&root, "webpage", WEBPAGE_MANIFEST, WEBPAGE_SKILL)?;
    Ok(())
}

fn ensure_builtin_plugin(
    root: &Path,
    plugin_id: &str,
    expected_manifest: &str,
    expected_skill: &str,
) -> Result<(), String> {
    let plugin = root.join(plugin_id);
    match fs::symlink_metadata(&plugin) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(format!("built-in {plugin_id} plugin path is invalid"));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(&plugin).map_err(|e| format!("create {plugin_id} plugin: {e}"))?;
        }
        Err(error) => return Err(format!("inspect {plugin_id} plugin: {error}")),
    }
    let manifest = plugin.join("plugin.json");
    // The built-in plugin is versioned with the host application.  Older
    // installations may still have the pre-declaration manifest (including
    // the removed agent selector), which would fail validation and silently
    // disappear from the sidebar.  Reconcile it on every startup so the
    // built-in definition is migrated before plugin discovery runs.
    let needs_manifest_migration = match fs::read_to_string(&manifest) {
        Ok(existing) => existing != expected_manifest,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(error) => {
            return Err(format!("read {plugin_id} manifest: {error}"));
        }
    };
    if needs_manifest_migration {
        fs::write(&manifest, expected_manifest)
            .map_err(|e| format!("write {plugin_id} manifest: {e}"))?;
    }
    let skill = plugin.join("SKILL.md");
    let needs_skill_migration = match fs::read_to_string(&skill) {
        Ok(existing) => existing != expected_skill,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(error) => return Err(format!("read {plugin_id} skill: {error}")),
    };
    if needs_skill_migration {
        fs::write(&skill, expected_skill).map_err(|e| format!("write {plugin_id} skill: {e}"))?;
    }
    Ok(())
}

fn read_plugin(path: &Path) -> Result<PluginDescriptor, String> {
    let expected_id = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    read_plugin_as(path, expected_id)
}

/// Read a source directory before it has been installed. Its directory name
/// is not authoritative; the manifest id becomes the final installation id.
fn read_plugin_source(path: &Path) -> Result<PluginDescriptor, String> {
    let raw = fs::read_to_string(path.join("plugin.json"))
        .map_err(|error| format!("read plugin source manifest: {error}"))?;
    let manifest: PluginManifest = serde_json::from_str(&raw)
        .map_err(|error| format!("parse plugin source manifest: {error}"))?;
    let id = manifest.id.clone();
    read_plugin_as(path, &id)
}

/// Read a plugin while validating it against its final published id. Staging
/// directories deliberately have random names, so they must use this helper
/// with the intended id instead of the staging directory basename.
fn read_plugin_as(path: &Path, expected_id: &str) -> Result<PluginDescriptor, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect plugin {}: {error}", path.display()))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!("plugin path is invalid: {}", path.display()));
    }
    let manifest_path = path.join("plugin.json");
    let raw = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("read {}: {e}", manifest_path.display()))?;
    let manifest: PluginManifest = serde_json::from_str(&raw)
        .map_err(|e| format!("parse {}: {e}", manifest_path.display()))?;
    if manifest.id != expected_id {
        return Err(format!(
            "plugin id does not match directory: {}",
            path.display()
        ));
    }
    let definition = validate_manifest(&manifest)?;
    let integrity_status = verify_plugin_integrity(path, &manifest)?;
    let instructions_path = manifest
        .tool
        .as_ref()
        .map(|tool| tool.instructions.as_str())
        .or_else(|| manifest.agent.as_ref().map(|agent| agent.skill.as_str()))
        .ok_or_else(|| format!("plugin has no instructions: {}", manifest.id))?;
    let skill_path = path.join(instructions_path);
    let skill_metadata = fs::symlink_metadata(&skill_path)
        .map_err(|error| format!("inspect {}: {error}", skill_path.display()))?;
    if skill_metadata.file_type().is_symlink()
        || !skill_metadata.is_file()
        || !plugin_path_is_inside(&skill_path, path)
    {
        return Err(format!(
            "plugin instructions are invalid: {}",
            skill_path.display()
        ));
    }
    let skill = fs::read_to_string(&skill_path)
        .map_err(|e| format!("read {}: {e}", skill_path.display()))?;
    let is_system = is_builtin_plugin_id(&manifest.id);
    let permissions = if manifest.permissions.is_empty() {
        vec![
            "agent.invoke".to_string(),
            "notebook.read".to_string(),
            "artifact.write".to_string(),
        ]
    } else {
        manifest.permissions.clone()
    };
    Ok(PluginDescriptor {
        manifest,
        installed_path: path.to_string_lossy().to_string(),
        skill,
        is_system,
        enabled: true,
        permissions,
        integrity_status,
        definition,
    })
}

fn verify_plugin_integrity(path: &Path, manifest: &PluginManifest) -> Result<String, String> {
    let Some(integrity) = &manifest.integrity else {
        return Ok("unverified".into());
    };
    for (relative, expected) in &integrity.files {
        let file = path.join(relative);
        let metadata = fs::symlink_metadata(&file)
            .map_err(|error| format!("inspect integrity file {relative}: {error}"))?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || !plugin_path_is_inside(&file, path)
        {
            return Err(format!("plugin integrity file is invalid: {relative}"));
        }
        let bytes =
            fs::read(&file).map_err(|error| format!("read integrity file {relative}: {error}"))?;
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(format!("plugin integrity mismatch: {relative}"));
        }
    }
    Ok("verified".into())
}

fn plugin_path_is_inside(path: &Path, root: &Path) -> bool {
    let Ok(path) = dunce::canonicalize(path) else {
        return false;
    };
    let Ok(root) = dunce::canonicalize(root) else {
        return false;
    };
    path.starts_with(root)
}

fn is_relative_plugin_path(raw: &str) -> bool {
    flowix_plugin_runtime::is_relative_plugin_path(raw)
}

fn valid_plugin_id(id: &str) -> bool {
    flowix_plugin_runtime::valid_plugin_id(id)
}

fn copy_plugin_tree(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(source).map_err(|e| format!("inspect plugin source: {e}"))?;
    if metadata.file_type().is_symlink() {
        return Err("plugin source cannot contain symbolic links".to_string());
    }
    if metadata.is_dir() {
        fs::create_dir_all(destination).map_err(|e| format!("create plugin directory: {e}"))?;
        for entry in fs::read_dir(source).map_err(|e| format!("read plugin source: {e}"))? {
            let entry = entry.map_err(|e| format!("read plugin source entry: {e}"))?;
            copy_plugin_tree(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        fs::copy(source, destination).map_err(|e| format!("copy plugin file: {e}"))?;
    } else {
        return Err("plugin source contains an unsupported filesystem entry".to_string());
    }
    Ok(())
}

pub fn refresh_plugins() -> Result<Vec<PluginDescriptor>, String> {
    Ok(plugin_catalog_snapshot()?.plugins)
}

fn validate_plugin_tree(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| format!("inspect plugin source: {e}"))?;
    if metadata.file_type().is_symlink() {
        return Err("plugin source cannot contain symbolic links".to_string());
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(|e| format!("read plugin source: {e}"))? {
            let entry = entry.map_err(|e| format!("read plugin source entry: {e}"))?;
            validate_plugin_tree(&entry.path())?;
        }
    } else if !metadata.is_file() {
        return Err("plugin source contains an unsupported filesystem entry".to_string());
    }
    Ok(())
}

pub fn validate_plugin_directory(source_directory: &str) -> Result<PluginDescriptor, String> {
    let source = PathBuf::from(source_directory);
    let source_meta =
        fs::symlink_metadata(&source).map_err(|e| format!("inspect plugin source: {e}"))?;
    if !source_meta.is_dir() || source_meta.file_type().is_symlink() {
        return Err("plugin source must be a real directory".to_string());
    }
    validate_plugin_tree(&source)?;
    let descriptor = read_plugin_source(&source)?;
    if !valid_plugin_id(&descriptor.manifest.id) {
        return Err("plugin id must use lowercase letters, numbers, '-' or '_'".into());
    }
    Ok(descriptor)
}

pub fn install_from_directory(source_directory: &str) -> Result<PluginDescriptor, String> {
    ensure_builtin_plugins()?;
    let source = PathBuf::from(source_directory);
    let source_descriptor = validate_plugin_directory(source_directory)?;
    let id = source_descriptor.manifest.id.clone();
    let root = plugin_root()?;
    let destination = root.join(&id);
    if is_builtin_plugin_id(&id) {
        return Err(format!("the built-in {id} plugin is managed by Flowix"));
    }
    let replacing = match fs::symlink_metadata(&destination) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink()
                || !metadata.is_dir()
                || !path_is_inside(&destination, &root)
            {
                return Err("existing plugin installation is invalid".into());
            }
            let existing = read_plugin(&destination)?;
            let current = semver::Version::parse(&existing.manifest.version)
                .map_err(|error| format!("installed plugin version is invalid: {error}"))?;
            let incoming = semver::Version::parse(&source_descriptor.manifest.version)
                .map_err(|error| format!("incoming plugin version is invalid: {error}"))?;
            if incoming < current {
                return Err(format!(
                    "plugin downgrade is not allowed: {id} {current} -> {incoming}"
                ));
            }
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("inspect existing plugin: {error}")),
    };
    if !path_is_inside(&destination, &root) {
        return Err("plugin installation path escaped plugin directory".into());
    }
    let staging = root.join(format!(".{id}.installing-{}", uuid::Uuid::new_v4()));
    if let Err(error) = copy_plugin_tree(&source, &staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    if let Err(error) = read_plugin_as(&staging, &id) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    let backup = root.join(format!(".{id}.backup-{}", uuid::Uuid::new_v4()));
    if replacing {
        if let Err(error) = fs::rename(&destination, &backup) {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("stage existing plugin for upgrade: {error}"));
        }
    }
    if let Err(error) = fs::rename(&staging, &destination) {
        if replacing {
            let _ = fs::rename(&backup, &destination);
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("publish plugin installation: {error}"));
    }
    let descriptor = match read_plugin(&destination) {
        Ok(descriptor) => descriptor,
        Err(error) => {
            let _ = fs::remove_dir_all(&destination);
            if replacing {
                let _ = fs::rename(&backup, &destination);
            }
            return Err(format!("verify published plugin: {error}"));
        }
    };
    if replacing {
        if let Err(error) = fs::remove_dir_all(&backup) {
            tracing::warn!(plugin = %id, path = %backup.display(), "plugin upgraded but old version cleanup failed: {error}");
        }
    }
    Ok(descriptor)
}

pub fn uninstall(id: &str) -> Result<(), String> {
    if !valid_plugin_id(id) {
        return Err("invalid plugin id".to_string());
    }
    let root = plugin_root()?;
    let target = root.join(id);
    let metadata = fs::symlink_metadata(&target).map_err(|e| format!("plugin not found: {e}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() || !path_is_inside(&target, &root) {
        return Err("invalid plugin installation".to_string());
    }
    let plugin = read_plugin(&target)?;
    if plugin.is_system {
        return Err(format!("the built-in {} plugin cannot be uninstalled", id));
    }
    fs::remove_dir_all(&target).map_err(|e| format!("uninstall plugin: {e}"))?;
    let mut state = read_plugin_state_result()?;
    if state.disabled.remove(id) {
        write_plugin_state(&state)?;
    }
    Ok(())
}

pub fn list_plugins() -> Result<Vec<PluginDescriptor>, String> {
    Ok(plugin_catalog_snapshot()?.plugins)
}

fn scan_plugin_catalog() -> Result<PluginCatalogSnapshot, String> {
    ensure_builtin_plugins()?;
    let root = plugin_root()?;
    let mut plugins = Vec::new();
    let mut diagnostics = Vec::new();
    let state = match read_plugin_state_result() {
        Ok(state) => state,
        Err(error) => {
            diagnostics.push(PluginDiagnostic {
                plugin_id: None,
                path: plugin_state_path()?.to_string_lossy().to_string(),
                status: "invalid".into(),
                message: Some(error),
            });
            PluginStateFile::default()
        }
    };
    for entry in fs::read_dir(&root).map_err(|e| format!("scan plugins: {e}"))? {
        let entry = entry.map_err(|e| format!("scan plugin entry: {e}"))?;
        if !entry.path().is_dir() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        match read_plugin(&entry.path()) {
            Ok(mut plugin) => {
                plugin.enabled = !state.disabled.contains(&plugin.manifest.id);
                diagnostics.push(PluginDiagnostic {
                    plugin_id: Some(plugin.manifest.id.clone()),
                    path: entry.path().to_string_lossy().to_string(),
                    status: if plugin.enabled { "ready" } else { "disabled" }.into(),
                    message: None,
                });
                plugins.push(plugin);
            }
            Err(error) => diagnostics.push(PluginDiagnostic {
                plugin_id: None,
                path: entry.path().to_string_lossy().to_string(),
                status: "invalid".into(),
                message: Some(error),
            }),
        }
    }
    plugins.sort_by_key(|plugin| (plugin.manifest.ui.order, plugin.manifest.name.clone()));
    diagnostics.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(PluginCatalogSnapshot {
        plugins,
        diagnostics,
    })
}

pub fn plugin_catalog_snapshot() -> Result<PluginCatalogSnapshot, String> {
    scan_plugin_catalog()
}

pub fn plugin_diagnostics() -> Result<Vec<PluginDiagnostic>, String> {
    Ok(plugin_catalog_snapshot()?.diagnostics)
}

pub fn set_enabled(id: &str, enabled: bool) -> Result<(), String> {
    if !valid_plugin_id(id) {
        return Err("invalid plugin id".into());
    }
    let root = plugin_root()?;
    let plugin = read_plugin(&root.join(id))?;
    if plugin.is_system && !enabled {
        return Err(format!("the built-in {id} plugin cannot be disabled"));
    }
    let mut state = read_plugin_state_result()?;
    if enabled {
        state.disabled.remove(id);
    } else {
        state.disabled.insert(id.to_string());
    }
    write_plugin_state(&state)?;
    Ok(())
}

pub fn get_plugin(id: &str) -> Result<PluginDescriptor, String> {
    let plugin = list_plugins()?
        .into_iter()
        .find(|plugin| plugin.manifest.id == id)
        .ok_or_else(|| format!("plugin not found: {id}"))?;
    if !plugin.enabled {
        return Err(format!("plugin is disabled: {id}"));
    }
    Ok(plugin)
}

pub fn new_run_id() -> String {
    format!("plugin-run-{}", uuid::Uuid::new_v4())
}

pub fn begin_run_with_prepared(
    id: &str,
    prepared_prompt: String,
    agent_type: &str,
    run_id: &str,
    app_handle: &tauri::AppHandle,
) -> Result<PluginRunStarted, String> {
    let event = PluginRunEvent {
        run_id: run_id.to_string(),
        plugin_id: id.to_string(),
        status: "started".to_string(),
        agent_type: agent_type.to_string(),
        artifact: None,
        error: None,
        content: None,
    };
    app_handle
        .emit("plugin-run", event)
        .map_err(|e| format!("emit plugin run event: {e}"))?;
    Ok(PluginRunStarted {
        run_id: run_id.to_string(),
        prepared_prompt,
    })
}

pub fn emit_run_failed(
    run_id: &str,
    plugin_id: &str,
    agent_type: &str,
    error: &str,
    app_handle: &tauri::AppHandle,
) -> Result<(), String> {
    app_handle
        .emit(
            "plugin-run",
            PluginRunEvent {
                run_id: run_id.to_string(),
                plugin_id: plugin_id.to_string(),
                status: "failed".to_string(),
                agent_type: agent_type.to_string(),
                artifact: None,
                error: Some(error.to_string()),
                content: None,
            },
        )
        .map_err(|e| format!("emit plugin run event: {e}"))
}

pub fn prepare_prompt(id: &str, user_prompt: &str, context: &str) -> Result<String, String> {
    let plugin = get_plugin(id)?;
    if plugin.manifest.kind != "agent-markdown" {
        return Err(format!(
            "plugin '{}' is an artifact tool; use its declared CLI command",
            plugin.manifest.id
        ));
    }
    let user_prompt = user_prompt.trim();
    if user_prompt.is_empty() {
        return Err("plugin prompt cannot be empty".to_string());
    }
    if user_prompt.len() > 20_000 {
        return Err("plugin prompt is too long".to_string());
    }
    let parser = match plugin.definition.parser {
        PluginParser::MindmapMarkdown => "mindmap-markdown",
        PluginParser::Markdown => "markdown",
        PluginParser::Json => "json",
        PluginParser::Html => "html",
        PluginParser::Text => "text",
    };
    Ok(format!(
        "# Flowix Plugin: {}\n\n## Plugin Instructions\n{}\n\n## Output Contract\n- Format: {}\n- Parser: {}\n- Return only the final artifact content.\n\n## Context\n{}\n\n## User Request\n<user-request>\n{}\n</user-request>",
        plugin.manifest.name,
        plugin.skill.trim(),
        plugin.manifest.output.format,
        parser,
        context.trim(),
        user_prompt,
    ))
}

pub fn resolve_agent_type(id: &str, requested: &str) -> Result<String, String> {
    let plugin = get_plugin(id)?;
    Ok(plugin
        .definition
        .runtime
        .map(PluginRuntime::key)
        .unwrap_or(requested)
        .to_string())
}

pub(crate) fn registered_notebook(
    notebook_path: &str,
    memo_file: &Arc<std::sync::RwLock<flowix_core::memo_file::MemoFile>>,
) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(notebook_path);
    if !candidate.is_absolute() || !candidate.is_dir() {
        return Err(format!("notebook path is unavailable: {notebook_path}"));
    }
    let candidate = dunce::canonicalize(candidate).map_err(|error| error.to_string())?;
    let memo_file = read_lock(memo_file, "memo_file");
    let root = memo_file
        .registered_notebook_paths()
        .into_iter()
        .filter_map(|root| dunce::canonicalize(root).ok())
        .find(|root| *root == candidate)
        .ok_or_else(|| "notebook path is not registered in Flowix".to_string())?;
    Ok(root)
}

pub fn write_output(
    id: &str,
    notebook_path: &str,
    content: &str,
    agent_type: &str,
    source_note: Option<&str>,
    run_id: Option<&str>,
    app_handle: Option<&tauri::AppHandle>,
    memo_file: &Arc<std::sync::RwLock<flowix_core::memo_file::MemoFile>>,
) -> Result<PluginArtifact, String> {
    let plugin = get_plugin(id)?;
    let notebook = registered_notebook(notebook_path, memo_file)?;
    let parsed = parse_plugin_output(&plugin, content)?;
    let clean = parsed.content;
    let title = parsed.title;
    let output_dir = notebook.join(&plugin.definition.output_directory);
    if !path_is_inside(&output_dir, &notebook) {
        return Err("plugin output directory escaped notebook root".to_string());
    }
    fs::create_dir_all(&output_dir).map_err(|e| format!("create plugin output: {e}"))?;
    if !path_is_inside(&output_dir, &notebook) {
        return Err("plugin output directory escaped notebook root".to_string());
    }
    let output_path = output_file_path(&output_dir, &title, &plugin.definition.extension);
    if !path_is_inside(&output_path, &notebook) {
        return Err("plugin output path escaped notebook root".to_string());
    }
    let document = artifact_document(&plugin, &clean, agent_type, source_note);
    flowix_core::memo_file::atomic_write_bytes(&output_path, document.as_bytes())
        .map_err(|e| format!("write plugin output: {e}"))?;
    let artifact_relative_path = output_path
        .strip_prefix(&notebook)
        .map_err(|_| "plugin output path is outside notebook root".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let pointer = PluginArtifactPointer {
        path: artifact_relative_path,
        format: plugin.manifest.output.format.clone(),
        parser: match plugin.definition.parser {
            PluginParser::MindmapMarkdown => "mindmap-markdown",
            PluginParser::Markdown => "markdown",
            PluginParser::Json => "json",
            PluginParser::Html => "html",
            PluginParser::Text => "text",
        }
        .to_string(),
        renderer: plugin.manifest.output.renderer.clone(),
        title: title.clone(),
        content_hash: flowix_plugin_runtime::artifact_content_hash(&clean),
        created_at: chrono::Local::now().to_rfc3339(),
        source_note: source_note.map(str::to_string),
    };
    let pointer_body = pointer_document(&plugin, &pointer)?;
    let notebook_id = {
        let memo_guard = read_lock(memo_file, "memo_file");
        memo_guard
            .read_notebook_configs()
            .map_err(|e| format!("read notebooks: {e}"))?
            .into_iter()
            .find(|config| Path::new(&config.path) == notebook)
            .map(|config| config.id)
            .ok_or_else(|| "notebook path is not registered in Flowix".to_string())?
    };
    let pointer_created = flowix_core::MemoService::new(&read_lock(memo_file, "memo_file"))
        .create_memo_named(Some(&notebook_id), &title, &pointer_body)
        .map_err(|e| {
            let _ = fs::remove_file(&output_path);
            format!("create plugin note: {e}")
        })?;
    let pointer_memo = pointer_created.memo;
    if let Some(app_handle) = app_handle.as_ref() {
        crate::watcher::runtime::mark_self_write_for(app_handle, &pointer_created.path);
        crate::memo_events::emit(
            app_handle,
            crate::memo_events::MemoEvent::Created {
                memo: pointer_memo.clone(),
                notebook_id: notebook_id.clone(),
                derived_changed: crate::memo_events::MemoDerivedChanged::from_memos(
                    None,
                    &pointer_memo,
                ),
                source: crate::memo_events::MemoChangeSource::ExternalTool,
            },
        );
    }
    let artifact = PluginArtifact {
        plugin_id: plugin.manifest.id,
        path: output_path.to_string_lossy().to_string(),
        name: title,
        created_at: chrono::Local::now().to_rfc3339(),
        format: plugin.manifest.output.format,
        renderer: plugin.manifest.output.renderer,
        content: Some(clean),
        note_id: Some(pointer_memo.id.clone()),
    };
    if let (Some(run_id), Some(app_handle)) = (run_id, app_handle) {
        app_handle
            .emit(
                "plugin-run",
                PluginRunEvent {
                    run_id: run_id.to_string(),
                    plugin_id: artifact.plugin_id.clone(),
                    status: "completed".to_string(),
                    agent_type: agent_type.to_string(),
                    artifact: Some(artifact.clone()),
                    error: None,
                    content: None,
                },
            )
            .map_err(|e| format!("emit plugin run event: {e}"))?;
    }
    Ok(artifact)
}

/// Create pointer notes for artifacts written before the pointer-note model
/// was introduced. This is deliberately idempotent: the artifact relative
/// path is the stable identity, while the memo id and filename are allowed to
/// be generated by MemoService.
fn migrate_legacy_outputs(
    plugin: &PluginDescriptor,
    notebook_id: &str,
    notebook: &Path,
    memo_file: &Arc<std::sync::RwLock<flowix_core::memo_file::MemoFile>>,
    app_handle: Option<&tauri::AppHandle>,
) -> Result<(), String> {
    let output_dir = notebook.join(&plugin.definition.output_directory);
    if !path_is_inside(&output_dir, notebook) || !output_dir.is_dir() {
        return Ok(());
    }

    let existing_paths = {
        let memo_file = read_lock(memo_file, "memo_file");
        memo_file
            .read_all_memos_with_body_for_notebook_id(Some(notebook_id))
            .into_iter()
            .filter_map(|(_, body)| {
                let yaml = body
                    .strip_prefix("---\n")
                    .and_then(|value| value.split_once("\n---"))
                    .map(|(yaml, _)| yaml)?;
                let metadata = serde_yaml::from_str::<PluginNoteFrontmatter>(yaml).ok()?;
                (metadata.flowix_plugin == plugin.manifest.id
                    && metadata.flowix_note_type == plugin.definition.note_type)
                    .then(|| metadata.flowix_artifact.path)
            })
            .collect::<std::collections::HashSet<_>>()
    };

    let entries =
        fs::read_dir(&output_dir).map_err(|error| format!("list plugin outputs: {error}"))?;
    for entry in entries {
        let path = entry
            .map_err(|error| format!("read plugin output entry: {error}"))?
            .path();
        if !path.is_file()
            || path.extension().and_then(|extension| extension.to_str())
                != Some(plugin.definition.extension.trim_start_matches('.'))
        {
            continue;
        }
        let relative = path
            .strip_prefix(notebook)
            .map_err(|_| "plugin output path is outside notebook root".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if existing_paths.contains(&relative) {
            continue;
        }
        let raw =
            fs::read_to_string(&path).map_err(|error| format!("read plugin output: {error}"))?;
        let parsed = match parse_plugin_output(plugin, &raw) {
            Ok(parsed) => parsed,
            Err(error) => {
                tracing::warn!(plugin = %plugin.manifest.id, path = %path.display(), "skip legacy plugin output migration: {error}");
                continue;
            }
        };
        let pointer = PluginArtifactPointer {
            path: relative.clone(),
            format: plugin.manifest.output.format.clone(),
            parser: parser_key(plugin.definition.parser).to_string(),
            renderer: plugin.manifest.output.renderer.clone(),
            title: parsed.title.clone(),
            content_hash: flowix_plugin_runtime::artifact_content_hash(&parsed.content),
            created_at: fs::metadata(&path)
                .and_then(|metadata| metadata.modified())
                .map(chrono::DateTime::<chrono::Local>::from)
                .map(|date| date.to_rfc3339())
                .unwrap_or_else(|_| chrono::Local::now().to_rfc3339()),
            source_note: None,
        };
        let body = pointer_document(plugin, &pointer)?;
        let created = flowix_core::MemoService::new(&read_lock(memo_file, "memo_file"))
            .create_memo_named(Some(notebook_id), &parsed.title, &body)
            .map_err(|error| format!("create migrated plugin note: {error}"))?;
        if let Some(app_handle) = app_handle {
            crate::watcher::runtime::mark_self_write_for(app_handle, &created.path);
            crate::memo_events::emit(
                app_handle,
                crate::memo_events::MemoEvent::Created {
                    memo: created.memo.clone(),
                    notebook_id: notebook_id.to_string(),
                    derived_changed: crate::memo_events::MemoDerivedChanged::from_memos(
                        None,
                        &created.memo,
                    ),
                    source: crate::memo_events::MemoChangeSource::ExternalTool,
                },
            );
        }
    }
    Ok(())
}

fn legacy_output_prefix(plugin_id: &str) -> String {
    format!(".plugin-output/{plugin_id}/")
}

fn migrated_output_path(plugin_id: &str, relative: &str) -> Option<String> {
    let prefix = legacy_output_prefix(plugin_id);
    relative
        .strip_prefix(&prefix)
        .map(|suffix| format!(".flowix/plugin/{plugin_id}/{suffix}"))
}

/// Repair pointer notes after a legacy artifact has moved. This is separate
/// from the filesystem migration so a failed note write never causes an
/// already-moved artifact to be removed.
pub fn repair_notebook_artifact_pointers(
    notebook_id: &str,
    notebook: &Path,
    memo_file: &Arc<std::sync::RwLock<flowix_core::memo_file::MemoFile>>,
) -> Result<usize, String> {
    let entries = {
        let memo_file = read_lock(memo_file, "memo_file");
        memo_file.read_all_memos_with_body_for_notebook_id(Some(notebook_id))
    };
    let mut repaired = 0;
    for (memo, raw_note) in entries {
        let Some(yaml) = raw_note
            .strip_prefix("---\n")
            .and_then(|value| value.split_once("\n---"))
            .map(|(yaml, _)| yaml)
        else {
            continue;
        };
        let Ok(mut metadata) = serde_yaml::from_str::<PluginNoteFrontmatter>(yaml) else {
            continue;
        };
        let Ok(plugin) = get_plugin(&metadata.flowix_plugin) else {
            continue;
        };
        if metadata.flowix_note_type != plugin.definition.note_type {
            continue;
        }
        let Some(mapped) =
            migrated_output_path(&plugin.manifest.id, &metadata.flowix_artifact.path)
        else {
            continue;
        };
        let old_path = notebook.join(&metadata.flowix_artifact.path);
        let new_path = notebook.join(&mapped);
        if !new_path.is_file() || old_path.is_file() {
            continue;
        }
        metadata.flowix_artifact.path = mapped.clone();
        let body = pointer_document(&plugin, &metadata.flowix_artifact)?;
        flowix_core::MemoService::new(&read_lock(memo_file, "memo_file"))
            .save_memo_preserving_filename(&memo.id, &body)
            .map_err(|error| format!("repair plugin pointer {}: {error}", memo.id))?;
        repaired += 1;
        tracing::info!(
            plugin = %plugin.manifest.id,
            memo_id = %memo.id,
            from = %old_path.display(),
            to = %new_path.display(),
            "repaired plugin artifact pointer path"
        );
    }
    Ok(repaired)
}

fn parser_key(parser: PluginParser) -> &'static str {
    match parser {
        PluginParser::MindmapMarkdown => "mindmap-markdown",
        PluginParser::Markdown => "markdown",
        PluginParser::Json => "json",
        PluginParser::Html => "html",
        PluginParser::Text => "text",
    }
}

/// Run notebook-scoped plugin migrations during notebook activation/startup.
/// Keeping this outside `list_notes` makes plugin queries read-only and keeps
/// all legacy artifact writes behind the notebook migration boundary.
pub fn migrate_notebook_data(
    notebook_id: &str,
    notebook: &Path,
    memo_file: &Arc<std::sync::RwLock<flowix_core::memo_file::MemoFile>>,
    app_handle: Option<&tauri::AppHandle>,
) -> Result<(), String> {
    static MIGRATION_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    let _migration_guard = MIGRATION_LOCK
        .get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .map_err(|_| "plugin output migration lock poisoned".to_string())?;

    repair_notebook_artifact_pointers(notebook_id, notebook, memo_file)?;
    for plugin in list_plugins()? {
        migrate_legacy_outputs(&plugin, notebook_id, notebook, memo_file, app_handle)?;
    }
    Ok(())
}

pub fn list_notes(
    id: &str,
    notebook_id: &str,
    memo_file: &Arc<std::sync::RwLock<flowix_core::memo_file::MemoFile>>,
) -> Result<Vec<flowix_core::memo_file::Memo>, String> {
    let plugin = get_plugin(id)?;
    let memo_file = read_lock(memo_file, "memo_file");
    let notes = memo_file
        .read_all_memos_for_notebook_id(Some(notebook_id))
        .into_iter()
        .filter(|memo| {
            memo.properties
                .get("flowix_note_type")
                .and_then(serde_json::Value::as_str)
                == Some(plugin.definition.note_type.as_str())
                && memo
                    .properties
                    .get("flowix_plugin")
                    .and_then(serde_json::Value::as_str)
                    == Some(plugin.manifest.id.as_str())
        })
        .collect();
    Ok(notes)
}

#[cfg(test)]
mod tests {
    use super::manifest::PluginField;
    use super::{
        clean_markdown, is_relative_plugin_path, parse_html, parse_json, parse_mindmap_markdown,
        read_plugin_as, read_plugin_source, valid_plugin_id, validate_manifest, PluginManifest,
        PluginRuntime, MINDMAP_MANIFEST, MINDMAP_SKILL,
    };

    #[test]
    fn plugin_workspace_requires_a_registered_root_before_execution() {
        use flowix_core::memo_file::{MemoFile, NotebookConfig};
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("notebook");
        std::fs::create_dir_all(root.join("child")).unwrap();
        let store = MemoFile::new(directory.path().join("config"));
        store
            .write_notebook_configs(&[NotebookConfig {
                id: "notebook".into(),
                name: "Notebook".into(),
                icon: None,
                path: root.to_string_lossy().into_owned(),
                is_default: true,
                sort: 0,
                created_at: 1,
                updated_at: 1,
            }])
            .unwrap();
        let store = std::sync::Arc::new(std::sync::RwLock::new(store));
        assert_eq!(
            super::registered_notebook(&root.to_string_lossy(), &store).unwrap(),
            dunce::canonicalize(&root).unwrap()
        );
        assert!(super::registered_notebook(&root.join("child").to_string_lossy(), &store).is_err());
        assert!(super::registered_notebook(&directory.path().to_string_lossy(), &store).is_err());
        assert!(super::registered_notebook(".", &store).is_err());
    }

    #[test]
    fn extracts_markdown_from_code_fence() {
        let output = "Here you go:\n```markdown\n# Root\n\n## Child\n```";
        assert_eq!(clean_markdown(output).unwrap(), "# Root\n\n## Child");
    }

    #[test]
    fn rejects_missing_root_heading() {
        assert!(clean_markdown("- child").is_err());
    }

    #[test]
    fn parses_json_output_and_extracts_title() {
        let parsed = parse_json("```json\n{\"title\":\"Roadmap\",\"items\":[1,2]}\n```")
            .expect("valid JSON output");
        assert_eq!(parsed.title, "Roadmap");
        assert!(parsed.content.contains("\"items\""));
    }

    #[test]
    fn parses_html_output_without_markdown_rules() {
        let parsed = parse_html("<main><h1>Report</h1></main>").expect("valid HTML output");
        assert_eq!(parsed.title, "HTML output");
        assert!(parsed.content.contains("<main>"));
    }

    #[test]
    fn parses_mindmap_output_after_explanation() {
        let parsed = parse_mindmap_markdown("说明\n\n# Root\n\n## Child").expect("mindmap");
        assert_eq!(parsed.title, "Root");
        assert_eq!(parsed.content, "# Root\n\n## Child");
    }

    #[test]
    fn validates_plugin_ids_and_relative_paths() {
        assert!(valid_plugin_id("my-plugin_2"));
        assert!(!valid_plugin_id("MindMap"));
        assert!(!valid_plugin_id("../escape"));
        assert!(is_relative_plugin_path("SKILL.md"));
        assert!(!is_relative_plugin_path("../SKILL.md"));
        assert!(!is_relative_plugin_path("/tmp/SKILL.md"));
    }

    #[test]
    fn validates_builtin_manifest_into_definition() {
        let manifest: PluginManifest = serde_json::from_str(MINDMAP_MANIFEST).unwrap();
        let definition = validate_manifest(&manifest).expect("builtin manifest is valid");
        assert_eq!(definition.parser, super::PluginParser::MindmapMarkdown);
        assert_eq!(definition.runtime, None);
        assert_eq!(definition.extension, ".md");
        assert_eq!(definition.note_type, "mindmap");
    }

    #[test]
    fn rejects_unknown_runtime_and_duplicate_fields() {
        let mut manifest: PluginManifest = serde_json::from_str(MINDMAP_MANIFEST).unwrap();
        manifest.execution.runtime = Some("unknown".to_string());
        assert!(validate_manifest(&manifest).is_err());

        let mut manifest: PluginManifest = serde_json::from_str(MINDMAP_MANIFEST).unwrap();
        manifest.input.fields = vec![
            PluginField {
                id: "duplicate".to_string(),
                field_type: "text".to_string(),
                label: None,
                required: false,
                placeholder: None,
                options: vec![],
            },
            PluginField {
                id: "duplicate".to_string(),
                field_type: "text".to_string(),
                label: None,
                required: false,
                placeholder: None,
                options: vec![],
            },
        ];
        assert!(validate_manifest(&manifest).is_err());
    }

    #[test]
    fn loads_manifest_file_and_normalizes_plugin_definition() {
        let temp = tempfile::tempdir().expect("temp plugin directory");
        let manifest_path = temp.path().join("plugin.json");
        std::fs::write(&manifest_path, MINDMAP_MANIFEST).expect("write manifest");
        let raw = std::fs::read_to_string(&manifest_path).expect("read manifest");
        let manifest: PluginManifest = serde_json::from_str(&raw).expect("parse manifest");
        let definition = validate_manifest(&manifest).expect("validate manifest");
        assert_eq!(
            definition.output_directory,
            std::path::Path::new(".flowix/plugin/mindmap")
        );
        assert_eq!(definition.extension, ".md");
        assert_eq!(definition.runtime.map(PluginRuntime::key), None);
    }

    #[test]
    fn validates_a_plugin_from_an_install_staging_directory() {
        let temp = tempfile::tempdir().expect("temp plugin directory");
        let staging = temp.path().join(".mindmap.installing-random");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("plugin.json"), MINDMAP_MANIFEST).unwrap();
        std::fs::write(staging.join("SKILL.md"), MINDMAP_SKILL).unwrap();

        let plugin = read_plugin_as(&staging, "mindmap").expect("staging plugin is valid");
        assert_eq!(plugin.manifest.id, "mindmap");
    }

    #[test]
    fn accepts_a_source_directory_whose_name_differs_from_the_plugin_id() {
        let temp = tempfile::tempdir().expect("temp plugin directory");
        let source = temp.path().join("downloaded-package");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("plugin.json"), MINDMAP_MANIFEST).unwrap();
        std::fs::write(source.join("SKILL.md"), MINDMAP_SKILL).unwrap();

        let plugin = read_plugin_source(&source).expect("source manifest determines plugin id");
        assert_eq!(plugin.manifest.id, "mindmap");
    }
}
