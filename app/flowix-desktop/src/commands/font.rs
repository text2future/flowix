use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

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
    pub format: String,
    pub unicode_range: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedFontResult {
    pub font_id: String,
    pub cached: bool,
    pub files: Vec<CachedFontFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FontManifest {
    font_id: String,
    source_css_url: String,
    css_len: usize,
    files: Vec<FontManifestFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FontManifestFile {
    family: String,
    weight: String,
    style: String,
    format: String,
    unicode_range: Option<String>,
    file_name: String,
}

#[derive(Debug, Clone)]
struct FontDefinition {
    id: &'static str,
    css_url: &'static str,
}

const FONT_DEFINITIONS: &[FontDefinition] = &[
    FontDefinition {
        id: "noto-sans-sc",
        css_url: "https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@100..900&display=swap",
    },
    FontDefinition {
        id: "noto-serif-sc",
        css_url:
            "https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@200..900&display=swap",
    },
];

#[tauri::command]
pub fn get_font_cache_status() -> Vec<FontCacheStatus> {
    FONT_DEFINITIONS
        .iter()
        .map(|definition| FontCacheStatus {
            font_id: definition.id.to_string(),
            cached: cached_manifest(definition.id).is_some(),
        })
        .collect()
}

#[tauri::command]
pub async fn ensure_font_cached(font_id: String) -> Result<CachedFontResult, String> {
    let definition = FONT_DEFINITIONS
        .iter()
        .find(|definition| definition.id == font_id)
        .ok_or_else(|| format!("unsupported font id: {font_id}"))?;

    if let Some(result) = cached_manifest(definition.id) {
        return Ok(result);
    }

    download_font(definition).await
}

#[tauri::command]
pub fn remove_cached_font(font_id: String) -> Result<(), String> {
    ensure_supported_font_id(&font_id)?;
    let dir = font_dir(&font_id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn download_font(definition: &FontDefinition) -> Result<CachedFontResult, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 Flowix Font Cache")
        .build()
        .map_err(|e| e.to_string())?;

    let css = client
        .get(definition.css_url)
        .header(reqwest::header::ACCEPT, "text/css,*/*;q=0.1")
        .send()
        .await
        .map_err(|e| format!("failed to fetch font css: {e}"))?
        .error_for_status()
        .map_err(|e| format!("font css request failed: {e}"))?
        .text()
        .await
        .map_err(|e| format!("failed to read font css: {e}"))?;

    let faces = parse_google_font_css(&css)?;
    if faces.is_empty() {
        return Err("font css did not contain downloadable font faces".into());
    }

    let root = fonts_root();
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let final_dir = font_dir(definition.id);
    let tmp_dir = root.join(format!("{}.tmp-{}", definition.id, uuid::Uuid::new_v4()));
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    let result = async {
        let mut files = Vec::with_capacity(faces.len());
        for (index, face) in faces.into_iter().enumerate() {
            let file_name = format!("font-{index}.{}", face.extension);
            let target = tmp_dir.join(&file_name);
            let bytes = client
                .get(&face.url)
                .send()
                .await
                .map_err(|e| format!("failed to download font file: {e}"))?
                .error_for_status()
                .map_err(|e| format!("font file request failed: {e}"))?
                .bytes()
                .await
                .map_err(|e| format!("failed to read font file: {e}"))?;
            if bytes.is_empty() {
                return Err("downloaded font file was empty".into());
            }
            fs::write(&target, &bytes).map_err(|e| e.to_string())?;
            files.push(FontManifestFile {
                family: face.family,
                weight: face.weight,
                style: face.style,
                format: face.format,
                unicode_range: face.unicode_range,
                file_name,
            });
        }

        let manifest = FontManifest {
            font_id: definition.id.to_string(),
            source_css_url: definition.css_url.to_string(),
            css_len: css.len(),
            files,
        };
        let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
        fs::write(tmp_dir.join("manifest.json"), manifest_json).map_err(|e| e.to_string())?;

        if final_dir.exists() {
            fs::remove_dir_all(&final_dir).map_err(|e| e.to_string())?;
        }
        fs::rename(&tmp_dir, &final_dir).map_err(|e| e.to_string())?;
        manifest_to_result(&final_dir, manifest, true)
    }
    .await;

    if result.is_err() {
        let _ = fs::remove_dir_all(&tmp_dir);
    }
    result
}

#[derive(Debug)]
struct ParsedFontFace {
    family: String,
    weight: String,
    style: String,
    unicode_range: Option<String>,
    url: String,
    format: String,
    extension: String,
}

fn parse_google_font_css(css: &str) -> Result<Vec<ParsedFontFace>, String> {
    let face_re = Regex::new(r"(?s)@font-face\s*\{(?P<body>.*?)\}").map_err(|e| e.to_string())?;
    let prop_re =
        Regex::new(r"(?m)(font-family|font-style|font-weight|unicode-range)\s*:\s*([^;]+);")
            .map_err(|e| e.to_string())?;
    let url_re = Regex::new(
        r#"url\(['"]?(?P<url>https://[^)'"]+?\.(?P<ext>woff2|ttf))['"]?\)\s*format\(['"]?(?P<format>[^)'"]+)['"]?\)"#,
    )
    .map_err(|e| e.to_string())?;

    let mut faces = Vec::new();
    for cap in face_re.captures_iter(css) {
        let body = cap.name("body").map(|m| m.as_str()).unwrap_or_default();
        let mut family = None;
        let mut weight = None;
        let mut style = None;
        let mut unicode_range = None;
        for prop in prop_re.captures_iter(body) {
            let key = prop.get(1).map(|m| m.as_str()).unwrap_or_default();
            let value = prop
                .get(2)
                .map(|m| {
                    m.as_str()
                        .trim()
                        .trim_matches('\'')
                        .trim_matches('"')
                        .to_string()
                })
                .unwrap_or_default();
            match key {
                "font-family" => family = Some(value),
                "font-weight" => weight = Some(value),
                "font-style" => style = Some(value),
                "unicode-range" => unicode_range = Some(value),
                _ => {}
            }
        }
        let Some(url_cap) = url_re.captures(body) else {
            continue;
        };
        let url = url_cap
            .name("url")
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();
        let extension = url_cap
            .name("ext")
            .map(|m| m.as_str().to_string())
            .unwrap_or_else(|| "ttf".into());
        let format = url_cap
            .name("format")
            .map(|m| m.as_str().to_string())
            .unwrap_or_else(|| {
                if extension == "woff2" {
                    "woff2"
                } else {
                    "truetype"
                }
                .into()
            });
        faces.push(ParsedFontFace {
            family: family.unwrap_or_else(|| "Flowix Downloaded Font".into()),
            weight: weight.unwrap_or_else(|| "400".into()),
            style: style.unwrap_or_else(|| "normal".into()),
            unicode_range,
            url,
            format,
            extension,
        });
    }
    Ok(faces)
}

fn cached_manifest(font_id: &str) -> Option<CachedFontResult> {
    ensure_supported_font_id(font_id).ok()?;
    let dir = font_dir(font_id);
    let manifest_path = dir.join("manifest.json");
    let manifest = fs::read_to_string(manifest_path)
        .ok()
        .and_then(|content| serde_json::from_str::<FontManifest>(&content).ok())?;
    if manifest.font_id != font_id {
        return None;
    }
    if manifest.files.is_empty() {
        return None;
    }
    if manifest
        .files
        .iter()
        .any(|file| !dir.join(&file.file_name).exists())
    {
        return None;
    }
    manifest_to_result(&dir, manifest, true).ok()
}

fn manifest_to_result(
    dir: &Path,
    manifest: FontManifest,
    cached: bool,
) -> Result<CachedFontResult, String> {
    Ok(CachedFontResult {
        font_id: manifest.font_id,
        cached,
        files: manifest
            .files
            .into_iter()
            .map(|file| CachedFontFile {
                family: file.family,
                weight: file.weight,
                style: file.style,
                format: file.format,
                unicode_range: file.unicode_range,
                path: dir.join(file.file_name).to_string_lossy().to_string(),
            })
            .collect(),
    })
}

fn ensure_supported_font_id(font_id: &str) -> Result<(), String> {
    if FONT_DEFINITIONS
        .iter()
        .any(|definition| definition.id == font_id)
    {
        Ok(())
    } else {
        Err(format!("unsupported font id: {font_id}"))
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
