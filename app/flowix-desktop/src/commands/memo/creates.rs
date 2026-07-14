// ==================== Creates and Imports ====================
//
// Covers four related concerns that all share the same write pipeline:
//   - new memo creation (add_document)
//   - external document import (import_external_document_to_memo)
//   - memo templates (list / save / delete / create-from)
//   - single-field metadata updates (favorite / unfavorite / set_colors /
//     finalize_filename)
// These were grouped as one section in the original memo.rs because they all
// go through `sync_metadata_only_global` + `emit_updated_after_write`; the
// helpers handle the disk/index/event fan-out.

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

use super::AppState;
use crate::commands::helpers::{
    force_rebuild_index, mark_self_write_for, rebuild_index_in_background,
    start_security_bookmark_access, synthesize_minimal_memo, try_index_remove, try_index_upsert,
};

use super::*;

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
