//! 改名、移动与外部导入。
//!
//! 三种变更共享一条尾部流程 [`rename_path_and_notify`]：先让 `external_watch`
//! 认领这次移动（否则 watcher 会当成「外部删除 + 外部新建」各报一次），再用一次
//! 事务把索引里的旧路径搬到新路径，最后把笔记本相对路径变化广播给前端。
//! 目录移动之后不再同步重扫笔记索引与资源目录：那两步只补「从未入过索引」的文件，
//! 交给 `notebook_background` 的被动维护队列，改名因此不必等一次全库遍历。
//! 导入是拷贝，只有终点一个新路径。
use std::fs;
use std::path::{Path, PathBuf};

use tauri::{Emitter, Manager, State, WebviewWindow};

use super::mutate::{file_mutation_error, target_directory_error, validate_file_name};
use super::tree::is_browsable_scope;
use super::view::rebase_default_create_folder_for_move;
use crate::app::state::AppState;
use crate::commands::helpers::{
    can_access_document_path, can_access_scoped_file, is_internal_notebook_path,
    refresh_current_notebook_watcher, refresh_notebook_note_index, FileOperationFailure,
};
use crate::config::path_is_inside;
use crate::lock_utils::read_lock;

fn rename_path_and_notify(
    source: &Path,
    target: &Path,
    state: &AppState,
    app: &tauri::AppHandle,
) -> Result<Option<crate::events::path_change::NotebookPathMove>, String> {
    let started = std::time::Instant::now();
    // Drop whatever a previous rename on this worker thread left behind, so a
    // failed call cannot log the timings of the one before it.
    let _ = flowix_core::memo_file::rename_probe::take_last();
    let source_was_directory = source.is_dir();
    let mf = read_lock(&state.memo_file, "memo_file");
    let roots_before = if source_was_directory {
        mf.read_notebook_configs().map_err(file_mutation_error)?
    } else {
        Vec::new()
    };
    let _watch_move = crate::external_watch::begin_path_move(app, source);
    mf.rename_indexed_path(source, target)
        .map_err(file_mutation_error)?;
    crate::external_watch::rebase_path(app, source, target);
    // The default note folder is stored notebook-relative, so a directory move
    // has to repair it before anything reads it back.
    rebase_default_create_folder_for_move(&mf, source, target, app);
    if target.is_dir() {
        let configs = mf.read_notebook_configs().unwrap_or_default();
        if let Some(config) = configs.into_iter().find(|config| {
            dunce::canonicalize(&config.path).ok().is_some_and(|root| {
                dunce::canonicalize(target)
                    .ok()
                    .is_some_and(|path| path.starts_with(root))
            })
        }) {
            // The move above already rebased every indexed row (notes, resources,
            // collections) inside one transaction. The two full passes that used
            // to run here only picked up files that were never indexed, at the
            // cost of a whole-notebook walk plus one transaction per note while
            // the user waited for the rename to return. Hand them to the passive
            // maintenance queue: it dedups per notebook, reruns when a pass is
            // already in flight, and reports back through the maintenance events.
            state.notebook_background.request(&config.id, true, true);
            state.notebook_background.request_media(&config.id);
            // The collection catalog resolve canonicalises the root itself, so a
            // failed canonicalise still reports through its own warning. It stays
            // synchronous because the caller reads collection rows on the new
            // scope as soon as this command returns.
            flowix_core::collection_store::refresh_catalog_best_effort(&mf, &config.id);
        }
    } else {
        refresh_notebook_note_index(&mf, source);
        refresh_notebook_note_index(&mf, target);
        flowix_core::collection_store::refresh_path(&mf, source);
        flowix_core::collection_store::refresh_path(&mf, target);
    }
    let mut notebook_change = None;
    {
        flowix_core::collection_store::rebase_collection_paths_for_move(&mf, source, target);
        // 文件夹外观以路径为身份，目录改名 / 移动必须跟着走；否则侧边栏与标题
        // 旁的图标、头图会留在旧路径上，而且没有第二份数据可恢复。
        flowix_core::memo_file::rebase_folder_index_for_move(&mf, source, target);
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
            if let Some(previous_path) = previous_path {
                let change = crate::events::path_change::NotebookPathMove::new(
                    notebook_id,
                    previous_path,
                    relative_path,
                    source_was_directory,
                );
                change.emit(app);
                notebook_change = Some(change);
            }
        }
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
    let notebook_roots_changed = roots_before.iter().any(|previous| {
        notebooks
            .iter()
            .any(|current| current.id == previous.id && current.path != previous.path)
    });
    drop(mf);
    if notebook_roots_changed {
        refresh_current_notebook_watcher(state, app);
        let _ = app.emit(crate::commands::notebook::NOTEBOOKS_CHANGED_EVENT, ());
        let _ = app.emit(
            crate::commands::agent_workspace::AGENT_WORKSPACE_CHANGED_EVENT,
            (),
        );
    }
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
    record_rename_profile(started, source_was_directory);
    Ok(notebook_change)
}

/// A rename slower than this is worth a line in `app.log`. The whole path is a
/// filesystem `rename` plus a handful of SQL updates on a healthy machine, so
/// anything above this means the exclusive window (the one a concurrent save
/// waits on) is doing real work — which is exactly the signal needed to decide
/// whether the index rebase still needs to be made more precise.
const SLOW_RENAME_LOG_MS: f64 = 50.0;

fn record_rename_profile(started: std::time::Instant, directory: bool) {
    let Some(profile) = flowix_core::memo_file::rename_probe::take_last() else {
        return;
    };
    let tail = started.elapsed().saturating_sub(profile.total);
    let payload = profile.to_json(tail, directory);
    let total_ms = profile.total_ms() + tail.as_secs_f64() * 1_000.0;
    if total_ms >= SLOW_RENAME_LOG_MS {
        crate::runtime_log::record_event("warn", "slow-rename", payload);
    } else {
        crate::runtime_log::record_event("info", "rename-profile", payload);
    }
}

#[tauri::command]
pub async fn rename_file(
    operation_id: Option<String>,
    window: tauri::WebviewWindow,
    file_path: String,
    name: String,
    space_path: String,
    app: tauri::AppHandle,
) -> Result<crate::events::path_change::PathMutationResult, String> {
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
            if !fs::symlink_metadata(source)
                .map_err(file_mutation_error)?
                .is_file()
            {
                return Err("SOURCE_NOT_REGULAR_FILE".to_string());
            }
            let notebook_change = rename_path_and_notify(source, &target, state.inner(), &app)?;
            Ok(crate::events::path_change::PathMutationResult {
                path: target.to_string_lossy().into_owned(),
                notebook_change,
            })
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
) -> Result<crate::events::path_change::PathMutationResult, FileOperationFailure> {
    let source = Path::new(&file_path);
    let target_directory = Path::new(&target_directory_path);
    let scope = Path::new(&space_path);
    if !is_browsable_scope(scope, &state)
        || !can_access_scoped_file(source, Some(&space_path), &state)
        || !can_access_scoped_file(target_directory, Some(&space_path), &state)
    {
        return Err(FileOperationFailure::code("FILE_PERMISSION_DENIED"));
    }
    if !fs::symlink_metadata(source)
        .map_err(file_mutation_error)?
        .is_file()
    {
        return Err(FileOperationFailure::code("SOURCE_NOT_REGULAR_FILE"));
    }
    if !fs::symlink_metadata(target_directory)
        .map_err(target_directory_error)?
        .is_dir()
    {
        return Err(FileOperationFailure::code("TARGET_NOT_DIRECTORY"));
    }
    let file_name = source
        .file_name()
        .ok_or_else(|| FileOperationFailure::code("INVALID_FILE_PATH"))?;
    let target = target_directory.join(file_name);
    if !can_access_scoped_file(&target, Some(&space_path), &state) {
        return Err(FileOperationFailure::code("FILE_PERMISSION_DENIED"));
    }
    if source == target {
        return Ok(crate::events::path_change::PathMutationResult {
            path: source.to_string_lossy().into_owned(),
            notebook_change: None,
        });
    }
    if fs::symlink_metadata(&target).is_ok() {
        return Err(file_mutation_error(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "target already exists",
        ))
        .into());
    }
    let notebook_change = rename_path_and_notify(source, &target, state.inner(), &app)?;
    Ok(crate::events::path_change::PathMutationResult {
        path: target.to_string_lossy().into_owned(),
        notebook_change,
    })
}

/// Move a folder within the caller's notebook/access-folder scope.
#[tauri::command]
pub async fn move_folder(
    folder_path: String,
    target_directory_path: String,
    space_path: String,
    app: tauri::AppHandle,
) -> Result<crate::events::path_change::PathMutationResult, FileOperationFailure> {
    // A directory move renames in place but then reconciles the note index, the
    // resource catalog and the view catalog for the whole notebook. That is
    // disk-bound work, so it leaves the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        move_folder_blocking(
            &folder_path,
            &target_directory_path,
            &space_path,
            &state,
            &app,
        )
    })
    .await
    .map_err(|error| FileOperationFailure::from(format!("FOLDER_MOVE_TASK_FAILED: {error}")))?
}

fn move_folder_blocking(
    folder_path: &str,
    target_directory_path: &str,
    space_path: &str,
    state: &State<AppState>,
    app: &tauri::AppHandle,
) -> Result<crate::events::path_change::PathMutationResult, FileOperationFailure> {
    let source = Path::new(folder_path);
    let target_directory = Path::new(target_directory_path);
    let scope = Path::new(space_path);
    if source == scope
        || !is_browsable_scope(scope, &state)
        || !path_is_inside(source, scope)
        || !path_is_inside(target_directory, scope)
        || is_internal_notebook_path(source, &state)
        || is_internal_notebook_path(target_directory, &state)
    {
        return Err(FileOperationFailure::code("FILE_PERMISSION_DENIED"));
    }
    if !fs::symlink_metadata(source)
        .map_err(file_mutation_error)?
        .is_dir()
    {
        return Err(FileOperationFailure::code("SOURCE_NOT_DIRECTORY"));
    }
    if !fs::symlink_metadata(target_directory)
        .map_err(target_directory_error)?
        .is_dir()
    {
        return Err(FileOperationFailure::code("TARGET_NOT_DIRECTORY"));
    }
    if path_is_inside(target_directory, source) {
        return Err(FileOperationFailure::code("INVALID_MOVE_TARGET"));
    }
    let folder_name = source
        .file_name()
        .ok_or_else(|| FileOperationFailure::code("INVALID_FILE_PATH"))?;
    let target = target_directory.join(folder_name);
    if !path_is_inside(&target, scope) || is_internal_notebook_path(&target, &state) {
        return Err(FileOperationFailure::code("FILE_PERMISSION_DENIED"));
    }
    if source == target {
        return Ok(crate::events::path_change::PathMutationResult {
            path: source.to_string_lossy().into_owned(),
            notebook_change: None,
        });
    }
    if fs::symlink_metadata(&target).is_ok() {
        return Err(file_mutation_error(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "target already exists",
        ))
        .into());
    }
    let notebook_change = rename_path_and_notify(source, &target, state.inner(), &app)?;
    Ok(crate::events::path_change::PathMutationResult {
        path: target.to_string_lossy().into_owned(),
        notebook_change,
    })
}

/// Resolve physical paths before detecting self-imports or filename conflicts.
/// Access checks remain the command boundary's responsibility.
pub(crate) fn resolve_import_file_paths(
    source: &Path,
    target_directory: &Path,
) -> Result<(PathBuf, PathBuf), FileOperationFailure> {
    let source = dunce::canonicalize(source).map_err(file_mutation_error)?;
    let target_directory = dunce::canonicalize(target_directory).map_err(target_directory_error)?;
    if !fs::metadata(&source)
        .map_err(file_mutation_error)?
        .is_file()
    {
        return Err(FileOperationFailure::code("SOURCE_NOT_REGULAR_FILE"));
    }
    if flowix_core::file_copy::is_cloud_file_not_downloaded(&source) {
        return Err(FileOperationFailure::code("CLOUD_FILE_NOT_DOWNLOADED"));
    }
    if !fs::metadata(&target_directory)
        .map_err(target_directory_error)?
        .is_dir()
    {
        return Err(FileOperationFailure::code("TARGET_NOT_DIRECTORY"));
    }
    let file_name = source
        .file_name()
        .ok_or_else(|| FileOperationFailure::code("INVALID_FILE_PATH"))?;
    let target = target_directory.join(file_name);
    // Canonicalize existing destinations too (including file symlinks).
    if dunce::canonicalize(&target).is_ok_and(|path| path == source) {
        return Ok((source.clone(), source));
    }
    if fs::symlink_metadata(&target).is_ok() {
        return Err(file_mutation_error(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "target already exists",
        ))
        .into());
    }
    Ok((source, target))
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
) -> Result<String, FileOperationFailure> {
    let source = Path::new(&file_path);
    let target_directory = Path::new(&target_directory_path);
    let scope = Path::new(&space_path);
    if !is_browsable_scope(scope, &state)
        || !can_access_scoped_file(target_directory, Some(&space_path), &state)
    {
        return Err(FileOperationFailure::code("FILE_PERMISSION_DENIED"));
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
        return Err(FileOperationFailure::code("FILE_PERMISSION_DENIED"));
    }
    let (source, target) = resolve_import_file_paths(source, target_directory)?;
    if !can_access_scoped_file(&target, Some(&space_path), &state) {
        return Err(FileOperationFailure::code("FILE_PERMISSION_DENIED"));
    }
    if source == target {
        return Ok(target.to_string_lossy().into_owned());
    }

    let memo_file = state.memo_file.clone();
    tokio::task::spawn_blocking(move || {
        let store = read_lock(&memo_file, "memo_file");
        let ids = store
            .notebook_ids_for_paths(&[&target])
            .map_err(file_mutation_error)?;
        let copy = |destination: &Path| -> std::io::Result<()> {
            let mut input = fs::File::open(&source)?;
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(destination)?;
            if let Err(error) = std::io::copy(&mut input, &mut output) {
                let _ = fs::remove_file(destination);
                return Err(error);
            }
            output.sync_all()
        };
        match ids.as_slice() {
            [notebook_id] => store.with_file_write(
                notebook_id,
                &target,
                flowix_core::memo_file::FileLockIntent::Create,
                "import_file",
                copy,
            ),
            [] => {
                let _guard = store
                    .acquire_cross_process_write_lock()
                    .map_err(file_mutation_error)?;
                copy(&target)
            }
            _ => store.with_registered_path_change(
                &[&target],
                "import_file_nested_notebooks",
                || copy(&target),
            ),
        }
        .map_err(file_mutation_error)?;
        Ok(target.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("FILE_OPERATION_FAILED: {error}"))?
}

#[tauri::command]
pub async fn rename_folder(
    operation_id: Option<String>,
    window: tauri::WebviewWindow,
    folder_path: String,
    name: String,
    space_path: String,
    app: tauri::AppHandle,
) -> Result<crate::events::path_change::PathMutationResult, String> {
    crate::commands::document_operations::run(
        "rename_folder",
        operation_id,
        window.label().to_owned(),
        move || {
            let state = app.state::<AppState>();
            validate_file_name(&name)?;
            let source = Path::new(&folder_path);
            let scope = Path::new(&space_path);
            let parent = source.parent().ok_or("INVALID_FILE_PATH")?;
            let target = parent.join(&name);

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
            if !fs::symlink_metadata(source)
                .map_err(file_mutation_error)?
                .is_dir()
            {
                return Err("SOURCE_NOT_DIRECTORY".to_string());
            }
            let collection_move = {
                let memo = read_lock(&state.memo_file, "memo_file");
                crate::commands::collection::rename_folder_collection_at_path(
                    &memo, source, &name, &app,
                )?
            };
            if let Some((_notebook_id, result)) = collection_move {
                let path = Path::new(&result.notebook_path).join(&result.actual_relative_path);
                {
                    // A folder that still owns a legacy `.index.yaml` renames
                    // through the collection mutation, which bypasses
                    // `rename_path_and_notify` (see
                    // `collection::rename_folder_collection_at_path`).
                    let memo = read_lock(&state.memo_file, "memo_file");
                    rebase_default_create_folder_for_move(&memo, source, &path, &app);
                }
                return Ok(crate::events::path_change::PathMutationResult {
                    path: path
                        .parent()
                        .ok_or("INVALID_COLLECTION_PATH")?
                        .to_string_lossy()
                        .into_owned(),
                    notebook_change: crate::commands::collection::path_change_for_result(
                        &_notebook_id,
                        &result,
                    ),
                });
            }
            if fs::symlink_metadata(&target).is_ok() {
                return Err(file_mutation_error(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "target already exists",
                )));
            }
            let notebook_change = rename_path_and_notify(source, &target, state.inner(), &app)?;
            Ok(crate::events::path_change::PathMutationResult {
                path: target.to_string_lossy().into_owned(),
                notebook_change,
            })
        },
    )
    .await
}
