use once_cell::sync::Lazy;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::app::state::AppState;
use crate::USER_CONFIG_DIR_NAME;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontCacheStatus {
    pub font_id: String,
    pub cached: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedFontFile {
    pub family: String,
    pub weight: String,
    pub style: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedFontResult {
    pub font_id: String,
    pub downloaded: bool,
    pub files: Vec<CachedFontFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FontDownloadProgress {
    font_id: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    percent: Option<u8>,
}

const FONT_DOWNLOAD_PROGRESS_EVENT: &str = "font-download-progress";
const MAX_FONT_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CACHED_FONT_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_FONT_LICENSE_BYTES: u64 = 256 * 1024;
static FONT_CACHE_LOCKS: Lazy<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static FONT_SELECTION_SEQUENCE: Lazy<StdMutex<u64>> = Lazy::new(|| StdMutex::new(0));

#[tauri::command]
pub fn begin_font_selection() -> u64 {
    let mut sequence = FONT_SELECTION_SEQUENCE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *sequence = sequence.wrapping_add(1);
    *sequence
}

#[tauri::command]
pub fn commit_font_selection(
    selection_id: u64,
    font_id: String,
    font_family: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<bool, String> {
    let sequence = FONT_SELECTION_SEQUENCE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if *sequence != selection_id {
        return Ok(false);
    }

    if !is_supported_preference_font(&font_id) || font_family.len() > 512 {
        return Err(format!("unsupported font id: {font_id}"));
    }
    state
        .user_config
        .set_preferred_font(font_id, font_family)
        .map_err(|error| error.to_string())?;
    let _ = app.emit("user-config-changed", "preference");
    Ok(true)
}

fn is_supported_preference_font(font_id: &str) -> bool {
    matches!(
        font_id,
        "inter"
            | "nunito-sans"
            | "noto-sans-sc"
            | "noto-serif-sc"
            | "lxgw-wenkai"
            | "pingfang-sc"
            | "microsoft-yahei"
            | "system-ui"
            | "serif"
            | "monospace"
    )
}

#[derive(Debug, Clone)]
struct FontDefinition {
    id: &'static str,
    archive_url: &'static str,
    archive_sha256: &'static str,
    archive_files: &'static [RemoteFontFile],
}

#[derive(Debug, Clone)]
struct RemoteFontFile {
    family: &'static str,
    weight: &'static str,
    style: &'static str,
    file_name: &'static str,
    sha256: &'static str,
}

const LXGW_WENKAI_FILES: &[RemoteFontFile] = &[
    RemoteFontFile {
        family: "霞鹜文楷",
        weight: "300",
        style: "normal",
        file_name: "LXGWWenKai-Light.woff2",
        sha256: "89eac7b90eac43b0107aadae059c19b5d2ee364e5cb3446b8a744888b953791f",
    },
    RemoteFontFile {
        family: "霞鹜文楷",
        weight: "400",
        style: "normal",
        file_name: "LXGWWenKai-Regular.woff2",
        sha256: "affc1418e51e3a2324d39dd011caefdc2914f20b0756f063d1d09d0ece81ec2d",
    },
    RemoteFontFile {
        family: "霞鹜文楷",
        weight: "500",
        style: "normal",
        file_name: "LXGWWenKai-Medium.woff2",
        sha256: "5e68b006ac745db42b8eac829b98ad8b3557b80407c06fdb0c453a61a10ff09e",
    },
];

const NOTO_SANS_SC_FILES: &[RemoteFontFile] = &[RemoteFontFile {
    family: "Noto Sans SC",
    weight: "100 900",
    style: "normal",
    file_name: "NotoSansSC-VF.woff2",
    sha256: "d238a6158deb73fe0287e8a862437124491f2c3865b4da074d668f31bc38d30e",
}];

const NOTO_SERIF_SC_FILES: &[RemoteFontFile] = &[RemoteFontFile {
    family: "Noto Serif SC",
    weight: "200 900",
    style: "normal",
    file_name: "NotoSerifSC-VF.woff2",
    sha256: "13227a1e1d6a40c7beb843687400d235dfe3fad2a6600472dccdadabc43d70b4",
}];

const LXGW_WENKAI_ARCHIVE_URL: &str =
    "https://download.flowix-memo.com/fonts/lxgw-wenkai/v1.522/lxgw-wenkai-v1.522.zip";
const NOTO_SANS_SC_ARCHIVE_URL: &str =
    "https://download.flowix-memo.com/fonts/noto-sans-sc/google-fonts-23e54b5-v1/noto-sans-sc.zip";
const NOTO_SERIF_SC_ARCHIVE_URL: &str = "https://download.flowix-memo.com/fonts/noto-serif-sc/google-fonts-23e54b5-v1/noto-serif-sc.zip";

const FONT_DEFINITIONS: &[FontDefinition] = &[
    FontDefinition {
        id: "noto-sans-sc",
        archive_url: NOTO_SANS_SC_ARCHIVE_URL,
        archive_sha256: "bca5910cb10c45ab2059f960574c8e1912e9b2e2cee8f54599ed3ba37c014f57",
        archive_files: NOTO_SANS_SC_FILES,
    },
    FontDefinition {
        id: "noto-serif-sc",
        archive_url: NOTO_SERIF_SC_ARCHIVE_URL,
        archive_sha256: "be378355ba1979a8227c69f8bd9b9da4f6b30ea9945a9ac4bf93c24aa4f626a1",
        archive_files: NOTO_SERIF_SC_FILES,
    },
    FontDefinition {
        id: "lxgw-wenkai",
        archive_url: LXGW_WENKAI_ARCHIVE_URL,
        archive_sha256: "ac8d33bca3a1dab9863e178c33488070020c906659e23e8e1a9f970440c711c7",
        archive_files: LXGW_WENKAI_FILES,
    },
];

#[tauri::command]
pub fn get_font_cache_status() -> Vec<FontCacheStatus> {
    FONT_DEFINITIONS
        .iter()
        .map(|definition| FontCacheStatus {
            font_id: definition.id.to_string(),
            // This is called when the typography preferences page opens.
            // Avoid hashing whole font files here; a cache presence check is
            // enough for the UI hint, while full integrity validation remains
            // in ensure_font_cached and get_cached_font_bytes.
            cached: cached_font_metadata_present(definition),
        })
        .collect()
}

#[tauri::command]
pub async fn ensure_font_cached(
    app: AppHandle,
    font_id: String,
) -> Result<CachedFontResult, String> {
    let definition = FONT_DEFINITIONS
        .iter()
        .find(|definition| definition.id == font_id)
        .ok_or_else(|| format!("unsupported font id: {font_id}"))?;

    let font_lock = font_cache_lock(&font_id).await;
    let _guard = font_lock.lock().await;

    if let Some(result) = cached_font_result(definition) {
        return Ok(result);
    }

    download_font(&app, definition).await
}

#[tauri::command]
pub fn get_cached_font_bytes(
    font_id: String,
    file_index: usize,
) -> Result<tauri::ipc::Response, String> {
    let definition = FONT_DEFINITIONS
        .iter()
        .find(|definition| definition.id == font_id)
        .ok_or_else(|| format!("unsupported font id: {font_id}"))?;
    let font = definition
        .archive_files
        .get(file_index)
        .ok_or("font file index is invalid")?;
    let path = font_dir(definition.id).join(font.file_name);
    let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if !(4..=MAX_CACHED_FONT_FILE_BYTES).contains(&size) {
        return Err("cached font file has an invalid size".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() as u64 != size || format!("{:x}", Sha256::digest(&bytes)) != font.sha256 {
        return Err("cached font file failed its integrity check".into());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

async fn font_cache_lock(font_id: &str) -> Arc<Mutex<()>> {
    let mut locks = FONT_CACHE_LOCKS.lock().await;
    locks
        .entry(font_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

async fn download_font(
    app: &AppHandle,
    definition: &FontDefinition,
) -> Result<CachedFontResult, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 Flowix Font Cache")
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    download_font_archive(app, &client, definition).await
}

async fn download_font_archive(
    app: &AppHandle,
    client: &reqwest::Client,
    definition: &FontDefinition,
) -> Result<CachedFontResult, String> {
    let mut response = client
        .get(definition.archive_url)
        .send()
        .await
        .map_err(|e| format!("failed to download font archive: {e}"))?
        .error_for_status()
        .map_err(|e| format!("font archive request failed: {e}"))?;
    let total_bytes = response.content_length();
    if total_bytes.is_some_and(|size| size > MAX_FONT_ARCHIVE_BYTES) {
        return Err("font archive exceeds the 64 MiB limit".into());
    }

    let root = fonts_root();
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let final_dir = font_dir(definition.id);
    let tmp_dir = root.join(format!("{}.tmp-{}", definition.id, uuid::Uuid::new_v4()));
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    let result = async {
        let archive_path = tmp_dir.join("font-bundle.zip");
        let mut archive_file = fs::File::create(&archive_path).map_err(|e| e.to_string())?;
        let mut downloaded_bytes = 0_u64;
        let mut last_progress_bytes = 0_u64;
        let mut archive_hasher = Sha256::new();
        emit_font_download_progress(app, definition.id, 0, total_bytes);
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("failed to read font archive: {e}"))?
        {
            downloaded_bytes = downloaded_bytes.saturating_add(chunk.len() as u64);
            if downloaded_bytes > MAX_FONT_ARCHIVE_BYTES {
                return Err("font archive exceeds the 64 MiB limit".into());
            }
            archive_hasher.update(&chunk);
            archive_file.write_all(&chunk).map_err(|e| e.to_string())?;
            if downloaded_bytes.saturating_sub(last_progress_bytes) >= 256 * 1024 {
                emit_font_download_progress(app, definition.id, downloaded_bytes, total_bytes);
                last_progress_bytes = downloaded_bytes;
            }
        }
        archive_file.flush().map_err(|e| e.to_string())?;
        if downloaded_bytes == 0 || total_bytes.is_some_and(|size| size != downloaded_bytes) {
            return Err("downloaded font archive is empty or incomplete".into());
        }
        let actual_sha256 = format!("{:x}", archive_hasher.finalize());
        if actual_sha256 != definition.archive_sha256 {
            return Err("font archive SHA-256 checksum mismatch".into());
        }
        emit_font_download_progress(app, definition.id, downloaded_bytes, total_bytes);
        drop(archive_file);

        let archive_file = fs::File::open(&archive_path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(archive_file)
            .map_err(|e| format!("invalid font ZIP archive: {e}"))?;
        if archive.len() != definition.archive_files.len() + 1 {
            return Err("font archive contains an unexpected number of files".into());
        }
        for index in 0..archive.len() {
            let name = archive
                .name_for_index(index)
                .ok_or("font archive contains an invalid entry")?;
            if name != "OFL.txt"
                && !definition
                    .archive_files
                    .iter()
                    .any(|file| file.file_name == name)
            {
                return Err(format!("unexpected file in font archive: {name}"));
            }
        }

        for font in definition.archive_files {
            let mut entry = archive
                .by_name(font.file_name)
                .map_err(|e| format!("font archive is missing {}: {e}", font.file_name))?;
            let size = entry.size();
            if entry.is_dir()
                || entry.compression() != zip::CompressionMethod::Stored
                || !(4..=MAX_CACHED_FONT_FILE_BYTES).contains(&size)
            {
                return Err(format!("invalid font archive entry: {}", font.file_name));
            }
            let mut signature = [0_u8; 4];
            entry
                .read_exact(&mut signature)
                .map_err(|e| format!("invalid font file {}: {e}", font.file_name))?;
            if signature != *b"wOF2" {
                return Err(format!("{} is not a WOFF2 font", font.file_name));
            }
            let target_path = tmp_dir.join(font.file_name);
            let mut target = fs::File::create(&target_path).map_err(|e| e.to_string())?;
            target.write_all(&signature).map_err(|e| e.to_string())?;
            let copied = std::io::copy(&mut entry, &mut target).map_err(|e| e.to_string())?;
            if copied + signature.len() as u64 != size {
                return Err(format!("font file {} is incomplete", font.file_name));
            }
            target.flush().map_err(|e| e.to_string())?;
            let (_, actual_sha256) = sha256_file(&target_path)?;
            if actual_sha256 != font.sha256 {
                return Err(format!(
                    "font file {} failed its SHA-256 check",
                    font.file_name
                ));
            }
        }

        {
            let mut license = archive
                .by_name("OFL.txt")
                .map_err(|e| format!("font archive is missing OFL.txt: {e}"))?;
            if license.is_dir() || license.size() > MAX_FONT_LICENSE_BYTES {
                return Err("font archive contains an invalid OFL.txt".into());
            }
            let mut contents = Vec::with_capacity(license.size() as usize);
            license
                .read_to_end(&mut contents)
                .map_err(|e| format!("failed to read font license: {e}"))?;
            std::str::from_utf8(&contents)
                .map_err(|e| format!("invalid font license text: {e}"))?;
            fs::write(tmp_dir.join("OFL.txt"), contents).map_err(|e| e.to_string())?;
        }
        drop(archive);
        fs::remove_file(archive_path).map_err(|e| e.to_string())?;

        install_font_cache(&tmp_dir, &final_dir)?;
        Ok(font_result(definition, true))
    }
    .await;

    if result.is_err() {
        let _ = fs::remove_dir_all(&tmp_dir);
    }
    result
}

fn emit_font_download_progress(
    app: &AppHandle,
    font_id: &str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
) {
    let percent = total_bytes
        .filter(|total| *total > 0)
        .map(|total| ((downloaded_bytes.saturating_mul(100) / total).min(100)) as u8);
    let _ = app.emit(
        FONT_DOWNLOAD_PROGRESS_EVENT,
        FontDownloadProgress {
            font_id: font_id.to_string(),
            downloaded_bytes,
            total_bytes,
            percent,
        },
    );
}

fn cached_font_result(definition: &FontDefinition) -> Option<CachedFontResult> {
    let dir = font_dir(definition.id);
    for font in definition.archive_files {
        let (_, sha256) = sha256_file(&dir.join(font.file_name)).ok()?;
        if sha256 != font.sha256 {
            return None;
        }
    }
    let license_size = fs::metadata(dir.join("OFL.txt")).ok()?.len();
    if !(1..=MAX_FONT_LICENSE_BYTES).contains(&license_size) {
        return None;
    }
    Some(font_result(definition, false))
}

fn cached_font_metadata_present(definition: &FontDefinition) -> bool {
    let dir = font_dir(definition.id);
    for font in definition.archive_files {
        let Ok(metadata) = fs::metadata(dir.join(font.file_name)) else {
            return false;
        };
        if !metadata.is_file() || !(4..=MAX_CACHED_FONT_FILE_BYTES).contains(&metadata.len()) {
            return false;
        }
    }
    let Ok(license) = fs::metadata(dir.join("OFL.txt")) else {
        return false;
    };
    license.is_file() && (1..=MAX_FONT_LICENSE_BYTES).contains(&license.len())
}

fn install_font_cache(tmp_dir: &Path, final_dir: &Path) -> Result<(), String> {
    let backup_dir = final_dir.with_extension(format!("backup-{}", uuid::Uuid::new_v4()));
    let had_previous_cache = final_dir.exists();
    if had_previous_cache {
        fs::rename(final_dir, &backup_dir).map_err(|e| e.to_string())?;
    }
    if let Err(error) = fs::rename(tmp_dir, final_dir) {
        if had_previous_cache {
            let _ = fs::rename(&backup_dir, final_dir);
        }
        return Err(error.to_string());
    }
    if had_previous_cache {
        let _ = fs::remove_dir_all(backup_dir);
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<(u64, String), String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if !(4..=MAX_CACHED_FONT_FILE_BYTES).contains(&size) {
        return Err("cached font file has an invalid size".into());
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok((size, format!("{:x}", hasher.finalize())))
}

fn font_result(definition: &FontDefinition, downloaded: bool) -> CachedFontResult {
    CachedFontResult {
        font_id: definition.id.to_string(),
        downloaded,
        files: definition
            .archive_files
            .iter()
            .map(|font| CachedFontFile {
                family: font.family.to_string(),
                weight: font.weight.to_string(),
                style: font.style.to_string(),
            })
            .collect(),
    }
}

fn fonts_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(USER_CONFIG_DIR_NAME)
        .join("fonts")
}

fn font_dir(font_id: &str) -> PathBuf {
    fonts_root().join(font_id)
}
