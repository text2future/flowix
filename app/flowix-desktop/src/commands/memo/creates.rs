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
use flowix_core::memo_file::{atomic_write_bytes, extract_body_content, Memo, MemoFile};
use flowix_core::NoteService;

use crate::app::state::AppState;
use crate::template_store;
use crate::watcher::runtime::{mark_self_create_dir_for, mark_self_write_for};

use super::helpers::*;
use super::*;

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
    notebook_change: super::super::path_change::NotebookPathCreated,
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
        let notebook_change = super::super::path_change::NotebookPathCreated::from_window(
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
    let notebook_change = super::super::path_change::NotebookPathCreated::from_window(
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
    let notebook_change = super::super::path_change::NotebookPathCreated::from_window(
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
pub struct RenameMemoTitleResult {
    pub notebook_change: super::super::path_change::NotebookPathMove,
    pub memo: Option<Memo>,
    pub path: String,
    pub filename: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveMemoResult {
    pub notebook_change: super::super::path_change::NotebookPathMove,
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
        crate::commands::external_document_watch::begin_path_move(&app, requested_path);
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
    crate::commands::external_document_watch::rebase_path(&app, requested_path, &moved.path);
    {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        crate::commands::document_list::rebase_collection_paths(
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
    let notebook_change = super::super::path_change::NotebookPathMove::new(
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

/// Rename a memo independently from its Markdown content.
#[tauri::command]
pub async fn rename_memo_title(
    operation_id: Option<String>,
    file_path: String,
    title: String,
    expected_filename: Option<String>,
    expected_content: Option<String>,
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<RenameMemoTitleResult, String> {
    crate::commands::document_operations::run(
        "rename",
        operation_id,
        window.label().to_owned(),
        move || {
            let state = app.state::<AppState>();
            rename_memo_title_blocking(
                file_path,
                title,
                expected_filename,
                expected_content,
                state,
                app.clone(),
                window,
            )
        },
    )
    .await
    .map_err(|error| error.to_string())
}

fn rename_memo_title_blocking(
    file_path: String,
    title: String,
    expected_filename: Option<String>,
    expected_content: Option<String>,
    state: State<AppState>,
    app: AppHandle,
    _window: tauri::WebviewWindow,
) -> Result<RenameMemoTitleResult, String> {
    let title = title.trim().trim_end_matches(".md").trim();
    if title.is_empty() {
        return Err("memo title cannot be empty".to_string());
    }

    let requested_path = Path::new(&file_path);
    if !requested_path.is_absolute() {
        return Err("absolute document path required".into());
    }
    let _watch_move =
        crate::commands::external_document_watch::begin_path_move(&app, requested_path);
    let (renamed, old_relative, old_path) = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let (notebook_id, relative_path) = notebook_note_address(&memo_file, requested_path)?
            .ok_or_else(|| {
                "document is not a Markdown note inside a registered notebook".to_string()
            })?;
        if expected_filename.as_deref().is_some_and(|expected| {
            expected != relative_path.rsplit('/').next().unwrap_or(&relative_path)
        }) {
            return Err("note filename changed before rename".into());
        }
        let mut service = NoteService::new(&memo_file);
        let original = service
            .get(&notebook_id, &relative_path)
            .map_err(|error| error.to_string())?;
        if expected_content.as_deref().is_some_and(|expected| {
            !super::helpers::cas_content_matches(&original.body, expected, expected)
        }) {
            return Err("note changed before rename".into());
        }
        mark_self_write_for(&app, &original.path);
        let renamed = service
            .rename(
                &notebook_id,
                &relative_path,
                title,
                expected_content.as_deref(),
            )
            .map_err(|error| error.to_string())?;
        mark_self_write_for(&app, &renamed.path);
        (renamed, relative_path, original.path)
    };
    crate::commands::external_document_watch::rebase_path(&app, requested_path, &renamed.path);
    {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        crate::commands::document_list::rebase_collection_paths(
            &memo_file,
            &renamed.notebook.id,
            &old_relative,
            &renamed.entry.relative_path,
        );
    }
    if let Err(error) = state.thread_manager.rebase_agent_note_paths(
        &renamed.notebook.id,
        &renamed.notebook.id,
        &old_relative,
        &renamed.entry.relative_path,
        &old_path.to_string_lossy(),
        &renamed.path.to_string_lossy(),
    ) {
        tracing::warn!(
            notebook_id = %renamed.notebook.id,
            old_relative = %old_relative,
            new_relative = %renamed.entry.relative_path,
            "note was renamed but agent note references could not be rebased: {error}"
        );
    }
    let path = renamed.path.to_string_lossy().into_owned();
    let notebook_change = super::super::path_change::NotebookPathMove::new(
        renamed.notebook.id.clone(),
        old_relative,
        renamed.entry.relative_path.clone(),
        false,
    );
    notebook_change.emit(&app);
    Ok(RenameMemoTitleResult {
        notebook_change,
        memo: None,
        path,
        filename: renamed
            .entry
            .relative_path
            .rsplit('/')
            .next()
            .unwrap_or(&renamed.entry.relative_path)
            .to_owned(),
    })
}
