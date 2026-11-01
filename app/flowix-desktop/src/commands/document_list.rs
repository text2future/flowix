//! Notebook folder listings and collection-to-note reference maintenance.
use crate::{app::state::AppState, lock_utils::read_lock};
use flowix_core::memo_file::{FileManagementPolicy, FileWriteOutcome, MemoFile, ResourceKind};
use serde::{Deserialize, Serialize};
use std::{cmp::Ordering, fs, path::Path, time::UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
const DEFAULT_LIMIT: usize = 48;
const MAX_LIMIT: usize = 100;

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
    /// Indexed asset category; distinct from the generic file preview kind.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_directory: Option<bool>,
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

pub(crate) fn is_table_document_path(path: &Path) -> bool {
    super::collection::collection_type_for_path(path)
        == Some(flowix_core::collection::CollectionType::Table)
}
pub(crate) fn refresh_table_document_path(memo: &MemoFile, path: &Path) {
    super::collection::refresh_path(memo, path);
}
pub(crate) fn refresh_view_document_path(memo: &MemoFile, path: &Path) {
    super::collection::refresh_path(memo, path);
}
pub(crate) fn refresh_view_document_catalog_checked(
    memo: &MemoFile,
    id: &str,
    _root: &Path,
) -> Result<(), String> {
    super::collection::refresh_catalog(memo, id)
}
pub(crate) fn refresh_view_document_catalog(memo: &MemoFile, id: &str, root: &Path) {
    if let Err(error) = refresh_view_document_catalog_checked(memo, id, root) {
        tracing::warn!(%error, "collection catalog refresh failed");
    }
}

fn rebase_collection_document_paths(
    source: &str,
    notebook_id: &str,
    old_path: &str,
    new_path: &str,
) -> Option<String> {
    let mut document = flowix_core::collection::CollectionDocument::parse(source)
        .ok()?
        .normalized_v2()
        .ok()?;
    if !document
        .rebase_paths_for_notebook(notebook_id, old_path, new_path)
        .ok()?
    {
        return None;
    }
    document.revise().ok()?;
    document.serialize().ok()
}

fn remove_table_document_note_records(source: &str, note_path: &str) -> Option<String> {
    let mut document = flowix_core::collection::CollectionDocument::parse(source)
        .ok()?
        .normalized_v2()
        .ok()?;
    let normalized_note_path = note_path.replace('\\', "/");
    let records = match document.collection.kind {
        flowix_core::collection::CollectionType::Table => document
            .payload
            .get_mut("dataset")?
            .get_mut("records")?,
        // Hybrid collections keep their note records in the notes domain.
        flowix_core::collection::CollectionType::Hybrid => document
            .payload
            .get_mut("domains")?
            .get_mut("notes")?
            .get_mut("records")?,
        _ => return None,
    };
    let mut changed = false;
    for key in ["include", "exclude"] {
        let Some(items) = records
            .get_mut(key)
            .and_then(serde_json::Value::as_array_mut)
        else {
            continue;
        };
        let original_len = items.len();
        items.retain(|record| {
            record
                .get("note_path")
                .and_then(serde_json::Value::as_str)
                .is_none_or(|path| path.replace('\\', "/") != normalized_note_path)
        });
        changed |= items.len() != original_len;
    }
    if !changed {
        return None;
    }
    document.collection.revision = document.collection.revision.checked_add(1)?;
    document.collection.updated_at =
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    document.serialize().ok()
}

/// Remove persisted references to a note after deletion. Collection documents
/// are independent user files, so conflicts or write failures must not undo
/// the note deletion.
pub(crate) fn remove_table_note_records(memo_file: &MemoFile, notebook_id: &str, note_path: &str) {
    if note_path.is_empty() {
        return;
    }
    let Some(notebook) = memo_file.get_notebook_config_by_id(notebook_id) else {
        return;
    };
    let Ok(root) = dunce::canonicalize(&notebook.path) else {
        return;
    };
    let Ok(documents) = super::collection::list_for_rebase(memo_file, notebook_id) else {
        return;
    };

    for item in documents.into_iter().filter(|item| {
        matches!(
            item.collection_type,
            flowix_core::collection::CollectionType::Table
                | flowix_core::collection::CollectionType::Hybrid
        ) && item.parse_state == "valid"
    }) {
        let path = root.join(&item.relative_path);
        for _ in 0..2 {
            let Ok(source) = fs::read_to_string(&path) else {
                break;
            };
            let Some(next) = remove_table_document_note_records(&source, note_path) else {
                break;
            };
            match memo_file.write_file_if_matches_for_notebook(
                notebook_id,
                &path,
                &next,
                Some(&source),
            ) {
                Ok(FileWriteOutcome::Saved) => {
                    refresh_table_document_path(memo_file, &path);
                    break;
                }
                Ok(FileWriteOutcome::Conflict { .. }) => {
                    tracing::debug!(path = %path.display(), "table note reference removal retry after concurrent edit");
                }
                Err(error) => {
                    tracing::debug!(path = %path.display(), "table note reference removal skipped: {error}");
                    break;
                }
            }
        }
    }
}

/// Best-effort maintenance of note/media collection references after a generic path move.
/// Collection folder mutations perform the same transformation inside their operation journal.
pub(crate) fn rebase_collection_paths(
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
    let Ok(documents) = super::collection::list_for_rebase(memo_file, notebook_id) else {
        return;
    };

    for item in documents
        .into_iter()
        .filter(|item| item.parse_state == "valid")
    {
        let path = root.join(&item.relative_path);
        let Ok(source) = fs::read_to_string(&path) else {
            continue;
        };
        let Some(next) = rebase_collection_document_paths(
            &source,
            notebook_id,
            old_relative_path,
            new_relative_path,
        ) else {
            continue;
        };
        match memo_file.write_file_if_matches_for_notebook(notebook_id, &path, &next, Some(&source))
        {
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
pub(crate) fn rebase_collection_paths_for_move(memo_file: &MemoFile, source: &Path, target: &Path) {
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
        rebase_collection_paths(
            memo_file,
            &notebook.id,
            &old_relative.to_string_lossy().replace('\\', "/"),
            &new_relative.to_string_lossy().replace('\\', "/"),
        );
        break;
    }
}

fn decode_cursor(cursor: &str) -> Result<(i64, String), String> {
    let (time, path) = cursor.split_once(':').ok_or("INVALID_CURSOR")?;
    let time = time.parse::<i64>().map_err(|_| "INVALID_CURSOR")?;
    if path.contains('\0') {
        return Err("INVALID_CURSOR".into());
    }
    Ok((time, path.to_owned()))
}

#[derive(Debug, Clone)]
struct FolderFileEntry {
    relative_path: String,
    resource_kind: String,
    modified_ms: i64,
    created_ms: Option<i64>,
    size_bytes: u64,
}

fn compare_folder_file_entries(left: &FolderFileEntry, right: &FolderFileEntry) -> Ordering {
    right
        .modified_ms
        .cmp(&left.modified_ms)
        .then_with(|| left.relative_path.cmp(&right.relative_path))
}

/// Keep only the requested page and one lookahead row before sorting. Directory
/// enumeration remains necessary, but retained candidates stay bounded by the page size.
fn retain_folder_page_entries(
    mut entries: Vec<FolderFileEntry>,
    limit: usize,
) -> (Vec<FolderFileEntry>, bool) {
    let candidate_count = limit.saturating_add(1);
    if entries.len() > candidate_count {
        entries.select_nth_unstable_by(candidate_count, compare_folder_file_entries);
        entries.truncate(candidate_count);
    }
    entries.sort_by(compare_folder_file_entries);
    let has_more = entries.len() > limit;
    if has_more {
        entries.truncate(limit);
    }
    (entries, has_more)
}

fn push_folder_page_candidate(entries: &mut Vec<FolderFileEntry>, entry: FolderFileEntry, limit: usize) {
    let candidate_count = limit.saturating_add(1);
    entries.push(entry);
    if entries.len() > candidate_count.saturating_mul(2) {
        entries.select_nth_unstable_by(candidate_count, compare_folder_file_entries);
        entries.truncate(candidate_count);
    }
}

#[tauri::command]
pub async fn list_document_page(
    request: DocumentPageRequest,
    state: State<'_, AppState>,
) -> Result<DocumentPage, String> {
    let root = {
        let store = read_lock(&state.memo_file, "memo_file");
        let config = store
            .get_notebook_config_by_id(&request.notebook_id)
            .ok_or("NOTEBOOK_NOT_FOUND")?;
        dunce::canonicalize(&config.path).map_err(|error| error.to_string())?
    };
    let folder = dunce::canonicalize(&request.folder_path).map_err(|error| error.to_string())?;
    let policy = FileManagementPolicy::from_notebook_root(&root);
    let visibility = super::file::tree_visibility_for(state.inner(), true);
    if !folder.is_dir()
        || !folder.starts_with(&root)
        || folder
            .strip_prefix(&root)
            .is_ok_and(|relative| policy.is_tree_hidden_at(&root, relative))
    {
        return Err("INVALID_NOTEBOOK_FOLDER".into());
    }
    let cursor = request.cursor.as_deref().map(decode_cursor).transpose()?;
    let limit = request.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let resource_kinds = request.resource_kinds;
    tauri::async_runtime::spawn_blocking(move || {
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
            let name = entry.file_name().to_string_lossy().to_string();
            // 展示口径与文件树一致：文件夹看目录规则，文件看文件通配表。
            // `.index.yaml` 因此不再需要单独特判。
            if visibility.hides_entry(&name, file_type.is_dir()) {
                continue;
            }
            let relative = match path.strip_prefix(&root) {
                Ok(relative) => relative,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                if cursor.is_none() {
                    let metadata = match entry.metadata() {
                        Ok(metadata) => metadata,
                        Err(error) => { tracing::debug!(path = %path.display(), "skip unreadable document folder metadata: {error}"); continue; }
                    };
                    let modified = metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|duration| duration.as_millis().min(u64::MAX as u128) as u64);
                    let created = metadata.created().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|duration| duration.as_millis().min(u64::MAX as u128) as u64);
                    folders.push(DocumentPageItem {
                        name,
                        full_path: path.to_string_lossy().into_owned(),
                        resource_kind: "folder".into(),
                        asset_kind: None,
                        is_directory: Some(true),
                        size_bytes: None,
                        modified_ms: modified,
                        created_ms: created,
                    });
                }
                continue;
            }
            if !file_type.is_file() { continue; }
            let resource_kind = kind(&path).to_owned();
            if !resource_kinds.is_empty() && !resource_kinds.iter().any(|kind| kind == &resource_kind) {
                continue;
            }
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
            let relative_path = relative.to_string_lossy().replace('\\', "/");
            if cursor.as_ref().is_some_and(|(time, cursor_path)| {
                modified_ms > *time || (modified_ms == *time && relative_path <= *cursor_path)
            }) {
                continue;
            }
            push_folder_page_candidate(&mut entries, FolderFileEntry {
                relative_path,
                resource_kind,
                modified_ms,
                created_ms,
                size_bytes: metadata.len(),
            }, limit);
        }
        folders.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()).then_with(|| left.name.cmp(&right.name)));
        let (entries, has_more) = retain_folder_page_entries(entries, limit);

        let mut items = Vec::new();
        let mut last = None;
        for entry in entries {
            last = Some(format!("{}:{}", entry.modified_ms, entry.relative_path));
            let full_path = root.join(Path::new(&entry.relative_path));
            items.push(DocumentPageItem {
                name: full_path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                full_path: full_path.to_string_lossy().into_owned(),
                resource_kind: entry.resource_kind,
                asset_kind: None,
                is_directory: Some(false),
                modified_ms: Some(entry.modified_ms.max(0) as u64),
                created_ms: entry.created_ms.map(|value| value.max(0) as u64),
                size_bytes: Some(entry.size_bytes),
            });
        }
        Ok(DocumentPage { folders, next_cursor: if has_more { last } else { None }, has_more, items })
    }).await.map_err(|error| error.to_string())?
}

/// List the notebook's indexed work documents across all folders. The shared
/// resource catalog supplies metadata only; document contents are not parsed.
#[tauri::command]
pub async fn list_work_documents_page(
    notebook_id: String,
    cursor: Option<String>,
    limit: Option<usize>,
    resource_kinds: Option<Vec<String>>,
    path: Option<String>,
    file_name_contains: Option<String>,
    app: AppHandle,
) -> Result<DocumentPage, String> {
    crate::document_io::run("list_work_documents_page", move || {
        let state = app.state::<AppState>();
        let store = read_lock(&state.memo_file, "memo_file");
        let config = store
            .get_notebook_config_by_id(&notebook_id)
            .ok_or("NOTEBOOK_NOT_FOUND")?;
        let root = dunce::canonicalize(&config.path).map_err(|error| error.to_string())?;
        let visibility = super::file::tree_visibility_for(state.inner(), true);
        let all_kinds = [
            ResourceKind::Document,
            ResourceKind::Spreadsheet,
            ResourceKind::Presentation,
            ResourceKind::Web,
            ResourceKind::Archive,
            ResourceKind::Database,
        ];
        let parse_kind = |kind: &str| match kind {
            "document" => Some(ResourceKind::Document),
            "spreadsheet" => Some(ResourceKind::Spreadsheet),
            "presentation" => Some(ResourceKind::Presentation),
            "web" => Some(ResourceKind::Web),
            "archive" => Some(ResourceKind::Archive),
            "database" => Some(ResourceKind::Database),
            _ => None,
        };
        let selected_kinds = match resource_kinds.as_deref() {
            None => all_kinds.to_vec(),
            // 空选/全选等价：列表面板类目内全部。
            Some(kinds) => {
                let parsed: Option<Vec<ResourceKind>> = kinds
                    .iter()
                    .filter(|kind| kind.as_str() != "any")
                    .map(|kind| parse_kind(kind))
                    .collect();
                match parsed {
                    None => return Err("INVALID_WORK_DOCUMENT_KIND".into()),
                    Some(kinds) if kinds.is_empty() => all_kinds.to_vec(),
                    Some(kinds) => kinds,
                }
            }
        };
        let selected_path = path
            .unwrap_or_default()
            .trim()
            .replace('\\', "/")
            .trim_matches('/')
            .to_owned();
        if selected_path.starts_with('/')
            || selected_path
                .split('/')
                .any(|part| part == ".." || part == ".")
        {
            return Err("INVALID_WORK_DOCUMENT_PATH".into());
        }
        let selected_name = file_name_contains.unwrap_or_default().trim().to_lowercase();
        let mut scan_cursor = cursor.as_deref().map(decode_cursor).transpose()?;
        let limit = limit.unwrap_or(48).clamp(1, 100);
        let mut items = Vec::with_capacity(limit);
        let mut last_selected_cursor = None;
        let mut has_more = false;
        'pages: loop {
            let page = store
                .list_indexed_resources_page(&notebook_id, &selected_kinds, scan_cursor, 120)
                .map_err(|error| error.to_string())?;
            for resource in page.resources {
                let relative = Path::new(&resource.relative_path);
                if relative.is_absolute()
                    || relative.components().any(|part| {
                        matches!(
                            part,
                            std::path::Component::ParentDir | std::path::Component::CurDir
                        )
                    })
                    || visibility.hides_file_path(relative)
                {
                    continue;
                }
                let parent = relative
                    .parent()
                    .unwrap_or_else(|| Path::new(""))
                    .to_string_lossy()
                    .replace('\\', "/");
                if !selected_path.is_empty()
                    && parent != selected_path
                    && !parent.starts_with(&format!("{selected_path}/"))
                {
                    continue;
                }
                let name = relative
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned();
                if !selected_name.is_empty() && !name.to_lowercase().contains(&selected_name) {
                    continue;
                }
                let path = root.join(relative);
                let canonical = match dunce::canonicalize(&path) {
                    Ok(path) if path.starts_with(&root) => path,
                    _ => continue,
                };
                let metadata = match fs::symlink_metadata(&path) {
                    Ok(metadata) => metadata,
                    Err(_) => continue,
                };
                if metadata.file_type().is_symlink()
                    || (resource.is_directory && !metadata.is_dir())
                    || (!resource.is_directory && !metadata.is_file())
                {
                    continue;
                }
                if items.len() == limit {
                    has_more = true;
                    break 'pages;
                }
                items.push(DocumentPageItem {
                    name,
                    full_path: canonical.to_string_lossy().into_owned(),
                    resource_kind: "other".into(),
                    asset_kind: Some(resource.kind.as_str().into()),
                    is_directory: Some(resource.is_directory),
                    size_bytes: Some(resource.size_bytes),
                    modified_ms: Some(resource.modified_ms),
                    created_ms: Some(resource.created_at.max(0) as u64),
                });
                last_selected_cursor = Some(format!("{}:{}", resource.modified_ms, resource.id));
            }
            if !page.has_more {
                break;
            }
            scan_cursor = page.next_cursor.as_deref().map(decode_cursor).transpose()?;
            if scan_cursor.is_none() {
                break;
            }
        }
        Ok(DocumentPage {
            folders: Vec::new(),
            items,
            next_cursor: if has_more { last_selected_cursor } else { None },
            has_more,
        })
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::{push_folder_page_candidate, retain_folder_page_entries, FolderFileEntry};

    fn entry(relative_path: &str, modified_ms: i64) -> FolderFileEntry {
        FolderFileEntry {
            relative_path: relative_path.into(),
            resource_kind: "other".into(),
            modified_ms,
            created_ms: None,
            size_bytes: 0,
        }
    }

    #[test]
    fn folder_page_sorts_only_the_requested_rows_and_one_lookahead() {
        let candidates = vec![
            entry("old.md", 1),
            entry("tie-b.md", 5),
            entry("new.md", 9),
            entry("tie-a.md", 5),
            entry("middle.md", 7),
        ];

        let (page, has_more) = retain_folder_page_entries(candidates, 2);

        assert!(has_more);
        assert_eq!(
            page.iter()
                .map(|item| item.relative_path.as_str())
                .collect::<Vec<_>>(),
            ["new.md", "middle.md"]
        );
    }

    #[test]
    fn folder_page_uses_path_as_the_stable_tie_breaker() {
        let candidates = vec![entry("b.md", 5), entry("a.md", 5)];

        let (page, has_more) = retain_folder_page_entries(candidates, 2);

        assert!(!has_more);
        assert_eq!(
            page.iter()
                .map(|item| item.relative_path.as_str())
                .collect::<Vec<_>>(),
            ["a.md", "b.md"]
        );
    }

    #[test]
    fn folder_page_candidate_buffer_stays_bounded_and_keeps_the_same_page() {
        let candidates = (0..200)
            .map(|index| entry(&format!("note-{index:03}.md"), (index * 17 % 31) as i64))
            .collect::<Vec<_>>();
        let mut bounded = Vec::new();
        for candidate in candidates.iter().cloned() {
            push_folder_page_candidate(&mut bounded, candidate, 5);
            assert!(bounded.len() <= 2 * (5 + 1));
        }

        let (expected, expected_has_more) = retain_folder_page_entries(candidates, 5);
        let (actual, actual_has_more) = retain_folder_page_entries(bounded, 5);
        assert_eq!(actual_has_more, expected_has_more);
        assert_eq!(
            actual.iter().map(|item| &item.relative_path).collect::<Vec<_>>(),
            expected.iter().map(|item| &item.relative_path).collect::<Vec<_>>(),
        );
    }
}
