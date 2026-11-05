//! Flowix-managed DeepSeek Harness runtime.
//!
//! DSH is deliberately distributed independently from the Tauri application.
//! The client downloads a signed, platform-specific archive, verifies it, and
//! installs it into a versioned directory.  The JSON-RPC host still runs as a
//! child process of Flowix; this keeps the existing stdio protocol and avoids
//! exposing a local TCP service.

use futures::{
    future::{AbortHandle, Abortable},
    StreamExt,
};
use reqwest::{blocking::Client as BlockingClient, Client};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
#[cfg(not(debug_assertions))]
use tauri::Manager;
use tauri::{AppHandle, Emitter};

use crate::app::paths::get_app_data_path;

mod activation;
mod archive;
mod cleanup;
pub(crate) mod cli;
pub(crate) use cli::resolve_cli_launch;
pub(crate) fn set_user_selected_cli(path: Option<PathBuf>) {
    cli::set_user_selected_dsh_cli(path);
}
pub(crate) fn is_valid_cli_path(path: &Path) -> bool {
    cli::is_valid_dsh_cli_path(path)
}
mod download;
mod environment;
mod manifest;
mod publish;
mod verify;

use activation::activate_current;
use archive::extract_archive;
use cleanup::remove_runtime_root;
use download::{normalized_sha256, partial_download_path, response_resumes};
use environment::dsh_plugin_environment;
pub use environment::managed_child_environment;
use manifest::{
    dsh_version_is_at_least, fetch_manifest, flowix_version_is_at_least, manifest_url,
    validate_manifest_version, DshArtifact, DshManifest,
};
use publish::safe_bundle_path;
use verify::verify_artifact;

pub const DSH_PROTOCOL_VERSION: u64 = 1;
const DEFAULT_PROFILE: &str = "flowix";
const DSH_DIR_NAME: &str = "dsh";
pub const DSH_DOWNLOAD_PROGRESS_EVENT: &str = "dsh-download-progress";
const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: u64 = 100_000;
const HEALTH_CHECK_TIMEOUT: Duration = Duration::from_secs(30);
static DSH_UPDATE_CANCELLED: AtomicBool = AtomicBool::new(false);
static DSH_DOWNLOAD_ABORT: OnceLock<Mutex<Option<AbortHandle>>> = OnceLock::new();
static DSH_OPERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static DSH_DOWNLOAD_PROGRESS: OnceLock<Mutex<Option<DshDownloadProgress>>> = OnceLock::new();

/// DSH updates trust the HTTPS-served latest.json manifest, SHA-256, and the
/// same Minisign signature used by the Tauri updater.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshStatus {
    pub installed: bool,
    pub local_installed: bool,
    pub managed_installed: bool,
    pub app_server_profile_installed: bool,
    pub app_server_profile_update_available: bool,
    pub executable_path: Option<String>,
    pub version: Option<String>,
    pub harness_version: Option<String>,
    pub source: Option<String>,
    pub profile: String,
    pub message: Option<String>,
    pub archive_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshUpdateCheck {
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshDownloadProgress {
    pub phase: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub percent: Option<u8>,
    pub resumed: bool,
}

fn dsh_operation_lock() -> &'static Mutex<()> {
    DSH_OPERATION_LOCK.get_or_init(|| Mutex::new(()))
}

fn try_acquire_operation_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    match dsh_operation_lock().try_lock() {
        Ok(guard) => Ok(guard),
        Err(std::sync::TryLockError::WouldBlock) => {
            Err("a DSH install, update, or uninstall is already in progress".to_string())
        }
        Err(std::sync::TryLockError::Poisoned(poisoned)) => {
            tracing::warn!("DSH operation lock was poisoned; recovering it");
            Ok(poisoned.into_inner())
        }
    }
}

fn download_progress_state() -> &'static Mutex<Option<DshDownloadProgress>> {
    DSH_DOWNLOAD_PROGRESS.get_or_init(|| Mutex::new(None))
}

fn download_abort_state() -> &'static Mutex<Option<AbortHandle>> {
    DSH_DOWNLOAD_ABORT.get_or_init(|| Mutex::new(None))
}

/// Return the latest DSH download state so newly mounted windows can recover
/// progress after missing one or more native events.
pub fn download_progress() -> Option<DshDownloadProgress> {
    download_progress_state()
        .lock()
        .ok()
        .and_then(|value| value.clone())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DshRuntimeMetadata {
    schema_version: u64,
    product: String,
    version: String,
    protocol_version: u64,
    build_id: String,
    target: String,
    includes_ui: bool,
    #[serde(default = "default_runtime_type")]
    runtime_type: String,
    #[serde(default)]
    node_executable: Option<String>,
    #[serde(default)]
    entrypoint: Option<String>,
    #[serde(default)]
    cli_entrypoint: Option<String>,
    #[serde(default)]
    pnpm_entrypoint: Option<String>,
    #[serde(default)]
    node_version: Option<String>,
    #[serde(default)]
    node_abi: Option<String>,
    #[serde(default)]
    pnpm_version: Option<String>,
}

fn default_runtime_type() -> String {
    "sea".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurrentDsh {
    version: String,
    target: String,
    build_id: Option<String>,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    archive_size: Option<u64>,
    installed_at: String,
    #[serde(default = "default_runtime_type")]
    runtime_type: String,
    #[serde(default)]
    node_executable: Option<String>,
    #[serde(default)]
    entrypoint: Option<String>,
    #[serde(default)]
    cli_entrypoint: Option<String>,
    #[serde(default)]
    pnpm_entrypoint: Option<String>,
    #[serde(default)]
    node_version: Option<String>,
    #[serde(default)]
    node_abi: Option<String>,
    #[serde(default)]
    pnpm_version: Option<String>,
}

#[derive(Debug, Clone)]
struct DshInstallation {
    version: String,
    harness_version: Option<String>,
    host_path: PathBuf,
    build_id: Option<String>,
    sha256: Option<String>,
    archive_size: Option<u64>,
    launch: ManagedDshLaunch,
}

#[derive(Debug, Clone)]
pub struct ManagedDshLaunch {
    pub executable: PathBuf,
    pub args: Vec<PathBuf>,
    pub root: PathBuf,
    pub cli_entrypoint: Option<PathBuf>,
}

pub fn status() -> DshStatus {
    let development = development_bundle_launch_spec();
    let local = local_dsh_executable();
    let managed = current_installation();
    let dsh_home = dsh_home_path();
    let profile_owned = flowix_profile_owned(&dsh_home);
    let app_server_profile_installed = flowix_profile_installed(&dsh_home);
    let app_server_profile_update_available = profile_owned && !app_server_profile_installed;
    if let Some(executable) = local.as_ref() {
        let version = local_dsh_version(executable);
        return DshStatus {
            installed: true,
            local_installed: true,
            managed_installed: managed.is_some()
                || development
                    .as_ref()
                    .map(|result| result.is_ok())
                    .unwrap_or(false),
            executable_path: Some(executable.display().to_string()),
            version,
            harness_version: None,
            source: Some("local-cli".to_string()),
            profile: DEFAULT_PROFILE.to_string(),
            message: None,
            archive_size: None,
            app_server_profile_installed,
            app_server_profile_update_available,
        };
    }
    if let Some(Ok(launch)) = development.as_ref() {
        return DshStatus {
            installed: true,
            local_installed: false,
            managed_installed: true,
            executable_path: Some(launch.executable.display().to_string()),
            version: Some("dev".to_string()),
            harness_version: harness_version_from_root(&launch.root),
            source: Some("flowix-dev-bundle".to_string()),
            profile: DEFAULT_PROFILE.to_string(),
            message: None,
            archive_size: None,
            app_server_profile_installed,
            app_server_profile_update_available,
        };
    }
    match managed {
        Some(installation) => DshStatus {
            installed: true,
            local_installed: false,
            managed_installed: true,
            executable_path: Some(installation.host_path.display().to_string()),
            version: Some(installation.version.clone()),
            harness_version: installation.harness_version.clone(),
            source: Some("flowix-managed".to_string()),
            profile: DEFAULT_PROFILE.to_string(),
            message: None,
            archive_size: installation.archive_size,
            app_server_profile_installed,
            app_server_profile_update_available,
        },
        None => DshStatus {
            installed: false,
            local_installed: false,
            managed_installed: false,
            executable_path: None,
            version: None,
            harness_version: None,
            source: None,
            profile: DEFAULT_PROFILE.to_string(),
            message: development
                .and_then(Result::err)
                .or_else(|| Some("DeepSeek Harness is not installed".to_string())),
            archive_size: None,
            app_server_profile_installed: false,
            app_server_profile_update_available: false,
        },
    }
}

fn dsh_home_path() -> PathBuf {
    crate::config::user::resolve_dsh_home(&dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
}

pub(crate) fn flowix_profile_installed(dsh_home: &Path) -> bool {
    flowix_profile_present(dsh_home)
        && flowix_profile_version(dsh_home).as_deref() == Some(env!("CARGO_PKG_VERSION"))
}

fn flowix_profile_present(dsh_home: &Path) -> bool {
    let profile = dsh_home.join("profiles").join(DEFAULT_PROFILE);
    if !profile
        .join("node_modules/dsh-appserver/src/cordis-plugin.js")
        .is_file()
        || !profile
            .join("node_modules/dsh-flowix-memory/launcher.mjs")
            .is_file()
        || !profile.join("cordis.patch.yml").is_file()
    {
        return false;
    }
    let Ok(package_bytes) = fs::read(profile.join("package.json")) else {
        return false;
    };
    let Ok(package) = serde_json::from_slice::<serde_json::Value>(&package_bytes) else {
        return false;
    };
    package
        .pointer("/dsh/profile/bundles")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|bundles| {
            ["dsh-appserver", "dsh-flowix-memory"]
                .iter()
                .all(|required| {
                    bundles
                        .iter()
                        .any(|bundle| bundle.as_str() == Some(required))
                })
        })
}

fn flowix_profile_owned(dsh_home: &Path) -> bool {
    let package = fs::read(
        dsh_home
            .join("profiles")
            .join(DEFAULT_PROFILE)
            .join("package.json"),
    )
    .ok()
    .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    package
        .as_ref()
        .and_then(|package| package.get("name"))
        .and_then(serde_json::Value::as_str)
        == Some("dsh-profile-flowix")
}

fn flowix_profile_version(dsh_home: &Path) -> Option<String> {
    let package = fs::read(
        dsh_home
            .join("profiles")
            .join(DEFAULT_PROFILE)
            .join("package.json"),
    )
    .ok()
    .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())?;
    package
        .pointer("/flowix/profileVersion")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

fn local_dsh_executable() -> Option<PathBuf> {
    cli::local_dsh_executable()
}

fn local_dsh_version(cli: &Path) -> Option<String> {
    let canonical = fs::canonicalize(cli).unwrap_or_else(|_| cli.to_path_buf());
    for executable in [canonical.as_path(), cli] {
        let mut directory = executable.parent();
        while let Some(current) = directory {
            let manifest = current.join("package.json");
            if let Ok(bytes) = fs::read(&manifest) {
                if let Ok(package) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    if package.get("name").and_then(serde_json::Value::as_str)
                        == Some("@deepseek-ai/dsh")
                    {
                        if let Some(version) =
                            package.get("version").and_then(serde_json::Value::as_str)
                        {
                            return Some(version.to_string());
                        }
                    }
                }
            }
            for relative in [
                Path::new("node_modules/@deepseek-ai/dsh/package.json"),
                Path::new("lib/node_modules/@deepseek-ai/dsh/package.json"),
            ] {
                let manifest = current.join(relative);
                if let Ok(bytes) = fs::read(manifest) {
                    if let Ok(package) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                        if package.get("name").and_then(serde_json::Value::as_str)
                            == Some("@deepseek-ai/dsh")
                        {
                            if let Some(version) =
                                package.get("version").and_then(serde_json::Value::as_str)
                            {
                                return Some(version.to_string());
                            }
                        }
                    }
                }
            }
            directory = current.parent();
        }
    }
    None
}

/// Install the Flowix App Server profile after an explicit user action.
/// Startup only probes this state; it never calls this function implicitly.
pub fn install_appserver_profile(app: &AppHandle) -> Result<DshStatus, String> {
    let _operation_guard = try_acquire_operation_lock()?;
    let current_status = status();
    if !current_status.installed {
        return Err("请先安装 DSH，再安装 Flowix App Server 插件".to_string());
    }

    let home = dsh_home_path();
    let source = appserver_profile_resource(app)?;

    install_profile_from_source(&home, &source)?;
    Ok(status())
}

pub(crate) fn install_profile_from_source(home: &Path, source: &Path) -> Result<(), String> {
    let target = home.join("profiles").join(DEFAULT_PROFILE);
    let had_flowix_profile = target.exists();
    if had_flowix_profile {
        let package_path = target.join("package.json");
        let package = fs::read(&package_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        if package
            .as_ref()
            .and_then(|value| value.get("name"))
            .and_then(serde_json::Value::as_str)
            != Some("dsh-profile-flowix")
        {
            return Err(format!(
                "DSH profile '{}' 已存在且不属于 Flowix；为避免覆盖用户配置，请先在 DSH 中更换 profile 名称",
                DEFAULT_PROFILE
            ));
        }
    }

    let parent = target.parent().ok_or("invalid DSH profile path")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("create DSH profiles directory: {error}"))?;
    let transaction_id = uuid::Uuid::new_v4();
    let staging = parent.join(format!(".flowix-profile-install-{transaction_id}"));
    let backup = parent.join(format!(".flowix-profile-backup-{transaction_id}"));
    let staged = if had_flowix_profile {
        copy_profile_tree(&target, &staging).and_then(|()| {
            for bundle in ["dsh-appserver", "dsh-flowix-memory"] {
                let installed = staging.join("node_modules").join(bundle);
                if installed.exists() {
                    fs::remove_dir_all(&installed)
                        .map_err(|error| format!("replace Flowix DSH bundle {bundle}: {error}"))?;
                }
                copy_profile_tree(&source.join("node_modules").join(bundle), &installed)?;
            }
            merge_flowix_profile_package(
                &staging.join("package.json"),
                &source.join("package.json"),
            )?;
            repair_flowix_profile_patch(
                &staging.join("cordis.patch.yml"),
                &source.join("cordis.patch.yml"),
            )
            .and_then(|()| stamp_flowix_profile_version(&staging))
        })
    } else {
        copy_profile_tree(&source, &staging).and_then(|()| stamp_flowix_profile_version(&staging))
    };
    if let Err(error) = staged {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    if target.exists() {
        fs::rename(&target, &backup)
            .map_err(|error| format!("preserve existing Flowix DSH profile: {error}"))?;
    }
    if let Err(error) = fs::rename(&staging, &target) {
        let _ = fs::remove_dir_all(&staging);
        if backup.exists() {
            let _ = fs::rename(&backup, &target);
        }
        return Err(format!("publish Flowix DSH profile: {error}"));
    }
    if backup.exists() {
        let _ = fs::remove_dir_all(&backup);
    }
    Ok(())
}

/// Add missing Flowix patch entries while preserving existing user settings.
fn repair_flowix_profile_patch(target: &Path, source: &Path) -> Result<(), String> {
    if !target.exists() {
        fs::copy(source, target)
            .map_err(|error| format!("restore Flowix profile patch: {error}"))?;
        return Ok(());
    }
    let read_patch = |path: &Path| -> Result<Vec<serde_yaml::Value>, String> {
        let bytes = fs::read(path).map_err(|error| format!("read DSH profile patch: {error}"))?;
        serde_yaml::from_slice(&bytes).map_err(|error| format!("parse DSH profile patch: {error}"))
    };
    let mut patch = read_patch(target)?;
    let required = read_patch(source)?;
    let mut changed = false;
    for entry in required {
        let id = entry.get("id").and_then(serde_yaml::Value::as_str);
        if let Some(id) = id {
            if let Some(existing) = patch
                .iter_mut()
                .find(|existing| existing.get("id").and_then(serde_yaml::Value::as_str) == Some(id))
            {
                changed |= merge_required_patch_fields(existing, &entry);
                continue;
            }
        }
        // Entries without an id (e.g. insert operations) use structural equality.
        if id.is_none() && patch.contains(&entry) {
            continue;
        }
        patch.push(entry);
        changed = true;
    }
    if changed {
        let yaml = serde_yaml::to_string(&patch)
            .map_err(|error| format!("serialize DSH profile patch: {error}"))?;
        fs::write(target, yaml).map_err(|error| format!("repair DSH profile patch: {error}"))?;
    }
    Ok(())
}

/// Refresh Flowix-owned patch fields while retaining user-added fields and
/// entries. Required values from the shipped patch take precedence.
fn merge_required_patch_fields(
    existing: &mut serde_yaml::Value,
    required: &serde_yaml::Value,
) -> bool {
    match (existing, required) {
        (serde_yaml::Value::Mapping(existing), serde_yaml::Value::Mapping(required)) => {
            let mut changed = false;
            for (key, required_value) in required {
                if let Some(existing_value) = existing.get_mut(key) {
                    changed |= merge_required_patch_fields(existing_value, required_value);
                } else {
                    existing.insert(key.clone(), required_value.clone());
                    changed = true;
                }
            }
            changed
        }
        (existing, required) if existing != required => {
            *existing = required.clone();
            true
        }
        _ => false,
    }
}

fn merge_flowix_profile_package(target: &Path, source: &Path) -> Result<(), String> {
    let mut target_json: serde_json::Value = serde_json::from_slice(
        &fs::read(target).map_err(|error| format!("read existing DSH profile package: {error}"))?,
    )
    .map_err(|error| format!("parse existing DSH profile package: {error}"))?;
    let source_json: serde_json::Value = serde_json::from_slice(
        &fs::read(source).map_err(|error| format!("read Flowix DSH profile package: {error}"))?,
    )
    .map_err(|error| format!("parse Flowix DSH profile package: {error}"))?;
    let bundles = target_json
        .pointer_mut("/dsh/profile/bundles")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or("existing Flowix DSH profile has no bundle list")?;
    for required in [
        "@deepseek-ai/dsh-base",
        "dsh-appserver",
        "dsh-flowix-memory",
    ] {
        if !bundles
            .iter()
            .any(|bundle| bundle.as_str() == Some(required))
        {
            bundles.push(serde_json::Value::String(required.to_string()));
        }
    }
    if target_json
        .get("name")
        .and_then(serde_json::Value::as_str)
        .is_none()
    {
        target_json["name"] = source_json["name"].clone();
    }
    fs::write(
        target,
        serde_json::to_vec_pretty(&target_json)
            .map_err(|error| format!("serialize Flowix DSH profile package: {error}"))?,
    )
    .map_err(|error| format!("write Flowix DSH profile package: {error}"))
}

fn stamp_flowix_profile_version(profile: &Path) -> Result<(), String> {
    let package_path = profile.join("package.json");
    let mut package: serde_json::Value = serde_json::from_slice(
        &fs::read(&package_path)
            .map_err(|error| format!("read Flowix DSH profile package: {error}"))?,
    )
    .map_err(|error| format!("parse Flowix DSH profile package: {error}"))?;
    package["flowix"]["profileVersion"] =
        serde_json::Value::String(env!("CARGO_PKG_VERSION").to_string());
    fs::write(
        &package_path,
        serde_json::to_vec_pretty(&package)
            .map_err(|error| format!("serialize Flowix DSH profile package: {error}"))?,
    )
    .map_err(|error| format!("write Flowix DSH profile version: {error}"))
}

fn appserver_profile_resource(_app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let source = repo.join(".build/dsh-runtime-dev");
        if source.is_dir() {
            let platform = if cfg!(target_os = "macos") {
                "macos"
            } else if cfg!(target_os = "windows") {
                "windows"
            } else {
                "linux"
            };
            let arch = if cfg!(target_arch = "aarch64") {
                "arm64"
            } else {
                "x64"
            };
            let candidate = source.join(format!("node24-{platform}-{arch}/profile/flowix"));
            if candidate.is_dir() {
                return Ok(candidate);
            }
        }
        let staged = repo.join(".build/dsh-appserver-profile/flowix");
        for bundle in ["dsh-appserver", "dsh-flowix-memory"] {
            let plugin_target = staged.join("node_modules").join(bundle);
            if plugin_target.exists() {
                fs::remove_dir_all(&plugin_target)
                    .map_err(|error| format!("refresh local DSH bundle {bundle}: {error}"))?;
            }
            copy_profile_tree(&repo.join(bundle), &plugin_target)?;
        }
        fs::create_dir_all(&staged)
            .map_err(|error| format!("create local DSH profile template: {error}"))?;
        fs::copy(
            repo.join("scripts/dsh-dev-profile.patch.yml"),
            staged.join("cordis.patch.yml"),
        )
        .map_err(|error| format!("stage DSH App Server profile patch: {error}"))?;
        fs::write(
            staged.join("package.json"),
            br#"{
  "name": "dsh-profile-flowix",
  "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-appserver", "dsh-flowix-memory"] } }
}
"#,
        )
        .map_err(|error| format!("stage DSH App Server profile manifest: {error}"))?;
        Ok(staged)
    }
    #[cfg(not(debug_assertions))]
    {
        let resource = _app
            .path()
            .resource_dir()
            .ok()
            .map(|root| root.join("dsh-profile/flowix"))
            .filter(|path| path.is_dir());
        resource.ok_or_else(|| "Flowix App Server installation files are missing".to_string())
    }
}

/// Check the published DSH manifest without downloading or changing the
/// installed runtime. Development bundles deliberately skip remote checks.
pub fn check_for_update() -> Result<DshUpdateCheck, String> {
    if development_bundle_launch_spec().is_some() {
        return Ok(DshUpdateCheck {
            current_version: Some("dev".to_string()),
            latest_version: None,
            update_available: false,
        });
    }
    let current_version = current_installation().map(|installation| installation.version);
    let latest_version = fetch_manifest()?.version;
    let update_available = current_version
        .as_deref()
        .map(|current| !dsh_version_is_at_least(current, &latest_version).unwrap_or(false))
        .unwrap_or(false);
    Ok(DshUpdateCheck {
        current_version,
        latest_version: Some(latest_version),
        update_available,
    })
}

pub(crate) fn development_bundle_launch_spec() -> Option<Result<ManagedDshLaunch, String>> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let configured = std::env::var_os("FLOWIX_DSH_DEV_ROOT").map(PathBuf::from);
    let root = configured.or_else(|| {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let platform = if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(target_os = "windows") {
            "windows"
        } else {
            "linux"
        };
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        };
        let candidate = repo.join(format!(".build/dsh-runtime-dev/node24-{platform}-{arch}"));
        candidate.is_dir().then_some(candidate)
    });
    root.map(|root| {
        let canonical = dunce::canonicalize(&root)
            .map_err(|error| format!("invalid DSH dev runtime {}: {error}", root.display()))?;
        let node = canonical
            .join("node")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        let runtime = canonical.join("runtime/node_modules/@deepseek-ai/dsh/lib/bin.js");
        let profile = canonical
            .join("profile")
            .join(DEFAULT_PROFILE)
            .join("package.json");
        for (label, path) in [
            ("private Node", &node),
            ("DSH CLI", &runtime),
            ("Flowix profile", &profile),
        ] {
            if !path.is_file() {
                return Err(format!(
                    "DSH dev runtime is incomplete: {label} is missing at {}",
                    path.display()
                ));
            }
        }
        Ok(ManagedDshLaunch {
            executable: node,
            args: vec![runtime.clone()],
            root: canonical,
            cli_entrypoint: Some(runtime),
        })
    })
}

fn harness_version_from_root(root: &Path) -> Option<String> {
    let package = root.join("runtime/node_modules/@deepseek-ai/dsh/package.json");
    let value: serde_json::Value = serde_json::from_str(&fs::read_to_string(package).ok()?).ok()?;
    value.get("version")?.as_str().map(ToOwned::to_owned)
}



/// Prepare and verify an update while the current host remains available, then
/// invoke `before_publish` immediately before replacing the installed runtime.
pub fn install_runtime_with_progress_before_publish(
    app: Option<AppHandle>,
    mut before_publish: impl FnMut() -> Result<(), String>,
) -> Result<DshStatus, String> {
    let _operation_guard = try_acquire_operation_lock()?;
    DSH_UPDATE_CANCELLED.store(false, Ordering::Release);
    let result = install_runtime_inner(app.as_ref(), &mut before_publish);
    if let Err(error) = &result {
        let phase = if is_cancelled_error(error) {
            "cancelled"
        } else {
            "failed"
        };
        emit_progress(app.as_ref(), phase, 0, None, false);
        tracing::warn!("DSH update failed: {error}");
    }
    result
}

pub fn cancel_update() {
    DSH_UPDATE_CANCELLED.store(true, Ordering::Release);
    if let Ok(active) = download_abort_state().lock() {
        if let Some(handle) = active.as_ref() {
            handle.abort();
        }
    }
}

fn is_cancelled_error(error: &str) -> bool {
    error.contains("DSH download cancelled") || error.contains("DSH install cancelled")
}

fn check_cancelled() -> Result<(), String> {
    if DSH_UPDATE_CANCELLED.load(Ordering::Acquire) {
        return Err("DSH install cancelled".to_string());
    }
    Ok(())
}


/// Delegate profile dependency changes to the official `dsh plugin`
/// implementation embedded in the managed carrier. Flowix validates only the
/// narrow IPC surface; package resolution, reconciliation and install
/// semantics remain upstream-owned.
pub fn run_profile_plugin(
    dsh_home: &Path,
    action: &str,
    package: Option<&str>,
) -> Result<String, String> {
    let _operation_guard = try_acquire_operation_lock()?;
    let action = action.trim();
    if !matches!(action, "add" | "remove" | "update") {
        return Err("unsupported DSH plugin action".to_string());
    }
    let package = package.map(str::trim).filter(|value| !value.is_empty());
    if matches!(action, "add" | "remove") && package.is_none() {
        return Err(format!("DSH plugin {action} requires a package spec"));
    }
    if action == "update" && package.is_some() {
        return Err("DSH plugin update does not accept a package spec".to_string());
    }
    if action == "remove" && package.is_some_and(is_required_flowix_profile_bundle) {
        return Err("the official base and Flowix profile bundles cannot be removed".to_string());
    }
    if package.is_some_and(|value| value.starts_with('-') || value.contains('\0')) {
        return Err("invalid DSH plugin package spec".to_string());
    }

    let mut args = vec!["plugin", "--profile", DEFAULT_PROFILE, action];
    if let Some(package) = package {
        args.push(package);
    }
    let launch = resolve_cli_launch(&args)?;
    let mut command = Command::new(&launch.executable);
    crate::process_window::hide_std_command_window(&mut command);
    command
        .args(&launch.args)
        .env_clear()
        .envs(launch.environment)
        .env("DSH_HOME", dsh_home);
    let output = command
        .output()
        .map_err(|error| format!("start official dsh plugin command: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(if stderr.is_empty() {
            format!("dsh plugin exited with {}", output.status)
        } else {
            stderr
        });
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

fn is_required_flowix_profile_bundle(package: &str) -> bool {
    matches!(package, "@deepseek-ai/dsh-base" | "dsh-flowix-memory")
}

fn install_runtime_inner(
    app: Option<&AppHandle>,
    before_publish: &mut dyn FnMut() -> Result<(), String>,
) -> Result<DshStatus, String> {
    emit_progress(app, "checking", 0, None, false);
    let manifest = fetch_manifest()?;
    check_cancelled()?;
    if !matches!(manifest.schema_version, 1 | 2) {
        return Err(format!(
            "unsupported DSH manifest schema {}",
            manifest.schema_version
        ));
    }
    if manifest.product != "flowix-dsh" {
        return Err("DSH manifest product mismatch".to_string());
    }
    if manifest.protocol_version != DSH_PROTOCOL_VERSION {
        return Err(format!(
            "DSH protocol mismatch: package={}, client={}",
            manifest.protocol_version, DSH_PROTOCOL_VERSION
        ));
    }
    validate_manifest_version(&manifest.version)?;
    if let Some(minimum) = manifest.min_flowix_version.as_deref() {
        if !flowix_version_is_at_least(crate::runtime_log::APP_VERSION, minimum)? {
            return Err(format!(
                "DSH {} requires Flowix >= {}, current Flowix is {}",
                manifest.version,
                minimum,
                crate::runtime_log::APP_VERSION
            ));
        }
    }
    let target = target_key();
    let artifact = manifest
        .platforms
        .get(target)
        .ok_or_else(|| format!("no DSH package is available for {target}"))?;
    if artifact.signature.as_deref().is_none()
        || artifact
            .signature
            .as_deref()
            .is_some_and(|signature| signature.trim().is_empty())
    {
        return Err("DSH update manifest has no artifact signature".to_string());
    }

    let root = dsh_root();
    if let Some(current) = current_installation() {
        if dsh_version_is_at_least(&current.version, &manifest.version)?
            && (current.version != manifest.version || current_artifact_matches(&current, artifact))
        {
            emit_progress(app, "up-to-date", 0, None, false);
            return Ok(status());
        }
    }
    fs::create_dir_all(root.join("downloads"))
        .map_err(|e| format!("create DSH download directory: {e}"))?;
    let download = download_artifact(&artifact.url, &artifact.sha256, app, &root)?;
    if let Err(error) = check_cancelled() {
        let _ = fs::remove_file(&download.partial_path);
        return Err(error);
    }
    if let Err(error) = verify_artifact(&download.bytes, artifact) {
        let _ = fs::remove_file(&download.partial_path);
        return Err(error);
    }
    let _ = fs::remove_file(&download.partial_path);
    let versions = root.join("versions");
    fs::create_dir_all(&versions).map_err(|e| format!("create DSH directory: {e}"))?;
    let staging = versions.join(format!(".installing-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&staging).map_err(|e| format!("create DSH staging directory: {e}"))?;

    emit_progress(
        app,
        "installing",
        download.bytes.len() as u64,
        Some(download.bytes.len() as u64),
        false,
    );
    let result = extract_archive(&download.bytes, &staging)
        .and_then(|()| check_cancelled())
        .and_then(|()| {
            let metadata = validate_runtime_metadata(&staging, &manifest, target, artifact)?;
            let launch = launch_from_metadata(&staging, &metadata)?;
            health_check(&launch)
        })
        .and_then(|()| check_cancelled())
        .and_then(|()| before_publish())
        .and_then(|()| publish_install(&root, &staging, &manifest, target, artifact));
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result.map(|_| {
        emit_progress(app, "installed", 1, Some(1), false);
        status()
    })
}

fn current_artifact_matches(current: &DshInstallation, artifact: &DshArtifact) -> bool {
    // Installations created before checksum persistence are deliberately
    // re-downloaded once.  A matching version/build id alone cannot prove
    // that the bytes on disk are the bytes published in the manifest.
    current
        .sha256
        .as_deref()
        .is_some_and(|sha256| sha256.eq_ignore_ascii_case(artifact.sha256.trim()))
        && current.build_id == artifact.build_id
}


pub fn managed_launch_spec() -> Option<ManagedDshLaunch> {
    if let Some(result) = development_bundle_launch_spec() {
        return result.ok();
    }
    current_installation().map(|installation| installation.launch)
}

struct DownloadedArtifact {
    bytes: Vec<u8>,
    partial_path: PathBuf,
}

fn download_artifact(
    url: &str,
    expected_sha256: &str,
    app: Option<&AppHandle>,
    root: &Path,
) -> Result<DownloadedArtifact, String> {
    let (abort_handle, abort_registration) = AbortHandle::new_pair();
    {
        let mut active = download_abort_state()
            .lock()
            .map_err(|_| "DSH download cancellation state is unavailable".to_string())?;
        *active = Some(abort_handle);
    }

    let result = tauri::async_runtime::block_on(Abortable::new(
        download_artifact_async(url, expected_sha256, app, root),
        abort_registration,
    ));

    if let Ok(mut active) = download_abort_state().lock() {
        *active = None;
    }

    match result {
        Ok(result) => result,
        Err(_) => {
            Err("DSH download cancelled; the partial download was kept for resume".to_string())
        }
    }
}

async fn download_artifact_async(
    url: &str,
    expected_sha256: &str,
    app: Option<&AppHandle>,
    root: &Path,
) -> Result<DownloadedArtifact, String> {
    let normalized_hash = normalized_sha256(expected_sha256)?;
    let partial_path = partial_download_path(root, &normalized_hash);
    let mut existing = fs::metadata(&partial_path)
        .map(|meta| meta.len())
        .unwrap_or(0);
    if existing > MAX_DOWNLOAD_BYTES {
        fs::remove_file(&partial_path)
            .map_err(|e| format!("remove oversized DSH partial download: {e}"))?;
        existing = 0;
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .map_err(|e| format!("create DSH download client: {e}"))?;
    let mut response = request_artifact(&client, url, existing).await?;
    if response.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && existing > 0 {
        let _ = fs::remove_file(&partial_path);
        existing = 0;
        response = request_artifact(&client, url, 0).await?;
    }
    let resumed = response_resumes(existing, response.status());
    if existing > 0 && !resumed {
        existing = 0;
        response = request_artifact(&client, url, 0).await?;
    }
    if !response.status().is_success() {
        return Err(format!("download DSH package: HTTP {}", response.status()));
    }
    let total_bytes = response
        .content_length()
        .map(|length| length.saturating_add(existing));
    let mut downloaded = existing;
    let mut file = if existing > 0 {
        tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&partial_path)
            .await
    } else {
        tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&partial_path)
            .await
    }
    .map_err(|e| format!("open DSH partial download: {e}"))?;
    let mut last_emit = Instant::now();
    emit_progress(app, "downloading", downloaded, total_bytes, resumed);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if DSH_UPDATE_CANCELLED.load(Ordering::Acquire) {
            emit_progress(app, "cancelled", downloaded, total_bytes, resumed);
            return Err(
                "DSH download cancelled; the partial download was kept for resume".to_string(),
            );
        }
        let chunk = chunk.map_err(|e| format!("read DSH package: {e}"))?;
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > MAX_DOWNLOAD_BYTES {
            return Err(format!(
                "DSH package exceeds {} MiB limit",
                MAX_DOWNLOAD_BYTES / 1024 / 1024
            ));
        }
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|e| format!("write DSH partial download: {e}"))?;
        if last_emit.elapsed() >= Duration::from_millis(100) {
            emit_progress(app, "downloading", downloaded, total_bytes, resumed);
            last_emit = Instant::now();
        }
    }
    tokio::io::AsyncWriteExt::flush(&mut file)
        .await
        .map_err(|e| format!("flush DSH partial download: {e}"))?;
    file.sync_all()
        .await
        .map_err(|e| format!("sync DSH partial download: {e}"))?;
    emit_progress(app, "downloaded", downloaded, total_bytes, resumed);
    let bytes = fs::read(&partial_path).map_err(|e| format!("read completed DSH package: {e}"))?;
    if bytes.is_empty() {
        return Err("downloaded DSH package is empty".to_string());
    }
    Ok(DownloadedArtifact {
        bytes,
        partial_path,
    })
}

async fn request_artifact(
    client: &Client,
    url: &str,
    existing: u64,
) -> Result<reqwest::Response, String> {
    let mut request = client.get(url);
    if existing > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
    }
    request
        .send()
        .await
        .map_err(|e| format!("download DSH package: {e}"))
}

fn emit_progress(
    app: Option<&AppHandle>,
    phase: &str,
    downloaded: u64,
    total: Option<u64>,
    resumed: bool,
) {
    let percent = total
        .filter(|value| *value > 0)
        .map(|value| ((downloaded.saturating_mul(100) / value).min(100)) as u8);
    let progress = DshDownloadProgress {
        phase: phase.to_string(),
        downloaded_bytes: downloaded,
        total_bytes: total,
        percent,
        resumed,
    };
    if let Ok(mut value) = download_progress_state().lock() {
        *value = Some(progress.clone());
    }
    if let Some(app) = app {
        let _ = app.emit(DSH_DOWNLOAD_PROGRESS_EVENT, progress);
    }
}

fn publish_install(
    root: &Path,
    staging: &Path,
    manifest: &DshManifest,
    target: &str,
    artifact: &DshArtifact,
) -> Result<(), String> {
    let metadata = validate_runtime_metadata(staging, manifest, target, artifact)?;
    let staged_launch = launch_from_metadata(staging, &metadata)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&staged_launch.executable)
            .map_err(|e| format!("inspect dsh-host: {e}"))?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&staged_launch.executable, permissions)
            .map_err(|e| format!("make dsh-host executable: {e}"))?;
    }
    let version_root = root.join("versions").join(&manifest.version);
    let backup = if version_root.exists() {
        let backup = version_root.with_file_name(format!(".replaced-{}", uuid::Uuid::new_v4()));
        fs::rename(&version_root, &backup)
            .map_err(|e| format!("stage previous DSH version: {e}"))?;
        Some(backup)
    } else {
        None
    };
    if let Err(error) = fs::rename(staging, &version_root) {
        if let Some(previous) = backup.as_ref() {
            let _ = fs::rename(previous, &version_root);
        }
        return Err(format!("publish DSH version: {error}"));
    }
    let installed_launch = launch_from_metadata(&version_root, &metadata)?;
    if let Err(error) = health_check(&installed_launch) {
        let _ = fs::remove_dir_all(&version_root);
        if let Some(previous) = backup.as_ref() {
            let _ = fs::rename(previous, &version_root);
        }
        return Err(error);
    }
    let current = CurrentDsh {
        version: manifest.version.clone(),
        target: target.to_string(),
        build_id: artifact.build_id.clone(),
        sha256: Some(artifact.sha256.trim().to_ascii_lowercase()),
        archive_size: artifact.size_bytes,
        installed_at: chrono::Utc::now().to_rfc3339(),
        runtime_type: metadata.runtime_type,
        node_executable: metadata.node_executable,
        entrypoint: metadata.entrypoint,
        cli_entrypoint: metadata.cli_entrypoint,
        pnpm_entrypoint: metadata.pnpm_entrypoint,
        node_version: metadata.node_version,
        node_abi: metadata.node_abi,
        pnpm_version: metadata.pnpm_version,
    };
    let current_path = root.join("current.json");
    let temp_path = root.join(format!(".current-{}.json", uuid::Uuid::new_v4()));
    let body =
        serde_json::to_vec_pretty(&current).map_err(|e| format!("serialize DSH state: {e}"))?;
    if let Err(error) = fs::write(&temp_path, body) {
        let _ = fs::remove_dir_all(&version_root);
        if let Some(previous) = backup.as_ref() {
            let _ = fs::rename(previous, &version_root);
        }
        return Err(format!("write DSH state: {error}"));
    }
    if let Err(error) = activate_current(&temp_path, &current_path) {
        let _ = fs::remove_file(&temp_path);
        let _ = fs::remove_dir_all(&version_root);
        if let Some(previous) = backup.as_ref() {
            let _ = fs::rename(previous, &version_root);
        }
        return Err(error);
    }
    if let Some(previous) = backup {
        if let Err(error) = fs::remove_dir_all(&previous) {
            // The active marker already points at the new, healthy version;
            // leave cleanup to the next install rather than reporting a
            // successful activation as a failed upgrade.
            tracing::warn!(path = %previous.display(), %error, "failed to remove replaced DSH version");
        }
    }
    cleanup_old_versions(root, &version_root);
    Ok(())
}

fn validate_runtime_metadata(
    staging: &Path,
    manifest: &DshManifest,
    target: &str,
    artifact: &DshArtifact,
) -> Result<DshRuntimeMetadata, String> {
    let path = staging.join("dsh-runtime.json");
    let metadata: DshRuntimeMetadata = serde_json::from_str(
        &fs::read_to_string(&path)
            .map_err(|e| format!("read DSH archive metadata {}: {e}", path.display()))?,
    )
    .map_err(|e| format!("parse DSH archive metadata: {e}"))?;
    if !matches!(metadata.schema_version, 1 | 2) || metadata.product != "flowix-dsh" {
        return Err("DSH archive metadata schema or product mismatch".to_string());
    }
    if metadata.version != manifest.version {
        return Err(format!(
            "DSH archive version mismatch: manifest={}, archive={}",
            manifest.version, metadata.version
        ));
    }
    if metadata.protocol_version != manifest.protocol_version
        || metadata.protocol_version != DSH_PROTOCOL_VERSION
    {
        return Err(format!(
            "DSH archive protocol mismatch: manifest={}, archive={}, client={}",
            manifest.protocol_version, metadata.protocol_version, DSH_PROTOCOL_VERSION
        ));
    }
    if target != target_key() || metadata.target != runtime_target_key() {
        return Err(format!(
            "DSH archive target mismatch: manifest={}, archive={}, client={}/{}",
            target,
            metadata.target,
            target_key(),
            runtime_target_key()
        ));
    }
    if metadata.includes_ui {
        return Err("DSH archive unexpectedly includes UI assets".to_string());
    }
    if metadata.runtime_type == "node-bundle" {
        if metadata
            .node_version
            .as_deref()
            .is_some_and(|value| !value.starts_with('v') || value.len() < 4)
        {
            return Err("DSH archive has an invalid nodeVersion".to_string());
        }
        if metadata.node_abi.as_deref().is_some_and(|value| {
            value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit())
        }) {
            return Err("DSH archive has an invalid nodeAbi".to_string());
        }
        if metadata
            .pnpm_version
            .as_deref()
            .is_some_and(|value| value != "11.7.0")
        {
            return Err("DSH archive uses an unsupported private pnpm version".to_string());
        }
    }
    let manifest_build_id = artifact
        .build_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("DSH manifest artifact is missing buildId")?;
    if metadata.build_id.trim().is_empty() || metadata.build_id != manifest_build_id {
        return Err(format!(
            "DSH archive buildId mismatch: manifest={}, archive={}",
            manifest_build_id, metadata.build_id
        ));
    }
    launch_from_metadata(staging, &metadata)?;
    Ok(metadata)
}

fn launch_from_metadata(
    root: &Path,
    metadata: &DshRuntimeMetadata,
) -> Result<ManagedDshLaunch, String> {
    if metadata.runtime_type == "node-bundle" {
        let node = safe_bundle_path(
            root,
            metadata
                .node_executable
                .as_deref()
                .ok_or("DSH node bundle is missing nodeExecutable")?,
            "nodeExecutable",
        )?;
        let entry = safe_bundle_path(
            root,
            metadata
                .entrypoint
                .as_deref()
                .ok_or("DSH node bundle is missing entrypoint")?,
            "entrypoint",
        )?;
        if !node.is_file() || !entry.is_file() {
            return Err("DSH node bundle executable or entrypoint is missing".to_string());
        }
        let cli_entrypoint = metadata
            .cli_entrypoint
            .as_deref()
            .map(|value| safe_bundle_path(root, value, "cliEntrypoint"))
            .transpose()?;
        if cli_entrypoint.as_ref().is_some_and(|path| !path.is_file()) {
            return Err("DSH node bundle CLI entrypoint is missing".to_string());
        }
        if let Some(value) = metadata.pnpm_entrypoint.as_deref() {
            let pnpm = safe_bundle_path(root, value, "pnpmEntrypoint")?;
            if !pnpm.is_file() {
                return Err("DSH node bundle private pnpm entrypoint is missing".to_string());
            }
        }
        return Ok(ManagedDshLaunch {
            executable: node,
            args: vec![entry],
            root: root.to_path_buf(),
            cli_entrypoint,
        });
    }
    let host = root.join(if cfg!(windows) {
        "dsh-host.exe"
    } else {
        "dsh-host"
    });
    if !host.is_file() {
        return Err("DSH archive does not contain dsh-host".to_string());
    }
    Ok(ManagedDshLaunch {
        executable: host,
        args: Vec::new(),
        root: root.to_path_buf(),
        cli_entrypoint: None,
    })
}

fn cleanup_old_versions(root: &Path, current_version_root: &Path) {
    let versions = root.join("versions");
    let entries = match fs::read_dir(&versions) {
        Ok(entries) => entries,
        Err(error) => {
            tracing::warn!(path = %versions.display(), %error, "failed to inspect old DSH versions");
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == current_version_root {
            continue;
        }
        let result = if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        if let Err(error) = result {
            tracing::warn!(path = %path.display(), %error, "failed to remove old DSH version");
        }
    }
}

/// Write a file that must stay owner-only. `dsh-credentials-local` rejects
/// `.credentials.yaml` unless its mode is 600; plain `fs::write` creates it
/// with the process umask (typically 644) and fails that assert.
fn write_private_file(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(contents)?;
        // `mode` only applies at creation; normalize pre-existing files too.
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        return Ok(());
    }
    #[cfg(not(unix))]
    {
        fs::write(path, contents)
    }
}

fn copy_profile_tree(source: &Path, target: &Path) -> Result<(), String> {
    if source.is_dir() {
        fs::create_dir_all(target).map_err(|e| format!("create DSH profile directory: {e}"))?;
        for entry in fs::read_dir(source).map_err(|e| format!("read DSH profile directory: {e}"))? {
            let entry = entry.map_err(|e| format!("read DSH profile entry: {e}"))?;
            copy_profile_tree(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create DSH profile parent: {e}"))?;
        }
        fs::copy(source, target).map_err(|e| format!("copy DSH profile file: {e}"))?;
    }
    Ok(())
}

fn health_check(launch: &ManagedDshLaunch) -> Result<(), String> {
    let root = &launch.root;
    let session_root = root.join(format!(".health-check-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&session_root)
        .map_err(|e| format!("create DSH health-check directory: {e}"))?;
    let dsh_home = session_root.join("dsh-home");
    fs::create_dir_all(&dsh_home).map_err(|e| format!("create DSH health-check home: {e}"))?;
    let settings_path = dsh_home.join("settings.yaml");
    let credentials_path = dsh_home.join(".credentials.yaml");
    copy_profile_tree(
        &root.join("profile").join(DEFAULT_PROFILE),
        &dsh_home.join("profiles").join(DEFAULT_PROFILE),
    )?;
    fs::write(&settings_path, b"llm-pi-ai:\n  providers: {}\n")
        .map_err(|e| format!("write DSH health-check settings: {e}"))?;
    write_private_file(&credentials_path, b"DSH_API_KEY: health-check\n")
        .map_err(|e| format!("write DSH health-check credentials: {e}"))?;
    let mut command = Command::new(&launch.executable);
    crate::process_window::hide_std_command_window(&mut command);
    command.args(&launch.args);
    // Node-bundle releases launch the official DSH CLI directly.  Unlike the
    // legacy embedded host, that CLI requires an explicit profile selection;
    // without it the process exits before App Server can answer initialize.
    if launch.cli_entrypoint.is_some() {
        command.args(["--profile", DEFAULT_PROFILE]);
    }
    let mut child = command
        .envs(managed_child_environment(root))
        .env("FLOWIX_DSH_SESSION_ROOT", &session_root)
        .env("DSH_HOME", &dsh_home)
        .env("DSH_SETTINGS_PATH", &settings_path)
        .env("DSH_CREDENTIALS_PATH", &credentials_path)
        .env("FLOWIX_DSH_ROOT", root)
        .env("FLOWIX_DSH_APPSERVER_STDIO", "1")
        .env(
            "DSH_PROFILE_DIR",
            dsh_home.join("profiles").join(DEFAULT_PROFILE),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("start DSH health check: {e}"))?;
    let stderr = Arc::new(Mutex::new(String::new()));
    if let Some(mut stream) = child.stderr.take() {
        let captured = Arc::clone(&stderr);
        std::thread::spawn(move || {
            let mut output = String::new();
            let _ = stream.read_to_string(&mut output);
            if let Ok(mut value) = captured.lock() {
                *value = output;
            }
        });
    }
    let result = (|| -> Result<(), String> {
        let mut stdin = child
            .stdin
            .take()
            .ok_or("DSH health-check stdin unavailable")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("DSH health-check stdout unavailable")?;
        let (line_tx, line_rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if line_tx
                    .send(line.map_err(|e| format!("read DSH health check: {e}")))
                    .is_err()
                {
                    break;
                }
            }
        });
        let initialize = rpc_health_request(
            &mut child,
            &mut stdin,
            &line_rx,
            &stderr,
            1,
            "initialize",
            serde_json::json!({
                "protocolVersion": DSH_PROTOCOL_VERSION,
                "clientInfo": { "name": "flowix-install-health-check", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": {}
            }),
        )?;
        let initialized = initialize
            .get("result")
            .ok_or("DSH App Server initialize returned no result")?;
        if initialized
            .get("protocolVersion")
            .and_then(serde_json::Value::as_u64)
            != Some(DSH_PROTOCOL_VERSION)
            || initialized
                .get("serverInfo")
                .and_then(|value| value.get("name"))
                .and_then(serde_json::Value::as_str)
                != Some("dsh-appserver")
        {
            return Err("DSH App Server initialize health check failed".to_string());
        }
        let thread = rpc_health_request(
            &mut child,
            &mut stdin,
            &line_rx,
            &stderr,
            2,
            "thread/start",
            serde_json::json!({
                "flowixThreadId": "flowix-install-health-check",
                "cwd": root,
                "workspacePaths": [],
                "provider": "openai",
                "model": "health-check-model",
                "agentPreset": "minimal",
                "permissionMode": "read-only"
            }),
        )?;
        let thread_id = thread
            .get("result")
            .and_then(|value| value.get("thread"))
            .and_then(|value| value.get("id"))
            .and_then(serde_json::Value::as_str)
            .ok_or("DSH App Server thread/start returned no threadId")?;
        rpc_health_request(
            &mut child,
            &mut stdin,
            &line_rx,
            &stderr,
            3,
            "thread/close",
            serde_json::json!({ "threadId": thread_id }),
        )?;
        rpc_health_request(
            &mut child,
            &mut stdin,
            &line_rx,
            &stderr,
            4,
            "shutdown",
            serde_json::json!({}),
        )?;
        Ok(())
    })();
    let _ = child.kill();
    let _ = child.wait();
    let _ = fs::remove_dir_all(&session_root);
    result
}

fn rpc_health_request(
    child: &mut Child,
    stdin: &mut impl Write,
    lines: &mpsc::Receiver<Result<String, String>>,
    stderr: &Arc<Mutex<String>>,
    id: u64,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    writeln!(stdin, "{request}").map_err(|e| format!("write DSH {method} health check: {e}"))?;
    stdin
        .flush()
        .map_err(|e| format!("flush DSH {method} health check: {e}"))?;
    let deadline = Instant::now() + HEALTH_CHECK_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let line = lines.recv_timeout(remaining).map_err(|error| {
            let diagnostic = stderr
                .lock()
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .map(|value| format!("; stderr={value}"))
                .unwrap_or_default();
            match error {
                mpsc::RecvTimeoutError::Timeout => {
                    format!("DSH {method} health check timed out{diagnostic}")
                }
                mpsc::RecvTimeoutError::Disconnected => {
                    let status = child
                        .try_wait()
                        .ok()
                        .flatten()
                        .map(|value| format!(" ({value})"))
                        .unwrap_or_default();
                    format!("DSH {method} health check process exited{status}{diagnostic}")
                }
            }
        })??;
        let frame: serde_json::Value = serde_json::from_str(line.trim())
            .map_err(|e| format!("parse DSH {method} health check: {e}"))?;
        if frame.get("id").and_then(serde_json::Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = frame.get("error") {
            let message = error
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown JSON-RPC error");
            return Err(format!("DSH {method} health check failed: {message}"));
        }
        return Ok(frame);
    }
}

fn current_installation() -> Option<DshInstallation> {
    let root = dsh_root();
    let current: CurrentDsh =
        serde_json::from_str(&fs::read_to_string(root.join("current.json")).ok()?).ok()?;
    validate_manifest_version(&current.version).ok()?;
    if current.target != target_key() {
        return None;
    }
    let version_root = root.join("versions").join(&current.version);
    let metadata = DshRuntimeMetadata {
        schema_version: 1,
        product: "flowix-dsh".to_string(),
        version: current.version.clone(),
        protocol_version: DSH_PROTOCOL_VERSION,
        build_id: current.build_id.clone().unwrap_or_default(),
        target: runtime_target_key().to_string(),
        includes_ui: false,
        runtime_type: current.runtime_type.clone(),
        node_executable: current.node_executable.clone(),
        entrypoint: current.entrypoint.clone(),
        cli_entrypoint: current.cli_entrypoint.clone(),
        pnpm_entrypoint: current.pnpm_entrypoint.clone(),
        node_version: current.node_version.clone(),
        node_abi: current.node_abi.clone(),
        pnpm_version: current.pnpm_version.clone(),
    };
    let launch = launch_from_metadata(&version_root, &metadata).ok()?;
    let host = launch
        .args
        .first()
        .cloned()
        .unwrap_or_else(|| launch.executable.clone());
    Some(DshInstallation {
        version: current.version,
        harness_version: harness_version_from_root(&version_root),
        host_path: host,
        build_id: current.build_id,
        sha256: current.sha256,
        archive_size: current.archive_size,
        launch,
    })
}

pub(crate) fn dsh_root() -> PathBuf {
    get_app_data_path().join(DSH_DIR_NAME)
}

fn target_key() -> &'static str {
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "darwin-aarch64"
        } else {
            "darwin-x86_64"
        }
    } else if cfg!(target_os = "windows") {
        "windows-x86_64"
    } else if cfg!(target_os = "linux") {
        if cfg!(target_arch = "aarch64") {
            "linux-aarch64"
        } else {
            "linux-x86_64"
        }
    } else {
        "unknown"
    }
}

fn runtime_target_key() -> &'static str {
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "node24-macos-arm64"
        } else {
            "node24-macos-x64"
        }
    } else if cfg!(target_os = "windows") {
        "node24-windows-x64"
    } else if cfg!(target_os = "linux") {
        if cfg!(target_arch = "aarch64") {
            "node24-linux-arm64"
        } else {
            "node24-linux-x64"
        }
    } else {
        "unknown"
    }
}

#[cfg(test)]
mod tests {
    use super::{
        archive::safe_archive_path, dsh_version_is_at_least, validate_manifest_version, DshArtifact,
    };
    use std::path::{Path, PathBuf};

    #[cfg(unix)]
    use super::DshManifest;
    #[cfg(unix)]
    use std::collections::HashMap;

    #[cfg(unix)]
    #[test]
    fn private_file_is_owner_only_on_create_and_normalize() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let fresh = dir.path().join("fresh.yaml");
        super::write_private_file(&fresh, b"a").unwrap();
        let mode = fresh.metadata().unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        // A pre-existing world-readable file must be tightened, not left at 644.
        let stale = dir.path().join("stale.yaml");
        std::fs::write(&stale, b"a").unwrap();
        std::fs::set_permissions(&stale, std::fs::Permissions::from_mode(0o644)).unwrap();
        super::write_private_file(&stale, b"b").unwrap();
        let mode = stale.metadata().unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(std::fs::read(&stale).unwrap(), b"b");
    }

    #[test]
    fn repairs_appserver_bundle_and_patch_in_an_existing_flowix_profile() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let home = temp.path().join("official-dsh-home");
        let target = home.join("profiles/flowix");
        std::fs::create_dir_all(source.join("node_modules/dsh-appserver/src")).unwrap();
        std::fs::create_dir_all(source.join("node_modules/dsh-flowix-memory/src")).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(
            source.join("node_modules/dsh-appserver/src/cordis-plugin.js"),
            "export {};",
        )
        .unwrap();
        std::fs::write(
            source.join("node_modules/dsh-flowix-memory/src/index.js"),
            "export {};",
        )
        .unwrap();
        std::fs::write(source.join("package.json"), br#"{"name":"dsh-profile-flowix","private":true,"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","dsh-appserver","dsh-flowix-memory"]}}}"#).unwrap();
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let patch_source = repo.join("scripts/dsh-dev-profile.patch.yml");
        std::fs::copy(&patch_source, source.join("cordis.patch.yml")).unwrap();
        std::fs::write(target.join("package.json"), br#"{"name":"dsh-profile-flowix","dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}"#).unwrap();
        std::fs::write(
            target.join("cordis.patch.yml"),
            "- id: user-custom-plugin\n  config:\n    enabled: true\n",
        )
        .unwrap();

        super::install_profile_from_source(&home, &source).unwrap();
        assert!(super::flowix_profile_installed(&home));
        let package: serde_json::Value =
            serde_json::from_slice(&std::fs::read(target.join("package.json")).unwrap()).unwrap();
        let bundles = package
            .pointer("/dsh/profile/bundles")
            .unwrap()
            .as_array()
            .unwrap();
        assert!(bundles.iter().any(|bundle| bundle == "dsh-appserver"));
        let patch: Vec<serde_yaml::Value> =
            serde_yaml::from_slice(&std::fs::read(target.join("cordis.patch.yml")).unwrap())
                .unwrap();
        assert!(patch
            .iter()
            .any(|entry| entry.get("id").and_then(serde_yaml::Value::as_str)
                == Some("user-custom-plugin")));
        assert!(patch
            .iter()
            .any(|entry| entry.get("id").and_then(serde_yaml::Value::as_str)
                == Some("dsh-appserver-extension")));
    }

    #[test]
    fn protects_only_flowix_profile_requirements_from_managed_removal() {
        assert!(super::is_required_flowix_profile_bundle(
            "@deepseek-ai/dsh-base"
        ));
        assert!(super::is_required_flowix_profile_bundle(
            "dsh-flowix-memory"
        ));
        assert!(!super::is_required_flowix_profile_bundle(
            "community-dsh-plugin"
        ));
    }

    #[test]
    fn rejects_archive_traversal() {
        assert!(safe_archive_path(Path::new("../escape")).is_err());
        assert!(safe_archive_path(Path::new("/absolute")).is_err());
        assert!(safe_archive_path(Path::new("dsh-host")).is_ok());
    }

    #[test]
    fn compares_dsh_versions_before_downloading() {
        assert!(dsh_version_is_at_least("1.2.0", "1.1.9").unwrap());
        assert!(!dsh_version_is_at_least("1.2.0", "1.2.1").unwrap());
        assert!(dsh_version_is_at_least("1.2.0", "1.2.0").unwrap());
        assert!(dsh_version_is_at_least("1.2.0", "bad-version").is_err());
    }

    #[test]
    fn rejects_unsafe_manifest_versions_before_path_use() {
        assert!(validate_manifest_version("1.2.3").is_ok());
        assert!(validate_manifest_version("1.2.3/../../escape").is_err());
        assert!(validate_manifest_version(" 1.2.3").is_err());
    }

    #[test]
    fn uninstall_removes_the_runtime_tree_and_is_idempotent() {
        let root = tempdir_runtime_root("uninstall-removes");
        let versions = root.join("versions").join("1.0.0");
        std::fs::create_dir_all(&versions).unwrap();
        std::fs::write(versions.join("dsh-host"), b"binary").unwrap();
        std::fs::create_dir_all(root.join("downloads")).unwrap();
        std::fs::write(root.join("downloads/leftover.part"), b"partial").unwrap();
        std::fs::write(
            root.join("current.json"),
            br#"{"version":"1.0.0","target":"test","buildId":null,"installedAt":"2026-01-01T00:00:00Z"}"#,
        )
        .unwrap();

        super::remove_runtime_root(&root).unwrap();
        assert!(!root.exists());

        // A second uninstall of an already-clean system is a no-op, not an error.
        super::remove_runtime_root(&root).unwrap();
    }

    #[test]
    fn uninstall_deactivates_before_deleting_so_partial_failures_report_uninstalled() {
        let root = tempdir_runtime_root("uninstall-partial");
        std::fs::create_dir_all(root.join("versions")).unwrap();
        std::fs::write(root.join("current.json"), "not-json").unwrap();

        super::remove_runtime_root(&root).unwrap();
        assert!(!root.exists());
    }

    #[test]
    fn uninstall_removes_a_runtime_tree_without_a_current_marker() {
        let root = tempdir_runtime_root("uninstall-without-marker");
        std::fs::create_dir_all(root.join("versions/1.0.0")).unwrap();
        std::fs::write(root.join("versions/1.0.0/dsh-host"), b"binary").unwrap();

        super::remove_runtime_root(&root).unwrap();
        assert!(!root.exists());
    }

    #[test]
    fn legacy_installation_without_checksum_is_not_reused() {
        let current = super::DshInstallation {
            version: "1.0.0".to_string(),
            harness_version: None,
            host_path: std::path::PathBuf::from("dsh-host"),
            build_id: Some("same-build".to_string()),
            sha256: None,
            archive_size: None,
            launch: super::ManagedDshLaunch {
                executable: std::path::PathBuf::from("dsh-host"),
                args: Vec::new(),
                root: std::path::PathBuf::from("."),
                cli_entrypoint: None,
            },
        };
        let artifact = DshArtifact {
            url: "https://example.test/dsh.tar.gz".to_string(),
            sha256: "0".repeat(64),
            signature: None,
            size_bytes: None,
            build_id: Some("same-build".to_string()),
        };

        assert!(!super::current_artifact_matches(&current, &artifact));
    }

    #[test]
    fn cleanup_old_versions_keeps_only_the_active_version() {
        let root = tempdir_runtime_root("cleanup-old-versions");
        let versions = root.join("versions");
        let active = versions.join("2.0.0");
        let previous = versions.join("1.0.0");
        std::fs::create_dir_all(&active).unwrap();
        std::fs::create_dir_all(&previous).unwrap();
        std::fs::create_dir_all(versions.join("0.9.0")).unwrap();
        std::fs::create_dir_all(versions.join(".replaced-old")).unwrap();
        std::fs::write(versions.join(".installing-stale"), b"stale").unwrap();

        super::cleanup_old_versions(&root, &active);

        assert!(active.exists());
        assert!(!previous.exists());
        assert!(!versions.join("0.9.0").exists());
        assert!(!versions.join(".replaced-old").exists());
        assert!(!versions.join(".installing-stale").exists());
    }

    #[test]
    fn activation_replaces_the_previous_marker() {
        let root = tempdir_runtime_root("activation");
        let current = root.join("current.json");
        let temp = root.join(".current-new.json");
        std::fs::write(&current, b"old").unwrap();
        std::fs::write(&temp, b"new").unwrap();

        super::activation::activate_current(&temp, &current).unwrap();
        assert_eq!(std::fs::read(&current).unwrap(), b"new");
        assert!(!temp.exists());
    }

    #[cfg(unix)]
    #[test]
    fn reinstalling_existing_version_replaces_the_previous_directory() {
        let root = tempdir_runtime_root("reinstall-existing");
        let version = "1.0.0";
        let version_root = root.join("versions").join(version);
        std::fs::create_dir_all(&version_root).unwrap();
        std::fs::write(version_root.join("dsh-host"), b"old-host").unwrap();

        let staging = root.join("versions").join(".installing-test");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(
            staging.join("dsh-host"),
            b"#!/bin/sh\nread request\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":1,\"serverInfo\":{\"name\":\"dsh-appserver\"},\"buildId\":\"test-build\",\"capabilities\":[\"model-catalog\",\"model-discovery\",\"plugin-catalog\",\"runtime-profile\",\"credentials-management\",\"model-settings-management\"]}}'\nread request\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"thread\":{\"id\":\"health\"}}}'\nread request\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"capabilities\":[\"runtime-events\",\"session-control\",\"credentials-management\",\"model-settings-management\"]}}'\nread request\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{\"disposed\":true}}'\nread request\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":5,\"result\":{\"ok\":true}}'\n",
        )
        .unwrap();
        std::fs::create_dir_all(staging.join("profile/flowix")).unwrap();
        std::fs::write(
            staging.join("profile/flowix/package.json"),
            b"{\"name\":\"dsh-profile-flowix\",\"private\":true}",
        )
        .unwrap();
        write_test_runtime_metadata(&staging, version, "test-build");

        let manifest = DshManifest {
            schema_version: 1,
            product: "flowix-dsh".to_string(),
            version: version.to_string(),
            protocol_version: super::DSH_PROTOCOL_VERSION,
            min_flowix_version: None,
            platforms: HashMap::new(),
        };
        let artifact = DshArtifact {
            url: "https://example.test/dsh.tar.gz".to_string(),
            sha256: "0".repeat(64),
            signature: None,
            size_bytes: None,
            build_id: Some("test-build".to_string()),
        };

        super::publish_install(&root, &staging, &manifest, super::target_key(), &artifact).unwrap();
        assert!(std::fs::read(version_root.join("dsh-host"))
            .unwrap()
            .starts_with(b"#!/bin/sh"));
        assert!(!root.join("versions").join(".installing-test").exists());
        assert!(root.join("current.json").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn failed_health_check_restores_the_previous_version_directory() {
        let root = tempdir_runtime_root("reinstall-rollback");
        let version = "1.0.0";
        let version_root = root.join("versions").join(version);
        std::fs::create_dir_all(&version_root).unwrap();
        std::fs::write(version_root.join("dsh-host"), b"old-host").unwrap();

        let staging = root.join("versions").join(".installing-test");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(
            staging.join("dsh-host"),
            b"#!/bin/sh\nread request\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":999}}'\nread request\n",
        )
        .unwrap();
        write_test_runtime_metadata(&staging, version, "test-build");

        let manifest = DshManifest {
            schema_version: 1,
            product: "flowix-dsh".to_string(),
            version: version.to_string(),
            protocol_version: super::DSH_PROTOCOL_VERSION,
            min_flowix_version: None,
            platforms: HashMap::new(),
        };
        let artifact = DshArtifact {
            url: "https://example.test/dsh.tar.gz".to_string(),
            sha256: "0".repeat(64),
            signature: None,
            size_bytes: None,
            build_id: Some("test-build".to_string()),
        };

        assert!(
            super::publish_install(&root, &staging, &manifest, super::target_key(), &artifact,)
                .is_err()
        );
        assert_eq!(
            std::fs::read(version_root.join("dsh-host")).unwrap(),
            b"old-host"
        );
    }

    fn tempdir_runtime_root(prefix: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("flowix-dsh-test-{prefix}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_test_runtime_metadata(root: &Path, version: &str, build_id: &str) {
        std::fs::write(
            root.join("dsh-runtime.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "product": "flowix-dsh",
                "version": version,
                "protocolVersion": super::DSH_PROTOCOL_VERSION,
                "buildId": build_id,
                "target": super::runtime_target_key(),
                "includesUi": false,
            }))
            .unwrap(),
        )
        .unwrap();
    }
}
