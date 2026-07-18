// ==================== Reads ====================

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};

use crate::lock_utils::read_lock;
use crate::memo_events::{self, MemoChangeSource, MemoDerivedChanged};
use crate::watcher::path::normalize_for_compare;
use flowix_core::memo_file::{Memo, MemoFile, MemoTodoEntry};
use flowix_core::MemoService;

use crate::app::search_index::rebuild_index_in_background;
use crate::app::state::AppState;
use crate::commands::helpers::start_security_bookmark_access;
use crate::watcher::runtime::mark_self_write_for;

use super::helpers::*;
use super::*;

#[tauri::command]
#[allow(non_snake_case)]
pub fn get_memos(
    notebook_id: Option<String>,
    filter: Option<String>,
    sort: Option<String>,
    tag_id: Option<String>,
    state: State<AppState>,
    _app: AppHandle,
) -> GetMemosResponse {
    // Read the requested notebook directly. Do not switch current notebook here;
    // switching would rebind watcher/reconcile/search and slow down list loading.
    let memos = MemoService::new(&read_lock(&state.memo_file, "memo_file")).list_memos_filtered(
        notebook_id.as_deref(),
        filter.as_deref().unwrap_or("all"),
        sort.as_deref().unwrap_or("createdAt"),
        tag_id.as_deref(),
    );
    GetMemosResponse { memos }
}

#[tauri::command]
pub fn search_mention_notes(
    query: Option<String>,
    limit: Option<usize>,
    state: State<AppState>,
) -> Vec<MentionNoteSearchItem> {
    let normalized_query = query.unwrap_or_default().trim().to_lowercase();
    let max_items = limit.unwrap_or(200).max(1);

    let memo_file = read_lock(&state.memo_file, "memo_file");
    let previous_notebook_id = memo_file.current_notebook_id_value();
    let mut service = MemoService::new(&memo_file);
    let notebooks = service.list_notebooks().unwrap_or_default();

    let mut ordered_notebooks = notebooks.clone();
    if let Some(current_id) = previous_notebook_id.as_deref() {
        ordered_notebooks.sort_by(|a, b| {
            let a_current = a.id == current_id;
            let b_current = b.id == current_id;
            b_current.cmp(&a_current)
        });
    }

    let mut items = Vec::new();
    for notebook in ordered_notebooks {
        for memo in service.list_memos_filtered(Some(&notebook.id), "all", "updatedAt", None) {
            let title = note_title(&memo.filename);
            if !normalized_query.is_empty() && !title.to_lowercase().contains(&normalized_query) {
                continue;
            }

            let original_path = Path::new(&notebook.path)
                .join(&memo.filename)
                .to_str()
                .map(|path| path.to_string());

            items.push(MentionNoteSearchItem {
                id: memo.id,
                filename: memo.filename,
                title,
                updated_at: memo.updated_at,
                notebook_id: notebook.id.clone(),
                notebook_name: notebook.name.clone(),
                notebook_path: notebook.path.clone(),
                original_path,
            });

            if items.len() >= max_items {
                return items;
            }
        }
    }

    items
}

#[tauri::command]
pub fn list_agent_role_memos(state: State<AppState>) -> Vec<AgentRoleMemoItem> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let previous_notebook_id = memo_file.current_notebook_id_value();
    let mut service = MemoService::new(&memo_file);
    let notebooks = service.list_notebooks().unwrap_or_default();

    let mut ordered_notebooks = notebooks.clone();
    if let Some(current_id) = previous_notebook_id.as_deref() {
        ordered_notebooks.sort_by(|a, b| {
            let a_current = a.id == current_id;
            let b_current = b.id == current_id;
            b_current.cmp(&a_current)
        });
    }

    let mut items = Vec::new();
    for notebook in ordered_notebooks {
        for memo in service.list_all_memos(Some(&notebook.id)) {
            let role_name = memo
                .properties
                .get("agent-role")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let Some(role_name) = role_name else {
                continue;
            };
            let memo_icon = memo
                .properties
                .get("icon")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .or_else(|| memo.icon.clone());

            items.push(AgentRoleMemoItem {
                memo_id: memo.id,
                role_name: role_name.to_string(),
                filename: memo.filename,
                memo_icon,
                notebook_id: notebook.id.clone(),
                notebook_name: notebook.name.clone(),
                notebook_icon: notebook.icon.clone(),
            });
        }
    }

    items.sort_by(|a, b| {
        a.role_name
            .to_lowercase()
            .cmp(&b.role_name.to_lowercase())
            .then_with(|| {
                a.notebook_name
                    .to_lowercase()
                    .cmp(&b.notebook_name.to_lowercase())
            })
            .then_with(|| a.filename.to_lowercase().cmp(&b.filename.to_lowercase()))
    });
    items
}

#[tauri::command]
pub fn get_used_memo_tag_ids(
    notebook_id: Option<String>,
    state: State<AppState>,
) -> UsedMemoTagIdsResponse {
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
}

#[tauri::command]
pub fn get_memo_todo_metadata(
    notebook_id: Option<String>,
    sort: Option<String>,
    state: State<AppState>,
) -> Vec<MemoTodoEntry> {
    MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .todo_metadata(
            notebook_id.as_deref(),
            sort.as_deref().unwrap_or("createdAt"),
        )
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_memo_todo_count(notebook_id: Option<String>, state: State<AppState>) -> usize {
    get_memo_todo_metadata(notebook_id, None, state).len()
}

#[tauri::command]
pub fn read_memo(id: String, state: State<AppState>) -> Option<Memo> {
    let (memo, path) = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let mut service = MemoService::new(&memo_file);
        let memo = service.memo_metadata(&id).ok()?;
        let path = service.resolve_memo(&id).ok()?.path;
        (memo, path)
    };
    // Keep stale index entries from opening an empty editor when the file is gone.
    start_security_bookmark_access(&state, &path);
    if !path.exists() {
        tracing::info!(
            "[read_memo] file gone, unregistering ghost: {}",
            path.display()
        );
        let _ = MemoService::new(&read_lock(&state.memo_file, "memo_file")).delete_memo(&memo.id);
        return None;
    }
    Some(memo)
}

/// Resolve the authoritative memo metadata, path and body in one IPC.
///
/// Tab hosts use this at activation time so inactive tabs remain cheap and a
/// document switch does not need separate `read_memo` + `read_document` calls.
#[tauri::command]
pub fn open_memo_session(id: String, state: State<AppState>) -> Option<OpenMemoSessionResponse> {
    let (memo, notebook_id, notebook_path, path) = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let mut service = MemoService::new(&memo_file);
        let resolved = service.resolve_memo(&id).ok()?;
        (
            MemoFile::index_entry_to_memo(&resolved.entry),
            resolved.notebook.id,
            resolved.notebook.path,
            resolved.path,
        )
    };

    start_security_bookmark_access(&state, &path);
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) => {
            if error.kind() == std::io::ErrorKind::NotFound {
                tracing::info!(
                    "[open_memo_session] file gone, unregistering ghost: {}",
                    path.display()
                );
                let _ = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
                    .delete_memo(&memo.id);
            }
            return None;
        }
    };

    Some(OpenMemoSessionResponse {
        memo,
        notebook_id,
        notebook_path,
        path: path.to_string_lossy().to_string(),
        content,
    })
}

#[tauri::command]
pub fn read_document(file_path: String, state: State<AppState>) -> Option<String> {
    if !crate::commands::helpers::can_access_document_path(Path::new(&file_path), &state) {
        eprintln!("[read_document] refused out-of-scope path: {}", file_path);
        return None;
    }
    let io_path = resolve_document_path_for_io(&file_path, state.inner());
    start_security_bookmark_access(&state, &io_path);
    fs::read_to_string(&io_path).ok()
}

/// Resolve a document path for disk I/O, with a constrained stale-path fallback.
fn resolve_document_path_for_io(file_path: &str, state: &AppState) -> std::path::PathBuf {
    let requested_path = std::path::PathBuf::from(file_path);
    if requested_path.exists() {
        return requested_path;
    }
    // If the requested stale path is missing, resolve by the notebook implied by that path.
    if let Some(file_name) = requested_path.file_name().and_then(|n| n.to_str()) {
        if let Some(entry_path) =
            resolve_missing_document_path_from_notebook_index(&requested_path, file_name, state)
        {
            return entry_path;
        }
    }
    requested_path
}

fn resolve_missing_document_path_from_notebook_index(
    requested_path: &Path,
    file_name: &str,
    state: &AppState,
) -> Option<PathBuf> {
    let requested_norm = normalize_for_compare(requested_path);
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let mut service = MemoService::new(&memo_file);
    let configs = service.list_notebooks().ok()?;

    let mut candidates = configs
        .into_iter()
        .filter_map(|cfg| {
            let base_norm = normalize_for_compare(Path::new(&cfg.path));
            requested_norm
                .starts_with(&base_norm)
                .then_some((base_norm.to_string_lossy().len(), cfg))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|a, b| b.0.cmp(&a.0));

    for (_, cfg) in candidates {
        if let Some(entry) = service
            .list_memos(&cfg.id)
            .unwrap_or_default()
            .into_iter()
            .find(|entry| entry.filename == file_name)
        {
            return Some(PathBuf::from(cfg.path).join(entry.filename));
        }
    }
    None
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteDocumentResult {
    pub path: String,
    pub content: String,
}

/// Write an indexed memo. Standalone Markdown files use the independent
/// `write_external_document` command and never enter this path.
#[tauri::command]
#[allow(non_snake_case)]
pub fn write_document(
    key: Option<String>,
    content: String,
    expectedContent: Option<String>,
    state: State<AppState>,
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Option<WriteDocumentResult> {
    write_document_internal(
        key.as_deref(),
        &content,
        expectedContent.as_deref(),
        &state,
        &app,
        window.label(),
    )
}

/// Write a memo by global key and return the final path/content after rename.
fn write_document_internal(
    key: Option<&str>,
    content: &str,
    expected_content: Option<&str>,
    state: &State<AppState>,
    app: &AppHandle,
    origin_window_label: &str,
) -> Option<WriteDocumentResult> {
    let key = key?;
    let before = read_memo_or_none(state.inner(), key);
    if before.is_none() {
        eprintln!("[write_document_internal] memo not found: key={key}");
        return None;
    }

    // CAS: reject the write if the on-disk content has diverged from the caller.
    if let Some(expected) = expected_content {
        let current_path =
            match MemoService::new(&read_lock(&state.memo_file, "memo_file")).resolve_memo(key) {
                Ok(resolved) => resolved.path,
                Err(_) => {
                    eprintln!("[write_document_internal] no file path for key={key}");
                    return None;
                }
            };
        start_security_bookmark_access(state.inner(), &current_path);
        match fs::read_to_string(&current_path) {
            Ok(current) if cas_content_matches(&current, expected, content) => {}
            Ok(_) => {
                eprintln!(
                    "[write_document_internal] CAS refused: key={} disk != expected",
                    key
                );
                return None;
            }
            Err(e) => {
                eprintln!("[write_document_internal] CAS read failed for {key}: {e}");
                return None;
            }
        }
    }

    // Mark the target before writing so the watcher can suppress our own change.
    if let Ok(resolved) =
        MemoService::new(&read_lock(&state.memo_file, "memo_file")).resolve_memo(key)
    {
        let path = resolved.path;
        start_security_bookmark_access(state.inner(), &path);
        mark_self_write_for(app, &path);
    }
    let result =
        MemoService::new(&read_lock(&state.memo_file, "memo_file")).save_memo(key, content);
    match result {
        Ok(edited) => {
            let updated = edited.memo?;
            // Internal editor saves suppress their own watcher events, so this
            // path is responsible for notifying the UI with the final memo
            // metadata after preview/thumbnail/tags/todos derivation.
            // The write may rename the file, so resolve the final path after it succeeds.
            let final_path = edited.path;
            start_security_bookmark_access(state.inner(), &final_path);
            mark_self_write_for(app, &final_path);
            let final_content = match fs::read_to_string(&final_path) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!(
                        "[write_document_internal] final read_to_string failed for {key}: {e}"
                    );
                    return None;
                }
            };
            if let Err(e) = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
                .maybe_create_auto_memo_version(key, &final_content)
            {
                eprintln!("[write_document_internal] auto version failed for {key}: {e}");
            }
            let event_path = final_path.to_string_lossy().to_string();
            let notebook_id = notebook_id_for_memo(state.inner(), key);
            let derived_changed = MemoDerivedChanged::from_memos(before.as_ref(), &updated);
            emit_updated_memo_event(
                state.inner(),
                app,
                key,
                event_path.clone(),
                updated,
                notebook_id,
                derived_changed,
                MemoChangeSource::UserEdit,
            );
            memo_events::emit_content_updated_to_sibling_windows(
                app,
                origin_window_label,
                key,
                &event_path,
            );
            Some(WriteDocumentResult {
                path: event_path,
                content: final_content,
            })
        }
        Err(e) => {
            eprintln!("[write_document_internal] write_memo failed for {key}: {e}");
            None
        }
    }
}

#[tauri::command]
pub fn get_launch_open_files() -> Vec<String> {
    crate::commands::helpers::markdown_paths_from_args(std::env::args())
}

#[tauri::command]
pub fn search_memos(
    notebook_id: Option<String>,
    query: String,
    limit: Option<usize>,
    state: State<AppState>,
    app: AppHandle,
) -> SearchMemosResponse {
    let idx = read_lock(&state.search, "search");
    if let Some(ref nb) = notebook_id {
        if idx.current_notebook() != Some(nb.as_str()) {
            drop(idx);
            rebuild_index_in_background(state.inner(), &app);
            return SearchMemosResponse {
                hits: vec![],
                index_ready: false,
            };
        }
    }
    drop(idx);

    let needs_rebuild = {
        let idx = read_lock(&state.search, "search");
        let current_nb = read_lock(&state.memo_file, "memo_file").current_notebook_id_value();
        !idx.is_loaded() || idx.current_notebook() != current_nb.as_deref()
    };
    if needs_rebuild {
        rebuild_index_in_background(state.inner(), &app);
    }

    let idx = read_lock(&state.search, "search");
    let index_ready = idx.is_loaded();
    let hits = idx.search(&query, limit.unwrap_or(30));
    SearchMemosResponse { hits, index_ready }
}
