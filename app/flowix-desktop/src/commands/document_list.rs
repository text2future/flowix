//! Notebook-scoped, time ordered listing for the folder card view.
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path},
    sync::{Arc, Mutex, OnceLock},
    time::UNIX_EPOCH,
};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{app::state::AppState, lock_utils::read_lock};
use flowix_core::memo_file::{FileManagementPolicy, FileWriteOutcome, MemoFile};

const TABLE_CATALOG_VERSION: &str = "3";
const MEDIA_LIBRARY_CATALOG_VERSION: &str = "1";
const DEFAULT_LIMIT: usize = 48;
const MAX_LIMIT: usize = 100;

static TABLE_CATALOG_STATES: OnceLock<Mutex<HashMap<String, Arc<Mutex<bool>>>>> = OnceLock::new();
static MEDIA_LIBRARY_CATALOG_STATES: OnceLock<Mutex<HashMap<String, Arc<Mutex<bool>>>>> = OnceLock::new();

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPageRequest {
    pub notebook_id: String,
    pub folder_path: String,
    #[serde(default)]
    pub resource_kinds: Vec<String>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPageItem {
    pub full_path: String,
    pub name: String,
    pub resource_kind: String,
    pub size_bytes: Option<u64>,
    pub modified_ms: Option<u64>,
    pub created_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPage {
    pub folders: Vec<DocumentPageItem>,
    pub items: Vec<DocumentPageItem>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDocumentListItem {
    pub relative_path: String,
    pub table_id: String,
    pub name: String,
    pub modified_ms: u64,
    pub file_revision: i64,
    pub in_views: bool,
    pub identity_conflict: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaLibraryListItem {
    pub relative_path: String,
    pub library_id: String,
    pub name: String,
    pub modified_ms: u64,
    pub in_views: bool,
    pub identity_conflict: bool,
}

fn table_catalog_state(notebook_id: &str) -> Result<Arc<Mutex<bool>>, String> {
    let states = TABLE_CATALOG_STATES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut states = states
        .lock()
        .map_err(|_| "TABLE_CATALOG_STATE_LOCK_FAILED")?;
    Ok(states
        .entry(notebook_id.to_owned())
        .or_insert_with(|| Arc::new(Mutex::new(false)))
        .clone())
}

fn media_library_catalog_state(notebook_id: &str) -> Result<Arc<Mutex<bool>>, String> {
    let states = MEDIA_LIBRARY_CATALOG_STATES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut states = states
        .lock()
        .map_err(|_| "MEDIA_LIBRARY_CATALOG_STATE_LOCK_FAILED")?;
    Ok(states
        .entry(notebook_id.to_owned())
        .or_insert_with(|| Arc::new(Mutex::new(false)))
        .clone())
}

fn kind(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "md" | "markdown" => "note",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "avif" | "ico" | "tif"
        | "tiff" | "heic" => "image",
        "3gp" | "avi" | "flv" | "m2ts" | "m4v" | "mkv" | "mov" | "mp4" | "mpeg" | "mpg" | "mts"
        | "webm" | "wmv" => "video",
        _ => "other",
    }
}

fn setup(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS media_resources (
        id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, relative_path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('image', 'video')), size_bytes INTEGER NOT NULL, modified_ms INTEGER NOT NULL,
        fingerprint TEXT, properties TEXT NOT NULL DEFAULT '{}', properties_revision INTEGER NOT NULL DEFAULT 0,
        missing_since INTEGER, deleted_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(notebook_id, relative_path)
    );
    CREATE TABLE IF NOT EXISTS table_documents (
        relative_path TEXT PRIMARY KEY, table_id TEXT NOT NULL, name TEXT NOT NULL,
        modified_ms INTEGER NOT NULL, file_revision INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_table_documents_id ON table_documents(table_id);
    CREATE INDEX IF NOT EXISTS idx_table_documents_name ON table_documents(name COLLATE NOCASE, relative_path);
    CREATE TABLE IF NOT EXISTS table_document_catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS table_document_view_state (
        table_id TEXT PRIMARY KEY, in_views INTEGER NOT NULL DEFAULT 0 CHECK(in_views IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS media_library_view_state (
        library_id TEXT PRIMARY KEY, in_views INTEGER NOT NULL DEFAULT 0 CHECK(in_views IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS media_libraries (
        relative_path TEXT PRIMARY KEY, library_id TEXT NOT NULL, name TEXT NOT NULL,
        modified_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_libraries_id ON media_libraries(library_id);
    CREATE INDEX IF NOT EXISTS idx_media_libraries_name ON media_libraries(name COLLATE NOCASE, relative_path);
    CREATE TABLE IF NOT EXISTS media_library_catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
        .map_err(|error| error.to_string())
}

pub(crate) fn is_table_document_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            let name = name.to_ascii_lowercase();
            name.ends_with(".table.yml") || name.ends_with(".table.yaml")
        })
}

fn is_valid_prefixed_uuid_id(value: &str, prefix: &str) -> bool {
    value.len() == prefix.len() + 32
        && value.starts_with(prefix)
        && value[prefix.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn table_document_item(root: &Path, path: &Path) -> Option<TableDocumentListItem> {
    let relative = path.strip_prefix(root).ok()?;
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return None;
    }
    let source = fs::read_to_string(path).ok()?;
    let value: serde_yaml::Value = serde_yaml::from_str(&source).ok()?;
    if value.get("format").and_then(serde_yaml::Value::as_str) != Some("flowix.table")
        || value.get("version").and_then(serde_yaml::Value::as_i64) != Some(1)
    {
        return None;
    }
    let table = value.get("table")?;
    let table_id = table.get("id")?.as_str()?.trim();
    let file_revision = value.get("revision")?.as_i64()?;
    if !is_valid_prefixed_uuid_id(table_id, "tbl_") || file_revision < 0 {
        return None;
    }
    let filename = path.file_name()?.to_string_lossy();
    let lowercase = filename.to_ascii_lowercase();
    let name = if lowercase.ends_with(".table.yaml") {
        filename[..filename.len() - ".table.yaml".len()].to_owned()
    } else if lowercase.ends_with(".table.yml") {
        filename[..filename.len() - ".table.yml".len()].to_owned()
    } else {
        filename.into_owned()
    };
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| {
            duration.as_millis().min(u64::MAX as u128) as u64
        });
    Some(TableDocumentListItem {
        relative_path: relative.to_string_lossy().replace('\\', "/"),
        table_id: table_id.to_owned(),
        name,
        modified_ms,
        file_revision,
        in_views: false,
        identity_conflict: false,
    })
}

fn collect_table_documents(root: &Path) -> Result<Vec<TableDocumentListItem>, String> {
    let policy = FileManagementPolicy::from_notebook_root(root);
    let mut pending = vec![root.to_path_buf()];
    let mut documents = Vec::new();
    while let Some(folder) = pending.pop() {
        let entries = match fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(error) if folder == root => return Err(error.to_string()),
            Err(error) => {
                tracing::debug!(path = %folder.display(), "skip unreadable table catalog directory: {error}");
                continue;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            if policy.is_tree_hidden_at(root, relative) {
                continue;
            }
            if file_type.is_dir() {
                if entry.file_name().to_string_lossy().starts_with('.') {
                    continue;
                }
                pending.push(path);
            } else if is_table_document_path(&path) {
                if let Some(item) = table_document_item(root, &path) {
                    documents.push(item);
                }
            }
        }
    }
    documents.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });
    Ok(documents)
}

fn is_media_library_path(path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()).is_some_and(|name| {
        let name = name.to_ascii_lowercase();
        name.ends_with(".lib.yaml") || name.ends_with(".lib.yml")
    })
}

fn yaml_mapping_has_only_keys(value: &serde_yaml::Value, allowed: &[&str]) -> bool {
    value.as_mapping().is_some_and(|mapping| {
        mapping
            .keys()
            .all(|key| key.as_str().is_some_and(|key| allowed.contains(&key)))
    })
}

fn valid_media_library_document(value: &serde_yaml::Value) -> Option<(&str, &str)> {
    if !yaml_mapping_has_only_keys(value, &["format", "version", "library", "view"])
        || value.get("format")?.as_str()? != "flowix.media-library"
        || value.get("version")?.as_f64()? != 1.0
    {
        return None;
    }

    let library = value.get("library")?;
    if !yaml_mapping_has_only_keys(library, &["id", "name", "revision"]) {
        return None;
    }
    let library_id = library.get("id")?.as_str()?.trim();
    let stored_name = library.get("name")?.as_str()?;
    let name = stored_name.trim();
    let revision = library.get("revision")?.as_f64()?;
    if !is_valid_media_library_id(library_id)
        || name.is_empty()
        || stored_name != name
        || !revision.is_finite()
        || revision.fract() != 0.0
        || !(0.0..=9_007_199_254_740_991.0).contains(&revision)
    {
        return None;
    }

    let view = value.get("view")?;
    if !yaml_mapping_has_only_keys(view, &["id", "layout", "kinds", "sort"])
        || !view
            .get("id")?
            .as_str()
            .is_some_and(|id| is_valid_prefixed_uuid_id(id, "view_"))
        || view.get("layout")?.as_str()? != "waterfall"
    {
        return None;
    }
    let mut kinds_seen = HashSet::new();
    for kind in view.get("kinds")?.as_sequence()? {
        let kind = kind.as_str()?;
        if !matches!(kind, "image" | "video") || !kinds_seen.insert(kind) {
            return None;
        }
    }
    if let Some(sort) = view.get("sort") {
        if !yaml_mapping_has_only_keys(sort, &["field", "direction"])
            || sort.get("field")?.as_str()? != "created_at"
            || sort.get("direction")?.as_str()? != "desc"
        {
            return None;
        }
    }

    Some((library_id, name))
}

fn yaml_line_body(line: &str) -> &str {
    let without_newline = line.strip_suffix('\n').unwrap_or(line);
    without_newline.strip_suffix('\r').unwrap_or(without_newline)
}

fn replace_yaml_scalar_field(
    source: &str,
    parent_key: Option<&str>,
    field_key: &str,
    expected_value: Option<&str>,
    replacement: &str,
) -> Result<String, String> {
    let lines = source.split_inclusive('\n').collect::<Vec<_>>();
    let indentation = |line: &str| line.bytes().take_while(|byte| *byte == b' ').count();
    let key_line = |content: &str, key: &str| {
        content
            .split_once(':')
            .is_some_and(|(candidate, _)| candidate.trim() == key)
    };

    let start = if let Some(parent_key) = parent_key {
        let parent = lines
            .iter()
            .position(|line| {
                let body = yaml_line_body(line);
                indentation(body) == 0
                    && key_line(body, parent_key)
                    && body.trim_start().split_once(':').is_some_and(|(_, tail)| {
                        let tail = tail.trim();
                        tail.is_empty() || tail.starts_with('#')
                    })
            })
            .ok_or_else(|| format!("MISSING_YAML_MAPPING:{parent_key}"))?;
        let parent_indent = indentation(yaml_line_body(lines[parent]));
        let mut child_indent = None;
        let mut field = None;
        for index in parent + 1..lines.len() {
            let body = yaml_line_body(lines[index]);
            let trimmed = body.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let indent = indentation(body);
            if indent <= parent_indent {
                break;
            }
            let level = *child_indent.get_or_insert(indent);
            if indent == level && key_line(body.trim_start(), field_key) {
                if field.replace(index).is_some() {
                    return Err(format!("DUPLICATE_YAML_FIELD:{field_key}"));
                }
            }
        }
        let field = field.ok_or_else(|| format!("MISSING_YAML_FIELD:{field_key}"))?;
        field
    } else {
        let mut field = None;
        for (index, line) in lines.iter().enumerate() {
            let body = yaml_line_body(line);
            if indentation(body) == 0 && key_line(body, field_key) {
                if field.replace(index).is_some() {
                    return Err(format!("DUPLICATE_YAML_FIELD:{field_key}"));
                }
            }
        }
        field.ok_or_else(|| format!("MISSING_YAML_FIELD:{field_key}"))?
    };
    let line = lines[start];
    let body = yaml_line_body(line);
    let colon = body.find(':').ok_or("INVALID_YAML_FIELD")?;
    let value_start = colon + 1 + body[colon + 1..].len() - body[colon + 1..].trim_start().len();
    let value_text = &body[value_start..];
    let (scalar_start, scalar_end) = if let Some(quote @ ('\'' | '"')) = value_text.chars().next() {
        let close = value_text[1..]
            .find(quote)
            .map(|index| value_start + 1 + index)
            .ok_or("INVALID_YAML_SCALAR")?;
        (value_start + 1, close)
    } else {
        let end = value_text
            .find(|character: char| character.is_whitespace() || character == '#')
            .unwrap_or(value_text.len());
        (value_start, value_start + end)
    };
    if scalar_start == scalar_end {
        return Err(format!("INVALID_YAML_FIELD:{field_key}"));
    }
    let scalar = &body[scalar_start..scalar_end];
    if expected_value.is_some_and(|expected| expected != scalar) {
        return Err(format!("YAML_FIELD_CHANGED:{field_key}"));
    }
    let mut updated = String::with_capacity(source.len() + replacement.len());
    for (index, current) in lines.iter().enumerate() {
        if index == start {
            let current_body = yaml_line_body(current);
            updated.push_str(&current_body[..scalar_start]);
            updated.push_str(replacement);
            updated.push_str(&current_body[scalar_end..]);
            let ending = &current[current_body.len()..];
            updated.push_str(ending);
        } else {
            updated.push_str(current);
        }
    }
    Ok(updated)
}

fn media_library_item(root: &Path, path: &Path) -> Option<MediaLibraryListItem> {
    let relative = path.strip_prefix(root).ok()?;
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return None;
    }
    let source = fs::read_to_string(path).ok()?;
    let value: serde_yaml::Value = serde_yaml::from_str(&source).ok()?;
    let (library_id, name) = valid_media_library_document(&value)?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis().min(u64::MAX as u128) as u64);
    Some(MediaLibraryListItem {
        relative_path: relative.to_string_lossy().replace('\\', "/"),
        library_id: library_id.to_owned(),
        name: name.to_owned(),
        modified_ms,
        in_views: false,
        identity_conflict: false,
    })
}

fn collect_media_libraries(root: &Path) -> Result<Vec<MediaLibraryListItem>, String> {
    let policy = FileManagementPolicy::from_notebook_root(root);
    let mut pending = vec![root.to_path_buf()];
    let mut libraries = Vec::new();
    while let Some(folder) = pending.pop() {
        let entries = match fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(error) if folder == root => return Err(error.to_string()),
            Err(error) => {
                tracing::debug!(path = %folder.display(), "skip unreadable media library directory: {error}");
                continue;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else { continue; };
            if file_type.is_symlink() { continue; }
            let Ok(relative) = path.strip_prefix(root) else { continue; };
            if policy.is_tree_hidden_at(root, relative) { continue; }
            if file_type.is_dir() {
                if !entry.file_name().to_string_lossy().starts_with('.') { pending.push(path); }
            } else if is_media_library_path(&path) {
                if let Some(item) = media_library_item(root, &path) { libraries.push(item); }
            }
        }
    }
    libraries.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()).then_with(|| left.relative_path.cmp(&right.relative_path)));
    Ok(libraries)
}

fn is_valid_media_library_id(library_id: &str) -> bool {
    is_valid_prefixed_uuid_id(library_id, "lib_")
}

fn rebased_relative_path(value: &str, old_path: &str, new_path: &str) -> Option<String> {
    let value = value.replace('\\', "/");
    let old_path = old_path.trim_matches('/');
    let new_path = new_path.trim_matches('/');
    if value == old_path {
        return Some(new_path.to_owned());
    }
    let prefix = format!("{old_path}/");
    value
        .strip_prefix(&prefix)
        .map(|suffix| format!("{new_path}/{suffix}"))
}

fn rebase_table_document_paths(source: &str, old_path: &str, new_path: &str) -> Option<String> {
    let mut value: serde_yaml::Value = serde_yaml::from_str(source).ok()?;
    let mut changed = false;
    let updated_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    if let Some(records) = value
        .get_mut("records")
        .and_then(|records| records.get_mut("data"))
        .and_then(serde_yaml::Value::as_sequence_mut)
    {
        for record in records {
            let Some(path) = record.get("note_path").and_then(serde_yaml::Value::as_str) else {
                continue;
            };
            if let Some(rebased) = rebased_relative_path(path, old_path, new_path) {
                if let Some(record) = record.as_mapping_mut() {
                    record.insert(
                        serde_yaml::Value::String("note_path".to_owned()),
                        serde_yaml::Value::String(rebased),
                    );
                    record.insert(
                        serde_yaml::Value::String("updated_at".to_owned()),
                        serde_yaml::Value::String(updated_at.clone()),
                    );
                    changed = true;
                }
            }
        }
    }

    if let Some(excluded_paths) = value
        .get_mut("records")
        .and_then(|records| records.get_mut("auto_collect"))
        .and_then(|auto_collect| auto_collect.get_mut("excluded_note_paths"))
        .and_then(serde_yaml::Value::as_sequence_mut)
    {
        for path in excluded_paths {
            let Some(path_text) = path.as_str() else {
                continue;
            };
            if let Some(rebased) = rebased_relative_path(path_text, old_path, new_path) {
                *path = serde_yaml::Value::String(rebased);
                changed = true;
            }
        }
    }

    if let Some(folder_path) = value
        .get_mut("records")
        .and_then(|records| records.get_mut("auto_collect"))
        .and_then(|auto_collect| auto_collect.get_mut("condition"))
        .and_then(|condition| condition.get_mut("file_condition"))
        .and_then(|file_condition| file_condition.get_mut("path_contains"))
    {
        if let Some(path_text) = folder_path.as_str() {
            if let Some(rebased) = rebased_relative_path(path_text, old_path, new_path) {
                *folder_path = serde_yaml::Value::String(rebased);
                changed = true;
            }
        }
    }

    if !changed {
        return None;
    }
    let next_revision = value
        .get("revision")
        .and_then(serde_yaml::Value::as_i64)
        .map(|revision| revision + 1);
    if let (Some(mapping), Some(revision)) = (value.as_mapping_mut(), next_revision) {
        mapping.insert(
            serde_yaml::Value::String("revision".to_owned()),
            serde_yaml::Value::Number(revision.into()),
        );
    }
    serde_yaml::to_string(&value).ok()
}

/// Best-effort maintenance of table-to-note references after a note path move.
/// Table files are independent user documents, so a failed/conflicted rewrite
/// must never fail the note rename itself. Unresolved references are repaired
/// to blank rows when the table is next loaded.
pub(crate) fn rebase_table_note_paths(
    memo_file: &MemoFile,
    notebook_id: &str,
    old_relative_path: &str,
    new_relative_path: &str,
) {
    if old_relative_path == new_relative_path
        || old_relative_path.is_empty()
        || new_relative_path.is_empty()
    {
        return;
    }
    let Some(notebook) = memo_file.get_notebook_config_by_id(notebook_id) else {
        return;
    };
    let Ok(root) = dunce::canonicalize(&notebook.path) else {
        return;
    };
    let Ok(documents) = collect_table_documents(&root) else {
        return;
    };

    for item in documents {
        let path = root.join(&item.relative_path);
        let Ok(source) = fs::read_to_string(&path) else {
            continue;
        };
        let Some(next) = rebase_table_document_paths(&source, old_relative_path, new_relative_path)
        else {
            continue;
        };
        match memo_file.write_file_if_matches(&path, &next, Some(&source)) {
            Ok(FileWriteOutcome::Saved) => refresh_table_document_path(memo_file, &path),
            Ok(FileWriteOutcome::Conflict { .. }) => {
                tracing::debug!(path = %path.display(), "table reference rebase skipped after concurrent edit")
            }
            Err(error) => {
                tracing::debug!(path = %path.display(), "table reference rebase skipped: {error}")
            }
        }
    }
}

/// Rebase references for a file or folder move when both paths belong to the
/// same notebook. This path-based wrapper is used by generic file operations.
pub(crate) fn rebase_table_note_paths_for_move(memo_file: &MemoFile, source: &Path, target: &Path) {
    let Ok(notebooks) = memo_file.read_notebook_configs() else {
        return;
    };
    for notebook in notebooks {
        let Ok(root) = dunce::canonicalize(&notebook.path) else {
            continue;
        };
        let (Ok(old_relative), Ok(new_relative)) =
            (source.strip_prefix(&root), target.strip_prefix(&root))
        else {
            continue;
        };
        rebase_table_note_paths(
            memo_file,
            &notebook.id,
            &old_relative.to_string_lossy().replace('\\', "/"),
            &new_relative.to_string_lossy().replace('\\', "/"),
        );
        break;
    }
}

fn replace_table_document_catalog(conn: &mut Connection, root: &Path) -> Result<(), String> {
    let documents = collect_table_documents(root)?;
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM table_documents", [])
        .map_err(|error| error.to_string())?;
    {
        let mut statement = transaction.prepare("INSERT INTO table_documents(relative_path, table_id, name, modified_ms, file_revision) VALUES(?1, ?2, ?3, ?4, ?5)")
            .map_err(|error| error.to_string())?;
        for item in &documents {
            statement
                .execute(params![
                    item.relative_path,
                    item.table_id,
                    item.name,
                    item.modified_ms as i64,
                    item.file_revision
                ])
                .map_err(|error| error.to_string())?;
        }
    }
    transaction.execute("INSERT INTO table_document_catalog_meta(key, value) VALUES('version', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [TABLE_CATALOG_VERSION])
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn refresh_table_document_path_in_db(
    database: &Path,
    root: &Path,
    path: &Path,
) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|error| error.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let mut conn = Connection::open(database).map_err(|error| error.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(10))
        .map_err(|error| error.to_string())?;
    setup(&conn)?;
    let visible = !FileManagementPolicy::from_notebook_root(root)
        .is_tree_hidden_at(root, Path::new(&relative));
    if visible && is_table_document_path(path) {
        if let Some(item) = table_document_item(root, path) {
            conn.execute("INSERT INTO table_documents(relative_path, table_id, name, modified_ms, file_revision) VALUES(?1, ?2, ?3, ?4, ?5) ON CONFLICT(relative_path) DO UPDATE SET table_id=excluded.table_id, name=excluded.name, modified_ms=excluded.modified_ms, file_revision=excluded.file_revision",
                params![item.relative_path, item.table_id, item.name, item.modified_ms as i64, item.file_revision])
                .map_err(|error| error.to_string())?;
            return Ok(());
        }
    }
    conn.execute(
        "DELETE FROM table_documents WHERE relative_path=?1",
        [relative],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn refresh_table_document_path(memo_file: &MemoFile, path: &Path) {
    if !is_table_document_path(path) {
        return;
    }
    let Ok(notebooks) = memo_file.read_notebook_configs() else {
        return;
    };
    let candidate = notebooks
        .into_iter()
        .filter_map(|notebook| {
            let root = dunce::canonicalize(&notebook.path).ok()?;
            path.strip_prefix(&root).ok()?;
            let database = memo_file.notebook_db_path(&notebook.id).ok()?;
            Some((notebook.id, root, database))
        })
        .max_by_key(|(_, root, _)| root.components().count());
    let Some((notebook_id, root, database)) = candidate else {
        return;
    };
    let Ok(state) = table_catalog_state(&notebook_id) else {
        return;
    };
    let Ok(_guard) = state.lock() else {
        return;
    };
    if let Err(error) = refresh_table_document_path_in_db(&database, &root, path) {
        tracing::warn!(path = %path.display(), "table document index update failed: {error}");
    }
}

fn refresh_table_document_catalog(
    memo_file: &MemoFile,
    notebook_id: &str,
    notebook_root: &Path,
) -> Result<(), String> {
    let database = memo_file
        .notebook_db_path(notebook_id)
        .map_err(|error| error.to_string())?;
    let state = table_catalog_state(notebook_id)?;
    let mut ready = state
        .lock()
        .map_err(|_| "TABLE_CATALOG_STATE_LOCK_FAILED")?;
    let result = (|| {
        let mut conn = Connection::open(database).map_err(|error| error.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(10))
            .map_err(|error| error.to_string())?;
        setup(&conn)?;
        replace_table_document_catalog(&mut conn, notebook_root)
    })();
    if let Err(error) = result {
        *ready = false;
        return Err(error);
    }
    *ready = true;
    Ok(())
}

fn replace_media_library_catalog(conn: &mut Connection, root: &Path) -> Result<(), String> {
    let libraries = collect_media_libraries(root)?;
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM media_libraries", [])
        .map_err(|error| error.to_string())?;
    {
        let mut statement = transaction
            .prepare("INSERT INTO media_libraries(relative_path, library_id, name, modified_ms) VALUES(?1, ?2, ?3, ?4)")
            .map_err(|error| error.to_string())?;
        for item in &libraries {
            statement
                .execute(params![item.relative_path, item.library_id, item.name, item.modified_ms as i64])
                .map_err(|error| error.to_string())?;
        }
    }
    transaction
        .execute(
            "INSERT INTO media_library_catalog_meta(key, value) VALUES('version', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [MEDIA_LIBRARY_CATALOG_VERSION],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn refresh_media_library_path_in_db(
    database: &Path,
    root: &Path,
    path: &Path,
) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|error| error.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let conn = Connection::open(database).map_err(|error| error.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(10))
        .map_err(|error| error.to_string())?;
    setup(&conn)?;
    let visible = !FileManagementPolicy::from_notebook_root(root)
        .is_tree_hidden_at(root, Path::new(&relative));
    if visible && is_media_library_path(path) {
        if let Some(item) = media_library_item(root, path) {
            conn.execute(
                "INSERT INTO media_libraries(relative_path, library_id, name, modified_ms) VALUES(?1, ?2, ?3, ?4) ON CONFLICT(relative_path) DO UPDATE SET library_id=excluded.library_id, name=excluded.name, modified_ms=excluded.modified_ms",
                params![item.relative_path, item.library_id, item.name, item.modified_ms as i64],
            )
            .map_err(|error| error.to_string())?;
            return Ok(());
        }
    }
    conn.execute("DELETE FROM media_libraries WHERE relative_path=?1", [relative])
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn refresh_media_library_path(memo_file: &MemoFile, path: &Path) {
    if !is_media_library_path(path) {
        return;
    }
    let Ok(notebooks) = memo_file.read_notebook_configs() else {
        return;
    };
    let candidate = notebooks
        .into_iter()
        .filter_map(|notebook| {
            let root = dunce::canonicalize(&notebook.path).ok()?;
            path.strip_prefix(&root).ok()?;
            let database = memo_file.notebook_db_path(&notebook.id).ok()?;
            Some((notebook.id, root, database))
        })
        .max_by_key(|(_, root, _)| root.components().count());
    let Some((notebook_id, root, database)) = candidate else {
        return;
    };
    let Ok(state) = media_library_catalog_state(&notebook_id) else {
        return;
    };
    let Ok(_guard) = state.lock() else {
        return;
    };
    if let Err(error) = refresh_media_library_path_in_db(&database, &root, path) {
        tracing::warn!(path = %path.display(), "media library catalog update failed: {error}");
    }
}

fn refresh_media_library_catalog(
    memo_file: &MemoFile,
    notebook_id: &str,
    notebook_root: &Path,
) -> Result<(), String> {
    let database = memo_file
        .notebook_db_path(notebook_id)
        .map_err(|error| error.to_string())?;
    let state = media_library_catalog_state(notebook_id)?;
    let mut ready = state
        .lock()
        .map_err(|_| "MEDIA_LIBRARY_CATALOG_STATE_LOCK_FAILED")?;
    let result = (|| {
        let mut conn = Connection::open(database).map_err(|error| error.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(10))
            .map_err(|error| error.to_string())?;
        setup(&conn)?;
        replace_media_library_catalog(&mut conn, notebook_root)
    })();
    if let Err(error) = result {
        *ready = false;
        return Err(error);
    }
    *ready = true;
    Ok(())
}

fn ensure_media_library_catalog(
    conn: &mut Connection,
    notebook_root: &Path,
    ready: &mut bool,
) -> Result<(), String> {
    let version: Option<String> = conn
        .query_row(
            "SELECT value FROM media_library_catalog_meta WHERE key='version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if !*ready || version.as_deref() != Some(MEDIA_LIBRARY_CATALOG_VERSION) {
        replace_media_library_catalog(conn, notebook_root)?;
        *ready = true;
    }
    Ok(())
}

/// Refresh both notebook view-document catalogs at the same lifecycle points.
pub(crate) fn refresh_view_document_catalog(
    memo_file: &MemoFile,
    notebook_id: &str,
    notebook_root: &Path,
) {
    if let Err(error) = refresh_view_document_catalog_checked(memo_file, notebook_id, notebook_root) {
        tracing::warn!(notebook_id, "view document catalog refresh failed: {error}");
    }
}

pub(crate) fn refresh_view_document_catalog_checked(
    memo_file: &MemoFile,
    notebook_id: &str,
    notebook_root: &Path,
) -> Result<(), String> {
    let table_result = refresh_table_document_catalog(memo_file, notebook_id, notebook_root)
        .map_err(|error| format!("table catalog refresh failed: {error}"));
    let media_result = refresh_media_library_catalog(memo_file, notebook_id, notebook_root)
        .map_err(|error| format!("media library catalog refresh failed: {error}"));
    match (table_result, media_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(table), Ok(())) => Err(table),
        (Ok(()), Err(media)) => Err(media),
        (Err(table), Err(media)) => Err(format!("{table}; {media}")),
    }
}

/// Refresh both view-document catalogs for a single file mutation.
pub(crate) fn refresh_view_document_path(memo_file: &MemoFile, path: &Path) {
    refresh_table_document_path(memo_file, path);
    refresh_media_library_path(memo_file, path);
}

fn decode_cursor(cursor: &str) -> Result<(i64, String), String> {
    let (time, path) = cursor.split_once(':').ok_or("INVALID_CURSOR")?;
    let time = time.parse::<i64>().map_err(|_| "INVALID_CURSOR")?;
    if path.contains('\0') {
        return Err("INVALID_CURSOR".into());
    }
    Ok((time, path.to_owned()))
}

#[derive(Debug)]
struct FolderFileEntry {
    relative_path: String,
    resource_kind: String,
    modified_ms: i64,
    created_ms: Option<i64>,
    size_bytes: u64,
}

#[tauri::command]
pub async fn list_document_page(
    request: DocumentPageRequest,
    state: State<'_, AppState>,
) -> Result<DocumentPage, String> {
    let (root, database) = {
        let store = read_lock(&state.memo_file, "memo_file");
        let config = store
            .get_notebook_config_by_id(&request.notebook_id)
            .ok_or("NOTEBOOK_NOT_FOUND")?;
        (
            dunce::canonicalize(&config.path).map_err(|error| error.to_string())?,
            store
                .notebook_db_path(&request.notebook_id)
                .map_err(|error| error.to_string())?,
        )
    };
    let folder = dunce::canonicalize(&request.folder_path).map_err(|error| error.to_string())?;
    let policy = FileManagementPolicy::from_notebook_root(&root);
    if !folder.is_dir()
        || !folder.starts_with(&root)
        || folder
            .strip_prefix(&root)
            .is_ok_and(|relative| policy.is_ignored_at(&root, relative))
    {
        return Err("INVALID_NOTEBOOK_FOLDER".into());
    }
    let cursor = request.cursor.as_deref().map(decode_cursor).transpose()?;
    let limit = request.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let resource_kinds = request.resource_kinds;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = Connection::open(&database).map_err(|error| error.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(10)).map_err(|error| error.to_string())?;
        setup(&conn)?;
        let mut folders = Vec::new();
        let mut entries = Vec::new();
        for entry in fs::read_dir(&folder).map_err(|error| error.to_string())? {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => { tracing::debug!("skip unreadable document folder entry: {error}"); continue; }
            };
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) => { tracing::debug!(path = %entry.path().display(), "skip unreadable document entry: {error}"); continue; }
            };
            let path = entry.path();
            let relative = match path.strip_prefix(&root) {
                Ok(relative) => relative,
                Err(_) => continue,
            };
            if policy.is_ignored_at(&root, relative) {
                continue;
            }
            if file_type.is_dir() {
                if cursor.is_none() {
                    let metadata = match entry.metadata() {
                        Ok(metadata) => metadata,
                        Err(error) => { tracing::debug!(path = %path.display(), "skip unreadable document folder metadata: {error}"); continue; }
                    };
                    let modified = metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|duration| duration.as_millis().min(u64::MAX as u128) as u64);
                    let created = metadata.created().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|duration| duration.as_millis().min(u64::MAX as u128) as u64);
                    folders.push(DocumentPageItem {
                        name: entry.file_name().to_string_lossy().into_owned(),
                        full_path: path.to_string_lossy().into_owned(),
                        resource_kind: "folder".into(),
                        size_bytes: None,
                        modified_ms: modified,
                        created_ms: created,
                    });
                }
                continue;
            }
            if !file_type.is_file() { continue; }
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) => { tracing::debug!(path = %path.display(), "skip unreadable document metadata: {error}"); continue; }
            };
            let modified_ms = metadata.modified().ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |duration| duration.as_millis().min(i64::MAX as u128) as i64);
            let created_ms = metadata.created().ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64);
            entries.push(FolderFileEntry {
                relative_path: relative.to_string_lossy().replace('\\', "/"),
                resource_kind: kind(&path).to_owned(),
                modified_ms,
                created_ms,
                size_bytes: metadata.len(),
            });
        }
        folders.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()).then_with(|| left.name.cmp(&right.name)));
        entries.sort_by(|left, right| right.modified_ms.cmp(&left.modified_ms).then_with(|| left.relative_path.cmp(&right.relative_path)));

        let mut items = Vec::new();
        let mut last = None;
        let mut has_more = false;
        for entry in entries {
            if cursor.as_ref().is_some_and(|(time, path)| {
                entry.modified_ms > *time || (entry.modified_ms == *time && entry.relative_path <= *path)
            }) {
                continue;
            }
            if !resource_kinds.is_empty() && !resource_kinds.iter().any(|kind| kind == &entry.resource_kind) { continue; }
            if items.len() == limit { has_more = true; break; }
            last = Some(format!("{}:{}", entry.modified_ms, entry.relative_path));
            let full_path = root.join(Path::new(&entry.relative_path));
            items.push(DocumentPageItem {
                name: full_path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                full_path: full_path.to_string_lossy().into_owned(),
                resource_kind: entry.resource_kind,
                modified_ms: Some(entry.modified_ms.max(0) as u64),
                created_ms: entry.created_ms.map(|value| value.max(0) as u64),
                size_bytes: Some(entry.size_bytes),
            });
        }
        Ok(DocumentPage { folders, next_cursor: if has_more { last } else { None }, has_more, items })
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn list_table_documents(
    notebook_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<TableDocumentListItem>, String> {
    let notebook = {
        let store = read_lock(&state.memo_file, "memo_file");
        let config = store
            .get_notebook_config_by_id(&notebook_id)
            .ok_or("NOTEBOOK_NOT_FOUND")?;
        (
            dunce::canonicalize(&config.path).map_err(|error| error.to_string())?,
            store
                .notebook_db_path(&notebook_id)
                .map_err(|error| error.to_string())?,
        )
    };
    tauri::async_runtime::spawn_blocking(move || {
        let state = table_catalog_state(&notebook_id)?;
        let mut ready = state.lock().map_err(|_| "TABLE_CATALOG_STATE_LOCK_FAILED")?;
        let mut conn = Connection::open(&notebook.1).map_err(|error| error.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(10)).map_err(|error| error.to_string())?;
        setup(&conn)?;
        let version: Option<String> = conn.query_row(
            "SELECT value FROM table_document_catalog_meta WHERE key='version'",
            [],
            |row| row.get(0),
        ).optional().map_err(|error| error.to_string())?;
        if !*ready || version.as_deref() != Some(TABLE_CATALOG_VERSION) {
            replace_table_document_catalog(&mut conn, &notebook.0)?;
            *ready = true;
        }
        let mut statement = conn.prepare("SELECT d.relative_path, d.table_id, d.name, MAX(d.modified_ms, 0), d.file_revision, COALESCE(s.in_views, 0), (SELECT COUNT(*) FROM table_documents duplicate WHERE duplicate.table_id=d.table_id) > 1 FROM table_documents d LEFT JOIN table_document_view_state s ON s.table_id = d.table_id ORDER BY d.name COLLATE NOCASE, d.relative_path")
            .map_err(|error| error.to_string())?;
        let items = statement.query_map([], |row| Ok(TableDocumentListItem {
            relative_path: row.get(0)?,
            table_id: row.get(1)?,
            name: row.get(2)?,
            modified_ms: row.get::<_, i64>(3)?.max(0) as u64,
            file_revision: row.get(4)?,
            in_views: row.get::<_, i64>(5)? != 0,
            identity_conflict: row.get(6)?,
        })).map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        Ok(items)
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn set_table_document_in_views(
    notebook_id: String,
    table_id: String,
    in_views: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !is_valid_prefixed_uuid_id(&table_id, "tbl_") {
        return Err("INVALID_TABLE_ID".into());
    }
    let database = {
        let store = read_lock(&state.memo_file, "memo_file");
        store
            .get_notebook_config_by_id(&notebook_id)
            .ok_or("NOTEBOOK_NOT_FOUND")?;
        store.notebook_db_path(&notebook_id).map_err(|error| error.to_string())?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let conn = Connection::open(database).map_err(|error| error.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(10)).map_err(|error| error.to_string())?;
        setup(&conn)?;
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM table_documents WHERE table_id = ?1)",
            [&table_id],
            |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        if !exists {
            return Err("TABLE_DOCUMENT_NOT_FOUND".into());
        }
        let identity_conflict: bool = conn.query_row(
            "SELECT COUNT(*) > 1 FROM table_documents WHERE table_id = ?1",
            [&table_id],
            |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        if identity_conflict {
            return Err("TABLE_IDENTITY_CONFLICT".into());
        }
        conn.execute(
            "INSERT INTO table_document_view_state(table_id, in_views) VALUES(?1, ?2) ON CONFLICT(table_id) DO UPDATE SET in_views=excluded.in_views",
            params![table_id, if in_views { 1_i64 } else { 0_i64 }],
        ).map_err(|error| error.to_string())?;
        Ok(())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn list_media_libraries(
    notebook_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MediaLibraryListItem>, String> {
    let notebook = {
        let store = read_lock(&state.memo_file, "memo_file");
        let config = store
            .get_notebook_config_by_id(&notebook_id)
            .ok_or("NOTEBOOK_NOT_FOUND")?;
        (
            dunce::canonicalize(&config.path).map_err(|error| error.to_string())?,
            store.notebook_db_path(&notebook_id).map_err(|error| error.to_string())?,
        )
    };
    tauri::async_runtime::spawn_blocking(move || {
        let catalog_state = media_library_catalog_state(&notebook_id)?;
        let mut ready = catalog_state
            .lock()
            .map_err(|_| "MEDIA_LIBRARY_CATALOG_STATE_LOCK_FAILED")?;
        let mut conn = Connection::open(notebook.1).map_err(|error| error.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(10))
            .map_err(|error| error.to_string())?;
        setup(&conn)?;
        ensure_media_library_catalog(&mut conn, &notebook.0, &mut ready)?;
        let mut statement = conn.prepare("SELECT d.relative_path, d.library_id, d.name, MAX(d.modified_ms, 0), COALESCE(s.in_views, 0), (SELECT COUNT(*) FROM media_libraries duplicate WHERE duplicate.library_id=d.library_id) > 1 FROM media_libraries d LEFT JOIN media_library_view_state s ON s.library_id = d.library_id ORDER BY d.name COLLATE NOCASE, d.relative_path")
            .map_err(|error| error.to_string())?;
        let libraries = statement.query_map([], |row| Ok(MediaLibraryListItem {
            relative_path: row.get(0)?,
            library_id: row.get(1)?,
            name: row.get(2)?,
            modified_ms: row.get::<_, i64>(3)?.max(0) as u64,
            in_views: row.get::<_, i64>(4)? != 0,
            identity_conflict: row.get(5)?,
        })).map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(libraries)
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn set_media_library_in_views(
    notebook_id: String,
    library_id: String,
    in_views: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !is_valid_media_library_id(&library_id) {
        return Err("INVALID_MEDIA_LIBRARY_ID".into());
    }
    let notebook = {
        let store = read_lock(&state.memo_file, "memo_file");
        let config = store
            .get_notebook_config_by_id(&notebook_id)
            .ok_or("NOTEBOOK_NOT_FOUND")?;
        (
            dunce::canonicalize(&config.path).map_err(|error| error.to_string())?,
            store.notebook_db_path(&notebook_id).map_err(|error| error.to_string())?,
        )
    };
    let notebook_id_for_catalog = notebook_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let catalog_state = media_library_catalog_state(&notebook_id_for_catalog)?;
        let mut ready = catalog_state
            .lock()
            .map_err(|_| "MEDIA_LIBRARY_CATALOG_STATE_LOCK_FAILED")?;
        let mut conn = Connection::open(notebook.1).map_err(|error| error.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(10))
            .map_err(|error| error.to_string())?;
        setup(&conn)?;
        ensure_media_library_catalog(&mut conn, &notebook.0, &mut ready)?;
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM media_libraries WHERE library_id = ?1)",
            [&library_id],
            |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        if !exists {
            return Err("MEDIA_LIBRARY_NOT_FOUND".into());
        }
        let identity_conflict: bool = conn.query_row(
            "SELECT COUNT(*) > 1 FROM media_libraries WHERE library_id = ?1",
            [&library_id],
            |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        if identity_conflict {
            return Err("MEDIA_LIBRARY_IDENTITY_CONFLICT".into());
        }
        conn.execute(
            "INSERT INTO media_library_view_state(library_id, in_views) VALUES(?1, ?2) ON CONFLICT(library_id) DO UPDATE SET in_views=excluded.in_views",
            params![library_id, if in_views { 1_i64 } else { 0_i64 }],
        ).map_err(|error| error.to_string())?;
        Ok(())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn make_view_document_identity_unique(
    notebook_id: String,
    relative_path: String,
    state: State<AppState>,
) -> Result<String, String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let notebook = memo_file
        .get_notebook_config_by_id(&notebook_id)
        .ok_or("NOTEBOOK_NOT_FOUND")?;
    let root = dunce::canonicalize(&notebook.path).map_err(|error| error.to_string())?;
    let database = memo_file
        .notebook_db_path(&notebook_id)
        .map_err(|error| error.to_string())?;

    let relative = Path::new(&relative_path);
    if relative.as_os_str().is_empty()
        || relative.components().any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("INVALID_RELATIVE_PATH".into());
    }
    let normalized = relative.to_string_lossy().replace('\\', "/");
    let path = root.join(relative);
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("VIEW_DOCUMENT_NOT_REGULAR_FILE".into());
    }
    let canonical_parent = dunce::canonicalize(path.parent().ok_or("INVALID_RELATIVE_PATH")?)
        .map_err(|error| error.to_string())?;
    if !canonical_parent.starts_with(&root) {
        return Err("PATH_OUTSIDE_NOTEBOOK".into());
    }
    let is_table = is_table_document_path(&path);
    let is_library = is_media_library_path(&path);
    if !is_table && !is_library {
        return Err("UNSUPPORTED_VIEW_DOCUMENT".into());
    }

    let source = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let document: serde_yaml::Value =
        serde_yaml::from_str(&source).map_err(|error| error.to_string())?;
    let (old_id, id_prefix) = if is_table {
        let item = table_document_item(&root, &path).ok_or("INVALID_TABLE_DOCUMENT")?;
        let stored_id = document
            .get("table")
            .and_then(|table| table.get("id"))
            .and_then(serde_yaml::Value::as_str)
            .ok_or("INVALID_TABLE_DOCUMENT")?;
        if stored_id != item.table_id {
            return Err("INVALID_TABLE_ID".into());
        }
        (item.table_id, "tbl_")
    } else {
        let (library_id, _) = valid_media_library_document(&document)
            .ok_or("INVALID_MEDIA_LIBRARY_DOCUMENT")?;
        if document
            .get("library")
            .and_then(|library| library.get("id"))
            .and_then(serde_yaml::Value::as_str)
            != Some(library_id)
        {
            return Err("INVALID_MEDIA_LIBRARY_ID".into());
        }
        (library_id.to_owned(), "lib_")
    };

    let conn = Connection::open(database).map_err(|error| error.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(10))
        .map_err(|error| error.to_string())?;
    setup(&conn)?;
    let (table_count, indexed_id): (i64, Option<String>) = if is_table {
        let count = conn.query_row(
            "SELECT COUNT(*) FROM table_documents WHERE table_id = ?1",
            [&old_id],
            |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        let indexed_id = conn.query_row(
            "SELECT table_id FROM table_documents WHERE relative_path = ?1",
            [&normalized],
            |row| row.get(0),
        ).optional().map_err(|error| error.to_string())?;
        (count, indexed_id)
    } else {
        let count = conn.query_row(
            "SELECT COUNT(*) FROM media_libraries WHERE library_id = ?1",
            [&old_id],
            |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        let indexed_id = conn.query_row(
            "SELECT library_id FROM media_libraries WHERE relative_path = ?1",
            [&normalized],
            |row| row.get(0),
        ).optional().map_err(|error| error.to_string())?;
        (count, indexed_id)
    };
    if indexed_id.as_deref() != Some(old_id.as_str()) {
        return Err("VIEW_DOCUMENT_INDEX_STALE".into());
    }
    if table_count < 2 {
        return Err("IDENTITY_NOT_CONFLICTED".into());
    }

    let new_id = loop {
        let candidate = format!("{id_prefix}{}", uuid::Uuid::now_v7().simple());
        let count = if is_table {
            conn.query_row(
                "SELECT COUNT(*) FROM table_documents WHERE table_id = ?1",
                [&candidate],
                |row| row.get::<_, i64>(0),
            )
        } else {
            conn.query_row(
                "SELECT COUNT(*) FROM media_libraries WHERE library_id = ?1",
                [&candidate],
                |row| row.get::<_, i64>(0),
            )
        }.map_err(|error| error.to_string())?;
        if count == 0 {
            break candidate;
        }
    };

    let (updated, expected_revision) = if is_table {
        let revision = document
            .get("revision")
            .and_then(serde_yaml::Value::as_i64)
            .filter(|revision| *revision >= 0)
            .ok_or("INVALID_TABLE_REVISION")?
            .checked_add(1)
            .ok_or("REVISION_OVERFLOW")?;
        let with_new_id = replace_yaml_scalar_field(
            &source,
            Some("table"),
            "id",
            Some(&old_id),
            &new_id,
        )?;
        (
            replace_yaml_scalar_field(&with_new_id, None, "revision", None, &revision.to_string())?,
            revision,
        )
    } else {
        let revision = document
            .get("library")
            .and_then(|library| library.get("revision"))
            .and_then(serde_yaml::Value::as_f64)
            .filter(|revision| {
                revision.is_finite()
                    && revision.fract() == 0.0
                    && (0.0..=9_007_199_254_740_991.0).contains(revision)
            })
            .ok_or("INVALID_MEDIA_LIBRARY_REVISION")? as i64;
        let revision = revision.checked_add(1).ok_or("REVISION_OVERFLOW")?;
        let with_new_id = replace_yaml_scalar_field(
            &source,
            Some("library"),
            "id",
            Some(&old_id),
            &new_id,
        )?;
        (
            replace_yaml_scalar_field(
                &with_new_id,
                Some("library"),
                "revision",
                None,
                &revision.to_string(),
            )?,
            revision,
        )
    };
    let verified: serde_yaml::Value =
        serde_yaml::from_str(&updated).map_err(|error| error.to_string())?;
    let (verified_id, verified_revision) = if is_table {
        (
            verified
                .get("table")
                .and_then(|table| table.get("id"))
                .and_then(serde_yaml::Value::as_str),
            verified.get("revision").and_then(serde_yaml::Value::as_i64),
        )
    } else {
        (
            verified
                .get("library")
                .and_then(|library| library.get("id"))
                .and_then(serde_yaml::Value::as_str),
            verified
                .get("library")
                .and_then(|library| library.get("revision"))
                .and_then(serde_yaml::Value::as_f64)
                .filter(|revision| revision.fract() == 0.0)
                .map(|revision| revision as i64),
        )
    };
    if verified_id != Some(new_id.as_str()) || verified_revision != Some(expected_revision) {
        return Err("IDENTITY_UPDATE_VALIDATION_FAILED".into());
    }
    match memo_file.write_file_if_matches(&path, &updated, Some(&source)) {
        Ok(FileWriteOutcome::Saved) => {
            drop(conn);
            refresh_view_document_path(&memo_file, &path);
            Ok(new_id)
        }
        Ok(FileWriteOutcome::Conflict { .. }) => Err("VIEW_DOCUMENT_CHANGED_RELOAD_AND_RETRY".into()),
        Err(error) => Err(error.to_string()),
    }
}
