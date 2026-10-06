//! Notebook-local media resource index.
//!
//! Media files remain on disk, while their user properties and resource
//! identity are stored in the notebook-local database at
//! `<notebook>/.flowix/notebook.db`. It is deliberately separate from the
//! global notebook registry database (`~/.flowix/index.db`).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::notebook::sqlite_to_io;
use super::MemoFile;

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

const MEDIA_MISSING_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

fn now_ms() -> i64 {
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
    // It must not contain the path or mtime: a media file can be renamed
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

pub fn media_kind_for_path(path: &Path) -> Option<MediaResourceKind> {
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
    ) {
        return Some(MediaResourceKind::Image);
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
        return Some(MediaResourceKind::Video);
    }
    None
}

impl MemoFile {
    pub(crate) fn open_notebook_db(&self, notebook_id: &str) -> std::io::Result<Connection> {
        let path = self.notebook_db_path(notebook_id)?;
        let mut conn = Connection::open(path).map_err(sqlite_to_io)?;
        conn.busy_timeout(std::time::Duration::from_secs(10))
            .map_err(sqlite_to_io)?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS media_resources (
                id TEXT PRIMARY KEY,
                notebook_id TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('image', 'video')),
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
            CREATE INDEX IF NOT EXISTS idx_media_resources_kind
                ON media_resources(kind);
            CREATE INDEX IF NOT EXISTS idx_media_resources_updated
                ON media_resources(updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_media_resources_fingerprint
                ON media_resources(fingerprint);
            CREATE TABLE IF NOT EXISTS notebook_index_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            "#,
        )
        .map_err(sqlite_to_io)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_to_io)?;
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
        tx.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_media_resources_missing
                 ON media_resources(missing_since, deleted_at);
             CREATE INDEX IF NOT EXISTS idx_media_resources_library_page
                 ON media_resources(notebook_id, deleted_at, missing_since, created_at DESC, id DESC);",
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
             FROM media_resources
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
    ) -> std::io::Result<MediaResourcePage> {
        let conn = self.open_notebook_db(notebook_id)?;
        let kind_filter = match kinds {
            [] => String::new(),
            [MediaResourceKind::Image] => " AND kind = 'image'".to_owned(),
            [MediaResourceKind::Video] => " AND kind = 'video'".to_owned(),
            _ => " AND kind IN ('image', 'video')".to_owned(),
        };
        let cursor_filter = if cursor.is_some() {
            " AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))"
        } else {
            ""
        };
        let limit = limit.clamp(1, 120).saturating_add(1) as i64;
        let sql = format!(
            "SELECT id, notebook_id, relative_path, kind, size_bytes, modified_ms,
                    fingerprint, properties, properties_revision, created_at, updated_at
             FROM media_resources
             WHERE notebook_id = ?1 AND deleted_at IS NULL AND missing_since IS NULL{kind_filter}{cursor_filter}
             ORDER BY created_at DESC, id DESC LIMIT ?{limit_param}",
            limit_param = if cursor.is_some() { 4 } else { 2 },
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
        let mut resources = if let Some((created_at, id)) = cursor {
            statement.query_map(params![notebook_id, created_at, id, limit], decode_row)
                .map_err(sqlite_to_io)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_to_io)?
        } else {
            statement.query_map(params![notebook_id, limit], decode_row)
                .map_err(sqlite_to_io)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_to_io)?
        };
        let has_more = resources.len() > limit as usize - 1;
        if has_more { resources.pop(); }
        let next_cursor = has_more.then(|| resources.last()).flatten()
            .map(|resource| format!("{}:{}", resource.created_at, resource.id));
        Ok(MediaResourcePage { resources, next_cursor, has_more })
    }

    /// Register or refresh a media path. The file itself is never modified.
    pub fn ensure_media_resource(
        &self,
        notebook_id: &str,
        relative_path: &str,
        kind: MediaResourceKind,
        absolute_path: &Path,
    ) -> std::io::Result<MediaResource> {
        let metadata = fs::metadata(absolute_path)?;
        if !metadata.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "media resource is not a file",
            ));
        }
        let size_bytes = metadata.len();
        let modified = modified_ms(absolute_path);
        let fingerprint = stable_fingerprint(absolute_path, size_bytes);
        let conn = self.open_notebook_db(notebook_id)?;
        let legacy_import_pending = conn
            .query_row(
                "SELECT 1 FROM notebook_index_meta
                 WHERE key = 'media_legacy_sidecars_imported_v1'",
                [],
                |_| Ok(()),
            )
            .optional()
            .map_err(sqlite_to_io)?
            .is_none();
        let mut existing = self.read_media_resource_record(notebook_id, relative_path)?;

        // Preserve the resource id and its database properties when a file was
        // renamed outside Flowix. Only associate an old row when its previous
        // media path is gone and the fingerprint is unique; identical copies
        // must not steal one another's metadata.
        if existing.is_none() {
            let mut candidates = conn
                .prepare(
                    "SELECT id, relative_path FROM media_resources
                     WHERE notebook_id = ?1 AND fingerprint = ?2 AND relative_path <> ?3
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
                        "UPDATE media_resources SET relative_path = ?1, updated_at = ?2,
                             missing_since = NULL, deleted_at = NULL
                         WHERE notebook_id = ?3 AND id = ?4",
                        params![relative_path, now_ms(), notebook_id, candidate_id],
                    )
                    .map_err(sqlite_to_io)?;
                    existing = self.read_media_resource_record(notebook_id, relative_path)?;
                }
            }
        }
        let id = existing
            .as_ref()
            .map(|record| record.resource.id.clone())
            .unwrap_or_else(|| format!("media_{}", uuid::Uuid::now_v7()));
        let created_at = existing
            .as_ref()
            .map(|record| record.resource.created_at)
            .unwrap_or_else(now_ms);
        let updated_at = now_ms();
        let properties = existing
            .as_ref()
            .map(|record| record.resource.properties.clone())
            .unwrap_or_else(|| {
                if !legacy_import_pending {
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
            INSERT INTO media_resources
                (id, notebook_id, relative_path, kind, size_bytes, modified_ms,
                 fingerprint, properties, properties_revision, missing_since, deleted_at,
                 created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, NULL, NULL, ?9, ?10)
            ON CONFLICT(notebook_id, relative_path) DO UPDATE SET
                kind = excluded.kind,
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
                size_bytes as i64,
                modified as i64,
                fingerprint,
                serde_json::to_string(&properties).unwrap_or_else(|_| "{}".to_string()),
                created_at,
                updated_at,
            ],
        )
        .map_err(sqlite_to_io)?;
        Ok(MediaResource {
            id,
            notebook_id: notebook_id.to_string(),
            relative_path: relative_path.to_string(),
            kind,
            size_bytes,
            modified_ms: modified,
            fingerprint: Some(fingerprint),
            properties,
            properties_revision: existing
                .as_ref()
                .map(|record| record.resource.properties_revision)
                .unwrap_or(0),
            created_at,
            updated_at,
        })
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
                "UPDATE media_resources SET properties = ?1, updated_at = ?2,
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
                "UPDATE media_resources SET properties = ?1, updated_at = ?2,
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
                        "SELECT 1 FROM media_resources
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
                "SELECT relative_path FROM media_resources WHERE notebook_id = ?1 AND id = ?2",
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
                "UPDATE media_resources
                 SET missing_since = COALESCE(missing_since, ?1),
                     deleted_at = ?1, updated_at = ?1
                 WHERE notebook_id = ?2 AND id = ?3",
                params![now, notebook_id, resource_id],
            )
            .map_err(sqlite_to_io)?;
        Ok(changed > 0)
    }

    /// Refresh or retire one media catalog path after a filesystem event.
    /// File bytes remain untouched; a missing resource is retained briefly so
    /// a rename can preserve its identity and user properties.
    pub fn refresh_media_resource_path(
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
            .is_ignored_at(&root, relative)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "media path is excluded by notebook policy",
            ));
        }
        let absolute = super::notebook_path_from_relative(&root, relative_path)
            .map_err(std::io::Error::other)?;
        match fs::symlink_metadata(&absolute) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "media resource is not a regular file",
                    ));
                }
                let canonical_root = fs::canonicalize(&root)?;
                let canonical_path = fs::canonicalize(&absolute)?;
                if !canonical_path.starts_with(&canonical_root) {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "media path leaves notebook",
                    ));
                }
                let Some(kind) = media_kind_for_path(&absolute) else {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "unsupported media resource type",
                    ));
                };
                self.ensure_media_resource(notebook_id, relative_path, kind, &absolute)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let conn = self.open_notebook_db(notebook_id)?;
                let now = now_ms();
                conn.execute(
                    "UPDATE media_resources
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

    /// Preserve identity for a confirmed same-notebook filesystem rename.
    /// Returns false when the old path is unknown or the destination already
    /// has a catalog record; callers can then use ordinary path refresh.
    pub fn move_media_resource_path(
        &self,
        notebook_id: &str,
        old_relative_path: &str,
        new_relative_path: &str,
    ) -> std::io::Result<bool> {
        if old_relative_path == new_relative_path {
            return Ok(false);
        }
        let root = self
            .memo_base_for_notebook_id_result(notebook_id)
            .map_err(std::io::Error::other)?;
        let policy = self.file_management_policy(notebook_id);
        if policy.is_ignored_at(&root, Path::new(old_relative_path))
            || policy.is_ignored_at(&root, Path::new(new_relative_path))
        {
            return Ok(false);
        }
        let new_absolute = super::notebook_path_from_relative(&root, new_relative_path)
            .map_err(std::io::Error::other)?;
        let metadata = fs::symlink_metadata(&new_absolute)?;
        if metadata.file_type().is_symlink() || !metadata.is_file()
            || !fs::canonicalize(&new_absolute)?.starts_with(fs::canonicalize(&root)?)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "renamed media path is not a regular notebook file",
            ));
        }
        let kind = media_kind_for_path(&new_absolute).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "unsupported media resource type")
        })?;
        let size = metadata.len();
        let modified = modified_ms(&new_absolute);
        let fingerprint = stable_fingerprint(&new_absolute, size);
        let mut conn = self.open_notebook_db(notebook_id)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_to_io)?;
        let destination_exists = tx
            .query_row(
                "SELECT 1 FROM media_resources WHERE notebook_id=?1 AND relative_path=?2",
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
                "UPDATE media_resources SET relative_path=?1, kind=?2, size_bytes=?3,
                    modified_ms=?4, fingerprint=?5, missing_since=NULL, deleted_at=NULL,
                    updated_at=?6
                 WHERE notebook_id=?7 AND relative_path=?8",
                params![
                    new_relative_path,
                    kind.as_str(),
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

    /// Rebuild the media catalog from notebook files. The media file remains
    /// on disk, while resource properties are restored from the notebook
    /// database and are not regenerated from sibling files.
    pub fn reconcile_media_resources(&self, notebook_id: &str) -> std::io::Result<usize> {
        let root = self
            .memo_base_for_notebook_id_result(notebook_id)
            .map_err(std::io::Error::other)?;
        // Snapshot the catalog once. Unchanged files need neither another
        // SQLite connection nor a fingerprint read and write on every launch.
        let existing: HashMap<String, (String, u64, u64, bool)> = {
            let conn = self.open_notebook_db(notebook_id)?;
            let mut statement = conn
                .prepare(
                    "SELECT relative_path, kind, size_bytes, modified_ms,
                            fingerprint IS NOT NULL AND missing_since IS NULL AND deleted_at IS NULL
                     FROM media_resources WHERE notebook_id = ?1",
                )
                .map_err(sqlite_to_io)?;
            let rows = statement
                .query_map(params![notebook_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        (
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?.max(0) as u64,
                            row.get::<_, i64>(3)?.max(0) as u64,
                            row.get::<_, bool>(4)?,
                        ),
                    ))
                })
                .map_err(sqlite_to_io)?;
            rows.collect::<Result<_, _>>().map_err(sqlite_to_io)?
        };
        let policy = self.file_management_policy(notebook_id);
        let mut seen = HashSet::new();
        let mut indexed = 0usize;
        for entry in walkdir::WalkDir::new(&root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                entry.path().strip_prefix(&root)
                    .is_ok_and(|relative| relative.as_os_str().is_empty() || !policy.is_ignored_at(&root, relative))
            })
        {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    tracing::debug!(notebook = %notebook_id, error = %error, "skip unreadable media index entry");
                    continue;
                }
            };
            if !entry.file_type().is_file() {
                continue;
            }
            let Some(kind) = media_kind_for_path(entry.path()) else {
                continue;
            };
            let relative = super::notebook_relative_path(&root, entry.path())
                .map_err(std::io::Error::other)?;
            if let Some((old_kind, old_size, old_modified, active)) = existing.get(&relative) {
                let metadata = entry.metadata().map_err(std::io::Error::other)?;
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as u64)
                    .unwrap_or(0);
                if *active
                    && old_kind == kind.as_str()
                    && *old_size == metadata.len()
                    && *old_modified == modified
                {
                    seen.insert(relative);
                    indexed += 1;
                    continue;
                }
            }
            match self.ensure_media_resource(notebook_id, &relative, kind, entry.path()) {
                Ok(_) => {
                    seen.insert(relative);
                    indexed += 1;
                }
                Err(error) => return Err(error),
            }
        }

        let conn = self.open_notebook_db(notebook_id)?;
        let mut statement = conn
            .prepare(
                "SELECT id, relative_path, missing_since, deleted_at
                      FROM media_resources WHERE notebook_id = ?1",
            )
            .map_err(sqlite_to_io)?;
        let stale: Vec<(String, String, Option<i64>, Option<i64>)> = statement
            .query_map(params![notebook_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .map_err(sqlite_to_io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_to_io)?;
        drop(statement);
        let now = now_ms();
        for (id, relative, missing_since, deleted_at) in stale {
            if !seen.contains(&relative) {
                if policy.is_ignored_at(&root, Path::new(&relative)) {
                    continue;
                }
                let first_missing_at = missing_since.unwrap_or(now);
                conn.execute(
                    "UPDATE media_resources
                     SET missing_since = COALESCE(missing_since, ?1),
                         updated_at = CASE WHEN missing_since IS NULL THEN ?1 ELSE updated_at END
                     WHERE notebook_id = ?2 AND id = ?3",
                    params![first_missing_at, notebook_id, id],
                )
                .map_err(sqlite_to_io)?;
                if first_missing_at < now - MEDIA_MISSING_RETENTION_MS
                    || deleted_at.is_some()
                        && deleted_at.unwrap_or(now) < now - MEDIA_MISSING_RETENTION_MS
                {
                    conn.execute(
                        "DELETE FROM media_resources
                         WHERE notebook_id = ?1 AND id = ?2",
                        params![notebook_id, id],
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
        Ok(indexed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(renamed.id, resource.id);
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
                "UPDATE media_resources SET updated_at = 123 WHERE relative_path = 'photo.png'",
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
    fn renamed_media_keeps_its_id_and_database_properties() {
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

        assert_eq!(new_resource.id, old_resource.id);
        assert_eq!(new_resource.properties, properties);
        assert!(!MemoFile::legacy_media_properties_path(&new_media).exists());
        assert!(!MemoFile::legacy_media_properties_path(&old_media).exists());
        assert!(memo_file
            .read_media_resource("nb_media_test", "old.png")
            .unwrap()
            .is_none());
    }
}
