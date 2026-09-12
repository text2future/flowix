// ==================== Creates and Imports ====================
//
// Covers four related concerns that all share the same write pipeline:
//   - new memo creation (add_document)
//   - external document import (import_external_document_to_memo)
//   - memo templates (list / save / delete / create-from)
//   - single-field metadata updates (favorite / unfavorite / set_colors)
// These were grouped as one section in the original memo.rs because they all
// go through `sync_metadata_only_global` + `emit_updated_after_write`; the
// helpers handle the disk/index/event fan-out.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};

use crate::lock_utils::read_lock;
use crate::memo_events::{self, MemoChangeSource, MemoDerivedChanged, MemoEvent};
use crate::USER_CONFIG_DIR_NAME;
use flowix_core::memo_file::{atomic_write_bytes, extract_body_content, Memo, MemoColor, MemoFile};
use flowix_core::MemoService;

use crate::app::search_index::try_index_upsert;
use crate::app::state::AppState;
use crate::watcher::runtime::mark_self_write_for;

use super::helpers::*;
use super::*;

#[tauri::command]
pub fn add_document(
    tag: Option<String>,
    notebook_id: Option<String>,
    parent_relative_path: Option<String>,
    state: State<AppState>,
    app: AppHandle,
) -> Memo {
    // Create a date-title memo. The selected tag is persisted in YAML
    // frontmatter; body #tag tokens are references only.
    let now = chrono::Utc::now().timestamp_millis();
    let title = chrono::Local::now().format("%Y-%m-%d").to_string();
    // The filename is the note title. Keep it outside Markdown so a new note
    // starts with an empty editable body (apart from system frontmatter).
    let body = String::new();

    // Mark the expected path before create to suppress our own watcher event.
    let abs = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .preview_create_path_in_directory(
            notebook_id.as_deref(),
            parent_relative_path.as_deref(),
            &title,
        )
        .unwrap_or_default();
    mark_self_write_for(&app, &abs);

    // Create the markdown file and memo index row.
    let memo = match MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .create_memo_named_with_tag_in_directory(
            notebook_id.as_deref(),
            parent_relative_path.as_deref(),
            &title,
            &body,
            tag.as_deref().filter(|value| !value.trim().is_empty()),
        ) {
        Ok(created) => created.memo,
        Err(e) => {
            eprintln!("[add_document] create_memo failed: {e}");
            // Return an empty memo so the IPC shape stays stable on failure.
            return Memo {
                id: String::new(),
                filename: format!("{}.md", title),
                relative_path: format!("{}.md", title),
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
    if let Ok(resolved) =
        MemoService::new(&read_lock(&state.memo_file, "memo_file")).resolve_memo(&memo.id)
    {
        mark_self_write_for(&app, &resolved.path);
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

    let content = fs::read_to_string(&path).map_err(|e| format!("read template failed: {e}"))?;
    let body = extract_body_content(&content).to_string();
    let title = template_name_from_path(&path);

    let abs = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .preview_create_path(notebook_id.as_deref(), &title)
        .map_err(|e| format!("prepare memo from template failed: {e}"))?;
    mark_self_write_for(&app, &abs);

    let memo = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .create_memo_named(notebook_id.as_deref(), &title, &body)
        .map_err(|e| format!("create memo from template failed: {e}"))?
        .memo;

    try_index_upsert(state.inner(), &memo.id);
    if let Ok(resolved) =
        MemoService::new(&read_lock(&state.memo_file, "memo_file")).resolve_memo(&memo.id)
    {
        mark_self_write_for(&app, &resolved.path);
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
    let abs_new = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .preview_create_path(notebook_id.as_deref(), &title)
        .map_err(|e| format!("prepare imported memo failed: {e}"))?;
    mark_self_write_for(&app, &abs_new);

    let memo = MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .create_memo_named(notebook_id.as_deref(), &title, &body)
        .map_err(|e| format!("create_memo failed: {e}"))?
        .memo;

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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameMemoTitleResult {
    pub memo: Memo,
    pub old_path: String,
    pub path: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveMemoResult {
    pub memo: Memo,
    pub old_path: String,
    pub path: String,
}

/// Move a memo to an existing directory in its notebook while preserving its id.
#[tauri::command]
pub fn move_memo_to_directory(
    id: String,
    notebook_id: String,
    parent_relative_path: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<MoveMemoResult, String> {
    let before =
        read_memo_or_none(state.inner(), &id).ok_or_else(|| format!("memo not found: {id}"))?;
    let (old_path, edited) = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let mut service = MemoService::new(&memo_file);
        let old_path = service
            .resolve_memo(&id)
            .map_err(|error| error.to_string())?
            .path;
        mark_self_write_for(&app, &old_path);
        let edited = service
            .move_memo_to_directory(&id, &notebook_id, &parent_relative_path)
            .map_err(|error| error.to_string())?;
        (old_path, edited)
    };
    let memo = edited
        .memo
        .ok_or_else(|| "move completed without memo metadata".to_string())?;
    mark_self_write_for(&app, &edited.path);
    let notebook_id = notebook_id_for_memo(state.inner(), &id);
    let derived_changed = MemoDerivedChanged::from_memos(Some(&before), &memo);
    emit_updated_memo_event(
        state.inner(),
        &app,
        &id,
        edited.path.to_string_lossy().into_owned(),
        memo.clone(),
        notebook_id,
        derived_changed,
        MemoChangeSource::UserEdit,
        None,
    );
    Ok(MoveMemoResult {
        memo,
        old_path: old_path.to_string_lossy().into_owned(),
        path: edited.path.to_string_lossy().into_owned(),
    })
}

/// Rename a memo independently from its Markdown content.
#[tauri::command]
pub fn rename_memo_title(
    id: String,
    title: String,
    expected_filename: Option<String>,
    state: State<AppState>,
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<RenameMemoTitleResult, String> {
    let title = title.trim().trim_end_matches(".md").trim();
    if title.is_empty() {
        return Err("memo title cannot be empty".to_string());
    }

    let memo_file = read_lock(&state.memo_file, "memo_file");
    let mut service = MemoService::new(&memo_file);
    let before = service
        .memo_metadata(&id)
        .map_err(|error| error.to_string())?;
    let resolved = service
        .resolve_memo(&id)
        .map_err(|error| error.to_string())?;
    let old_path = resolved.path.to_string_lossy().into_owned();
    mark_self_write_for(&app, &resolved.path);
    let edited = service
        .rename_memo_with_validation(&id, title, |resolved| {
            if expected_filename
                .as_deref()
                .is_some_and(|expected| expected != resolved.entry.filename)
            {
                return Err(flowix_core::FlowixError::Conflict(
                    "memo filename changed before rename".to_string(),
                ));
            }
            Ok(())
        })
        .map_err(|error| error.to_string())?;
    let memo = edited
        .memo
        .ok_or_else(|| "rename completed without memo metadata".to_string())?;
    let path = edited.path.to_string_lossy().into_owned();
    mark_self_write_for(&app, &edited.path);
    let notebook_id = notebook_id_for_memo(state.inner(), &id);
    let derived_changed = MemoDerivedChanged::from_memos(Some(&before), &memo);
    drop(service);
    drop(memo_file);
    emit_updated_memo_event(
        state.inner(),
        &app,
        &id,
        path.clone(),
        memo.clone(),
        notebook_id,
        derived_changed,
        MemoChangeSource::UserEdit,
        Some(window.label()),
    );

    Ok(RenameMemoTitleResult {
        memo,
        old_path,
        path,
    })
}

#[tauri::command]
pub fn favorite_memo(id: String, state: State<AppState>, app: AppHandle) -> bool {
    let Some(mut memo) = read_memo_or_none(state.inner(), &id) else {
        return false;
    };
    let before = memo.clone();
    memo.favorited = true;
    memo.updated_at = chrono::Utc::now().timestamp_millis();
    if let Some(path) = read_lock(&state.memo_file, "memo_file").find_memo_file_path(&id) {
        mark_self_write_for(&app, &path);
    }
    if MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .sync_memo_metadata(&memo)
        .is_err()
    {
        return false;
    }
    let _ = emit_updated_after_write(state.inner(), &app, &id, Some(before), None);
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
    if let Some(path) = read_lock(&state.memo_file, "memo_file").find_memo_file_path(&id) {
        mark_self_write_for(&app, &path);
    }
    if MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .sync_memo_metadata(&memo)
        .is_err()
    {
        return false;
    }
    let _ = emit_updated_after_write(state.inner(), &app, &id, Some(before), None);
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
    if let Some(path) = read_lock(&state.memo_file, "memo_file").find_memo_file_path(&id) {
        mark_self_write_for(&app, &path);
    }
    if MemoService::new(&read_lock(&state.memo_file, "memo_file"))
        .sync_memo_metadata(&memo)
        .is_err()
    {
        return false;
    }
    let _ = emit_updated_after_write(state.inner(), &app, &id, Some(before), None);
    true
}
