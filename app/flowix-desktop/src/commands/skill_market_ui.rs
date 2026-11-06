use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

use crate::app::state::AppState;

const MANIFEST_PATH: &str = "/v1/desktop/skill-market-ui/manifest";
const MAX_ARCHIVE_BYTES: usize = 50 * 1024 * 1024;
const MAX_EXPANDED_BYTES: usize = 80 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 100;
const REQUIRED_FILES: [&str; 5] = [
    "index.html",
    "en/index.html",
    "css/skill-market.css",
    "js/skill-market.js",
    "assets/favicon.ico",
];

static MARKET_UI_INSTALL_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketUiManifest {
    schema_version: u32,
    product: String,
    version: String,
    size_bytes: usize,
    sha256: String,
    bundle_path: String,
    entrypoints: MarketUiEntrypoints,
}

#[derive(Debug, Deserialize)]
struct MarketUiEntrypoints {
    #[serde(rename = "zh-CN")]
    zh_cn: String,
    #[serde(rename = "en-US")]
    en_us: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMarketUiPage {
    entry_path: String,
    cached: bool,
}

#[tauri::command]
pub async fn ensure_skill_market_ui(
    app: AppHandle,
    state: State<'_, AppState>,
    language: String,
) -> Result<SkillMarketUiPage, String> {
    let cloud_base = state.cloud_environment.api_base().to_string();
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("resolve Flowix data directory: {error}"))?
        .join("skill-market-ui")
        .join(state.cloud_environment.name());
    ensure_entry_path(cloud_base, root, &language).await
}

async fn ensure_entry_path(
    cloud_base: String,
    root: std::path::PathBuf,
    language: &str,
) -> Result<SkillMarketUiPage, String> {
    // A valid local page never waits for the network or an in-flight update.
    if let Some(version) = read_current_version(&root) {
        refresh_in_background(cloud_base, root.clone(), version.clone());
        return Ok(SkillMarketUiPage {
            entry_path: entry_path(&root, &version, language),
            cached: true,
        });
    }

    let _lock = install_lock().lock().await;
    // Another first-open request may have populated the cache while we waited.
    let version = match read_current_version(&root) {
        Some(version) => version,
        None => ensure_latest_bundle(&cloud_base, &root, None).await?,
    };
    Ok(SkillMarketUiPage {
        entry_path: entry_path(&root, &version, language),
        cached: false,
    })
}

fn install_lock() -> &'static tokio::sync::Mutex<()> {
    MARKET_UI_INSTALL_LOCK.get_or_init(tokio::sync::Mutex::default)
}

fn entry_path(root: &Path, version: &str, language: &str) -> String {
    let entry = if language == "en-US" {
        "en/index.html"
    } else {
        "index.html"
    };
    root.join("versions")
        .join(version)
        .join(entry)
        .display()
        .to_string()
}

fn refresh_in_background(cloud_base: String, root: std::path::PathBuf, version: String) {
    // Coalesce overlapping checks rather than queueing one check per click.
    let Ok(guard) = install_lock().try_lock() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        if let Err(error) = ensure_latest_bundle(&cloud_base, &root, Some(&version)).await {
            tracing::debug!(%error, "Background market UI update failed; keeping cached page");
        }
    });
}

async fn ensure_latest_bundle(
    cloud_base: &str,
    root: &Path,
    current_version: Option<&str>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|error| format!("create Skill Market UI client: {error}"))?;
    let manifest_url = format!("{cloud_base}{MANIFEST_PATH}");
    let response = client
        .get(&manifest_url)
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .send()
        .await
        .map_err(|error| format!("check Skill Market UI version: {error}"))?
        .error_for_status()
        .map_err(|error| format!("check Skill Market UI version: {error}"))?;
    let manifest: MarketUiManifest = response
        .json()
        .await
        .map_err(|error| format!("read Skill Market UI manifest: {error}"))?;
    validate_manifest(&manifest)?;

    if let Some(current_version) = current_version {
        let current = semver::Version::parse(current_version)
            .map_err(|error| format!("read cached Skill Market UI version: {error}"))?;
        let latest = semver::Version::parse(&manifest.version)
            .map_err(|error| format!("read published Skill Market UI version: {error}"))?;
        if current_version == manifest.version || current > latest {
            return Ok(current_version.to_string());
        }
    }
    if valid_installed_version(root, &manifest.version) {
        write_current_version(root, &manifest.version)?;
        return Ok(manifest.version);
    }

    let bundle_url = format!("{cloud_base}{}", manifest.bundle_path);
    let mut response = client
        .get(bundle_url)
        .send()
        .await
        .map_err(|error| format!("download Skill Market UI: {error}"))?
        .error_for_status()
        .map_err(|error| format!("download Skill Market UI: {error}"))?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_ARCHIVE_BYTES as u64)
    {
        return Err("Skill Market UI bundle exceeds its size limit".to_string());
    }
    let mut bytes = Vec::with_capacity(manifest.size_bytes.min(MAX_ARCHIVE_BYTES));
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("read Skill Market UI bundle: {error}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_ARCHIVE_BYTES {
            return Err("Skill Market UI bundle exceeds its size limit".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.len() != manifest.size_bytes {
        return Err("Skill Market UI bundle size does not match its manifest".to_string());
    }
    let digest = Sha256::digest(&bytes);
    if format!("{digest:x}") != manifest.sha256.to_ascii_lowercase() {
        return Err("Skill Market UI bundle failed its SHA-256 check".to_string());
    }

    let root = root.to_path_buf();
    let version = manifest.version;
    tokio::task::spawn_blocking(move || {
        install_bundle(&root, &version, &bytes)?;
        write_current_version(&root, &version)?;
        Ok(version)
    })
    .await
    .map_err(|error| format!("install Skill Market UI task failed: {error}"))?
}

fn validate_manifest(manifest: &MarketUiManifest) -> Result<(), String> {
    if manifest.schema_version != 1 || manifest.product != "flowix-skill-market-ui" {
        return Err("Skill Market UI manifest has an unsupported format".to_string());
    }
    if !valid_version(&manifest.version)
        || manifest.size_bytes == 0
        || manifest.size_bytes > MAX_ARCHIVE_BYTES
        || manifest.sha256.len() != 64
        || !manifest.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Skill Market UI manifest contains invalid release metadata".to_string());
    }
    let expected_bundle_path = format!(
        "/v1/desktop/skill-market-ui/versions/{}/bundle.zip",
        manifest.version
    );
    if manifest.bundle_path != expected_bundle_path
        || manifest.entrypoints.zh_cn != "index.html"
        || manifest.entrypoints.en_us != "en/index.html"
    {
        return Err("Skill Market UI manifest contains unsupported paths".to_string());
    }
    Ok(())
}

fn valid_version(version: &str) -> bool {
    semver::Version::parse(version).is_ok()
}

fn valid_installed_version(root: &Path, version: &str) -> bool {
    if !valid_version(version) {
        return false;
    }
    let directory = root.join("versions").join(version);
    REQUIRED_FILES
        .iter()
        .all(|file| directory.join(file).is_file())
}

fn read_current_version(root: &Path) -> Option<String> {
    [
        root.join("current-version"),
        root.join("current-version.previous"),
    ]
    .into_iter()
    .filter_map(|path| fs::read_to_string(path).ok())
    .map(|version| version.trim().to_string())
    .find(|version| valid_installed_version(root, version))
}

fn write_current_version(root: &Path, version: &str) -> Result<(), String> {
    if !valid_version(version) {
        return Err("Refusing to activate an invalid Skill Market UI version".to_string());
    }
    fs::create_dir_all(root).map_err(|error| format!("create Skill Market UI cache: {error}"))?;
    let temporary = root.join(format!(".current-version-{}", uuid::Uuid::new_v4()));
    let target = root.join("current-version");
    let previous = root.join("current-version.previous");
    fs::write(&temporary, version)
        .map_err(|error| format!("write Skill Market UI version: {error}"))?;
    if previous.exists() {
        fs::remove_file(&previous)
            .map_err(|error| format!("remove previous Skill Market UI pointer: {error}"))?;
    }
    if target.exists() {
        fs::rename(&target, &previous)
            .map_err(|error| format!("stage current Skill Market UI pointer: {error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, &target) {
        let _ = fs::remove_file(temporary);
        if previous.exists() {
            let _ = fs::rename(&previous, &target);
        }
        return Err(format!("activate Skill Market UI version: {error}"));
    }
    let _ = fs::remove_file(previous);
    Ok(())
}

fn install_bundle(root: &Path, version: &str, bytes: &[u8]) -> Result<(), String> {
    let staging_root = root.join(format!(".installing-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&staging_root)
        .map_err(|error| format!("create Skill Market UI staging directory: {error}"))?;
    let result = extract_bundle(&staging_root, bytes);
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&staging_root);
        return Err(error);
    }
    if !REQUIRED_FILES
        .iter()
        .all(|file| staging_root.join(file).is_file())
    {
        let _ = fs::remove_dir_all(&staging_root);
        return Err("Skill Market UI bundle is missing a required file".to_string());
    }

    let versions = root.join("versions");
    fs::create_dir_all(&versions)
        .map_err(|error| format!("create Skill Market UI versions directory: {error}"))?;
    let target = versions.join(version);
    if target.exists() {
        fs::remove_dir_all(&target)
            .map_err(|error| format!("replace invalid Skill Market UI version: {error}"))?;
    }
    fs::rename(&staging_root, &target).map_err(|error| {
        let _ = fs::remove_dir_all(&staging_root);
        format!("publish Skill Market UI version: {error}")
    })
}

fn extract_bundle(root: &Path, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_ARCHIVE_BYTES {
        return Err("Skill Market UI bundle exceeds its size limit".to_string());
    }
    let mut archive = zip::ZipArchive::new(io::Cursor::new(bytes))
        .map_err(|error| format!("invalid Skill Market UI bundle: {error}"))?;
    if archive.len() == 0 || archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("Skill Market UI bundle contains an invalid number of files".to_string());
    }
    let mut expanded_bytes = 0usize;
    let mut seen = std::collections::HashSet::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("read Skill Market UI bundle entry: {error}"))?;
        let name = entry.name().to_string();
        let mode = entry.unix_mode().unwrap_or(0);
        let kind = mode & 0o170000;
        if kind != 0 && kind != 0o100000 && kind != 0o040000 {
            return Err("Skill Market UI bundle contains a special file".to_string());
        }
        let normalized = name.trim_end_matches('/');
        if !valid_bundle_path(normalized) || !seen.insert(normalized.to_string()) {
            return Err("Skill Market UI bundle contains an invalid or duplicate path".to_string());
        }
        let destination = root.join(normalized);
        if entry.is_dir() {
            if entry.size() != 0 || !matches!(normalized, "en" | "css" | "js" | "assets") {
                return Err("Skill Market UI bundle contains an unexpected directory".to_string());
            }
            fs::create_dir_all(destination)
                .map_err(|error| format!("create Skill Market UI asset directory: {error}"))?;
            continue;
        }
        if kind == 0o040000
            || !REQUIRED_FILES.contains(&normalized)
            || entry.size() > MAX_EXPANDED_BYTES as u64
        {
            return Err("Skill Market UI bundle contains an unexpected file".to_string());
        }
        expanded_bytes = expanded_bytes.saturating_add(entry.size() as usize);
        if expanded_bytes > MAX_EXPANDED_BYTES {
            return Err("Skill Market UI bundle expands beyond its size limit".to_string());
        }
        let mut content = Vec::with_capacity(entry.size() as usize);
        entry
            .by_ref()
            .take(MAX_EXPANDED_BYTES as u64 + 1)
            .read_to_end(&mut content)
            .map_err(|error| format!("extract Skill Market UI bundle entry: {error}"))?;
        if content.len() as u64 != entry.size() {
            return Err("Skill Market UI bundle entry size is invalid".to_string());
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create Skill Market UI asset directory: {error}"))?;
        }
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&destination)
            .map_err(|error| format!("write Skill Market UI asset: {error}"))?;
        output
            .write_all(&content)
            .map_err(|error| format!("write Skill Market UI asset: {error}"))?;
        output
            .flush()
            .map_err(|error| format!("finish Skill Market UI asset: {error}"))?;
    }
    Ok(())
}

fn valid_bundle_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 256
        && !path.starts_with('/')
        && !path.contains('\\')
        && path.split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cached_page_opens_even_while_an_update_holds_the_install_lock() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_path_buf();
        for file in REQUIRED_FILES {
            let target = root.join("versions/1.0.0").join(file);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, b"cached").unwrap();
        }
        write_current_version(&root, "1.0.0").unwrap();
        let _updating = install_lock().lock().await;
        let cached = tokio::time::timeout(
            Duration::from_secs(1),
            ensure_entry_path("not-a-network-address".into(), root.clone(), "en-US"),
        )
        .await
        .expect("cached pages must not wait for the update lock or network")
        .unwrap();
        assert_eq!(
            cached.entry_path,
            root.join("versions/1.0.0/en/index.html")
                .display()
                .to_string()
        );
        assert!(cached.cached);
    }

    #[tokio::test]
    async fn first_open_reports_download_failure_instead_of_returning_a_missing_page() {
        let directory = tempfile::tempdir().unwrap();
        let result = ensure_entry_path(
            "not-a-network-address".into(),
            directory.path().to_path_buf(),
            "zh-CN",
        )
        .await;
        assert!(result.is_err());
        assert!(read_current_version(directory.path()).is_none());
    }
}
