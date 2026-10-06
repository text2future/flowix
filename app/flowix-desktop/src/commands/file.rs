use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{State, WebviewWindow};

use crate::config::path_is_inside;
use crate::lock_utils::read_lock;
use flowix_core::memo_file::{
    media_kind_for_path, notebook_path_from_relative, FileManagementPolicy, MediaResourceKind,
    MemoColor,
};
use sha2::{Digest, Sha256};
use tokio::sync::{Notify, Semaphore};

use super::helpers::{
    can_access_document_path, can_access_scoped_file, is_agent_access_folder,
    is_internal_notebook_path, is_registered_notebook_path, is_registered_notebook_root,
    refresh_notebook_note_index, start_security_bookmark_access,
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
) -> Vec<DocTreeItem> {
    read_dir_single_level_with_policy(dir_path, memo_metadata, None)
}

fn read_dir_single_level_with_policy(
    dir_path: &Path,
    memo_metadata: Option<&HashMap<std::path::PathBuf, MemoTreeMetadata>>,
    policy: Option<(&Path, &FileManagementPolicy)>,
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

            if let Some((root, rules)) = policy {
                if path
                    .strip_prefix(root)
                    .is_ok_and(|relative| rules.is_tree_hidden_at(root, relative))
                {
                    continue;
                }
            }

            // .flowix is application-owned notebook data. It stays hidden
            // even when the user opts into hidden directories.
            if name == ".flowix" {
                continue;
            }

            // Non-notebook file browser roots use the same default visibility
            // for AGENTS.md; notebook roots are filtered by FileManagementPolicy.
            if policy.is_none() && name == "AGENTS.md" {
                continue;
            }

            // FileManagementPolicy controls notebook paths. External browser
            // roots keep hidden paths out of the tree by default.
            let meta = fs::metadata(&path).ok();
            let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            if policy.is_none() && name.starts_with('.') {
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

fn notebook_policy_for_path(
    state: &AppState,
    path: &Path,
) -> Option<(std::path::PathBuf, FileManagementPolicy)> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let root = memo_file
        .registered_notebook_paths()
        .into_iter()
        .filter(|root| path.starts_with(root))
        .max_by_key(|root| root.components().count())?;
    let policy = FileManagementPolicy::from_notebook_root(&root);
    Some((root, policy))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookViewPreferences {
    #[serde(default)]
    pub default_create_folder: Option<String>,
    #[serde(default)]
    pub file_management: FileManagementPolicy,
    #[serde(default, skip_deserializing, skip_serializing_if = "is_false")]
    pub refresh_pending: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookFolderOption {
    pub relative_path: String,
    pub depth: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookSettingsTreeEntry {
    pub relative_path: String,
    pub is_directory: bool,
    pub locked: bool,
    pub hidden: bool,
    pub default_hidden: bool,
    pub collapsed: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
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

pub(crate) fn default_create_folder_for_notebook(root: &Path) -> Result<Option<String>, String> {
    flowix_core::memo_file::default_create_folder_for_notebook(root)
}

pub(crate) fn migrate_legacy_watcher_rules(
    root: &Path,
    config: &crate::watcher::WhitelistConfig,
) -> Result<(), String> {
    static MIGRATION_LOCK: Mutex<()> = Mutex::new(());
    let _guard = MIGRATION_LOCK
        .lock()
        .map_err(|_| "FILE_MANAGEMENT_MIGRATION_LOCK_FAILED")?;
    let mut preferences = read_notebook_view_preferences(root);
    if preferences.file_management.legacy_watcher_migrated {
        return Ok(());
    }
    let policy = &mut preferences.file_management;
    policy.legacy_skip_dirs = config
        .skip_dirs
        .iter()
        .filter(|name| {
            !matches!(
                name.as_str(),
                ".flowix"
                    | ".plugin-output"
                    | ".git"
                    | ".DS_Store"
                    | "node_modules"
                    | ".cache"
                    | ".trash"
                    | "attachments"
                    | "attachments-cache"
            )
        })
        .cloned()
        .collect();
    policy.legacy_skip_files = config
        .skip_files
        .iter()
        .filter(|name| {
            !matches!(
                name.as_str(),
                "*.tmp" | "*.swp" | "*~" | ".DS_Store" | "Thumbs.db" | "*.bak" | "*.lock"
            )
        })
        .cloned()
        .collect();
    policy.legacy_watcher_migrated = true;
    let path = notebook_preferences_path(root)?;
    fs::create_dir_all(path.parent().ok_or("INVALID_NOTEBOOK_CONFIG_DIRECTORY")?)
        .map_err(|error| error.to_string())?;
    if !policy.legacy_skip_dirs.is_empty() || !policy.legacy_skip_files.is_empty() {
        flowix_core::memo_file::atomic_write_bytes(
            &root.join(".flowix/file-management-refresh-pending"),
            b"pending",
        )
        .map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(&preferences).map_err(|error| error.to_string())?;
    flowix_core::memo_file::atomic_write_bytes(&path, &bytes).map_err(|error| error.to_string())?;
    Ok(())
}

fn normalize_relative_folder_paths(folders: Vec<String>) -> Result<Vec<String>, String> {
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

fn normalize_excluded_index_paths(folders: Vec<String>) -> Result<Vec<String>, String> {
    let mut normalized: Vec<String> = Vec::new();
    for folder in folders {
        if folder.is_empty() {
            if !normalized.iter().any(|path| path.is_empty()) {
                normalized.push(folder);
            }
        } else {
            normalized.extend(normalize_relative_folder_paths(vec![folder])?);
        }
    }
    Ok(normalized)
}

#[tauri::command]
pub fn get_notebook_view_preferences(
    notebook_path: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<NotebookViewPreferences, String> {
    let root = Path::new(&notebook_path);
    if !is_registered_notebook_root(root, &state) {
        return Err("NOTEBOOK_NOT_REGISTERED".to_string());
    }
    migrate_legacy_watcher_rules(root, &state.user_config.get_preference().watcher)?;
    if root
        .join(".flowix/file-management-refresh-pending")
        .exists()
    {
        if let Ok(canonical_root) = fs::canonicalize(root) {
            let _ = refresh_file_management_indexes(&canonical_root, &state, &app);
        }
    }
    let mut preferences = read_notebook_view_preferences(root);
    preferences.refresh_pending = root
        .join(".flowix/file-management-refresh-pending")
        .exists();
    Ok(preferences)
}

fn refresh_file_management_indexes(
    root: &Path,
    state: &AppState,
    app: &AppHandle,
) -> Result<(), String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let notebook = memo_file
        .read_notebook_configs()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|notebook| fs::canonicalize(&notebook.path).ok().as_deref() == Some(root))
        .ok_or("NOTEBOOK_NOT_REGISTERED")?;
    memo_file
        .reconcile_note_index(&notebook.id)
        .map_err(|error| format!("refresh note index failed: {error}"))?;
    memo_file
        .reconcile_media_resources(&notebook.id)
        .map_err(|error| format!("refresh media index failed: {error}"))?;
    crate::commands::document_list::refresh_view_document_catalog_checked(&memo_file, &notebook.id, root)?;
    fs::remove_file(root.join(".flowix/file-management-refresh-pending"))
        .map_err(|error| format!("clear index refresh marker failed: {error}"))?;
    let _ = app.emit(
        "file-management-changed",
        serde_json::json!({
            "notebookId": notebook.id,
            "notebookPath": root.to_string_lossy(),
        }),
    );
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileManagementCandidate {
    relative_path: String,
    is_directory: bool,
    locked: bool,
}

/// Show concrete ignored entries. Descendants of an ignored directory become
/// discoverable after that directory is included, avoiding scans of .git and
/// dependency trees just to render Preferences.
#[tauri::command]
pub fn get_file_management_candidates(
    notebook_path: String,
    state: State<AppState>,
) -> Result<Vec<FileManagementCandidate>, String> {
    let root = Path::new(&notebook_path);
    if !is_registered_notebook_root(root, &state) {
        return Err("NOTEBOOK_NOT_REGISTERED".to_string());
    }
    migrate_legacy_watcher_rules(root, &state.user_config.get_preference().watcher)?;
    let policy = read_notebook_view_preferences(root).file_management;
    let defaults = FileManagementPolicy::default();
    let mut pending = vec![root.to_path_buf()];
    let mut candidates = [".flowix", ".plugin-output"]
        .into_iter()
        .filter(|name| *name == ".flowix" || root.join(name).exists())
        .map(|name| FileManagementCandidate {
            relative_path: name.to_string(),
            is_directory: root.join(name).is_dir(),
            locked: true,
        })
        .collect::<Vec<_>>();
    while let Some(directory) = pending.pop() {
        let entries = fs::read_dir(&directory).map_err(|error| error.to_string())?;
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            let is_directory = metadata.is_dir();
            let name = Path::new(entry.file_name().as_os_str()).to_path_buf();
            let own_name_ignored = defaults.is_ignored(&name)
                || policy.matches_legacy_entry(&path)
                || FileManagementPolicy::has_hidden_attribute(&path);
            if FileManagementPolicy::is_locked_name(&entry.file_name().to_string_lossy()) {
                continue;
            }
            if own_name_ignored {
                candidates.push(FileManagementCandidate {
                    relative_path: relative.to_string_lossy().replace('\\', "/"),
                    is_directory,
                    locked: false,
                });
            }
            if is_directory && !policy.is_ignored_at(root, relative) {
                pending.push(path);
            }
        }
    }
    candidates.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(candidates)
}

fn collect_notebook_folders(
    root: &Path,
    directory: &Path,
    policy: &FileManagementPolicy,
    folders: &mut Vec<NotebookFolderOption>,
) -> Result<(), String> {
    let entries = fs::read_dir(directory).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || FileManagementPolicy::has_hidden_attribute(&path) {
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        if policy.is_ignored_at(root, relative) {
            continue;
        }
        let relative_path = relative.to_string_lossy().replace('\\', "/");
        let depth = relative.components().count();
        folders.push(NotebookFolderOption {
            relative_path,
            depth,
        });
        collect_notebook_folders(root, &path, policy, folders)?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_notebook_folder_options(
    notebook_path: String,
    state: State<AppState>,
) -> Result<Vec<NotebookFolderOption>, String> {
    let root = Path::new(&notebook_path);
    if !is_registered_notebook_root(root, &state) {
        return Err("NOTEBOOK_NOT_REGISTERED".to_string());
    }
    let policy = read_notebook_view_preferences(root).file_management;
    let mut folders = Vec::new();
    collect_notebook_folders(root, root, &policy, &mut folders)?;
    folders.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(folders)
}

fn collect_notebook_settings_tree(
    root: &Path,
    directory: &Path,
    policy: &FileManagementPolicy,
    entries: &mut Vec<NotebookSettingsTreeEntry>,
) -> Result<(), String> {
    let children = fs::read_dir(directory).map_err(|error| error.to_string())?;
    for child in children.flatten() {
        let path = child.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let relative_path = relative.to_string_lossy().replace('\\', "/");
        let hidden = policy.is_tree_hidden_at(root, relative);
        let default_hidden = FileManagementPolicy::default().is_ignored_at(root, relative)
            || policy.matches_legacy_entry(&path)
            || FileManagementPolicy::has_hidden_attribute(&path);
        if metadata.is_dir() {
            let is_flowix_dir = relative_path == ".flowix";
            let collapsed = is_flowix_dir || default_hidden || hidden;
            let locked = relative_path == ".flowix"
                || relative_path == ".plugin-output"
                || relative_path.starts_with(".flowix/")
                || relative_path.starts_with(".plugin-output/");
            entries.push(NotebookSettingsTreeEntry {
                relative_path,
                is_directory: true,
                locked,
                hidden,
                default_hidden,
                collapsed,
            });
            if !collapsed {
                collect_notebook_settings_tree(root, &path, policy, entries)?;
            }
        } else if relative.components().count() == 1
            && matches!(
                child.file_name().to_string_lossy().as_ref(),
                "AGENTS.md" | ".DS_Store"
            )
        {
            entries.push(NotebookSettingsTreeEntry {
                relative_path,
                is_directory: false,
                locked: false,
                hidden,
                default_hidden,
                collapsed: false,
            });
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_notebook_settings_tree(
    notebook_path: String,
    state: State<AppState>,
) -> Result<Vec<NotebookSettingsTreeEntry>, String> {
    let root = Path::new(&notebook_path);
    if !is_registered_notebook_root(root, &state) {
        return Err("NOTEBOOK_NOT_REGISTERED".to_string());
    }
    let policy = read_notebook_view_preferences(root).file_management;
    let mut entries = Vec::new();
    collect_notebook_settings_tree(root, root, &policy, &mut entries)?;
    entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(entries)
}

#[tauri::command]
pub fn set_notebook_view_preferences(
    notebook_path: String,
    preferences: NotebookViewPreferences,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let root = Path::new(&notebook_path);
    if !is_registered_notebook_root(root, &state) {
        return Err("NOTEBOOK_NOT_REGISTERED".to_string());
    }
    let root = fs::canonicalize(root)
        .map_err(|error| format!("resolve notebook directory failed: {error}"))?;
    migrate_legacy_watcher_rules(&root, &state.user_config.get_preference().watcher)?;
    let previous_preferences = read_notebook_view_preferences(&root);
    let previous_policy = previous_preferences.file_management.clone();
    let path = notebook_preferences_path(&root)?;
    let parent = path
        .parent()
        .expect("notebook preferences have a parent directory");
    fs::create_dir_all(parent)
        .map_err(|error| format!("create notebook config directory failed: {error}"))?;
    let preferences = NotebookViewPreferences {
        default_create_folder: normalize_default_create_folder(preferences.default_create_folder)?,
        file_management: FileManagementPolicy {
            included_paths: normalize_relative_folder_paths(
                preferences.file_management.included_paths,
            )?,
            hidden_paths: normalize_relative_folder_paths(
                preferences.file_management.hidden_paths,
            )?,
            excluded_index_paths: normalize_excluded_index_paths(
                preferences.file_management.excluded_index_paths,
            )?,
            legacy_skip_dirs: previous_policy.legacy_skip_dirs.clone(),
            legacy_skip_files: previous_policy.legacy_skip_files.clone(),
            legacy_watcher_migrated: previous_policy.legacy_watcher_migrated,
        },
        refresh_pending: false,
    };
    let bytes = serde_json::to_vec_pretty(&preferences)
        .map_err(|error| format!("serialize notebook preferences failed: {error}"))?;
    let tree_visibility_changed =
        previous_policy.hidden_paths != preferences.file_management.hidden_paths;
    let default_create_folder_changed =
        previous_preferences.default_create_folder != preferences.default_create_folder;
    let refresh_marker = root.join(".flowix/file-management-refresh-pending");
    if previous_policy.included_paths != preferences.file_management.included_paths
        || previous_policy.excluded_index_paths != preferences.file_management.excluded_index_paths
    {
        flowix_core::memo_file::atomic_write_bytes(&refresh_marker, b"pending")
            .map_err(|error| format!("mark index refresh pending failed: {error}"))?;
    }
    flowix_core::memo_file::atomic_write_bytes(&path, &bytes)
        .map_err(|error| format!("write notebook preferences failed: {error}"))?;
    if tree_visibility_changed || default_create_folder_changed {
        let _ = app.emit(
            "notebook-view-preferences-changed",
            serde_json::json!({
                "notebookPath": notebook_path,
                "treeVisibilityChanged": tree_visibility_changed,
                "defaultCreateFolderChanged": default_create_folder_changed,
            }),
        );
    }
    let refresh_indexes = refresh_marker.exists();
    if refresh_indexes {
        refresh_file_management_indexes(&root, &state, &app)?;
    }
    if tree_visibility_changed && !refresh_indexes {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        if let Some(notebook) = memo_file
            .read_notebook_configs()
            .unwrap_or_default()
            .into_iter()
            .find(|notebook| {
                dunce::canonicalize(&notebook.path).ok().as_deref() == Some(root.as_path())
            })
        {
            crate::commands::document_list::refresh_view_document_catalog_checked(
                &memo_file,
                &notebook.id,
                &root,
            )?;
        }
    }
    Ok(())
}

fn normalize_default_create_folder(folder: Option<String>) -> Result<Option<String>, String> {
    let Some(folder) = folder else {
        return Ok(None);
    };
    let trimmed = folder.trim_matches('/');
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.contains('\\') || trimmed.contains('\0') {
        return Err("INVALID_NOTEBOOK_FOLDER_PREFERENCE".to_string());
    }
    let path = Path::new(trimmed);
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("INVALID_NOTEBOOK_FOLDER_PREFERENCE".to_string());
    }
    Ok(Some(path.to_string_lossy().replace('\\', "/")))
}

// ==================== IPC ====================

#[tauri::command]
pub fn get_file_tree(space_path: String, state: State<AppState>) -> Option<Vec<DocTreeItem>> {
    let path = Path::new(&space_path);
    start_security_bookmark_access(&state, path);
    if !path.exists()
        || is_internal_notebook_path(path, &state)
        || !is_browsable_scope(path, &state)
    {
        return None;
    }
    let memo_metadata = memo_tree_metadata_for_directory(path, &state);
    let notebook_policy = notebook_policy_for_path(&state, path);
    Some(read_dir_single_level_with_policy(
        path,
        memo_metadata.as_ref(),
        notebook_policy
            .as_ref()
            .map(|(root, policy)| (root.as_path(), policy)),
    ))
}

#[tauri::command]
pub fn get_dir_children(dir_path: String, state: State<AppState>) -> Vec<DocTreeItem> {
    let path = Path::new(&dir_path);
    start_security_bookmark_access(&state, path);
    if !path.exists()
        || is_internal_notebook_path(path, &state)
        || !is_browsable_scope(path, &state)
    {
        return vec![];
    }
    let memo_metadata = memo_tree_metadata_for_directory(path, &state);
    let notebook_policy = notebook_policy_for_path(&state, path);
    read_dir_single_level_with_policy(
        path,
        memo_metadata.as_ref(),
        notebook_policy
            .as_ref()
            .map(|(root, policy)| (root.as_path(), policy)),
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

/// Read a downscaled JPEG preview for an in-scope raster image. The full-size
/// image remains unloaded until the user opens the media resource.
#[tauri::command]
pub fn read_image_preview(
    file_path: String,
    space_path: Option<String>,
    state: State<AppState>,
) -> Option<String> {
    let path = Path::new(&file_path);
    if !can_access_scoped_file(path, space_path.as_deref(), &state) || !path.is_file() {
        return None;
    }
    start_security_bookmark_access(&state, path);
    let bytes = fs::read(path).ok()?;
    let preview = image::load_from_memory(&bytes).ok()?.thumbnail(640, 640).to_rgb8();
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 76)
        .encode_image(&preview)
        .ok()?;
    Some(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(jpeg)
    ))
}

const MEDIA_PREVIEW_CONCURRENCY: usize = 2;
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
        Self { cancelled: AtomicBool::new(false), notify: Notify::new() }
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
    if !is_image && !is_video {
        return Err("unsupported media thumbnail kind".to_string());
    }
    start_security_bookmark_access(&state, &path);

    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let identity = format!("v1:{}:{}:{}:{}", path.display(), metadata.len(), modified_ns, kind);
    let digest = format!("{:x}", Sha256::digest(identity.as_bytes()));
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("media-thumbnails");
    let cache_path = cache_root.join(format!("{digest}.jpg"));
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
        if worker_cancellation.is_cancelled() { return Ok(false); }
        if output.is_file() {
            return Ok(true);
        }
        fs::create_dir_all(&cache_root).map_err(|error| error.to_string())?;
        let generated = if is_image {
            write_image_thumbnail(&path, &output, &worker_cancellation)
        } else {
            write_video_thumbnail(&path, &output, &worker_cancellation)
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
    let Some(requests) = MEDIA_PREVIEW_REQUESTS.get() else { return; };
    if let Ok(requests) = requests.lock() {
        if let Some(request) = requests.get(&request_id) { request.cancel(); }
    }
}

fn remove_media_preview_request(request_id: &str, expected: &Arc<MediaPreviewCancellation>) {
    let Some(requests) = MEDIA_PREVIEW_REQUESTS.get() else { return; };
    if let Ok(mut requests) = requests.lock() {
        if requests.get(request_id).is_some_and(|current| Arc::ptr_eq(current, expected)) {
            requests.remove(request_id);
        }
    }
}

fn write_image_thumbnail(
    source: &Path,
    output: &Path,
    cancellation: &MediaPreviewCancellation,
) -> Result<bool, String> {
    let bytes = fs::read(source).map_err(|error| error.to_string())?;
    if cancellation.is_cancelled() { return Ok(false); }
    let image = image::load_from_memory(&bytes).map_err(|error| error.to_string())?;
    if cancellation.is_cancelled() { return Ok(false); }
    let preview = image.thumbnail(640, 640).to_rgb8();
    write_thumbnail_jpeg(output, &preview, 76, cancellation)
}

fn write_video_thumbnail(
    source: &Path,
    output: &Path,
    cancellation: &MediaPreviewCancellation,
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
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? { break status; }
            std::thread::sleep(Duration::from_millis(60));
        };
        if !status.success() || cancellation.is_cancelled() {
            return Ok(false);
        }
        let thumbnail = fs::read_dir(directory.path())
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|candidate| candidate.extension().is_some_and(|extension| extension == "png"));
        let Some(thumbnail) = thumbnail else { return Ok(false); };
        let bytes = fs::read(thumbnail).map_err(|error| error.to_string())?;
        if cancellation.is_cancelled() { return Ok(false); }
        let image = image::load_from_memory(&bytes)
            .map_err(|error| error.to_string())?
            .thumbnail(480, 480)
            .to_rgb8();
        return write_thumbnail_jpeg(output, &image, 72, cancellation);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (source, output, cancellation);
        Ok(false)
    }
}

fn write_thumbnail_jpeg(
    output: &Path,
    image: &image::RgbImage,
    quality: u8,
    cancellation: &MediaPreviewCancellation,
) -> Result<bool, String> {
    if cancellation.is_cancelled() { return Ok(false); }
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, quality)
        .encode_image(image)
        .map_err(|error| error.to_string())?;
    if cancellation.is_cancelled() { return Ok(false); }
    let nonce = MEDIA_PREVIEW_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = output.with_extension(format!("{nonce}.tmp"));
    fs::write(&temporary, jpeg).map_err(|error| error.to_string())?;
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
    let Ok(_guard) = lock.lock() else { return; };
    let Ok(entries) = fs::read_dir(cache_root) else { return; };
    let mut files: Vec<(SystemTime, u64, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then(|| (
                metadata.modified().unwrap_or(UNIX_EPOCH),
                metadata.len(),
                entry.path(),
            ))
        })
        .collect();
    let total = files.iter().map(|(_, size, _)| *size).sum::<u64>();
    if total <= MEDIA_PREVIEW_CACHE_LIMIT_BYTES { return; }
    files.sort_by_key(|(modified, _, _)| *modified);
    let mut retained = total;
    for (_, size, path) in files {
        if retained <= MEDIA_PREVIEW_CACHE_LIMIT_BYTES { break; }
        if fs::remove_file(path).is_ok() { retained = retained.saturating_sub(size); }
    }
}

/// Read a temporary Quick Look thumbnail for an in-scope video file.
#[tauri::command]
pub fn read_video_preview(
    file_path: String,
    space_path: Option<String>,
    state: State<AppState>,
) -> Option<String> {
    let path = Path::new(&file_path);
    if !can_access_scoped_file(path, space_path.as_deref(), &state) || !path.is_file() {
        eprintln!("[read_video_preview] refused file: {}", file_path);
        return None;
    }
    start_security_bookmark_access(&state, path);

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
            .find(|candidate| candidate.extension().is_some_and(|extension| extension == "png"))?;
        let bytes = fs::read(thumbnail).ok()?;
        let preview = image::load_from_memory(&bytes).ok()?.thumbnail(480, 480).to_rgb8();
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 72)
            .encode_image(&preview)
            .ok()?;
        return Some(format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(jpeg)
        ));
    }

    #[cfg(not(target_os = "macos"))]
    {
        None
    }
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
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let path = Path::new(&file_path);
    let saved = memo_file.write_file(path, content.as_bytes()).is_ok();
    if saved {
        refresh_notebook_note_index(&memo_file, path);
        crate::commands::document_list::refresh_view_document_path(&memo_file, path);
    }
    saved
}

#[tauri::command]
pub fn delete_file(file_path: String, space_path: Option<String>, state: State<AppState>) -> bool {
    if !can_access_scoped_file(Path::new(&file_path), space_path.as_deref(), &state) {
        eprintln!("[delete_file] refused out-of-scope path: {}", file_path);
        return false;
    }
    start_security_bookmark_access(&state, Path::new(&file_path));
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let path = Path::new(&file_path);
    let deleted = memo_file.delete_file(path).is_ok();
    if deleted {
        refresh_notebook_note_index(&memo_file, path);
        crate::commands::document_list::refresh_view_document_path(&memo_file, path);
    }
    deleted
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
    let deleted = fs::remove_dir_all(folder).is_ok();
    if deleted {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let canonical_scope = dunce::canonicalize(scope).unwrap_or_else(|_| scope.to_path_buf());
        if let Some(notebook) = memo_file
            .read_notebook_configs()
            .unwrap_or_default()
            .into_iter()
            .find(|config| {
                dunce::canonicalize(&config.path)
                    .unwrap_or_else(|_| Path::new(&config.path).to_path_buf())
                    == canonical_scope
            })
        {
            if let Err(error) = memo_file.reconcile_note_index(&notebook.id) {
                tracing::warn!(notebook_id = %notebook.id, "V2 index refresh after folder deletion failed: {error}");
            }
            crate::commands::document_list::refresh_view_document_catalog(
                &memo_file,
                &notebook.id,
                &canonical_scope,
            );
        }
    }
    deleted
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

fn rename_path_and_notify(
    source: &Path,
    target: &Path,
    state: &AppState,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let source_was_directory = source.is_dir();
    let source_was_markdown = source
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown")
        });
    let mf = read_lock(&state.memo_file, "memo_file");
    let changes = mf
        .rename_indexed_path(source, target)
        .map_err(file_mutation_error)?;
    if target.is_dir() {
        let configs = mf.read_notebook_configs().unwrap_or_default();
        if let Some(config) = configs.into_iter().find(|config| {
            dunce::canonicalize(&config.path).ok().is_some_and(|root| {
                dunce::canonicalize(target)
                    .ok()
                    .is_some_and(|path| path.starts_with(root))
            })
        }) {
            if let Err(error) = mf.reconcile_note_index(&config.id) {
                tracing::warn!(notebook_id = %config.id, "V2 index refresh after folder move failed: {error}");
            }
            if let Ok(root) = dunce::canonicalize(&config.path) {
                crate::commands::document_list::refresh_view_document_catalog(
                    &mf, &config.id, &root,
                );
            }
        }
    } else {
        refresh_notebook_note_index(&mf, source);
        refresh_notebook_note_index(&mf, target);
        crate::commands::document_list::refresh_view_document_path(&mf, source);
        crate::commands::document_list::refresh_view_document_path(&mf, target);
    }
    let target_is_markdown = target
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown")
        });
    if source_was_directory || (source_was_markdown && target_is_markdown) {
        crate::commands::document_list::rebase_table_note_paths_for_move(&mf, source, target);
        if let Some((notebook_id, relative_path, previous_path)) = mf
            .read_notebook_configs()
            .unwrap_or_default()
            .into_iter()
            .find_map(|notebook| {
                let root = dunce::canonicalize(&notebook.path).ok()?;
                let relative = target.strip_prefix(&root).ok()?;
                let previous = source
                    .strip_prefix(&root)
                    .ok()
                    .map(|path| path.to_string_lossy().replace('\\', "/"));
                Some((
                    notebook.id,
                    relative.to_string_lossy().replace('\\', "/"),
                    previous,
                ))
            })
        {
            let _ = app.emit(
                "flowix:path-note-changed",
                serde_json::json!({
                    "notebookId": notebook_id,
                    "relativePath": relative_path,
                    "previousRelativePath": previous_path,
                    "kind": "path",
                    "deleted": false,
                }),
            );
        }
    }
    for (notebook_id, before, memo) in changes {
        let Some(config) = mf.get_notebook_config_by_id(&notebook_id) else {
            continue;
        };
        let path = notebook_path_from_relative(Path::new(&config.path), &memo.relative_path)?;
        crate::memo_events::emit(
            app,
            crate::memo_events::MemoEvent::Updated {
                id: memo.id.clone(),
                path: path.to_string_lossy().into_owned(),
                notebook_id,
                derived_changed: crate::memo_events::MemoDerivedChanged::from_memos(
                    Some(&before),
                    &memo,
                ),
                memo,
                source: crate::memo_events::MemoChangeSource::UserEdit,
            },
        );
    }
    let notebooks = mf.read_notebook_configs().unwrap_or_default();
    let address_for = |path: &Path| {
        notebooks.iter().find_map(|notebook| {
            let relative = path.strip_prefix(Path::new(&notebook.path)).ok()?;
            Some((
                notebook.id.clone(),
                relative.to_string_lossy().replace('\\', "/"),
            ))
        })
    };
    let rebase = address_for(source).zip(address_for(target));
    drop(mf);
    if let Some(((old_notebook_id, old_relative), (new_notebook_id, new_relative))) = rebase {
        if let Err(error) = state.thread_manager.rebase_agent_note_paths(
            &old_notebook_id,
            &new_notebook_id,
            &old_relative,
            &new_relative,
            &source.to_string_lossy(),
            &target.to_string_lossy(),
        ) {
            tracing::warn!(
                old_notebook_id = %old_notebook_id,
                new_notebook_id = %new_notebook_id,
                old_relative = %old_relative,
                new_relative = %new_relative,
                "note was renamed but agent note references could not be rebased: {error}"
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn rename_file(
    operation_id: Option<String>,
    window: tauri::WebviewWindow,
    file_path: String,
    name: String,
    space_path: String,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::commands::document_operations::run(
        "rename_external",
        operation_id,
        window.label().to_owned(),
        move || {
            let state = app.state::<AppState>();
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
            rename_path_and_notify(source, &target, state.inner(), &app)?;
            Ok(target.to_string_lossy().into_owned())
        },
    )
    .await
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
    app: tauri::AppHandle,
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
    rename_path_and_notify(source, &target, state.inner(), &app)?;
    Ok(target.to_string_lossy().into_owned())
}

/// Move a folder within the caller's notebook/access-folder scope.
#[tauri::command]
pub fn move_folder(
    folder_path: String,
    target_directory_path: String,
    space_path: String,
    state: State<AppState>,
    app: tauri::AppHandle,
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
    rename_path_and_notify(source, &target, state.inner(), &app)?;
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
    app: tauri::AppHandle,
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
    rename_path_and_notify(source, &target, state.inner(), &app)?;
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
        let items = read_dir_single_level(directory.path(), None);
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|item| item.name != "photo.png.yaml"));
        assert!(items.iter().all(|item| item.name != "AGENTS.md"));
        assert_eq!(items[0].name, "folder");
        assert_eq!(items[1].name, "note.md");

        let hidden_items = read_dir_single_level(directory.path(), None);
        assert!(hidden_items.iter().all(|item| item.name != ".flowix"));
    }

    #[test]
    fn only_media_property_sidecars_are_hidden_from_directory_listing() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("photo.png.yaml"), "title: Reference").unwrap();
        fs::write(directory.path().join("video.mp4.yml"), "kind: demo").unwrap();
        fs::write(directory.path().join("config.yaml"), "enabled: true").unwrap();

        let items = read_dir_single_level(directory.path(), None);
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

        let items = read_dir_single_level(directory.path(), Some(&metadata));
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
    fn notebook_policy_can_include_hidden_directories_but_not_dot_files() {
        let directory = tempfile::tempdir().unwrap();
        let hidden = directory.path().join(".codex");
        fs::create_dir(&hidden).unwrap();
        fs::write(hidden.join("skill.md"), "skill").unwrap();
        fs::write(directory.path().join(".gitignore"), "ignored").unwrap();

        let policy = FileManagementPolicy {
            included_paths: vec![".codex".to_string()],
            ..Default::default()
        };
        let items = read_dir_single_level_with_policy(
            directory.path(),
            None,
            Some((directory.path(), &policy)),
        );
        assert_eq!(
            items
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            vec![".codex"]
        );
        let hidden_children =
            read_dir_single_level_with_policy(&hidden, None, Some((directory.path(), &policy)));
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
        let names: Vec<_> = read_dir_single_level(&root, None)
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
