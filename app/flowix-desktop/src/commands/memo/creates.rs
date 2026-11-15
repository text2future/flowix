// ==================== Creates and Imports ====================
//
// Covers note creation, import, memo templates, and path-based moves:
//   - path-based note creation and import
//   - memo templates (list / save / delete / create-from)
// Metadata controls write the document YAML through the frontend save queue.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State};

use crate::commands::helpers::FileOperationFailure;
use crate::lock_utils::read_lock;
use crate::USER_CONFIG_DIR_NAME;
use flowix_core::memo_file::{atomic_write_bytes, extract_body_content, MemoFile};
use flowix_core::NoteService;

use crate::app::state::AppState;
use crate::template_store;
use crate::watcher::runtime::{mark_self_create_dir_for, mark_self_write_for};

use super::helpers::*;
use super::*;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HtmlCreateReceipt {
    fingerprint: String,
    relative_path: String,
    complete: bool,
}

/// Create a page-submitted note with a durable request receipt. A pending
/// receipt with no matching file is deliberately not retried automatically:
/// the result could have been moved or deleted after a process interruption.
#[tauri::command]
pub async fn create_html_note(
    notebook_id: String,
    page_path: String,
    parent_relative_path: String,
    content: String,
    client_request_id: String,
    images: Option<Vec<String>>,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    if content.trim().is_empty() || content.len() > 64 * 1024
        || client_request_id.len() < 16 || client_request_id.len() > 128
        || !client_request_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("INVALID_INPUT".into());
    }
    let images = images.unwrap_or_default();
    if images.len() > 20 { return Err("INVALID_IMAGES".into()); }
    let origin_window_label = window.label().to_string();
    crate::document_io::run("create_html_note", move || {
        use fs2::FileExt;
        use std::io::Write;
        use std::path::Component;
        let state = app.state::<AppState>();
        let memo = read_lock(&state.memo_file, "memo_file");
        let notebook = memo.get_notebook_config_by_id(&notebook_id).ok_or("NOTEBOOK_NOT_FOUND")?;
        let root = fs::canonicalize(&notebook.path).map_err(|e| e.to_string())?;
        let page = fs::canonicalize(&page_path).map_err(|e| e.to_string())?;
        if !page.starts_with(&root) || !page.is_file() { return Err("INVALID_PAGE".to_string()); }
        let relative = Path::new(&parent_relative_path);
        if !parent_relative_path.is_empty() && (parent_relative_path.len() > 4096 || parent_relative_path.contains('\\')
            || relative.components().any(|part| !matches!(part, Component::Normal(_)))
            || relative.components().next().is_some_and(|part| part.as_os_str() == ".flowix")) {
            return Err("INVALID_FOLDER".to_string());
        }
        let mut folder = root.clone();
        for part in relative.components() {
            folder.push(part.as_os_str());
            let meta = fs::symlink_metadata(&folder).map_err(|e| e.to_string())?;
            if !meta.is_dir() || meta.file_type().is_symlink() { return Err("INVALID_FOLDER".to_string()); }
        }
        if !folder.starts_with(&root) || flowix_core::memo_file::FileManagementPolicy::from_notebook_root(&root).is_index_hidden_at(&root, relative) {
            return Err("INVALID_FOLDER".to_string());
        }
        let mut unique = std::collections::HashSet::new();
        for image in &images {
            let path = Path::new(image);
            if image.len() > 4096 || image.contains('\\') || !image.starts_with("attachments/")
                || path.components().any(|part| !matches!(part, Component::Normal(_)))
                || !unique.insert(image) { return Err("INVALID_IMAGES".into()); }
            let extension = path.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
            if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif" | "tif" | "tiff" | "heic" | "heif") { return Err("INVALID_IMAGES".into()); }
            let target = fs::canonicalize(root.join(path)).map_err(|_| "INVALID_IMAGES")?;
            let attachments = fs::canonicalize(root.join("attachments")).map_err(|_| "INVALID_IMAGES")?;
            if !attachments.starts_with(&root) || !target.starts_with(&attachments) || !target.is_file() { return Err("INVALID_IMAGES".into()); }
        }
        let final_content = if images.is_empty() { content.clone() } else {
            use serde_yaml::{Mapping, Value};
            let normalized = content.replace("\r\n", "\n");
            let (mut frontmatter, body) = if let Some(rest) = normalized.strip_prefix("---\n") {
                let end = rest.find("\n---\n").ok_or("INVALID_FRONTMATTER")?;
                let parsed: Value = serde_yaml::from_str(&rest[..end]).map_err(|_| "INVALID_FRONTMATTER")?;
                let map = match parsed { Value::Mapping(map) => map, Value::Null => Mapping::new(), _ => return Err("INVALID_FRONTMATTER".into()) };
                (map, &rest[end + 5..])
            } else { (Mapping::new(), normalized.as_str()) };
            let key = Value::String("images".into());
            let mut all = match frontmatter.remove(&key) {
                None | Some(Value::Null) => Vec::new(),
                Some(Value::String(value)) => vec![Value::String(value)],
                Some(Value::Sequence(values)) if values.iter().all(|value| value.is_string()) => values,
                _ => return Err("INVALID_IMAGES".into()),
            };
            for image in &images { let value = Value::String(image.clone()); if !all.contains(&value) { all.push(value); } }
            frontmatter.insert(key, Value::Sequence(all));
            let types_key = Value::String("flowix_property_types".into());
            let mut types = match frontmatter.remove(&types_key) { None | Some(Value::Null) => Mapping::new(), Some(Value::Mapping(map)) => map, _ => return Err("INVALID_FRONTMATTER".into()) };
            types.insert(Value::String("images".into()), Value::String("Image".into()));
            frontmatter.insert(types_key, Value::Mapping(types));
            let yaml = serde_yaml::to_string(&frontmatter).map_err(|e| e.to_string())?;
            format!("---\n{}---\n{}", yaml, body)
        };
        let hash = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
        let key = hash(format!("{}\0{}\0{}", notebook_id, page.display(), client_request_id).as_bytes());
        let fingerprint = if images.is_empty() { hash(format!("{}\0{}", parent_relative_path, content).as_bytes()) } else { hash(format!("{}\0{}\0{}", parent_relative_path, content, serde_json::to_string(&images).map_err(|e| e.to_string())?).as_bytes()) };
        let receipt_dir = dirs::home_dir().ok_or("HOME_UNAVAILABLE")?.join(".flowix").join("html-create-receipts");
        fs::create_dir_all(&receipt_dir).map_err(|e| e.to_string())?;
        let lock_path = receipt_dir.join(format!("{key}.lock"));
        let lock = fs::OpenOptions::new().read(true).write(true).create(true).open(lock_path).map_err(|e| e.to_string())?;
        lock.lock_exclusive().map_err(|e| e.to_string())?;
        let receipt_path = receipt_dir.join(format!("{key}.json"));
        let existing = match fs::read(&receipt_path) {
            Ok(data) => Some(serde_json::from_slice::<HtmlCreateReceipt>(&data).map_err(|e| e.to_string())?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        if let Some(receipt) = existing.as_ref() {
            if receipt.fingerprint != fingerprint { return Err("REQUEST_ID_CONFLICT".into()); }
            if receipt.complete { return Ok(receipt.relative_path.clone()); }
            let path = root.join(&receipt.relative_path);
            let metadata = fs::symlink_metadata(&path).map_err(|_| "CREATE_RESULT_UNKNOWN".to_string())?;
            if !metadata.is_file() || metadata.file_type().is_symlink()
                || fs::read(&path).map_err(|e| e.to_string())? != final_content.as_bytes() {
                return Err("CREATE_RESULT_UNKNOWN".to_string());
            }
        }
        // Serialize HTML submissions to the same folder while choosing a free
        // readable filename and recording it in the request receipt.
        let folder_key = hash(format!("{}\0{}", notebook_id, parent_relative_path).as_bytes());
        let folder_lock = fs::OpenOptions::new().read(true).write(true).create(true)
            .open(receipt_dir.join(format!("folder-{folder_key}.lock"))).map_err(|e| e.to_string())?;
        folder_lock.lock_exclusive().map_err(|e| e.to_string())?;
        let relative_path = existing.as_ref().map(|r| r.relative_path.clone()).unwrap_or_else(|| {
            let first_line: String = content.lines().map(str::trim).find(|line| !line.is_empty())
                .unwrap_or("记录").chars().take(100).map(|ch| if ch.is_control() { ' ' } else { ch }).collect();
            let sanitized = MemoFile::sanitize_memo_filename_component(&first_line);
            // A single filename component is commonly limited to 255 UTF-8
            // bytes. Leave space for the extension and any conflict suffix.
            let mut base = String::new();
            for ch in sanitized.chars() {
                if base.len() + ch.len_utf8() > 220 { break; }
                base.push(ch);
            }
            let base = base.trim_matches(|ch: char| ch == ' ' || ch == '.');
            let base = if base.is_empty() { "记录" } else { base };
            let windows_stem = base.split('.').next().unwrap_or("").to_ascii_uppercase();
            let reserved = matches!(windows_stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || (windows_stem.len() == 4 && (windows_stem.starts_with("COM") || windows_stem.starts_with("LPT"))
                    && matches!(windows_stem.as_bytes()[3], b'1'..=b'9'));
            let safe_base = if reserved { format!("{base}_") } else { base.to_string() };
            let filename = flowix_core::memo_file::resolve_filename_conflict(&folder, &safe_base, &[]);
            if parent_relative_path.is_empty() { filename } else { format!("{parent_relative_path}/{filename}") }
        });
        if existing.is_none() {
            let receipt = HtmlCreateReceipt { fingerprint: fingerprint.clone(), relative_path: relative_path.clone(), complete: false };
            let bytes = serde_json::to_vec(&receipt).map_err(|e| e.to_string())?;
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&receipt_path).map_err(|e| e.to_string())?;
            file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
            memo.create_file_for_notebook(&notebook_id, &root.join(&relative_path), final_content.as_bytes()).map_err(|e| e.to_string())?;
        }
        memo.refresh_note_path_after_write(&notebook_id, &relative_path);
        mark_self_write_for(&app, &root.join(&relative_path));
        let receipt = HtmlCreateReceipt { fingerprint, relative_path: relative_path.clone(), complete: true };
        flowix_core::memo_file::atomic_write_bytes(&receipt_path, &serde_json::to_vec(&receipt).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        crate::events::path_change::NotebookPathCreated::from_window(notebook_id, relative_path.clone(), origin_window_label).emit(&app);
        Ok(relative_path)
    }).await.map_err(|e| e.to_string())?
}

/// Stable path-document creation error.
#[derive(Debug, serde::Serialize)]
pub struct MemoCreateError {
    code: &'static str,
    message: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedPathDocumentResult {
    notebook_id: String,
    relative_path: String,
    path: String,
    initial_content: String,
    entry: flowix_core::memo_file::NoteEntry,
    notebook_change: crate::events::path_change::NotebookPathCreated,
}

impl CreatedPathDocumentResult {
    fn publish_created(&self, app: &AppHandle) {
        self.notebook_change.emit(app);
    }
}

fn default_parent_relative_path(
    memo_file: &MemoFile,
    notebook_id: &str,
) -> Result<Option<String>, flowix_core::FlowixError> {
    let Some(notebook) = memo_file.get_notebook_config_by_id(notebook_id) else {
        return Ok(None);
    };
    crate::commands::file::default_create_folder_for_notebook(Path::new(&notebook.path))
        .map_err(flowix_core::FlowixError::InvalidInput)
}

/// Resolve the directory a create command is about to write into, so the
/// watcher can treat the following native create as a product creation.
fn create_target_dir(
    memo_file: &MemoFile,
    notebook_id: &str,
    parent: Option<&str>,
) -> Option<PathBuf> {
    let root = memo_file
        .get_notebook_config_by_id(notebook_id)
        .map(|notebook| PathBuf::from(&notebook.path))?;
    Some(match parent {
        Some(parent) if !parent.is_empty() => root.join(parent),
        _ => root,
    })
}

#[tauri::command]
pub async fn add_path_document(
    tag: Option<String>,
    title: Option<String>,
    notebook_id: String,
    // None uses the notebook's default create folder; Some("") explicitly uses its root.
    parent_relative_path: Option<String>,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<CreatedPathDocumentResult, MemoCreateError> {
    let origin_window_label = window.label().to_string();
    let title = title
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());
    crate::document_io::run("create_path_document", move || {
        let state = app.state::<AppState>();
        let body = match tag.as_deref() {
            Some(tag) => {
                flowix_core::memo_file::replace_frontmatter_tags("", &[tag.to_string()])
                    .map_err(|error| flowix_core::FlowixError::InvalidInput(error.to_string()))?
            }
            None => String::new(),
        };
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let effective_parent = match parent_relative_path {
            Some(parent) => Some(parent),
            None => default_parent_relative_path(&memo_file, &notebook_id)?,
        };
        if let Some(dir) = create_target_dir(&memo_file, &notebook_id, effective_parent.as_deref())
        {
            mark_self_create_dir_for(&app, &dir);
        }
        let created = NoteService::new(&memo_file).create(
            &notebook_id,
            effective_parent.as_deref(),
            &title,
            &body,
        )?;
        mark_self_write_for(&app, &created.path);
        let notebook_change = crate::events::path_change::NotebookPathCreated::from_window(
            created.notebook.id.clone(),
            created.entry.relative_path.clone(),
            origin_window_label,
        );
        let result = CreatedPathDocumentResult {
            notebook_id: created.notebook.id,
            relative_path: created.entry.relative_path.clone(),
            path: created.path.to_string_lossy().to_string(),
            initial_content: created.body,
            entry: created.entry,
            notebook_change,
        };
        result.publish_created(&app);
        Ok::<_, MemoCreateError>(result)
    })
    .await
    .map_err(|message| MemoCreateError {
        code: "INTERNAL_ERROR",
        message,
    })?
}

impl From<flowix_core::FlowixError> for MemoCreateError {
    fn from(error: flowix_core::FlowixError) -> Self {
        use flowix_core::FlowixError;
        let code = match &error {
            FlowixError::InvalidInput(_) => "INVALID_INPUT",
            FlowixError::NotFound(_) => "NOT_FOUND",
            FlowixError::Conflict(_) => "CONFLICT",
            FlowixError::PermissionDenied(_) => "PERMISSION_DENIED",
            FlowixError::Io(_) => "IO_ERROR",
            FlowixError::CorruptData(_) => "CORRUPT_DATA",
            FlowixError::Internal(_) => "INTERNAL_ERROR",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

fn memo_template_dir() -> Option<PathBuf> {
    dirs::home_dir()
        .map(|home| template_store::notes_templates_dir(&home.join(USER_CONFIG_DIR_NAME)))
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
    fs::create_dir_all(&dir)
        .map_err(|error| format!("create template directory failed: {error}"))?;
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
pub fn create_path_from_template(
    template_id: String,
    notebook_id: String,
    state: State<AppState>,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<CreatedPathDocumentResult, String> {
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
    let body = extract_body_content(&content);
    let title = template_name_from_path(&path);
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let parent = default_parent_relative_path(&memo_file, &notebook_id)
        .map_err(|error| error.to_string())?;
    if let Some(dir) = create_target_dir(&memo_file, &notebook_id, parent.as_deref()) {
        mark_self_create_dir_for(&app, &dir);
    }
    let created = NoteService::new(&memo_file)
        .create(&notebook_id, parent.as_deref(), &title, body)
        .map_err(|e| e.to_string())?;
    mark_self_write_for(&app, &created.path);
    let notebook_change = crate::events::path_change::NotebookPathCreated::from_window(
        created.notebook.id.clone(),
        created.entry.relative_path.clone(),
        window.label().to_string(),
    );
    let result = CreatedPathDocumentResult {
        notebook_id: created.notebook.id,
        relative_path: created.entry.relative_path.clone(),
        path: created.path.to_string_lossy().to_string(),
        initial_content: created.body,
        entry: created.entry,
        notebook_change,
    };
    result.publish_created(&app);
    Ok(result)
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn import_external_document_by_path(
    file_path: String,
    content: String,
    notebook_id: String,
    state: State<AppState>,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<CreatedPathDocumentResult, String> {
    let title = Path::new(&file_path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("imported");
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let parent = default_parent_relative_path(&memo_file, &notebook_id)
        .map_err(|error| error.to_string())?;
    if let Some(dir) = create_target_dir(&memo_file, &notebook_id, parent.as_deref()) {
        mark_self_create_dir_for(&app, &dir);
    }
    let created = NoteService::new(&memo_file)
        .create(&notebook_id, parent.as_deref(), title, &content)
        .map_err(|error| error.to_string())?;
    mark_self_write_for(&app, &created.path);
    let notebook_change = crate::events::path_change::NotebookPathCreated::from_window(
        created.notebook.id.clone(),
        created.entry.relative_path.clone(),
        window.label().to_string(),
    );
    let result = CreatedPathDocumentResult {
        notebook_id: created.notebook.id,
        relative_path: created.entry.relative_path.clone(),
        path: created.path.to_string_lossy().to_string(),
        initial_content: created.body,
        entry: created.entry,
        notebook_change,
    };
    result.publish_created(&app);
    Ok(result)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveMemoResult {
    pub notebook_change: crate::events::path_change::NotebookPathMove,
    pub path: String,
}

/// Move a notebook note by relative path.
#[tauri::command]
pub fn move_memo_to_directory(
    file_path: String,
    notebook_id: String,
    parent_relative_path: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<MoveMemoResult, FileOperationFailure> {
    let requested_path = Path::new(&file_path);
    if !requested_path.is_absolute() {
        return Err("absolute document path required".into());
    }
    let _watch_move =
        crate::external_watch::begin_path_move(&app, requested_path);
    let (moved, old_relative, old_path) = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let (source_notebook_id, relative_path) =
            notebook_note_address(&memo_file, requested_path)?.ok_or_else(|| {
                "document is not a Markdown note inside a registered notebook".to_string()
            })?;
        if source_notebook_id != notebook_id {
            return Err("note does not belong to the selected notebook".into());
        }
        let mut service = NoteService::new(&memo_file);
        let original = service
            .get(&source_notebook_id, &relative_path)
            .map_err(FileOperationFailure::from)?;
        mark_self_write_for(&app, &original.path);
        let moved = service
            .move_to(&source_notebook_id, &relative_path, &parent_relative_path)
            .map_err(FileOperationFailure::from)?;
        drop(service);
        mark_self_write_for(&app, &moved.path);
        (moved, relative_path, original.path)
    };
    crate::external_watch::rebase_path(&app, requested_path, &moved.path);
    {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        flowix_core::collection_store::rebase_collection_paths(
            &memo_file,
            &notebook_id,
            &old_relative,
            &moved.entry.relative_path,
        );
    }
    if let Err(error) = state.thread_manager.rebase_agent_note_paths(
        &notebook_id,
        &notebook_id,
        &old_relative,
        &moved.entry.relative_path,
        &old_path.to_string_lossy(),
        &moved.path.to_string_lossy(),
    ) {
        tracing::warn!(
            notebook_id = %notebook_id,
            old_relative = %old_relative,
            new_relative = %moved.entry.relative_path,
            "note was moved but agent note references could not be rebased: {error}"
        );
    }
    let notebook_change = crate::events::path_change::NotebookPathMove::new(
        notebook_id.clone(),
        old_relative,
        moved.entry.relative_path.clone(),
        false,
    );
    notebook_change.emit(&app);
    Ok(MoveMemoResult {
        notebook_change,
        path: moved.path.to_string_lossy().into_owned(),
    })
}
