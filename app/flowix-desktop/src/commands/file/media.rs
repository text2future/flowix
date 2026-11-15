//! 图片 / 视频 / 文档缩略图：解码、落缓存盘、可取消。
//!
//! 三条约束决定了这里的形状：
//! 1. 解码是最贵的一步，全局并发 1（`MEDIA_PREVIEW_CONCURRENCY`），避免大图
//!    的内存峰值叠加；
//! 2. 前端切换视图会放弃请求，所以每个请求带 `request_id`，排队与解码两段都能
//!    被 `cancel_media_thumbnail` 打断；
//! 3. 命中返回缓存文件路径而不是 base64 —— 字节走 asset protocol，不过 IPC。
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tokio::sync::{Notify, Semaphore};

use crate::app::state::AppState;
use crate::commands::helpers::{
    can_access_document_path, can_access_scoped_file, is_internal_notebook_path,
};
use flowix_core::memo_file::{media_kind_for_path, MediaResourceKind};

fn image_mime_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        "avif" => Some("image/avif"),
        "ico" => Some("image/x-icon"),
        "tif" | "tiff" => Some("image/tiff"),
        "heic" => Some("image/heic"),
        "heif" => Some("image/heif"),
        _ => None,
    }
}

/// Read an in-scope image as a data URL so the webview can preview arbitrary
/// user files without widening the Tauri asset-protocol scope.
///
/// The scope check, the read and the base64 encode run on the blocking pool.
/// Synchronous commands run on the IPC thread, so encoding a multi-megabyte
/// photo into a data URL there stalls the window for the whole encode. Callers
/// fire one of these per visible card or table image cell.
#[tauri::command]
pub async fn read_image_file(
    file_path: String,
    space_path: Option<String>,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let path = Path::new(&file_path);
        let mime = image_mime_type(path)?;
        let authorized = can_access_scoped_file(path, space_path.as_deref(), &state)
            || (can_access_document_path(path, window.label(), &state)
                && !is_internal_notebook_path(path, &state));
        if !authorized || !path.is_file() {
            eprintln!("[read_image_file] refused file: {}", file_path);
            return None;
        }
        let bytes = fs::read(path).ok()?;
        Some(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    })
    .await
    .ok()?
}

/// Read a downscaled, transparency-preserving PNG preview for an in-scope raster image.
/// Callers choose a bounded maximum dimension appropriate for its display size.
#[tauri::command]
pub async fn read_image_preview(
    file_path: String,
    space_path: Option<String>,
    max_dimension: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let path = Path::new(&file_path);
    if !can_access_scoped_file(path, space_path.as_deref(), &state) || !path.is_file() {
        return Ok(None);
    }
    let path = path.to_path_buf();
    let max_dimension = preview_max_dimension(max_dimension);
    let slots = MEDIA_PREVIEW_SLOTS
        .get_or_init(|| Arc::new(Semaphore::new(MEDIA_PREVIEW_CONCURRENCY)))
        .clone();
    let permit = slots
        .acquire_owned()
        .await
        .map_err(|error| error.to_string())?;
    let preview = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let preview = decode_image_preview(&path, max_dimension).ok()?;
        let mut png = std::io::Cursor::new(Vec::new());
        preview.write_to(&mut png, image::ImageFormat::Png).ok()?;
        Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png.into_inner())
        ))
    })
    .await
    .map_err(|error| error.to_string())?;
    Ok(preview)
}

fn preview_max_dimension(requested: Option<u32>) -> u32 {
    requested.unwrap_or(640).clamp(128, 4096)
}

/// Resolve an image only from Codex's generated image directory.
/// Codex imageGeneration results sit outside the agent workspace roots.
fn codex_generated_image_path(file_path: String) -> Option<PathBuf> {
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))?;
    let generated_root = fs::canonicalize(codex_home.join("generated_images")).ok()?;
    let path = fs::canonicalize(file_path).ok()?;
    if !path.starts_with(&generated_root) || !path.is_file() {
        return None;
    }
    image_mime_type(&path)?;
    Some(path)
}

/// Read a downscaled preview from Codex's generated image directory.
#[tauri::command]
pub async fn read_codex_generated_image_preview(
    file_path: String,
    max_dimension: Option<u32>,
) -> Option<String> {
    let path = codex_generated_image_path(file_path)?;
    let max_dimension = preview_max_dimension(max_dimension);
    let slots = MEDIA_PREVIEW_SLOTS
        .get_or_init(|| Arc::new(Semaphore::new(MEDIA_PREVIEW_CONCURRENCY)))
        .clone();
    let permit = slots.acquire_owned().await.ok()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let preview = decode_image_preview(&path, max_dimension).ok()?;
        let mut png = std::io::Cursor::new(Vec::new());
        preview.write_to(&mut png, image::ImageFormat::Png).ok()?;
        Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png.into_inner())
        ))
    })
    .await
    .ok()?
}

// Decode previews sequentially to keep large-image memory peaks from overlapping.
const MEDIA_PREVIEW_CONCURRENCY: usize = 1;
const MEDIA_PREVIEW_CACHE_LIMIT_BYTES: u64 = 512 * 1024 * 1024;
static MEDIA_PREVIEW_SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
static MEDIA_PREVIEW_CACHE_WRITES: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
static MEDIA_PREVIEW_TEMP_SEQUENCE: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
static MEDIA_PREVIEW_PRUNE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static MEDIA_PREVIEW_REQUESTS: OnceLock<Mutex<HashMap<String, Arc<MediaPreviewCancellation>>>> =
    OnceLock::new();

struct MediaPreviewCancellation {
    cancelled: AtomicBool,
    notify: Notify,
}

impl MediaPreviewCancellation {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_one();
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

/// Generate or reuse a small image/video thumbnail on a bounded blocking pool.
/// The command returns a cache file path so the WebView loads the bytes through
/// the asset protocol instead of transferring base64 data over IPC.
#[tauri::command]
pub async fn get_media_thumbnail(
    file_path: String,
    space_path: Option<String>,
    kind: String,
    request_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    if request_id.is_empty() || request_id.len() > 128 {
        return Err("invalid media preview request id".to_string());
    }
    let path = dunce::canonicalize(&file_path).map_err(|error| error.to_string())?;
    if !can_access_scoped_file(&path, space_path.as_deref(), &state) || !path.is_file() {
        return Err("media path is outside the permitted scope".to_string());
    }
    let actual_kind = media_kind_for_path(&path);
    let is_image = kind == "image" && actual_kind == Some(MediaResourceKind::Image);
    let is_video = kind == "video" && actual_kind == Some(MediaResourceKind::Video);
    let is_document = kind == "document" && is_document_preview_path(&path);
    if !is_image && !is_video && !is_document {
        return Err("unsupported media thumbnail kind".to_string());
    }

    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let identity = format!(
        "v4:{}:{}:{}:{}",
        path.display(),
        metadata.len(),
        modified_ns,
        kind
    );
    let digest = format!("{:x}", Sha256::digest(identity.as_bytes()));
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("media-thumbnails");
    let cache_extension = if is_video { "jpg" } else { "png" };
    let cache_path = cache_root.join(format!("{digest}.{cache_extension}"));
    if cache_path.is_file() {
        return Ok(Some(cache_path.to_string_lossy().into_owned()));
    }

    let cancellation = Arc::new(MediaPreviewCancellation::new());
    MEDIA_PREVIEW_REQUESTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "media preview request registry poisoned".to_string())?
        .insert(request_id.clone(), cancellation.clone());

    let slots = MEDIA_PREVIEW_SLOTS
        .get_or_init(|| Arc::new(Semaphore::new(MEDIA_PREVIEW_CONCURRENCY)))
        .clone();
    let acquire = slots.acquire_owned();
    tokio::pin!(acquire);
    let notified = cancellation.notify.notified();
    tokio::pin!(notified);
    let permit = tokio::select! {
        result = &mut acquire => result.map_err(|error| format!("media preview queue closed: {error}"))?,
        _ = &mut notified => {
            remove_media_preview_request(&request_id, &cancellation);
            return Ok(None);
        }
    };
    if cancellation.is_cancelled() {
        remove_media_preview_request(&request_id, &cancellation);
        return Ok(None);
    }
    let output = cache_path.clone();
    let worker_cancellation = cancellation.clone();
    let join_result = tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        let _permit = permit;
        if worker_cancellation.is_cancelled() {
            return Ok(false);
        }
        if output.is_file() {
            return Ok(true);
        }
        fs::create_dir_all(&cache_root).map_err(|error| error.to_string())?;
        let generated = if is_image {
            write_image_thumbnail(&path, &output, &worker_cancellation)
        } else if is_video {
            write_video_thumbnail(&path, &output, &worker_cancellation)
        } else {
            // 文档预览（pdf/html/office…）走系统 Quick Look；失败返回 false，前端回落文件图标。
            write_system_thumbnail(&path, &output, &worker_cancellation, false)
        }?;
        if generated {
            let writes = MEDIA_PREVIEW_CACHE_WRITES.fetch_add(1, Ordering::Relaxed) + 1;
            if writes % 32 == 0 {
                prune_media_thumbnail_cache(&cache_root);
            }
        }
        Ok(generated)
    })
    .await;
    remove_media_preview_request(&request_id, &cancellation);
    let result = join_result.map_err(|error| format!("media preview task failed: {error}"))??;

    Ok(result.then(|| cache_path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn cancel_media_thumbnail(request_id: String) {
    let Some(requests) = MEDIA_PREVIEW_REQUESTS.get() else {
        return;
    };
    if let Ok(requests) = requests.lock() {
        if let Some(request) = requests.get(&request_id) {
            request.cancel();
        }
    }
}

fn remove_media_preview_request(request_id: &str, expected: &Arc<MediaPreviewCancellation>) {
    let Some(requests) = MEDIA_PREVIEW_REQUESTS.get() else {
        return;
    };
    if let Ok(mut requests) = requests.lock() {
        if requests
            .get(request_id)
            .is_some_and(|current| Arc::ptr_eq(current, expected))
        {
            requests.remove(request_id);
        }
    }
}

fn image_preview_error(error: image::ImageError) -> String {
    let category = match &error {
        image::ImageError::Unsupported(_) => "MEDIA_PREVIEW_UNSUPPORTED",
        image::ImageError::Limits(_) => "MEDIA_PREVIEW_LIMIT",
        _ => "MEDIA_PREVIEW_DECODE_FAILED",
    };
    format!("{category}: {error}")
}

/// Decode from a buffered file instead of retaining the entire encoded original.
/// Apply metadata orientation before computing the photo-wall aspect ratio.
fn decode_image_preview(source: &Path, size: u32) -> Result<image::DynamicImage, String> {
    use image::ImageDecoder;
    let mut reader = image::ImageReader::open(source)
        .map_err(|error| error.to_string())?
        .with_guessed_format()
        .map_err(|error| error.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(256 * 1024 * 1024);
    limits.max_image_width = Some(32768);
    limits.max_image_height = Some(32768);
    reader.limits(limits.clone());
    let mut decoder = reader.into_decoder().map_err(image_preview_error)?;
    // into_decoder does not reserve the DynamicImage output buffer as decode does.
    // Reserve a second buffer too: EXIF rotation can temporarily duplicate it.
    let output_bytes = decoder.total_bytes();
    limits.reserve(output_bytes).map_err(image_preview_error)?;
    limits.reserve(output_bytes).map_err(image_preview_error)?;
    decoder.set_limits(limits).map_err(image_preview_error)?;
    let orientation = decoder.orientation().map_err(image_preview_error)?;
    let mut image = image::DynamicImage::from_decoder(decoder).map_err(image_preview_error)?;
    image.apply_orientation(orientation);
    Ok(image.thumbnail(size, size))
}

fn write_image_thumbnail(
    source: &Path,
    output: &Path,
    cancellation: &MediaPreviewCancellation,
) -> Result<bool, String> {
    if cancellation.is_cancelled() {
        return Ok(false);
    }
    match decode_image_preview(source, 640) {
        Ok(preview) => write_thumbnail_png(output, &preview, cancellation),
        Err(error) => {
            let extension = source
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if error.starts_with("MEDIA_PREVIEW_UNSUPPORTED:")
                && matches!(extension.as_str(), "heic" | "heif" | "avif")
            {
                write_system_thumbnail(source, output, cancellation, true)
            } else {
                Err(error)
            }
        }
    }
}

fn write_video_thumbnail(
    source: &Path,
    output: &Path,
    cancellation: &MediaPreviewCancellation,
) -> Result<bool, String> {
    write_system_thumbnail(source, output, cancellation, false)
}

/// Extensions that Quick Look can reasonably turn into a document preview thumbnail.
/// Unsupported platforms (no `qlmanage`) or failures simply yield no preview.
fn is_document_preview_path(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "pdf" | "html" | "htm" | "rtf" | "epub"
            | "doc" | "docx" | "ppt" | "pptx" | "pps" | "ppsx"
            | "xls" | "xlsx" | "key" | "pages" | "numbers"
            | "odt" | "ods" | "odp"
    )
}

fn write_system_thumbnail(
    source: &Path,
    output: &Path,
    cancellation: &MediaPreviewCancellation,
    preserve_alpha: bool,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let directory = tempfile::tempdir().map_err(|error| error.to_string())?;
        let mut child = std::process::Command::new("/usr/bin/qlmanage")
            .args(["-t", "-s", "480", "-o"])
            .arg(directory.path())
            .arg(source)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| error.to_string())?;
        let started = std::time::Instant::now();
        let status = loop {
            if cancellation.is_cancelled() {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(false);
            }
            if started.elapsed() >= Duration::from_secs(8) {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(false);
            }
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                break status;
            }
            std::thread::sleep(Duration::from_millis(60));
        };
        if !status.success() || cancellation.is_cancelled() {
            return Ok(false);
        }
        let thumbnail = fs::read_dir(directory.path())
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|candidate| {
                candidate
                    .extension()
                    .is_some_and(|extension| extension == "png")
            });
        let Some(thumbnail) = thumbnail else {
            return Ok(false);
        };
        if cancellation.is_cancelled() {
            return Ok(false);
        }
        let preview = decode_image_preview(&thumbnail, 640)?;
        if preserve_alpha {
            return write_thumbnail_png(output, &preview, cancellation);
        }
        return write_thumbnail_jpeg(output, &preview.to_rgb8(), 72, cancellation);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (source, output, cancellation, preserve_alpha);
        Ok(false)
    }
}

fn write_thumbnail_jpeg(
    output: &Path,
    image: &image::RgbImage,
    quality: u8,
    cancellation: &MediaPreviewCancellation,
) -> Result<bool, String> {
    if cancellation.is_cancelled() {
        return Ok(false);
    }
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, quality)
        .encode_image(image)
        .map_err(|error| error.to_string())?;
    write_thumbnail_bytes(output, jpeg, cancellation)
}

fn write_thumbnail_png(
    output: &Path,
    image: &image::DynamicImage,
    cancellation: &MediaPreviewCancellation,
) -> Result<bool, String> {
    if cancellation.is_cancelled() {
        return Ok(false);
    }
    let mut png = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    write_thumbnail_bytes(output, png.into_inner(), cancellation)
}

fn write_thumbnail_bytes(
    output: &Path,
    bytes: Vec<u8>,
    cancellation: &MediaPreviewCancellation,
) -> Result<bool, String> {
    if cancellation.is_cancelled() {
        return Ok(false);
    }
    let nonce = MEDIA_PREVIEW_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = output.with_extension(format!("{nonce}.tmp"));
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    match fs::rename(&temporary, output) {
        Ok(()) => Ok(true),
        Err(_error) if output.is_file() => {
            let _ = fs::remove_file(temporary);
            Ok(true)
        }
        Err(error) => {
            let _ = fs::remove_file(temporary);
            Err(error.to_string())
        }
    }
}

fn prune_media_thumbnail_cache(cache_root: &Path) {
    let lock = MEDIA_PREVIEW_PRUNE_LOCK.get_or_init(|| Mutex::new(()));
    let Ok(_guard) = lock.lock() else {
        return;
    };
    let Ok(entries) = fs::read_dir(cache_root) else {
        return;
    };
    let mut files: Vec<(SystemTime, u64, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then(|| {
                (
                    metadata.modified().unwrap_or(UNIX_EPOCH),
                    metadata.len(),
                    entry.path(),
                )
            })
        })
        .collect();
    let total = files.iter().map(|(_, size, _)| *size).sum::<u64>();
    if total <= MEDIA_PREVIEW_CACHE_LIMIT_BYTES {
        return;
    }
    files.sort_by_key(|(modified, _, _)| *modified);
    let mut retained = total;
    for (_, size, path) in files {
        if retained <= MEDIA_PREVIEW_CACHE_LIMIT_BYTES {
            break;
        }
        if fs::remove_file(path).is_ok() {
            retained = retained.saturating_sub(size);
        }
    }
}

/// Read a temporary Quick Look thumbnail for an in-scope video file.
///
/// Quick Look spawns a helper process and the result is then decoded and
/// re-encoded, so the whole command runs on the blocking pool rather than on
/// the IPC thread.
#[tauri::command]
pub async fn read_video_preview(
    file_path: String,
    space_path: Option<String>,
    app: AppHandle,
) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let path = Path::new(&file_path);
        if !can_access_scoped_file(path, space_path.as_deref(), &state) || !path.is_file() {
            eprintln!("[read_video_preview] refused file: {}", file_path);
            return None;
        }

        #[cfg(target_os = "macos")]
        {
            let directory = tempfile::tempdir().ok()?;
            let output = std::process::Command::new("/usr/bin/qlmanage")
                .args(["-t", "-s", "480", "-o"])
                .arg(directory.path())
                .arg(path)
                .output()
                .ok()?;
            if !output.status.success() {
                return None;
            }
            let thumbnail = fs::read_dir(directory.path())
                .ok()?
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .find(|candidate| {
                    candidate
                        .extension()
                        .is_some_and(|extension| extension == "png")
                })?;
            let bytes = fs::read(thumbnail).ok()?;
            let preview = image::load_from_memory(&bytes)
                .ok()?
                .thumbnail(480, 480)
                .to_rgb8();
            let mut jpeg = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 72)
                .encode_image(&preview)
                .ok()?;
            Some(format!(
                "data:image/jpeg;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(jpeg)
            ))
        }

        #[cfg(not(target_os = "macos"))]
        {
            None
        }
    })
    .await
    .ok()?
}
