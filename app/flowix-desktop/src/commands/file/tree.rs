//! 文件树的读取口径：磁盘列举 + 索引元数据补水。
//!
//! 这里只有读：一条 `fs::read_dir`、一次笔记索引的精确主键查询、一次资源目录
//! 标记查询。写盘命令在 `mutate` / `transfer`，视图偏好在 `view`。
//!
//! 两条口径必须分开看：展示过滤只走 [`TreeVisibility`]（文件夹按目录规则、文件
//! 按通配表），索引口径只通过 `index_excluded` 这个布尔暴露给前端 —— 前端据此
//! 决定要不要提供「在此新建笔记」。
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::app::state::AppState;
use crate::commands::helpers::{
    is_attached_notebook_directory, is_internal_notebook_path, is_registered_notebook_path,
};
use crate::config::path_is_inside;
use crate::lock_utils::read_lock;
use flowix_core::memo_file::{FileManagementPolicy, MemoFile, NoteColor, TreeVisibility};

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
    /// True when this row sits in a folder that every index and the watcher
    /// skip. Such rows stay browsable, but creating a note there would hide it
    /// from every list, so the row menu offers no note creation.
    pub index_excluded: bool,
    /// True when the row is pinned. Notes mirror `memo_meta.favorited`;
    /// documents read the resource catalog flag, so one field drives the row
    /// menu for every kind of entry.
    pub pinned: bool,
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
    pub icon: Option<String>,
    pub colors: Vec<NoteColor>,
    pub favorited: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct MemoTreeMetadata {
    pub(crate) created_ms: Option<u64>,
    pub(crate) memo: DocTreeMemoMeta,
}

// ==================== 域内 helper ====================

pub(crate) fn generate_stable_id(full_path: &str) -> String {
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
            | "heif"
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

pub(crate) fn canonical_path(path: &Path) -> std::path::PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Resolve the innermost registered notebook that contains `path`.
fn enclosing_notebook(memo_file: &MemoFile, path: &Path) -> Option<(String, PathBuf)> {
    let canonical = canonical_path(path);
    let config = memo_file
        .read_notebook_configs()
        .ok()?
        .into_iter()
        .filter(|config| path_is_inside(&canonical, Path::new(&config.path)))
        .max_by_key(|config| Path::new(&config.path).components().count())?;
    let root = canonical_path(Path::new(&config.path));
    Some((config.id, root))
}

/// True when `path` sits in a notebook folder that every index and the watcher
/// skip, so content created there would never show up in a list.
pub(crate) fn index_excluded_for_path(memo_file: &MemoFile, path: &Path) -> bool {
    let Some((_, root)) = enclosing_notebook(memo_file, path) else { return false; };
    let canonical = canonical_path(path);
    let Ok(relative) = canonical.strip_prefix(&root) else { return false; };
    FileManagementPolicy::from_notebook_root(&root).is_index_hidden_at(&root, relative)
}

/// Backend truth for "the indexes and the watcher skip this path". Folder
/// surfaces ask before offering a note/media chooser: a folder outside the
/// index can never list its own contents, so the chooser would only promise
/// views that stay empty. Ancestors count too, so a visible subfolder of a
/// hidden folder reports the same answer as its parent.
#[tauri::command]
pub fn is_path_index_excluded(file_path: String, state: State<AppState>) -> bool {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    index_excluded_for_path(&memo_file, Path::new(&file_path))
}

/// Hydrate only the visible direct children found by the filesystem listing.
/// The core query uses exact primary keys and decodes only tree-row metadata.
pub(crate) fn populate_memo_tree_metadata(
    directory_path: &Path,
    items: &mut [DocTreeItem],
    memo_file_store: &Arc<RwLock<MemoFile>>,
    notebook_background: &Arc<crate::app::notebook_background::NotebookBackground>,
) {
    let memo_file = read_lock(memo_file_store, "memo_file");
    let Some((notebook_id, notebook_root)) = enclosing_notebook(&memo_file, directory_path) else { return; };
    // Resolve only listed notes, preserving metadata for in-notebook symlinks.
    let relative_path_for = |item: &DocTreeItem| {
        canonical_path(Path::new(&item.full_path)).strip_prefix(&notebook_root).ok()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
    };
    let listed_notes: Vec<_> = items.iter().enumerate()
        .filter(|(_, item)| matches!(item.resource_kind, Some(DocTreeResourceKind::Note)))
        .filter_map(|(index, item)| relative_path_for(item).map(|path| (index, path)))
        .collect();
    let relative_paths: Vec<_> = listed_notes.iter().map(|(_, path)| path.clone()).collect();
    let metadata = match memo_file.read_note_tree_metadata_for_paths(&notebook_id, &relative_paths) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
            notebook_background.request(&notebook_id, true, false);
            return;
        }
        Err(_) => return,
    };
    let by_path: HashMap<_, _> = metadata.into_iter().map(|entry| (entry.relative_path.clone(), entry)).collect();
    for (index, relative_path) in listed_notes {
        let item = &mut items[index];
        if let Some(entry) = by_path.get(&relative_path) {
            item.memo_created_ms = u64::try_from(entry.created_at).ok();
            item.pinned = entry.favorited;
            item.memo_meta = Some(DocTreeMemoMeta {
                icon: entry.icon.clone(), colors: entry.colors.clone(), favorited: entry.favorited,
            });
        }
    }
    // Non-note documents have no frontmatter, so their pin lives in the
    // resource catalog. One query covers the whole listing.
    let listed_documents: Vec<(usize, String)> = items.iter().enumerate()
        .filter(|(_, item)| {
            item.item_type == "document"
                && !matches!(item.resource_kind, Some(DocTreeResourceKind::Note))
        })
        .filter_map(|(index, item)| relative_path_for(item).map(|path| (index, path)))
        .collect();
    if listed_documents.is_empty() {
        return;
    }
    let paths: Vec<String> = listed_documents.iter().map(|(_, path)| path.clone()).collect();
    let Ok(pinned) = memo_file.read_pinned_resource_paths(&notebook_id, &paths) else {
        return;
    };
    if pinned.is_empty() {
        return;
    }
    for (index, relative_path) in listed_documents {
        items[index].pinned = pinned.contains(&relative_path);
    }
}

#[cfg(test)]
pub(crate) fn read_dir_single_level(
    dir_path: &Path,
    memo_metadata: Option<&HashMap<std::path::PathBuf, MemoTreeMetadata>>,
) -> Vec<DocTreeItem> {
    read_dir_single_level_with_policy(
        dir_path,
        memo_metadata,
        None,
        TreeVisibility::default(),
    )
}

/// One-level listing shared by the tree and the folder lists.
///
/// 过滤只走展示口径 [`TreeVisibility::hides_entry`]：文件夹看目录规则，文件看
/// 文件通配表，两条规则互不牵连。访问 / 索引 / watcher 的判定属于
/// `FileManagementPolicy`，不在这里做——所以 `.index.yaml` 不出现在树里，但
/// 集合的读写与重命名照旧可用。
pub(crate) fn read_dir_single_level_with_policy(
    dir_path: &Path,
    memo_metadata: Option<&HashMap<std::path::PathBuf, MemoTreeMetadata>>,
    policy: Option<(&Path, &FileManagementPolicy)>,
    visibility: TreeVisibility,
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
            let meta = fs::metadata(&path).ok();
            let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);

            // 全局「访问空间显示隐藏文件夹 / 显示系统文件夹」开关（两个都默认开）
            // 只作用在目录上；文件永远按通配表过滤。
            if visibility.hides_entry(&name, is_dir) {
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
            let index_excluded = policy.is_some_and(|(root, rules)| {
                path.strip_prefix(root)
                    .is_ok_and(|relative| rules.is_index_hidden_at(root, relative))
            });
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
                index_excluded,
                pinned: memo_metadata.and_then(|metadata| Some(metadata.memo.favorited)).unwrap_or(false),
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

/// Global «访问空间» display switches for a notebook-scoped listing.
///
/// 只属于展示口径：文件树和文件夹列表共用同一个来源，避免「树里关掉了点目录、
/// 列表里还留着」。外部文件夹浏览（非笔记本范围）没有这项偏好，一律用默认值。
/// 访问 / 索引 / watcher 不得读这个函数。
pub(crate) fn tree_visibility_for(state: &AppState, scoped: bool) -> TreeVisibility {
    if !scoped {
        return TreeVisibility::default();
    }
    let preference = state.user_config.get_preference();
    TreeVisibility {
        show_hidden: preference.space_show_hidden_folders,
        show_system: preference.space_show_system_folders,
    }
}

// ==================== IPC ====================

#[tauri::command]
pub async fn get_file_tree(
    space_path: String,
    app: AppHandle,
) -> Option<Vec<DocTreeItem>> {
    let path = Path::new(&space_path).to_path_buf();
    // Filesystem enumeration and index reads stay off the command thread.
    let (memo_file, notebook_background, notebook_policy, tree_visibility) = {
        let state = app.state::<AppState>();
        if !path.exists()
            || is_internal_notebook_path(&path, &state)
            || !is_browsable_scope(&path, &state)
        {
            return None;
        }
        let notebook_policy = notebook_policy_for_path(&state, &path);
        let tree_visibility = tree_visibility_for(&state, notebook_policy.is_some());
        (
            state.memo_file.clone(),
            state.notebook_background.clone(),
            notebook_policy,
            tree_visibility,
        )
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut items = read_dir_single_level_with_policy(
            &path,
            None,
            notebook_policy
                .as_ref()
                .map(|(root, policy)| (root.as_path(), policy)),
            tree_visibility,
        );
        populate_memo_tree_metadata(&path, &mut items, &memo_file, &notebook_background);
        items
    })
    .await
    .ok()
}

#[tauri::command]
pub async fn get_dir_children(dir_path: String, app: AppHandle) -> Vec<DocTreeItem> {
    let path = Path::new(&dir_path).to_path_buf();
    let (memo_file, notebook_background, notebook_policy, tree_visibility) = {
        let state = app.state::<AppState>();
        if !path.exists()
            || is_internal_notebook_path(&path, &state)
            || !is_browsable_scope(&path, &state)
        {
            return vec![];
        }
        let notebook_policy = notebook_policy_for_path(&state, &path);
        let tree_visibility = tree_visibility_for(&state, notebook_policy.is_some());
        (
            state.memo_file.clone(),
            state.notebook_background.clone(),
            notebook_policy,
            tree_visibility,
        )
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut items = read_dir_single_level_with_policy(
            &path,
            None,
            notebook_policy
                .as_ref()
                .map(|(root, policy)| (root.as_path(), policy)),
            tree_visibility,
        );
        populate_memo_tree_metadata(&path, &mut items, &memo_file, &notebook_background);
        items
    })
    .await
    .unwrap_or_default()
}

/// 文件树可浏览作用域 ── 注册笔记本根 或 资料文件夹 (agent access
/// folder entry), 两者都要求 path 本身落在作用域内 (子目录随
/// `path_is_inside` 一并放行)。
pub(crate) fn is_browsable_scope(path: &Path, state: &State<AppState>) -> bool {
    !is_internal_notebook_path(path, state)
        && (is_registered_notebook_path(path, state) || is_attached_notebook_directory(path, state))
}
