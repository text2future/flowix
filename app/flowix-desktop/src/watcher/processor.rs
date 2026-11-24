//! Keep the notebook path index aligned with filesystem changes.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use flowix_core::memo_file::{
    notebook_relative_path, resource_kind_for_path, FileManagementPolicy, MemoFile,
};
use tauri::{AppHandle, Emitter};

use crate::watcher::event::{FsEventKind, RawFsEvent};

#[derive(Debug, Clone)]
pub struct NotebookWatchContext {
    pub notebook_id: String,
    pub root: PathBuf,
}

pub struct PathNoteEventProcessor;

#[derive(Debug)]
pub(crate) enum DispatchOutcome {
    PathIndexed {
        relative_path: String,
        change: PathChangeKind,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PathChangeKind {
    Created,
    Updated,
    Deleted,
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "md" | "markdown"))
}

fn indexable_relative_path(ctx: &NotebookWatchContext, path: &Path) -> Result<String, String> {
    let relative_path = notebook_relative_path(&ctx.root, path)?;
    let relative = Path::new(&relative_path);
    if !is_markdown_path(relative)
        || FileManagementPolicy::from_notebook_root(&ctx.root)
            .is_index_hidden_at(&ctx.root, relative)
    {
        return Err("not an indexable Markdown path".to_string());
    }
    Ok(relative_path)
}

#[cfg(test)]
pub(crate) fn dispatch_modify_event(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    path: &Path,
    _event_kind: FsEventKind,
) -> Result<DispatchOutcome, String> {
    let path_was_known = memo_file
        .indexed_note_path_presence(&ctx.notebook_id, &notebook_relative_path(&ctx.root, path)?)
        .ok()
        .flatten();
    refresh_path(memo_file, ctx, path, path_was_known)
}

fn refresh_path(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    path: &Path,
    path_was_known: Option<bool>,
) -> Result<DispatchOutcome, String> {
    refresh_path_with_content(memo_file, ctx, path, path_was_known, None)
}

fn refresh_path_with_content(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    path: &Path,
    path_was_known: Option<bool>,
    content: Option<&str>,
) -> Result<DispatchOutcome, String> {
    let relative_path = indexable_relative_path(ctx, path)?;
    match content {
        Some(content) => {
            memo_file.refresh_note_path_with_content(&ctx.notebook_id, &relative_path, content)
        }
        None => memo_file.refresh_note_path(&ctx.notebook_id, &relative_path),
    }
    .map_err(|error| error.to_string())?;
    let change = if !path.is_file() {
        PathChangeKind::Deleted
    } else if path_was_known == Some(false) {
        PathChangeKind::Created
    } else {
        PathChangeKind::Updated
    };
    Ok(DispatchOutcome::PathIndexed {
        relative_path,
        change,
    })
}

fn emit_path_changed(
    app: &AppHandle,
    ctx: &NotebookWatchContext,
    relative_path: &str,
    deleted: bool,
) {
    emit_path_changed_with_content(app, ctx, relative_path, deleted, None);
}

fn emit_path_changed_with_content(
    app: &AppHandle,
    ctx: &NotebookWatchContext,
    relative_path: &str,
    deleted: bool,
    content: Option<&str>,
) {
    emit_path_changed_ui(app, ctx, relative_path, deleted);
    record_cloud_path_change_with_content(app, ctx, relative_path, deleted, content);
}

fn emit_path_changed_ui(
    app: &AppHandle,
    ctx: &NotebookWatchContext,
    relative_path: &str,
    deleted: bool,
) {
    let _ = app.emit(
        "flowix:path-note-changed",
        serde_json::json!({
            "notebookId": ctx.notebook_id,
            "relativePath": relative_path,
            "deleted": deleted,
        }),
    );
}

pub(crate) fn record_cloud_path_change(
    app: &AppHandle,
    ctx: &NotebookWatchContext,
    relative_path: &str,
    deleted: bool,
) {
    record_cloud_path_change_with_content(app, ctx, relative_path, deleted, None);
}

fn record_cloud_path_change_with_content(
    app: &AppHandle,
    ctx: &NotebookWatchContext,
    relative_path: &str,
    _deleted: bool,
    _content: Option<&str>,
) {
    if relative_path.is_empty() {
        return;
    }
    super::host_port::schedule_cloud_sync(app, &ctx.notebook_id, true);
}

fn record_confirmed_cloud_move(
    app: &AppHandle,
    notebook_id: &str,
    _from_path: &str,
    _to_path: &str,
) -> bool {
    super::host_port::schedule_cloud_sync(app, notebook_id, true);
    true
}

fn refresh_resource_path(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    path: &Path,
) -> Result<(), String> {
    let relative_path = notebook_relative_path(&ctx.root, path)?;
    if FileManagementPolicy::from_notebook_root(&ctx.root)
        .is_index_hidden_at(&ctx.root, Path::new(&relative_path))
    {
        return Ok(());
    }
    memo_file
        .refresh_indexed_resource_path(&ctx.notebook_id, &relative_path)
        .map_err(|error| error.to_string())
}

fn enclosing_package_document(ctx: &NotebookWatchContext, path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .skip(1)
        .take_while(|ancestor| *ancestor != ctx.root.as_path())
        .find(|ancestor| {
            ancestor.is_dir()
                && ancestor
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|extension| {
                        matches!(extension.to_ascii_lowercase().as_str(), "pages" | "key")
                    })
        })
        .map(Path::to_path_buf)
}

fn process_indexed_resource_event(
    event: &RawFsEvent,
    memo_file: &Arc<std::sync::RwLock<MemoFile>>,
    ctx: &NotebookWatchContext,
) -> bool {
    if matches!(event.kind, FsEventKind::DirectoryChange) {
        return false;
    }
    let old_resource = event
        .rename_from
        .as_ref()
        .is_some_and(|path| resource_kind_for_path(path).is_some());
    let new_resource = resource_kind_for_path(&event.path).is_some();
    if !old_resource && !new_resource {
        return false;
    }
    let Ok(memo_file) = memo_file.read() else {
        return true;
    };
    let Ok(_write_guard) = memo_file
        .operation_locks()
        .notebook_read(&ctx.notebook_id, "watcher_resource_refresh")
    else {
        return true;
    };
    if old_resource && new_resource {
        if let Some(old_path) = event.rename_from.as_ref() {
            if event
                .rename_from_notebook_id
                .as_ref()
                .is_none_or(|id| id == &ctx.notebook_id)
            {
                let old_root = event.rename_from_root.as_ref().unwrap_or(&ctx.root);
                if let (Ok(old_relative), Ok(new_relative)) = (
                    notebook_relative_path(old_root, old_path),
                    notebook_relative_path(&ctx.root, &event.path),
                ) {
                    match memo_file.move_indexed_resource_path(
                        &ctx.notebook_id,
                        &old_relative,
                        &new_relative,
                    ) {
                        Ok(true) => return true,
                        Ok(false) => {}
                        Err(error) => tracing::warn!("resource rename refresh failed: {error}"),
                    }
                }
            }
        }
    }
    if new_resource {
        if let Err(error) = refresh_resource_path(&memo_file, ctx, &event.path) {
            tracing::warn!(path = %event.path.display(), "resource path refresh failed: {error}");
        }
    }
    if let Some(old_path) = event.rename_from.as_ref().filter(|_| old_resource) {
        let old_ctx = NotebookWatchContext {
            notebook_id: event
                .rename_from_notebook_id
                .clone()
                .unwrap_or_else(|| ctx.notebook_id.clone()),
            root: event
                .rename_from_root
                .clone()
                .unwrap_or_else(|| ctx.root.clone()),
        };
        if let Err(error) = refresh_resource_path(&memo_file, &old_ctx, old_path) {
            tracing::warn!(path = %old_path.display(), "old resource path refresh failed: {error}");
        }
    }
    // A type-changing rename may also add or remove a Markdown note.
    !is_markdown_path(&event.path)
        && !event
            .rename_from
            .as_ref()
            .is_some_and(|path| is_markdown_path(path))
}

/// Ignore attachments even when a user preference broadens the watcher filter.
fn is_under_attachments_dir(ctx: &NotebookWatchContext, path: &Path) -> bool {
    let attachments = crate::watcher::path::normalize_for_compare(&ctx.root.join("attachments"));
    crate::watcher::path::normalize_for_compare(path).starts_with(&attachments)
}

pub(crate) fn wait_for_markdown_copy_to_settle(path: &Path) {
    let mut last_len = None;
    let mut stable_samples = 0;
    for _ in 0..8 {
        let Ok(meta) = std::fs::metadata(path) else {
            std::thread::sleep(Duration::from_millis(50));
            continue;
        };
        if !meta.is_file() {
            return;
        }
        let len = meta.len();
        if Some(len) == last_len {
            stable_samples += 1;
            if stable_samples >= 2 && std::fs::File::open(path).is_ok() {
                return;
            }
        } else {
            last_len = Some(len);
            stable_samples = 0;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

impl PathNoteEventProcessor {
    pub fn process(
        event: &RawFsEvent,
        app: &AppHandle,
        memo_file: &Arc<std::sync::RwLock<MemoFile>>,
        ctx: &NotebookWatchContext,
        stable_content: Option<&str>,
    ) {
        if let Some(previous) = &event.rename_from {
            crate::external_watch::rebase_path(app, previous, &event.path);
        }

        let old_bundle = event.rename_from.as_ref().and_then(|path| {
            let old_ctx = NotebookWatchContext {
                notebook_id: event
                    .rename_from_notebook_id
                    .clone()
                    .unwrap_or_else(|| ctx.notebook_id.clone()),
                root: event
                    .rename_from_root
                    .clone()
                    .unwrap_or_else(|| ctx.root.clone()),
            };
            enclosing_package_document(&old_ctx, path).map(|bundle| (old_ctx, bundle))
        });
        let new_bundle = enclosing_package_document(ctx, &event.path);
        if old_bundle.is_some() || new_bundle.is_some() {
            if let Ok(memo_file) = memo_file.read() {
                if let Some((old_ctx, bundle)) = &old_bundle {
                    if let Ok(relative) = notebook_relative_path(&old_ctx.root, bundle) {
                        let _ = memo_file
                            .refresh_indexed_resource_path(&old_ctx.notebook_id, &relative);
                    }
                }
                if let Some(bundle) = &new_bundle {
                    if let Ok(relative) = notebook_relative_path(&ctx.root, bundle) {
                        let _ =
                            memo_file.refresh_indexed_resource_path(&ctx.notebook_id, &relative);
                    }
                }
                if new_bundle.is_some()
                    && old_bundle.is_none()
                    && event
                        .rename_from
                        .as_ref()
                        .is_some_and(|path| resource_kind_for_path(path).is_some())
                {
                    if let Some(old_path) = &event.rename_from {
                        let old_ctx = NotebookWatchContext {
                            notebook_id: event
                                .rename_from_notebook_id
                                .clone()
                                .unwrap_or_else(|| ctx.notebook_id.clone()),
                            root: event
                                .rename_from_root
                                .clone()
                                .unwrap_or_else(|| ctx.root.clone()),
                        };
                        let _ = refresh_resource_path(&memo_file, &old_ctx, old_path);
                    }
                }
            }
            if new_bundle.is_some() {
                return;
            }
        }

        let collection_path = |root: &Path, path: &Path| {
            path.strip_prefix(root).ok().is_some_and(|relative| {
                flowix_core::collection::is_collection_document_path(relative)
                    && !relative.starts_with("attachments")
                    && !relative.starts_with(".flowix")
            })
        };
        if collection_path(&ctx.root, &event.path)
            || event.rename_from.as_ref().is_some_and(|path| {
                collection_path(event.rename_from_root.as_deref().unwrap_or(&ctx.root), path)
            })
        {
            let moved = event
                .rename_from
                .as_ref()
                .and_then(|old| {
                    let old_root = event.rename_from_root.as_deref().unwrap_or(&ctx.root);
                    if event
                        .rename_from_notebook_id
                        .as_ref()
                        .is_some_and(|id| id != &ctx.notebook_id)
                        || !collection_path(old_root, old)
                        || !collection_path(&ctx.root, &event.path)
                    {
                        return None;
                    }
                    Some((
                        notebook_relative_path(old_root, old).ok()?,
                        notebook_relative_path(&ctx.root, &event.path).ok()?,
                    ))
                })
                .is_some_and(|(old, new)| {
                    record_confirmed_cloud_move(app, &ctx.notebook_id, &old, &new)
                });
            if !moved {
                if let Some(old) = event.rename_from.as_ref() {
                    let old_ctx = NotebookWatchContext {
                        notebook_id: event
                            .rename_from_notebook_id
                            .clone()
                            .unwrap_or_else(|| ctx.notebook_id.clone()),
                        root: event
                            .rename_from_root
                            .clone()
                            .unwrap_or_else(|| ctx.root.clone()),
                    };
                    if collection_path(&old_ctx.root, old) {
                        if let Ok(relative) = notebook_relative_path(&old_ctx.root, old) {
                            if !relative.starts_with("attachments/")
                                && !relative.starts_with(".flowix/")
                            {
                                record_cloud_path_change(app, &old_ctx, &relative, true);
                            }
                        }
                    }
                }
                if collection_path(&ctx.root, &event.path) {
                    if let Ok(relative) = notebook_relative_path(&ctx.root, &event.path) {
                        if !relative.starts_with("attachments/")
                            && !relative.starts_with(".flowix/")
                        {
                            record_cloud_path_change(app, ctx, &relative, !event.path.exists());
                        }
                    }
                }
            }
            if let Ok(memo) = memo_file.read() {
                if let Some(old) = event.rename_from.as_ref() {
                    flowix_core::collection_store::refresh_path(&memo, old);
                }
                flowix_core::collection_store::refresh_path(&memo, &event.path);
                // The collection watcher branch intentionally skips ordinary note
                // indexing. Still broadcast the updated collection identity so
                // open table/list surfaces can adopt an external CLI/MCP write.
                if event.path.is_file() {
                    if let Ok(source) = std::fs::read_to_string(&event.path) {
                        if let Ok(document) =
                            flowix_core::collection::CollectionDocument::parse(&source)
                        {
                            if let Ok(item) = flowix_core::collection_store::with_catalog(
                                &memo,
                                &ctx.notebook_id,
                                |catalog| catalog.resolve(&document.collection.id),
                            ) {
                                let relative = item.relative_path.clone();
                                let _ = app.emit(
                                    "collection-changed",
                                    serde_json::json!({
                                        "notebookId": ctx.notebook_id,
                                        "collectionId": document.collection.id,
                                        "operationId": format!("watcher-{}", item.index_sequence),
                                        "indexSequence": item.index_sequence,
                                        "relativePath": relative,
                                        "previousRelativePath": relative,
                                        "notebookPath": ctx.root,
                                        "name": item.name,
                                        "revision": document.collection.revision,
                                        "directoryMove": null,
                                    }),
                                );
                            }
                        }
                    }
                }
            }
            return;
        }
        if process_indexed_resource_event(event, memo_file, ctx) {
            if let Some(old_path) = event.rename_from.as_ref() {
                if let Ok(memo_file) = memo_file.read() {
                    flowix_core::collection_store::rebase_collection_paths_for_move(
                        &memo_file,
                        old_path,
                        &event.path,
                    );
                }
            }
            let old_media_path = event.rename_from.as_ref().and_then(|old_path| {
                let old_ctx = NotebookWatchContext {
                    notebook_id: event
                        .rename_from_notebook_id
                        .clone()
                        .unwrap_or_else(|| ctx.notebook_id.clone()),
                    root: event
                        .rename_from_root
                        .clone()
                        .unwrap_or_else(|| ctx.root.clone()),
                };
                notebook_relative_path(&old_ctx.root, old_path)
                    .ok()
                    .filter(|path| {
                        path.starts_with("attachments/") && old_ctx.notebook_id == ctx.notebook_id
                    })
            });
            let new_media_path = notebook_relative_path(&ctx.root, &event.path)
                .ok()
                .filter(|path| path.starts_with("attachments/"));
            let moved = old_media_path
                .as_ref()
                .zip(new_media_path.as_ref())
                .is_some_and(|(old, new)| {
                    record_confirmed_cloud_move(app, &ctx.notebook_id, old, new)
                });
            if let Ok(relative) = notebook_relative_path(&ctx.root, &event.path) {
                if relative.starts_with("attachments/") && !moved {
                    record_cloud_path_change(app, ctx, &relative, !event.path.exists());
                }
            }
            if let Some(old_path) = &event.rename_from {
                let old_ctx = NotebookWatchContext {
                    notebook_id: event
                        .rename_from_notebook_id
                        .clone()
                        .unwrap_or_else(|| ctx.notebook_id.clone()),
                    root: event
                        .rename_from_root
                        .clone()
                        .unwrap_or_else(|| ctx.root.clone()),
                };
                if let Ok(relative) = notebook_relative_path(&old_ctx.root, old_path) {
                    if relative.starts_with("attachments/") && !moved {
                        record_cloud_path_change(app, &old_ctx, &relative, true);
                    }
                }
            }
            return;
        }
        if event.rename_from.is_none()
            && is_under_attachments_dir(ctx, &event.path)
            && FileManagementPolicy::from_notebook_root(&ctx.root)
                .is_index_hidden_at(&ctx.root, Path::new("attachments"))
        {
            return;
        }
        if let (Some(old_path), Some(old_notebook_id), Some(old_root)) = (
            event.rename_from.as_ref(),
            event.rename_from_notebook_id.as_ref(),
            event.rename_from_root.as_ref(),
        ) {
            if let Ok(memo_file) = memo_file.read() {
                flowix_core::collection_store::refresh_path(&memo_file, old_path);
                flowix_core::collection_store::refresh_path(&memo_file, &event.path);
            }
            let old_ctx = NotebookWatchContext {
                notebook_id: old_notebook_id.clone(),
                root: old_root.clone(),
            };
            if let (Ok(old_relative), Ok(new_relative)) = (
                notebook_relative_path(&old_ctx.root, old_path),
                notebook_relative_path(&ctx.root, &event.path),
            ) {
                if let Err(error) = super::host_port::rebase_agent_paths(
                    app,
                    old_notebook_id,
                    &ctx.notebook_id,
                    &old_relative,
                    &new_relative,
                    &old_path.to_string_lossy(),
                    &event.path.to_string_lossy(),
                ) {
                    tracing::warn!(old_notebook_id, new_notebook_id = %ctx.notebook_id, "agent cross-notebook path rebase failed: {error}");
                }
            }
            return;
        }
        let Ok(memo_file) = memo_file.read() else {
            return;
        };
        let Ok(_write_guard) = memo_file
            .operation_locks()
            .notebook_read(&ctx.notebook_id, "watcher_note_refresh")
        else {
            return;
        };

        if let Some(old_path) = &event.rename_from {
            flowix_core::collection_store::refresh_path(&memo_file, old_path);
            flowix_core::collection_store::refresh_path(&memo_file, &event.path);
            let rebase = notebook_relative_path(&ctx.root, old_path)
                .ok()
                .zip(notebook_relative_path(&ctx.root, &event.path).ok());
            let cloud_move = rebase.as_ref().is_some_and(|(old, new)| {
                record_confirmed_cloud_move(app, &ctx.notebook_id, old, new)
            });
            if event.path.is_dir()
                && rebase.as_ref().is_some_and(|(old, new)| {
                    flowix_core::collection_store::consume_local_folder_move(
                        &ctx.notebook_id,
                        old,
                        new,
                    )
                })
            {
                // The collection operation already updated all derived indexes and
                // references before publishing its completion event.
                return;
            }
            super::host_port::request_background(app, &ctx.notebook_id, true, true);
            if event.path.is_dir() {
                super::host_port::request_media(app, &ctx.notebook_id);
            }
            drop(_write_guard);
            let old_path_is_markdown = is_markdown_path(old_path);
            let new_path_is_markdown = is_markdown_path(&event.path);
            if event.path.is_dir() || (old_path_is_markdown && new_path_is_markdown) {
                if let (Ok(old_relative), Ok(new_relative)) = (
                    notebook_relative_path(&ctx.root, old_path),
                    notebook_relative_path(&ctx.root, &event.path),
                ) {
                    flowix_core::collection_store::rebase_collection_paths(
                        &memo_file,
                        &ctx.notebook_id,
                        &old_relative,
                        &new_relative,
                    );
                    // 文件夹外观没有 id 可兜底，路径就是身份：外部（访达 / 终端）
                    // 改名或移动目录时，这里必须和集合引用一起搬，否则图标与头图
                    // 会永久留在旧路径上。
                    if event.path.is_dir() {
                        if let Err(error) = memo_file.rebase_folder_index(
                            &ctx.notebook_id,
                            &old_relative,
                            &new_relative,
                        ) {
                            tracing::warn!(
                                notebook_id = %ctx.notebook_id,
                                %old_relative,
                                %new_relative,
                                "folder appearance rebase after external move failed: {error}"
                            );
                        }
                    }
                }
            }
            if let Some((old_relative, new_relative)) = rebase.as_ref() {
                // The OS supplied a confirmed rename pair. Keep it intact for
                // open editors; separate delete/create notifications would close
                // a tab before the new path could be attached to its identity.
                let _ = app.emit(
                    "flowix:path-note-changed",
                    serde_json::json!({
                        "notebookId": ctx.notebook_id,
                        "previousRelativePath": old_relative,
                        "relativePath": new_relative,
                        "kind": "path",
                        "directory": event.path.is_dir(),
                        "deleted": false,
                    }),
                );
                if !cloud_move {
                    if indexable_relative_path(ctx, old_path).is_ok() {
                        record_cloud_path_change(app, ctx, old_relative, true);
                    }
                    if indexable_relative_path(ctx, &event.path).is_ok() {
                        record_cloud_path_change(app, ctx, new_relative, false);
                    }
                }
            } else {
                emit_path_changed(app, ctx, "", false);
            }
            drop(memo_file);
            if let Some((old_relative, new_relative)) = rebase {
                if let Err(error) = super::host_port::rebase_agent_paths(
                    app,
                    &ctx.notebook_id,
                    &ctx.notebook_id,
                    &old_relative,
                    &new_relative,
                    &old_path.to_string_lossy(),
                    &event.path.to_string_lossy(),
                ) {
                    tracing::warn!(notebook_id = %ctx.notebook_id, "agent path rebase failed: {error}");
                }
            }
            return;
        }

        match event.kind {
            FsEventKind::Create | FsEventKind::Modify | FsEventKind::Remove => {
                flowix_core::collection_store::refresh_path(&memo_file, &event.path);
                match refresh_path_with_content(
                    &memo_file,
                    ctx,
                    &event.path,
                    event.path_was_known,
                    stable_content,
                ) {
                    Ok(DispatchOutcome::PathIndexed {
                        relative_path,
                        change,
                    }) => {
                        tracing::debug!(path = %event.path.display(), native_kind = ?event.kind, ?change, "reconciled notebook path");
                        if change == PathChangeKind::Created {
                            crate::events::path_change::NotebookPathCreated::from_external_tool(
                                ctx.notebook_id.clone(),
                                relative_path.clone(),
                            )
                            .emit(app);
                            record_cloud_path_change_with_content(
                                app,
                                ctx,
                                &relative_path,
                                false,
                                stable_content,
                            );
                        } else {
                            emit_path_changed_with_content(
                                app,
                                ctx,
                                &relative_path,
                                change == PathChangeKind::Deleted,
                                stable_content,
                            );
                        }
                    }
                    Err(error) => {
                        tracing::debug!(path = %event.path.display(), "path refresh skipped: {error}")
                    }
                }
            }
            FsEventKind::DirectoryChange => {
                // The worker folds a burst into one call before dispatch; this
                // keeps a direct caller of `process` correct on its own.
                Self::reconcile_directory_change(
                    app,
                    &memo_file,
                    ctx,
                    std::slice::from_ref(&event.path),
                    1,
                );
            }
            FsEventKind::Other => {}
        }
    }

    /// Whole-notebook reconcile for one collapsed burst of directory events.
    ///
    /// `directories` and `absorbed` are diagnostic only — they never change what
    /// this function does. The burst they describe was already folded into a
    /// single call by [`crate::watcher::directory_coalesce`], because a directory
    /// reconcile recomputes the whole notebook and is therefore idempotent.
    pub(crate) fn reconcile_directory_change(
        app: &AppHandle,
        memo_file: &MemoFile,
        ctx: &NotebookWatchContext,
        directories: &[PathBuf],
        absorbed: u32,
    ) {
        let started = Instant::now();
        flowix_core::collection_store::refresh_catalog_best_effort(memo_file, &ctx.notebook_id);
        let catalog = started.elapsed();
        super::host_port::request_background(app, &ctx.notebook_id, false, true);
        let index_request = started.elapsed().saturating_sub(catalog);
        super::host_port::request_media(app, &ctx.notebook_id);
        let media_request = started.elapsed().saturating_sub(catalog + index_request);
        emit_path_changed(app, ctx, "", false);
        let total = started.elapsed();
        let directory = directories
            .first()
            .and_then(|directory| notebook_relative_path(&ctx.root, directory).ok())
            .unwrap_or_default();
        crate::watcher::probe::record(
            &ctx.notebook_id,
            &directory,
            crate::watcher::probe::ReconcileProfile {
                catalog,
                index_request,
                media_request,
                broadcast: total.saturating_sub(catalog + index_request + media_request),
                total,
                absorbed,
            },
        );
    }

    pub(crate) fn unregister_and_emit(
        app: &AppHandle,
        memo_file: &Arc<std::sync::RwLock<MemoFile>>,
        ctx: &NotebookWatchContext,
        path: &Path,
    ) {
        if resource_kind_for_path(path).is_some() {
            let Ok(memo_file) = memo_file.read() else {
                return;
            };
            let Ok(_write_guard) = memo_file
                .operation_locks()
                .notebook_read(&ctx.notebook_id, "watcher_resource_removal")
            else {
                return;
            };
            if let Err(error) = refresh_resource_path(&memo_file, ctx, path) {
                tracing::warn!(path = %path.display(), "resource removal refresh failed: {error}");
            }
            return;
        }
        let Ok(memo_file) = memo_file.read() else {
            return;
        };
        let Ok(_write_guard) = memo_file
            .operation_locks()
            .notebook_read(&ctx.notebook_id, "watcher_path_refresh")
        else {
            return;
        };
        flowix_core::collection_store::refresh_path(&memo_file, path);
        if let Ok(DispatchOutcome::PathIndexed {
            relative_path,
            change,
        }) = refresh_path(&memo_file, ctx, path, None)
        {
            emit_path_changed(app, ctx, &relative_path, change == PathChangeKind::Deleted);
        }
    }
}

#[cfg(test)]
mod tests;
