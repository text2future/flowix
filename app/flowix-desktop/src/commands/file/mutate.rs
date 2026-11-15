//! 磁盘写入命令：新建、保存、删除、建目录。
//!
//! 每条命令都要先过作用域（注册笔记本或 agent 访问文件夹），再挑三条写入路径
//! 之一：单笔记本、无笔记本、跨笔记本。这三条对应 `MemoFile` 的三种锁语义，
//! 选错就绕开了索引对账。
use std::fs;
use std::path::{Component, Path, PathBuf};

use tauri::{AppHandle, Manager, State};

use super::tree::{
    generate_stable_id, index_excluded_for_path, is_browsable_scope, DocTreeItem,
    DocTreeResourceKind,
};
use crate::app::state::AppState;
use crate::commands::helpers::{
    can_access_scoped_file, is_internal_notebook_path, is_registered_notebook_root,
    refresh_notebook_note_index,
};
use crate::config::path_is_inside;
use crate::lock_utils::read_lock;

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
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let path = Path::new(&file_path);
    let notebook_ids = match memo_file.notebook_ids_for_paths(&[path]) {
        Ok(ids) => ids,
        Err(error) => {
            tracing::warn!(path = %path.display(), "cannot resolve notebook for write: {error}");
            return false;
        }
    };
    let saved = match notebook_ids.as_slice() {
        [notebook_id] => memo_file
            .write_file_for_notebook(notebook_id, path, content.as_bytes())
            .is_ok(),
        [] => memo_file.write_file(path, content.as_bytes()).is_ok(),
        _ => memo_file
            .with_registered_path_change(&[path], "write_file_nested_notebooks", || {
                fs::metadata(path)?;
                flowix_core::memo_file::atomic_write_bytes(path, content.as_bytes())
            })
            .is_ok(),
    };
    if saved {
        refresh_notebook_note_index(&memo_file, path);
        flowix_core::collection_store::refresh_path(&memo_file, path);
    }
    saved
}

#[tauri::command]
pub fn create_file(
    file_path: String,
    content: String,
    space_path: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    let path = Path::new(&file_path);
    if !can_access_scoped_file(path, space_path.as_deref(), &state)
        || is_internal_notebook_path(path, &state)
    {
        return Err("FILE_PERMISSION_DENIED".to_string());
    }
    if !path.parent().is_some_and(Path::is_dir) {
        return Err("FILE_NOT_FOUND: parent directory does not exist".to_string());
    }
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let notebook_ids = memo_file
        .notebook_ids_for_paths(&[path])
        .map_err(file_mutation_error)?;
    match notebook_ids.as_slice() {
        [notebook_id] => memo_file
            .create_file_for_notebook(notebook_id, path, content.as_bytes())
            .map_err(file_mutation_error)?,
        [] => memo_file
            .create_file(path, content.as_bytes())
            .map_err(file_mutation_error)?,
        _ => memo_file
            .with_registered_path_change(&[path], "create_file_nested_notebooks", || {
                flowix_core::memo_file::atomic_create_bytes(path, content.as_bytes())
            })
            .map_err(file_mutation_error)?,
    }
    refresh_notebook_note_index(&memo_file, path);
    flowix_core::collection_store::refresh_path(&memo_file, path);
    Ok(())
}

#[tauri::command]
pub fn delete_file(file_path: String, space_path: Option<String>, state: State<AppState>) -> bool {
    if !can_access_scoped_file(Path::new(&file_path), space_path.as_deref(), &state) {
        eprintln!("[delete_file] refused out-of-scope path: {}", file_path);
        return false;
    }
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let path = Path::new(&file_path);
    let notebook_ids = match memo_file.notebook_ids_for_paths(&[path]) {
        Ok(ids) => ids,
        Err(error) => {
            tracing::warn!(path = %path.display(), "cannot resolve notebook for delete: {error}");
            return false;
        }
    };
    let deleted = match notebook_ids.as_slice() {
        [notebook_id] => memo_file
            .delete_file_for_notebook(notebook_id, path)
            .is_ok(),
        [] => memo_file.delete_file(path).is_ok(),
        _ => memo_file
            .with_registered_path_change(&[path], "delete_file_nested_notebooks", || {
                fs::remove_file(path)
            })
            .is_ok(),
    };
    if deleted {
        refresh_notebook_note_index(&memo_file, path);
        flowix_core::collection_store::refresh_path(&memo_file, path);
    }
    deleted
}

#[tauri::command]
pub async fn delete_folder(
    folder_path: String,
    space_path: String,
    app: AppHandle,
) -> Result<bool, String> {
    // Recursive removal, the cross-process write lock and the post-delete index
    // reconcile are all disk-bound. A synchronous command runs them on the main
    // thread, so deleting a large folder freezes the window until the sweep ends.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        delete_folder_blocking(&folder_path, &space_path, &state)
    })
    .await
    .map_err(|error| format!("folder delete task failed: {error}"))?
}

fn delete_folder_blocking(
    folder_path: &str,
    space_path: &str,
    state: &State<AppState>,
) -> Result<bool, String> {
    let folder = Path::new(folder_path);
    let scope = Path::new(space_path);
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
        return Err("FILE_PERMISSION_DENIED".to_string());
    }
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let notebook_ids = memo_file
        .notebook_ids_for_paths(&[folder])
        .map_err(file_mutation_error)?;
    let deletion_attempted = std::cell::Cell::new(false);
    let deletion = if notebook_ids.is_empty() {
        memo_file
            .acquire_cross_process_write_lock()
            .and_then(|_guard| {
                deletion_attempted.set(true);
                fs::remove_dir_all(folder)
            })
    } else {
        let ids: Vec<&str> = notebook_ids.iter().map(String::as_str).collect();
        memo_file.with_notebook_change(&ids, "delete_folder", || {
            if memo_file.notebook_ids_for_paths(&[folder])? != notebook_ids
                || !path_is_inside(folder, scope)
                || folder == scope
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "folder changed while waiting for notebook lock",
                ));
            }
            let metadata = fs::symlink_metadata(folder)?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "folder is no longer a directory",
                ));
            }
            deletion_attempted.set(true);
            fs::remove_dir_all(folder)
        })
    };
    if let Err(error) = deletion {
        for id in &notebook_ids {
            if let Err(index_error) = memo_file.reconcile_note_index(id) {
                tracing::warn!(notebook_id = %id, "index refresh after partial folder deletion failed: {index_error}");
            }
        }
        return Err(if deletion_attempted.get() && folder.exists() {
            format!(
                "FOLDER_DELETE_PARTIAL: {} remains: {error}",
                folder.display()
            )
        } else {
            format!("FOLDER_DELETE_FAILED: {error}")
        });
    }
    let deleted = true;
    if deleted {
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
            flowix_core::collection_store::refresh_catalog_best_effort(&memo_file, &notebook.id);
            // The folder is gone; its appearance row would otherwise survive under a
            // path that no longer exists and be inherited by whoever creates a folder
            // with the same name later.
            flowix_core::memo_file::delete_folder_index_for_path(&memo_file, folder);
        }
    }
    Ok(deleted)
}

pub(crate) fn file_mutation_error(error: std::io::Error) -> String {
    let code = match error.kind() {
        std::io::ErrorKind::AlreadyExists => "FILE_EXISTS",
        std::io::ErrorKind::NotFound => "FILE_NOT_FOUND",
        std::io::ErrorKind::PermissionDenied => "FILE_PERMISSION_DENIED",
        _ => "FILE_OPERATION_FAILED",
    };
    format!("{code}: {error}")
}

/// Create a single new directory level, failing with `AlreadyExists` when the
/// target already exists (folder or file). Unlike `create_dir_all`, which
/// silently succeeds on duplicates, this lets `create_folder` surface
/// `FILE_EXISTS` to the UI. `create_dir` is atomic, so no check-then-create
/// race remains. Validated names never contain separators, so the target is
/// always one level below an existing parent.
pub(crate) fn create_new_dir(target: &Path) -> std::io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| std::io::Error::other("folder has no parent"))?;
    fs::create_dir_all(parent)?;
    fs::create_dir(target)
}

pub(crate) fn target_directory_error(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        "TARGET_NOT_DIRECTORY".to_string()
    } else {
        file_mutation_error(error)
    }
}

pub(crate) fn validate_file_name(name: &str) -> Result<(), String> {
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

/// Resolve a notebook-relative folder without using the filtered file tree.
pub(crate) fn notebook_folder_target(
    root: &Path,
    relative_folder: &str,
) -> Result<PathBuf, String> {
    let relative = Path::new(relative_folder);
    if relative.is_absolute()
        || relative_folder.contains(['\\', '\0'])
        || relative_folder
            .split('/')
            .any(|part| part == "." || part == "..")
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("INVALID_NOTEBOOK_FOLDER_PREFERENCE".to_string());
    }
    let target = root.join(relative);
    if !path_is_inside(&target, root) {
        return Err("FILE_PERMISSION_DENIED".to_string());
    }
    Ok(target)
}

/// Idempotent directory preparation for collection creation. Filesystem checks
/// preserve the volume's case rules and ignore file-tree visibility settings.
#[tauri::command]
pub fn ensure_notebook_folder(
    notebook_path: String,
    relative_folder: String,
    state: State<AppState>,
) -> Result<(), String> {
    let root = Path::new(&notebook_path);
    if !is_registered_notebook_root(root, &state) {
        return Err("FILE_PERMISSION_DENIED".to_string());
    }
    // A missing notebook root must not be silently recreated.
    if !root.is_dir() {
        return Err("FILE_NOT_FOUND: notebook directory does not exist".to_string());
    }
    let target = notebook_folder_target(root, &relative_folder)?;
    if is_internal_notebook_path(&target, &state) {
        return Err("FILE_PERMISSION_DENIED".to_string());
    }
    if target.is_dir() {
        return Ok(());
    }
    let memo_file = read_lock(&state.memo_file, "memo_file");
    memo_file
        .with_registered_path_change(&[&target], "ensure_notebook_folder", || {
            fs::create_dir_all(&target)
        })
        .map_err(file_mutation_error)
}

#[tauri::command]
pub fn create_folder(
    space_path: String,
    name: String,
    _parent_id: Option<String>,
    state: State<AppState>,
) -> Result<DocTreeItem, String> {
    // Same failure contract as `create_document`: stable codes instead of `None`,
    // so the UI can tell an invalid name from a conflict or a permission denial.
    validate_file_name(&name)?;
    let target_path = Path::new(&space_path).join(&name);
    if !is_browsable_scope(Path::new(&space_path), &state)
        || !path_is_inside(&target_path, Path::new(&space_path))
        || is_internal_notebook_path(&target_path, &state)
    {
        eprintln!(
            "[create_folder] refused out-of-scope path: {}",
            target_path.display()
        );
        return Err("FILE_PERMISSION_DENIED".to_string());
    }
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let notebook_ids = memo_file
        .notebook_ids_for_paths(&[&target_path])
        .map_err(file_mutation_error)?;
    if notebook_ids.is_empty() {
        let _guard = memo_file
            .acquire_cross_process_write_lock()
            .map_err(file_mutation_error)?;
        create_new_dir(&target_path).map_err(file_mutation_error)?;
    } else {
        memo_file
            .with_registered_path_change(&[&target_path], "create_folder", || {
                create_new_dir(&target_path)
            })
            .map_err(file_mutation_error)?;
    }

    Ok(DocTreeItem {
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
        index_excluded: index_excluded_for_path(&memo_file, &target_path),
        pinned: false,
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
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let notebook_ids = memo_file
        .notebook_ids_for_paths(&[&target_path])
        .map_err(file_mutation_error)?;
    match notebook_ids.as_slice() {
        [notebook_id] => memo_file
            .create_file_for_notebook(notebook_id, &target_path, b"")
            .map_err(file_mutation_error)?,
        [] => memo_file
            .create_file(&target_path, b"")
            .map_err(file_mutation_error)?,
        _ => memo_file
            .with_registered_path_change(
                &[&target_path],
                "create_document_nested_notebooks",
                || flowix_core::memo_file::atomic_create_bytes(&target_path, b""),
            )
            .map_err(file_mutation_error)?,
    }

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
        index_excluded: index_excluded_for_path(&memo_file, &target_path),
        pinned: false,
    })
}
