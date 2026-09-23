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
use tauri::{AppHandle, Emitter};

use crate::app::paths::get_app_data_path;

mod activation;
mod archive;
mod cleanup;
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
    if let Some(result) = development_bundle_launch_spec() {
        return match result {
            Ok(launch) => DshStatus {
                installed: true,
                executable_path: Some(launch.executable.display().to_string()),
                version: Some("dev".to_string()),
                harness_version: harness_version_from_root(&launch.root),
                source: Some("flowix-dev-bundle".to_string()),
                profile: DEFAULT_PROFILE.to_string(),
                message: None,
                archive_size: None,
            },
            Err(message) => DshStatus {
                installed: false,
                executable_path: None,
                version: None,
                harness_version: None,
                source: Some("flowix-dev-bundle".to_string()),
                profile: DEFAULT_PROFILE.to_string(),
                message: Some(message),
                archive_size: None,
            },
        };
    }
    match current_installation() {
        Some(installation) => DshStatus {
            installed: true,
            executable_path: Some(installation.host_path.display().to_string()),
            version: Some(installation.version.clone()),
            harness_version: installation.harness_version.clone(),
            source: Some("flowix-managed".to_string()),
            profile: DEFAULT_PROFILE.to_string(),
            message: None,
            archive_size: installation.archive_size,
        },
        None => DshStatus {
            installed: false,
            executable_path: None,
            version: None,
            harness_version: None,
            source: None,
            profile: DEFAULT_PROFILE.to_string(),
            message: Some("DeepSeek Harness is not installed".to_string()),
            archive_size: None,
        },
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

/// Best-effort size lookup for the install card. A manifest outage must not
/// make the DSH preferences page unusable or block installation.
pub fn latest_archive_size() -> Option<u64> {
    let client = BlockingClient::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .ok()?;
    let manifest: DshManifest = client
        .get(manifest_url())
        .send()
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .ok()?;
    manifest
        .platforms
        .get(target_key())
        .and_then(|artifact| artifact.size_bytes)
}

/// Download and atomically install the current platform's DSH archive.
/// Network and archive work is intentionally synchronous; the Tauri command
/// runs it on a blocking worker so the UI thread remains responsive.
pub fn install_runtime_with_progress(app: Option<AppHandle>) -> Result<DshStatus, String> {
    install_runtime_with_progress_before_publish(app, || Ok(()))
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

/// Remove the Flowix-managed DSH runtime tree. `prepare` must have shut down
/// every dsh-host child process first; the caller is expected to invoke the
/// manager's `prepare_uninstall` before reaching this function. Only the
/// runtime tree under the Flowix data directory (`<app data>/dsh`) is removed
/// — user state in `~/.dsh/` (settings, sessions) is deliberately preserved.
pub fn uninstall_runtime() -> Result<DshStatus, String> {
    let _operation_guard = try_acquire_operation_lock()?;
    remove_runtime_root(&dsh_root()).map(|_| status())
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
    let launch = managed_launch_spec().ok_or("DeepSeek Harness runtime is not installed")?;
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

    let mut command = Command::new(&launch.executable);
    crate::process_window::hide_std_command_window(&mut command);
    if let Some(cli) = launch.cli_entrypoint.as_ref() {
        command.arg(cli);
    } else {
        command.env("DSH_EMBEDDED_CLI_MODE", "1");
    }
    command
        .env_clear()
        .envs(dsh_plugin_environment())
        .envs(managed_child_environment(&launch.root))
        .env("DSH_HOME", dsh_home)
        .env("FLOWIX_DSH_ROOT", &launch.root)
        .args(["plugin", "--profile", DEFAULT_PROFILE, action]);
    if let Some(package) = package {
        command.arg(package);
    }
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

/// Used by the Rust host resolver. The path is versioned and never points at
/// a partially downloaded archive.
pub fn managed_host_path() -> Option<PathBuf> {
    current_installation().map(|installation| installation.launch.executable)
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
    use super::{archive::safe_archive_path, dsh_version_is_at_least, validate_manifest_version};
    use std::path::Path;

    #[cfg(unix)]
    use super::{DshArtifact, DshManifest};
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
