use std::collections::HashSet;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use base64::Engine;
use image::GenericImageView;
use once_cell::sync::Lazy;
use regex::Regex;
use rllm::error::LLMError as RllmError;

use super::constants::{MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION};

static MARKDOWN_IMAGE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"!\[[^\]]*\]\((?P<src>[^)\s]+(?:\s[^)]*)?)\)"#).unwrap());
static REMOTE_IMAGE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\bhttps?://[^\s<>()]+?\.(?:png|jpe?g)(?:\?[^\s<>()]*)?"#).unwrap()
});
static FILE_URL_IMAGE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\bfile:///[^\s<>()]+?\.(?:png|jpe?g)(?:\?[^\s<>()]*)?"#).unwrap()
});
static ASSET_URL_IMAGE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\basset://localhost/[^\s<>()]+?\.(?:png|jpe?g)(?:\?[^\s<>()]*)?"#).unwrap()
});
static WINDOWS_IMAGE_PATH_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)(?:^|[\s(])(?P<path>[A-Za-z]:[\\/][^\r\n<>"|?*]+?\.(?:png|jpe?g))(?:$|[\s),.!?;:])"#,
    )
    .unwrap()
});
static MARKDOWN_LINK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"\[[^\]]+\]\((?P<src>[^)\s]+(?:\s[^)]*)?)\)"#).unwrap());
static REMOTE_VIDEO_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\bhttps?://[^\s<>()]+?\.(?:mp4|mov|webm|m4v)(?:\?[^\s<>()]*)?"#).unwrap()
});
static FILE_URL_VIDEO_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\bfile:///[^\s<>()]+?\.(?:mp4|mov|webm|m4v)(?:\?[^\s<>()]*)?"#).unwrap()
});
static ASSET_URL_VIDEO_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\basset://localhost/[^\s<>()]+?\.(?:mp4|mov|webm|m4v)(?:\?[^\s<>()]*)?"#)
        .unwrap()
});
static WINDOWS_VIDEO_PATH_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)(?:^|[\s(])(?P<path>[A-Za-z]:[\\/][^\r\n<>"|?*]+?\.(?:mp4|mov|webm|m4v))(?:$|[\s),.!?;:])"#,
    )
    .unwrap()
});

pub(super) fn extract_image_sources(content: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();

    for caps in MARKDOWN_IMAGE_RE.captures_iter(content) {
        if let Some(src) = caps.name("src") {
            let src = normalize_markdown_image_src(src.as_str());
            if is_supported_image_source(&src) && seen.insert(src.clone()) {
                out.push(src);
            }
        }
    }

    for mat in REMOTE_IMAGE_RE.find_iter(content) {
        let src = trim_bare_image_source(mat.as_str());
        if seen.insert(src.clone()) {
            out.push(src);
        }
    }

    for mat in FILE_URL_IMAGE_RE.find_iter(content) {
        let src = trim_bare_image_source(mat.as_str());
        if seen.insert(src.clone()) {
            out.push(src);
        }
    }

    for mat in ASSET_URL_IMAGE_RE.find_iter(content) {
        let src = trim_bare_image_source(mat.as_str());
        if seen.insert(src.clone()) {
            out.push(src);
        }
    }

    for caps in WINDOWS_IMAGE_PATH_RE.captures_iter(content) {
        if let Some(path) = caps.name("path") {
            let src = trim_bare_image_source(path.as_str());
            if seen.insert(src.clone()) {
                out.push(src);
            }
        }
    }

    out
}

pub(super) fn extract_video_sources(content: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();

    for caps in MARKDOWN_LINK_RE.captures_iter(content) {
        if let Some(src) = caps.name("src") {
            let src = normalize_markdown_image_src(src.as_str());
            if is_supported_video_source(&src) && seen.insert(src.clone()) {
                out.push(src);
            }
        }
    }

    for mat in REMOTE_VIDEO_RE.find_iter(content) {
        let src = trim_bare_image_source(mat.as_str());
        if seen.insert(src.clone()) {
            out.push(src);
        }
    }

    for mat in FILE_URL_VIDEO_RE.find_iter(content) {
        let src = trim_bare_image_source(mat.as_str());
        if seen.insert(src.clone()) {
            out.push(src);
        }
    }

    for mat in ASSET_URL_VIDEO_RE.find_iter(content) {
        let src = trim_bare_image_source(mat.as_str());
        if seen.insert(src.clone()) {
            out.push(src);
        }
    }

    for caps in WINDOWS_VIDEO_PATH_RE.captures_iter(content) {
        if let Some(path) = caps.name("path") {
            let src = trim_bare_image_source(path.as_str());
            if seen.insert(src.clone()) {
                out.push(src);
            }
        }
    }

    out
}

fn normalize_markdown_image_src(src: &str) -> String {
    let trimmed = src.trim();
    let without_title = trimmed
        .split_once(" \"")
        .or_else(|| trimmed.split_once(" '"))
        .map(|(url, _)| url)
        .unwrap_or(trimmed)
        .trim();
    without_title
        .trim_matches('<')
        .trim_matches('>')
        .trim()
        .to_string()
}

fn trim_bare_image_source(src: &str) -> String {
    src.trim()
        .trim_end_matches(|c: char| {
            matches!(c, ')' | ']' | '}' | ',' | '.' | ';' | ':' | '!' | '?')
        })
        .to_string()
}

fn is_supported_image_source(src: &str) -> bool {
    let lower = src.to_ascii_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("file:///")
        || lower.starts_with("asset://localhost/")
    {
        return lower.contains(".png") || lower.contains(".jpg") || lower.contains(".jpeg");
    }
    is_supported_local_image_path(src)
}

fn is_supported_local_image_path(src: &str) -> bool {
    let lower = src.to_ascii_lowercase();
    (lower.ends_with(".png") || lower.ends_with(".jpg") || lower.ends_with(".jpeg"))
        && (Path::new(src).is_absolute()
            || src.starts_with(r"\\")
            || src.starts_with("//")
            || src.as_bytes().get(1) == Some(&b':'))
}

fn is_supported_video_source(src: &str) -> bool {
    let lower = src.to_ascii_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("file:///")
        || lower.starts_with("asset://localhost/")
    {
        return lower.contains(".mp4")
            || lower.contains(".mov")
            || lower.contains(".webm")
            || lower.contains(".m4v");
    }
    is_supported_local_video_path(src)
}

fn is_supported_local_video_path(src: &str) -> bool {
    let lower = src.to_ascii_lowercase();
    (lower.ends_with(".mp4")
        || lower.ends_with(".mov")
        || lower.ends_with(".webm")
        || lower.ends_with(".m4v"))
        && (Path::new(src).is_absolute()
            || src.starts_with(r"\\")
            || src.starts_with("//")
            || src.as_bytes().get(1) == Some(&b':'))
}

pub(super) fn mime_from_source(src: &str) -> Option<&'static str> {
    let lower = src.to_ascii_lowercase();
    let path = lower.split('?').next().unwrap_or(&lower);
    if path.ends_with(".png") {
        Some("image/png")
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        Some("image/jpeg")
    } else {
        None
    }
}

pub(super) fn video_mime_from_source(src: &str) -> Option<&'static str> {
    let lower = src.to_ascii_lowercase();
    let path = lower.split('?').next().unwrap_or(&lower);
    if path.ends_with(".mp4") || path.ends_with(".m4v") {
        Some("video/mp4")
    } else if path.ends_with(".mov") {
        Some("video/quicktime")
    } else if path.ends_with(".webm") {
        Some("video/webm")
    } else {
        None
    }
}

pub(super) fn mime_from_content_type(content_type: Option<&str>) -> Option<&'static str> {
    let ct = content_type?.split(';').next()?.trim().to_ascii_lowercase();
    match ct.as_str() {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        _ => None,
    }
}

pub(super) fn file_url_to_path(src: &str) -> Result<PathBuf, RllmError> {
    let url = reqwest::Url::parse(src)
        .map_err(|e| RllmError::HttpError(format!("invalid image file URL '{src}': {e}")))?;
    url.to_file_path()
        .map_err(|_| RllmError::HttpError(format!("invalid image file URL path '{src}'")))
}

pub(super) fn asset_url_to_path(src: &str) -> Result<PathBuf, RllmError> {
    let url = reqwest::Url::parse(src)
        .map_err(|e| RllmError::HttpError(format!("invalid image asset URL '{src}': {e}")))?;
    if url.scheme() != "asset" || url.host_str() != Some("localhost") {
        return Err(RllmError::HttpError(format!(
            "unsupported image asset URL '{src}'"
        )));
    }

    let decoded = percent_decode(url.path()).map_err(|e| {
        RllmError::HttpError(format!("invalid percent-encoded asset URL '{src}': {e}"))
    })?;
    let path =
        if decoded.len() >= 4 && decoded.as_bytes()[0] == b'/' && decoded.as_bytes()[2] == b':' {
            &decoded[1..]
        } else {
            decoded.as_str()
        };
    Ok(PathBuf::from(path.replace('/', "\\")))
}

fn percent_decode(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err("truncated percent escape".to_string());
            }
            let hi = hex_value(bytes[i + 1]).ok_or_else(|| "invalid percent escape".to_string())?;
            let lo = hex_value(bytes[i + 2]).ok_or_else(|| "invalid percent escape".to_string())?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

pub(super) fn encode_resized_image_data_url(
    source: &str,
    bytes: &[u8],
    mime_hint: Option<&str>,
) -> Result<String, RllmError> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(RllmError::HttpError(format!(
            "image '{source}' is too large: {} bytes exceeds {} bytes",
            bytes.len(),
            MAX_IMAGE_BYTES
        )));
    }

    let image = image::load_from_memory(bytes).map_err(|e| RllmError::ResponseFormatError {
        message: format!("failed to decode image '{source}'"),
        raw_response: e.to_string(),
    })?;
    let (width, height) = image.dimensions();
    let resized = if width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
        image.resize(
            MAX_IMAGE_DIMENSION,
            MAX_IMAGE_DIMENSION,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        image
    };

    let mime = mime_hint
        .or_else(|| mime_from_source(source))
        .unwrap_or("image/jpeg");
    let mut out = Cursor::new(Vec::new());
    match mime {
        "image/png" => resized.write_to(&mut out, image::ImageFormat::Png),
        _ => resized.write_to(&mut out, image::ImageFormat::Jpeg),
    }
    .map_err(|e| RllmError::JsonError(format!("failed to encode image '{source}': {e}")))?;

    let encoded = base64::engine::general_purpose::STANDARD.encode(out.into_inner());
    Ok(format!("data:{mime};base64,{encoded}"))
}
