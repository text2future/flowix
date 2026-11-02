// ==================== Reads ====================

use std::fs;
use std::path::Path;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::lock_utils::read_lock;
use flowix_core::memo_file::{
    normalize_markdown_encoding_boundaries,
    notebook_path_from_relative, notebook_relative_path, Memo, MemoFile,
    NoteEntry, NoteTitleFilter,
};
use flowix_core::service::{NoteSaveOutcome, NotePageQuery};
use flowix_core::{FlowixError, NoteService};

use crate::app::state::AppState;
use crate::watcher::runtime::mark_self_write_content_for;

use super::helpers::*;
use super::*;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownLocation {
    path: String,
    notebook_id: Option<String>,
    relative_path: Option<String>,
    notebook_path: Option<String>,
    indexable: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NotePathStatus {
    Present,
    Missing,
}

/// Report absence separately from permission and I/O errors for stale-note actions.
#[tauri::command]
pub fn note_path_status(file_path: String, state: State<AppState>) -> Result<NotePathStatus, String> {
    let path = Path::new(&file_path);
    if !path.is_absolute() {
        return Err("absolute note path required".into());
    }
    let memo_file = read_lock(&state.memo_file, "memo_file");
    super::helpers::notebook_note_address(&memo_file, path)?
        .ok_or_else(|| "note path is outside a notebook or is not Markdown".to_string())?;
    drop(memo_file);
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(NotePathStatus::Present),
        Ok(_) => Err("note path is not a file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(NotePathStatus::Missing),
        Err(error) => Err(format!("cannot access note path: {error}")),
    }
}

/// Classify a Markdown file by notebook-relative path, independently of its opening UI.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn resolve_markdown_location(
    filePath: String,
    app: AppHandle,
) -> Result<MarkdownLocation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let requested = Path::new(&filePath);
        if !requested.is_absolute() {
            return Err("absolute document path required".to_string());
        }
        let path = dunce::canonicalize(requested).unwrap_or_else(|_| requested.to_path_buf());
        let mut notebooks = memo_file.read_notebook_configs().map_err(|error| error.to_string())?;
        notebooks.sort_by_key(|notebook| std::cmp::Reverse(notebook.path.len()));
        for notebook in notebooks {
            let root = Path::new(&notebook.path);
            let canonical_root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
            let Ok(relative_path) = notebook_relative_path(&canonical_root, &path) else {
                continue;
            };
            let relative = Path::new(&relative_path);
            let markdown = relative.extension().and_then(|ext| ext.to_str())
                .is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown"));
            let policy = memo_file.file_management_policy(&notebook.id);
            let indexable = markdown && !policy.is_index_hidden_at(&canonical_root, relative);
            return Ok(MarkdownLocation {
                path: path.to_string_lossy().into_owned(),
                notebook_id: Some(notebook.id),
                relative_path: Some(relative_path),
                notebook_path: Some(notebook.path),
                indexable,
            });
        }
        Ok(MarkdownLocation {
            path: path.to_string_lossy().into_owned(),
            notebook_id: None,
            relative_path: None,
            notebook_path: None,
            indexable: false,
        })
    }).await.map_err(|error| format!("Markdown location task failed: {error}"))?
}
/// List the notebook's rebuildable note projection, keyed by relative path.
#[tauri::command]
pub async fn list_notes_by_path(
    notebook_id: String,
    app: AppHandle,
) -> Result<Vec<NoteEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let memo_file = read_lock(&state.memo_file, "memo_file");
        NoteService::new(&memo_file)
            .list(&notebook_id)
            .map_err(|error| crate::app::notebook_background::query_error(state.inner(), &notebook_id, error))
    })
    .await
    .map_err(|error| format!("path-based note list task failed: {error}"))?
}

/// Read one note from the current index projection without changing index state.
#[tauri::command]
pub async fn get_indexed_note_by_path(
    notebook_id: String,
    relative_path: String,
    app: AppHandle,
) -> Result<Option<NoteEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let memo_file = read_lock(&state.memo_file, "memo_file");
        memo_file.read_indexed_note_entry_by_path(&notebook_id, &relative_path)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("indexed note read task failed: {error}"))?
}

/// Return one page from the path-keyed Note index without consulting Memo IDs.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn get_path_notes(
    notebook_id: String,
    filter: Option<String>,
    sort: Option<String>,
    tag_id: Option<String>,
    color: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
    title_filter: Option<NoteTitleFilter>,
    app: AppHandle,
) -> Result<GetPathNotesResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let mut service = NoteService::new(&memo_file);
        let page = service
            .list_indexed_page_query(&notebook_id, NotePageQuery {
                filter: filter.as_deref().unwrap_or("all"),
                sort: sort.as_deref().unwrap_or("createdAt"),
                tag_id: tag_id.as_deref(),
                color: color.as_deref(),
                cursor: cursor.as_deref(),
                limit,
                title_filter: title_filter.as_ref(),
            })
            .map_err(|error: FlowixError| crate::app::notebook_background::query_error(state.inner(), &notebook_id, error))?;
        Ok(GetPathNotesResponse {
            notes: page.notes,
            next_cursor: page.next_cursor,
            has_more: page.has_more,
        })
    })
    .await
    .map_err(|error| format!("path note list task failed: {error}"))?
}
#[tauri::command]
pub async fn get_used_memo_tag_ids(
    notebook_id: Option<String>,
    app: AppHandle,
) -> Result<UsedMemoTagIdsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let id = notebook_id.or_else(|| memo_file.current_notebook_id_value()).unwrap_or_default();
        let (used_tag_ids, tag_counts, total_memo_count, agent_memo_count, todo_memo_count) =
            memo_file.read_tag_usage_summary_for_notebook_id(Some(&id))
                .map_err(|error| crate::app::notebook_background::query_error(state.inner(), &id, error))?;
        Ok(UsedMemoTagIdsResponse {
            used_tag_ids,
            tag_counts: tag_counts
                .into_iter()
                .map(|(tag_id, count)| MemoTagCount { tag_id, count })
                .collect(),
            total_memo_count,
            agent_memo_count,
            todo_memo_count,
        })
    })
    .await
    .map_err(|error| format!("tag summary task failed: {error}"))?
}

#[tauri::command]
pub async fn read_document(
    window: tauri::WebviewWindow,
    file_path: String,
    app: AppHandle,
) -> Option<String> {
    crate::document_io::run("read", move || {
        let state = app.state::<AppState>();
        if !crate::commands::helpers::can_access_document_path(
            Path::new(&file_path),
            window.label(),
            &state,
        ) {
            eprintln!("[read_document] refused out-of-scope path: {}", file_path);
            return None;
        }
        let requested_path = Path::new(&file_path);
        let memo_file = read_lock(&state.memo_file, "memo_file");
        match notebook_note_address(&memo_file, requested_path) {
            Ok(Some((notebook_id, relative_path))) => {
                let mut service = NoteService::new(&memo_file);
                if let Err(error) = service.get(&notebook_id, &relative_path) {
                    tracing::debug!(
                        notebook_id = %notebook_id,
                        relative_path = %relative_path,
                        "note read is falling back to Markdown after path-index failure: {error}"
                    );
                }
            }
            Err(error) => {
                tracing::warn!(path = %requested_path.display(), "refusing note path: {error}");
                return None;
            }
            Ok(None) => {}
        }
        fs::read_to_string(requested_path)
            .ok()
            .map(|content| normalize_markdown_encoding_boundaries(&content).into_owned())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn get_document_modified_at(
    window: tauri::WebviewWindow,
    file_path: String,
    app: AppHandle,
) -> Option<u64> {
    crate::document_io::run("metadata", move || {
        let state = app.state::<AppState>();
        let path = Path::new(&file_path);
        if !crate::commands::helpers::can_access_document_path(path, window.label(), &state) {
            return None;
        }
        fs::metadata(path).ok()?.modified().ok()?
            .duration_since(std::time::UNIX_EPOCH).ok()
            .map(|duration| duration.as_millis() as u64)
    })
    .await
    .ok()
    .flatten()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteDocumentResult {
    pub path: String,
    pub content: String,
    #[serde(flatten)]
    pub commit: Option<crate::document_mutation::DocumentCommit>,
}

/// Save a notebook note by path. Standalone documents use the independent
/// `write_external_document` command and never enter this path.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn write_document(
    operation_id: Option<String>,
    filePath: String,
    content: String,
    expectedContent: Option<String>,
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<WriteDocumentResult>, String> {
    let origin_window_label = window.label().to_owned();
    crate::commands::document_operations::run(
        "save",
        operation_id,
        origin_window_label.clone(),
        move || {
            let state = app.state::<AppState>();
            write_document_internal(
                &filePath,
                &content,
                expectedContent.as_deref(),
                &state,
                &app,
                &origin_window_label,
            )
        },
    )
    .await
}

/// Save the existing file at an exact absolute path with content validation.
fn write_document_internal(
    file_path: &str,
    content: &str,
    expected_content: Option<&str>,
    state: &State<AppState>,
    app: &AppHandle,
    origin_window_label: &str,
) -> Result<Option<WriteDocumentResult>, String> {
    if !Path::new(file_path).is_absolute() {
        return Err("absolute document path required".into());
    }
    let requested_path = Path::new(file_path);
    let (notebook_id, relative_path) =
        notebook_note_address(&read_lock(&state.memo_file, "memo_file"), requested_path)?
            .ok_or_else(|| {
                "document is not a Markdown note inside a registered notebook".to_string()
            })?;

    let current_content = fs::read_to_string(requested_path).map_err(|error| error.to_string())?;
    if expected_content
        .is_some_and(|expected| !cas_content_matches(&current_content, expected, content))
    {
        return Ok(None);
    }

    let (saved_path, saved_content, entry, profile) = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let mut service = NoteService::new(&memo_file);
        // Register the revision this save is about to land, not the revision
        // currently on disk. Everything below (file sync, index commit, FTS
        // rewrite) happens before the post-write mark exists, and the watcher
        // validates self-writes ~100ms after the event; on a slow disk the save
        // outlives that window, so a disk-state pre-mark would be stale and the
        // post-write mark would arrive too late — the write gets reported as an
        // external edit and the UI refetches the whole notebook. The file is
        // written verbatim (`atomic_write_bytes(path, content.as_bytes())`), so
        // the content hash is knowable before the write.
        mark_self_write_content_for(app, requested_path, content.as_bytes());
        let outcome = service.save(
            &notebook_id,
            &relative_path,
            content,
            Some(&current_content),
        );
        // Read on the saving thread, before the lock is released; writing the
        // log line happens after the lock so it never extends the critical path.
        let profile = flowix_core::memo_file::save_probe::take_last();
        match outcome {
            Ok(NoteSaveOutcome::Saved(document)) => {
                (document.path, document.body, document.entry, profile)
            }
            Ok(NoteSaveOutcome::Conflict { .. }) => return Ok(None),
            Err(error) => return Err(error.to_string()),
        }
    };

    record_slow_save_profile(profile);
    // The landed bytes are already known, so refreshing the mark must not cost
    // another full-file read + hash on the save path. This keeps the mark alive
    // past a long index refresh.
    mark_self_write_content_for(app, &saved_path, saved_content.as_bytes());
    let _ = app.emit("flowix:path-note-changed", serde_json::json!({
        "changeId": uuid::Uuid::new_v4().to_string(),
        "notebookId": notebook_id,
        "relativePath": relative_path,
        "entry": entry,
        "originWindowLabel": origin_window_label,
    }));

    Ok(Some(WriteDocumentResult {
        path: saved_path.display().to_string(),
        content: saved_content,
        commit: None,
    }))
}

/// A save slower than this is worth a line in `app.log`; on a healthy machine
/// the whole path is ~12-15ms, so anything above this is a real signal.
const SLOW_SAVE_LOG_MS: f64 = 40.0;

fn record_slow_save_profile(
    profile: Option<flowix_core::memo_file::save_probe::SaveProfile>,
) {
    let Some(profile) = profile else { return };
    if profile.total_ms() < SLOW_SAVE_LOG_MS {
        return;
    }
    crate::runtime_log::record_event("warn", "slow-note-save", profile.to_json());
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathNoteSearchHit {
    notebook_id: String,
    relative_path: String,
    title: String,
    snippet: String,
    matched_in: String,
}

#[tauri::command]
pub async fn search_path_notes(
    notebook_id: String,
    query: String,
    limit: Option<usize>,
    app: AppHandle,
) -> Result<Vec<PathNoteSearchHit>, String> {
    // Search runs a SQLite query plus a full-text scan. A synchronous command
    // executes on the main thread, which froze the Webview while typing or
    // while a background reconcile held the read lock.
    let memo_file = app.state::<AppState>().memo_file.clone();
    let limit = limit.unwrap_or(30).clamp(1, 100);
    tauri::async_runtime::spawn_blocking(move || {
        let memo_file = read_lock(&memo_file, "memo_file");
        NoteService::new(&memo_file)
            .search(&notebook_id, &query, limit)
            .map_err(|error| error.to_string())
            .map(|hits| {
                hits.into_iter()
                    .map(|hit| PathNoteSearchHit {
                        notebook_id: notebook_id.clone(),
                        relative_path: hit.relative_path,
                        title: hit.title,
                        snippet: hit.snippet,
                        matched_in: hit.matched_in,
                    })
                    .collect()
            })
    })
    .await
    .map_err(|error| error.to_string())?
}
