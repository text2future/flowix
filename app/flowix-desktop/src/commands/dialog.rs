//! Dialog IPC — 原生 dialog + 附件保存 + 导出文件。
//!
//! 7 个 IPC:
//! - `select_directory` / `select_files` / `save_file_dialog` — 走 tauri-plugin-dialog
//! - `save_attachment` / `save_attachment_content` — 拷贝到 `<notebook>/attachments/`
//! - `copy_attachment_file` — 把附件复制到保存对话框选中的目标路径
//! - `write_export_file` — 写任意路径 (无 scope guard, 风险点)
//!
//! 4 个域内 helper: `sanitize_attachment_file_name` / `unique_attachment_path`
//! (注意: 这两个**不是**跨域, 所以放在本文件而不是 helpers.rs) /
//! `base64_decode` / `write_bytes_to_path`。

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use tauri::{Manager, State};

use crate::lock_utils::{read_lock, write_lock};

use super::AppState;

// ==================== 域内 helper ====================

fn sanitize_attachment_file_name(name: &str) -> String {
    let leaf = Path::new(name)
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or("attachment");

    let sanitized: String = leaf
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                '_'
            } else {
                ch
            }
        })
        .collect();

    let sanitized = sanitized.trim_matches(|ch| matches!(ch, ' ' | '.'));
    if sanitized.is_empty() {
        "attachment".to_string()
    } else {
        sanitized.to_string()
    }
}

fn unique_attachment_path(attachments_dir: &Path, requested_name: &str) -> Result<PathBuf, String> {
    use crate::path_scope::path_is_inside;

    let safe_name = sanitize_attachment_file_name(requested_name);
    let candidate = attachments_dir.join(&safe_name);
    if !path_is_inside(&candidate, attachments_dir) {
        return Err("Invalid attachment path".to_string());
    }
    if !candidate.exists() {
        return Ok(candidate);
    }

    let safe_path = Path::new(&safe_name);
    let stem = safe_path
        .file_stem()
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or("attachment");
    let ext = safe_path.extension().and_then(std::ffi::OsStr::to_str);

    for index in 1..10_000 {
        let file_name = match ext {
            Some(ext) if !ext.is_empty() => format!("{}_{}.{}", stem, index, ext),
            _ => format!("{}_{}", stem, index),
        };
        let candidate = attachments_dir.join(file_name);
        if !path_is_inside(&candidate, attachments_dir) {
            return Err("Invalid attachment path".to_string());
        }
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err("Unable to allocate attachment file name".to_string())
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    // Handle both standard base64 and URL-safe base64
    let input = input.replace('-', "+").replace('_', "/");
    let padding = match input.len() % 4 {
        2 => "==",
        3 => "=",
        _ => "",
    };
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(format!("{}{}", input, padding))
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    Ok(decoded)
}

fn write_bytes_to_path(file_path: &str, bytes: &[u8]) -> bool {
    if file_path.trim().is_empty() {
        return false;
    }
    let path = Path::new(file_path);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(path, bytes).is_ok()
}

// ==================== IPC: 原生 dialog ====================

#[tauri::command]
pub async fn select_directory(app: tauri::AppHandle) -> Option<String> {
    use std::sync::mpsc;
    #[cfg(not(target_os = "macos"))]
    use tauri_plugin_dialog::DialogExt;
    #[cfg(not(target_os = "macos"))]
    use tokio::task;

    let (tx, rx) = mpsc::channel();

    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        let state_handle = handle.clone();
        handle
            .run_on_main_thread(move || {
                let result = crate::security_bookmark::pick_directory_with_bookmark(
                    "选择笔记本文件夹",
                )
                .map(|(path, _bookmark)| {
                    let state = state_handle.state::<AppState>();
                    if let Err(e) = state.security_bookmarks.record_directory(Path::new(&path)) {
                        tracing::warn!("[select_directory] failed to persist bookmark: {e}");
                    }
                    path
                });
                tx.send(result).ok();
            })
            .ok()?;
        return rx.recv().ok().flatten();
    }

    #[cfg(not(target_os = "macos"))]
    // Run blocking dialog in a background thread to avoid freezing the UI
    let handle = app.clone();
    #[cfg(not(target_os = "macos"))]
    task::spawn_blocking(move || {
        let result = handle
            .dialog()
            .file()
            .set_title("选择笔记本文件夹")
            .blocking_pick_folder()
            .map(|p| p.to_string());
        tx.send(result).ok();
    });

    #[cfg(not(target_os = "macos"))]
    rx.recv().ok().flatten()
}

#[tauri::command]
pub async fn select_files(app: tauri::AppHandle) -> Option<Vec<String>> {
    use std::sync::mpsc;
    use tauri_plugin_dialog::DialogExt;
    use tokio::task;

    let (tx, rx) = mpsc::channel();

    let handle = app.clone();
    task::spawn_blocking(move || {
        let result = handle
            .dialog()
            .file()
            .add_filter(
                "Attachments",
                &[
                    "png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "doc", "docx", "xls",
                    "xlsx", "ppt", "pptx", "txt", "md", "csv", "json", "mp3", "wav", "ogg", "mp4",
                    "webm", "mov", "avi", "zip", "rar", "7z", "tar", "gz",
                ],
            )
            .set_title("选择图片")
            .add_filter("图片", &["png", "jpg", "jpeg", "gif", "webp", "svg"])
            .add_filter("All files", &["*"])
            .blocking_pick_files()
            .map(|paths| paths.into_iter().map(|p| p.to_string()).collect());
        tx.send(result).ok();
    });

    rx.recv().ok().flatten()
}

#[tauri::command]
pub async fn save_file_dialog(
    app: tauri::AppHandle,
    suggested_name: Option<String>,
    filters: Option<Vec<Vec<String>>>,
) -> Option<String> {
    use std::sync::mpsc;
    use tauri_plugin_dialog::DialogExt;
    use tokio::task;

    let (tx, rx) = mpsc::channel();

    let handle = app.clone();
    let suggested = suggested_name.unwrap_or_else(|| "Untitled".to_string());
    let filter_list = filters.unwrap_or_default();

    task::spawn_blocking(move || {
        let mut builder = handle
            .dialog()
            .file()
            .set_title("保存文件")
            .set_file_name(&suggested);

        for filter in &filter_list {
            if filter.is_empty() {
                continue;
            }
            let name = filter[0].clone();
            let exts: Vec<&str> = filter.iter().skip(1).map(|s| s.as_str()).collect();
            if !exts.is_empty() {
                builder = builder.add_filter(&name, &exts);
            }
        }

        let result = builder.blocking_save_file().map(|p| p.to_string());
        tx.send(result).ok();
    });

    rx.recv().ok().flatten()
}

// ==================== IPC: 附件保存 ====================

#[tauri::command]
pub async fn save_attachment(
    source_path: String,
    notebook_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    {
        let mut memo_file = write_lock(&state.memo_file, "memo_file");
        if let Some(ref id) = notebook_id {
            memo_file.set_current_notebook(Some(id.clone()));
        }
    }

    let attachments_dir = read_lock(&state.memo_file, "memo_file")
        .get_memo_base()
        .join("attachments");
    fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;

    let source = Path::new(&source_path);
    let file_name = source
        .file_name()
        .ok_or("Invalid file name")?
        .to_str()
        .ok_or("Invalid file name")?;
    let dest_path = unique_attachment_path(&attachments_dir, file_name)?;

    fs::copy(&source_path, &dest_path).map_err(|e| e.to_string())?;

    Ok(Some(dest_path.to_str().unwrap().to_string()))
}

#[tauri::command]
pub async fn save_attachment_content(
    content: String,
    file_name: String,
    notebook_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    {
        let mut memo_file = write_lock(&state.memo_file, "memo_file");
        if let Some(ref id) = notebook_id {
            memo_file.set_current_notebook(Some(id.clone()));
        }
    }

    let attachments_dir = read_lock(&state.memo_file, "memo_file")
        .get_memo_base()
        .join("attachments");
    fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;

    let dest_path = unique_attachment_path(&attachments_dir, &file_name)?;

    // Decode base64 content and write to file
    let decoded = base64_decode(&content).map_err(|e| format!("Failed to decode base64: {}", e))?;
    fs::write(&dest_path, decoded).map_err(|e| e.to_string())?;

    Ok(Some(dest_path.to_str().unwrap().to_string()))
}

#[tauri::command]
pub async fn copy_attachment_file(
    source_path: String,
    target_path: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    use crate::path_scope::path_is_inside;

    let attachments_dir = read_lock(&state.memo_file, "memo_file")
        .get_memo_base()
        .join("attachments");
    let source = Path::new(&source_path);

    if !path_is_inside(source, &attachments_dir) {
        return Err("Source is not an attachment".to_string());
    }

    if !source.is_file() {
        return Err("Attachment does not exist".to_string());
    }

    fs::copy(source, Path::new(&target_path)).map_err(|e| e.to_string())?;
    Ok(true)
}

// ==================== IPC: 导出 ====================

/// 写任意路径 (无 scope guard) — 历史遗留: 导出功能不走 notebook 限制。
/// 风险: 前端可以传任意路径。已在 caller 侧加 `expectedDirectory` 等弱校验。
#[tauri::command]
pub fn write_export_file(file_path: String, content: String) -> bool {
    write_bytes_to_path(&file_path, content.as_bytes())
}
