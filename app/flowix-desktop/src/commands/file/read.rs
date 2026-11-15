//! 只读 IPC：文本、DOCX 预览（base64 直传）、DOCX 转 Markdown。
//!
//! DOCX 不走通用 `fs` 授权：预览认「已授权的单文件」或「访问空间内的文件」，
//! 转 Markdown 只认后者 —— 它要在源文件旁边写盘，一次打开授权不够。
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Deserialize;
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::app::state::AppState;
use crate::commands::helpers::{
    can_access_document_path, can_access_scoped_file, can_access_scoped_file_with_state,
    refresh_notebook_note_index,
};
use crate::lock_utils::read_lock;

#[tauri::command]
pub async fn read_file(
    file_path: String,
    space_path: Option<String>,
    app: AppHandle,
) -> Option<String> {
    {
        let state = app.state::<AppState>();
        if !can_access_scoped_file_with_state(
            Path::new(&file_path),
            space_path.as_deref(),
            state.inner(),
        ) {
            eprintln!("[read_file] refused out-of-scope path: {}", file_path);
            return None;
        }
    }
    // Opening a large document should not block the main thread on the read.
    tauri::async_runtime::spawn_blocking(move || fs::read_to_string(&file_path).ok())
        .await
        .ok()
        .flatten()
}

const MAX_DOCX_PREVIEW_BYTES: u64 = 50 * 1024 * 1024;

fn authorized_docx_path(
    file_path: &str,
    space_path: Option<&str>,
    window_label: &str,
    state: &State<'_, AppState>,
) -> Result<PathBuf, String> {
    let requested = Path::new(file_path);
    if !requested.is_absolute() {
        return Err("DOCX_PATH_INVALID: DOCX path must be absolute".to_string());
    }
    let path = dunce::canonicalize(requested)
        .map_err(|error| format!("DOCX_UNAVAILABLE: could not open file: {error}"))?;
    if !path.is_file() {
        return Err("DOCX_UNAVAILABLE: path is not a file".to_string());
    }
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("docx"))
    {
        return Err("DOCX_UNSUPPORTED: only .docx files are supported".to_string());
    }
    if !can_access_document_path(&path, window_label, state)
        && !can_access_scoped_file(&path, space_path, state)
    {
        return Err("DOCX_FORBIDDEN: file is outside its authorized space".to_string());
    }
    Ok(path)
}

/// Read an authorized DOCX for the in-app preview. Binary bytes cross IPC as
/// base64 so the WebView can decode them without granting general fs access.
#[tauri::command]
pub async fn read_docx_file(
    window: WebviewWindow,
    file_path: String,
    space_path: Option<String>,
    app: AppHandle,
) -> Result<String, String> {
    let window_label = window.label().to_owned();
    crate::document_io::run("read_docx", move || {
        let state = app.state::<AppState>();
        let path = authorized_docx_path(&file_path, space_path.as_deref(), &window_label, &state)?;
        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        if metadata.len() > MAX_DOCX_PREVIEW_BYTES {
            return Err(format!(
                "DOCX_TOO_LARGE: file is larger than {} MB",
                MAX_DOCX_PREVIEW_BYTES / (1024 * 1024)
            ));
        }
        let bytes = fs::read(&path).map_err(|error| format!("DOCX_READ_FAILED: {error}"))?;
        if bytes.len() as u64 > MAX_DOCX_PREVIEW_BYTES {
            return Err("DOCX_TOO_LARGE: file grew beyond the preview limit".to_string());
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })
    .await?
}

/// Create a sibling Markdown file without replacing an existing document.
/// If the original name is taken, add a numbered suffix atomically.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxMarkdownImage {
    marker: String,
    content_type: String,
    content_base64: String,
}

struct PreparedDocxImage {
    marker: String,
    extension: &'static str,
    bytes: Vec<u8>,
}

const MAX_DOCX_MARKDOWN_IMAGES: usize = 256;
const MAX_DOCX_MARKDOWN_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const MAX_DOCX_MARKDOWN_TOTAL_IMAGE_BYTES: usize = 50 * 1024 * 1024;

fn docx_image_extension(content_type: &str) -> Option<&'static str> {
    match content_type
        .split(';')
        .next()?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/bmp" => Some("bmp"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        "image/tiff" => Some("tiff"),
        "image/avif" => Some("avif"),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some("ico"),
        "image/x-emf" => Some("emf"),
        "image/x-wmf" => Some("wmf"),
        _ => None,
    }
}

fn docx_image_markdown_href(path: &Path, directory: &Path) -> String {
    // Both paths are canonical and belong to the same access space.
    let target: Vec<_> = path.components().collect();
    let source: Vec<_> = directory.components().collect();
    let common = target
        .iter()
        .zip(&source)
        .take_while(|(a, b)| a == b)
        .count();
    let mut relative = PathBuf::new();
    for _ in &source[common..] {
        relative.push("..");
    }
    for component in &target[common..] {
        relative.push(component.as_os_str());
    }
    let mut encoded = String::new();
    let path = relative.to_string_lossy().replace('\\', "/");
    for byte in path.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~' | b'/') {
            encoded.push(*byte as char);
        } else {
            use std::fmt::Write as _;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

fn prepare_docx_images(images: Vec<DocxMarkdownImage>) -> Result<Vec<PreparedDocxImage>, String> {
    if images.len() > MAX_DOCX_MARKDOWN_IMAGES {
        return Err("DOCX_IMAGE_LIMIT: too many images in the document".to_string());
    }
    let mut markers = HashSet::new();
    let mut total_bytes = 0usize;
    let mut total_encoded_bytes = 0usize;
    images
        .into_iter()
        .map(|image| {
            if !image.marker.starts_with("flowix-docx-image-")
                || !image
                    .marker
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                || !markers.insert(image.marker.clone())
            {
                return Err("DOCX_IMAGE_INVALID: invalid or duplicate image reference".to_string());
            }
            let extension = docx_image_extension(&image.content_type)
                .ok_or_else(|| "DOCX_IMAGE_UNSUPPORTED: unsupported image format".to_string())?;
            if image.content_base64.len() > MAX_DOCX_MARKDOWN_IMAGE_BYTES.saturating_mul(4) / 3 + 8
            {
                return Err("DOCX_IMAGE_TOO_LARGE: an image is larger than 25 MB".to_string());
            }
            total_encoded_bytes = total_encoded_bytes.saturating_add(image.content_base64.len());
            if total_encoded_bytes > MAX_DOCX_MARKDOWN_TOTAL_IMAGE_BYTES.saturating_mul(4) / 3 + 16
            {
                return Err(
                    "DOCX_IMAGE_TOO_LARGE: total image data is larger than 50 MB".to_string(),
                );
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(image.content_base64.as_bytes())
                .map_err(|_| "DOCX_IMAGE_INVALID: image data is invalid".to_string())?;
            if bytes.len() > MAX_DOCX_MARKDOWN_IMAGE_BYTES {
                return Err("DOCX_IMAGE_TOO_LARGE: an image is larger than 25 MB".to_string());
            }
            total_bytes = total_bytes.saturating_add(bytes.len());
            if total_bytes > MAX_DOCX_MARKDOWN_TOTAL_IMAGE_BYTES {
                return Err(
                    "DOCX_IMAGE_TOO_LARGE: total image data is larger than 50 MB".to_string(),
                );
            }
            Ok(PreparedDocxImage {
                marker: image.marker,
                extension,
                bytes,
            })
        })
        .collect()
}

fn create_docx_image_file(
    directory: &Path,
    scope_path: &str,
    state: &State<'_, AppState>,
    image: &PreparedDocxImage,
    index: usize,
) -> Result<PathBuf, String> {
    for suffix in 0..=9999 {
        let filename = if suffix == 0 {
            format!("docx-image-{:03}.{}", index + 1, image.extension)
        } else {
            format!("docx-image-{:03}-{suffix}.{}", index + 1, image.extension)
        };
        let target = directory.join(filename);
        if !can_access_scoped_file(&target, Some(scope_path), state) {
            return Err("DOCX_FORBIDDEN: attachment path is outside this space".to_string());
        }
        match flowix_core::memo_file::atomic_create_bytes(&target, &image.bytes) {
            Ok(()) => return Ok(target),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("DOCX_IMAGE_WRITE_FAILED: {error}")),
        }
    }
    Err("DOCX_NAME_CONFLICT: could not find an unused attachment filename".to_string())
}

fn create_docx_markdown_with_images(
    source: &Path,
    space_path: &str,
    content: String,
    images: Vec<DocxMarkdownImage>,
    state: &State<'_, AppState>,
) -> Result<PathBuf, String> {
    let parent = source
        .parent()
        .ok_or_else(|| "DOCX_PATH_INVALID: source has no parent directory".to_string())?;
    let stem = source
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .ok_or_else(|| "DOCX_PATH_INVALID: source filename is invalid".to_string())?;
    let prepared_images = prepare_docx_images(images)?;
    let mut markdown = content;
    for image in &prepared_images {
        if !markdown.contains(&image.marker) {
            return Err(
                "DOCX_IMAGE_REFERENCE_MISSING: converted image reference is missing".to_string(),
            );
        }
    }

    let space_root = dunce::canonicalize(space_path)
        .map_err(|error| format!("DOCX_UNAVAILABLE: could not open access space: {error}"))?;
    let markdown_directory = dunce::canonicalize(parent)
        .map_err(|error| format!("DOCX_UNAVAILABLE: could not open output directory: {error}"))?;
    if !markdown_directory.starts_with(&space_root) {
        return Err("DOCX_FORBIDDEN: output path is outside this space".to_string());
    }
    let mut created_images = Vec::with_capacity(prepared_images.len());
    if !prepared_images.is_empty() {
        let attachment_directory = space_root.join("attachments");
        if !can_access_scoped_file(&attachment_directory, Some(space_path), state) {
            return Err("DOCX_FORBIDDEN: cannot create attachments in this space".to_string());
        }
        fs::create_dir_all(&attachment_directory)
            .map_err(|error| format!("DOCX_IMAGE_WRITE_FAILED: {error}"))?;
        let attachment_directory = dunce::canonicalize(&attachment_directory)
            .map_err(|error| format!("DOCX_IMAGE_WRITE_FAILED: {error}"))?;
        if !attachment_directory.starts_with(&space_root)
            || !can_access_scoped_file(&attachment_directory, Some(space_path), state)
        {
            return Err("DOCX_FORBIDDEN: attachment directory escapes this space".to_string());
        }

        for (index, image) in prepared_images.iter().enumerate() {
            match create_docx_image_file(&attachment_directory, space_path, state, image, index) {
                Ok(path) => {
                    markdown = markdown.replace(
                        &image.marker,
                        &docx_image_markdown_href(&path, &markdown_directory),
                    );
                    created_images.push(path);
                }
                Err(error) => {
                    for created in &created_images {
                        let _ = fs::remove_file(created);
                    }
                    return Err(error);
                }
            }
        }
    }

    for suffix in 0..=9999 {
        let file_name = if suffix == 0 {
            format!("{stem}.md")
        } else {
            format!("{stem} ({suffix}).md")
        };
        let target = parent.join(file_name);
        if !can_access_scoped_file(&target, Some(space_path), state) {
            for created in &created_images {
                let _ = fs::remove_file(created);
            }
            return Err("DOCX_FORBIDDEN: output path is outside this space".to_string());
        }
        match flowix_core::memo_file::atomic_create_bytes(&target, markdown.as_bytes()) {
            Ok(()) => return Ok(target),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                for created in &created_images {
                    let _ = fs::remove_file(created);
                }
                return Err(format!("DOCX_WRITE_FAILED: {error}"));
            }
        }
    }
    for created in &created_images {
        let _ = fs::remove_file(created);
    }
    Err("DOCX_NAME_CONFLICT: could not find an unused Markdown filename".to_string())
}

#[tauri::command]
pub async fn create_docx_markdown(
    window: WebviewWindow,
    file_path: String,
    space_path: String,
    content: String,
    images: Vec<DocxMarkdownImage>,
    app: AppHandle,
) -> Result<String, String> {
    let window_label = window.label().to_owned();
    crate::document_io::run("create_docx_markdown", move || {
        let state = app.state::<AppState>();
        let source = authorized_docx_path(&file_path, Some(&space_path), &window_label, &state)?;
        // Creating a sibling requires an explicit browsable-space grant. A
        // one-file open grant is sufficient for preview, but not for writing.
        if !can_access_scoped_file(&source, Some(&space_path), &state) {
            return Err("DOCX_FORBIDDEN: cannot create Markdown outside this space".to_string());
        }
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let notebook_ids = memo_file
            .notebook_ids_for_paths(&[&source])
            .map_err(|error| error.to_string())?;
        let target = if notebook_ids.is_empty() {
            create_docx_markdown_with_images(&source, &space_path, content, images, &state)?
        } else {
            let ids: Vec<&str> = notebook_ids.iter().map(String::as_str).collect();
            memo_file
                .with_notebook_change(&ids, "create_docx_markdown_with_images", || {
                    Ok(create_docx_markdown_with_images(
                        &source,
                        &space_path,
                        content,
                        images,
                        &state,
                    ))
                })
                .map_err(|error| error.to_string())??
        };
        refresh_notebook_note_index(&memo_file, &target);
        Ok(target.to_string_lossy().into_owned())
    })
    .await?
}
