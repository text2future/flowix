//! Read-only collection dataset access shared by the CLI and MCP operation layer.
use crate::{errors::CliError, store};
use flowix_core::{
    collection::{valid_id, CollectionDocument, CollectionType},
    memo_file::FileManagementPolicy,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

pub(crate) fn read(
    notebook_key: &str,
    collection_id: Option<&str>,
    relative_path: Option<&str>,
) -> Result<Value, CliError> {
    if collection_id.is_some() == relative_path.is_some() {
        return Err(CliError::Usage(
            "collection read requires exactly one of collection id or path".into(),
        ));
    }

    let memo = store::open()?;
    let notebook = flowix_core::MemoService::new(&memo).resolve_notebook(notebook_key)?;
    let root = fs::canonicalize(&notebook.path)?;
    let policy = FileManagementPolicy::from_notebook_root(&root);
    let (path, document) = if let Some(id) = collection_id {
        let catalog_path = PathBuf::from(&notebook.path)
            .join(".flowix")
            .join("notebook.db");
        find_by_id(&root, &policy, &catalog_path, id)?
    } else {
        read_by_path(&root, &policy, relative_path.expect("selector checked"))?
    };
    document.validate().map_err(CliError::Other)?;
    let relative_path = path
        .strip_prefix(&root)
        .map_err(|error| CliError::Other(error.to_string()))?
        .to_string_lossy()
        .replace('\\', "/");

    Ok(json!({
        "ok": true,
        "action": "collection.read",
        "notebookId": notebook.id,
        "notebook": notebook.name,
        "relativePath": relative_path,
        "collection": {
            "id": document.collection.id,
            "type": document.collection.kind.as_str(),
            "name": document.collection.name,
            "revision": document.collection.revision,
            "createdAt": document.collection.created_at,
            "updatedAt": document.collection.updated_at,
            "properties": document.collection.properties,
        },
        "payload": document.payload,
    }))
}

fn read_by_path(
    root: &Path,
    policy: &FileManagementPolicy,
    raw_path: &str,
) -> Result<(PathBuf, CollectionDocument), CliError> {
    let relative = normalize_relative_path(raw_path)?;
    if policy.is_ignored_at(root, &relative) {
        return Err(CliError::NotFound(format!(
            "collection not found: {raw_path}"
        )));
    }
    let path = root.join(&relative);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| CliError::NotFound(format!("collection not found: {raw_path}")))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || collection_type(&path).is_none()
    {
        return Err(CliError::Usage(
            "path must name a collection file inside the notebook".into(),
        ));
    }
    let canonical = fs::canonicalize(&path)?;
    if !canonical.starts_with(root) {
        return Err(CliError::Usage(
            "collection path is outside the notebook".into(),
        ));
    }
    let canonical_relative = canonical
        .strip_prefix(root)
        .map_err(|error| CliError::Other(error.to_string()))?;
    if policy.is_ignored_at(root, canonical_relative) {
        return Err(CliError::NotFound(format!(
            "collection not found: {raw_path}"
        )));
    }
    let source = fs::read_to_string(&canonical)?;
    let document = CollectionDocument::parse(&source).map_err(CliError::Other)?;
    validate_file_type(&canonical, document.collection.kind)?;
    Ok((canonical, document))
}

fn find_by_id(
    root: &Path,
    policy: &FileManagementPolicy,
    catalog_path: &Path,
    id: &str,
) -> Result<(PathBuf, CollectionDocument), CliError> {
    if !valid_id(id, "col_") {
        return Err(CliError::Usage("invalid collection id".into()));
    }
    if let Some(path) = indexed_collection_path(catalog_path, id)? {
        if let Some(matched) = read_matching_collection(root, policy, &root.join(path), id) {
            return Ok(matched);
        }
    }

    // The catalog is a rebuildable projection. Fall back to the files when it
    // is absent or stale, so CLI/MCP reads still work before the desktop has
    // populated the collection index or after an external file move.
    let mut matches = Vec::new();
    collect_collection_files(root, root, policy, &mut matches)?;
    let mut found = Vec::new();
    for path in matches {
        if let Some(matched) = read_matching_collection(root, policy, &path, id) {
            found.push(matched);
        }
    }
    match found.len() {
        0 => Err(CliError::NotFound(format!("collection not found: {id}"))),
        1 => Ok(found.remove(0)),
        _ => Err(CliError::Other("COLLECTION_IDENTITY_CONFLICT".into())),
    }
}

fn indexed_collection_path(catalog_path: &Path, id: &str) -> Result<Option<PathBuf>, CliError> {
    if !catalog_path.is_file() {
        return Ok(None);
    }
    let Ok(connection) = Connection::open(catalog_path) else {
        return Ok(None);
    };
    let mut statement = match connection
        .prepare("SELECT relative_path FROM collection_documents WHERE collection_id = ?1")
    {
        Ok(statement) => statement,
        Err(_) => return Ok(None),
    };
    let rows = statement.query_map([id], |row| row.get::<_, String>(0));
    let Ok(rows) = rows else {
        return Ok(None);
    };
    let paths = rows.collect::<Result<Vec<_>, _>>();
    let Ok(paths) = paths else {
        return Ok(None);
    };
    match paths.as_slice() {
        [] => Ok(None),
        [path] => Ok(Some(PathBuf::from(path))),
        // Duplicate rows can be stale after external file changes; verify the
        // source files before reporting an identity conflict.
        _ => Ok(None),
    }
}

fn read_matching_collection(
    root: &Path,
    policy: &FileManagementPolicy,
    candidate_path: &Path,
    id: &str,
) -> Option<(PathBuf, CollectionDocument)> {
    let path = if candidate_path.is_absolute() {
        candidate_path.to_owned()
    } else {
        root.join(candidate_path)
    };
    let relative_path = path.strip_prefix(root).ok()?;
    if relative_path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
        || policy.is_ignored_at(root, relative_path)
    {
        return None;
    }
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || collection_type(&path).is_none()
    {
        return None;
    }
    let canonical = fs::canonicalize(&path).ok()?;
    if !canonical.starts_with(root) {
        return None;
    }
    let source = fs::read_to_string(&canonical).ok()?;
    let document = CollectionDocument::parse(&source).ok()?;
    if document.collection.id != id
        || validate_file_type(&canonical, document.collection.kind).is_err()
    {
        return None;
    }
    Some((canonical, document))
}

fn collect_collection_files(
    root: &Path,
    directory: &Path,
    policy: &FileManagementPolicy,
    output: &mut Vec<PathBuf>,
) -> Result<(), CliError> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|error| CliError::Other(error.to_string()))?;
        if policy.is_ignored_at(root, relative) {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_collection_files(root, &path, policy, output)?;
        } else if file_type.is_file() && collection_type(&path).is_some() {
            output.push(path);
        }
    }
    Ok(())
}

fn normalize_relative_path(raw_path: &str) -> Result<PathBuf, CliError> {
    let normalized = raw_path.replace('\\', "/");
    let path = Path::new(&normalized);
    if normalized.trim().is_empty()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(CliError::Usage(
            "collection path must be a notebook-relative path without `.` or `..`".into(),
        ));
    }
    Ok(path.to_owned())
}

fn collection_type(path: &Path) -> Option<CollectionType> {
    let filename = path.file_name()?.to_string_lossy().to_ascii_lowercase();
    if filename.ends_with(".table.yml") || filename.ends_with(".table.yaml") {
        Some(CollectionType::Table)
    } else if filename.ends_with(".lib.yml") || filename.ends_with(".lib.yaml") {
        Some(CollectionType::MediaLibrary)
    } else {
        None
    }
}

fn validate_file_type(path: &Path, actual: CollectionType) -> Result<(), CliError> {
    if collection_type(path) != Some(actual) {
        return Err(CliError::Other("COLLECTION_TYPE_EXTENSION_MISMATCH".into()));
    }
    Ok(())
}
