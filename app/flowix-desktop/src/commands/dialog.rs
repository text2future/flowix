use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::lock_utils::read_lock;

use crate::app::state::AppState;

// ==================== 鍩熷唴 helper ====================

mod attachment_fingerprint;
mod attachments;
mod base64_input;
mod upload_quota;
pub(crate) mod upload_sessions;

// ==================== IPC: 鍘熺敓 dialog ====================

#[tauri::command]
pub async fn select_directory(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择笔记本文件夹")
            .blocking_pick_folder()
            .map(|p| {
                let path = Path::new(&p.to_string()).to_path_buf();
                record_bookmark_directory(&app, &path);
                path.to_string_lossy().into_owned()
            })
    })
    .await
    .ok()
    .flatten()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsidianVaultRecord {
    pub name: String,
    pub path: String,
}

fn discover_obsidian_vaults() -> Result<Vec<ObsidianVaultRecord>, String> {
    let Some(config_dir) = dirs::config_dir() else {
        return Ok(Vec::new());
    };
    let config_path = config_dir.join("obsidian").join("obsidian.json");
    let contents = match fs::read_to_string(&config_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("OBSIDIAN_CONFIG_READ_FAILED".to_string()),
    };
    let config: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|_| "OBSIDIAN_CONFIG_INVALID".to_string())?;
    let Some(vaults) = config.get("vaults").and_then(serde_json::Value::as_object) else {
        return Ok(Vec::new());
    };

    let mut seen_paths = HashSet::new();
    let mut discovered = Vec::new();
    for vault in vaults.values() {
        let Some(configured_path) = vault.get("path").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let path = Path::new(configured_path);
        if !path.is_dir() {
            continue;
        }

        let canonical_path =
            fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(configured_path));
        let path_string = canonical_path.to_string_lossy().into_owned();
        let path_key = if cfg!(windows) {
            path_string.to_lowercase()
        } else {
            path_string.clone()
        };
        if !seen_paths.insert(path_key) {
            continue;
        }

        let name = canonical_path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or(configured_path)
            .to_string();
        discovered.push(ObsidianVaultRecord {
            name,
            path: path_string,
        });
    }

    discovered.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.path.to_lowercase().cmp(&right.path.to_lowercase()))
    });
    Ok(discovered)
}

#[tauri::command]
pub async fn list_obsidian_vaults() -> Result<Vec<ObsidianVaultRecord>, String> {
    tokio::task::spawn_blocking(discover_obsidian_vaults)
        .await
        .map_err(|error| format!("obsidian vault discovery task failed: {error}"))?
}

#[tauri::command]
pub async fn select_project_directory(
    app: tauri::AppHandle,
    project_source: String,
) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;

    let (title, relative_directory) = match project_source.as_str() {
        "workbuddy" => ("选择 WorkBuddy 项目文件夹", Path::new("workbuddy")),
        "codex" => ("选择 Codex 项目文件夹", Path::new("Documents/Codex")),
        _ => return None,
    };
    let home_directory = dirs::home_dir()?;
    let project_directory = home_directory.join(relative_directory);
    let start_directory = if project_directory.is_dir() {
        project_directory
    } else {
        home_directory
    };

    tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title(title)
            .set_directory(start_directory)
            .blocking_pick_folder()
            .map(|path| {
                let path = Path::new(&path.to_string()).to_path_buf();
                record_bookmark_directory(&app, &path);
                path.to_string_lossy().into_owned()
            })
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn select_import_directory(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Option<String> {
    let generation = app
        .state::<AppState>()
        .document_access
        .generation(window.label());
    use tauri_plugin_dialog::DialogExt;
    let handle = app.clone();
    let window_label = window.label().to_owned();
    tokio::task::spawn_blocking(move || {
        handle
            .dialog()
            .file()
            .set_title("选择要导入的文件夹")
            .blocking_pick_folder()
            .and_then(|path| {
                let path = Path::new(&path.to_string()).to_path_buf();
                let granted = handle
                    .state::<AppState>()
                    .document_access
                    .grant_directory_for_generation(&window_label, generation, &path);
                if granted {
                    record_bookmark_directory(&handle, &path);
                }
                granted.then(|| path.to_string_lossy().into_owned())
            })
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn select_files(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    accept: Option<String>,
    multiple: Option<bool>,
) -> Option<Vec<String>> {
    let generation = app
        .state::<AppState>()
        .document_access
        .generation(window.label());
    use tauri_plugin_dialog::DialogExt;
    use tokio::task;

    let handle = app.clone();
    task::spawn_blocking(move || {
        let dialog = handle.dialog().file().set_title("选择文件");
        let dialog = match accept.as_deref() {
            Some("image/*") => dialog.add_filter(
                "图片",
                &[
                    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "tif",
                    "tiff", "heic", "heif",
                ],
            ),
            Some("video/*") => {
                dialog.add_filter("视频", &["mp4", "webm", "mov", "avi", "mkv", "ogg"])
            }
            Some("media/*") => dialog.add_filter(
                "图片和视频",
                &[
                    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico", "tif",
                    "tiff", "heic", "heif", "3gp", "avi", "flv", "m2ts", "m4v", "mkv", "mov",
                    "mp4", "mpeg", "mpg", "mts", "webm", "wmv",
                ],
            ),
            _ => dialog.add_filter(
                "Attachments",
                &[
                    "png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "doc", "docx", "xls",
                    "xlsx", "ppt", "pptx", "txt", "md", "csv", "json", "mp3", "wav", "ogg", "mp4",
                    "webm", "mov", "avi", "zip", "rar", "7z", "tar", "gz",
                ],
            ),
        };
        let dialog = dialog.add_filter("All files", &["*"]);
        let result = if multiple.unwrap_or(true) {
            dialog.blocking_pick_files()
        } else {
            dialog.blocking_pick_file().map(|path| vec![path])
        }
        .map(|paths| {
            paths
                .into_iter()
                .filter_map(|path| {
                    let path = path.to_string();
                    let granted = handle
                        .state::<AppState>()
                        .document_access
                        .grant_for_generation(window.label(), generation, Path::new(&path));
                    if granted {
                        if let Err(error) = handle
                            .state::<AppState>()
                            .security_bookmarks
                            .record_file(Path::new(&path))
                        {
                            tracing::warn!(%error, "cannot persist selected file bookmark");
                        }
                        Some(path)
                    } else {
                        None
                    }
                })
                .collect::<Vec<String>>()
        });
        result
    })
    .await
    .ok()
    .flatten()
}

fn record_bookmark_directory(app: &tauri::AppHandle, path: &Path) {
    #[cfg(target_os = "macos")]
    if let Err(error) = app
        .state::<AppState>()
        .security_bookmarks
        .record_directory(path)
    {
        tracing::warn!(
            "failed to persist macOS folder bookmark for {}: {error}",
            path.display()
        );
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, path);
}

#[tauri::command]
pub async fn save_file_dialog(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    suggested_name: Option<String>,
    filters: Option<Vec<Vec<String>>>,
) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    use tokio::task;

    let handle = app.clone();
    let suggested = suggested_name.unwrap_or_else(|| "Untitled".to_string());
    let filter_list = filters.unwrap_or_default();
    app.state::<AppState>().export_access.revoke(window.label());
    let generation = app
        .state::<AppState>()
        .export_access
        .generation(window.label());

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

        let result = builder.blocking_save_file().and_then(|path| {
            handle
                .state::<AppState>()
                .export_access
                .grant_for_generation(window.label(), generation, Path::new(&path.to_string()))
                .map(|path| path.to_string_lossy().into_owned())
        });
        result
    })
    .await
    .ok()
    .flatten()
}

// ==================== IPC: notebook asset import ====================

#[tauri::command]
pub async fn save_notebook_asset(
    window: tauri::WebviewWindow,
    source_path: String,
    notebook_id: Option<String>,
    note_path: Option<String>,
    deduplicate: Option<bool>,
    reuse_notebook_file: Option<bool>,
    reuse_existing_attachment: Option<bool>,
    target_directory_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<Option<attachments::SavedNotebookAsset>, String> {
    let permit = upload_quota::UPLOAD_QUOTA.acquire()?;
    let source = Path::new(&source_path);
    let source = dunce::canonicalize(source).map_err(|error| error.to_string())?;
    if !super::helpers::can_access_document_path(&source, window.label(), &state) {
        return Err("Notebook asset source is not authorized".to_string());
    }
    if !source.is_file() {
        return Err("Attachment source is not a regular file".to_string());
    }
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid file name")?
        .to_string();
    let mut reader = fs::File::open(&source).map_err(|error| error.to_string())?;
    let metadata = reader.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Notebook asset source is not a regular file".to_string());
    }
    let root = {
        let store = read_lock(&state.memo_file, "memo_file");
        let (owner, _) =
            attachments::resolve_note_owner(&store, notebook_id.as_deref(), note_path.as_deref())
                .map_err(|error| error.to_string())?;
        attachments::notebook_root(&store, Some(&owner)).map_err(|error| error.to_string())?
    };
    // Notebook-local assets are already durable workspace files. Return their
    // canonical path instead of making an attachment copy.
    if reuse_notebook_file.unwrap_or(false) && source.starts_with(&root) {
        return Ok(Some(attachments::SavedNotebookAsset {
            path: source.to_string_lossy().into_owned(),
            created: false,
        }));
    }
    if metadata.len() > attachments::MAX_ATTACHMENT_BYTES {
        return Err("ATTACHMENT_FILE_TOO_LARGE".to_string());
    }
    let target_directory = target_directory_path.map(std::path::PathBuf::from);
    let memo_file = state.memo_file.clone();
    let deduplicate = deduplicate.unwrap_or(false);
    tokio::task::spawn_blocking(
        move || -> Result<Option<attachments::SavedNotebookAsset>, String> {
            let _permit = permit;
            let store = read_lock(&memo_file, "memo_file");
            let saved = attachments::save_for_owner_in_directory(
                &store,
                notebook_id.as_deref(),
                note_path.as_deref(),
                &name,
                &mut reader,
                deduplicate,
                target_directory.as_deref(),
                reuse_existing_attachment.unwrap_or(true),
            )
            .map_err(|error| error.to_string())?;
            Ok(Some(saved))
        },
    )
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn copy_attachment_file(
    window: tauri::WebviewWindow,
    source_path: String,
    target_path: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let source = attachments::authorized_attachment(
        &read_lock(&state.memo_file, "memo_file"),
        Path::new(&source_path),
    )
    .map_err(|error| error.to_string())?;
    let source = source.as_path();

    let mut reader = fs::File::open(source).map_err(|error| error.to_string())?;
    state
        .export_access
        .save(
            window.label(),
            Path::new(&target_path),
            &mut reader,
            &read_lock(&state.memo_file, "memo_file"),
        )
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn open_attachment_file(
    app: tauri::AppHandle,
    source_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let source = attachments::authorized_attachment(
        &read_lock(&state.memo_file, "memo_file"),
        Path::new(&source_path),
    )
    .map_err(|error| error.to_string())?;
    let source = source.as_path();

    app.opener()
        .open_path(source.display().to_string(), None::<String>)
        .map_err(|e| e.to_string())
}

// ==================== IPC: 瀵煎嚭 ====================

#[tauri::command]
pub fn write_export_file(
    window: tauri::WebviewWindow,
    file_path: String,
    content: String,
    state: State<'_, AppState>,
) -> bool {
    state
        .export_access
        .save(
            window.label(),
            Path::new(&file_path),
            &mut content.as_bytes(),
            &read_lock(&state.memo_file, "memo_file"),
        )
        .is_ok()
}
