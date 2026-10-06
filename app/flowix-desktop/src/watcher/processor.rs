//! Keep the notebook path index aligned with filesystem changes.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use flowix_core::memo_file::{
    media_kind_for_path, FileManagementPolicy, notebook_relative_path, MemoFile,
};
use tauri::{AppHandle, Emitter, Manager};

use crate::watcher::event::{FsEventKind, RawFsEvent};

#[derive(Debug, Clone)]
pub struct NotebookWatchContext {
    pub notebook_id: String,
    pub root: PathBuf,
}

pub struct PathNoteEventProcessor;

#[derive(Debug)]
pub(crate) enum DispatchOutcome {
    PathIndexed { relative_path: String },
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension().and_then(|value| value.to_str())
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "md" | "markdown"))
}

fn indexable_relative_path(ctx: &NotebookWatchContext, path: &Path) -> Result<String, String> {
    let relative_path = notebook_relative_path(&ctx.root, path)?;
    let relative = Path::new(&relative_path);
    if !is_markdown_path(relative) || FileManagementPolicy::from_notebook_root(&ctx.root).is_index_ignored_at(&ctx.root, relative) {
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
    refresh_path(memo_file, ctx, path)
}

fn refresh_path(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    path: &Path,
) -> Result<DispatchOutcome, String> {
    let relative_path = indexable_relative_path(ctx, path)?;
    memo_file.refresh_note_path(&ctx.notebook_id, &relative_path)
        .map_err(|error| error.to_string())?;
    Ok(DispatchOutcome::PathIndexed { relative_path })
}

fn emit_path_changed(app: &AppHandle, ctx: &NotebookWatchContext, relative_path: &str, deleted: bool) {
    emit_path_changed_ui(app, ctx, relative_path, deleted);
    record_cloud_path_change(app, ctx, relative_path, deleted);
}

fn emit_path_changed_ui(app: &AppHandle, ctx: &NotebookWatchContext, relative_path: &str, deleted: bool) {
    let _ = app.emit("flowix:path-note-changed", serde_json::json!({
        "notebookId": ctx.notebook_id,
        "relativePath": relative_path,
        "deleted": deleted,
    }));
}

fn record_cloud_path_change(app: &AppHandle, ctx: &NotebookWatchContext, relative_path: &str, deleted: bool) {
    if !relative_path.is_empty() {
        if let Some(state) = app.try_state::<crate::app::state::AppState>() {
            let cloud_id = flowix_sync::v2_path_note_id(&ctx.notebook_id, relative_path);
            let fingerprint = if deleted {
                "deleted".to_string()
            } else {
                std::fs::read(ctx.root.join(relative_path))
                    .map(|bytes| flowix_sync::v2_content_hash(&bytes))
                    .unwrap_or_else(|_| "unobserved".to_string())
            };
            match state.cloud_sync.record_v2_local_change(
                &ctx.notebook_id,
                &cloud_id,
                if deleted { flowix_sync::LocalChangeKind::Delete } else { flowix_sync::LocalChangeKind::Put },
                &fingerprint,
            ) {
                Ok(changed) => crate::commands::cloud::schedule_notebook_sync_observation(
                    app.clone(), ctx.notebook_id.clone(), changed,
                ),
                Err(error) => tracing::warn!("failed to record cloud path change: {error}"),
            }
        }
    }
}

fn record_confirmed_cloud_move(
    app: &AppHandle,
    notebook_id: &str,
    from_path: &str,
    to_path: &str,
) -> bool {
    let Some(state) = app.try_state::<crate::app::state::AppState>() else { return false };
    match state.cloud_sync.record_v2_local_move(notebook_id, from_path, to_path) {
        Ok(true) => {
            crate::commands::cloud::schedule_notebook_sync(app.clone(), notebook_id.to_string());
            true
        }
        Ok(false) => false,
        Err(error) => {
            tracing::warn!("failed to record cloud move: {error}");
            false
        }
    }
}

fn refresh_media_path(memo_file: &MemoFile, ctx: &NotebookWatchContext, path: &Path) -> Result<(), String> {
    let relative_path = notebook_relative_path(&ctx.root, path)?;
    if FileManagementPolicy::from_notebook_root(&ctx.root)
        .is_ignored_at(&ctx.root, Path::new(&relative_path)) {
        return Ok(());
    }
    memo_file.refresh_media_resource_path(&ctx.notebook_id, &relative_path)
        .map_err(|error| error.to_string())
}

fn process_media_event(
    event: &RawFsEvent,
    memo_file: &Arc<std::sync::RwLock<MemoFile>>,
    ctx: &NotebookWatchContext,
) -> bool {
    if matches!(event.kind, FsEventKind::DirectoryChange) {
        return false;
    }
    let old_media = event.rename_from.as_ref().is_some_and(|path| media_kind_for_path(path).is_some());
    let new_media = media_kind_for_path(&event.path).is_some();
    if !old_media && !new_media {
        return false;
    }
    let Ok(memo_file) = memo_file.read() else { return true; };
    let Ok(_write_guard) = memo_file.acquire_cross_process_write_lock() else { return true; };
    if old_media && new_media {
        if let Some(old_path) = event.rename_from.as_ref() {
            if event.rename_from_notebook_id.as_ref().is_none_or(|id| id == &ctx.notebook_id) {
                let old_root = event.rename_from_root.as_ref().unwrap_or(&ctx.root);
                if let (Ok(old_relative), Ok(new_relative)) = (
                    notebook_relative_path(old_root, old_path),
                    notebook_relative_path(&ctx.root, &event.path),
                ) {
                    match memo_file.move_media_resource_path(&ctx.notebook_id, &old_relative, &new_relative) {
                        Ok(true) => return true,
                        Ok(false) => {},
                        Err(error) => tracing::warn!("media rename refresh failed: {error}"),
                    }
                }
            }
        }
    }
    if new_media {
        if let Err(error) = refresh_media_path(&memo_file, ctx, &event.path) {
            tracing::warn!(path = %event.path.display(), "media path refresh failed: {error}");
        }
    }
    if let Some(old_path) = event.rename_from.as_ref().filter(|_| old_media) {
        let old_ctx = NotebookWatchContext {
            notebook_id: event.rename_from_notebook_id.clone().unwrap_or_else(|| ctx.notebook_id.clone()),
            root: event.rename_from_root.clone().unwrap_or_else(|| ctx.root.clone()),
        };
        if let Err(error) = refresh_media_path(&memo_file, &old_ctx, old_path) {
            tracing::warn!(path = %old_path.display(), "old media path refresh failed: {error}");
        }
    }
    // A type-changing rename may also add or remove a Markdown note.
    !is_markdown_path(&event.path)
        && !event.rename_from.as_ref().is_some_and(|path| is_markdown_path(path))
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
        if !meta.is_file() { return; }
        let len = meta.len();
        if Some(len) == last_len {
            stable_samples += 1;
            if stable_samples >= 2 && std::fs::File::open(path).is_ok() { return; }
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
    ) {
        if process_media_event(event, memo_file, ctx) {
            let old_media_path = event.rename_from.as_ref().and_then(|old_path| {
                let old_ctx = NotebookWatchContext {
                    notebook_id: event.rename_from_notebook_id.clone().unwrap_or_else(|| ctx.notebook_id.clone()),
                    root: event.rename_from_root.clone().unwrap_or_else(|| ctx.root.clone()),
                };
                notebook_relative_path(&old_ctx.root, old_path).ok()
                    .filter(|path| path.starts_with("attachments/") && old_ctx.notebook_id == ctx.notebook_id)
            });
            let new_media_path = notebook_relative_path(&ctx.root, &event.path).ok()
                .filter(|path| path.starts_with("attachments/"));
            let moved = old_media_path.as_ref().zip(new_media_path.as_ref())
                .is_some_and(|(old, new)| record_confirmed_cloud_move(app, &ctx.notebook_id, old, new));
            if let Ok(relative) = notebook_relative_path(&ctx.root, &event.path) {
                if relative.starts_with("attachments/") && !moved {
                    record_cloud_path_change(app, ctx, &relative, !event.path.exists());
                }
            }
            if let Some(old_path) = &event.rename_from {
                let old_ctx = NotebookWatchContext {
                    notebook_id: event.rename_from_notebook_id.clone().unwrap_or_else(|| ctx.notebook_id.clone()),
                    root: event.rename_from_root.clone().unwrap_or_else(|| ctx.root.clone()),
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
                .is_ignored_at(&ctx.root, Path::new("attachments")) { return; }
        if let (Some(old_path), Some(old_notebook_id), Some(old_root)) = (
            event.rename_from.as_ref(),
            event.rename_from_notebook_id.as_ref(),
            event.rename_from_root.as_ref(),
        ) {
            if let Ok(memo_file) = memo_file.read() {
                if let Ok(_write_guard) = memo_file.acquire_cross_process_write_lock() {
                    crate::commands::document_list::refresh_view_document_path(&memo_file, old_path);
                    crate::commands::document_list::refresh_view_document_path(&memo_file, &event.path);
                }
            }
            let old_ctx = NotebookWatchContext { notebook_id: old_notebook_id.clone(), root: old_root.clone() };
            if let (Ok(old_relative), Ok(new_relative)) = (
                notebook_relative_path(&old_ctx.root, old_path),
                notebook_relative_path(&ctx.root, &event.path),
            ) {
                let state = app.state::<crate::app::state::AppState>();
                if let Err(error) = state.thread_manager.rebase_agent_note_paths(
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
        let Ok(memo_file) = memo_file.read() else { return; };
        let Ok(_write_guard) = memo_file.acquire_cross_process_write_lock() else { return; };

        if let Some(old_path) = &event.rename_from {
            crate::commands::document_list::refresh_view_document_path(&memo_file, old_path);
            crate::commands::document_list::refresh_view_document_path(&memo_file, &event.path);
            let rebase = notebook_relative_path(&ctx.root, old_path).ok()
                .zip(notebook_relative_path(&ctx.root, &event.path).ok());
            let cloud_move = rebase.as_ref().is_some_and(|(old, new)|
                record_confirmed_cloud_move(app, &ctx.notebook_id, old, new));
            if let Err(error) = memo_file.reconcile_note_index(&ctx.notebook_id) {
                tracing::warn!(notebook_id = %ctx.notebook_id, "path rename reconciliation failed: {error}");
            }
            drop(_write_guard);
            let old_path_is_markdown = is_markdown_path(old_path);
            let new_path_is_markdown = is_markdown_path(&event.path);
            if event.path.is_dir() || (old_path_is_markdown && new_path_is_markdown) {
                if let (Ok(old_relative), Ok(new_relative)) = (
                    notebook_relative_path(&ctx.root, old_path),
                    notebook_relative_path(&ctx.root, &event.path),
                ) {
                    crate::commands::document_list::rebase_table_note_paths(
                        &memo_file,
                        &ctx.notebook_id,
                        &old_relative,
                        &new_relative,
                    );
                }
            }
            let mut emitted = false;
            if let Ok(relative_path) = indexable_relative_path(ctx, old_path) {
                if cloud_move { emit_path_changed_ui(app, ctx, &relative_path, true); }
                else { emit_path_changed(app, ctx, &relative_path, true); }
                emitted = true;
            }
            if let Ok(relative_path) = indexable_relative_path(ctx, &event.path) {
                if cloud_move { emit_path_changed_ui(app, ctx, &relative_path, false); }
                else { emit_path_changed(app, ctx, &relative_path, false); }
                emitted = true;
            }
            if !emitted { emit_path_changed(app, ctx, "", false); }
            drop(memo_file);
            if let Some((old_relative, new_relative)) = rebase {
                let state = app.state::<crate::app::state::AppState>();
                if let Err(error) = state.thread_manager.rebase_agent_note_paths(
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
                crate::commands::document_list::refresh_view_document_path(&memo_file, &event.path);
                match refresh_path(&memo_file, ctx, &event.path) {
                    Ok(DispatchOutcome::PathIndexed { relative_path }) => {
                        emit_path_changed(app, ctx, &relative_path, !event.path.exists());
                    }
                    Err(error) => tracing::debug!(path = %event.path.display(), "path refresh skipped: {error}"),
                }
            }
            FsEventKind::DirectoryChange => {
                Self::reconcile_directory_change(app, &memo_file, ctx);
            }
            FsEventKind::Other => {}
        }
    }

    fn reconcile_directory_change(app: &AppHandle, memo_file: &MemoFile, ctx: &NotebookWatchContext) {
        crate::commands::document_list::refresh_view_document_catalog(memo_file, &ctx.notebook_id, &ctx.root);
        match memo_file.reconcile_note_index(&ctx.notebook_id) {
            Ok(report) => tracing::info!(notebook_id = %ctx.notebook_id,
                added = report.added, updated = report.updated, removed = report.removed,
                "path index reconciliation completed"),
            Err(error) => tracing::warn!(notebook_id = %ctx.notebook_id,
                "path index reconciliation failed: {error}"),
        }
        emit_path_changed(app, ctx, "", false);
        match memo_file.reconcile_media_resources(&ctx.notebook_id) {
            Ok(count) => tracing::debug!(notebook_id = %ctx.notebook_id, count, "media catalog reconciliation completed"),
            Err(error) => tracing::warn!(notebook_id = %ctx.notebook_id, "media catalog reconciliation failed: {error}"),
        }
    }

    pub(crate) fn unregister_and_emit(
        app: &AppHandle,
        memo_file: &Arc<std::sync::RwLock<MemoFile>>,
        ctx: &NotebookWatchContext,
        path: &Path,
    ) {
        if media_kind_for_path(path).is_some() {
            let Ok(memo_file) = memo_file.read() else { return; };
            let Ok(_write_guard) = memo_file.acquire_cross_process_write_lock() else { return; };
            if let Err(error) = refresh_media_path(&memo_file, ctx, path) {
                tracing::warn!(path = %path.display(), "media removal refresh failed: {error}");
            }
            return;
        }
        let Ok(memo_file) = memo_file.read() else { return; };
        let Ok(_write_guard) = memo_file.acquire_cross_process_write_lock() else { return; };
        crate::commands::document_list::refresh_view_document_path(&memo_file, path);
        if let Ok(DispatchOutcome::PathIndexed { relative_path }) = refresh_path(&memo_file, ctx, path) {
            emit_path_changed(app, ctx, &relative_path, !path.exists());
        }
    }
}

#[cfg(test)]
mod tests;
