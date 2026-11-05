//! Notebook-local resource catalog shared by media and file documents.
//!
//! Files remain on disk, while their identity and lightweight metadata are
//! stored in the notebook-local database at
//! `<notebook>/.flowix/notebook.db`. It is deliberately separate from the
//! global notebook registry database (`~/.flowix/db/local.db`).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::notebook::sqlite_to_io;
use super::MemoFile;

/// File family stored in the shared resource catalog. The `image` and `video`
/// values keep the media library API stable; other families are indexed as
/// files only and are never parsed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceKind {
    Image,
    Video,
    Audio,
    Document,
    Spreadsheet,
    Presentation,
    Web,
    Archive,
    Database,
}

impl ResourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Video => "video",
            Self::Audio => "audio",
            Self::Document => "document",
            Self::Spreadsheet => "spreadsheet",
            Self::Presentation => "presentation",
            Self::Web => "web",
            Self::Archive => "archive",
            Self::Database => "database",
        }
    }

    fn is_media(self) -> bool {
        matches!(self, Self::Image | Self::Video | Self::Audio)
    }

    fn has_media_properties(self) -> bool {
        matches!(self, Self::Image | Self::Video)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaResourceKind {
    Image,
    Video,
}

impl MediaResourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Video => "video",
        }
    }

    fn resource_kind(self) -> ResourceKind {
        match self {
            Self::Image => ResourceKind::Image,
            Self::Video => ResourceKind::Video,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedResource {
    pub id: String,
    pub notebook_id: String,
    pub relative_path: String,
    pub kind: ResourceKind,
    pub format: String,
    pub is_directory: bool,
    pub size_bytes: u64,
    pub modified_ms: u64,
    pub fingerprint: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedResourcePage {
    pub resources: Vec<IndexedResource>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaResource {
    pub id: String,
    pub notebook_id: String,
    pub relative_path: String,
    pub kind: MediaResourceKind,
    pub size_bytes: u64,
    pub modified_ms: u64,
    pub fingerprint: Option<String>,
    pub properties: serde_json::Value,
    pub properties_revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaResourcePage {
    pub resources: Vec<MediaResource>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

struct MediaResourceRecord {
    resource: MediaResource,
    deleted_at: Option<i64>,
}

const RESOURCE_MISSING_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Normalize a notebook-relative path and derive its stable resource ID.
/// The path is part of identity: a rename produces a new ID.
pub fn resource_catalog_id(notebook_id: &str, relative_path: &str) -> std::io::Result<String> {
    let normalized = normalize_resource_relative_path(relative_path)?;
    if notebook_id.is_empty() || notebook_id.contains("::") || notebook_id.contains('\0') {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid notebook id"));
    }
    Ok(format!("{notebook_id}::{normalized}"))
}

/// Backward-compatible media name for the shared resource identity function.
pub fn media_resource_id(notebook_id: &str, relative_path: &str) -> std::io::Result<String> {
    resource_catalog_id(notebook_id, relative_path)
}

pub(crate) fn normalize_resource_relative_path(relative_path: &str) -> std::io::Result<String> {
    let normalized = relative_path.replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.contains('\0')
        || normalized.split('/').any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid resource relative path"));
    }
    Ok(normalized)
}

pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn stable_fingerprint(path: &Path, size_bytes: u64) -> String {
    // This is intentionally a quick identity signal, not a full content hash.
    // It must not contain the path or mtime: a resource can be renamed
    // outside Flowix and still be recognized during the next catalog rebuild.
    // The size plus both ends of the file avoids reading a large video in full
    // while making accidental matches less likely than a prefix-only sample.
    let mut digest = Sha256::new();
    digest.update(size_bytes.to_le_bytes());
    if let Ok(mut file) = fs::File::open(path) {
        use std::io::{Read, Seek};
        const SAMPLE_SIZE: usize = 64 * 1024;
        let mut prefix = [0_u8; SAMPLE_SIZE];
        if let Ok(read) = file.read(&mut prefix) {
            digest.update(&prefix[..read]);
        }
        if size_bytes > SAMPLE_SIZE as u64 {
            if file
                .seek(std::io::SeekFrom::End(-(SAMPLE_SIZE as i64)))
                .is_ok()
            {
                let mut suffix = [0_u8; SAMPLE_SIZE];
                if let Ok(read) = file.read(&mut suffix) {
                    digest.update(&suffix[..read]);
                }
            }
        }
    }
    format!("{size_bytes}:{:x}", digest.finalize())
}

fn parse_kind(value: &str) -> Option<MediaResourceKind> {
    match value {
        "image" => Some(MediaResourceKind::Image),
        "video" => Some(MediaResourceKind::Video),
        _ => None,
    }
}

fn parse_resource_kind(value: &str) -> Option<ResourceKind> {
    match value {
        "image" => Some(ResourceKind::Image),
        "video" => Some(ResourceKind::Video),
        "audio" => Some(ResourceKind::Audio),
        "document" => Some(ResourceKind::Document),
        "spreadsheet" => Some(ResourceKind::Spreadsheet),
        "presentation" => Some(ResourceKind::Presentation),
        "web" => Some(ResourceKind::Web),
        "archive" => Some(ResourceKind::Archive),
        "database" => Some(ResourceKind::Database),
        _ => None,
    }
}

pub fn media_kind_for_path(path: &Path) -> Option<MediaResourceKind> {
    match resource_kind_for_path(path)? {
        ResourceKind::Image => Some(MediaResourceKind::Image),
        ResourceKind::Video => Some(MediaResourceKind::Video),
        _ => None,
    }
}

/// Classify supported non-code files without opening or parsing their content.
pub fn resource_kind_for_path(path: &Path) -> Option<ResourceKind> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    if matches!(
        extension.as_str(),
        "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "bmp"
            | "svg"
            | "avif"
            | "ico"
            | "tif"
            | "tiff"
            | "heic"
            | "heif"
    ) {
        return Some(ResourceKind::Image);
    }
    if matches!(
        extension.as_str(),
        "3gp"
            | "avi"
            | "flv"
            | "m2ts"
            | "m4v"
            | "mkv"
            | "mov"
            | "mp4"
            | "mpeg"
            | "mpg"
            | "mts"
            | "webm"
            | "wmv"
    ) {
        return Some(ResourceKind::Video);
    }
    if matches!(
        extension.as_str(),
        "aac" | "aif" | "aiff" | "alac" | "amr" | "ape" | "caf" | "dff" | "dsf"
            | "flac" | "m4a" | "m4b" | "m4p" | "mid" | "midi" | "mka" | "mp3"
            | "mpc" | "oga" | "ogg" | "opus" | "ra" | "ram" | "tta" | "voc"
            | "wav" | "wma" | "wv"
    ) {
        return Some(ResourceKind::Audio);
    }
    if matches!(extension.as_str(), "docx" | "doc" | "odt" | "pages" | "wps" | "pdf") {
        return Some(ResourceKind::Document);
    }
    if matches!(extension.as_str(), "xlsx" | "xls" | "xlsm" | "ods" | "csv") {
        return Some(ResourceKind::Spreadsheet);
    }
    if matches!(extension.as_str(), "pptx" | "ppt" | "key" | "odp") {
        return Some(ResourceKind::Presentation);
    }
    if matches!(extension.as_str(), "html" | "htm") {
        return Some(ResourceKind::Web);
    }
    if matches!(extension.as_str(), "zip" | "7z" | "rar") {
        return Some(ResourceKind::Archive);
    }
    if matches!(extension.as_str(), "sqlite" | "db") {
        return Some(ResourceKind::Database);
    }
    None
}

fn resource_format_for_path(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn is_directory_resource_bundle(path: &Path) -> bool {
    path.is_dir()
        && path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| matches!(extension.to_ascii_lowercase().as_str(), "pages" | "key"))
}

fn is_inside_directory_resource_bundle(path: &Path, root: &Path) -> bool {
    path.ancestors()
        .skip(1)
        .take_while(|ancestor| *ancestor != root)
        .any(is_directory_resource_bundle)
}

impl MemoFile {
    pub(crate) fn open_notebook_db(&self, notebook_id: &str) -> std::io::Result<Connection> {
        self.open_notebook_db_inner(notebook_id, false)
    }

    /// Initialize the shared notebook resource catalog during version initialization.
    pub fn initialize_resource_catalog_schema(&self, notebook_id: &str) -> std::io::Result<()> {
        self.open_notebook_db_inner(notebook_id, true)?;
        Ok(())
    }


    fn open_notebook_db_inner(
        &self,
        notebook_id: &str,
        run_legacy_migrations: bool,
    ) -> std::io::Result<Connection> {
        let path = self.notebook_db_path(notebook_id)?;
        if run_legacy_migrations {
            super::with_database_rebuild(&path, || {
                self.open_notebook_db_unchecked(notebook_id, true)
            })
        } else {
            self.open_notebook_db_unchecked(notebook_id, false)
        }
    }

    fn open_notebook_db_unchecked(
        &self,
        notebook_id: &str,
        run_legacy_migrations: bool,
    ) -> std::io::Result<Connection> {
        let path = self.notebook_db_path(notebook_id)?;
        let mut conn = Connection::open(path).map_err(sqlite_to_io)?;
        conn.busy_timeout(std::time::Duration::from_secs(10))
            .map_err(sqlite_to_io)?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS resource_catalog (
                id TEXT PRIMARY KEY,
                notebook_id TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('image', 'video', 'audio', 'document', 'spreadsheet', 'presentation', 'web', 'archive', 'database')),
                format TEXT NOT NULL DEFAULT '',
                is_directory INTEGER NOT NULL DEFAULT 0,
                size_bytes INTEGER NOT NULL,
                modified_ms INTEGER NOT NULL,
                fingerprint TEXT,
                properties TEXT NOT NULL DEFAULT '{}',
                properties_revision INTEGER NOT NULL DEFAULT 0,
                missing_since INTEGER,
                deleted_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(notebook_id, relative_path)
            );
            CREATE INDEX IF NOT EXISTS idx_resource_catalog_kind
                ON resource_catalog(kind);
            CREATE INDEX IF NOT EXISTS idx_resource_catalog_updated
                ON resource_catalog(updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_resource_catalog_fingerprint
                ON resource_catalog(fingerprint);
            CREATE TABLE IF NOT EXISTS notebook_index_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            "#,
        )
        .map_err(sqlite_to_io)?;
        if !run_legacy_migrations {
            return Ok(conn);
        }
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_to_io)?;
        for (column, definition) in [
            ("format", "TEXT NOT NULL DEFAULT ''"),
            ("is_directory", "INTEGER NOT NULL DEFAULT 0"),
            ("properties_revision", "INTEGER NOT NULL DEFAULT 0"),
            ("missing_since", "INTEGER"),
            ("deleted_at", "INTEGER"),
        ] {
            let exists = tx
                .prepare("PRAGMA table_info(resource_catalog)")
                .map_err(sqlite_to_io)?
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(sqlite_to_io)?
                .filter_map(Result::ok)
                .any(|name| name == column);
            if !exists {
                tx.execute(
                    &format!("ALTER TABLE resource_catalog ADD COLUMN {column} {definition}"),
                    [],
                )
                .map_err(sqlite_to_io)?;
            }
        }
        let catalog_sql: String = tx
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='resource_catalog'",
                [],
                |row| row.get(0),
            )
            .map_err(sqlite_to_io)?;
        let required_kinds = [
            "'image'", "'video'", "'audio'", "'document'", "'spreadsheet'",
            "'presentation'", "'web'", "'archive'", "'database'",
        ];
        if !required_kinds.iter().all(|kind| catalog_sql.contains(kind)) {
            // SQLite cannot alter a CHECK constraint in place. Rebuild this
            // derived catalog table transactionally so notebooks created by
            // earlier versions can index the newer document families.
            tx.execute_batch(
                "CREATE TABLE resource_catalog_next (
                    id TEXT PRIMARY KEY,
                    notebook_id TEXT NOT NULL,
                    relative_path TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('image', 'video', 'audio', 'document', 'spreadsheet', 'presentation', 'web', 'archive', 'database')),
                    format TEXT NOT NULL DEFAULT '',
                    is_directory INTEGER NOT NULL DEFAULT 0,
                    size_bytes INTEGER NOT NULL,
                    modified_ms INTEGER NOT NULL,
                    fingerprint TEXT,
                    properties TEXT NOT NULL DEFAULT '{}',
                    properties_revision INTEGER NOT NULL DEFAULT 0,
                    missing_since INTEGER,
                    deleted_at INTEGER,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    UNIQUE(notebook_id, relative_path)
                );
                INSERT INTO resource_catalog_next (
                    id, notebook_id, relative_path, kind, format, is_directory,
                    size_bytes, modified_ms, fingerprint, properties,
                    properties_revision, missing_since, deleted_at, created_at, updated_at
                ) SELECT
                    id, notebook_id, relative_path, kind, format, is_directory,
                    size_bytes, modified_ms, fingerprint, properties,
                    properties_revision, missing_since, deleted_at, created_at, updated_at
                FROM resource_catalog;
                DROP TABLE resource_catalog;
                ALTER TABLE resource_catalog_next RENAME TO resource_catalog;",
            )
            .map_err(sqlite_to_io)?;
        }
        // Older notebook databases may still have the former media table.
        // Keep its shape readable until the resource catalog initialization
        // job copies missing targets transactionally, retaining the old table.
        let legacy_media_table_exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_resources')",
                [],
                |row| row.get(0),
            )
            .map_err(sqlite_to_io)?;
        if legacy_media_table_exists {
            for (column, definition) in [
                ("properties_revision", "INTEGER NOT NULL DEFAULT 0"),
                ("missing_since", "INTEGER"),
                ("deleted_at", "INTEGER"),
            ] {
                let exists = tx
                    .prepare("PRAGMA table_info(media_resources)")
                    .map_err(sqlite_to_io)?
                    .query_map([], |row| row.get::<_, String>(1))
                    .map_err(sqlite_to_io)?
                    .filter_map(Result::ok)
                    .any(|name| name == column);
                if !exists {
                    tx.execute(
                        &format!("ALTER TABLE media_resources ADD COLUMN {column} {definition}"),
                        [],
                    )
                    .map_err(sqlite_to_io)?;
                }
            }
        }
        tx.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_resource_catalog_kind
                 ON resource_catalog(kind);
             CREATE INDEX IF NOT EXISTS idx_resource_catalog_updated
                 ON resource_catalog(updated_at DESC);
             CREATE INDEX IF NOT EXISTS idx_resource_catalog_fingerprint
                 ON resource_catalog(fingerprint);
             CREATE INDEX IF NOT EXISTS idx_resource_catalog_missing
                 ON resource_catalog(missing_since, deleted_at);
             CREATE INDEX IF NOT EXISTS idx_resource_catalog_kind_format
                 ON resource_catalog(kind, format);
             CREATE INDEX IF NOT EXISTS idx_resource_catalog_library_page
                 ON resource_catalog(notebook_id, deleted_at, missing_since, created_at DESC, id DESC);",
        )
        .map_err(sqlite_to_io)?;
        tx.commit().map_err(sqlite_to_io)?;
        Ok(conn)
    }

    /// Legacy sidecar location used only to import properties created by an
    /// older build. New writes never create this file.
    pub fn legacy_media_properties_path(absolute_path: &Path) -> PathBuf {
        let mut name = absolute_path.as_os_str().to_os_string();
        name.push(".yaml");
        PathBuf::from(name)
    }

    /// Read a legacy sibling YAML sidecar for the one-time compatibility
    /// import. The database migration marker prevents later reads.
    fn read_legacy_media_properties(absolute_path: &Path) -> std::io::Result<serde_json::Value> {
        let path = Self::legacy_media_properties_path(absolute_path);
        let content = match fs::read_to_string(path) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(serde_json::json!({}));
            }
            Err(error) => return Err(error),
        };
        if content.trim().is_empty() {
            return Ok(serde_json::json!({}));
        }
        let value = serde_yaml::from_str::<serde_json::Value>(&content).map_err(|error| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string())
        })?;
        if !value.is_object() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "media properties YAML must be a mapping",
            ));
        }
        Ok(value)
    }

    fn read_media_resource_record(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> std::io::Result<Option<MediaResourceRecord>> {
        let conn = self.open_notebook_db(notebook_id)?;
        let resource = conn
            .query_row(
                "SELECT id, notebook_id, relative_path, kind, size_bytes, modified_ms,
                    fingerprint, properties, properties_revision, missing_since, deleted_at,
                    created_at, updated_at
             FROM resource_catalog
             WHERE notebook_id = ?1 AND relative_path = ?2",
                params![notebook_id, relative_path],
                |row| {
                    let kind: String = row.get(3)?;
                    Ok(MediaResourceRecord {
                        resource: MediaResource {
                            id: row.get(0)?,
                            notebook_id: row.get(1)?,
                            relative_path: row.get(2)?,
                            kind: parse_kind(&kind).ok_or(rusqlite::Error::InvalidQuery)?,
                            size_bytes: row.get::<_, i64>(4)?.max(0) as u64,
                            modified_ms: row.get::<_, i64>(5)?.max(0) as u64,
                            fingerprint: row.get(6)?,
                            properties: serde_json::from_str::<serde_json::Value>(
                                &row.get::<_, String>(7)?,
                            )
                            .unwrap_or_else(|_| serde_json::json!({})),
                            properties_revision: row.get(8)?,
                            created_at: row.get(11)?,
                            updated_at: row.get(12)?,
                        },
                        deleted_at: row.get(10)?,
                    })
                },
            )
            .optional()
            .map_err(sqlite_to_io)?;
        Ok(resource)
    }

    pub fn read_media_resource(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> std::io::Result<Option<MediaResource>> {
        let Some(record) = self.read_media_resource_record(notebook_id, relative_path)? else {
            return Ok(None);
        };
        if record.deleted_at.is_some() {
            return Ok(None);
        }
        Ok(Some(record.resource))
    }

    /// Query the notebook media catalog by a stable descending creation cursor.
    /// Media bytes and per-file metadata are never loaded as part of this query.
    pub fn list_media_resources_page(
        &self,
        notebook_id: &str,
        kinds: &[MediaResourceKind],
        cursor: Option<(i64, String)>,
        limit: usize,
        folder_scope: Option<(String, bool)>,
    ) -> std::io::Result<MediaResourcePage> {
        let conn = self.open_notebook_db(notebook_id)?;
        let kind_filter = match kinds {
            [] => " AND kind IN ('image', 'video')".to_owned(),
            [MediaResourceKind::Image] => " AND kind = 'image'".to_owned(),
            [MediaResourceKind::Video] => " AND kind = 'video'".to_owned(),
            _ => " AND kind IN ('image', 'video')".to_owned(),
        };
        let mut values = vec![rusqlite::types::Value::Text(notebook_id.to_owned())];
        let mut where_extra = String::new();
        if let Some((folder, descendants)) = folder_scope {
            let folder = folder.trim_matches('/');
            if folder.is_empty() {
                if !descendants { where_extra.push_str(" AND instr(relative_path, '/') = 0"); }
            } else {
                let prefix = format!("{folder}/");
                values.push(rusqlite::types::Value::Text(prefix.clone()));
                values.push(rusqlite::types::Value::Text(prefix.clone()));
                where_extra.push_str(&format!(" AND substr(relative_path, 1, length(?{})) = ?{}", values.len() - 1, values.len()));
                if !descendants {
                    values.push(rusqlite::types::Value::Text(prefix));
                    where_extra.push_str(&format!(" AND instr(substr(relative_path, length(?{}) + 1), '/') = 0", values.len()));
                }
            }
        }
        if let Some((created_at, id)) = cursor {
            values.push(rusqlite::types::Value::Integer(created_at));
            values.push(rusqlite::types::Value::Text(id));
            where_extra.push_str(&format!(" AND (created_at < ?{} OR (created_at = ?{} AND id < ?{}))", values.len() - 1, values.len() - 1, values.len()));
        }
        let limit = limit.clamp(1, 120).saturating_add(1) as i64;
        values.push(rusqlite::types::Value::Integer(limit));
        let sql = format!(
            "SELECT id, notebook_id, relative_path, kind, size_bytes, modified_ms,
                    fingerprint, properties, properties_revision, created_at, updated_at
             FROM resource_catalog
             WHERE notebook_id = ?1 AND deleted_at IS NULL AND missing_since IS NULL{kind_filter}{where_extra}
             ORDER BY created_at DESC, id DESC LIMIT ?{}",
            values.len(),
        );
        let mut statement = conn.prepare(&sql).map_err(sqlite_to_io)?;
        let decode_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<MediaResource> {
            let kind: String = row.get(3)?;
            Ok(MediaResource {
                id: row.get(0)?,
                notebook_id: row.get(1)?,
                relative_path: row.get(2)?,
                kind: parse_kind(&kind).ok_or(rusqlite::Error::InvalidQuery)?,
                size_bytes: row.get::<_, i64>(4)?.max(0) as u64,
                modified_ms: row.get::<_, i64>(5)?.max(0) as u64,
                fingerprint: row.get(6)?,
                properties: serde_json::from_str::<serde_json::Value>(&row.get::<_, String>(7)?)
                    .unwrap_or_else(|_| serde_json::json!({})),
                properties_revision: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        };
        let mut resources = statement.query_map(rusqlite::params_from_iter(values.iter()), decode_row)
            .map_err(sqlite_to_io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_to_io)?;
        let has_more = resources.len() > limit as usize - 1;
        if has_more { resources.pop(); }
        let next_cursor = has_more.then(|| resources.last()).flatten()
            .map(|resource| format!("{}:{}", resource.created_at, resource.id));
        Ok(MediaResourcePage { resources, next_cursor, has_more })
    }

    /// Query the shared catalog for indexed non-media resources. This returns
    /// metadata only; file contents are never opened or parsed.
    pub fn list_indexed_resources_page(
        &self,
        notebook_id: &str,
        kinds: &[ResourceKind],
        cursor: Option<(i64, String)>,
        limit: usize,
    ) -> std::io::Result<IndexedResourcePage> {
        let conn = self.open_notebook_db(notebook_id)?;
        let mut values = vec![rusqlite::types::Value::Text(notebook_id.to_owned())];
        let kind_filter = if kinds.is_empty() {
            String::new()
        } else {
            let placeholders = kinds.iter().enumerate().map(|(index, _)| format!("?{}", index + 2)).collect::<Vec<_>>().join(",");
            values.extend(kinds.iter().map(|kind| rusqlite::types::Value::Text(kind.as_str().to_owned())));
            format!(" AND kind IN ({placeholders})")
        };
        let mut cursor_filter = String::new();
        if let Some((modified_ms, id)) = cursor {
            values.push(rusqlite::types::Value::Integer(modified_ms));
            values.push(rusqlite::types::Value::Text(id));
            cursor_filter = format!(
                " AND (modified_ms < ?{} OR (modified_ms = ?{} AND id < ?{}))",
                values.len() - 1,
                values.len() - 1,
                values.len(),
            );
        }
        let page_limit = limit.clamp(1, 120).saturating_add(1) as i64;
        values.push(rusqlite::types::Value::Integer(page_limit));
        let sql = format!(
            "SELECT id, notebook_id, relative_path, kind, format, is_directory,
                    size_bytes, modified_ms, fingerprint, created_at, updated_at
             FROM resource_catalog
             WHERE notebook_id = ?1 AND deleted_at IS NULL AND missing_since IS NULL{kind_filter}{cursor_filter}
             ORDER BY modified_ms DESC, id DESC LIMIT ?{}",
            values.len(),
        );
        let mut statement = conn.prepare(&sql).map_err(sqlite_to_io)?;
        let decode_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<IndexedResource> {
            let kind: String = row.get(3)?;
            Ok(IndexedResource {
                id: row.get(0)?,
                notebook_id: row.get(1)?,
                relative_path: row.get(2)?,
                kind: parse_resource_kind(&kind).ok_or(rusqlite::Error::InvalidQuery)?,
                format: row.get(4)?,
                is_directory: row.get(5)?,
                size_bytes: row.get::<_, i64>(6)?.max(0) as u64,
                modified_ms: row.get::<_, i64>(7)?.max(0) as u64,
                fingerprint: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        };
        let mut resources = statement
            .query_map(rusqlite::params_from_iter(values.iter()), decode_row)
            .map_err(sqlite_to_io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_to_io)?;
        let has_more = resources.len() > page_limit as usize - 1;
        if has_more { resources.pop(); }
        let next_cursor = has_more.then(|| resources.last()).flatten()
            .map(|resource| format!("{}:{}", resource.modified_ms, resource.id));
        Ok(IndexedResourcePage { resources, next_cursor, has_more })
    }

    /// Read a lightweight catalog row. This never opens or parses the file.
    pub fn read_indexed_resource(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> std::io::Result<Option<IndexedResource>> {
        let conn = self.open_notebook_db(notebook_id)?;
        conn.query_row(
            "SELECT id, notebook_id, relative_path, kind, format, is_directory,
                    size_bytes, modified_ms, fingerprint, created_at, updated_at
             FROM resource_catalog
             WHERE notebook_id=?1 AND relative_path=?2 AND deleted_at IS NULL",
            params![notebook_id, relative_path],
            |row| {
                let kind: String = row.get(3)?;
                Ok(IndexedResource {
                    id: row.get(0)?,
                    notebook_id: row.get(1)?,
                    relative_path: row.get(2)?,
                    kind: parse_resource_kind(&kind).ok_or(rusqlite::Error::InvalidQuery)?,
                    format: row.get(4)?,
                    is_directory: row.get(5)?,
                    size_bytes: row.get::<_, i64>(6)?.max(0) as u64,
                    modified_ms: row.get::<_, i64>(7)?.max(0) as u64,
                    fingerprint: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            },
        )
        .optional()
        .map_err(sqlite_to_io)
    }

    /// Register or refresh any supported file path without reading its content.
    pub fn ensure_indexed_resource(
        &self,
        notebook_id: &str,
        relative_path: &str,
        kind: ResourceKind,
        absolute_path: &Path,
    ) -> std::io::Result<IndexedResource> {
        let relative_path = normalize_resource_relative_path(relative_path)?;
        let id = resource_catalog_id(notebook_id, &relative_path)?;
        let path_type = fs::symlink_metadata(absolute_path)?;
        if path_type.file_type().is_symlink() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "indexed resource cannot be a symbolic link",
            ));
        }
        let metadata = fs::metadata(absolute_path)?;
        let is_directory = path_type.is_dir() && is_directory_resource_bundle(absolute_path);
        if !metadata.is_file() && !is_directory {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "indexed resource is not a file",
            ));
        }
        let size_bytes = if is_directory { 0 } else { metadata.len() };
        let modified = modified_ms(absolute_path);
        let fingerprint = (kind.is_media() && !is_directory)
            .then(|| stable_fingerprint(absolute_path, size_bytes));
        let format = resource_format_for_path(absolute_path);
        let conn = self.open_notebook_db(notebook_id)?;
        let legacy_import_pending = kind.has_media_properties() && conn
            .query_row(
                "SELECT 1 FROM notebook_index_meta
                 WHERE key = 'media_legacy_sidecars_imported_v1'",
                [],
                |_| Ok(()),
            )
            .optional()
            .map_err(sqlite_to_io)?
            .is_none();
        let mut existing = conn
            .query_row(
                "SELECT properties, properties_revision, created_at
                 FROM resource_catalog WHERE notebook_id=?1 AND relative_path=?2",
                params![notebook_id, relative_path],
                |row| {
                    Ok((
                        serde_json::from_str::<serde_json::Value>(&row.get::<_, String>(0)?)
                            .unwrap_or_else(|_| serde_json::json!({})),
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(sqlite_to_io)?;

        // Media properties can follow an out-of-app rename when the sampled
        // fingerprint uniquely identifies a file whose old path disappeared.
        if kind.is_media() && existing.is_none() {
            let fingerprint = fingerprint.as_deref().unwrap_or_default();
            let mut candidates = conn
                .prepare(
                    "SELECT id, relative_path FROM resource_catalog
                     WHERE notebook_id = ?1 AND kind IN ('image', 'video')
                       AND fingerprint = ?2 AND relative_path <> ?3
                     LIMIT 2",
                )
                .map_err(sqlite_to_io)?
                .query_map(params![notebook_id, fingerprint, relative_path], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(sqlite_to_io)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_to_io)?;
            if candidates.len() == 1 {
                let (candidate_id, old_relative) = candidates.pop().expect("one candidate");
                let root = self
                    .memo_base_for_notebook_id_result(notebook_id)
                    .map_err(std::io::Error::other)?;
                let old_absolute = super::notebook_path_from_relative(&root, &old_relative)
                    .map_err(std::io::Error::other)?;
                if !old_absolute.is_file() {
                    conn.execute(
                        "UPDATE resource_catalog SET id = ?1, relative_path = ?2, updated_at = ?3,
                             missing_since = NULL, deleted_at = NULL
                         WHERE notebook_id = ?4 AND id = ?5",
                        params![id, relative_path, now_ms(), notebook_id, candidate_id],
                    )
                    .map_err(sqlite_to_io)?;
                    existing = conn
                        .query_row(
                            "SELECT properties, properties_revision, created_at
                             FROM resource_catalog WHERE notebook_id=?1 AND relative_path=?2",
                            params![notebook_id, relative_path],
                            |row| Ok((
                                serde_json::from_str::<serde_json::Value>(&row.get::<_, String>(0)?)
                                    .unwrap_or_else(|_| serde_json::json!({})),
                                row.get::<_, i64>(1)?,
                                row.get::<_, i64>(2)?,
                            )),
                        )
                        .optional()
                        .map_err(sqlite_to_io)?;
                }
            }
        }
        let created_at = existing
            .as_ref()
            .map(|record| record.2)
            .unwrap_or_else(now_ms);
        let updated_at = now_ms();
        let properties = existing
            .as_ref()
            .map(|record| record.0.clone())
            .unwrap_or_else(|| {
                if !kind.has_media_properties() || !legacy_import_pending {
                    return serde_json::json!({});
                }
                match Self::read_legacy_media_properties(absolute_path) {
                    Ok(properties) => properties,
                    Err(error) => {
                        tracing::warn!(
                            path = %absolute_path.display(),
                            %error,
                            "ignoring malformed legacy media sidecar during database import"
                        );
                        serde_json::json!({})
                    }
                }
            });
        conn.execute(
            r#"
            INSERT INTO resource_catalog
                (id, notebook_id, relative_path, kind, format, is_directory, size_bytes, modified_ms,
                 fingerprint, properties, properties_revision, missing_since, deleted_at,
                 created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                    NULL, NULL, ?12, ?13)
            ON CONFLICT(notebook_id, relative_path) DO UPDATE SET
                id = excluded.id,
                kind = excluded.kind,
                format = excluded.format,
                is_directory = excluded.is_directory,
                size_bytes = excluded.size_bytes,
                modified_ms = excluded.modified_ms,
                fingerprint = excluded.fingerprint,
                missing_since = NULL,
                deleted_at = NULL,
                updated_at = excluded.updated_at
            "#,
            params![
                id,
                notebook_id,
                relative_path,
                kind.as_str(),
                format,
                is_directory,
                size_bytes as i64,
                modified as i64,
                fingerprint,
                serde_json::to_string(&properties).unwrap_or_else(|_| "{}".to_string()),
                existing.as_ref().map(|record| record.1).unwrap_or(0),
                created_at,
                updated_at,
            ],
        )
        .map_err(sqlite_to_io)?;
        Ok(IndexedResource {
            id,
            notebook_id: notebook_id.to_string(),
            relative_path: relative_path.clone(),
            kind,
            format,
            is_directory,
            size_bytes,
            modified_ms: modified,
            fingerprint,
            created_at,
            updated_at,
        })
    }

    /// Media compatibility wrapper over the shared catalog.
    pub fn ensure_media_resource(
        &self,
        notebook_id: &str,
        relative_path: &str,
        kind: MediaResourceKind,
        absolute_path: &Path,
    ) -> std::io::Result<MediaResource> {
        let indexed = self.ensure_indexed_resource(
            notebook_id,
            relative_path,
            kind.resource_kind(),
            absolute_path,
        )?;
        self.read_media_resource(notebook_id, &indexed.relative_path)?
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "media resource missing after refresh"))
    }

    pub fn update_media_resource_properties(
        &self,
        notebook_id: &str,
        resource_id: &str,
        properties: &serde_json::Value,
    ) -> std::io::Result<Option<MediaResource>> {
        self.update_media_resource_properties_if_revision(
            notebook_id,
            resource_id,
            properties,
            None,
        )
    }

    pub fn update_media_resource_properties_if_revision(
        &self,
        notebook_id: &str,
        resource_id: &str,
        properties: &serde_json::Value,
        expected_revision: Option<i64>,
    ) -> std::io::Result<Option<MediaResource>> {
        if !properties.is_object() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "media properties must be a mapping",
            ));
        }
        let conn = self.open_notebook_db(notebook_id)?;
        let updated_at = now_ms();
        let serialized = serde_json::to_string(properties)
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        let changed = if let Some(expected_revision) = expected_revision {
            conn.execute(
                "UPDATE resource_catalog SET properties = ?1, updated_at = ?2,
                    properties_revision = properties_revision + 1
                 WHERE notebook_id = ?3 AND id = ?4 AND deleted_at IS NULL
                    AND properties_revision = ?5",
                params![
                    serialized,
                    updated_at,
                    notebook_id,
                    resource_id,
                    expected_revision
                ],
            )
        } else {
            conn.execute(
                "UPDATE resource_catalog SET properties = ?1, updated_at = ?2,
                    properties_revision = properties_revision + 1
                 WHERE notebook_id = ?3 AND id = ?4 AND deleted_at IS NULL",
                params![serialized, updated_at, notebook_id, resource_id],
            )
        }
        .map_err(sqlite_to_io)?;
        if changed == 0 {
            if expected_revision.is_some()
                && conn
                    .query_row(
                        "SELECT 1 FROM resource_catalog
                         WHERE notebook_id = ?1 AND id = ?2 AND deleted_at IS NULL",
                        params![notebook_id, resource_id],
                        |_| Ok(()),
                    )
                    .optional()
                    .map_err(sqlite_to_io)?
                    .is_some()
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WouldBlock,
                    "media resource properties changed; reload and retry",
                ));
            }
            return Ok(None);
        }
        let relative_path: String = conn
            .query_row(
                "SELECT relative_path FROM resource_catalog WHERE notebook_id = ?1 AND id = ?2",
                params![notebook_id, resource_id],
                |row| row.get(0),
            )
            .map_err(sqlite_to_io)?;
        self.read_media_resource(notebook_id, &relative_path)
    }

    pub fn mark_media_resource_deleted(
        &self,
        notebook_id: &str,
        resource_id: &str,
    ) -> std::io::Result<bool> {
        let conn = self.open_notebook_db(notebook_id)?;
        let now = now_ms();
        let changed = conn
            .execute(
                "UPDATE resource_catalog
                 SET missing_since = COALESCE(missing_since, ?1),
                     deleted_at = ?1, updated_at = ?1
                 WHERE notebook_id = ?2 AND id = ?3",
                params![now, notebook_id, resource_id],
            )
            .map_err(sqlite_to_io)?;
        Ok(changed > 0)
    }

    /// Refresh or retire one supported file path after a filesystem event.
    /// A missing resource is retained briefly so a rename can preserve its
    /// identity and, for media, its user properties.
    pub fn refresh_indexed_resource_path(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> std::io::Result<()> {
        let root = self
            .memo_base_for_notebook_id_result(notebook_id)
            .map_err(std::io::Error::other)?;
        let relative = Path::new(relative_path);
        if self
            .file_management_policy(notebook_id)
            .is_index_hidden_at(&root, relative)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "resource path is excluded by notebook policy",
            ));
        }
        let absolute = super::notebook_path_from_relative(&root, relative_path)
            .map_err(std::io::Error::other)?;
        match fs::symlink_metadata(&absolute) {
            Ok(metadata) => {
                let is_directory = metadata.is_dir() && is_directory_resource_bundle(&absolute);
                if metadata.file_type().is_symlink() || (!metadata.is_file() && !is_directory) {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "resource is not a regular file",
                    ));
                }
                let canonical_root = fs::canonicalize(&root)?;
                let canonical_path = fs::canonicalize(&absolute)?;
                if !canonical_path.starts_with(&canonical_root) {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "resource path leaves notebook",
                    ));
                }
                let Some(kind) = resource_kind_for_path(&absolute) else {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "unsupported resource type",
                    ));
                };
                self.ensure_indexed_resource(notebook_id, relative_path, kind, &absolute)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let conn = self.open_notebook_db(notebook_id)?;
                let now = now_ms();
                conn.execute(
                    "UPDATE resource_catalog
                     SET missing_since = COALESCE(missing_since, ?1),
                         deleted_at = ?1, updated_at = ?1
                     WHERE notebook_id = ?2 AND relative_path = ?3",
                    params![now, notebook_id, relative_path],
                )
                .map_err(sqlite_to_io)?;
            }
            Err(error) => return Err(error),
        }
        Ok(())
    }

    /// Media-only compatibility wrapper.
    pub fn refresh_media_resource_path(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> std::io::Result<()> {
        if media_kind_for_path(Path::new(relative_path)).is_none() {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a media path"));
        }
        self.refresh_indexed_resource_path(notebook_id, relative_path)
    }

    /// Move a catalog row after a confirmed same-notebook filesystem rename.
    /// The resource ID changes with the path while user properties remain on the row.
    /// Returns false when the old path is unknown or the destination already
    /// has a catalog record; callers can then use ordinary path refresh.
    pub fn move_indexed_resource_path(
        &self,
        notebook_id: &str,
        old_relative_path: &str,
        new_relative_path: &str,
    ) -> std::io::Result<bool> {
        let old_relative_path = normalize_resource_relative_path(old_relative_path)?;
        let new_relative_path = normalize_resource_relative_path(new_relative_path)?;
        if old_relative_path == new_relative_path {
            return Ok(false);
        }
        let root = self
            .memo_base_for_notebook_id_result(notebook_id)
            .map_err(std::io::Error::other)?;
        let policy = self.file_management_policy(notebook_id);
        if policy.is_index_hidden_at(&root, Path::new(&old_relative_path))
            || policy.is_index_hidden_at(&root, Path::new(&new_relative_path))
        {
            return Ok(false);
        }
        let new_absolute = super::notebook_path_from_relative(&root, &new_relative_path)
            .map_err(std::io::Error::other)?;
        let metadata = fs::symlink_metadata(&new_absolute)?;
        let is_directory = metadata.is_dir() && is_directory_resource_bundle(&new_absolute);
        if metadata.file_type().is_symlink() || (!metadata.is_file() && !is_directory)
            || !fs::canonicalize(&new_absolute)?.starts_with(fs::canonicalize(&root)?)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "renamed resource path is not a regular notebook file",
            ));
        }
        let kind = resource_kind_for_path(&new_absolute).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "unsupported resource type")
        })?;
        let format = resource_format_for_path(&new_absolute);
        let size = if is_directory { 0 } else { metadata.len() };
        let modified = modified_ms(&new_absolute);
        let fingerprint = (kind.is_media() && !is_directory)
            .then(|| stable_fingerprint(&new_absolute, size));
        let new_id = resource_catalog_id(notebook_id, &new_relative_path)?;
        let mut conn = self.open_notebook_db(notebook_id)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_to_io)?;
        let destination_exists = tx
            .query_row(
                "SELECT 1 FROM resource_catalog WHERE notebook_id=?1 AND relative_path=?2",
                params![notebook_id, new_relative_path],
                |_| Ok(()),
            )
            .optional()
            .map_err(sqlite_to_io)?
            .is_some();
        if destination_exists {
            return Ok(false);
        }
        let changed = tx
            .execute(
                "UPDATE resource_catalog SET id=?1, relative_path=?2, kind=?3, format=?4,
                    is_directory=?5, size_bytes=?6, modified_ms=?7, fingerprint=?8,
                    missing_since=NULL, deleted_at=NULL, updated_at=?9
                 WHERE notebook_id=?10 AND relative_path=?11",
                params![
                    new_id,
                    new_relative_path,
                    kind.as_str(),
                    format,
                    is_directory,
                    size as i64,
                    modified as i64,
                    fingerprint,
                    now_ms(),
                    notebook_id,
                    old_relative_path,
                ],
            )
            .map_err(sqlite_to_io)?;
        tx.commit().map_err(sqlite_to_io)?;
        Ok(changed > 0)
    }


    /// Copy missing media records once, retaining the source table for recovery.
    /// The completion receipt commits with the copied records so retries cannot
    /// resurrect records deliberately deleted after a successful migration.
    pub fn migrate_legacy_media_resources_to_catalog(
        &self,
        notebook_id: &str,
    ) -> std::io::Result<usize> {
        // Respect receipts written by earlier desktop versions as well as the
        // notebook-local receipt below. Retained sources are not a live mirror.
        if self.local_migration_completed(
            &super::NotebookInitializationJob::MigrateResourceCatalog.key(notebook_id),
        )? {
            return Ok(0);
        }
        let mut conn = self.open_notebook_db(notebook_id)?;
        let has_legacy_table: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_resources')",
                [],
                |row| row.get(0),
            )
            .map_err(sqlite_to_io)?;
        if !has_legacy_table {
            return Ok(0);
        }
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_to_io)?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS notebook_data_migrations (
            notebook_id TEXT NOT NULL, migration_key TEXT NOT NULL, version INTEGER NOT NULL,
            completed_at INTEGER NOT NULL, PRIMARY KEY(notebook_id, migration_key));",
        )
        .map_err(sqlite_to_io)?;
        let completed: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notebook_data_migrations WHERE notebook_id=?1
                AND migration_key='legacy_media_catalog_copy_v1' AND version>=1)",
                params![notebook_id],
                |row| row.get(0),
            )
            .map_err(sqlite_to_io)?;
        if completed {
            return Ok(0);
        }
        let rows = {
            let mut statement = tx
                .prepare(
                    "SELECT notebook_id, relative_path, kind, size_bytes, modified_ms,
                            fingerprint, properties, properties_revision, missing_since,
                            deleted_at, created_at, updated_at
                     FROM media_resources WHERE notebook_id=?1 ORDER BY relative_path",
                )
                .map_err(sqlite_to_io)?;
            let rows = statement
                .query_map([notebook_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, Option<i64>>(8)?,
                        row.get::<_, Option<i64>>(9)?,
                        row.get::<_, i64>(10)?,
                        row.get::<_, i64>(11)?,
                    ))
                })
                .map_err(sqlite_to_io)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_to_io)?
        };
        let mut migrated = 0;
        for (row_notebook_id, path, old_kind, size, modified, fingerprint, properties,
             properties_revision, missing_since, deleted_at, created_at, updated_at) in rows {
            let relative_path = normalize_resource_relative_path(&path)?;
            let target_exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM resource_catalog WHERE notebook_id=?1 AND relative_path=?2)",
                params![row_notebook_id, relative_path], |row| row.get(0),
            ).map_err(sqlite_to_io)?;
            if target_exists {
                continue;
            }
            let kind = match parse_kind(&old_kind) {
                Some(MediaResourceKind::Image) => ResourceKind::Image,
                Some(MediaResourceKind::Video) => ResourceKind::Video,
                None => resource_kind_for_path(Path::new(&relative_path)).ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid legacy media kind")
                })?,
            };
            let id = resource_catalog_id(&row_notebook_id, &relative_path)?;
            let format = resource_format_for_path(Path::new(&relative_path));
            tx.execute(
                "INSERT INTO resource_catalog
                    (id, notebook_id, relative_path, kind, format, size_bytes, modified_ms,
                     fingerprint, properties, properties_revision, missing_since, deleted_at,
                     created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                 ON CONFLICT(notebook_id, relative_path) DO NOTHING",
                params![
                    id,
                    row_notebook_id,
                    relative_path,
                    kind.as_str(),
                    format,
                    size,
                    modified,
                    fingerprint,
                    properties,
                    properties_revision,
                    missing_since,
                    deleted_at,
                    created_at,
                    updated_at,
                ],
            )
            .map_err(sqlite_to_io)?;
            migrated += 1;
        }
        // Records and receipt must commit atomically. Keep the old table for recovery.
        tx.execute(
            "INSERT INTO notebook_data_migrations (notebook_id,migration_key,version,completed_at)
            VALUES (?1,'legacy_media_catalog_copy_v1',1,?2)",
            params![notebook_id, chrono::Utc::now().timestamp_millis()],
        )
        .map_err(sqlite_to_io)?;
        tx.commit().map_err(sqlite_to_io)?;
        Ok(migrated)
    }

    /// Replace historical generated media IDs and normalize media library
    /// references. Database and document updates are idempotent so startup can
    /// safely retry after an interrupted run.
    pub fn migrate_media_resource_identities(&self, notebook_id: &str) -> std::io::Result<usize> {
        let root = self
            .memo_base_for_notebook_id_result(notebook_id)
            .map_err(std::io::Error::other)?;
        let mut conn = self.open_notebook_db(notebook_id)?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sqlite_to_io)?;
        let has_legacy_table: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_resources')",
                [],
                |row| row.get(0),
            )
            .map_err(sqlite_to_io)?;
        let identity_table = if has_legacy_table {
            "media_resources"
        } else {
            "resource_catalog"
        };
        let rows = {
            let mut statement = tx
                .prepare(&format!(
                    "SELECT id, relative_path FROM {identity_table} WHERE notebook_id=?1 ORDER BY relative_path"
                ))
                .map_err(sqlite_to_io)?;
            let rows = statement
                .query_map([notebook_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(sqlite_to_io)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_to_io)?
        };
        let mut updates = Vec::new();
        let mut targets = HashSet::new();
        for (old_id, old_path) in rows {
            let relative_path = normalize_resource_relative_path(&old_path)?;
            let id = resource_catalog_id(notebook_id, &relative_path)?;
            if !targets.insert(id.clone()) {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "duplicate canonical media resource identity"));
            }
            if old_id != id || old_path != relative_path {
                let temporary_id = format!("__flowix_media_migration__{}", uuid::Uuid::now_v7().simple());
                updates.push((old_id, temporary_id, id, relative_path));
            }
        }
        for (old_id, temporary_id, _, _) in &updates {
            tx.execute(
                &format!("UPDATE {identity_table} SET id=?1 WHERE notebook_id=?2 AND id=?3"),
                params![temporary_id, notebook_id, old_id],
            ).map_err(sqlite_to_io)?;
        }
        for (_, temporary_id, id, relative_path) in &updates {
            tx.execute(
                &format!("UPDATE {identity_table} SET id=?1, relative_path=?2 WHERE notebook_id=?3 AND id=?4"),
                params![id, relative_path, notebook_id, temporary_id],
            ).map_err(sqlite_to_io)?;
        }
        tx.commit().map_err(sqlite_to_io)?;
        drop(conn);

        let mut changed = updates.len();
        let walker = walkdir::WalkDir::new(&root).follow_links(false).into_iter().filter_entry(|entry| {
            if entry.depth() == 0 || !entry.file_type().is_dir() { return true; }
            let name = entry.file_name().to_string_lossy();
            if name == ".flowix" || name == ".plugin-output" { return false; }
            let internal = entry.path().join(".flowix");
            !(internal.join("notebook.json").is_file() || internal.join("notebook.db").is_file())
        });
        for entry in walker {
            let entry = entry.map_err(std::io::Error::other)?;
            if !entry.file_type().is_file() { continue; }
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if !(name == ".index.yaml" || name.ends_with(".lib.yaml") || name.ends_with(".lib.yml")) { continue; }
            let path = entry.path();
            let source = fs::read_to_string(path)?;
            let Ok(mut document) = crate::collection::CollectionDocument::parse(&source) else {
                // Do not block startup on a damaged collection. The explicit
                // collection recovery flow rewrites its media IDs when repaired.
                tracing::warn!(path = %path.display(), "skip malformed collection during media identity migration");
                continue;
            };
            if document.collection.kind != crate::collection::CollectionType::MediaLibrary { continue; }
            document = match document.normalized_v2() {
                Ok(document) => document,
                Err(error) => {
                    tracing::warn!(path = %path.display(), %error,
                        "skip invalid collection during media identity migration");
                    continue;
                }
            };
            let changed_ids = document
                .normalize_media_resource_ids(notebook_id)
                .map_err(std::io::Error::other)?;
            if !changed_ids { continue; }
            document.revise().map_err(std::io::Error::other)?;
            let next = document.serialize().map_err(std::io::Error::other)?;
            match self.write_file_if_matches_for_notebook(notebook_id, path, &next, Some(&source))? {
                super::FileWriteOutcome::Saved => changed += 1,
                super::FileWriteOutcome::Conflict { .. } => {
                    return Err(std::io::Error::new(std::io::ErrorKind::WouldBlock, format!("media library changed during identity migration: {}", path.display())));
                }
            }
        }
        Ok(changed)
    }

    /// Rebuild the shared catalog from supported notebook files. File contents
    /// are not parsed; existing media properties remain attached to their rows.
    pub fn reconcile_media_resources(&self, notebook_id: &str) -> std::io::Result<usize> {
        self.reconcile_resources(notebook_id)
    }

    pub fn reconcile_media_resources_background(
        &self, notebook_id: &str, keep_running: &dyn Fn() -> bool,
    ) -> std::io::Result<usize> {
        self.reconcile_resources_background(notebook_id, keep_running)
    }

    pub fn reconcile_resources(&self, notebook_id: &str) -> std::io::Result<usize> {
        self.reconcile_resources_background(notebook_id, &|| true)
    }

    pub fn reconcile_resources_background(
        &self, notebook_id: &str, keep_running: &dyn Fn() -> bool,
    ) -> std::io::Result<usize> {
        self.reconcile_resources_background_with_changes(notebook_id, keep_running)
            .map(|(indexed, _changed_kinds)| indexed)
    }

    /// Reconcile the shared catalog and report which visible resource kinds changed.
    /// The background worker uses this to avoid unrelated refresh events after a scan.
    pub fn reconcile_resources_background_with_changes(
        &self, notebook_id: &str, keep_running: &dyn Fn() -> bool,
    ) -> std::io::Result<(usize, Vec<ResourceKind>)> {
        let root = self
            .memo_base_for_notebook_id_result(notebook_id)
            .map_err(std::io::Error::other)?;
        // Import legacy properties before a scan can manufacture placeholder
        // target rows. Failure leaves legacy data pending and stops this scan.
        self.migrate_legacy_media_resources_to_catalog(notebook_id)?;
        // Snapshot the catalog once. Unchanged files need neither another
        // SQLite connection nor a media fingerprint read on every launch.
        let existing: HashMap<String, (String, String, bool, u64, u64, bool)> = {
            let conn = self.open_notebook_db(notebook_id)?;
            let mut statement = conn
                .prepare(
                    "SELECT relative_path, kind, format, is_directory, size_bytes, modified_ms,
                            missing_since IS NULL AND deleted_at IS NULL
                     FROM resource_catalog WHERE notebook_id = ?1",
                )
                .map_err(sqlite_to_io)?;
            let rows = statement
                .query_map(params![notebook_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        (
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, bool>(3)?,
                            row.get::<_, i64>(4)?.max(0) as u64,
                            row.get::<_, i64>(5)?.max(0) as u64,
                            row.get::<_, bool>(6)?,
                        ),
                    ))
                })
                .map_err(sqlite_to_io)?;
            rows.collect::<Result<_, _>>().map_err(sqlite_to_io)?
        };
        let policy = self.file_management_policy(notebook_id);
        let mut seen = HashSet::new();
        let mut indexed = 0usize;
        let mut changed_kinds = BTreeSet::new();
        for entry in walkdir::WalkDir::new(&root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                if entry.depth() > 0 && is_inside_directory_resource_bundle(entry.path(), &root) {
                    return false;
                }
                entry.path().strip_prefix(&root)
                    .is_ok_and(|relative| relative.as_os_str().is_empty() || !policy.is_index_hidden_at(&root, relative))
            })
        {
            if !keep_running() { return Err(std::io::Error::from(std::io::ErrorKind::Interrupted)); }
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    // An incomplete directory walk is not evidence of deletion.
                    return Err(std::io::Error::other(error));
                }
            };
            let is_directory = entry.file_type().is_dir()
                && is_directory_resource_bundle(entry.path());
            if !entry.file_type().is_file() && !is_directory {
                continue;
            }
            let Some(kind) = resource_kind_for_path(entry.path()) else {
                continue;
            };
            let relative = super::notebook_relative_path(&root, entry.path())
                .map_err(std::io::Error::other)?;
            let format = resource_format_for_path(entry.path());
            if let Some((old_kind, old_format, old_is_directory, old_size, old_modified, active)) = existing.get(&relative) {
                let metadata = entry.metadata().map_err(std::io::Error::other)?;
                let indexed_size = if is_directory { 0 } else { metadata.len() };
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as u64)
                    .unwrap_or(0);
                if *active
                    && old_kind == kind.as_str()
                    && old_format == &format
                    && *old_is_directory == is_directory
                    && *old_size == indexed_size
                    && *old_modified == modified
                {
                    seen.insert(relative);
                    indexed += 1;
                    continue;
                }
                if *active {
                    if let Some(old_kind) = parse_resource_kind(old_kind) {
                        changed_kinds.insert(old_kind);
                    }
                }
            }
            match self.ensure_indexed_resource(notebook_id, &relative, kind, entry.path()) {
                Ok(_) => {
                    changed_kinds.insert(kind);
                    seen.insert(relative);
                    indexed += 1;
                }
                Err(error) => return Err(error),
            }
        }

        let conn = self.open_notebook_db(notebook_id)?;
        let mut statement = conn
            .prepare(
                "SELECT id, relative_path, kind, missing_since, deleted_at
                      FROM resource_catalog WHERE notebook_id = ?1",
            )
            .map_err(sqlite_to_io)?;
        let stale: Vec<(String, String, String, Option<i64>, Option<i64>)> = statement
            .query_map(params![notebook_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
            })
            .map_err(sqlite_to_io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_to_io)?;
        drop(statement);
        let now = now_ms();
        for (id, relative, kind, missing_since, deleted_at) in stale {
            if !keep_running() { return Err(std::io::Error::from(std::io::ErrorKind::Interrupted)); }
            if !root.is_dir() { return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "notebook unavailable")); }
            if !seen.contains(&relative) {
                if policy.is_index_hidden_at(&root, Path::new(&relative)) {
                    continue;
                }
                // A file can reappear after its directory was enumerated. A
                // stale scan must not retire its catalog entry or user properties.
                let candidate = super::notebook_path_from_relative(&root, &relative)
                    .map_err(std::io::Error::other)?;
                match fs::symlink_metadata(&candidate) {
                    Ok(_) => continue,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
                if !root.is_dir() {
                    return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "notebook unavailable"));
                }
                let first_missing_at = missing_since.unwrap_or(now);
                let updated = conn.execute(
                    "UPDATE resource_catalog
                     SET missing_since = COALESCE(missing_since, ?1),
                         updated_at = CASE WHEN missing_since IS NULL THEN ?1 ELSE updated_at END
                     WHERE notebook_id = ?2 AND id = ?3 AND relative_path = ?4
                       AND missing_since IS ?5 AND deleted_at IS ?6",
                    params![first_missing_at, notebook_id, id, relative, missing_since, deleted_at],
                )
                .map_err(sqlite_to_io)?;
                if updated > 0 && missing_since.is_none() && deleted_at.is_none() {
                    if let Some(kind) = parse_resource_kind(&kind) {
                        changed_kinds.insert(kind);
                    }
                }
                if first_missing_at < now - RESOURCE_MISSING_RETENTION_MS
                    || deleted_at.is_some()
                        && deleted_at.unwrap_or(now) < now - RESOURCE_MISSING_RETENTION_MS
                {
                    conn.execute(
                        "DELETE FROM resource_catalog
                         WHERE notebook_id = ?1 AND id = ?2 AND relative_path = ?3
                           AND missing_since = ?4 AND deleted_at IS ?5",
                        params![notebook_id, id, relative, first_missing_at, deleted_at],
                    )
                    .map_err(sqlite_to_io)?;
                }
            }
        }
        conn.execute(
            "INSERT INTO notebook_index_meta (key, value)
             VALUES ('media_legacy_sidecars_imported_v1', '1')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        )
        .map_err(sqlite_to_io)?;
        Ok((indexed, changed_kinds.into_iter().collect()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_resource_identity_is_notebook_and_normalized_relative_path() {
        assert_eq!(
            media_resource_id("nb_one", "photos\\summer.png").unwrap(),
            "nb_one::photos/summer.png"
        );
        assert_ne!(
            media_resource_id("nb_one", "photos/summer.png").unwrap(),
            media_resource_id("nb_two", "photos/summer.png").unwrap()
        );
        assert!(media_resource_id("nb_one", "../summer.png").is_err());
    }

    #[test]
    fn legacy_media_migration_preserves_existing_targets_and_retains_sources() {
        let (memo, _temp, root) = fixture();
        fs::write(root.join("kept.png"), b"image").unwrap();
        let resource = memo
            .ensure_media_resource(
                "nb_media_test",
                "kept.png",
                MediaResourceKind::Image,
                &root.join("kept.png"),
            )
            .unwrap();
        let conn = memo.open_notebook_db("nb_media_test").unwrap();
        conn.execute_batch(
            "CREATE TABLE media_resources AS SELECT id, notebook_id, relative_path, kind,
            size_bytes, modified_ms, fingerprint, properties, properties_revision, missing_since,
            deleted_at, created_at, updated_at FROM resource_catalog;
            UPDATE media_resources SET properties='{\"caption\":\"legacy\"}';",
        )
        .unwrap();
        memo.update_media_resource_properties(
            "nb_media_test",
            &resource.id,
            &serde_json::json!({"caption":"current"}),
        )
        .unwrap();
        assert_eq!(
            memo.migrate_legacy_media_resources_to_catalog("nb_media_test")
                .unwrap(),
            0
        );
        assert_eq!(
            memo.read_media_resource("nb_media_test", "kept.png")
                .unwrap()
                .unwrap()
                .properties["caption"],
            "current"
        );
        conn.execute("DELETE FROM resource_catalog", []).unwrap();
        assert_eq!(
            memo.migrate_legacy_media_resources_to_catalog("nb_media_test")
                .unwrap(),
            0
        );
        assert!(memo
            .read_media_resource("nb_media_test", "kept.png")
            .unwrap()
            .is_none());
        assert_eq!(
            memo.migrate_legacy_media_resources_to_catalog("nb_media_test")
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM media_resources", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn resource_scan_imports_legacy_properties_before_creating_targets() {
        let (memo, _temp, root) = fixture();
        fs::write(root.join("photo.png"), b"image").unwrap();
        let conn = memo.open_notebook_db("nb_media_test").unwrap();
        conn.execute_batch("CREATE TABLE media_resources (id TEXT, notebook_id TEXT, relative_path TEXT, kind TEXT,
            size_bytes INTEGER, modified_ms INTEGER, fingerprint TEXT, properties TEXT, properties_revision INTEGER,
            missing_since INTEGER, deleted_at INTEGER, created_at INTEGER, updated_at INTEGER);
            INSERT INTO media_resources VALUES ('old-id','nb_media_test','photo.png','image',5,1,NULL,
                '{\"caption\":\"legacy metadata\"}',3,NULL,NULL,1,1);").unwrap();
        memo.reconcile_resources("nb_media_test").unwrap();
        let after = memo
            .read_media_resource("nb_media_test", "photo.png")
            .unwrap()
            .unwrap();
        assert_eq!(after.properties["caption"], "legacy metadata");
        assert_eq!(after.properties_revision, 3);
        conn.execute("DELETE FROM resource_catalog", []).unwrap();
        assert_eq!(
            memo.migrate_legacy_media_resources_to_catalog("nb_media_test")
                .unwrap(),
            0
        );
        assert!(memo
            .read_media_resource("nb_media_test", "photo.png")
            .unwrap()
            .is_none());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM media_resources", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn failed_legacy_copy_rolls_back_records_and_receipt_for_retry() {
        let (memo, _temp, _root) = fixture();
        let conn = memo.open_notebook_db("nb_media_test").unwrap();
        conn.execute_batch("CREATE TABLE media_resources (id TEXT, notebook_id TEXT, relative_path TEXT, kind TEXT,
            size_bytes INTEGER, modified_ms INTEGER, fingerprint TEXT, properties TEXT, properties_revision INTEGER,
            missing_since INTEGER, deleted_at INTEGER, created_at INTEGER, updated_at INTEGER);
            INSERT INTO media_resources VALUES ('one','nb_media_test','a.png','image',5,1,NULL,'{}',0,NULL,NULL,1,1);
            INSERT INTO media_resources VALUES ('two','nb_media_test','z.unknown','invalid',5,1,NULL,'{}',0,NULL,NULL,1,1);").unwrap();
        assert!(memo
            .migrate_legacy_media_resources_to_catalog("nb_media_test")
            .is_err());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM resource_catalog", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        conn.execute("UPDATE media_resources SET kind='image' WHERE id='two'", [])
            .unwrap();
        assert_eq!(
            memo.migrate_legacy_media_resources_to_catalog("nb_media_test")
                .unwrap(),
            2
        );
        conn.execute("DELETE FROM resource_catalog", []).unwrap();
        assert_eq!(
            memo.migrate_legacy_media_resources_to_catalog("nb_media_test")
                .unwrap(),
            0
        );
    }

    #[test]
    fn previous_desktop_completion_receipt_does_not_replay_retained_media() {
        let (memo, _temp, _root) = fixture();
        let conn = memo.open_notebook_db("nb_media_test").unwrap();
        conn.execute_batch("CREATE TABLE media_resources (unrecognized_legacy_shape TEXT);")
            .unwrap();
        memo.mark_local_migration_completed(
            &super::super::NotebookInitializationJob::MigrateResourceCatalog.key("nb_media_test"),
        )
        .unwrap();
        assert_eq!(
            memo.migrate_legacy_media_resources_to_catalog("nb_media_test")
                .unwrap(),
            0
        );
    }

    #[test]
    fn background_note_preparation_preserves_shared_media_properties() {
        let (memo, _temp, root) = fixture();
        fs::write(root.join("kept.png"), b"image").unwrap();
        fs::write(root.join("note.md"), "# Note").unwrap();
        let media = memo.ensure_media_resource("nb_media_test", "kept.png", MediaResourceKind::Image, &root.join("kept.png")).unwrap();
        memo.update_media_resource_properties("nb_media_test", &media.id, &serde_json::json!({"caption":"user data"})).unwrap();
        memo.prepare_background_note_projection("nb_media_test").unwrap();
        memo.reconcile_note_index_background("nb_media_test", &|| true).unwrap();
        let after = memo.read_media_resource("nb_media_test", "kept.png").unwrap().unwrap();
        assert_eq!(after.id, media.id);
        assert_eq!(after.properties["caption"], "user data");
    }

    #[test]
    fn media_reappearing_after_enumeration_keeps_its_catalog_entry() {
        let (memo, _temp, root) = fixture();
        let path = root.join("returned.png");
        fs::write(&path, b"image").unwrap();
        memo.reconcile_media_resources("nb_media_test").unwrap();
        let before = memo.read_media_resource("nb_media_test", "returned.png").unwrap().unwrap();
        fs::remove_file(&path).unwrap();
        let checks = std::cell::Cell::new(0);
        memo.reconcile_media_resources_background("nb_media_test", &|| {
            checks.set(checks.get() + 1);
            // The empty root is visited first, then the stale catalog row.
            if checks.get() == 2 { fs::write(&path, b"image").unwrap(); }
            true
        }).unwrap();
        assert!(path.is_file());
        let conn = memo.open_notebook_db("nb_media_test").unwrap();
        let missing: Option<i64> = conn.query_row("SELECT missing_since FROM resource_catalog WHERE id=?1", [&before.id], |row| row.get(0)).unwrap();
        assert!(missing.is_none());
    }

    #[test]
    fn stale_media_cleanup_cannot_delete_a_concurrently_restored_catalog_row() {
        let (memo, _temp, root) = fixture();
        let old_path = root.join("old.png");
        fs::write(&old_path, b"image").unwrap();
        memo.reconcile_media_resources("nb_media_test").unwrap();
        let before = memo.read_media_resource("nb_media_test", "old.png").unwrap().unwrap();
        let conn = memo.open_notebook_db("nb_media_test").unwrap();
        conn.execute("UPDATE resource_catalog SET missing_since=1, deleted_at=1 WHERE id=?1", [&before.id]).unwrap();
        fs::remove_file(&old_path).unwrap();
        let checks = std::cell::Cell::new(0);
        memo.reconcile_media_resources_background("nb_media_test", &|| {
            checks.set(checks.get() + 1);
            if checks.get() == 2 {
                fs::write(root.join("new.png"), b"image").unwrap();
                conn.execute(
                    "UPDATE resource_catalog SET id=?1, relative_path='new.png', missing_since=NULL, deleted_at=NULL WHERE id=?2",
                    params![media_resource_id("nb_media_test", "new.png").unwrap(), before.id],
                ).unwrap();
            }
            true
        }).unwrap();
        let after = memo.read_media_resource("nb_media_test", "new.png").unwrap().unwrap();
        assert_eq!(after.id, media_resource_id("nb_media_test", "new.png").unwrap());
        assert_ne!(after.id, before.id);
        let missing: Option<i64> = conn.query_row("SELECT missing_since FROM resource_catalog WHERE id=?1", [&after.id], |row| row.get(0)).unwrap();
        assert!(missing.is_none());
    }

    #[test]
    fn cancelled_media_scan_never_marks_unvisited_resources_missing() {
        let (memo, _temp, root) = fixture();
        fs::write(root.join("kept.png"), b"image").unwrap();
        memo.reconcile_media_resources("nb_media_test").unwrap();
        let before = memo.read_media_resource("nb_media_test", "kept.png").unwrap().unwrap();
        assert_eq!(memo.reconcile_media_resources_background("nb_media_test", &|| false).unwrap_err().kind(), std::io::ErrorKind::Interrupted);
        let after = memo.read_media_resource("nb_media_test", "kept.png").unwrap().unwrap();
        assert_eq!(before.id, after.id);
        let conn = memo.open_notebook_db("nb_media_test").unwrap();
        let missing: Option<i64> = conn.query_row("SELECT missing_since FROM resource_catalog WHERE id=?1", [&before.id], |row| row.get(0)).unwrap();
        assert!(missing.is_none());
    }

    #[test]
    fn directory_index_rebase_updates_media_path_identity_and_preserves_projections() {
        let (memo, _temp, root) = fixture();
        fs::create_dir(root.join("Old")).unwrap();
        fs::create_dir(root.join("Oldish")).unwrap();
        fs::write(root.join("Old/photo.png"), b"image").unwrap();
        fs::write(root.join("Old/note.md"), "hello").unwrap();
        fs::write(root.join("Oldish/keep.png"), b"outside").unwrap();
        memo.refresh_media_resource_path("nb_media_test", "Old/photo.png").unwrap();
        memo.refresh_media_resource_path("nb_media_test", "Oldish/keep.png").unwrap();
        memo.refresh_note_path("nb_media_test", "Old/note.md").unwrap();
        let before = memo.read_media_resource("nb_media_test", "Old/photo.png").unwrap().unwrap();
        memo.update_media_resource_properties("nb_media_test", &before.id, &serde_json::json!({"caption":"keep"})).unwrap();
        let conn = memo.open_note_index_connection("nb_media_test").unwrap();
        conn.execute("UPDATE notes SET tags='[\"keep\"]' WHERE relative_path='Old/note.md'", []).unwrap();
        conn.execute("UPDATE notes SET created_at=42 WHERE relative_path='Old/note.md'", []).unwrap();
        drop(conn);
        fs::rename(root.join("Old"), root.join("New")).unwrap();
        for _ in 0..2 {
            memo.with_notebook_change(&["nb_media_test"], "test_directory_rebase", ||
                memo.rebase_directory_indexes("nb_media_test", "Old", "New")).unwrap();
        }
        let after = memo.read_media_resource("nb_media_test", "New/photo.png").unwrap().unwrap();
        assert_eq!(after.id, media_resource_id("nb_media_test", "New/photo.png").unwrap());
        assert_ne!(after.id, before.id);
        assert_eq!(after.fingerprint, before.fingerprint);
        assert_eq!(after.properties["caption"], "keep");
        assert!(memo.read_media_resource("nb_media_test", "Old/photo.png").unwrap().is_none());
        assert!(memo.read_media_resource("nb_media_test", "Oldish/keep.png").unwrap().is_some());
        let conn = memo.open_note_index_connection("nb_media_test").unwrap();
        assert_eq!(conn.query_row("SELECT created_at FROM notes WHERE relative_path='New/note.md'", [], |row| row.get::<_, i64>(0)).unwrap(), 42);
        assert_eq!(conn.query_row("SELECT tags FROM notes WHERE relative_path='New/note.md'", [], |row| row.get::<_, String>(0)).unwrap(), "[\"keep\"]");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM notes WHERE relative_path='Old/note.md'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn path_refresh_preserves_media_properties_across_rename_and_removal() {
        let (memo_file, _temp, root) = fixture();
        let old = root.join("old.png");
        let new = root.join("new.png");
        fs::write(&old, b"image bytes").unwrap();
        memo_file.refresh_media_resource_path("nb_media_test", "old.png").unwrap();
        let resource = memo_file.read_media_resource("nb_media_test", "old.png")
            .unwrap().unwrap();
        let properties = serde_json::json!({"caption": "Keep me"});
        memo_file.update_media_resource_properties(
            "nb_media_test", &resource.id, &properties,
        ).unwrap();

        fs::rename(&old, &new).unwrap();
        memo_file.refresh_media_resource_path("nb_media_test", "new.png").unwrap();
        memo_file.refresh_media_resource_path("nb_media_test", "old.png").unwrap();
        let renamed = memo_file.read_media_resource("nb_media_test", "new.png")
            .unwrap().unwrap();
        assert_eq!(renamed.id, media_resource_id("nb_media_test", "new.png").unwrap());
        assert_ne!(renamed.id, resource.id);
        assert_eq!(renamed.properties, properties);

        fs::remove_file(&new).unwrap();
        memo_file.refresh_media_resource_path("nb_media_test", "new.png").unwrap();
        assert!(memo_file.read_media_resource("nb_media_test", "new.png").unwrap().is_none());
    }

    fn fixture() -> (MemoFile, tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir_all(&root).unwrap();
        let mut memo_file = MemoFile::new(temp.path().join("config"));
        memo_file
            .write_notebook_configs(&[super::super::types::NotebookConfig {
                id: "nb_media_test".to_string(),
                name: "Media test".to_string(),
                icon: None,
                path: root.to_string_lossy().to_string(),
                is_default: true,
                sort: 0,
                created_at: 0,
                updated_at: 0,
            }])
            .unwrap();
        memo_file.set_current_notebook(Some("nb_media_test".to_string()));
        (memo_file, temp, root)
    }

    fn media_library_source(include_path: &str, exclude_path: &str) -> String {
        serde_yaml::to_string(&serde_json::json!({
            "format": "flowix.collection",
            "schema_version": 2,
            "collection": {
                "id": format!("col_{}", "a".repeat(32)),
                "type": "media_library",
                "revision": 4,
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z",
                "properties": {}
            },
            "payload": {
                "schema_version": 2,
                "dataset": {
                    "source": {"scope": "notebook", "depth": "descendants"},
                    "schema": {"fields": []},
                    "records": {
                        "include": [{"resource_id": "media_old_photo", "relative_path": include_path}],
                        "exclude": [{"resource_id": "media_old_excluded", "relative_path": exclude_path}]
                    },
                    "filter": null
                },
                "views": {
                    "default_id": format!("view_{}", "b".repeat(32)),
                    "items": [{
                        "id": format!("view_{}", "b".repeat(32)),
                        "name": "All media",
                        "layout": "waterfall",
                        "filter": {"all": [], "any": []},
                        "sort": [{"field": "created_at", "direction": "desc"}],
                        "config": {}
                    }]
                }
            }
        }))
        .unwrap()
    }

    #[test]
    fn media_identity_migration_rewrites_database_and_collection_references_idempotently() {
        let (memo, _temp, root) = fixture();
        let photo = root.join("photo.png");
        fs::write(&photo, b"image").unwrap();
        let resource = memo.ensure_media_resource(
            "nb_media_test", "photo.png", MediaResourceKind::Image, &photo,
        ).unwrap();
        memo.update_media_resource_properties(
            "nb_media_test", &resource.id, &serde_json::json!({"caption": "keep me"}),
        ).unwrap();
        let conn = memo.open_notebook_db("nb_media_test").unwrap();
        conn.execute(
            "UPDATE resource_catalog SET id='media_old_photo' WHERE notebook_id='nb_media_test' AND relative_path='photo.png'",
            [],
        ).unwrap();
        drop(conn);

        let collection_path = root.join("Library.lib.yaml");
        fs::write(&collection_path, media_library_source("photo.png", "removed.png")).unwrap();
        assert_eq!(memo.migrate_media_resource_identities("nb_media_test").unwrap(), 2);

        let canonical_photo_id = media_resource_id("nb_media_test", "photo.png").unwrap();
        let migrated = memo.read_media_resource("nb_media_test", "photo.png").unwrap().unwrap();
        assert_eq!(migrated.id, canonical_photo_id);
        assert_eq!(migrated.properties["caption"], "keep me");

        let source = fs::read_to_string(&collection_path).unwrap();
        let document = crate::collection::CollectionDocument::parse(&source).unwrap();
        assert_eq!(document.payload["dataset"]["records"]["include"][0]["resource_id"], canonical_photo_id);
        assert_eq!(document.payload["dataset"]["records"]["exclude"][0]["resource_id"], media_resource_id("nb_media_test", "removed.png").unwrap());
        assert_eq!(document.collection.revision, 5);
        assert_eq!(memo.migrate_media_resource_identities("nb_media_test").unwrap(), 0);
    }

    #[test]
    fn media_identity_migration_skips_semantically_invalid_collections_and_continues() {
        let (memo, _temp, root) = fixture();
        let photo = root.join("photo.png");
        fs::write(&photo, b"image").unwrap();
        memo.ensure_media_resource(
            "nb_media_test", "photo.png", MediaResourceKind::Image, &photo,
        ).unwrap();
        let conn = memo.open_notebook_db("nb_media_test").unwrap();
        conn.execute(
            "UPDATE resource_catalog SET id='media_old_photo' WHERE notebook_id='nb_media_test' AND relative_path='photo.png'",
            [],
        ).unwrap();
        let stored_id: String = conn.query_row(
            "SELECT id FROM resource_catalog WHERE notebook_id='nb_media_test' AND relative_path='photo.png'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(stored_id, "media_old_photo");
        drop(conn);

        let invalid_path = root.join("Broken.lib.yaml");
        let invalid_source = media_library_source("../photo.png", "removed.png");
        fs::write(&invalid_path, &invalid_source).unwrap();
        assert_eq!(memo.migrate_media_resource_identities("nb_media_test").unwrap(), 1);
        assert_eq!(
            memo.read_media_resource("nb_media_test", "photo.png").unwrap().unwrap().id,
            media_resource_id("nb_media_test", "photo.png").unwrap(),
        );
        assert_eq!(fs::read_to_string(invalid_path).unwrap(), invalid_source);
    }

    #[test]
    fn media_kind_classifies_supported_files_only() {
        assert_eq!(
            media_kind_for_path(Path::new("photo.PNG")),
            Some(MediaResourceKind::Image)
        );
        assert_eq!(
            media_kind_for_path(Path::new("clip.mp4")),
            Some(MediaResourceKind::Video)
        );
        assert_eq!(media_kind_for_path(Path::new("readme.md")), None);
    }

    #[test]
    fn legacy_sidecar_is_imported_once_into_the_database() {
        let (memo_file, _temp, root) = fixture();
        let media = root.join("photo.png");
        fs::write(&media, b"media").unwrap();
        let properties = serde_json::json!({
            "title": "Reference",
            "tags": ["design", "review"],
            "approved": true,
        });

        let sidecar = MemoFile::legacy_media_properties_path(&media);
        fs::write(&sidecar, serde_yaml::to_string(&properties).unwrap()).unwrap();
        let resource = memo_file
            .ensure_media_resource(
                "nb_media_test",
                "photo.png",
                MediaResourceKind::Image,
                &media,
            )
            .unwrap();

        assert_eq!(resource.properties, properties);
        assert!(sidecar.is_file());
    }

    #[test]
    fn media_index_is_created_inside_notebook_flowix_directory() {
        let (memo_file, _temp, root) = fixture();
        let media = root.join("photo.png");
        fs::write(&media, b"image bytes").unwrap();

        let resource = memo_file
            .ensure_media_resource(
                "nb_media_test",
                "photo.png",
                MediaResourceKind::Image,
                &media,
            )
            .unwrap();

        assert_eq!(resource.relative_path, "photo.png");
        assert_eq!(
            memo_file.notebook_db_path("nb_media_test").unwrap(),
            root.join(".flowix/notebook.db")
        );
        assert!(root.join(".flowix/notebook.db").is_file());
    }

    #[test]
    fn missing_legacy_sidecar_is_an_empty_property_mapping() {
        let (memo_file, _temp, root) = fixture();
        let media = root.join("clip.mp4");
        fs::write(&media, b"video bytes").unwrap();

        let resource = memo_file
            .ensure_media_resource(
                "nb_media_test",
                "clip.mp4",
                MediaResourceKind::Video,
                &media,
            )
            .unwrap();
        assert_eq!(resource.properties, serde_json::json!({}));
    }

    #[test]
    fn malformed_legacy_sidecar_is_ignored_after_database_migration() {
        let (memo_file, _temp, root) = fixture();
        let media = root.join("photo.png");
        fs::write(&media, b"image bytes").unwrap();
        fs::write(
            MemoFile::legacy_media_properties_path(&media),
            "this: [is not valid yaml",
        )
        .unwrap();

        let resource = memo_file
            .ensure_media_resource(
                "nb_media_test",
                "photo.png",
                MediaResourceKind::Image,
                &media,
            )
            .unwrap();
        assert_eq!(resource.properties, serde_json::json!({}));
        assert!(root.join(".flowix/notebook.db").is_file());
        assert!(memo_file
            .read_media_resource("nb_media_test", "photo.png")
            .unwrap()
            .is_some());
    }

    #[test]
    fn deleting_the_index_and_rebuilding_recovers_media_but_not_database_properties() {
        let (memo_file, _temp, root) = fixture();
        let media = root.join("photo.png");
        fs::write(&media, b"image bytes").unwrap();
        let properties = serde_json::json!({"title": "Reference", "reviewed": true});
        let resource = memo_file
            .ensure_media_resource(
                "nb_media_test",
                "photo.png",
                MediaResourceKind::Image,
                &media,
            )
            .unwrap();
        memo_file
            .update_media_resource_properties("nb_media_test", &resource.id, &properties)
            .unwrap();

        assert_eq!(
            memo_file
                .reconcile_media_resources("nb_media_test")
                .unwrap(),
            1
        );
        let db = memo_file.notebook_db_path("nb_media_test").unwrap();
        fs::remove_file(&db).unwrap();
        for suffix in ["-wal", "-shm"] {
            let _ = fs::remove_file(format!("{}{}", db.display(), suffix));
        }

        assert_eq!(
            memo_file
                .reconcile_media_resources("nb_media_test")
                .unwrap(),
            1
        );
        let resource = memo_file
            .read_media_resource("nb_media_test", "photo.png")
            .unwrap()
            .unwrap();
        assert_eq!(resource.properties, serde_json::json!({}));
    }

    #[test]
    fn reconcile_keeps_a_tombstone_for_deleted_media() {
        let (memo_file, _temp, root) = fixture();
        let media = root.join("photo.png");
        fs::write(&media, b"image bytes").unwrap();
        memo_file
            .reconcile_media_resources("nb_media_test")
            .unwrap();
        fs::remove_file(&media).unwrap();

        assert_eq!(
            memo_file
                .reconcile_media_resources("nb_media_test")
                .unwrap(),
            0
        );
        assert!(memo_file
            .read_media_resource("nb_media_test", "photo.png")
            .unwrap()
            .is_some());
    }

    #[test]
    fn reconcile_skips_unchanged_media_and_refreshes_changed_files() {
        let (memo_file, _temp, root) = fixture();
        let media = root.join("photo.png");
        fs::write(&media, b"first").unwrap();
        memo_file
            .reconcile_media_resources("nb_media_test")
            .unwrap();
        {
            let conn = memo_file.open_notebook_db("nb_media_test").unwrap();
            conn.execute(
                "UPDATE resource_catalog SET updated_at = 123 WHERE relative_path = 'photo.png'",
                [],
            )
            .unwrap();
        }

        assert_eq!(
            memo_file
                .reconcile_media_resources("nb_media_test")
                .unwrap(),
            1
        );
        let unchanged = memo_file
            .read_media_resource("nb_media_test", "photo.png")
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.updated_at, 123);

        fs::write(&media, b"longer content").unwrap();
        assert_eq!(
            memo_file
                .reconcile_media_resources("nb_media_test")
                .unwrap(),
            1
        );
        let changed = memo_file
            .read_media_resource("nb_media_test", "photo.png")
            .unwrap()
            .unwrap();
        assert_eq!(changed.id, unchanged.id);
        assert_eq!(changed.size_bytes, b"longer content".len() as u64);
        assert_ne!(changed.fingerprint, unchanged.fingerprint);
        assert!(changed.updated_at > 123);
    }

    #[test]
    fn updating_a_resource_persists_properties_in_the_database() {
        let (memo_file, _temp, root) = fixture();
        let media = root.join("photo.png");
        fs::write(&media, b"image bytes").unwrap();
        let resource = memo_file
            .ensure_media_resource(
                "nb_media_test",
                "photo.png",
                MediaResourceKind::Image,
                &media,
            )
            .unwrap();

        let properties = serde_json::json!({"stage": "done"});
        let updated = memo_file
            .update_media_resource_properties("nb_media_test", &resource.id, &properties)
            .unwrap()
            .unwrap();
        assert_eq!(updated.properties, properties);
        let read_after_update = memo_file
            .read_media_resource("nb_media_test", "photo.png")
            .unwrap()
            .unwrap();
        assert_eq!(read_after_update.properties, properties);
        assert!(!MemoFile::legacy_media_properties_path(&media).exists());
    }

    #[test]
    fn refreshing_a_resource_does_not_overwrite_database_properties() {
        let (memo_file, _temp, root) = fixture();
        let media = root.join("photo.png");
        fs::write(&media, b"image bytes").unwrap();
        let resource = memo_file
            .ensure_media_resource(
                "nb_media_test",
                "photo.png",
                MediaResourceKind::Image,
                &media,
            )
            .unwrap();
        let properties = serde_json::json!({"stage": "reviewed"});
        let updated = memo_file
            .update_media_resource_properties("nb_media_test", &resource.id, &properties)
            .unwrap()
            .unwrap();

        let refreshed = memo_file
            .ensure_media_resource(
                "nb_media_test",
                "photo.png",
                MediaResourceKind::Image,
                &media,
            )
            .unwrap();
        assert_eq!(refreshed.properties, properties);
        assert_eq!(refreshed.properties_revision, updated.properties_revision);
    }

    #[test]
    fn stale_property_revision_is_rejected() {
        let (memo_file, _temp, root) = fixture();
        let media = root.join("photo.png");
        fs::write(&media, b"image bytes").unwrap();
        let resource = memo_file
            .ensure_media_resource(
                "nb_media_test",
                "photo.png",
                MediaResourceKind::Image,
                &media,
            )
            .unwrap();
        let first = serde_json::json!({"stage": "first"});
        let updated = memo_file
            .update_media_resource_properties_if_revision(
                "nb_media_test",
                &resource.id,
                &first,
                Some(resource.properties_revision),
            )
            .unwrap()
            .unwrap();
        let stale = memo_file.update_media_resource_properties_if_revision(
            "nb_media_test",
            &resource.id,
            &serde_json::json!({"stage": "stale"}),
            Some(resource.properties_revision),
        );
        assert_eq!(stale.unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
        assert_eq!(updated.properties, serde_json::json!({"stage": "first"}));
    }

    #[test]
    fn renamed_media_changes_its_path_id_and_keeps_database_properties() {
        let (memo_file, _temp, root) = fixture();
        let old_media = root.join("old.png");
        let new_media = root.join("new.png");
        fs::write(&old_media, b"image bytes").unwrap();
        let old_resource = memo_file
            .ensure_media_resource(
                "nb_media_test",
                "old.png",
                MediaResourceKind::Image,
                &old_media,
            )
            .unwrap();
        let properties = serde_json::json!({"title": "Keep me"});
        memo_file
            .update_media_resource_properties("nb_media_test", &old_resource.id, &properties)
            .unwrap();

        fs::rename(&old_media, &new_media).unwrap();
        let new_resource = memo_file
            .ensure_media_resource(
                "nb_media_test",
                "new.png",
                MediaResourceKind::Image,
                &new_media,
            )
            .unwrap();

        assert_eq!(new_resource.id, media_resource_id("nb_media_test", "new.png").unwrap());
        assert_ne!(new_resource.id, old_resource.id);
        assert_eq!(new_resource.properties, properties);
        assert!(!MemoFile::legacy_media_properties_path(&new_media).exists());
        assert!(!MemoFile::legacy_media_properties_path(&old_media).exists());
        assert!(memo_file
            .read_media_resource("nb_media_test", "old.png")
            .unwrap()
            .is_none());
    }
}
