//! Notebook-owned collection catalog, mutations and recoverable file operations.
use crate::{app::state::AppState, lock_utils::read_lock};
use flowix_core::{
    collection::{
        valid_id, validate_properties, CollectionDocument, CollectionProperty, CollectionType,
    },
    memo_file::{atomic_write_bytes, rename_file_noclobber, FileLockIntent, FileManagementPolicy, MemoFile},
};
use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::UNIX_EPOCH,
};
use tauri::{Emitter, State};

static CATALOGS: OnceLock<Mutex<HashMap<String, Arc<Mutex<bool>>>>> = OnceLock::new();
fn catalog_lock(id: &str) -> Result<Arc<Mutex<bool>>, String> {
    let mut catalogs = CATALOGS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "COLLECTION_LOCK_FAILED")?;
    Ok(catalogs.entry(id.to_owned()).or_default().clone())
}
pub fn collection_type_for_path(path: &Path) -> Option<CollectionType> {
    let name = path.file_name()?.to_str()?.to_lowercase();
    if name.ends_with(".table.yml") || name.ends_with(".table.yaml") {
        Some(CollectionType::Table)
    } else if name.ends_with(".lib.yaml") || name.ends_with(".lib.yml") {
        Some(CollectionType::MediaLibrary)
    } else {
        None
    }
}
fn exact_path_exists(path: &Path) -> bool {
    path.parent()
        .and_then(|parent| fs::read_dir(parent).ok())
        .is_some_and(|entries| {
            entries
                .filter_map(Result::ok)
                .any(|entry| Some(entry.file_name().as_os_str()) == path.file_name())
        })
}
fn exact_path_exists_checked(path: &Path) -> Result<bool, String> {
    let parent = path.parent().ok_or("INVALID_COLLECTION_PATH")?;
    let entries = match fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if Some(entry.file_name().as_os_str()) == path.file_name() {
            return Ok(true);
        }
    }
    Ok(false)
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionIndexItem {
    pub index_sequence: i64,
    pub relative_path: String,
    pub collection_id: Option<String>,
    pub collection_type: CollectionType,
    pub name: String,
    pub schema_version: Option<i64>,
    pub payload_schema_version: Option<i64>,
    pub revision: Option<i64>,
    pub properties: serde_json::Value,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub modified_ms: u64,
    pub size_bytes: u64,
    pub content_hash: Option<String>,
    pub parse_state: String,
    pub error_code: Option<String>,
    pub in_views: bool,
    pub identity_conflict: bool,
}
pub struct CollectionCatalog {
    root: PathBuf,
    conn: Connection,
}
impl CollectionCatalog {
    pub fn open(memo: &MemoFile, id: &str) -> Result<Self, String> {
        let notebook = memo
            .get_notebook_config_by_id(id)
            .ok_or("NOTEBOOK_NOT_FOUND")?;
        let root = dunce::canonicalize(&notebook.path).map_err(|e| e.to_string())?;
        let conn = Connection::open(memo.notebook_db_path(id).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(10))
            .map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS collection_documents (
              relative_path TEXT PRIMARY KEY, collection_id TEXT, collection_type TEXT NOT NULL,
              name TEXT NOT NULL, schema_version INTEGER, payload_schema_version INTEGER, revision INTEGER,
              properties_json TEXT NOT NULL, created_at TEXT, updated_at TEXT, modified_ms INTEGER NOT NULL,
              size_bytes INTEGER NOT NULL, content_hash TEXT, parse_state TEXT NOT NULL, error_code TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_collection_documents_id ON collection_documents(collection_id);
            CREATE INDEX IF NOT EXISTS idx_collection_documents_type_name ON collection_documents(collection_type,name COLLATE NOCASE,relative_path);
            CREATE TABLE IF NOT EXISTS collection_state(collection_id TEXT PRIMARY KEY, in_views INTEGER NOT NULL DEFAULT 0 CHECK(in_views IN (0,1)), pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)), sort_order INTEGER);
            CREATE TABLE IF NOT EXISTS collection_catalog_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
            INSERT OR IGNORE INTO collection_catalog_meta VALUES('schema_version',1),('sequence',0);
            CREATE TABLE IF NOT EXISTS collection_operations(operation_id TEXT PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL, error_code TEXT);")
            .map_err(|e| e.to_string())?;
        Ok(Self { root, conn })
    }
    fn checked_path(&self, relative: &str) -> Result<PathBuf, String> {
        Self::checked_path_at_root(&self.root, relative)
    }
    fn checked_path_at_root(root: &Path, relative: &str) -> Result<PathBuf, String> {
        let path = Path::new(relative);
        if relative.contains('\\')
            || relative.contains('\0')
            || path.as_os_str().is_empty()
            || path
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err("INVALID_COLLECTION_PATH".into());
        }
        let result = root.join(path);
        let parent = dunce::canonicalize(result.parent().ok_or("INVALID_COLLECTION_PATH")?)
            .map_err(|e| e.to_string())?;
        if !parent.starts_with(root)
            || FileManagementPolicy::from_notebook_root(root).is_ignored_at(root, path)
        {
            return Err("PATH_OUTSIDE_NOTEBOOK".into());
        }
        if let Ok(meta) = fs::symlink_metadata(&result) {
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err("COLLECTION_NOT_REGULAR_FILE".into());
            }
        }
        Ok(result)
    }
    fn inspect(&self, path: &Path) -> Result<CollectionIndexItem, String> {
        Self::inspect_at_root(&self.root, path)
    }
    fn inspect_at_root(root: &Path, path: &Path) -> Result<CollectionIndexItem, String> {
        let kind = collection_type_for_path(path).ok_or("UNSUPPORTED_COLLECTION_FILE")?;
        let relative = path
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        Self::checked_path_at_root(root, &relative)?;
        let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |v| v.as_millis().min(u64::MAX as u128) as u64);
        let source = fs::read_to_string(path);
        let mut item = CollectionIndexItem {
            index_sequence: 0,
            relative_path: relative,
            collection_id: None,
            collection_type: kind,
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            schema_version: None,
            payload_schema_version: None,
            revision: None,
            properties: serde_json::json!({}),
            created_at: None,
            updated_at: None,
            modified_ms,
            size_bytes: metadata.len(),
            content_hash: source
                .as_ref()
                .ok()
                .map(|s| format!("{:x}", Sha256::digest(s.as_bytes()))),
            parse_state: "invalid".into(),
            error_code: None,
            in_views: false,
            identity_conflict: false,
        };
        match source
            .map_err(|e| e.to_string())
            .and_then(|s| CollectionDocument::parse(&s))
        {
            Ok(document) => {
                item.collection_id = Some(document.collection.id.clone());
                item.name = document.collection.name.clone();
                item.schema_version = Some(document.schema_version);
                item.payload_schema_version = document.payload["schema_version"].as_i64();
                item.revision = Some(document.collection.revision);
                item.properties = serde_json::to_value(&document.collection.properties)
                    .map_err(|e| e.to_string())?;
                item.created_at = Some(document.collection.created_at.clone());
                item.updated_at = Some(document.collection.updated_at.clone());
                if document.collection.kind != kind {
                    item.error_code = Some("COLLECTION_TYPE_EXTENSION_MISMATCH".into());
                } else if !document.supported() {
                    item.parse_state = "unsupported".into();
                    item.error_code = Some("UNSUPPORTED_COLLECTION_VERSION".into());
                } else {
                    match document.validate() {
                        Ok(()) => item.parse_state = "valid".into(),
                        Err(e) => item.error_code = Some(e),
                    }
                }
            }
            Err(e) => item.error_code = Some(e),
        }
        Ok(item)
    }
    fn upsert(conn: &Connection, item: &CollectionIndexItem) -> Result<(), String> {
        conn.execute("INSERT INTO collection_documents VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
            ON CONFLICT(relative_path) DO UPDATE SET collection_id=excluded.collection_id,collection_type=excluded.collection_type,name=excluded.name,
            schema_version=excluded.schema_version,payload_schema_version=excluded.payload_schema_version,revision=excluded.revision,properties_json=excluded.properties_json,
            created_at=excluded.created_at,updated_at=excluded.updated_at,modified_ms=excluded.modified_ms,size_bytes=excluded.size_bytes,content_hash=excluded.content_hash,parse_state=excluded.parse_state,error_code=excluded.error_code",
            params![item.relative_path,item.collection_id,item.collection_type.as_str(),item.name,item.schema_version,item.payload_schema_version,item.revision,
                item.properties.to_string(),item.created_at,item.updated_at,item.modified_ms as i64,item.size_bytes as i64,item.content_hash,item.parse_state,item.error_code]).map_err(|e| e.to_string())?;
        Ok(())
    }
    fn advance(conn: &Connection) -> Result<i64, String> {
        conn.execute(
            "UPDATE collection_catalog_meta SET value=value+1 WHERE key='sequence'",
            [],
        )
        .map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT value FROM collection_catalog_meta WHERE key='sequence'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())
    }
    pub fn reconcile(&mut self) -> Result<(), String> {
        let policy = FileManagementPolicy::from_notebook_root(&self.root);
        let mut pending = vec![self.root.clone()];
        let mut paths = HashSet::new();
        // A failed directory read aborts before deleting any trusted catalog row.
        while let Some(folder) = pending.pop() {
            for entry in fs::read_dir(&folder).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                let kind = entry.file_type().map_err(|e| e.to_string())?;
                if kind.is_symlink()
                    || policy.is_tree_hidden_at(
                        &self.root,
                        path.strip_prefix(&self.root).map_err(|e| e.to_string())?,
                    )
                {
                    continue;
                }
                if kind.is_dir() {
                    if !entry.file_name().to_string_lossy().starts_with('.') {
                        pending.push(path);
                    }
                } else if collection_type_for_path(&path).is_some() {
                    paths.insert(path);
                }
            }
        }
        let indexed = {
            let mut statement = self.conn.prepare("SELECT relative_path FROM collection_documents")
                .map_err(|error| error.to_string())?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
        };
        for relative in indexed {
            paths.insert(self.root.join(relative));
        }
        let mut paths: Vec<_> = paths.into_iter().collect();
        paths.sort();
        for chunk in paths.chunks(32) {
            self.refresh(chunk)?;
        }
        Ok(())
    }
    pub fn refresh(&mut self, paths: &[PathBuf]) -> Result<i64, String> {
        let root = self.root.clone();
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        for path in paths {
            if let Ok(relative) = path.strip_prefix(&root) {
                let relative = relative.to_string_lossy().replace('\\', "/");
                let hidden = FileManagementPolicy::from_notebook_root(&root)
                    .is_tree_hidden_at(&root, Path::new(&relative));
                let item = if exact_path_exists_checked(path)?
                    && !hidden
                    && collection_type_for_path(path).is_some()
                {
                    Some(Self::inspect_at_root(&root, path)?)
                } else {
                    None
                };
                if let Some(item) = item {
                    Self::upsert(&tx, &item)?;
                } else {
                    tx.execute(
                        "DELETE FROM collection_documents WHERE relative_path=?1",
                        [relative],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
        }
        let sequence = Self::advance(&tx)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(sequence)
    }
    pub fn list(&self, kind: Option<CollectionType>) -> Result<Vec<CollectionIndexItem>, String> {
        let mut statement = self.conn.prepare("SELECT d.relative_path,d.collection_id,d.collection_type,d.name,d.schema_version,d.payload_schema_version,d.revision,d.properties_json,d.created_at,d.updated_at,d.modified_ms,d.size_bytes,d.content_hash,d.parse_state,d.error_code,COALESCE(s.in_views,0),(SELECT COUNT(*)>1 FROM collection_documents x WHERE x.collection_id=d.collection_id),(SELECT value FROM collection_catalog_meta WHERE key='sequence') FROM collection_documents d LEFT JOIN collection_state s ON s.collection_id=d.collection_id WHERE (?1 IS NULL OR d.collection_type=?1) ORDER BY d.name COLLATE NOCASE,d.relative_path").map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([kind.map(CollectionType::as_str)], |row| {
                let kind: String = row.get(2)?;
                Ok(CollectionIndexItem {
                    index_sequence: row.get(17)?,
                    relative_path: row.get(0)?,
                    collection_id: row.get(1)?,
                    collection_type: if kind == "table" {
                        CollectionType::Table
                    } else {
                        CollectionType::MediaLibrary
                    },
                    name: row.get(3)?,
                    schema_version: row.get(4)?,
                    payload_schema_version: row.get(5)?,
                    revision: row.get(6)?,
                    properties: serde_json::from_str(&row.get::<_, String>(7)?)
                        .unwrap_or(serde_json::json!({})),
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                    modified_ms: row.get::<_, i64>(10)?.max(0) as u64,
                    size_bytes: row.get::<_, i64>(11)?.max(0) as u64,
                    content_hash: row.get(12)?,
                    parse_state: row.get(13)?,
                    error_code: row.get(14)?,
                    in_views: row.get::<_, i64>(15)? != 0,
                    identity_conflict: row.get(16)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
    fn resolve(&mut self, id: &str) -> Result<CollectionIndexItem, String> {
        if !valid_id(id, "col_") {
            return Err("INVALID_COLLECTION_ID".into());
        }
        let mut items = self
            .list(None)?
            .into_iter()
            .filter(|i| i.collection_id.as_deref() == Some(id))
            .collect::<Vec<_>>();
        // A stale path may be an externally moved file. Resolve by identity again.
        if items.len() != 1
            || fs::read_to_string(self.root.join(&items[0].relative_path))
                .ok()
                .and_then(|source| CollectionDocument::parse(&source).ok())
                .is_none_or(|document| document.collection.id != id)
        {
            self.reconcile()?;
            items = self
                .list(None)?
                .into_iter()
                .filter(|i| i.collection_id.as_deref() == Some(id))
                .collect();
        }
        match items.len() {
            0 => Err("COLLECTION_NOT_FOUND".into()),
            1 => {
                let item = items.remove(0);
                let path = self.checked_path(&item.relative_path)?;
                let inspected = self.inspect(&path)?;
                if inspected.content_hash != item.content_hash {
                    self.refresh(&[path])?;
                }
                let mut next = inspected;
                next.in_views = item.in_views;
                next.index_sequence = self
                    .conn
                    .query_row(
                        "SELECT value FROM collection_catalog_meta WHERE key='sequence'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                Ok(next)
            }
            _ => Err("COLLECTION_IDENTITY_CONFLICT".into()),
        }
    }
    fn read(
        &mut self,
        id: &str,
    ) -> Result<(CollectionIndexItem, PathBuf, String, CollectionDocument), String> {
        let item = self.resolve(id)?;
        let path = self.checked_path(&item.relative_path)?;
        let source = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let document = CollectionDocument::parse(&source)?;
        if document.collection.id != id {
            return Err("COLLECTION_IDENTITY_CHANGED".into());
        }
        document.validate()?;
        Ok((item, path, source, document))
    }
    fn recover(&mut self) -> Result<(), String> {
        let pending = {
            let mut statement = self
                .conn
                .prepare("SELECT body FROM collection_operations WHERE status='pending'")
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        for body in pending {
            let operation: FileOperation =
                serde_json::from_str(&body).map_err(|e| e.to_string())?;
            if let Err(error) = self.apply_operation(&operation) {
                self.conn.execute("UPDATE collection_operations SET status='blocked',error_code=?2 WHERE operation_id=?1",params![operation.operation_id,error]).map_err(|e|e.to_string())?;
            }
        }
        Ok(())
    }
    fn apply_operation(&mut self, operation: &FileOperation) -> Result<i64, String> {
        let source = self.checked_path(&operation.previous_path)?;
        let target = self.checked_path(&operation.target_path)?;
        let temporary = operation
            .temporary_path
            .as_ref()
            .map(|relative| self.checked_path(relative))
            .transpose()?;
        let mut current = if exact_path_exists(&source) {
            source.clone()
        } else if temporary
            .as_ref()
            .is_some_and(|path| exact_path_exists(path))
        {
            temporary.clone().unwrap()
        } else {
            target.clone()
        };
        let disk = fs::read_to_string(&current).map_err(|e| e.to_string())?;
        let document = CollectionDocument::parse(&disk)?;
        if document.collection.id != operation.collection_id {
            return Err("COLLECTION_IDENTITY_CHANGED".into());
        }
        if disk != operation.expected_content && disk != operation.next_content {
            return Err("COLLECTION_CONTENT_CONFLICT".into());
        }
        let target_aliases_source = operation.temporary_path.is_some() && current == source;
        if source != target && current != target && target.exists() && !target_aliases_source {
            return Err("FILE_EXISTS".into());
        }
        if disk != operation.next_content {
            atomic_write_bytes(&current, operation.next_content.as_bytes())
                .map_err(|e| e.to_string())?;
        }
        if source != target && current != target {
            if let Some(temporary) = &temporary {
                if current == source {
                    rename_file_noclobber(&source, temporary).map_err(|e| e.to_string())?;
                    current = temporary.clone();
                }
            }
            rename_file_noclobber(&current, &target).map_err(|e| e.to_string())?;
        }
        let mut paths = vec![source, target];
        if let Some(temporary) = temporary {
            paths.push(temporary);
        }
        let sequence = self.refresh(&paths)?;
        self.conn.execute("UPDATE collection_operations SET status='completed',error_code=NULL WHERE operation_id=?1",[&operation.operation_id]).map_err(|e|e.to_string())?;
        Ok(sequence)
    }
}
fn with_catalog<T>(
    memo: &MemoFile,
    id: &str,
    action: impl FnOnce(&mut CollectionCatalog) -> Result<T, String>,
) -> Result<T, String> {
    let lock = catalog_lock(id)?;
    let mut ready = lock.lock().map_err(|_| "COLLECTION_LOCK_FAILED")?;
    let mut catalog = CollectionCatalog::open(memo, id)?;
    if !*ready {
        catalog.reconcile()?;
        *ready = true;
    }
    drop(ready);
    action(&mut catalog)
}
pub(crate) fn refresh_catalog(memo: &MemoFile, id: &str) -> Result<(), String> {
    let _guard = memo.operation_locks().notebook_read(id, "refresh_collection_catalog")
        .map_err(|error| error.to_string())?;
    with_catalog(memo, id, |catalog| catalog.reconcile())
}
pub(crate) fn refresh_path(memo: &MemoFile, path: &Path) {
    if collection_type_for_path(path).is_none() {
        return;
    }
    let Ok(notebooks) = memo.read_notebook_configs() else {
        return;
    };
    let mut candidates = notebooks
        .into_iter()
        .filter_map(|notebook| {
            let root = dunce::canonicalize(&notebook.path).ok()?;
            path.strip_prefix(&root).ok()?;
            Some((notebook.id, root))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(_, root)| std::cmp::Reverse(root.components().count()));
    if let Some((id, _)) = candidates.first() {
        let _guard = match memo.operation_locks().notebook_read(id, "refresh_collection_path") {
            Ok(guard) => guard,
            Err(error) => {
                tracing::warn!(notebook_id = %id, %error, "collection index refresh lock failed");
                return;
            }
        };
        if let Err(error) = with_catalog(memo, id, |catalog| {
            catalog.refresh(&[path.to_owned()]).map(|_| ())
        }) {
            tracing::warn!(%error,"collection index refresh failed");
        }
    }
}
pub(crate) fn list_for_rebase(
    memo: &MemoFile,
    id: &str,
) -> Result<Vec<CollectionIndexItem>, String> {
    with_catalog(memo, id, |catalog| catalog.list(None))
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileOperation {
    operation_id: String,
    collection_id: String,
    previous_path: String,
    target_path: String,
    temporary_path: Option<String>,
    expected_content: String,
    next_content: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionMutation {
    pub notebook_id: String,
    pub collection_id: String,
    pub expected_revision: i64,
    pub operation_id: String,
    pub new_name: Option<String>,
    pub target_relative_path: Option<String>,
    pub properties: Option<std::collections::BTreeMap<String, Option<CollectionProperty>>>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionMutationResult {
    pub operation_id: String,
    pub status: String,
    pub collection_id: String,
    pub actual_name: String,
    pub previous_relative_path: String,
    pub notebook_path: String,
    pub actual_relative_path: String,
    pub actual_revision: i64,
    pub index_sequence: i64,
    pub content: String,
    pub error_code: Option<String>,
}
fn target_relative_path(
    request: &CollectionMutation,
    item: &CollectionIndexItem,
    path: &Path,
    document: &CollectionDocument,
) -> Result<String, String> {
    if let Some(relative) = &request.target_relative_path {
        return Ok(relative.clone());
    }
    if request.new_name.is_none() {
        return Ok(item.relative_path.clone());
    }

    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("INVALID_COLLECTION_PATH")?;
    let lower = filename.to_lowercase();
    let extension = [".table.yaml", ".table.yml", ".lib.yaml", ".lib.yml"]
        .into_iter()
        .find(|extension| lower.ends_with(extension))
        .ok_or("UNSUPPORTED_COLLECTION_FILE")?;
    Ok(Path::new(&item.relative_path)
        .parent()
        .unwrap_or(Path::new(""))
        .join(format!("{}{extension}", document.collection.name))
        .to_string_lossy()
        .replace('\\', "/"))
}

fn actual_operation_path(
    catalog: &CollectionCatalog,
    target: &Path,
    temporary_path: Option<&str>,
    fallback: PathBuf,
    collection_id: &str,
) -> PathBuf {
    if exact_path_exists(target)
        && fs::read_to_string(target)
            .ok()
            .and_then(|source| CollectionDocument::parse(&source).ok())
            .is_some_and(|document| document.collection.id == collection_id)
    {
        return target.to_owned();
    }
    if let Some(temporary) = temporary_path {
        let temporary = catalog.root.join(temporary);
        if exact_path_exists(&temporary) {
            return temporary;
        }
    }
    fallback
}

fn mutate(
    memo: &MemoFile,
    request: &CollectionMutation,
) -> Result<CollectionMutationResult, String> {
    if request.operation_id.trim().is_empty() {
        return Err("INVALID_OPERATION_ID".into());
    }
    // A pending rename can change the path used to identify the file lock.
    // Finish recovery under the notebook's structural lock before resolving it.
    let pending = with_catalog(memo, &request.notebook_id, |catalog| {
        let count: i64 = catalog.conn.query_row(
            "SELECT COUNT(*) FROM collection_operations WHERE status='pending'",
            [], |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        Ok(count != 0)
    })?;
    if pending {
        memo.with_notebook_change(&[&request.notebook_id], "recover_collections", || {
            Ok(with_catalog(memo, &request.notebook_id, |catalog| catalog.recover()))
        }).map_err(|error| error.to_string())??;
    }
    if request.new_name.is_some() || request.target_relative_path.is_some() {
        return memo.with_notebook_change(&[&request.notebook_id], "mutate_collection_structure", || {
            with_catalog(memo, &request.notebook_id, |catalog| catalog.recover())
                .map_err(std::io::Error::other)?;
            Ok(mutate_locked(memo, request, None))
        }).map_err(|error| error.to_string())?;
    }
    let path = with_catalog(memo, &request.notebook_id, |catalog| {
        let item = catalog.resolve(&request.collection_id)?;
        catalog.checked_path(&item.relative_path)
    })?;
    memo.with_file_write(&request.notebook_id, &path, FileLockIntent::Existing,
        "mutate_collection", |locked_path| Ok(mutate_locked(memo, request, Some(locked_path))))
        .map_err(|error| error.to_string())?
}

fn mutate_locked(
    memo: &MemoFile,
    request: &CollectionMutation,
    locked_path: Option<&Path>,
) -> Result<CollectionMutationResult, String> {
    with_catalog(memo, &request.notebook_id, |catalog| {
        let (item, path, source, mut document) = catalog.read(&request.collection_id)?;
        if let Some(locked_path) = locked_path {
            if dunce::canonicalize(&path).map_err(|error| error.to_string())? != locked_path {
                return Err("COLLECTION_PATH_CHANGED".into());
            }
        }
        if document.collection.revision != request.expected_revision {
            return Err("COLLECTION_REVISION_CONFLICT".into());
        }
        if let Some(name) = &request.new_name {
            let name = name.trim();
            if name.is_empty()
                || name
                    .chars()
                    .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
                || name.ends_with('.')
            {
                return Err("INVALID_COLLECTION_NAME".into());
            }
            document.collection.name = name.to_owned();
        }
        if let Some(patch) = &request.properties {
            for (key, value) in patch {
                if let Some(value) = value {
                    document
                        .collection
                        .properties
                        .insert(key.clone(), value.clone());
                } else {
                    document.collection.properties.remove(key);
                }
            }
            validate_properties(&document.collection.properties)?;
        }
        let target_relative = target_relative_path(&request, &item, &path, &document)?;
        let target = catalog.checked_path(&target_relative)?;
        if collection_type_for_path(&target) != Some(document.collection.kind) {
            return Err("COLLECTION_TYPE_EXTENSION_MISMATCH".into());
        }
        let case_only = target != path
            && target.exists()
            && dunce::canonicalize(&target).ok() == dunce::canonicalize(&path).ok();
        if target != path && target.exists() && !case_only {
            return Err("FILE_EXISTS".into());
        }
        let temporary_path = case_only.then(|| {
            Path::new(&item.relative_path)
                .parent()
                .unwrap_or(Path::new(""))
                .join(format!(
                    "__collection_rename_{}{}",
                    uuid::Uuid::now_v7().simple(),
                    if document.collection.kind == CollectionType::Table {
                        ".table.yml"
                    } else {
                        ".lib.yaml"
                    }
                ))
                .to_string_lossy()
                .replace('\\', "/")
        });
        if request.new_name.is_some() || request.properties.is_some() {
            document.revise()?;
        }
        let next_content = if request.new_name.is_some() || request.properties.is_some() {
            document.serialize()?
        } else {
            source.clone()
        };
        let operation = FileOperation {
            operation_id: request.operation_id.clone(),
            collection_id: request.collection_id.clone(),
            previous_path: item.relative_path.clone(),
            target_path: target_relative.clone(),
            temporary_path: temporary_path.clone(),
            expected_content: source,
            next_content,
        };
        catalog.conn.execute("INSERT INTO collection_operations(operation_id,body,status) VALUES(?1,?2,'pending')",params![operation.operation_id,serde_json::to_string(&operation).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        let outcome = catalog.apply_operation(&operation);
        let actual_path = actual_operation_path(
            catalog,
            &target,
            temporary_path.as_deref(),
            path,
            &request.collection_id,
        );
        let content = fs::read_to_string(&actual_path).map_err(|e| e.to_string())?;
        let actual = CollectionDocument::parse(&content)?;
        let (error_code, status, sequence) = match outcome {
            Ok(sequence) => (None, "completed", sequence),
            Err(error) => {
                catalog
                    .conn
                    .execute(
                        "UPDATE collection_operations SET error_code=?2 WHERE operation_id=?1",
                        params![operation.operation_id, error],
                    )
                    .map_err(|e| e.to_string())?;
                let sequence = catalog.refresh(&[
                    catalog.root.join(&item.relative_path),
                    catalog.root.join(&target_relative),
                ])?;
                (Some(error), "partial", sequence)
            }
        };
        Ok(CollectionMutationResult {
            operation_id: operation.operation_id,
            status: status.into(),
            collection_id: request.collection_id.clone(),
            actual_name: actual.collection.name,
            previous_relative_path: item.relative_path.clone(),
            notebook_path: catalog.root.to_string_lossy().into_owned(),
            actual_relative_path: actual_path
                .strip_prefix(&catalog.root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/"),
            actual_revision: actual.collection.revision,
            index_sequence: sequence,
            content,
            error_code,
        })
    })
}
#[tauri::command]
pub async fn list_collections(
    notebook_id: String,
    collection_type: Option<CollectionType>,
    state: State<'_, AppState>,
) -> Result<Vec<CollectionIndexItem>, String> {
    let memo = state.memo_file.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let memo = read_lock(&memo, "memo_file");
        with_catalog(&memo, &notebook_id, |catalog| catalog.list(collection_type))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn resolve_collection(
    notebook_id: String,
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<CollectionIndexItem, String> {
    let memo = state.memo_file.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let memo = read_lock(&memo, "memo_file");
        with_catalog(&memo, &notebook_id, |catalog| catalog.resolve(&collection_id))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn mutate_collection(
    request: CollectionMutation,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<CollectionMutationResult, String> {
    let memo = state.memo_file.clone();
    tauri::async_runtime::spawn_blocking(move||{
        let result=mutate(&read_lock(&memo,"memo_file"),&request)?;
        let _=app.emit("collection-changed",serde_json::json!({"notebookId":request.notebook_id,"collectionId":result.collection_id,"operationId":result.operation_id,"indexSequence":result.index_sequence,"relativePath":result.actual_relative_path,"previousRelativePath":result.previous_relative_path,"notebookPath":result.notebook_path,"name":result.actual_name,"revision":result.actual_revision}));
        Ok(result)
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn set_collection_display_state(
    notebook_id: String,
    collection_id: String,
    in_views: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let memo = state.memo_file.clone();
    tauri::async_runtime::spawn_blocking(move||{
        let memo=read_lock(&memo,"memo_file");
        let _guard = memo.operation_locks().notebook_read(&notebook_id, "set_collection_display_state")
            .map_err(|error| error.to_string())?;
        with_catalog(&memo,&notebook_id,|catalog|{
        let item=catalog.resolve(&collection_id)?;if item.parse_state!="valid"{return Err("COLLECTION_NOT_EDITABLE".into());}
        catalog.conn.execute("INSERT INTO collection_state(collection_id,in_views) VALUES(?1,?2) ON CONFLICT(collection_id) DO UPDATE SET in_views=excluded.in_views",params![collection_id,in_views]).map_err(|e|e.to_string())?;Ok(())
    })}).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn make_collection_identity_unique(
    notebook_id: String,
    relative_path: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let memo = state.memo_file.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let memo = read_lock(&memo, "memo_file");
        let id = memo.with_notebook_change(&[&notebook_id], "make_collection_identity_unique", || {
            Ok(with_catalog(&memo, &notebook_id, |catalog| {
            catalog.recover()?;
            let path = catalog.checked_path(&relative_path)?;
            let source = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let mut document = CollectionDocument::parse(&source)?;
            document.validate()?;
            catalog.reconcile()?;
            let duplicates: i64 = catalog
                .conn
                .query_row(
                    "SELECT COUNT(*) FROM collection_documents WHERE collection_id=?1",
                    [&document.collection.id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if duplicates < 2 {
                return Err("COLLECTION_ID_NOT_DUPLICATED".into());
            }
            document.collection.id = format!("col_{}", uuid::Uuid::now_v7().simple());
            document.revise()?;
            atomic_write_bytes(&path, document.serialize()?.as_bytes())
                .map_err(|e| e.to_string())?;
            catalog.refresh(&[path])?;
            Ok(document.collection.id)
            }))
        }).map_err(|error| error.to_string())??;
        let _ = app.emit(
            "file-management-changed",
            serde_json::json!({"notebookId":notebook_id}),
        );
        Ok(id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use flowix_core::memo_file::NotebookConfig;
    fn fixture() -> (MemoFile, tempfile::TempDir, PathBuf, String) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir_all(&root).unwrap();
        let memo = MemoFile::new(temp.path().join("config"));
        let id = format!("nb_{}", uuid::Uuid::now_v7().simple());
        memo.write_notebook_configs(&[NotebookConfig {
            id: id.clone(),
            name: "Collections".into(),
            icon: None,
            path: root.to_string_lossy().into_owned(),
            is_default: true,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        }])
        .unwrap();
        (memo, temp, root, id)
    }
    fn document(kind: CollectionType) -> CollectionDocument {
        let field = format!("fld_{}", uuid::Uuid::now_v7().simple());
        let view = format!("view_{}", uuid::Uuid::now_v7().simple());
        let payload = match kind {
            CollectionType::Table => {
                serde_json::json!({"schema_version":1,"table":{"primary_field_id":field,"fields":[{"id":field,"type":"primary","property_key":"note"}],"views":[{"id":view,"name":"表格","type":"table","config":{"visible_fields":[field]}}]},"records":{"data":[],"auto_collect":null}})
            }
            CollectionType::MediaLibrary => {
                serde_json::json!({"schema_version":1,"view":{"id":view,"layout":"waterfall","condition":{}},"records":{"data":[]}})
            }
        };
        CollectionDocument::parse(&serde_yaml::to_string(&serde_json::json!({"format":"flowix.collection","schema_version":1,"collection":{"id":format!("col_{}",uuid::Uuid::now_v7().simple()),"type":kind,"name":"Old","revision":0,"created_at":"2026-10-07T00:00:00Z","updated_at":"2026-10-07T00:00:00Z","properties":{"owner":{"type":"Text","value":"张三"}}},"payload":payload})).unwrap()).unwrap()
    }
    fn request(book: &str, document: &CollectionDocument) -> CollectionMutation {
        CollectionMutation {
            notebook_id: book.into(),
            collection_id: document.collection.id.clone(),
            expected_revision: document.collection.revision,
            operation_id: uuid::Uuid::now_v7().to_string(),
            new_name: Some("New".into()),
            target_relative_path: None,
            properties: None,
        }
    }
    #[test]
    fn catalogs_both_types_and_preserves_preferences_on_rebuild() {
        let (memo, _temp, root, book) = fixture();
        let table = document(CollectionType::Table);
        let library = document(CollectionType::MediaLibrary);
        fs::write(root.join("A.table.yml"), table.serialize().unwrap()).unwrap();
        fs::write(root.join("B.lib.yaml"), library.serialize().unwrap()).unwrap();
        let mut catalog = CollectionCatalog::open(&memo, &book).unwrap();
        catalog.reconcile().unwrap();
        let items = catalog.list(None).unwrap();
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|item| item.parse_state == "valid"));
        catalog
            .conn
            .execute(
                "INSERT INTO collection_state(collection_id,in_views) VALUES(?1,1)",
                [&table.collection.id],
            )
            .unwrap();
        fs::rename(root.join("A.table.yml"), root.join("Renamed.table.yml")).unwrap();
        catalog.reconcile().unwrap();
        let item = catalog.resolve(&table.collection.id).unwrap();
        assert_eq!(item.relative_path, "Renamed.table.yml");
        assert!(item.in_views);
    }
    #[test]
    fn rename_keeps_identity_properties_and_rejects_stale_revision_and_occupied_path() {
        let (memo, _temp, root, book) = fixture();
        let original = document(CollectionType::MediaLibrary);
        fs::write(root.join("Old.lib.yaml"), original.serialize().unwrap()).unwrap();
        let result = mutate(&memo, &request(&book, &original)).unwrap();
        assert_eq!(result.status, "completed");
        assert_eq!(result.actual_relative_path, "New.lib.yaml");
        assert_eq!(result.collection_id, original.collection.id);
        let renamed = CollectionDocument::parse(&result.content).unwrap();
        assert_eq!(
            renamed.collection.properties,
            original.collection.properties
        );
        assert_eq!(renamed.payload, original.payload);
        assert_eq!(renamed.collection.revision, 1);
        assert!(!root.join("Old.lib.yaml").exists());
        assert_eq!(
            mutate(&memo, &request(&book, &original)).unwrap_err(),
            "COLLECTION_REVISION_CONFLICT"
        );
        fs::write(root.join("Occupied.lib.yaml"), "foreign").unwrap();
        let mut occupied = request(&book, &renamed);
        occupied.new_name = Some("Occupied".into());
        assert_eq!(mutate(&memo, &occupied).unwrap_err(), "FILE_EXISTS");
        assert_eq!(
            fs::read_to_string(root.join("Occupied.lib.yaml")).unwrap(),
            "foreign"
        );
    }
    #[test]
    fn path_reuse_never_rebinds_the_original_identity_to_another_collection() {
        let (memo, _temp, root, book) = fixture();
        let original = document(CollectionType::Table);
        fs::write(root.join("Old.table.yml"), original.serialize().unwrap()).unwrap();
        let mut catalog = CollectionCatalog::open(&memo, &book).unwrap();
        catalog.reconcile().unwrap();
        fs::rename(root.join("Old.table.yml"), root.join("Moved.table.yml")).unwrap();
        fs::write(
            root.join("Old.table.yml"),
            document(CollectionType::Table).serialize().unwrap(),
        )
        .unwrap();
        assert_eq!(
            catalog
                .resolve(&original.collection.id)
                .unwrap()
                .relative_path,
            "Moved.table.yml"
        );
        fs::copy(root.join("Moved.table.yml"), root.join("Copy.table.yml")).unwrap();
        catalog.reconcile().unwrap();
        assert!(catalog
            .list(None)
            .unwrap()
            .iter()
            .filter(|item| item.collection_id.as_deref() == Some(&original.collection.id))
            .all(|item| item.identity_conflict));
        assert_eq!(
            catalog.resolve(&original.collection.id).unwrap_err(),
            "COLLECTION_IDENTITY_CONFLICT"
        );
    }
    #[test]
    fn recovers_a_rename_after_the_file_moved_but_before_catalog_commit() {
        let (memo, _temp, root, book) = fixture();
        let original = document(CollectionType::MediaLibrary);
        let mut next = original.clone();
        next.collection.name = "New".into();
        next.revise().unwrap();
        let mut catalog = CollectionCatalog::open(&memo, &book).unwrap();
        let expected = original.serialize().unwrap();
        let content = next.serialize().unwrap();
        fs::write(root.join("Old.lib.yaml"), &expected).unwrap();
        catalog.reconcile().unwrap();
        let operation = FileOperation {
            operation_id: "recover".into(),
            collection_id: original.collection.id.clone(),
            previous_path: "Old.lib.yaml".into(),
            target_path: "New.lib.yaml".into(),
            temporary_path: None,
            expected_content: expected,
            next_content: content.clone(),
        };
        catalog
            .conn
            .execute(
                "INSERT INTO collection_operations VALUES(?1,?2,'pending',NULL)",
                params![
                    operation.operation_id,
                    serde_json::to_string(&operation).unwrap()
                ],
            )
            .unwrap();
        fs::write(root.join("New.lib.yaml"), content).unwrap();
        fs::remove_file(root.join("Old.lib.yaml")).unwrap();
        let _guard = memo.acquire_cross_process_write_lock().unwrap();
        catalog.recover().unwrap();
        assert_eq!(
            catalog
                .resolve(&original.collection.id)
                .unwrap()
                .relative_path,
            "New.lib.yaml"
        );
        assert_eq!(
            catalog
                .conn
                .query_row(
                    "SELECT status FROM collection_operations WHERE operation_id='recover'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "completed"
        );
    }
    #[test]
    fn supports_case_only_rename_and_indexes_unsupported_versions_read_only() {
        let (memo, _temp, root, book) = fixture();
        let original = document(CollectionType::Table);
        fs::write(root.join("Old.table.yml"), original.serialize().unwrap()).unwrap();
        let mut rename = request(&book, &original);
        rename.new_name = Some("old".into());
        let result = mutate(&memo, &rename).unwrap();
        assert_eq!(result.actual_relative_path, "old.table.yml");
        let mut catalog = CollectionCatalog::open(&memo, &book).unwrap();
        assert_eq!(catalog.list(None).unwrap().len(), 1);
        let mut unsupported = document(CollectionType::MediaLibrary);
        unsupported.schema_version = 2;
        fs::write(
            root.join("Future.lib.yaml"),
            serde_yaml::to_string(&unsupported).unwrap(),
        )
        .unwrap();
        catalog.reconcile().unwrap();
        assert_eq!(
            catalog
                .resolve(&unsupported.collection.id)
                .unwrap()
                .parse_state,
            "unsupported"
        );
        assert!(catalog.read(&unsupported.collection.id).is_err());
    }
    #[test]
    fn property_updates_preserve_payload_and_moves_do_not_increment_content_revision() {
        let (memo, _temp, root, book) = fixture();
        let original = document(CollectionType::Table);
        fs::write(root.join("Old.table.yml"), original.serialize().unwrap()).unwrap();
        let mut patch = request(&book, &original);
        patch.new_name = None;
        patch.properties = Some(std::collections::BTreeMap::from([
            ("owner".into(), None),
            (
                "archived".into(),
                Some(CollectionProperty {
                    kind: "Boolean".into(),
                    name: Some("已归档".into()),
                    value: serde_json::json!(true),
                }),
            ),
        ]));
        let result = mutate(&memo, &patch).unwrap();
        let updated = CollectionDocument::parse(&result.content).unwrap();
        assert_eq!(updated.payload, original.payload);
        assert!(!updated.collection.properties.contains_key("owner"));
        assert_eq!(updated.collection.properties["archived"].value, true);
        fs::create_dir(root.join("views")).unwrap();
        let mut movement = request(&book, &updated);
        movement.new_name = None;
        movement.target_relative_path = Some("views/Moved.table.yml".into());
        let moved = mutate(&memo, &movement).unwrap();
        assert_eq!(moved.actual_revision, updated.collection.revision);
        assert_eq!(moved.collection_id, original.collection.id);
        movement.operation_id = uuid::Uuid::now_v7().to_string();
        movement.target_relative_path = Some("../escape.table.yml".into());
        assert!(mutate(&memo, &movement).is_err());
    }

    #[test]
    fn catalog_actions_on_one_notebook_can_overlap() {
        let (memo, _temp, _root, book) = fixture();
        with_catalog(&memo, &book, |_| Ok(())).unwrap();
        let memo = Arc::new(memo);
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let first_memo = memo.clone();
        let first_book = book.clone();
        let first = std::thread::spawn(move || {
            with_catalog(&first_memo, &first_book, |_| {
                entered_tx.send(()).unwrap();
                release_rx.recv_timeout(std::time::Duration::from_secs(2))
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
        });
        entered_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        let second = with_catalog(&memo, &book, |_| {
            release_tx.send(()).unwrap();
            Ok(())
        });
        assert!(second.is_ok());
        first.join().unwrap().unwrap();
    }
}
