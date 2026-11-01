//! Pinned entries shared by notes, indexed documents, and collections.
//!
//! The three sources live in the same notebook-local database
//! (`<notebook>/.flowix/notebook.db`), so one UNION query can page them by a
//! single creation-time ordering key. Notes carry the flag in their frontmatter
//! projection (`notes.favorited`), documents in `resource_catalog.properties`,
//! and collections in `collection_state.pinned` keyed by identity rather than
//! path, which is why a collection rename keeps its pin.

use std::collections::HashSet;

use rusqlite::{types::Value, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::notebook::sqlite_to_io;
use super::MemoFile;

/// Property key shared with the note frontmatter flag so both surfaces speak
/// one vocabulary (`flowix_favorited` already maps to "置顶" in the table UI).
pub(crate) const PINNED_PROPERTY_KEY: &str = "flowix_favorited";
/// Companion timestamp so a mixed list could later order by pin time instead of
/// creation time without another migration.
pub(crate) const PINNED_AT_PROPERTY_KEY: &str = "flowix_pinned_at";
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedEntry {
    /// `note`, `document`, or `collection`.
    pub entry_kind: String,
    pub relative_path: String,
    /// Indexed title for notes, display name for collections, empty for
    /// documents (the frontend derives the file name from the path).
    pub title: String,
    /// Milliseconds. The single ordering key every source maps onto.
    pub created_at: i64,
    pub modified_ms: i64,
    /// `note`, a `ResourceKind`, or a collection type.
    pub kind: String,
    pub collection_id: Option<String>,
    pub size_bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedEntryPage {
    pub entries: Vec<PinnedEntry>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PinnedCursor {
    created_at: i64,
    entry_kind: String,
    relative_path: String,
}

fn table_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [name],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
}

fn parse_cursor(cursor: Option<&str>) -> std::io::Result<Option<PinnedCursor>> {
    let Some(cursor) = cursor else { return Ok(None) };
    serde_json::from_str::<PinnedCursor>(cursor)
        .map(Some)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error.to_string()))
}

impl MemoFile {
    /// Set or clear the pinned flag of an indexed document.
    ///
    /// Non-media documents have no sidecar able to carry user state, so the
    /// catalog row is the only durable slot. `properties` survives catalog
    /// rebuilds because the upsert never rewrites the column, and it survives
    /// in-app renames because `move_indexed_resource_path` updates the row in
    /// place instead of deleting and re-inserting it.
    pub fn set_indexed_resource_favorite(
        &self,
        notebook_id: &str,
        relative_path: &str,
        favorited: bool,
    ) -> std::io::Result<Option<super::IndexedResource>> {
        let relative_path = super::media_resource::normalize_resource_relative_path(relative_path)?;
        let conn = self.open_notebook_db(notebook_id)?;
        let existing: Option<(String, i64)> = conn
            .query_row(
                "SELECT properties, properties_revision FROM resource_catalog
                 WHERE notebook_id = ?1 AND relative_path = ?2 AND deleted_at IS NULL",
                rusqlite::params![notebook_id, relative_path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(sqlite_to_io)?;
        let Some((properties, revision)) = existing else {
            return Ok(None);
        };
        let mut properties: serde_json::Value =
            serde_json::from_str(&properties).unwrap_or_else(|_| serde_json::json!({}));
        if !properties.is_object() {
            properties = serde_json::json!({});
        }
        let map = properties.as_object_mut().expect("object");
        if favorited {
            map.insert(PINNED_PROPERTY_KEY.to_string(), serde_json::Value::Bool(true));
            map.insert(
                PINNED_AT_PROPERTY_KEY.to_string(),
                serde_json::json!(super::media_resource::now_ms()),
            );
        } else {
            map.remove(PINNED_PROPERTY_KEY);
            map.remove(PINNED_AT_PROPERTY_KEY);
        }
        conn.execute(
            "UPDATE resource_catalog
             SET properties = ?1, properties_revision = ?2, updated_at = ?3
             WHERE notebook_id = ?4 AND relative_path = ?5 AND deleted_at IS NULL",
            rusqlite::params![
                serde_json::to_string(&properties).unwrap_or_else(|_| "{}".to_string()),
                revision + 1,
                super::media_resource::now_ms(),
                notebook_id,
                relative_path,
            ],
        )
        .map_err(sqlite_to_io)?;
        self.read_indexed_resource(notebook_id, &relative_path)
    }

    /// Which of `relative_paths` are pinned documents. One query for a whole
    /// directory listing; the tree must never ask per row.
    pub fn read_pinned_resource_paths(
        &self,
        notebook_id: &str,
        relative_paths: &[String],
    ) -> std::io::Result<HashSet<String>> {
        if relative_paths.is_empty() {
            return Ok(HashSet::new());
        }
        let conn = self.open_notebook_db(notebook_id)?;
        let placeholders = (2..=relative_paths.len() + 1)
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT relative_path FROM resource_catalog
             WHERE notebook_id = ?1 AND deleted_at IS NULL
               AND json_extract(properties, '$.{PINNED_PROPERTY_KEY}') = 1
               AND relative_path IN ({placeholders})"
        );
        let mut values = Vec::with_capacity(relative_paths.len() + 1);
        values.push(Value::Text(notebook_id.to_owned()));
        values.extend(relative_paths.iter().cloned().map(Value::Text));
        let mut statement = conn.prepare(&sql).map_err(sqlite_to_io)?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(values.iter()), |row| {
                row.get::<_, String>(0)
            })
            .map_err(sqlite_to_io)?;
        rows.collect::<Result<HashSet<_>, _>>().map_err(sqlite_to_io)
    }

    /// Page pinned notes, documents, and collections together, newest first.
    ///
    /// Ordering uses the indexed creation timestamp of each source, which for
    /// notes and documents means "first seen by Flowix" rather than the
    /// filesystem birth time. That keeps the mixed list internally consistent:
    /// both sources already rank themselves by this value elsewhere.
    pub fn list_pinned_entries(
        &self,
        notebook_id: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> std::io::Result<PinnedEntryPage> {
        let conn = self.open_notebook_db(notebook_id)?;
        let mut branches: Vec<String> = Vec::new();
        if table_exists(&conn, "notes").map_err(sqlite_to_io)? {
            branches.push(
                "SELECT 'note' AS entry_kind, relative_path AS relative_path, title AS title,
                        CASE WHEN created_at > 0 THEN created_at
                             ELSE COALESCE(CAST(modified_ns / 1000000 AS INTEGER), 0) END AS created_at,
                        updated_at AS modified_ms, 'note' AS kind,
                        NULL AS collection_id, COALESCE(size_bytes, 0) AS size_bytes
                 FROM notes WHERE favorited = 1"
                    .to_string(),
            );
        }
        branches.push(format!(
            "SELECT 'document' AS entry_kind, relative_path AS relative_path, '' AS title,
                    created_at AS created_at, modified_ms AS modified_ms, kind AS kind,
                    NULL AS collection_id, size_bytes AS size_bytes
             FROM resource_catalog
             WHERE notebook_id = ?1 AND deleted_at IS NULL AND missing_since IS NULL
               AND json_extract(properties, '$.{PINNED_PROPERTY_KEY}') = 1"
        ));
        if table_exists(&conn, "collection_documents").map_err(sqlite_to_io)?
            && table_exists(&conn, "collection_state").map_err(sqlite_to_io)?
        {
            branches.push(
                "SELECT 'collection' AS entry_kind, d.relative_path AS relative_path, d.name AS title,
                        COALESCE(CAST(strftime('%s', d.created_at) AS INTEGER) * 1000, d.modified_ms) AS created_at,
                        d.modified_ms AS modified_ms, d.collection_type AS kind,
                        d.collection_id AS collection_id, d.size_bytes AS size_bytes
                 FROM collection_documents d
                 JOIN collection_state s ON s.collection_id = d.collection_id
                 WHERE s.pinned = 1 AND d.parse_state = 'valid' AND d.collection_id IS NOT NULL"
                    .to_string(),
            );
        }

        let mut values = vec![Value::Text(notebook_id.to_owned())];
        let cursor_filter = if let Some(cursor) = parse_cursor(cursor)? {
            values.push(Value::Integer(cursor.created_at));
            values.push(Value::Text(cursor.entry_kind));
            values.push(Value::Text(cursor.relative_path));
            let at = values.len() - 2;
            format!(
                "WHERE created_at < ?{at}
                    OR (created_at = ?{at} AND entry_kind > ?{kind})
                    OR (created_at = ?{at} AND entry_kind = ?{kind} AND relative_path > ?{path})",
                kind = at + 1,
                path = at + 2,
            )
        } else {
            String::new()
        };
        let page_limit = limit.clamp(1, 500).saturating_add(1) as i64;
        values.push(Value::Integer(page_limit));
        let sql = format!(
            "SELECT entry_kind, relative_path, title, created_at, modified_ms, kind, collection_id, size_bytes
             FROM ({union}) {cursor_filter}
             ORDER BY created_at DESC, entry_kind ASC, relative_path ASC
             LIMIT ?{}",
            values.len(),
            union = branches.join(" UNION ALL "),
        );
        let mut statement = conn.prepare(&sql).map_err(sqlite_to_io)?;
        let mut entries = statement
            .query_map(rusqlite::params_from_iter(values.iter()), |row| {
                Ok(PinnedEntry {
                    entry_kind: row.get(0)?,
                    relative_path: row.get(1)?,
                    title: row.get(2)?,
                    created_at: row.get::<_, i64>(3)?.max(0),
                    modified_ms: row.get::<_, i64>(4)?.max(0),
                    kind: row.get(5)?,
                    collection_id: row.get(6)?,
                    size_bytes: row.get::<_, i64>(7)?.max(0),
                })
            })
            .map_err(sqlite_to_io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_to_io)?;
        let has_more = entries.len() > page_limit as usize - 1;
        if has_more {
            entries.pop();
        }
        let next_cursor = has_more
            .then(|| entries.last())
            .flatten()
            .map(|entry| {
                serde_json::to_string(&PinnedCursor {
                    created_at: entry.created_at,
                    entry_kind: entry.entry_kind.clone(),
                    relative_path: entry.relative_path.clone(),
                })
                .unwrap_or_default()
            })
            .filter(|cursor| !cursor.is_empty());
        Ok(PinnedEntryPage {
            entries,
            next_cursor,
            has_more,
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::memo_file::types::NotebookConfig;
    use crate::memo_file::{MemoFile, ResourceKind};
    use std::fs;
    use std::path::PathBuf;

    const NOTEBOOK_ID: &str = "nb_pin_test";

    fn fixture() -> (MemoFile, tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir_all(&root).unwrap();
        let mut memo_file = MemoFile::new(temp.path().join("config"));
        memo_file
            .write_notebook_configs(&[NotebookConfig {
                id: NOTEBOOK_ID.to_string(),
                name: "Pin test".to_string(),
                icon: None,
                path: root.to_string_lossy().to_string(),
                is_default: true,
                sort: 0,
                created_at: 0,
                updated_at: 0,
            }])
            .unwrap();
        memo_file.set_current_notebook(Some(NOTEBOOK_ID.to_string()));
        (memo_file, temp, root)
    }

    #[test]
    fn pinned_document_is_listed_and_follows_an_in_app_rename() {
        let (memo_file, _temp, root) = fixture();
        let document = root.join("spec.html");
        fs::write(&document, "<html></html>").unwrap();
        memo_file
            .ensure_indexed_resource(NOTEBOOK_ID, "spec.html", ResourceKind::Web, &document)
            .unwrap();
        let pinned = memo_file
            .set_indexed_resource_favorite(NOTEBOOK_ID, "spec.html", true)
            .unwrap()
            .expect("catalog row exists");
        assert_eq!(pinned.relative_path, "spec.html");

        let page = memo_file.list_pinned_entries(NOTEBOOK_ID, None, 10).unwrap();
        assert_eq!(page.entries.len(), 1);
        assert_eq!(page.entries[0].entry_kind, "document");
        assert_eq!(page.entries[0].relative_path, "spec.html");
        assert_eq!(page.entries[0].kind, "web");
        assert!(page.entries[0].created_at > 0);

        // An in-app rename updates the catalog row in place, so the flag stays.
        let renamed = root.join("spec-renamed.html");
        memo_file
            .rename_indexed_path(&document, &renamed)
            .unwrap();
        let page = memo_file.list_pinned_entries(NOTEBOOK_ID, None, 10).unwrap();
        assert_eq!(page.entries.len(), 1);
        assert_eq!(page.entries[0].relative_path, "spec-renamed.html");
    }

    #[test]
    fn unpinning_drops_only_the_favorite_keys() {
        let (memo_file, _temp, root) = fixture();
        let document = root.join("report.pdf");
        fs::write(&document, b"%PDF-1.4").unwrap();
        memo_file
            .ensure_indexed_resource(NOTEBOOK_ID, "report.pdf", ResourceKind::Document, &document)
            .unwrap();
        let conn = memo_file.open_notebook_db(NOTEBOOK_ID).unwrap();
        conn.execute(
            "UPDATE resource_catalog SET properties = ?1 WHERE notebook_id = ?2 AND relative_path = ?3",
            rusqlite::params![
                serde_json::json!({ "owner": "design" }).to_string(),
                NOTEBOOK_ID,
                "report.pdf"
            ],
        )
        .unwrap();
        drop(conn);

        memo_file
            .set_indexed_resource_favorite(NOTEBOOK_ID, "report.pdf", true)
            .unwrap()
            .unwrap();
        memo_file
            .set_indexed_resource_favorite(NOTEBOOK_ID, "report.pdf", false)
            .unwrap()
            .unwrap();
        let conn = memo_file.open_notebook_db(NOTEBOOK_ID).unwrap();
        let properties: String = conn
            .query_row(
                "SELECT properties FROM resource_catalog WHERE notebook_id = ?1 AND relative_path = ?2",
                rusqlite::params![NOTEBOOK_ID, "report.pdf"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&properties).unwrap(),
            serde_json::json!({ "owner": "design" })
        );
        assert!(
            memo_file
                .list_pinned_entries(NOTEBOOK_ID, None, 10)
                .unwrap()
                .entries
                .is_empty()
        );
    }

    #[test]
    fn pinned_entries_page_by_creation_time_across_sources() {
        let (memo_file, _temp, root) = fixture();
        for (index, name) in ["a.html", "b.html", "c.html"].iter().enumerate() {
            let path = root.join(name);
            fs::write(&path, b"x").unwrap();
            memo_file
                .ensure_indexed_resource(NOTEBOOK_ID, name, ResourceKind::Web, &path)
                .unwrap();
            memo_file
                .set_indexed_resource_favorite(NOTEBOOK_ID, name, true)
                .unwrap()
                .unwrap();
            // Force a deterministic creation order instead of relying on the clock.
            let conn = memo_file.open_notebook_db(NOTEBOOK_ID).unwrap();
            conn.execute(
                "UPDATE resource_catalog SET created_at = ?1 WHERE notebook_id = ?2 AND relative_path = ?3",
                rusqlite::params![100 + index as i64, NOTEBOOK_ID, name],
            )
            .unwrap();
        }

        let first = memo_file.list_pinned_entries(NOTEBOOK_ID, None, 2).unwrap();
        assert_eq!(first.entries.len(), 2);
        assert!(first.has_more);
        assert_eq!(first.entries[0].relative_path, "c.html");
        assert_eq!(first.entries[1].relative_path, "b.html");

        let second = memo_file
            .list_pinned_entries(NOTEBOOK_ID, first.next_cursor.as_deref(), 2)
            .unwrap();
        assert_eq!(second.entries.len(), 1);
        assert!(!second.has_more);
        assert_eq!(second.entries[0].relative_path, "a.html");
    }
}
