// ==================== Reads ====================

use std::fs;
use std::path::Path;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::lock_utils::read_lock;
use flowix_core::memo_file::{
    normalize_markdown_encoding_boundaries,
    notebook_path_from_relative, notebook_relative_path, Memo, MemoFile,
    NoteEntry, PathTodoEntry,
};
use flowix_core::service::NoteSaveOutcome;
use flowix_core::{FlowixError, MemoPage, MemoService, NoteService};

use crate::app::state::AppState;
use crate::commands::helpers::start_security_bookmark_access;
use crate::watcher::runtime::mark_self_write_for;

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

/// Classify a Markdown file independently of its opening UI and legacy memo ID.
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
            let indexable = markdown && !policy.is_index_ignored_at(&canonical_root, relative);
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
/// List the notebook's rebuildable note projection by relative path. This is
/// the ID-free list boundary for callers migrating off the legacy memo table.
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
            .map_err(|error| error.to_string())
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
    app: AppHandle,
) -> Result<GetPathNotesResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let mut service = NoteService::new(&memo_file);
        let page = service
            .list_page(
                &notebook_id,
                filter.as_deref().unwrap_or("all"),
                sort.as_deref().unwrap_or("createdAt"),
                tag_id.as_deref(),
                color.as_deref(),
                cursor.as_deref(),
                limit,
            )
            .map_err(|error: FlowixError| error.to_string())?;
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
        let (used_tag_ids, tag_counts, total_memo_count, agent_memo_count, todo_memo_count) =
            MemoService::new(&read_lock(&state.memo_file, "memo_file"))
                .tag_usage_summary(notebook_id.as_deref())
                .unwrap_or_default();
        UsedMemoTagIdsResponse {
            used_tag_ids,
            tag_counts: tag_counts
                .into_iter()
                .map(|(tag_id, count)| MemoTagCount { tag_id, count })
                .collect(),
            total_memo_count,
            agent_memo_count,
            todo_memo_count,
        }
    })
    .await
    .map_err(|error| format!("tag summary task failed: {error}"))
}

#[tauri::command]
pub fn get_memo_todo_metadata(
    notebook_id: Option<String>,
    sort: Option<String>,
    state: State<AppState>,
) -> Vec<PathTodoEntry> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let notebooks = memo_file.read_notebook_configs().unwrap_or_default();
    let mut entries = notebooks.into_iter()
        .filter(|notebook| notebook_id.as_deref().is_none_or(|id| notebook.id == id))
        .flat_map(|notebook| memo_file.read_note_path_todos(&notebook.id, sort.as_deref().unwrap_or("createdAt")).unwrap_or_default())
        .collect::<Vec<_>>();
    if sort.as_deref() == Some("updatedAt") {
        entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    } else {
        entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    }
    entries
}

#[tauri::command]
pub fn get_memo_todo_count(notebook_id: Option<String>, state: State<AppState>) -> usize {
    get_memo_todo_metadata(notebook_id, None, state).len()
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
        start_security_bookmark_access(&state, requested_path);
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
        start_security_bookmark_access(&state, path);
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
    crate::commands::document_operations::run(
        "save",
        operation_id,
        window.label().to_owned(),
        move || {
            let state = app.state::<AppState>();
            write_document_internal(
                &filePath,
                &content,
                expectedContent.as_deref(),
                &state,
                &app,
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
) -> Result<Option<WriteDocumentResult>, String> {
    if !Path::new(file_path).is_absolute() {
        return Err("absolute document path required".into());
    }
    start_security_bookmark_access(state.inner(), Path::new(file_path));
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

    let (saved_path, saved_content) = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let mut service = NoteService::new(&memo_file);
        mark_self_write_for(app, requested_path);
        match service.save(
            &notebook_id,
            &relative_path,
            content,
            Some(&current_content),
        ) {
            Ok(NoteSaveOutcome::Saved(document)) => (document.path, document.body),
            Ok(NoteSaveOutcome::Conflict { .. }) => return Ok(None),
            Err(error) => return Err(error.to_string()),
        }
    };

    mark_self_write_for(app, &saved_path);
    let _ = app.emit("flowix:path-note-changed", serde_json::json!({
        "notebookId": notebook_id,
        "relativePath": relative_path,
    }));

    Ok(Some(WriteDocumentResult {
        path: saved_path.display().to_string(),
        content: saved_content,
        commit: None,
    }))
}

#[tauri::command]
pub fn get_launch_open_files(window: tauri::WebviewWindow, state: State<AppState>) -> Vec<String> {
    if window.label() != "main" {
        return Vec::new();
    }
    crate::commands::helpers::markdown_paths_from_args(std::env::args())
        .into_iter()
        .filter_map(|path| dunce::canonicalize(path).ok())
        .map(|path| path.to_string_lossy().into_owned())
        .filter(|path| state.document_access.grant(window.label(), Path::new(path)))
        .collect()
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
pub fn search_path_notes(
    notebook_id: String,
    query: String,
    limit: Option<usize>,
    state: State<AppState>,
) -> Result<Vec<PathNoteSearchHit>, String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    NoteService::new(&memo_file)
        .search(&notebook_id, &query, limit.unwrap_or(30).clamp(1, 100))
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
}
