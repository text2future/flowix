//! Memo and document IPC commands.
//!
//! User-facing memo operations resolve globally by memo id. Watcher and
//! reconcile code stay scoped to the current notebook to avoid treating copied
//! files from another notebook as the original memo.
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::lock_utils::{read_lock, write_lock};
use crate::memo_events::{self, MemoChangeSource, MemoDerivedChanged, MemoEvent};
use crate::watcher::path::normalize_for_compare;
use crate::USER_CONFIG_DIR_NAME;
use flowix_core::memo_file::{
    atomic_write_bytes, extract_body_content, Memo, MemoColor, MemoFile, MemoTodoEntry,
    MemoVersionMeta, MemoVersionSource,
};
use flowix_core::search::MemoSearchHit;

use super::helpers::{
    force_rebuild_index, mark_self_write_for, rebuild_index_in_background,
    start_security_bookmark_access, synthesize_minimal_memo, try_index_remove, try_index_upsert,
};
use super::AppState;

#[derive(Serialize)]
pub struct GetMemosResponse {
    pub memos: Vec<Memo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMemosResponse {
    pub hits: Vec<MemoSearchHit>,
    pub index_ready: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionNoteSearchItem {
    pub id: String,
    pub filename: String,
    pub title: String,
    pub updated_at: i64,
    pub notebook_id: String,
    pub notebook_name: String,
    pub notebook_path: String,
    pub original_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoleMemoItem {
    pub memo_id: String,
    pub role_name: String,
    pub filename: String,
    pub memo_icon: Option<String>,
    pub notebook_id: String,
    pub notebook_name: String,
    pub notebook_icon: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsedMemoTagIdsResponse {
    pub used_tag_ids: Vec<String>,
    pub tag_counts: Vec<MemoTagCount>,
    pub total_memo_count: usize,
    pub agent_memo_count: usize,
    pub todo_memo_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoTagCount {
    pub tag_id: String,
    pub count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoTemplate {
    pub id: String,
    pub name: String,
}

// ==================== Helpers ====================

/// Read a memo from memo index; returns None when the id is missing.
fn read_memo_or_none(state: &AppState, id: &str) -> Option<Memo> {
    read_lock(&state.memo_file, "memo_file").read_memo_global(id)
}

fn current_notebook_id(state: &AppState) -> String {
    read_lock(&state.memo_file, "memo_file")
        .current_notebook_id_value()
        .unwrap_or_else(|| "nb_default".to_string())
}

fn notebook_id_for_memo(state: &AppState, id: &str) -> String {
    read_lock(&state.memo_file, "memo_file")
        .resolve_memo_location(id)
        .ok()
        .flatten()
        .map(|location| location.notebook.id)
        .unwrap_or_else(|| current_notebook_id(state))
}

/// Resolve the physical file path for an event payload.
fn abs_path_for(state: &AppState, id: &str) -> String {
    read_lock(&state.memo_file, "memo_file")
        .find_memo_file_path(id)
        .map(|p| p.display().to_string())
        .unwrap_or_default()
}

fn emit_updated_memo_event(
    state: &AppState,
    app: &AppHandle,
    id: &str,
    path: String,
    memo: Memo,
    notebook_id: String,
    derived_changed: MemoDerivedChanged,
    source: MemoChangeSource,
) {
    try_index_upsert(state, id);
    memo_events::emit(
        app,
        MemoEvent::Updated {
            id: id.to_string(),
            path,
            notebook_id,
            memo,
            derived_changed,
            source,
        },
    );
}

/// Mark the written file, refresh the search index, and notify the UI.
fn emit_updated_after_write(state: &AppState, app: &AppHandle, id: &str, before: Option<Memo>) {
    let path = abs_path_for(state, id);
    if !path.is_empty() {
        mark_self_write_for(app, Path::new(&path));
    }
    let memo = read_memo_or_none(state, id).unwrap_or_else(|| synthesize_minimal_memo(id));
    let notebook_id = notebook_id_for_memo(state, id);
    let derived_changed = MemoDerivedChanged::from_memos(before.as_ref(), &memo);
    emit_updated_memo_event(
        state,
        app,
        id,
        path,
        memo,
        notebook_id,
        derived_changed,
        MemoChangeSource::UserEdit,
    );
}

/// Lightweight CAS fallback normalization.
///
/// The fast path stays byte-for-byte equality. This is only used after that
/// fails, to tolerate editor serialization noise that does not change the
/// document body meaning: CRLF/LF, frontmatter rewrite, line-end spaces, and
/// empty paragraphs represented as `&nbsp;`/NBSP.
fn normalize_markdown_for_cas(content: &str) -> String {
    let lf = content.replace("\r\n", "\n").replace('\r', "\n");
    let body = extract_body_content(&lf);
    let mut out = String::new();
    let mut pending_blank = false;
    let mut wrote_line = false;

    for raw_line in body.lines() {
        let line = raw_line.trim_end();
        let marker = line.trim();
        let is_blank = marker.is_empty() || marker == "&nbsp;" || marker == "\u{00a0}";

        if is_blank {
            pending_blank = true;
            continue;
        }

        if wrote_line {
            out.push('\n');
            if pending_blank {
                out.push('\n');
            }
        }

        out.push_str(line);
        wrote_line = true;
        pending_blank = false;
    }

    out
}

fn cas_content_matches(current: &str, expected: &str, incoming: &str) -> bool {
    if current == expected || current == incoming {
        return true;
    }

    normalize_markdown_for_cas(current) == normalize_markdown_for_cas(expected)
}

fn note_title(filename: &str) -> String {
    filename
        .strip_suffix(".md")
        .or_else(|| filename.strip_suffix(".MD"))
        .unwrap_or(filename)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::cas_content_matches;

    #[test]
    fn cas_accepts_markdown_serialization_noise() {
        let current = "---\nkey: abc123\n---\r\n\r\n# Title\r\n&nbsp;\r\nBody  \r\n";
        let expected = "---\nkey: oldkey\n---\n\n# Title\n\nBody\n";
        let incoming = "---\nkey: abc123\n---\n\n# Title\n&nbsp;\nBody\n";

        assert!(cas_content_matches(current, expected, incoming));
    }

    #[test]
    fn cas_rejects_real_body_change() {
        let current = "---\nkey: abc123\n---\n\n# Title\nChanged\n";
        let expected = "---\nkey: abc123\n---\n\n# Title\nBody\n";
        let incoming = "---\nkey: abc123\n---\n\n# Title\nBody plus local edit\n";

        assert!(!cas_content_matches(current, expected, incoming));
    }

    #[test]
    fn cas_accepts_idempotent_incoming_content() {
        let current = "# Title\n\nBody\n";
        let expected = "# Title\n\nOld body\n";
        let incoming = "# Title\n\nBody\n";

        assert!(cas_content_matches(current, expected, incoming));
    }

    #[test]
    fn cas_accepts_frontmatter_body_leading_blank_drift() {
        let current = "---\nkey: d7ngibb3\n---\n\n# 2026-07-05\n";
        let expected = "---\nkey: d7ngibb3\n---\n# 2026-07-05\n";
        let incoming = "---\nkey: d7ngibb3\n---\n\n\n# 2026-07-05\n\n你好";

        assert!(cas_content_matches(current, expected, incoming));
    }
}

// ==================== Reads ====================

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
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let memos = memo_file.read_all_memos_filtered_for_notebook_id(
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
    let notebooks = memo_file.read_notebook_configs().unwrap_or_default();

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
        for memo in memo_file.read_all_memos_filtered_for_notebook_id(
            Some(&notebook.id),
            "all",
            "updatedAt",
            None,
        ) {
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
    let notebooks = memo_file.read_notebook_configs().unwrap_or_default();

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
        for memo in memo_file.read_all_memos_for_notebook_id(Some(&notebook.id)) {
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
        read_lock(&state.memo_file, "memo_file")
            .read_tag_usage_summary_for_notebook_id(notebook_id.as_deref())
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
    read_lock(&state.memo_file, "memo_file")
        .read_todo_metadata_entries_for_notebook_id(
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
    let memo = read_lock(&state.memo_file, "memo_file").read_memo_global(&id)?;
    // Keep stale index entries from opening an empty editor when the file is gone.
    let path = read_lock(&state.memo_file, "memo_file").find_memo_file_path(&memo.id)?;
    start_security_bookmark_access(&state, &path);
    if !path.exists() {
        tracing::info!(
            "[read_memo] file gone, unregistering ghost: {}",
            path.display()
        );
        let _ = read_lock(&state.memo_file, "memo_file").delete_memo_result_global(&memo.id);
        return None;
    }
    Some(memo)
}

#[tauri::command]
pub fn read_document(file_path: String, state: State<AppState>) -> Option<String> {
    if !super::helpers::can_access_document_path(Path::new(&file_path), &state) {
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
    let configs = memo_file.read_notebook_configs().ok()?;

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
        let Some(list) = memo_file
            .read_index_for_notebook_id(Some(&cfg.id))
            .ok()
            .flatten()
        else {
            continue;
        };
        if let Some(entry) = list
            .memos
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

/// Write a document through either the memo path or an external markdown path.
///
/// `internal` resolves by globally unique memo key and may rename the file when
/// the title changes. `external` writes the provided file path directly.
/// `expectedContent` is used as a CAS guard for both channels.
#[tauri::command]
#[allow(non_snake_case)]
pub fn write_document(
    key: Option<String>,
    channel: String,
    file_path: String,
    content: String,
    expectedContent: Option<String>,
    state: State<AppState>,
    app: AppHandle,
) -> Option<WriteDocumentResult> {
    match channel.as_str() {
        "internal" => write_document_internal(
            key.as_deref(),
            &content,
            expectedContent.as_deref(),
            &state,
            &app,
        ),
        "external" => {
            write_document_external(&file_path, &content, expectedContent.as_deref(), &state)
        }
        other => {
            eprintln!("[write_document] unknown channel: {other}");
            None
        }
    }
}

/// Write a memo by global key and return the final path/content after rename.
fn write_document_internal(
    key: Option<&str>,
    content: &str,
    expected_content: Option<&str>,
    state: &State<AppState>,
    app: &AppHandle,
) -> Option<WriteDocumentResult> {
    let key = key?;
    let before = read_memo_or_none(state.inner(), key);
    if before.is_none() {
        eprintln!("[write_document_internal] memo not found: key={key}");
        return None;
    }

    // CAS: reject the write if the on-disk content has diverged from the caller.
    if let Some(expected) = expected_content {
        let current_path = match read_lock(&state.memo_file, "memo_file").find_memo_file_path(key) {
            Some(p) => p,
            None => {
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
    if let Some(path) = read_lock(&state.memo_file, "memo_file").find_memo_file_path(key) {
        start_security_bookmark_access(state.inner(), &path);
        mark_self_write_for(app, &path);
    }
    let result = read_lock(&state.memo_file, "memo_file")
        .write_memo_renaming_on_title_change_global(key, content);
    match result {
        Ok(updated) => {
            // Internal editor saves suppress their own watcher events, so this
            // path is responsible for notifying the UI with the final memo
            // metadata after preview/thumbnail/tags/todos derivation.
            // The write may rename the file, so resolve the final path after it succeeds.
            let final_path = read_lock(&state.memo_file, "memo_file")
                .find_memo_file_path(key)
                .expect("just verified memo exists");
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
            if let Err(e) = read_lock(&state.memo_file, "memo_file")
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

/// Write an external markdown file directly. This does not update memo metadata.
fn write_document_external(
    file_path: &str,
    content: &str,
    expected_content: Option<&str>,
    state: &State<AppState>,
) -> Option<WriteDocumentResult> {
    if !super::helpers::can_access_document_path(Path::new(file_path), state) {
        eprintln!(
            "[write_document_external] refused out-of-scope path: {}",
            file_path
        );
        return None;
    }
    if let Some(parent) = Path::new(file_path).parent() {
        let _ = fs::create_dir_all(parent);
    }
    let io_path = resolve_document_path_for_io(file_path, state.inner());
    start_security_bookmark_access(state.inner(), &io_path);
    if let Some(parent) = io_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    // CAS: reject the write if the file changed since the caller read it.
    if let Some(expected) = expected_content {
        match fs::read_to_string(&io_path) {
            Ok(current_content) if cas_content_matches(&current_content, expected, content) => {}
            Ok(_) => {
                eprintln!(
                    "[write_document_external] CAS refused: {} changed on disk",
                    file_path
                );
                return None;
            }
            Err(e) => {
                eprintln!(
                    "[write_document_external] Failed to verify {}: {}",
                    file_path, e
                );
                return None;
            }
        }
    }

    match atomic_write_bytes(&io_path, content.as_bytes()) {
        Ok(_) => Some(WriteDocumentResult {
            path: io_path.to_string_lossy().to_string(),
            content: content.to_string(),
        }),
        Err(e) => {
            eprintln!(
                "[write_document_external] write failed for {}: {}",
                file_path, e
            );
            None
        }
    }
}

#[tauri::command]
pub fn get_launch_open_files() -> Vec<String> {
    super::helpers::markdown_paths_from_args(std::env::args())
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

// ==================== Creates and Imports ====================

#[tauri::command]
pub fn add_document(
    tag: Option<String>,
    notebook_id: Option<String>,
    state: State<AppState>,
    app: AppHandle,
) -> Memo {
    // 1. Switch notebook context when requested.
    if let Some(ref id) = notebook_id {
        write_lock(&state.memo_file, "memo_file").set_current_notebook(Some(id.clone()));
    }

    // Create a date-title memo, optionally seeded with a tag.
    let now = chrono::Utc::now().timestamp_millis();
    let title = chrono::Local::now().format("%Y-%m-%d").to_string();
    let body = match tag.as_deref() {
        Some(t) if !t.is_empty() => format!("# {}\n#{}\n", title, t),
        _ => format!("# {}\n", title),
    };

    // Mark the expected path before create to suppress our own watcher event.
    let abs = read_lock(&state.memo_file, "memo_file").file_path_for(&format!("{}.md", title));
    mark_self_write_for(&app, &abs);

    // Create the markdown file and memo index row.
    let memo = match read_lock(&state.memo_file, "memo_file").create_memo(&title, &body, None) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[add_document] create_memo failed: {e}");
            // Return an empty memo so the IPC shape stays stable on failure.
            return Memo {
                id: String::new(),
                filename: format!("{}.md", title),
                preview: String::new(),
                thumbnail: None,
                tags: vec![],
                todos: vec![],
                agents: vec![],
                created_at: now,
                updated_at: now,
                favorited: false,
                icon: None,
                colors: vec![],
                properties: serde_json::json!({}),
            };
        }
    };

    try_index_upsert(state.inner(), &memo.id);
    // Mark the final path too, because create_memo may resolve a filename conflict.
    let real_path = read_lock(&state.memo_file, "memo_file").find_memo_file_path(&memo.id);
    if let Some(p) = real_path {
        mark_self_write_for(&app, &p);
    }
    memo_events::emit(
        &app,
        MemoEvent::Created {
            memo: memo.clone(),
            notebook_id: notebook_id_for_memo(state.inner(), &memo.id),
            derived_changed: MemoDerivedChanged::from_memos(None, &memo),
            source: MemoChangeSource::UserNew,
        },
    );
    memo
}

fn memo_template_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(USER_CONFIG_DIR_NAME).join("template"))
}

fn is_template_file(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown"))
            .unwrap_or(false)
}

fn template_name_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("Untitled")
        .to_string()
}

fn next_template_filename(dir: &Path, title: &str) -> String {
    let base = MemoFile::sanitize_memo_filename_component(title);
    let base = if base.is_empty() {
        "template".to_string()
    } else {
        base
    };

    let primary = format!("{base}.md");
    if !dir.join(&primary).exists() {
        return primary;
    }

    let mut n = 1u32;
    loop {
        let candidate = format!("{base}-{n}.md");
        if !dir.join(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

#[tauri::command]
pub fn list_memo_templates() -> Vec<MemoTemplate> {
    let Some(dir) = memo_template_dir() else {
        return vec![];
    };
    let Ok(entries) = fs::read_dir(dir) else {
        return vec![];
    };

    let mut templates: Vec<MemoTemplate> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| is_template_file(path))
        .filter_map(|path| {
            let id = path.file_name()?.to_str()?.to_string();
            Some(MemoTemplate {
                name: template_name_from_path(&path),
                id,
            })
        })
        .collect();

    templates.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
    templates
}

#[tauri::command]
pub fn save_memo_template(title: String, content: String) -> Result<MemoTemplate, String> {
    let dir = memo_template_dir().ok_or_else(|| "template directory not available".to_string())?;
    let body = extract_body_content(&content).to_string();
    let filename = next_template_filename(&dir, &title);
    let path = dir.join(&filename);

    atomic_write_bytes(&path, body.as_bytes()).map_err(|e| format!("save template failed: {e}"))?;

    Ok(MemoTemplate {
        name: template_name_from_path(&path),
        id: filename,
    })
}

#[tauri::command]
pub fn delete_memo_template(template_id: String) -> Result<bool, String> {
    let template_name = Path::new(&template_id)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid template id".to_string())?;

    if template_name != template_id {
        return Err("invalid template id".to_string());
    }

    let dir = memo_template_dir().ok_or_else(|| "template directory not available".to_string())?;
    let path = dir.join(template_name);
    if !is_template_file(&path) {
        return Ok(false);
    }

    fs::remove_file(&path).map_err(|e| format!("delete template failed: {e}"))?;
    Ok(true)
}

#[tauri::command]
pub fn create_memo_from_template(
    template_id: String,
    notebook_id: Option<String>,
    state: State<AppState>,
    app: AppHandle,
) -> Result<Memo, String> {
    let template_name = Path::new(&template_id)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid template id".to_string())?;

    if template_name != template_id {
        return Err("invalid template id".to_string());
    }

    let dir = memo_template_dir().ok_or_else(|| "template directory not available".to_string())?;
    let path = dir.join(template_name);
    if !is_template_file(&path) {
        return Err("template not found".to_string());
    }

    if let Some(ref id) = notebook_id {
        write_lock(&state.memo_file, "memo_file").set_current_notebook(Some(id.clone()));
    }

    let content = fs::read_to_string(&path).map_err(|e| format!("read template failed: {e}"))?;
    let body = extract_body_content(&content).to_string();
    let title = template_name_from_path(&path);

    let abs = read_lock(&state.memo_file, "memo_file").file_path_for(&format!("{}.md", title));
    mark_self_write_for(&app, &abs);

    let memo = read_lock(&state.memo_file, "memo_file")
        .create_memo(&title, &body, None)
        .map_err(|e| format!("create memo from template failed: {e}"))?;

    try_index_upsert(state.inner(), &memo.id);
    if let Some(real_path) = read_lock(&state.memo_file, "memo_file").find_memo_file_path(&memo.id)
    {
        mark_self_write_for(&app, &real_path);
    }
    memo_events::emit(
        &app,
        MemoEvent::Created {
            memo: memo.clone(),
            notebook_id: notebook_id_for_memo(state.inner(), &memo.id),
            derived_changed: MemoDerivedChanged::from_memos(None, &memo),
            source: MemoChangeSource::UserNew,
        },
    );

    Ok(memo)
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn import_external_document_to_memo(
    file_path: String,
    content: String,
    notebook_id: Option<String>,
    state: State<AppState>,
    app: AppHandle,
) -> Result<Memo, String> {
    // Switch notebook context when requested.
    if let Some(ref id) = notebook_id {
        write_lock(&state.memo_file, "memo_file").set_current_notebook(Some(id.clone()));
    }

    let abs = std::path::PathBuf::from(&file_path);

    // Import by creating a normal memo from the external file stem and content.
    let title = std::path::Path::new(&file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("imported")
        .to_string();
    let body = if content.is_empty() {
        String::new()
    } else {
        content.clone()
    };

    // Mark the likely new path before writing.
    let mf = read_lock(&state.memo_file, "memo_file");
    let base = mf.get_memo_base();
    let candidate = flowix_core::memo_file::base_filename(&title);
    // Mirror create_memo's filename conflict rules before marking the path.
    let occupied: Vec<String> = mf
        .read_index()
        .map(|l| l.memos.into_iter().map(|e| e.filename).collect())
        .unwrap_or_default();
    let filename = flowix_core::memo_file::resolve_filename_conflict(&base, &candidate, &occupied);
    let abs_new = base.join(&filename);
    mark_self_write_for(&app, &abs_new);

    let memo = mf
        .create_memo(&title, &body, None)
        .map_err(|e| format!("create_memo failed: {e}"))?;
    drop(mf);

    try_index_upsert(state.inner(), &memo.id);
    let _ = abs;
    memo_events::emit(
        &app,
        MemoEvent::Created {
            memo: memo.clone(),
            notebook_id: notebook_id_for_memo(state.inner(), &memo.id),
            derived_changed: MemoDerivedChanged::from_memos(None, &memo),
            source: MemoChangeSource::UserImport,
        },
    );
    Ok(memo)
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn update_memo_db(
    id: String,
    content: Option<String>,
    filename: Option<String>,
    preview: Option<String>,
    defer_rename: Option<bool>,
    state: State<AppState>,
    app: AppHandle,
) -> bool {
    let defer_rename = defer_rename.unwrap_or(true);

    let memo_file = read_lock(&state.memo_file, "memo_file");
    let Some(current) = memo_file.read_memo_global(&id) else {
        return false;
    };

    if defer_rename {
        // Metadata-only update: sync index.db without touching the markdown file.
        let mut updated = current.clone();
        if let Some(f) = filename {
            updated.filename = f;
        }
        if let Some(p) = preview {
            updated.preview = p;
        }
        // Derive preview/tags/todos from provided content when available.
        if let Some(ref body) = content {
            use flowix_core::memo_file::apply_derived_memo_fields;
            apply_derived_memo_fields(&mut updated, body);
        }
        updated.updated_at = chrono::Utc::now().timestamp_millis();
        let ok = memo_file.sync_metadata_only_global(&updated).is_ok();
        drop(memo_file);
        if ok {
            let path = abs_path_for(state.inner(), &id);
            let notebook_id = notebook_id_for_memo(state.inner(), &id);
            let derived_changed = MemoDerivedChanged::from_memos(Some(&current), &updated);
            emit_updated_memo_event(
                state.inner(),
                &app,
                &id,
                path,
                updated,
                notebook_id,
                derived_changed,
                MemoChangeSource::UserEdit,
            );
        }
        return ok;
    }

    // Non-deferred path renames the memo file by title.
    drop(memo_file);
    if let Some(new_title) = filename {
        let new_title = new_title.trim_end_matches(".md").to_string();
        let mf = read_lock(&state.memo_file, "memo_file");
        match mf.rename_memo(&id, &new_title) {
            Ok(_) => {
                drop(mf);
                if let Some(body) = content {
                    let _ = read_lock(&state.memo_file, "memo_file").write_memo(&id, &body);
                }
                emit_updated_after_write(state.inner(), &app, &id, Some(current));
                return true;
            }
            Err(e) => {
                eprintln!("[update_memo_db] rename_memo failed: {e}");
                return false;
            }
        }
    }
    // 濞?content 闁哄洤鐡ㄩ弻?    if let Some(body) = content {
    if let Some(body) = content {
        match read_lock(&state.memo_file, "memo_file").write_memo(&id, &body) {
            Ok(_) => {
                emit_updated_after_write(state.inner(), &app, &id, Some(current));
                return true;
            }
            Err(e) => {
                eprintln!("[update_memo_db] write_memo failed: {e}");
                return false;
            }
        }
    }
    // 濞?metadata
    if preview.is_some() {
        let mut updated = current;
        if let Some(p) = preview {
            updated.preview = p;
        }
        updated.updated_at = chrono::Utc::now().timestamp_millis();
        return state
            .memo_file
            .read()
            .unwrap()
            .sync_metadata_only_global(&updated)
            .is_ok();
    }
    false
}

#[tauri::command]
pub fn finalize_memo_filename(id: String, state: State<AppState>, app: AppHandle) -> bool {
    // Filename finalization is handled by write/update paths; keep this as a no-op IPC.
    let _ = (id, state, app);
    true
}

#[tauri::command]
pub fn favorite_memo(id: String, state: State<AppState>, app: AppHandle) -> bool {
    let Some(mut memo) = read_memo_or_none(state.inner(), &id) else {
        return false;
    };
    let before = memo.clone();
    memo.favorited = true;
    memo.updated_at = chrono::Utc::now().timestamp_millis();
    if read_lock(&state.memo_file, "memo_file")
        .sync_metadata_only_global(&memo)
        .is_err()
    {
        return false;
    }
    emit_updated_after_write(state.inner(), &app, &id, Some(before));
    true
}

#[tauri::command]
pub fn unfavorite_memo(id: String, state: State<AppState>, app: AppHandle) -> bool {
    let Some(mut memo) = read_memo_or_none(state.inner(), &id) else {
        return false;
    };
    let before = memo.clone();
    memo.favorited = false;
    memo.updated_at = chrono::Utc::now().timestamp_millis();
    if state
        .memo_file
        .read()
        .unwrap()
        .sync_metadata_only_global(&memo)
        .is_err()
    {
        return false;
    }
    emit_updated_after_write(state.inner(), &app, &id, Some(before));
    true
}

#[tauri::command]
pub fn set_memo_colors(
    id: String,
    colors: Vec<MemoColor>,
    state: State<AppState>,
    app: AppHandle,
) -> bool {
    let Some(mut memo) = read_memo_or_none(state.inner(), &id) else {
        return false;
    };
    let before = memo.clone();
    memo.colors = colors;
    memo.updated_at = chrono::Utc::now().timestamp_millis();
    if state
        .memo_file
        .read()
        .unwrap()
        .sync_metadata_only_global(&memo)
        .is_err()
    {
        return false;
    }
    emit_updated_after_write(state.inner(), &app, &id, Some(before));
    true
}

// ==================== 閻楀牊婀?====================

#[tauri::command]
pub fn list_memo_versions(id: String, state: State<AppState>) -> Vec<MemoVersionMeta> {
    read_lock(&state.memo_file, "memo_file").list_memo_versions(&id)
}

#[tauri::command]
pub fn read_memo_version(id: String, version_id: String, state: State<AppState>) -> Option<String> {
    read_lock(&state.memo_file, "memo_file").read_memo_version(&id, &version_id)
}

#[tauri::command]
pub fn create_memo_version(
    id: String,
    source: Option<MemoVersionSource>,
    state: State<AppState>,
) -> Option<MemoVersionMeta> {
    let path = read_lock(&state.memo_file, "memo_file").find_memo_file_path(&id)?;
    start_security_bookmark_access(&state, &path);
    let content = fs::read_to_string(path).ok()?;
    match read_lock(&state.memo_file, "memo_file").create_memo_version(
        &id,
        &content,
        source.unwrap_or(MemoVersionSource::Manual),
    ) {
        Ok(version) => version,
        Err(e) => {
            eprintln!("[create_memo_version] failed for {id}: {e}");
            None
        }
    }
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn restore_memo_version(
    id: String,
    version_id: String,
    expectedContent: Option<String>,
    state: State<AppState>,
    app: AppHandle,
) -> Option<WriteDocumentResult> {
    let target_content =
        read_lock(&state.memo_file, "memo_file").read_memo_version(&id, &version_id)?;
    let before = read_memo_or_none(state.inner(), &id);
    let current_path = read_lock(&state.memo_file, "memo_file").find_memo_file_path(&id)?;
    start_security_bookmark_access(&state, &current_path);
    let current_content = fs::read_to_string(&current_path).ok()?;

    if let Some(expected) = expectedContent.as_deref() {
        if !cas_content_matches(&current_content, expected, &target_content) {
            eprintln!(
                "[restore_memo_version] CAS refused: key={} disk != expected",
                id
            );
            return None;
        }
    }

    if let Err(e) = read_lock(&state.memo_file, "memo_file").create_memo_version(
        &id,
        &current_content,
        MemoVersionSource::RestoreBackup,
    ) {
        eprintln!("[restore_memo_version] backup version failed for {id}: {e}");
        return None;
    }

    mark_self_write_for(&app, &current_path);
    match read_lock(&state.memo_file, "memo_file")
        .write_memo_renaming_on_title_change_global(&id, &target_content)
    {
        Ok(_) => {
            emit_updated_after_write(state.inner(), &app, &id, before);
            let final_path = read_lock(&state.memo_file, "memo_file").find_memo_file_path(&id)?;
            start_security_bookmark_access(&state, &final_path);
            let final_content = fs::read_to_string(&final_path).ok()?;
            Some(WriteDocumentResult {
                path: final_path.to_string_lossy().to_string(),
                content: final_content,
            })
        }
        Err(e) => {
            eprintln!("[restore_memo_version] restore failed for {id}: {e}");
            None
        }
    }
}

#[tauri::command]
pub fn delete_memo_version(id: String, version_id: String, state: State<AppState>) -> bool {
    read_lock(&state.memo_file, "memo_file").delete_memo_version(&id, &version_id)
}

// ==================== Deletes ====================

#[tauri::command]
pub fn delete_memo(id: String, state: State<AppState>, app: AppHandle) -> bool {
    try_index_remove(state.inner(), &id);
    let before = read_memo_or_none(state.inner(), &id);
    let notebook_id = notebook_id_for_memo(state.inner(), &id);
    let abs_path = abs_path_for(state.inner(), &id);
    // Mark before deleting so the watcher suppresses our own remove event.
    if !abs_path.is_empty() {
        mark_self_write_for(&app, Path::new(&abs_path));
    }
    let ok = read_lock(&state.memo_file, "memo_file")
        .delete_memo_result_global(&id)
        .unwrap_or(false);
    if ok {
        let derived_changed = before
            .as_ref()
            .map(MemoDerivedChanged::from_deleted)
            .unwrap_or_default();
        memo_events::emit(
            &app,
            MemoEvent::Deleted {
                id,
                path: abs_path,
                notebook_id,
                derived_changed,
            },
        );
    }
    ok
}

#[tauri::command]
pub fn clear_memos(notebook_id: Option<String>, state: State<AppState>, app: AppHandle) -> bool {
    let mut deleted_paths: Vec<(String, String, String, MemoDerivedChanged)> = Vec::new();
    let success = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let memos = memo_file.read_all_memos_filtered_for_notebook_id(
            notebook_id.as_deref(),
            "all",
            "createdAt",
            None,
        );
        drop(memo_file);
        let mut success = true;
        for memo in memos {
            let abs_path = {
                let mf = read_lock(&state.memo_file, "memo_file");
                mf.find_memo_file_path(&memo.id)
                    .map(|p| p.display().to_string())
                    .unwrap_or_default()
            };
            if !abs_path.is_empty() {
                mark_self_write_for(&app, Path::new(&abs_path));
            }
            if !read_lock(&state.memo_file, "memo_file")
                .delete_memo_result_global(&memo.id)
                .unwrap_or(false)
            {
                success = false;
                continue;
            }
            let deleted_notebook_id = notebook_id
                .clone()
                .unwrap_or_else(|| notebook_id_for_memo(state.inner(), &memo.id));
            let derived_changed = MemoDerivedChanged::from_deleted(&memo);
            deleted_paths.push((memo.id, abs_path, deleted_notebook_id, derived_changed));
        }
        success
    };
    if success {
        force_rebuild_index(state.inner(), &app);
    }
    for (id, path, notebook_id, derived_changed) in &deleted_paths {
        memo_events::emit(
            &app,
            MemoEvent::Deleted {
                id: id.clone(),
                path: path.clone(),
                notebook_id: notebook_id.clone(),
                derived_changed: derived_changed.clone(),
            },
        );
    }
    success
}
