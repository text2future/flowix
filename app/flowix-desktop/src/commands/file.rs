use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{State, WebviewWindow};

use crate::config::path_is_inside;
use crate::lock_utils::read_lock;
use flowix_core::memo_file::{media_kind_for_path, notebook_path_from_relative, MemoColor};

use super::helpers::{
    can_access_document_path, can_access_scoped_file, is_agent_access_folder,
    is_internal_notebook_path, is_registered_notebook_path, is_registered_notebook_root,
    start_security_bookmark_access,
};
use crate::app::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocTreeItem {
    pub id: String,
    pub full_path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub parent_id: Option<String>,
    pub children: Option<Vec<DocTreeItem>>,
    /// 文件字节大小 (folder 为 None, 避免递归统计目录大小的开销)。
    pub size_bytes: Option<u64>,
    /// 最后修改时间 (Unix epoch 毫秒; 文件与 folder 均适用)。
    pub modified_ms: Option<u64>,
    /// 创建时间 (Unix epoch 毫秒; macOS/Windows 免费读, 其余平台为 None)。
    pub created_ms: Option<u64>,
    /// Flowix 笔记的业务创建时间 (Unix epoch 毫秒)。对于已索引的笔记，
    /// 该值来自 memo index，不受原子替换文件导致的文件系统创建时间变化影响。
    pub memo_created_ms: Option<u64>,
    pub memo_meta: Option<DocTreeMemoMeta>,
    /// Resource classification for document nodes. Folders use `None`.
    pub resource_kind: Option<DocTreeResourceKind>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DocTreeResourceKind {
    Note,
    Image,
    Video,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocTreeMemoMeta {
    pub id: String,
    pub icon: Option<String>,
    pub colors: Vec<MemoColor>,
    pub favorited: bool,
}

#[derive(Debug, Clone)]
struct MemoTreeMetadata {
    created_ms: Option<u64>,
    memo: DocTreeMemoMeta,
}

// ==================== 域内 helper ====================

fn generate_stable_id(full_path: &str) -> String {
    format!(
        "file-{}",
        full_path.replace(['\\', '/', '#', '%', '?', '&'], "_")
    )
}

fn system_time_to_ms(t: SystemTime) -> Option<u64> {
    t.duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

fn modified_time_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified().ok().and_then(system_time_to_ms)
}

/// 创建时间 → Unix epoch 毫秒。macOS (`st_birthtime`) 与 Windows
/// (`creation_time`) 都在同一次 stat 结果里, 读取零额外 syscall; 其余
/// 平台 std 不提供 birth time, 返回 None。
fn created_time_ms(meta: &fs::Metadata) -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        let secs = meta.st_birthtime();
        return (secs >= 0).then_some(secs as u64 * 1000);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        // FILETIME: 100ns 自 1601-01-01; 与 Unix epoch 相差 11,644,473,600 秒。
        const WINDOWS_TO_UNIX_EPOCH_MS: u64 = 11_644_473_600_000;
        let ms_since_1601 = meta.creation_time() / 10_000; // 100ns → ms
        return Some(ms_since_1601.saturating_sub(WINDOWS_TO_UNIX_EPOCH_MS));
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = meta;
        None
    }
}

/// 单层目录列举 ── 只列直接子项, folder 的 `children` 置空占位, 由前端
/// 展开时再对子目录调 `get_dir_children` 惰性拉取 (VSCode 风格)。资料
/// 文夹可能很大, 全量递归会卡首屏; 单层也天然规避符号链接循环。
fn resource_kind_for_path(path: &Path) -> Option<DocTreeResourceKind> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    if matches!(extension.as_str(), "md" | "markdown") {
        return Some(DocTreeResourceKind::Note);
    }
    if matches!(
        extension.as_str(),
        "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "bmp"
            | "svg"
            | "avif"
            | "ico"
            | "tif"
            | "tiff"
            | "heic"
    ) {
        return Some(DocTreeResourceKind::Image);
    }
    if matches!(
        extension.as_str(),
        "3gp"
            | "avi"
            | "flv"
            | "m2ts"
            | "m4v"
            | "mkv"
            | "mov"
            | "mp4"
            | "mpeg"
            | "mpg"
            | "mts"
            | "webm"
            | "wmv"
    ) {
        return Some(DocTreeResourceKind::Video);
    }
    Some(DocTreeResourceKind::Other)
}

/// Hide legacy media-property YAML files from the notebook tree. New media
/// properties are stored in `.flowix/notebook.db`; this keeps old files from
/// becoming visible after upgrading.
fn is_media_properties_sidecar(path: &Path) -> bool {
    let is_yaml = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("yaml"));
    if !is_yaml {
        return false;
    }
    let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
        return false;
    };
    media_kind_for_path(Path::new(stem)).is_some()
}

fn canonical_path(path: &Path) -> std::path::PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn relative_memo_is_direct_child(relative_path: &Path, relative_directory: &Path) -> bool {
    relative_path.parent().unwrap_or_else(|| Path::new("")) == relative_directory
}

/// 读取当前目录直接子项所需的笔记元数据。MemoFile 已缓存当前笔记本
/// index；这里进一步只为当前目录的 Markdown 条目建立 path map，避免每次
/// 展开小目录都为整个笔记本执行路径拼接与 canonicalize。
/// 非笔记本目录返回 None，外部 Markdown 文件继续使用文件系统时间。
fn memo_tree_metadata_for_directory(
    directory_path: &Path,
    state: &State<AppState>,
) -> Option<HashMap<std::path::PathBuf, MemoTreeMetadata>> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let canonical_directory = canonical_path(directory_path);
    let config = memo_file
        .read_notebook_configs()
        .ok()?
        .into_iter()
        .filter(|config| path_is_inside(&canonical_directory, Path::new(&config.path)))
        .max_by_key(|config| Path::new(&config.path).components().count())?;
    let notebook_root = canonical_path(Path::new(&config.path));
    let relative_directory = canonical_directory
        .strip_prefix(&notebook_root)
        .ok()?
        .to_path_buf();
    let index = memo_file
        .read_index_for_notebook_id(Some(&config.id))
        .ok()??;

    Some(
        index
            .memos
            .into_iter()
            .filter_map(|entry| {
                let relative_path = if entry.relative_path.is_empty() {
                    entry.filename
                } else {
                    entry.relative_path
                };
                if !relative_memo_is_direct_child(Path::new(&relative_path), &relative_directory) {
                    return None;
                }
                let path =
                    notebook_path_from_relative(Path::new(&config.path), &relative_path).ok()?;
                Some((
                    canonical_path(&path),
                    MemoTreeMetadata {
                        created_ms: u64::try_from(entry.created_at).ok(),
                        memo: DocTreeMemoMeta {
                            id: entry.id,
                            icon: entry.icon,
                            colors: entry.colors,
                            favorited: entry.favorited,
                        },
                    },
                ))
            })
            .collect(),
    )
}

fn read_dir_single_level(
    dir_path: &Path,
    memo_metadata: Option<&HashMap<std::path::PathBuf, MemoTreeMetadata>>,
    include_hidden_directories: bool,
    show_agents_file: bool,
) -> Vec<DocTreeItem> {
    let mut items = Vec::new();

    if !dir_path.exists() {
        return items;
    }

    if let Ok(entries) = fs::read_dir(dir_path) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if !path_is_inside(&path, dir_path) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();

            // .flowix is application-owned notebook data. It stays hidden
            // even when the user opts into hidden directories.
            if name == ".flowix" {
                continue;
            }

            if is_media_properties_sidecar(&path) {
                continue;
            }

            // AGENTS.md remains on disk for native Agent runtimes to load;
            // visibility is controlled by the user preference.
            if name == "AGENTS.md" && !show_agents_file {
                continue;
            }

            // Hidden files remain hidden. The notebook tree can opt into
            // hidden directories so Markdown files below them can be loaded,
            // but dot-files themselves are never tree items.
            let meta = fs::metadata(&path).ok();
            let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            if name.starts_with('.') && (!is_dir || !include_hidden_directories) {
                continue;
            }

            // 一次 fs::metadata() 同时拿类型与大小 (语义与原先 path.is_dir()
            // 一致、跟随符号链接): 文件取 len()、folder 置 None, 不做递归统计。
            let size_bytes = if is_dir {
                None
            } else {
                meta.as_ref().map(|m| m.len())
            };
            let modified_ms = meta.as_ref().and_then(modified_time_ms);
            let created_ms = meta.as_ref().and_then(created_time_ms);
            let resource_kind = if is_dir {
                None
            } else {
                resource_kind_for_path(&path)
            };
            // Only Markdown notes can have memo metadata. Images, videos,
            // generic files and folders skip the canonicalize syscall.
            let memo_metadata = if matches!(&resource_kind, Some(DocTreeResourceKind::Note)) {
                memo_metadata.and_then(|items| items.get(&canonical_path(&path)))
            } else {
                None
            };
            let item = DocTreeItem {
                id: generate_stable_id(&path.to_string_lossy()),
                full_path: path.to_string_lossy().to_string(),
                name,
                item_type: if is_dir {
                    "folder".to_string()
                } else {
                    "document".to_string()
                },
                parent_id: None,
                children: if is_dir { Some(Vec::new()) } else { None },
                size_bytes,
                modified_ms,
                created_ms,
                memo_created_ms: memo_metadata.and_then(|metadata| metadata.created_ms),
                memo_meta: memo_metadata.map(|metadata| metadata.memo.clone()),
                resource_kind,
            };

            items.push(item);
        }
    }

    // Sort: folders first, then by name
    items.sort_by(|a, b| {
        if a.item_type != b.item_type {
            if a.item_type == "folder" {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            }
        } else {
            a.name.cmp(&b.name)
        }
    });

    items
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookViewPreferences {
    #[serde(default)]
    pub hidden_list_folders: Vec<String>,
}

fn notebook_preferences_path(root: &Path) -> Result<std::path::PathBuf, String> {
    let flowix_dir = root.join(".flowix");
    match fs::symlink_metadata(&flowix_dir) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("INVALID_NOTEBOOK_CONFIG_DIRECTORY".to_string());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("inspect notebook config directory failed: {error}")),
    }
    Ok(flowix_dir.join("view-preferences.json"))
}

fn read_notebook_view_preferences(root: &Path) -> NotebookViewPreferences {
    let Ok(path) = notebook_preferences_path(root) else {
        return NotebookViewPreferences::default();
    };
    let Some(bytes) = (match fs::read(&path) {
        Ok(bytes) => Some(bytes),
        // Compatibility with the release that stored view preferences in the
        // same file as the notebook identity manifest.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::read(root.join(".flowix/notebook.json")).ok()
        }
        Err(_) => None,
    }) else {
        return NotebookViewPreferences::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn normalize_hidden_list_folders(folders: Vec<String>) -> Result<Vec<String>, String> {
    let mut normalized = Vec::new();
    for folder in folders {
        let trimmed = folder.trim_matches('/');
        if trimmed.is_empty() || trimmed.contains('\\') || trimmed.contains('\0') {
            return Err("INVALID_NOTEBOOK_FOLDER_PREFERENCE".to_string());
        }
        let path = Path::new(trimmed);
        if path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err("INVALID_NOTEBOOK_FOLDER_PREFERENCE".to_string());
        }
        let value = path.to_string_lossy().replace('\\', "/");
        if !normalized.contains(&value) {
            normalized.push(value);
        }
    }
    Ok(normalized)
}

#[tauri::command]
pub fn get_notebook_view_preferences(
    notebook_path: String,
    state: State<AppState>,
) -> Result<NotebookViewPreferences, String> {
    let root = Path::new(&notebook_path);
    if !is_registered_notebook_root(root, &state) {
        return Err("NOTEBOOK_NOT_REGISTERED".to_string());
    }
    Ok(read_notebook_view_preferences(root))
}

#[tauri::command]
pub fn set_notebook_view_preferences(
    notebook_path: String,
    preferences: NotebookViewPreferences,
    state: State<AppState>,
) -> Result<(), String> {
    let root = Path::new(&notebook_path);
    if !is_registered_notebook_root(root, &state) {
        return Err("NOTEBOOK_NOT_REGISTERED".to_string());
    }
    let root = fs::canonicalize(root)
        .map_err(|error| format!("resolve notebook directory failed: {error}"))?;
    let path = notebook_preferences_path(&root)?;
    let parent = path
        .parent()
        .expect("notebook preferences have a parent directory");
    fs::create_dir_all(parent)
        .map_err(|error| format!("create notebook config directory failed: {error}"))?;
    let preferences = NotebookViewPreferences {
        hidden_list_folders: normalize_hidden_list_folders(preferences.hidden_list_folders)?,
    };
    let bytes = serde_json::to_vec_pretty(&preferences)
        .map_err(|error| format!("serialize notebook preferences failed: {error}"))?;
    flowix_core::memo_file::atomic_write_bytes(&path, &bytes)
        .map_err(|error| format!("write notebook preferences failed: {error}"))
}

// ==================== IPC ====================

#[tauri::command]
pub fn get_file_tree(
    space_path: String,
    include_hidden_directories: Option<bool>,
    show_agents_file: Option<bool>,
    state: State<AppState>,
) -> Option<Vec<DocTreeItem>> {
    let path = Path::new(&space_path);
    start_security_bookmark_access(&state, path);
    if !path.exists()
        || is_internal_notebook_path(path, &state)
        || !is_browsable_scope(path, &state)
    {
        return None;
    }
    let memo_metadata = memo_tree_metadata_for_directory(path, &state);
    Some(read_dir_single_level(
        path,
        memo_metadata.as_ref(),
        include_hidden_directories.unwrap_or(false),
        show_agents_file.unwrap_or(false),
    ))
}

#[tauri::command]
pub fn get_dir_children(
    dir_path: String,
    include_hidden_directories: Option<bool>,
    show_agents_file: Option<bool>,
    state: State<AppState>,
) -> Vec<DocTreeItem> {
    let path = Path::new(&dir_path);
    start_security_bookmark_access(&state, path);
    if !path.exists()
        || is_internal_notebook_path(path, &state)
        || !is_browsable_scope(path, &state)
    {
        return vec![];
    }
    let memo_metadata = memo_tree_metadata_for_directory(path, &state);
    read_dir_single_level(
        path,
        memo_metadata.as_ref(),
        include_hidden_directories.unwrap_or(false),
        show_agents_file.unwrap_or(false),
    )
}

/// 文件树可浏览作用域 ── 注册笔记本根 或 资料文件夹 (agent access
/// folder entry), 两者都要求 path 本身落在作用域内 (子目录随
/// `path_is_inside` 一并放行)。
fn is_browsable_scope(path: &Path, state: &State<AppState>) -> bool {
    !is_internal_notebook_path(path, state)
        && (is_registered_notebook_path(path, state) || is_agent_access_folder(path, state))
}

#[tauri::command]
pub fn read_file(
    file_path: String,
    space_path: Option<String>,
    state: State<AppState>,
) -> Option<String> {
    if !can_access_scoped_file(Path::new(&file_path), space_path.as_deref(), &state) {
        eprintln!("[read_file] refused out-of-scope path: {}", file_path);
        return None;
    }
    start_security_bookmark_access(&state, Path::new(&file_path));
    fs::read_to_string(&file_path).ok()
}

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
        _ => None,
    }
}

/// Read an in-scope image as a data URL so the webview can preview arbitrary
/// user files without widening the Tauri asset-protocol scope.
#[tauri::command]
pub fn read_image_file(
    file_path: String,
    space_path: Option<String>,
    state: State<AppState>,
) -> Option<String> {
    let path = Path::new(&file_path);
    let mime = image_mime_type(path)?;
    if !can_access_scoped_file(path, space_path.as_deref(), &state) || !path.is_file() {
        eprintln!("[read_image_file] refused file: {}", file_path);
        return None;
    }
    start_security_bookmark_access(&state, path);
    let bytes = fs::read(path).ok()?;
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[tauri::command]
pub fn write_file(
    file_path: String,
    content: String,
    _skip_validation: Option<bool>,
    space_path: Option<String>,
    state: State<AppState>,
) -> bool {
    if !can_access_scoped_file(Path::new(&file_path), space_path.as_deref(), &state) {
        eprintln!("[write_file] refused out-of-scope path: {}", file_path);
        return false;
    }
    start_security_bookmark_access(&state, Path::new(&file_path));
    read_lock(&state.memo_file, "memo_file")
        .write_file(Path::new(&file_path), content.as_bytes())
        .is_ok()
}

#[tauri::command]
pub fn delete_file(file_path: String, space_path: Option<String>, state: State<AppState>) -> bool {
    if !can_access_scoped_file(Path::new(&file_path), space_path.as_deref(), &state) {
        eprintln!("[delete_file] refused out-of-scope path: {}", file_path);
        return false;
    }
    start_security_bookmark_access(&state, Path::new(&file_path));
    read_lock(&state.memo_file, "memo_file")
        .delete_file(Path::new(&file_path))
        .is_ok()
}

#[tauri::command]
pub fn delete_folder(folder_path: String, space_path: String, state: State<AppState>) -> bool {
    let folder = Path::new(&folder_path);
    let scope = Path::new(&space_path);
    // Never allow the notebook root itself to be removed. The folder command
    // is intentionally recursive because a notebook folder may contain notes
    // and nested folders.
    if !path_is_inside(folder, scope)
        || folder == scope
        || is_internal_notebook_path(folder, &state)
        || !is_browsable_scope(scope, &state)
    {
        eprintln!(
            "[delete_folder] refused out-of-scope or notebook-root path: {}",
            folder_path
        );
        return false;
    }
    start_security_bookmark_access(&state, folder);
    fs::remove_dir_all(folder).is_ok()
}

fn file_mutation_error(error: std::io::Error) -> String {
    let code = match error.kind() {
        std::io::ErrorKind::AlreadyExists => "FILE_EXISTS",
        std::io::ErrorKind::NotFound => "FILE_NOT_FOUND",
        std::io::ErrorKind::PermissionDenied => "FILE_PERMISSION_DENIED",
        _ => "FILE_OPERATION_FAILED",
    };
    format!("{code}: {error}")
}

fn validate_file_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty()
        || name == "."
        || name == ".."
        || name.ends_with(['.', ' '])
        || name.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'
                )
        })
    {
        return Err("INVALID_FILE_NAME".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn rename_file(
    file_path: String,
    name: String,
    space_path: String,
    state: State<AppState>,
) -> Result<String, String> {
    validate_file_name(&name)?;
    let source = Path::new(&file_path);
    let parent = source.parent().ok_or("INVALID_FILE_PATH")?;
    let target = parent.join(name);
    if !can_access_scoped_file(source, Some(&space_path), &state)
        || !can_access_scoped_file(&target, Some(&space_path), &state)
    {
        return Err("FILE_PERMISSION_DENIED".to_string());
    }
    start_security_bookmark_access(&state, source);
    if !fs::symlink_metadata(source)
        .map_err(file_mutation_error)?
        .is_file()
    {
        return Err("SOURCE_NOT_REGULAR_FILE".to_string());
    }
    read_lock(&state.memo_file, "memo_file")
        .rename_file(source, &target)
        .map_err(file_mutation_error)?;
    Ok(target.to_string_lossy().into_owned())
}

/// Move a regular file within the caller's notebook/access-folder scope.
/// Indexed notes use the memo move command; this command handles images,
/// videos, and other unindexed resources.
#[tauri::command]
pub fn move_file(
    file_path: String,
    target_directory_path: String,
    space_path: String,
    state: State<AppState>,
) -> Result<String, String> {
    let source = Path::new(&file_path);
    let target_directory = Path::new(&target_directory_path);
    let scope = Path::new(&space_path);
    if !is_browsable_scope(scope, &state)
        || !can_access_scoped_file(source, Some(&space_path), &state)
        || !can_access_scoped_file(target_directory, Some(&space_path), &state)
    {
        return Err("FILE_PERMISSION_DENIED".to_string());
    }
    start_security_bookmark_access(&state, source);
    start_security_bookmark_access(&state, target_directory);
    if !fs::symlink_metadata(source)
        .map_err(file_mutation_error)?
        .is_file()
    {
        return Err("SOURCE_NOT_REGULAR_FILE".to_string());
    }
    if !fs::symlink_metadata(target_directory)
        .map_err(file_mutation_error)?
        .is_dir()
    {
        return Err("TARGET_NOT_DIRECTORY".to_string());
    }
    let file_name = source.file_name().ok_or("INVALID_FILE_PATH")?;
    let target = target_directory.join(file_name);
    if !can_access_scoped_file(&target, Some(&space_path), &state) {
        return Err("FILE_PERMISSION_DENIED".to_string());
    }
    if source == target {
        return Ok(source.to_string_lossy().into_owned());
    }
    if fs::symlink_metadata(&target).is_ok() {
        return Err(file_mutation_error(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "target already exists",
        )));
    }
    read_lock(&state.memo_file, "memo_file")
        .rename_file(source, &target)
        .map_err(file_mutation_error)?;
    Ok(target.to_string_lossy().into_owned())
}

/// Move a folder within the caller's notebook/access-folder scope.
#[tauri::command]
pub fn move_folder(
    folder_path: String,
    target_directory_path: String,
    space_path: String,
    state: State<AppState>,
) -> Result<String, String> {
    let source = Path::new(&folder_path);
    let target_directory = Path::new(&target_directory_path);
    let scope = Path::new(&space_path);
    if source == scope
        || !is_browsable_scope(scope, &state)
        || !path_is_inside(source, scope)
        || !path_is_inside(target_directory, scope)
        || is_internal_notebook_path(source, &state)
        || is_internal_notebook_path(target_directory, &state)
    {
        return Err("FILE_PERMISSION_DENIED".to_string());
    }
    start_security_bookmark_access(&state, source);
    start_security_bookmark_access(&state, target_directory);
    if !fs::symlink_metadata(source)
        .map_err(file_mutation_error)?
        .is_dir()
    {
        return Err("SOURCE_NOT_DIRECTORY".to_string());
    }
    if !fs::symlink_metadata(target_directory)
        .map_err(file_mutation_error)?
        .is_dir()
    {
        return Err("TARGET_NOT_DIRECTORY".to_string());
    }
    if path_is_inside(target_directory, source) {
        return Err("INVALID_MOVE_TARGET".to_string());
    }
    let folder_name = source.file_name().ok_or("INVALID_FILE_PATH")?;
    let target = target_directory.join(folder_name);
    if !path_is_inside(&target, scope) || is_internal_notebook_path(&target, &state) {
        return Err("FILE_PERMISSION_DENIED".to_string());
    }
    if source == target {
        return Ok(source.to_string_lossy().into_owned());
    }
    if fs::symlink_metadata(&target).is_ok() {
        return Err(file_mutation_error(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "target already exists",
        )));
    }
    fs::rename(source, &target).map_err(file_mutation_error)?;
    Ok(target.to_string_lossy().into_owned())
}

/// Copy a supported external resource into the caller's notebook scope.
/// External drag-and-drop is intentionally an import, so the source remains
/// unchanged and only the new notebook path is returned to the tree.
#[tauri::command]
pub async fn import_file(
    window: WebviewWindow,
    file_path: String,
    target_directory_path: String,
    space_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let source = Path::new(&file_path);
    let target_directory = Path::new(&target_directory_path);
    let scope = Path::new(&space_path);
    if !is_browsable_scope(scope, &state)
        || !can_access_scoped_file(target_directory, Some(&space_path), &state)
    {
        return Err("FILE_PERMISSION_DENIED".to_string());
    }
    // WebView2 can invoke this command just before Tauri's Drop RunEvent has
    // recorded the exact external path in DocumentAccess. Wait briefly for
    // that capability handoff; never authorize the caller-supplied path here.
    let mut source_allowed = can_access_document_path(source, window.label(), &state)
        || can_access_scoped_file(source, Some(&space_path), &state);
    for _ in 0..20 {
        if source_allowed {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        source_allowed = can_access_document_path(source, window.label(), &state)
            || can_access_scoped_file(source, Some(&space_path), &state);
    }
    if !source_allowed {
        return Err("FILE_PERMISSION_DENIED".to_string());
    }
    start_security_bookmark_access(&state, source);
    start_security_bookmark_access(&state, target_directory);
    if !fs::symlink_metadata(source)
        .map_err(file_mutation_error)?
        .is_file()
    {
        return Err("SOURCE_NOT_REGULAR_FILE".to_string());
    }
    if !matches!(
        resource_kind_for_path(source),
        Some(DocTreeResourceKind::Note | DocTreeResourceKind::Image | DocTreeResourceKind::Video)
    ) {
        return Err("UNSUPPORTED_IMPORT_FILE".to_string());
    }
    if !fs::symlink_metadata(target_directory)
        .map_err(file_mutation_error)?
        .is_dir()
    {
        return Err("TARGET_NOT_DIRECTORY".to_string());
    }
    let file_name = source.file_name().ok_or("INVALID_FILE_PATH")?;
    let target = target_directory.join(file_name);
    if !can_access_scoped_file(&target, Some(&space_path), &state) {
        return Err("FILE_PERMISSION_DENIED".to_string());
    }
    if source == target {
        return Ok(target.to_string_lossy().into_owned());
    }
    if fs::symlink_metadata(&target).is_ok() {
        return Err(file_mutation_error(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "target already exists",
        )));
    }

    let source = source.to_path_buf();
    let target = target.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut input = fs::File::open(&source).map_err(file_mutation_error)?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(file_mutation_error)?;
        if let Err(error) = std::io::copy(&mut input, &mut output) {
            let _ = fs::remove_file(&target);
            return Err(file_mutation_error(error));
        }
        Ok(target.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("FILE_OPERATION_FAILED: {error}"))?
}

#[tauri::command]
pub fn rename_folder(
    folder_path: String,
    name: String,
    space_path: String,
    state: State<AppState>,
) -> Result<String, String> {
    validate_file_name(&name)?;
    let source = Path::new(&folder_path);
    let scope = Path::new(&space_path);
    let parent = source.parent().ok_or("INVALID_FILE_PATH")?;
    let target = parent.join(name);

    // A notebook root is the scope boundary and must never be renamed from
    // inside the tree. Both paths are checked so a symlink cannot escape the
    // registered notebook/access-folder scope during the mutation.
    if source == scope
        || !path_is_inside(source, scope)
        || !path_is_inside(&target, scope)
        || is_internal_notebook_path(source, &state)
        || is_internal_notebook_path(&target, &state)
        || !is_browsable_scope(scope, &state)
    {
        return Err("FILE_PERMISSION_DENIED".to_string());
    }
    start_security_bookmark_access(&state, source);
    if !fs::symlink_metadata(source)
        .map_err(file_mutation_error)?
        .is_dir()
    {
        return Err("SOURCE_NOT_DIRECTORY".to_string());
    }
    if fs::symlink_metadata(&target).is_ok() {
        return Err(file_mutation_error(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "target already exists",
        )));
    }
    fs::rename(source, &target).map_err(file_mutation_error)?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn create_folder(
    space_path: String,
    name: String,
    _parent_id: Option<String>,
    state: State<AppState>,
) -> Option<DocTreeItem> {
    validate_file_name(&name).ok()?;
    let target_path = Path::new(&space_path).join(&name);
    if !is_browsable_scope(Path::new(&space_path), &state)
        || !path_is_inside(&target_path, Path::new(&space_path))
        || is_internal_notebook_path(&target_path, &state)
    {
        eprintln!(
            "[create_folder] refused out-of-scope path: {}",
            target_path.display()
        );
        return None;
    }
    start_security_bookmark_access(&state, &target_path);
    fs::create_dir_all(&target_path).ok()?;

    Some(DocTreeItem {
        id: generate_stable_id(&target_path.to_string_lossy()),
        full_path: target_path.to_string_lossy().to_string(),
        name,
        item_type: "folder".to_string(),
        parent_id: None,
        children: Some(vec![]),
        size_bytes: None,
        modified_ms: None,
        created_ms: None,
        memo_created_ms: None,
        memo_meta: None,
        resource_kind: None,
    })
}

#[tauri::command]
pub fn create_document(
    space_path: String,
    name: String,
    _parent_id: Option<String>,
    state: State<AppState>,
) -> Result<DocTreeItem, String> {
    validate_file_name(&name)?;
    let file_name = if name.ends_with(".md") {
        name.clone()
    } else {
        format!("{}.md", name)
    };
    let target_path = Path::new(&space_path).join(&file_name);
    if !is_browsable_scope(Path::new(&space_path), &state)
        || !path_is_inside(&target_path, Path::new(&space_path))
        || is_internal_notebook_path(&target_path, &state)
    {
        eprintln!(
            "[create_document] refused out-of-scope path: {}",
            target_path.display()
        );
        return Err("FILE_PERMISSION_DENIED".to_string());
    }
    start_security_bookmark_access(&state, &target_path);
    read_lock(&state.memo_file, "memo_file")
        .create_file(&target_path, b"")
        .map_err(file_mutation_error)?;

    Ok(DocTreeItem {
        id: generate_stable_id(&target_path.to_string_lossy()),
        full_path: target_path.to_string_lossy().to_string(),
        name: file_name,
        item_type: "document".to_string(),
        parent_id: None,
        children: None,
        size_bytes: Some(0),
        modified_ms: None,
        created_ms: None,
        memo_created_ms: None,
        memo_meta: None,
        resource_kind: Some(DocTreeResourceKind::Note),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_listing_preserves_regular_files_and_folders() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("note.md"), "body").unwrap();
        fs::write(directory.path().join("photo.png.yaml"), "title: Reference").unwrap();
        fs::write(directory.path().join("AGENTS.md"), "agent rules").unwrap();
        fs::create_dir(directory.path().join("folder")).unwrap();
        fs::create_dir(directory.path().join(".flowix")).unwrap();
        fs::write(directory.path().join(".hidden.md"), "hidden").unwrap();
        let items = read_dir_single_level(directory.path(), None, false, false);
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|item| item.name != "photo.png.yaml"));
        assert!(items.iter().all(|item| item.name != "AGENTS.md"));
        assert_eq!(items[0].name, "folder");
        assert_eq!(items[1].name, "note.md");

        let hidden_items = read_dir_single_level(directory.path(), None, true, false);
        assert!(hidden_items.iter().all(|item| item.name != ".flowix"));
    }

    #[test]
    fn only_media_property_sidecars_are_hidden_from_directory_listing() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("photo.png.yaml"), "title: Reference").unwrap();
        fs::write(directory.path().join("video.mp4.yml"), "kind: demo").unwrap();
        fs::write(directory.path().join("config.yaml"), "enabled: true").unwrap();

        let items = read_dir_single_level(directory.path(), None, false, false);
        assert_eq!(
            items
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            vec!["config.yaml", "video.mp4.yml"]
        );
    }

    #[test]
    fn directory_listing_attaches_indexed_memo_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let note_path = directory.path().join("note.md");
        fs::write(&note_path, "body").unwrap();
        let mut metadata = HashMap::new();
        metadata.insert(
            canonical_path(&note_path),
            MemoTreeMetadata {
                created_ms: Some(42),
                memo: DocTreeMemoMeta {
                    id: "memo-1".to_string(),
                    icon: Some("flashlight".to_string()),
                    colors: vec![MemoColor::Blue],
                    favorited: true,
                },
            },
        );

        let items = read_dir_single_level(directory.path(), Some(&metadata), false, false);
        assert_eq!(items[0].memo_created_ms, Some(42));
        let memo = items[0].memo_meta.as_ref().expect("indexed memo metadata");
        assert_eq!(memo.id, "memo-1");
        assert_eq!(memo.icon.as_deref(), Some("flashlight"));
        assert_eq!(memo.colors, vec![MemoColor::Blue]);
        assert!(memo.favorited);
    }

    #[test]
    fn memo_metadata_scope_only_matches_direct_directory_children() {
        assert!(relative_memo_is_direct_child(
            Path::new("root.md"),
            Path::new("")
        ));
        assert!(relative_memo_is_direct_child(
            Path::new("projects/note.md"),
            Path::new("projects")
        ));
        assert!(!relative_memo_is_direct_child(
            Path::new("projects/archive/note.md"),
            Path::new("projects")
        ));
    }

    #[test]
    fn directory_listing_can_include_hidden_directories_but_not_dot_files() {
        let directory = tempfile::tempdir().unwrap();
        let hidden = directory.path().join(".codex");
        fs::create_dir(&hidden).unwrap();
        fs::write(hidden.join("skill.md"), "skill").unwrap();
        fs::write(directory.path().join(".gitignore"), "ignored").unwrap();

        let items = read_dir_single_level(directory.path(), None, true, false);
        assert_eq!(
            items
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            vec![".codex"]
        );
        let hidden_children = read_dir_single_level(&hidden, None, true, false);
        assert_eq!(hidden_children[0].name, "skill.md");
    }

    #[cfg(unix)]
    #[test]
    fn directory_listing_hides_outside_and_dangling_links() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("allowed");
        fs::create_dir(&root).unwrap();
        let outside = directory.path().join("secret.md");
        fs::write(&outside, "secret").unwrap();
        fs::write(root.join("note.md"), "body").unwrap();
        symlink(&outside, root.join("outside.md")).unwrap();
        symlink(root.join("missing"), root.join("dangling.md")).unwrap();
        symlink(root.join("note.md"), root.join("inside.md")).unwrap();
        let names: Vec<_> = read_dir_single_level(&root, None, false, false)
            .into_iter()
            .map(|item| item.name)
            .collect();
        assert_eq!(names, vec!["inside.md", "note.md"]);
    }

    #[test]
    fn file_names_cannot_escape_the_selected_parent() {
        for name in [
            "",
            " ",
            ".",
            "..",
            "../note",
            "folder/note",
            "folder\\note",
            "C:\\note",
            "note:stream",
            "note\0",
            "note.",
        ] {
            assert!(validate_file_name(name).is_err(), "accepted {name:?}");
        }
        for name in ["笔记.md", "image.png", "notes 2026.md", ".gitignore"] {
            assert!(validate_file_name(name).is_ok(), "rejected {name:?}");
        }
    }

    #[test]
    fn file_errors_distinguish_conflicts_from_missing_and_denied_paths() {
        for (kind, code) in [
            (std::io::ErrorKind::AlreadyExists, "FILE_EXISTS:"),
            (std::io::ErrorKind::NotFound, "FILE_NOT_FOUND:"),
            (
                std::io::ErrorKind::PermissionDenied,
                "FILE_PERMISSION_DENIED:",
            ),
        ] {
            assert!(file_mutation_error(std::io::Error::new(kind, "failure")).starts_with(code));
        }
    }
}
