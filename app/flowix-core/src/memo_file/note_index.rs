//! Rebuildable, path-keyed note projection in the existing notebook.db.
//!
//! This index never supplies bytes for a note. Markdown remains the source of
//! content and the projection can be discarded and rebuilt from the notebook.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Connection, ErrorCode, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use super::{
    notebook_path_from_relative, notebook_relative_path, AgentThreadItem, MemoFile,
    NoteColor, TodoItem,
};

// Keep list and single-entry reads on the same projection decoder.
const NOTE_ENTRY_COLUMNS: &str = "relative_path, title, preview, thumbnail, created_at, updated_at, favorited, icon, colors_json, properties_json, size_bytes, tags, todos, agents";

/// Supported predicates applied before pagination; values are always SQL parameters.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct NoteTitleFilter {
    #[serde(rename = "match")]
    pub match_mode: String,
    pub conditions: Vec<NoteTitleCondition>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct NoteTitleCondition {
    pub op: String,
    pub value: String,
}

impl NoteTitleFilter {
    pub fn is_valid(&self) -> bool {
        matches!(self.match_mode.as_str(), "all" | "any")
            && !self.conditions.is_empty()
            && self.conditions.len() <= 8
            && self.conditions.iter().all(|rule| matches!(rule.op.as_str(), "eq" | "contains"))
            && serde_json::to_string(self).is_ok_and(|value| value.len() <= 2048)
    }
}

fn note_entry_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<NoteEntry> {
    fn json<T: serde::de::DeserializeOwned>(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<T> {
        let value: String = row.get(column)?;
        serde_json::from_str(&value).map_err(|error| rusqlite::Error::FromSqlConversionFailure(
            column, rusqlite::types::Type::Text, Box::new(error),
        ))
    }
    Ok(NoteEntry {
        relative_path: row.get(0)?, title: row.get(1)?, preview: row.get(2)?,
        thumbnail: row.get(3)?, created_at: row.get(4)?, updated_at: row.get(5)?,
        favorited: row.get::<_, i64>(6)? != 0, icon: row.get(7)?,
        colors: json(row, 8)?, properties: json(row, 9)?, size_bytes: row.get(10)?,
        tags: json(row, 11)?, todos: json(row, 12)?, agents: json(row, 13)?,
    })
}

const SCHEMA_VERSION: i64 = 4;
// Version 10 stores derived tags, todos, and agents on each notes row.
const PARSER_VERSION: i64 = 11;
const NOTE_SEARCH_FTS_VERSION: i64 = 2;
const NOTE_INDEX_REFRESH_PENDING: &str = "note-index-refresh-pending";
const NOTE_INDEX_REFRESH_PENDING_DIR: &str = "note-index-refresh-pending.d";
static NOTE_INDEX_REFRESH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn mark_note_index_refresh_pending(root: &Path) -> io::Result<()> {
    let pending_dir = root.join(".flowix").join(NOTE_INDEX_REFRESH_PENDING_DIR);
    fs::create_dir_all(&pending_dir)?;
    loop {
        let sequence = NOTE_INDEX_REFRESH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let name = format!(
            "{}-{}-{sequence}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default(),
            std::process::id()
        );
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(pending_dir.join(name))
        {
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
}

fn mark_note_index_refresh_pending_logged(root: &Path, notebook_id: &str, relative_path: &str) {
    if let Err(error) = mark_note_index_refresh_pending(root) {
        tracing::warn!(notebook_id, relative_path, "note index refresh marker failed: {error}");
    }
}

fn pending_note_index_refreshes(root: &Path) -> io::Result<Vec<std::path::PathBuf>> {
    let mut pending = Vec::new();
    let legacy = root.join(".flowix").join(NOTE_INDEX_REFRESH_PENDING);
    if legacy.is_file() {
        pending.push(legacy);
    }
    match fs::read_dir(root.join(".flowix").join(NOTE_INDEX_REFRESH_PENDING_DIR)) {
        Ok(entries) => {
            for entry in entries {
                pending.push(entry?.path());
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    Ok(pending)
}

fn sqlite_busy(error: &io::Error) -> bool {
    matches!(
        error.get_ref().and_then(|source| source.downcast_ref::<rusqlite::Error>()),
        Some(rusqlite::Error::SqliteFailure(code, _))
            if matches!(code.code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

fn display_title_from_relative_path(relative_path: &str) -> String {
    let filename = relative_path.rsplit('/').next().unwrap_or(relative_path);
    let lower = filename.to_ascii_lowercase();
    let extension_len = if lower.ends_with(".markdown") {
        9
    } else if lower.ends_with(".md") {
        3
    } else {
        0
    };
    filename[..filename.len() - extension_len].to_owned()
}

fn is_markdown_note_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown"))
}

/// Rebuildable list record. `relative_path` is its identity within a notebook.
/// No legacy memo ID or legacy table is required to read it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteEntry {
    #[serde(default)]
    pub size_bytes: u64,
    pub relative_path: String,
    pub title: String,
    pub preview: String,
    pub thumbnail: Option<String>,
    pub tags: Vec<String>,
    pub todos: Vec<TodoItem>,
    pub agents: Vec<AgentThreadItem>,
    pub created_at: i64,
    pub updated_at: i64,
    pub favorited: bool,
    pub icon: Option<String>,
    pub colors: Vec<NoteColor>,
    pub properties: serde_json::Value,
}

/// Minimal projection used by file-tree rows. It never reads note bodies.
#[derive(Debug)]
pub struct NoteTreeMetadata {
    pub relative_path: String,
    pub created_at: i64,
    pub favorited: bool,
    pub icon: Option<String>,
    pub colors: Vec<NoteColor>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum NoteWriteOutcome {
    Saved { content: String },
    Conflict { disk_content: String },
}

/// Internal save result; only a successful write can carry an index entry.
pub(crate) enum NoteWriteResult {
    Saved {
        content: String,
        index_entry: Option<NoteEntry>,
    },
    Conflict {
        disk_content: String,
    },
}

fn note_entry_from_derived_fields(
    relative_path: &str,
    size_bytes: u64,
    created_at: i64,
    updated_at: i64,
    fields: super::derivation::DerivedNoteFields<'_>,
) -> NoteEntry {
    let metadata = fields.metadata.unwrap_or_default();
    NoteEntry {
        size_bytes,
        relative_path: relative_path.to_owned(),
        title: display_title_from_relative_path(relative_path),
        preview: fields.preview,
        thumbnail: fields.thumbnail,
        tags: metadata.tags,
        todos: fields.todos,
        agents: fields.agents,
        created_at,
        updated_at,
        favorited: metadata.favorited,
        icon: metadata.icon,
        colors: metadata.colors,
        properties: metadata.properties,
    }
}

#[derive(Clone, Copy)]
enum MaintenanceAdmission {
    Wait,
    SkipIfBusy,
    FailIfBusy,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct NoteIndexReconcileReport {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub unchanged: usize,
}

/// Search result from the rebuildable notebook-local full-text projection.
#[derive(Debug, Clone)]
pub struct NoteSearchHit {
    pub relative_path: String,
    pub title: String,
    pub snippet: String,
    pub matched_in: String,
}

impl MemoFile {
    pub(crate) fn mark_note_index_refresh_pending_for_notebook(&self, notebook_id: &str) -> io::Result<()> {
        let root = self.notebook_root_for_note(notebook_id)?;
        mark_note_index_refresh_pending(&root)
    }

    /// A completed file create remains successful when its rebuildable index lags.
    pub fn refresh_note_path_after_write(&self, notebook_id: &str, relative_path: &str) {
        if let Err(error) = self.refresh_note_path(notebook_id, relative_path) {
            if let Err(marker_error) = self.mark_note_index_refresh_pending_for_notebook(notebook_id) {
                tracing::warn!(notebook_id, relative_path, "note index refresh marker failed: {marker_error}");
            }
            tracing::warn!(notebook_id, relative_path, "note saved but index refresh failed: {error}");
        }
    }

    /// Create a note with no generated memo ID and register it by relative path.
    pub fn create_note_by_path(
        &self,
        notebook_id: &str,
        parent_relative_path: Option<&str>,
        title: &str,
        content: &str,
    ) -> io::Result<String> {
        let root = self.notebook_root_for_note(notebook_id)?;
        let parent_relative = parent_relative_path.unwrap_or("").replace('\\', "/");
        let parent_path = if parent_relative.is_empty() {
            root.clone()
        } else {
            if self
                .file_management_policy(notebook_id)
                .is_tree_hidden_at(&root, Path::new(&parent_relative))
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "invalid note directory",
                ));
            }
            let path =
                notebook_path_from_relative(&root, &parent_relative).map_err(io::Error::other)?;
            let metadata = fs::metadata(&path)?;
            if !metadata.is_dir() || !fs::canonicalize(&path)?.starts_with(fs::canonicalize(&root)?)
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "note directory leaves notebook",
                ));
            }
            path
        };
        let candidate = super::base_filename(title);
        if candidate.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "empty note title",
            ));
        }
        super::frontmatter::extract_document_metadata_tolerant(content)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
        let mut suffix = 0u32;
        let path = loop {
            let filename = if suffix == 0 {
                format!("{candidate}.md")
            } else {
                format!("{candidate}-{suffix}.md")
            };
            let path = parent_path.join(filename);
            match self.create_file_for_notebook(notebook_id, &path, content.as_bytes()) {
                Ok(()) => break path,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    suffix = suffix.saturating_add(1);
                }
                Err(error) => return Err(error),
            }
        };
        let relative = notebook_relative_path(&root, &path).map_err(io::Error::other)?;
        if let Err(error) = self.refresh_note_path(notebook_id, &relative) {
            mark_note_index_refresh_pending_logged(&root, notebook_id, &relative);
            tracing::warn!(notebook_id, relative_path = %relative, "note created but path index refresh failed: {error}");
        }
        Ok(relative)
    }

    /// Save an existing note using only its notebook-relative path.
    pub fn write_note_by_path(
        &self,
        notebook_id: &str,
        relative_path: &str,
        content: &str,
        expected_content: Option<&str>,
    ) -> io::Result<NoteWriteOutcome> {
        self.write_note_by_path_with_result(
            notebook_id,
            relative_path,
            content,
            expected_content,
        )
        .map(|result| match result {
            NoteWriteResult::Saved { content, .. } => NoteWriteOutcome::Saved { content },
            NoteWriteResult::Conflict { disk_content } => {
                NoteWriteOutcome::Conflict { disk_content }
            }
        })
    }

    pub(crate) fn write_note_by_path_with_result(
        &self,
        notebook_id: &str,
        relative_path: &str,
        content: &str,
        expected_content: Option<&str>,
    ) -> io::Result<NoteWriteResult> {
        let root = self.notebook_root_for_note(notebook_id)?;
        let path = self.validate_note_path(&root, relative_path, true)?;
        super::frontmatter::extract_document_metadata_tolerant(content)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
        match self.write_file_if_matches_for_notebook(
            notebook_id,
            &path,
            content,
            expected_content,
        )? {
            super::FileWriteOutcome::Conflict { disk_content } => {
                Ok(NoteWriteResult::Conflict { disk_content })
            }
            super::FileWriteOutcome::Saved => {
                let index_entry = match self.refresh_note_path_with_content(
                    notebook_id,
                    relative_path,
                    content,
                ) {
                    Ok(()) => self
                        .read_indexed_note_entry_by_path(notebook_id, relative_path)
                        .ok()
                        .flatten(),
                    Err(error) => {
                        mark_note_index_refresh_pending_logged(&root, notebook_id, relative_path);
                        tracing::warn!(
                            notebook_id,
                            relative_path,
                            "note saved but path index refresh failed: {error}"
                        );
                        None
                    }
                };
                Ok(NoteWriteResult::Saved {
                    content: content.to_string(),
                    index_entry,
                })
            }
        }
    }

    /// Rename a note without resolving a memo ID. The actual filesystem
    /// rename is no-clobber; Note rows are then moved by refreshing both paths.
    pub fn rename_note_by_path(
        &self,
        notebook_id: &str,
        relative_path: &str,
        new_title: &str,
        expected_content: Option<&str>,
    ) -> io::Result<String> {
        let change_guard = self.operation_locks().notebook_change(&[notebook_id], "rename_note_by_path")?;
        let root = self.notebook_root_for_note(notebook_id)?;
        let old_path = self.validate_note_path(&root, relative_path, true)?;
        if let Some(expected) = expected_content {
            let current = fs::read_to_string(&old_path)?;
            let current = super::normalize_markdown_encoding_boundaries(&current);
            let expected = super::normalize_markdown_encoding_boundaries(expected);
            if current.as_ref() != expected.as_ref() {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "note changed before rename",
                ));
            }
        }
        // Read the existing projection without refreshing: this runs while
        // holding the notebook's exclusive lock, and refreshing would try to
        // re-acquire the notebook shared lock and deadlock against itself.
        let previous_created_at = self
            .read_indexed_note_entry_by_path(notebook_id, relative_path)?
            .map(|entry| entry.created_at)
            .or_else(|| {
                self.derive_note_entry_from_disk(notebook_id, relative_path)
                    .ok()
                    .map(|entry| entry.created_at)
            });
        let parent = Path::new(relative_path).parent().unwrap_or(Path::new(""));
        let parent_relative = parent.to_string_lossy().replace('\\', "/");
        let parent_path = if parent_relative.is_empty() {
            root.clone()
        } else {
            notebook_path_from_relative(&root, &parent_relative).map_err(io::Error::other)?
        };
        let title = super::sanitize_filename_component(new_title);
        if title.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "empty note title",
            ));
        }
        let old_name = old_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if old_name.strip_suffix(".md") == Some(title.as_str()) {
            return Ok(relative_path.replace('\\', "/"));
        }
        let candidate = super::base_filename(&title);
        let mut suffix = 0u32;
        let new_path = loop {
            let filename = if suffix == 0 {
                format!("{candidate}.md")
            } else {
                format!("{candidate}-{suffix}.md")
            };
            let target = parent_path.join(&filename);
            match super::rename_file_noclobber(&old_path, &target) {
                Ok(()) => break target,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    suffix = suffix.saturating_add(1);
                }
                Err(error) => return Err(error),
            }
        };
        let new_relative = notebook_relative_path(&root, &new_path).map_err(io::Error::other)?;
        if let Err(error) = self.move_path_archive(notebook_id, relative_path, &new_relative) {
            tracing::warn!(
                notebook_id,
                relative_path,
                "note renamed but archive move failed: {error}"
            );
        }
        if let Err(error) = self.rekey_note_content_revision(notebook_id, relative_path, &new_relative) {
            tracing::warn!(
                notebook_id,
                relative_path,
                "note renamed but content revision rekey failed: {error}"
            );
        }
        drop(change_guard);
        if let Err(error) = self.refresh_note_path(notebook_id, relative_path) {
            mark_note_index_refresh_pending_logged(&root, notebook_id, relative_path);
            tracing::warn!(
                notebook_id,
                relative_path,
                "note renamed but old path index cleanup failed: {error}"
            );
        }
        if let Err(error) = self.refresh_note_path(notebook_id, &new_relative) {
            mark_note_index_refresh_pending_logged(&root, notebook_id, &new_relative);
            tracing::warn!(notebook_id, relative_path = %new_relative, "note renamed but new path index refresh failed: {error}");
        } else if let Some(created_at) = previous_created_at.filter(|value| *value > 0) {
            let result = self
                .open_note_index_connection(notebook_id)
                .and_then(|conn| {
                    conn.execute(
                        "UPDATE notes SET created_at=?2 WHERE relative_path=?1",
                        params![new_relative, created_at],
                    )
                    .map(|_| ())
                    .map_err(io::Error::other)
                });
            if let Err(error) = result {
                tracing::warn!(notebook_id, relative_path = %new_relative, "note renamed but creation-time projection could not be preserved: {error}");
            }
        }
        Ok(new_relative)
    }

    /// Move a note into an existing directory using only its notebook path.
    /// Markdown is moved first; both Note rows are best-effort projections and
    /// can be repaired by reconciliation if SQLite is unavailable.
    pub fn move_note_by_path(
        &self,
        notebook_id: &str,
        relative_path: &str,
        parent_relative_path: &str,
    ) -> io::Result<String> {
        let change_guard = self.operation_locks().notebook_change(&[notebook_id], "move_note_by_path")?;
        let root = self.notebook_root_for_note(notebook_id)?;
        let old_path = self.validate_note_path(&root, relative_path, true)?;
        let parent_relative = parent_relative_path.replace('\\', "/");
        let parent = if parent_relative.is_empty() {
            root.clone()
        } else {
            let relative = Path::new(&parent_relative);
            if self
                .file_management_policy(notebook_id)
                .is_tree_hidden_at(&root, relative)
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "invalid note destination directory",
                ));
            }
            let path =
                notebook_path_from_relative(&root, &parent_relative).map_err(io::Error::other)?;
            let metadata = fs::metadata(&path)?;
            if !metadata.is_dir() || !fs::canonicalize(&path)?.starts_with(fs::canonicalize(&root)?)
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "note destination leaves notebook",
                ));
            }
            path
        };
        let filename = old_path
            .file_name()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid note filename"))?;
        let new_path = parent.join(filename);
        let new_relative = notebook_relative_path(&root, &new_path).map_err(io::Error::other)?;
        if new_relative == relative_path {
            return Ok(new_relative);
        }

        // Read the existing projection without refreshing: this runs while
        // holding the notebook's exclusive lock, and refreshing would try to
        // re-acquire the notebook shared lock and deadlock against itself.
        let previous_created_at = self
            .read_indexed_note_entry_by_path(notebook_id, relative_path)?
            .map(|entry| entry.created_at)
            .or_else(|| {
                self.derive_note_entry_from_disk(notebook_id, relative_path)
                    .ok()
                    .map(|entry| entry.created_at)
            });
        super::rename_file_noclobber(&old_path, &new_path)?;
        if let Err(error) = self.move_path_archive(notebook_id, relative_path, &new_relative) {
            tracing::warn!(
                notebook_id,
                relative_path,
                "note moved but archive move failed: {error}"
            );
        }
        if let Err(error) = self.rekey_note_content_revision(notebook_id, relative_path, &new_relative) {
            tracing::warn!(
                notebook_id,
                relative_path,
                "note moved but content revision rekey failed: {error}"
            );
        }

        drop(change_guard);

        if let Err(error) = self.refresh_note_path(notebook_id, relative_path) {
            mark_note_index_refresh_pending_logged(&root, notebook_id, relative_path);
            tracing::warn!(
                notebook_id,
                relative_path,
                "note moved but old path index cleanup failed: {error}"
            );
        }
        if let Err(error) = self.refresh_note_path(notebook_id, &new_relative) {
            mark_note_index_refresh_pending_logged(&root, notebook_id, &new_relative);
            tracing::warn!(notebook_id, relative_path = %new_relative, "note moved but new path index refresh failed: {error}");
        } else if let Some(created_at) = previous_created_at.filter(|value| *value > 0) {
            let result = self
                .open_note_index_connection(notebook_id)
                .and_then(|conn| {
                    conn.execute(
                        "UPDATE notes SET created_at=?2 WHERE relative_path=?1",
                        params![new_relative, created_at],
                    )
                    .map(|_| ())
                    .map_err(io::Error::other)
                });
            if let Err(error) = result {
                tracing::warn!(notebook_id, relative_path = %new_relative, "note moved but creation-time projection could not be preserved: {error}");
            }
        }
        Ok(new_relative)
    }

    /// Delete an existing note by path and remove only its rebuildable projection row.
    pub fn delete_note_by_path(&self, notebook_id: &str, relative_path: &str) -> io::Result<bool> {
        self.delete_note_by_path_checked(notebook_id, relative_path, None)
    }

    /// The expected body is compared while holding the target file lock.
    pub fn delete_note_by_path_checked(&self, notebook_id: &str, relative_path: &str, expected_content: Option<&str>) -> io::Result<bool> {
        let root = self.notebook_root_for_note(notebook_id)?;
        let path = self.validate_note_path(&root, relative_path, false)?;
        match self.with_file_write(
            notebook_id,
            &path,
            super::FileLockIntent::ExistingOrMissing,
            "delete_note_by_path",
            |path| {
                if let Some(expected) = expected_content {
                    if fs::read_to_string(path)? != expected {
                        return Err(io::Error::new(io::ErrorKind::WouldBlock, "note changed before delete"));
                    }
                }
                fs::remove_file(path)
            },
        ) {
            Ok(()) => {
                if let Err(error) = self.refresh_note_path(notebook_id, relative_path) {
                    mark_note_index_refresh_pending_logged(&root, notebook_id, relative_path);
                    tracing::warn!(
                        notebook_id,
                        relative_path,
                        "note deleted but path index cleanup failed: {error}"
                    );
                }
                Ok(true)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if let Err(index_error) = self.refresh_note_path(notebook_id, relative_path) {
                    mark_note_index_refresh_pending_logged(&root, notebook_id, relative_path);
                    tracing::warn!(
                        notebook_id,
                        relative_path,
                        "missing note but path index cleanup failed: {index_error}"
                    );
                }
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }

    /// Remove a stale path projection without deleting a file that reappeared.
    pub fn prune_missing_note_by_path(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> io::Result<bool> {
        let _write_guard = self.operation_locks().notebook_read(notebook_id, "prune_missing_note_index")?;
        let root = self.notebook_root_for_note(notebook_id)?;
        let path = self.validate_note_path(&root, relative_path, false)?;
        match fs::symlink_metadata(&path) {
            Ok(_) => return Ok(false),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        self.refresh_note_path(notebook_id, relative_path)?;
        match fs::symlink_metadata(&path) {
            Ok(_) => Ok(false),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
            Err(error) => Err(error),
        }
    }

    fn notebook_root_for_note(&self, notebook_id: &str) -> io::Result<std::path::PathBuf> {
        let root = self
            .get_notebook_config_by_id(notebook_id)
            .map(|config| std::path::PathBuf::from(config.path))
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "notebook not found"))?;
        if !root.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "notebook directory missing",
            ));
        }
        Ok(root)
    }

    fn validate_note_path(
        &self,
        root: &Path,
        relative_path: &str,
        must_exist: bool,
    ) -> io::Result<std::path::PathBuf> {
        let normalized = relative_path.replace('\\', "/");
        let relative = Path::new(&normalized);
        // Only tree-hidden paths are refused. Markdown inside a hidden folder
        // the tree still shows stays writable; the index refresh below keeps it
        // out of note projections.
        if normalized != relative_path
            || super::FileManagementPolicy::from_notebook_root(root)
                .is_tree_hidden_at(root, relative)
            || !is_markdown_note_path(relative)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid notebook note path",
            ));
        }
        let path = notebook_path_from_relative(root, &normalized).map_err(io::Error::other)?;
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "not a regular note file",
                    ));
                }
                if !fs::canonicalize(&path)?.starts_with(fs::canonicalize(root)?) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "note path leaves notebook",
                    ));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound && !must_exist => (),
            Err(error) => return Err(error),
        }
        Ok(path)
    }

    /// Return whether any note carries exactly `tag` in the path projection.
    pub fn note_tag_exists(&self, notebook_id: &str, tag: &str) -> io::Result<bool> {
        let conn = self.open_note_index_connection(notebook_id)?;
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notes n, json_each(n.tags) t WHERE t.value = ?1)",
                [tag],
                |row| row.get(0),
            )
            .map_err(io::Error::other)?;
        Ok(exists)
    }

    /// Return distinct note relative paths carrying `tag` or a subtree tag
    /// (`tag/<...>` at any depth), ordered for deterministic iteration.
    pub fn note_paths_with_tag(
        &self,
        notebook_id: &str,
        tag: &str,
    ) -> io::Result<Vec<String>> {
        let conn = self.open_note_index_connection(notebook_id)?;
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT n.relative_path FROM notes n, json_each(n.tags) t \
                 WHERE t.value = ?1 OR substr(t.value, 1, length(?1)+1) = ?1 || '/' ORDER BY n.relative_path",
            )
            .map_err(io::Error::other)?;
        let rows = stmt
            .query_map(params![tag], |row| row.get(0))
            .map_err(io::Error::other)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(io::Error::other)
    }

    /// Read one note's projection by path. This also repairs a missing or
    /// changed row from Markdown, so a rebuilt index is not required to open
    /// an individual note.
    pub fn read_note_entry_by_path(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> io::Result<Option<NoteEntry>> {
        self.refresh_note_path(notebook_id, relative_path)?;
        self.read_indexed_note_entry_by_path(notebook_id, relative_path)
    }

    /// Observe path presence before a watcher refresh. An absent row only proves
    /// absence after a complete scan; a cold/rebuilding projection is unknown.
    /// Never refresh from disk here: that would erase the before-state needed
    /// to distinguish a new path from an atomic replacement.
    pub fn indexed_note_path_presence(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> io::Result<Option<bool>> {
        let conn = self.open_note_index_connection(notebook_id)?;
        conn.query_row(
            "SELECT CASE WHEN EXISTS(SELECT 1 FROM notes WHERE relative_path=?1) THEN 1 \
             WHEN EXISTS(SELECT 1 FROM note_index_meta WHERE key='build_state' AND value='ready') THEN 0 \
             ELSE NULL END",
            params![relative_path],
            |row| row.get(0),
        ).map_err(io::Error::other)
    }

    /// Query the existing projection without refreshing it from the file.
    /// Table references use index presence as the source of truth.
    pub fn read_indexed_note_entry_by_path(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> io::Result<Option<NoteEntry>> {
        let conn = self.open_note_index_connection(notebook_id)?;
        conn.query_row(
            &format!("SELECT {NOTE_ENTRY_COLUMNS} FROM notes WHERE relative_path=?1"),
            params![relative_path],
            note_entry_from_row,
        ).optional().map_err(io::Error::other)
    }

    /// Derive an entry from the Markdown file when the SQLite projection is
    /// unavailable. This keeps opening and completing a file operation
    /// independent from index health; creation time falls back to filesystem
    /// metadata because `flowix_created_at` is intentionally index-only.
    pub fn derive_note_entry_from_disk(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> io::Result<NoteEntry> {
        let root = self.notebook_root_for_note(notebook_id)?;
        let path = self.validate_note_path(&root, relative_path, true)?;
        let metadata = fs::metadata(&path)?;
        let updated_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| (time.as_millis().min(i64::MAX as u128)) as i64)
            .unwrap_or(0);
        let created_at = metadata
            .created()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| (time.as_millis().min(i64::MAX as u128)) as i64)
            .unwrap_or(updated_at);
        let content = fs::read_to_string(&path)?;
        let fields = super::derivation::derive_note_fields(&content);
        Ok(note_entry_from_derived_fields(
            relative_path,
            metadata.len(),
            created_at,
            updated_at,
            fields,
        ))
    }

    /// Read the path-keyed list without opening any legacy memo table.
    pub fn read_note_entries(&self, notebook_id: &str) -> io::Result<Vec<NoteEntry>> {
        let conn = self.open_note_index_connection(notebook_id)?;
        if !Self::note_index_is_ready_on_connection(&conn)? {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "Note index is not ready",
            ));
        }
        let mut statement = conn.prepare(&format!(
            "SELECT {NOTE_ENTRY_COLUMNS} FROM notes ORDER BY created_at ASC, relative_path ASC"
        )).map_err(io::Error::other)?;
        let entries = statement
            .query_map([], note_entry_from_row)
            .map_err(io::Error::other)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io::Error::other)?;
        Ok(entries)
    }

    /// Read only entries already found by a directory listing. Primary-key
    /// lookups avoid scanning the notebook even when listing its root directory.
    pub fn read_note_tree_metadata_for_paths(
        &self,
        notebook_id: &str,
        relative_paths: &[String],
    ) -> io::Result<Vec<NoteTreeMetadata>> {
        if relative_paths.is_empty() { return Ok(Vec::new()); }
        let conn = self.open_note_index_connection(notebook_id)?;
        if !Self::note_index_is_ready_on_connection(&conn)? {
            return Err(io::Error::new(io::ErrorKind::WouldBlock, "Note index is not ready"));
        }
        let mut entries = Vec::with_capacity(relative_paths.len());
        // Stay below SQLite's variable limit, including older builds (999).
        for paths in relative_paths.chunks(300) {
            let placeholders = vec!["?"; paths.len()].join(",");
            let mut statement = conn.prepare(&format!(
                "SELECT relative_path, created_at, favorited, icon, colors_json \
                 FROM notes WHERE relative_path IN ({placeholders})"
            )).map_err(io::Error::other)?;
            let rows = statement.query_map(rusqlite::params_from_iter(paths), |row| {
                let colors: String = row.get(4)?;
                Ok(NoteTreeMetadata {
                    relative_path: row.get(0)?,
                    created_at: row.get(1)?,
                    favorited: row.get::<_, i64>(2)? != 0,
                    icon: row.get(3)?,
                    colors: serde_json::from_str(&colors).map_err(|error|
                        rusqlite::Error::FromSqlConversionFailure(
                            4, rusqlite::types::Type::Text, Box::new(error),
                        ))?,
                })
            }).map_err(io::Error::other)?;
            entries.extend(rows.collect::<Result<Vec<_>, _>>().map_err(io::Error::other)?);
        }
        Ok(entries)
    }

    /// Search the notebook-local FTS projection. Search content is derived
    /// from Markdown and can be rebuilt without changing the source files.
    pub fn search_notes(
        &self,
        notebook_id: &str,
        query: &str,
        limit: usize,
    ) -> io::Result<Vec<NoteSearchHit>> {
        self.search_notes_with_tag_filter(notebook_id, query, None, limit)
    }

    pub fn search_notes_with_tag_filter(
        &self,
        notebook_id: &str,
        query: &str,
        tag_filter: Option<&str>,
        limit: usize,
    ) -> io::Result<Vec<NoteSearchHit>> {
        let query = query.trim().to_lowercase();
        if query.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let tag_filter = tag_filter.map(str::trim).filter(|tag| !tag.is_empty());
        let conn = self.ensure_note_search_index(notebook_id)?;
        let root = self.notebook_root_for_note(notebook_id)?;
        if !pending_note_index_refreshes(&root)?.is_empty() {
            self.verify_note_index(notebook_id)?;
        }
        let short_query = query.chars().count() < 3;
        let (sql, query_pattern) = if short_query {
            let escaped = query
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            let pattern = format!("%{escaped}%");
            (
                "SELECT relative_path, title, body, tags,
                        CASE WHEN instr(lower(title), ?2) > 0 THEN 'title'
                             WHEN instr(lower(tags), ?2) > 0 THEN 'tag'
                             ELSE 'body' END AS matched_in
                 FROM note_search_fts
                 WHERE (lower(title) LIKE ?1 ESCAPE '\\'
                    OR lower(body) LIKE ?1 ESCAPE '\\'
                    OR lower(tags) LIKE ?1 ESCAPE '\\')
                   AND (?4 IS NULL OR EXISTS (
                       SELECT 1 FROM notes n, json_each(n.tags) t
                       WHERE n.relative_path=note_search_fts.relative_path
                         AND (t.value=?4 OR substr(t.value, 1, length(?4)+1)=?4 || '/')
                   ))
                 ORDER BY updated_at DESC, relative_path ASC LIMIT ?3",
                pattern,
            )
        } else {
            let quoted = format!("\"{}\"", query.replace('"', "\"\""));
            (
                "SELECT relative_path, title, body, tags,
                        CASE WHEN instr(lower(title), ?2) > 0 THEN 'title'
                             WHEN instr(lower(tags), ?2) > 0 THEN 'tag'
                             ELSE 'body' END AS matched_in
                 FROM note_search_fts
                 WHERE note_search_fts MATCH ?1
                   AND (?4 IS NULL OR EXISTS (
                       SELECT 1 FROM notes n, json_each(n.tags) t
                       WHERE n.relative_path=note_search_fts.relative_path
                         AND (t.value=?4 OR substr(t.value, 1, length(?4)+1)=?4 || '/')
                   ))
                 ORDER BY updated_at DESC, relative_path ASC LIMIT ?3",
                quoted,
            )
        };
        let mut statement = conn.prepare(sql).map_err(io::Error::other)?;
        let rows = statement
            .query_map(
                params![query_pattern, query, limit as i64, tag_filter],
                |row| {
                    let relative_path: String = row.get(0)?;
                    let title: String = row.get(1)?;
                    let body: String = row.get(2)?;
                    let matched_in: String = row.get(4)?;
                    let snippet = body
                        .chars()
                        .take(130)
                        .collect::<String>()
                        .replace(['\r', '\n'], " ");
                    Ok(NoteSearchHit {
                        relative_path,
                        title,
                        snippet,
                        matched_in,
                    })
                },
            )
            .map_err(io::Error::other)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(io::Error::other)
    }

    fn ensure_note_search_index(&self, notebook_id: &str) -> io::Result<Connection> {
        let root = self
            .get_notebook_config_by_id(notebook_id)
            .map(|config| std::path::PathBuf::from(config.path))
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "notebook not found"))?;
        let mut conn = self.open_note_index_connection(notebook_id)?;
        let version: Option<i64> = conn
            .query_row(
                "SELECT value FROM note_index_meta WHERE key='note_search_fts_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(io::Error::other)?
            .and_then(|value| value.parse().ok());
        if version == Some(NOTE_SEARCH_FTS_VERSION) {
            return Ok(conn);
        }

        // Read files outside SQLite write transactions. Each row is checked
        // against its current hash before a short, atomic FTS update.
        let notes: Vec<String> = conn
            .prepare("SELECT relative_path FROM notes ORDER BY relative_path")
            .map_err(io::Error::other)?
            .query_map([], |row| row.get(0))
            .map_err(io::Error::other)?
            .collect::<Result<_, _>>()
            .map_err(io::Error::other)?;
        for relative_path in notes {
            let path =
                notebook_path_from_relative(&root, &relative_path).map_err(io::Error::other)?;
            let bytes = match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    self.refresh_note_path(notebook_id, &relative_path)?;
                    continue;
                }
                Err(error) => return Err(error),
            };
            let hash = format!("{:x}", Sha256::digest(&bytes));
            let content = String::from_utf8(bytes)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(io::Error::other)?;
            let current: Option<(String, String, i64)> = tx
                .query_row(
                    "SELECT content_hash, title, updated_at FROM notes WHERE relative_path=?1",
                    params![relative_path],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(io::Error::other)?;
            let Some((current_hash, title, updated_at)) = current else {
                tx.commit().map_err(io::Error::other)?;
                continue;
            };
            if current_hash != hash {
                tx.commit().map_err(io::Error::other)?;
                self.refresh_note_path(notebook_id, &relative_path)?;
                continue;
            }
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM note_search_fts WHERE relative_path=?1)",
                    params![relative_path],
                    |row| row.get(0),
                )
                .map_err(io::Error::other)?;
            if exists {
                tx.commit().map_err(io::Error::other)?;
                continue;
            }
            let tags: String = tx.query_row(
                "SELECT COALESCE(group_concat(value, ' '), '') FROM notes n, json_each(n.tags) WHERE n.relative_path=?1",
                params![relative_path], |row| row.get(0),
            ).map_err(io::Error::other)?;
            tx.execute(
                "INSERT INTO note_search_fts(relative_path, title, body, tags, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    relative_path,
                    title,
                    super::extract_body_content(&content),
                    tags,
                    updated_at
                ],
            )
            .map_err(io::Error::other)?;
            tx.commit().map_err(io::Error::other)?;
        }
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(io::Error::other)?;
        tx.execute("DELETE FROM note_search_fts WHERE relative_path NOT IN (SELECT relative_path FROM notes)", []).map_err(io::Error::other)?;
        tx.execute(
            "INSERT INTO note_index_meta (key, value) VALUES ('note_search_fts_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![NOTE_SEARCH_FTS_VERSION.to_string()],
        )
        .map_err(io::Error::other)?;
        tx.commit().map_err(io::Error::other)?;
        Ok(conn)
    }

    /// Fetch one sorted page directly from the projection. Markdown is
    /// still authoritative; only the bounded result rows are hydrated.
    pub fn read_note_page(
        &self,
        notebook_id: &str,
        filter: &str,
        tag_id: Option<&str>,
        color: Option<&str>,
        sort: &str,
        now: i64,
        week_start: i64,
        month_start: i64,
        cursor: Option<(bool, i64, Option<&str>, Option<&str>, &str)>,
        limit: usize,
    ) -> io::Result<Vec<NoteEntry>> {
        self.read_note_page_with_title_filter(notebook_id, filter, tag_id, color, sort,
            now, week_start, month_start, cursor, limit, None)
    }

    pub fn read_note_page_with_title_filter(
        &self,
        notebook_id: &str,
        filter: &str,
        tag_id: Option<&str>,
        color: Option<&str>,
        sort: &str,
        now: i64,
        week_start: i64,
        month_start: i64,
        cursor: Option<(bool, i64, Option<&str>, Option<&str>, &str)>,
        limit: usize,
        title_filter: Option<&NoteTitleFilter>,
    ) -> io::Result<Vec<NoteEntry>> {
        if title_filter.is_some_and(|filter| !filter.is_valid()) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid note title filter"));
        }
        let conn = self.open_note_index_connection(notebook_id)?;
        if !Self::note_index_is_ready_on_connection(&conn)? {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "Note index is not ready",
            ));
        }
        let date_column = if sort == "updatedAt" {
            "updated_at"
        } else {
            "created_at"
        };
        let mut sql = format!("SELECT {NOTE_ENTRY_COLUMNS} FROM notes n WHERE 1=1");
        let mut args: Vec<SqlValue> = Vec::new();
        match filter {
            "todos" => sql.push_str(" AND json_array_length(n.todos)>0"),
            "agents" => sql.push_str(" AND json_array_length(n.agents)>0"),
            "favorited" => sql.push_str(" AND n.favorited=1"),
            "tagged" => {
                if let Some(tag) = tag_id {
                    sql.push_str(" AND EXISTS (SELECT 1 FROM json_each(n.tags) t WHERE t.value=? OR substr(t.value,1,length(?)+1)=?)");
                    args.push(tag.to_owned().into());
                    args.push(tag.to_owned().into());
                    args.push(format!("{tag}/").into());
                } else {
                    sql.push_str(" AND json_array_length(n.tags)>0");
                }
            }
            "thisWeek" | "thisMonth" => {
                sql.push_str(" AND n.created_at>=? AND n.created_at<=?");
                args.push(
                    (if filter == "thisWeek" {
                        week_start
                    } else {
                        month_start
                    })
                    .into(),
                );
                args.push(now.into());
            }
            _ => {}
        }
        match color {
            Some("any") => sql.push_str(" AND json_array_length(n.colors_json)>0"),
            Some("none") => sql.push_str(" AND json_array_length(n.colors_json)=0"),
            Some(value) => {
                sql.push_str(
                    " AND EXISTS (SELECT 1 FROM json_each(n.colors_json) c WHERE c.value=?)",
                );
                args.push(value.to_owned().into());
            }
            None => {}
        }
        if let Some(title_filter) = title_filter {
            let join = if title_filter.match_mode == "all" { " AND " } else { " OR " };
            let predicates: Vec<&str> = title_filter.conditions.iter().map(|rule| {
                args.push(rule.value.clone().into());
                if rule.op == "eq" { "n.title = ? COLLATE BINARY" } else { "instr(n.title, ?) > 0" }
            }).collect();
            sql.push_str(&format!(" AND ({})", predicates.join(join)));
        }
        let filename_sort = matches!(sort, "filenameAsc" | "filenameDesc");
        if let Some((favorited, value, lower, filename, path)) = cursor {
            if filename_sort {
                let comparison = if sort == "filenameDesc" { "<" } else { ">" };
                sql.push_str(&format!(" AND (n.favorited<? OR (n.favorited=? AND (n.filename_lower,n.filename,n.relative_path) {comparison} (?,?,?)))"));
                args.extend([
                    SqlValue::Integer(i64::from(favorited)),
                    SqlValue::Integer(i64::from(favorited)),
                    lower.unwrap_or_default().to_owned().into(),
                    filename.unwrap_or_default().to_owned().into(),
                    path.to_owned().into(),
                ]);
            } else {
                sql.push_str(&format!(" AND (n.favorited<? OR (n.favorited=? AND (n.{date_column}<? OR (n.{date_column}=? AND n.relative_path<?))))"));
                args.extend([
                    SqlValue::Integer(i64::from(favorited)),
                    SqlValue::Integer(i64::from(favorited)),
                    value.into(),
                    value.into(),
                    path.to_owned().into(),
                ]);
            }
        }
        if filename_sort {
            let direction = if sort == "filenameDesc" {
                "DESC"
            } else {
                "ASC"
            };
            sql.push_str(&format!(" ORDER BY n.favorited DESC, n.filename_lower {direction}, n.filename {direction}, n.relative_path {direction} LIMIT ?"));
        } else {
            sql.push_str(&format!(
                " ORDER BY n.favorited DESC, n.{date_column} DESC, n.relative_path DESC LIMIT ?"
            ));
        }
        args.push((limit as i64).into());
        let mut statement = conn.prepare(&sql).map_err(io::Error::other)?;
        let entries = statement
            .query_map(rusqlite::params_from_iter(args), note_entry_from_row)
            .map_err(io::Error::other)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io::Error::other)?;
        Ok(entries)
    }

    pub(crate) fn note_index_is_ready(&self, notebook_id: &str) -> io::Result<bool> {
        let conn = self.open_note_index_connection(notebook_id)?;
        Self::note_index_is_ready_on_connection(&conn)
    }

    fn note_index_is_ready_on_connection(conn: &Connection) -> io::Result<bool> {
        let mut stmt = conn.prepare(
            "SELECT key, value FROM note_index_meta WHERE key IN ('build_state', 'parser_version')"
        ).map_err(io::Error::other)?;
        let values = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(io::Error::other)?
            .collect::<Result<HashMap<_, _>, _>>()
            .map_err(io::Error::other)?;
        Ok(values
            .get("build_state")
            .is_some_and(|value| value == "ready")
            && values
                .get("parser_version")
                .is_some_and(|value| value == &PARSER_VERSION.to_string()))
    }

    /// Read a completed projection without creating directories, tables or scans.
    /// Absence, an unfinished build, and an obsolete parser return unknown.
    pub fn cached_note_count(&self, notebook_id: &str) -> io::Result<Option<usize>> {
        let notebook = self.get_notebook_config_by_id(notebook_id)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "notebook not found"))?;
        let path = Path::new(&notebook.path).join(".flowix/notebook.db");
        if !path.is_file() { return Ok(None); }
        let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(io::Error::other)?;
        conn.busy_timeout(Duration::from_millis(50)).map_err(io::Error::other)?;
        let has_projection: bool = conn.query_row(
            "SELECT COUNT(*)=2 FROM sqlite_master WHERE type='table' AND name IN ('note_index_meta', 'notes')",
            [], |row| row.get(0),
        ).map_err(io::Error::other)?;
        if !has_projection { return Ok(None); }
        let ready: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM note_index_meta WHERE key='build_state' AND value='ready')
             AND EXISTS(SELECT 1 FROM note_index_meta WHERE key='parser_version' AND value=?1)",
            [PARSER_VERSION.to_string()], |row| row.get(0),
        ).map_err(io::Error::other)?;
        if !ready { return Ok(None); }
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .map_err(io::Error::other)?;
        Ok(Some(usize::try_from(count).unwrap_or(0)))
    }

    pub(crate) fn note_count(&self, notebook_id: &str) -> io::Result<usize> {
        let conn = self.open_note_index_connection(notebook_id)?;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .map_err(io::Error::other)?;
        Ok(usize::try_from(count).unwrap_or(0))
    }

    pub(crate) fn note_occupied_filenames(
        &self,
        notebook_id: &str,
        parent: Option<&str>,
    ) -> io::Result<Vec<String>> {
        let conn = self.open_note_index_connection(notebook_id)?;
        let parent = parent.unwrap_or("");
        let mut stmt = conn
            .prepare(
                "SELECT relative_path FROM notes WHERE \
             (?1 = '' AND instr(relative_path, '/') = 0) OR \
             (?1 <> '' AND substr(relative_path, 1, length(?1) + 1) = ?1 || '/' \
              AND instr(substr(relative_path, length(?1) + 2), '/') = 0)",
            )
            .map_err(io::Error::other)?;
        let rows = stmt
            .query_map(params![parent], |row| row.get::<_, String>(0))
            .map_err(io::Error::other)?;
        rows.map(|row| row.map_err(io::Error::other))
            .filter_map(|row| match row {
                Ok(path) => {
                    let (directory, filename) = path.rsplit_once('/').unwrap_or(("", &path));
                    (directory == parent).then(|| Ok(filename.to_owned()))
                }
                Err(error) => Some(Err(error)),
            })
            .collect()
    }

    pub(crate) fn note_tag_usage_summary(
        &self,
        notebook_id: &str,
    ) -> io::Result<(Vec<String>, Vec<(String, usize)>, usize, usize, usize)> {
        let conn = self.open_note_index_connection(notebook_id)?;
        let count = |sql| -> io::Result<usize> {
            let value: i64 = conn
                .query_row(sql, [], |row| row.get(0))
                .map_err(io::Error::other)?;
            Ok(usize::try_from(value).unwrap_or(0))
        };
        let total = count("SELECT COUNT(*) FROM notes")?;
        let agents = count("SELECT COUNT(*) FROM notes WHERE json_array_length(agents)>0")?;
        let todos = count("SELECT COUNT(*) FROM notes WHERE json_array_length(todos)>0")?;
        let mut stmt = conn
            .prepare(
                "SELECT t.value, COUNT(DISTINCT n.relative_path) FROM notes n, json_each(n.tags) t GROUP BY t.value ORDER BY t.value COLLATE NOCASE ASC",
            )
            .map_err(io::Error::other)?;
        let tags = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(io::Error::other)?
            .map(|row| {
                row.map(|(tag, count)| (tag, usize::try_from(count).unwrap_or(0)))
                    .map_err(io::Error::other)
            })
            .collect::<io::Result<Vec<_>>>()?;
        let ids = tags.iter().map(|(tag, _)| tag.clone()).collect();
        Ok((ids, tags, total, agents, todos))
    }

    pub(crate) fn note_tag_path_pairs(
        &self,
        notebook_id: &str,
    ) -> io::Result<Vec<(String, String)>> {
        let conn = self.open_note_index_connection(notebook_id)?;
        let mut stmt = conn
            .prepare("SELECT t.value, n.relative_path FROM notes n, json_each(n.tags) t")
            .map_err(io::Error::other)?;
        let pairs = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(io::Error::other)?
            .map(|row| row.map_err(io::Error::other))
            .collect();
        pairs
    }

    /// Drop the obsolete Memo-ID projection after rebuilding the path index from Markdown.
    /// Derived tags, todos, agents, colors, and properties come from the source files.
    pub fn retire_legacy_memo_index(&self, notebook_id: &str) -> io::Result<()> {
        self.initialize_note_index_schema(notebook_id)?;
        let conn = self.open_note_index_connection(notebook_id)?;
        let retired: Option<String> = conn
            .query_row(
                "SELECT value FROM note_index_meta WHERE key='legacy_memo_index_retired'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(io::Error::other)?;
        if retired.as_deref() == Some("1") {
            return Ok(());
        }
        conn.execute_batch(
            "BEGIN IMMEDIATE;
             DELETE FROM notes;
             DELETE FROM note_index_meta WHERE key='parser_version';
             COMMIT;",
        )
        .map_err(io::Error::other)?;
        drop(conn);
        self.reconcile_note_index_blocking(notebook_id)?;
        let conn = self.open_note_index_connection(notebook_id)?;
        conn.execute_batch(
            "BEGIN IMMEDIATE;
             DROP TABLE IF EXISTS memo_content_revisions;
             DROP TABLE IF EXISTS memo_agents;
             DROP TABLE IF EXISTS memo_colors;
             DROP TRIGGER IF EXISTS trg_memo_tags_register_notebook_tag;
             DROP TABLE IF EXISTS memo_tags;
             DROP TABLE IF EXISTS memo_todos;
             DROP TABLE IF EXISTS pending_external_memo_creates;
             DROP TABLE IF EXISTS notebook_tags;
             DROP TABLE IF EXISTS memos;
             DROP TABLE IF EXISTS memo_lifecycles;
             DROP TABLE IF EXISTS memo_index_state;
             DROP TABLE IF EXISTS notebook_data_migrations;
             DROP TABLE IF EXISTS schema_migrations;
             INSERT INTO note_index_meta (key, value)
               VALUES ('legacy_memo_index_retired', '1')
               ON CONFLICT(key) DO UPDATE SET value='1';
             COMMIT;",
        )
        .map_err(io::Error::other)?;
        Ok(())
    }

    /// Reconcile one notebook's Note projection with files on disk. Existing
    /// rows are checked by stat first and hashed only when their stat changes.
    /// This method intentionally does not touch the legacy memo tables.
    ///
    /// This passive/lazy path skips instead of blocking when another process is
    /// already reconciling the same notebook, so a background refresh never
    /// turns into a spurious 5s timeout error. The next read pass retries.
    pub fn reconcile_note_index(&self, notebook_id: &str) -> io::Result<NoteIndexReconcileReport> {
        self.reconcile_note_index_inner(notebook_id, false, MaintenanceAdmission::SkipIfBusy, &|| true)
    }

    /// Hash every file, including entries whose size and mtime are unchanged.
    /// Use this for an occasional audit or after a suspected missed watcher event.
    ///
    /// Unlike [`Self::reconcile_note_index`], this explicit audit waits for the
    /// maintenance lock rather than skipping, so the caller can rely on a full
    /// pass having completed.
    pub fn verify_note_index(&self, notebook_id: &str) -> io::Result<NoteIndexReconcileReport> {
        self.reconcile_note_index_inner(notebook_id, true, MaintenanceAdmission::Wait, &|| true)
    }

    /// Blocking reconcile used by short-lived CLI/MCP processes that need an
    /// accurate result: it stats each file and hashes only those whose size or
    /// mtime changed, so a fresh index is cheap while a file changed after the
    /// last scan (for example a crash between body commit and refresh marker)
    /// is still picked up. Unlike [`Self::reconcile_note_index`], it waits for
    /// the maintenance lock instead of skipping a concurrent pass.
    pub fn reconcile_note_index_blocking(
        &self,
        notebook_id: &str,
    ) -> io::Result<NoteIndexReconcileReport> {
        self.reconcile_note_index_inner(notebook_id, false, MaintenanceAdmission::Wait, &|| true)
    }

    /// Enumerate Markdown note paths directly from the notebook tree without
    /// consulting SQLite. Mutating operations such as clear-notebook use this
    /// inventory so a missing index cannot hide files from the operation.
    pub fn list_note_paths_from_disk(&self, notebook_id: &str) -> io::Result<Vec<String>> {
        let root = self.notebook_root_for_note(notebook_id)?;
        let policy = self.file_management_policy(notebook_id);
        let mut paths = Vec::new();
        for item in WalkDir::new(&root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                entry.path() == root
                    || entry
                        .path()
                        .strip_prefix(&root)
                        .map(|relative| !policy.is_index_hidden_at(&root, relative))
                        .unwrap_or(false)
            })
        {
            let item = item.map_err(io::Error::other)?;
            if item.file_type().is_file() && is_markdown_note_path(item.path()) {
                paths.push(notebook_relative_path(&root, item.path()).map_err(io::Error::other)?);
            }
        }
        paths.sort();
        Ok(paths)
    }

    /// Refresh one path after a local write or watcher event. A missing file
    /// removes its projection; all other notebook files stay untouched.
    pub fn refresh_note_path(&self, notebook_id: &str, relative_path: &str) -> io::Result<()> {
        self.refresh_note_path_with_snapshot(notebook_id, relative_path, None)
    }

    /// Refresh one path from content already read or written by the caller.
    /// Markdown stays authoritative; the snapshot avoids reading the same body
    /// from disk again during this refresh.
    pub fn refresh_note_path_with_content(
        &self,
        notebook_id: &str,
        relative_path: &str,
        content: &str,
    ) -> io::Result<()> {
        self.refresh_note_path_with_snapshot(notebook_id, relative_path, Some(content))
    }

    fn refresh_note_path_with_snapshot(
        &self,
        notebook_id: &str,
        relative_path: &str,
        content_snapshot: Option<&str>,
    ) -> io::Result<()> {
        let relative = Path::new(relative_path);
        let root = self
            .get_notebook_config_by_id(notebook_id)
            .map(|config| std::path::PathBuf::from(config.path))
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "notebook not found"))?;
        let policy = self.file_management_policy(notebook_id);
        if policy.is_index_hidden_at(&root, relative) || !is_markdown_note_path(relative) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "not a notebook note path",
            ));
        }
        let path = notebook_path_from_relative(&root, relative_path).map_err(io::Error::other)?;
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "not a regular note file",
                ));
            }
            let canonical_root = fs::canonicalize(&root)?;
            let canonical_path = fs::canonicalize(&path)?;
            if !canonical_path.starts_with(&canonical_root) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "note path leaves notebook",
                ));
            }
        }
        let mut conn = self.open_note_index_connection(notebook_id)?;
        let mut report = NoteIndexReconcileReport::default();
        self.refresh_note_index_path_with_retry(
            notebook_id,
            &mut conn,
            &root,
            &path,
            true,
            false,
            content_snapshot,
            &mut report,
        )
    }

    /// Upgrade only the rebuildable projection in place. Never replace the
    /// shared notebook database, which also owns media properties/revisions.
    pub fn prepare_background_note_projection(&self, notebook_id: &str) -> io::Result<()> {
        let Some(_guard) = self.operation_locks().try_notebook_maintenance(notebook_id, "prepare_note_projection")? else {
            return Err(io::Error::new(io::ErrorKind::WouldBlock, "notebook maintenance is busy"));
        };
        self.open_note_index_connection_unchecked(notebook_id, true)?;
        Ok(())
    }

    /// Cooperative desktop maintenance. Locks and transactions remain per file;
    /// cancellation leaves an incomplete cold index explicitly unavailable.
    pub fn reconcile_note_index_background(
        &self, notebook_id: &str, keep_running: &dyn Fn() -> bool,
    ) -> io::Result<NoteIndexReconcileReport> {
        self.reconcile_note_index_inner(notebook_id, false, MaintenanceAdmission::FailIfBusy, keep_running)
    }

    fn reconcile_note_index_inner(
        &self,
        notebook_id: &str,
        verify_hashes: bool,
        admission: MaintenanceAdmission,
        keep_running: &dyn Fn() -> bool,
    ) -> io::Result<NoteIndexReconcileReport> {
        let _maintenance_guard = if !matches!(admission, MaintenanceAdmission::Wait) {
            let Some(guard) = self
                .operation_locks()
                .try_notebook_maintenance(notebook_id, "reconcile_note_index")?
            else {
                tracing::debug!(
                    notebook_id,
                    "note index reconcile skipped: another maintenance pass is in progress"
                );
                if matches!(admission, MaintenanceAdmission::FailIfBusy) {
                    return Err(io::Error::new(io::ErrorKind::WouldBlock, "notebook maintenance is busy"));
                }
                return Ok(NoteIndexReconcileReport::default());
            };
            guard
        } else {
            self.operation_locks()
                .notebook_maintenance(notebook_id, "reconcile_note_index")?
        };
        let root = self
            .get_notebook_config_by_id(notebook_id)
            .map(|config| std::path::PathBuf::from(config.path))
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "notebook not found"))?;
        if !root.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "notebook directory missing",
            ));
        }
        let pending_at_start = pending_note_index_refreshes(&root)?;
        let mut conn = self.open_note_index_connection(notebook_id)?;
        let parser_version: Option<i64> = conn
            .query_row(
                "SELECT value FROM note_index_meta WHERE key='parser_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(io::Error::other)?
            .and_then(|value| value.parse().ok());
        let reparse_all = parser_version != Some(PARSER_VERSION);
        // A warm refresh must not make existing lists unavailable while scanning.
        if reparse_all || !self.note_index_is_ready(notebook_id)? {
            conn.execute(
                "INSERT INTO note_index_meta (key, value) VALUES ('build_state', 'building') \
                 ON CONFLICT(key) DO UPDATE SET value='building'", [],
            ).map_err(io::Error::other)?;
        }
        let mut seen = HashSet::new();
        let mut report = NoteIndexReconcileReport::default();
        let policy = self.file_management_policy(notebook_id);
        for entry in WalkDir::new(&root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                entry.path() == root
                    || entry
                        .path()
                        .strip_prefix(&root)
                        .map(|relative| {
                            !policy.is_index_hidden_at(&root, relative)
                        })
                        .unwrap_or(false)
            })
        {
            if !keep_running() {
                return Err(io::Error::new(io::ErrorKind::Interrupted, "index maintenance cancelled"));
            }
            let entry = entry.map_err(io::Error::other)?;
            if !entry.file_type().is_file() || !is_markdown_note_path(entry.path()) {
                continue;
            }
            let relative = notebook_relative_path(&root, entry.path()).map_err(io::Error::other)?;
            seen.insert(relative.clone());
            self.refresh_note_index_path_with_retry(
                notebook_id,
                &mut conn,
                &root,
                entry.path(),
                verify_hashes,
                reparse_all,
                None,
                &mut report,
            )?;
        }
        let mut stmt = conn
            .prepare("SELECT relative_path FROM notes")
            .map_err(io::Error::other)?;
        let indexed = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(io::Error::other)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io::Error::other)?;
        drop(stmt);
        for relative in indexed {
            if !keep_running() {
                return Err(io::Error::new(io::ErrorKind::Interrupted, "index maintenance cancelled"));
            }
            if !seen.contains(&relative) {
                let candidate = notebook_path_from_relative(&root, &relative).map_err(io::Error::other)?;
                // The scan only nominates stale rows. A file may have appeared
                // after its directory was visited, so inspect it again under
                // the notebook lock and SQLite transaction.
                self.refresh_note_index_path_with_retry(
                    notebook_id, &mut conn, &root, &candidate, true, false, None, &mut report,
                )?;
            }
        }
        conn.execute(
            "INSERT INTO note_index_meta (key, value) VALUES ('last_complete_scan_at', ?1) \
                      ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![chrono::Utc::now().timestamp_millis().to_string()],
        )
        .map_err(io::Error::other)?;
        conn.execute(
            "INSERT INTO note_index_meta (key, value) VALUES ('parser_version', ?1) \
                      ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![PARSER_VERSION.to_string()],
        )
        .map_err(io::Error::other)?;
        conn.execute(
            "UPDATE note_index_meta SET value='ready' WHERE key='build_state'",
            [],
        )
        .map_err(io::Error::other)?;
        for pending in pending_at_start {
            match fs::remove_file(pending) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(report)
    }

    fn refresh_note_index_path_with_retry(
        &self,
        notebook_id: &str,
        conn: &mut Connection,
        root: &Path,
        path: &Path,
        verify_hashes: bool,
        reparse_all: bool,
        content_snapshot: Option<&str>,
        report: &mut NoteIndexReconcileReport,
    ) -> io::Result<()> {
        conn.busy_timeout(Duration::ZERO).map_err(io::Error::other)?;
        let started = Instant::now();
        loop {
            let guard = self.operation_locks().notebook_read(notebook_id, "refresh_note_index_path")?;
            let mut attempt = NoteIndexReconcileReport::default();
            let result = Self::refresh_note_index_path(
                conn,
                root,
                path,
                verify_hashes,
                reparse_all,
                content_snapshot,
                &mut attempt,
            );
            drop(guard);
            match result {
                Ok(()) => {
                    report.added += attempt.added;
                    report.updated += attempt.updated;
                    report.removed += attempt.removed;
                    report.unchanged += attempt.unchanged;
                    return Ok(());
                }
                Err(error) if sqlite_busy(&error) && started.elapsed() < Duration::from_secs(5) => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn refresh_note_index_path(
        conn: &mut Connection,
        root: &Path,
        path: &Path,
        verify_hashes: bool,
        reparse_all: bool,
        content_snapshot: Option<&str>,
        report: &mut NoteIndexReconcileReport,
    ) -> io::Result<()> {
        let relative = notebook_relative_path(root, path).map_err(io::Error::other)?;
        let policy = super::FileManagementPolicy::from_notebook_root(root);
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(io::Error::other)?;
        let missing = match fs::symlink_metadata(path) {
            Ok(_) => false,
            Err(error) if error.kind() == io::ErrorKind::NotFound => true,
            Err(error) => return Err(error),
        };
        if missing || policy.is_index_hidden_at(root, Path::new(&relative)) {
            if !root.is_dir() {
                return Err(io::Error::new(io::ErrorKind::NotFound, "notebook directory unavailable"));
            }
            tx.execute(
                "DELETE FROM note_search_fts WHERE relative_path = ?1",
                params![relative],
            )
            .map_err(io::Error::other)?;
            report.removed += tx
                .execute(
                    "DELETE FROM notes WHERE relative_path = ?1",
                    params![relative],
                )
                .map_err(io::Error::other)?;
            tx.commit().map_err(io::Error::other)?;
            return Ok(());
        }
        let metadata = fs::metadata(path)?;
        let size = metadata.len() as i64;
        let modified_ns = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| time.as_nanos().min(i64::MAX as u128) as i64);
        let file_created_ms = metadata
            .created()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| time.as_millis().min(i64::MAX as u128) as i64)
            .unwrap_or_else(|| modified_ns.unwrap_or(0) / 1_000_000);
        let previous: Option<(i64, Option<i64>, String, i64)> = tx.query_row(
                "SELECT size_bytes, modified_ns, content_hash, created_at FROM notes WHERE relative_path = ?1",
                params![relative],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            ).optional().map_err(io::Error::other)?;
        if !verify_hashes
            && !reparse_all
            && previous
                .as_ref()
                .is_some_and(|(old_size, old_modified, _, _)| {
                    *old_size == size && *old_modified == modified_ns
                })
        {
            report.unchanged += 1;
            tx.commit().map_err(io::Error::other)?;
            return Ok(());
        }
        let owned_bytes = if content_snapshot.is_none() {
            Some(fs::read(path)?)
        } else {
            None
        };
        let bytes = content_snapshot
            .map(str::as_bytes)
            .or_else(|| owned_bytes.as_deref())
            .expect("a file snapshot or disk bytes are available");
        let hash = format!("{:x}", Sha256::digest(bytes));
        if !reparse_all
            && previous
                .as_ref()
                .is_some_and(|(_, _, old_hash, _)| *old_hash == hash)
        {
            tx.execute(
                "UPDATE notes SET size_bytes = ?2, modified_ns = ?3 WHERE relative_path = ?1",
                params![relative, size, modified_ns],
            )
            .map_err(io::Error::other)?;
            report.unchanged += 1;
            tx.commit().map_err(io::Error::other)?;
            return Ok(());
        }
        let owned_content = match content_snapshot {
            Some(_) => None,
            None => Some(
                String::from_utf8(owned_bytes.expect("disk bytes were loaded"))
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?,
            ),
        };
        let content = content_snapshot
            .or(owned_content.as_deref())
            .expect("a valid note content snapshot is available");
        let title = display_title_from_relative_path(&relative);
        let derived = super::derivation::derive_note_fields(&content);
        let metadata = derived.metadata.unwrap_or_default();
        let filename = relative.rsplit('/').next().unwrap_or(&relative).to_owned();
        let filename_lower = filename.to_lowercase();
        tx.execute(
                "INSERT INTO notes (relative_path, size_bytes, modified_ns, content_hash, title, preview, thumbnail, properties_json, indexed_at, created_at, updated_at, favorited, icon, colors_json, filename, filename_lower, tags, todos, agents) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19) \
                 ON CONFLICT(relative_path) DO UPDATE SET size_bytes=excluded.size_bytes, modified_ns=excluded.modified_ns, \
                 content_hash=excluded.content_hash, title=excluded.title, preview=excluded.preview, thumbnail=excluded.thumbnail, \
                 properties_json=excluded.properties_json, indexed_at=excluded.indexed_at, \
                 created_at=excluded.created_at, updated_at=excluded.updated_at, favorited=excluded.favorited, \
                 icon=excluded.icon, colors_json=excluded.colors_json, filename=excluded.filename, filename_lower=excluded.filename_lower, \
                 tags=excluded.tags, todos=excluded.todos, agents=excluded.agents",
                params![relative, size, modified_ns, hash, title, derived.preview, derived.thumbnail,
                    metadata.properties.to_string(),
                    chrono::Utc::now().timestamp_millis(),
                    previous.as_ref().map(|(_, _, _, created)| *created).filter(|created| *created > 0)
                        .unwrap_or(file_created_ms),
                    modified_ns.unwrap_or(0) / 1_000_000,
                    i64::from(metadata.favorited), metadata.icon,
                     serde_json::to_string(&metadata.colors).map_err(io::Error::other)?,
                     filename, filename_lower,
                     serde_json::to_string(&metadata.tags).map_err(io::Error::other)?,
                     serde_json::to_string(&derived.todos).map_err(io::Error::other)?,
                     serde_json::to_string(&derived.agents).map_err(io::Error::other)?],
            ).map_err(io::Error::other)?;
        tx.execute(
            "DELETE FROM note_search_fts WHERE relative_path = ?1",
            params![relative],
        )
        .map_err(io::Error::other)?;
        tx.execute(
            "INSERT INTO note_search_fts(relative_path, title, body, tags, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                relative,
                title,
                derived.body,
                metadata.tags.join(" "),
                modified_ns.unwrap_or(0) / 1_000_000,
            ],
        )
        .map_err(io::Error::other)?;
        tx.commit().map_err(io::Error::other)?;
        if previous.is_some() {
            report.updated += 1;
        } else {
            report.added += 1;
        }
        Ok(())
    }

    pub(crate) fn open_note_index_connection(&self, notebook_id: &str) -> io::Result<Connection> {
        self.open_note_index_connection_inner(notebook_id, false)
    }

    /// Upgrade an existing note index only from the version-initialization worker.
    pub fn initialize_note_index_schema(&self, notebook_id: &str) -> io::Result<()> {
        self.open_note_index_connection_inner(notebook_id, true)?;
        Ok(())
    }

    fn open_note_index_connection_inner(
        &self,
        notebook_id: &str,
        run_legacy_migrations: bool,
    ) -> io::Result<Connection> {
        let path = self.notebook_db_path(notebook_id)?;
        if run_legacy_migrations {
            super::with_database_rebuild(&path, || {
                self.open_note_index_connection_unchecked(notebook_id, true)
            })
        } else {
            self.open_note_index_connection_unchecked(notebook_id, false)
        }
    }

    fn open_note_index_connection_unchecked(
        &self,
        notebook_id: &str,
        run_legacy_migrations: bool,
    ) -> io::Result<Connection> {
        let path = self.notebook_db_path(notebook_id)?;
        let mut conn = Connection::open(path).map_err(io::Error::other)?;
        conn.busy_timeout(std::time::Duration::from_secs(10))
            .map_err(io::Error::other)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(io::Error::other)?;
        if !run_legacy_migrations && note_schema_is_current(&conn, notebook_id)? {
            return Ok(conn);
        }
        if run_legacy_migrations {
            discard_legacy_v2_note_projection(&mut conn)?;
        }
        conn.execute_batch("CREATE TABLE IF NOT EXISTS note_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); \
            CREATE TABLE IF NOT EXISTS notes (relative_path TEXT PRIMARY KEY, \
              size_bytes INTEGER NOT NULL, modified_ns INTEGER, content_hash TEXT NOT NULL, \
              title TEXT NOT NULL, preview TEXT NOT NULL, thumbnail TEXT, properties_json TEXT NOT NULL, indexed_at INTEGER NOT NULL, \
              created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, \
              favorited INTEGER NOT NULL DEFAULT 0, icon TEXT, colors_json TEXT NOT NULL DEFAULT '[]', \
              filename TEXT NOT NULL DEFAULT '', filename_lower TEXT NOT NULL DEFAULT '', \
              tags TEXT NOT NULL DEFAULT '[]', todos TEXT NOT NULL DEFAULT '[]', agents TEXT NOT NULL DEFAULT '[]'); \
            CREATE TABLE IF NOT EXISTS note_content_revisions (notebook_id TEXT NOT NULL, \
              relative_path TEXT NOT NULL, content_hash TEXT NOT NULL, local_revision INTEGER NOT NULL, \
              change_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(notebook_id, relative_path));")
            .map_err(io::Error::other)?;
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS note_search_fts USING fts5(\
                relative_path UNINDEXED, title, body, tags, updated_at UNINDEXED,\
                tokenize='trigram'\
            );",
        )
        .map_err(io::Error::other)?;
        if run_legacy_migrations {
            for (column, definition) in [
                ("thumbnail", "TEXT"),
                ("created_at", "INTEGER NOT NULL DEFAULT 0"),
                ("updated_at", "INTEGER NOT NULL DEFAULT 0"),
                ("favorited", "INTEGER NOT NULL DEFAULT 0"),
                ("icon", "TEXT"),
                ("colors_json", "TEXT NOT NULL DEFAULT '[]'"),
                ("filename", "TEXT NOT NULL DEFAULT ''"),
                ("filename_lower", "TEXT NOT NULL DEFAULT ''"),
                ("tags", "TEXT NOT NULL DEFAULT '[]'"),
                ("todos", "TEXT NOT NULL DEFAULT '[]'"),
                ("agents", "TEXT NOT NULL DEFAULT '[]'"),
            ] {
                let mut statement = conn
                    .prepare("PRAGMA table_info(notes)")
                    .map_err(io::Error::other)?;
                let names = statement
                    .query_map([], |row| row.get::<_, String>(1))
                    .map_err(io::Error::other)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(io::Error::other)?;
                if !names.iter().any(|name| name == column) {
                    conn.execute_batch(&format!(
                        "ALTER TABLE notes ADD COLUMN {column} {definition}"
                    ))
                    .map_err(io::Error::other)?;
                }
            }
            // Older path projections stored derived values in child tables.
            // Markdown is authoritative, so do not copy these rows into the
            // new projection. Force a full parser pass before any query can
            // rely on the replacement columns, then discard the old tables.
            let has_table = |name: &str| -> io::Result<bool> {
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [name],
                    |row| row.get(0),
                ).map_err(io::Error::other)
            };
            let has_legacy_derived_tables = ["note_tags", "note_todos", "note_agents"]
                .into_iter()
                .try_fold(false, |found, table| Ok::<_, io::Error>(found || has_table(table)?))?;
            if has_legacy_derived_tables {
                conn.execute(
                    "DELETE FROM note_index_meta WHERE key='parser_version'",
                    [],
                )
                .map_err(io::Error::other)?;
            }
            conn.execute_batch("DROP TABLE IF EXISTS note_tags; DROP TABLE IF EXISTS note_todos; DROP TABLE IF EXISTS note_agents;")
                .map_err(io::Error::other)?;
        }
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_notes_created_page ON notes(favorited DESC, created_at DESC, relative_path DESC); \
            CREATE INDEX IF NOT EXISTS idx_notes_updated_page ON notes(favorited DESC, updated_at DESC, relative_path DESC); \
            CREATE INDEX IF NOT EXISTS idx_notes_filename_page ON notes(favorited DESC, filename_lower ASC, filename ASC, relative_path ASC);")
            .map_err(io::Error::other)?;
        conn.execute(
            "INSERT INTO note_index_meta (key, value) VALUES ('schema_version', ?1) \
                      ON CONFLICT(key) DO NOTHING",
            params![SCHEMA_VERSION.to_string()],
        )
        .map_err(io::Error::other)?;
        let stored_version: String = conn
            .query_row(
                "SELECT value FROM note_index_meta WHERE key='schema_version'",
                [],
                |row| row.get(0),
            )
            .map_err(io::Error::other)?;
        if stored_version != SCHEMA_VERSION.to_string() {
            let legacy_version = stored_version.parse::<i64>().unwrap_or(i64::MAX);
            if !run_legacy_migrations || legacy_version > SCHEMA_VERSION {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("unsupported Note index schema version: {stored_version}"),
                ));
            }
            conn.execute(
                "UPDATE note_index_meta SET value = ?1 WHERE key = 'schema_version'",
                params![SCHEMA_VERSION.to_string()],
            )
            .map_err(io::Error::other)?;
        }
        let stored_notebook: Option<String> = conn
            .query_row(
                "SELECT value FROM note_index_meta WHERE key='notebook_id'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(io::Error::other)?;
        if stored_notebook.is_some_and(|stored| stored != notebook_id) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Note index belongs to a different notebook",
            ));
        }
        conn.execute(
            "INSERT INTO note_index_meta (key, value) VALUES ('notebook_id', ?1) \
             ON CONFLICT(key) DO NOTHING",
            params![notebook_id],
        )
        .map_err(io::Error::other)?;
        Ok(conn)
    }
}

/// Inspect the database itself on every open, rather than caching a path:
/// another process may replace/rebuild the file while this process stays alive.
fn note_schema_is_current(conn: &Connection, notebook_id: &str) -> io::Result<bool> {
    let objects: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE \
         (type='table' AND name IN ('note_index_meta', 'notes', 'note_content_revisions', 'note_search_fts')) \
         OR (type='index' AND name IN ('idx_notes_created_page', 'idx_notes_updated_page', 'idx_notes_filename_page'))",
        [], |row| row.get(0),
    ).map_err(io::Error::other)?;
    if objects != 7 { return Ok(false); }
    let mut statement = conn.prepare(
        "SELECT key, value FROM note_index_meta WHERE key IN ('schema_version', 'notebook_id')"
    ).map_err(io::Error::other)?;
    let values = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(io::Error::other)?
        .collect::<Result<HashMap<_, _>, _>>().map_err(io::Error::other)?;
    let Some(version) = values.get("schema_version") else { return Ok(false); };
    if version != &SCHEMA_VERSION.to_string() {
        return Err(io::Error::new(io::ErrorKind::InvalidData,
            format!("unsupported Note index schema version: {version}")));
    }
    match values.get("notebook_id") {
        Some(stored) if stored == notebook_id => Ok(true),
        Some(_) => Err(io::Error::new(io::ErrorKind::InvalidData,
            "Note index belongs to a different notebook")),
        None => Ok(false),
    }
}

/// The V2 path projection is derived from Markdown. Drop its tables on first
/// use, leaving the current Note projection and unrelated notebook data intact.
fn discard_legacy_v2_note_projection(conn: &mut Connection) -> io::Result<()> {
    // Nearly every Note operation opens a connection. Keep the common path
    // read-only; take a writer reservation only while clearing legacy tables.
    let has_legacy_tables: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name IN \
             ('v2_index_meta', 'v2_notes', 'v2_note_tags', 'v2_note_todos', \
              'v2_note_agents', 'v2_note_search', 'v2_note_search_fts'))",
            [],
            |row| row.get(0),
        )
        .map_err(io::Error::other)?;
    if !has_legacy_tables {
        return Ok(());
    }

    // A concurrent opener may have already removed these tables. IF EXISTS
    // makes the transaction safe in either case. Drop FTS virtual tables by
    // their parent name so SQLite also removes their shadow tables.
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(io::Error::other)?;
    tx.execute_batch(
        "DROP TABLE IF EXISTS v2_note_search;
         DROP TABLE IF EXISTS v2_note_search_fts;
         DROP TABLE IF EXISTS v2_note_tags;
         DROP TABLE IF EXISTS v2_note_todos;
         DROP TABLE IF EXISTS v2_note_agents;
         DROP TABLE IF EXISTS v2_notes;
         DROP TABLE IF EXISTS v2_index_meta;",
    )
    .map_err(io::Error::other)?;
    tx.commit().map_err(io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memo_file::NotebookConfig;

    fn background_fixture() -> (tempfile::TempDir, MemoFile, std::path::PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook"); fs::create_dir_all(&root).unwrap();
        let memo = MemoFile::new(temp.path().join("config"));
        memo.initialize_current_registry_storage().unwrap();
        memo.write_notebook_configs(&[NotebookConfig {
            id: "background".into(), name: "Background".into(), icon: None,
            path: root.to_string_lossy().into_owned(), is_default: true,
            sort: 0, created_at: 0, updated_at: 0,
        }]).unwrap();
        (temp, memo, root)
    }

    #[test]
    fn tree_metadata_reads_only_requested_paths_in_bounded_batches() {
        let (_temp, memo, root) = background_fixture();
        fs::write(root.join("a.md"), "original body").unwrap();
        memo.reconcile_note_index("background").unwrap();
        let conn = memo.open_note_index_connection("background").unwrap();
        // A malformed field unrelated to tree rows must not break this query.
        conn.execute("UPDATE notes SET properties_json='invalid', favorited=1, icon='star', colors_json='[\"red\"]' WHERE relative_path='a.md'", []).unwrap();
        conn.execute("INSERT INTO notes SELECT 'nested/a.md', size_bytes, modified_ns, content_hash, title, preview, thumbnail, properties_json, indexed_at, created_at, updated_at, favorited, icon, colors_json, filename, filename_lower, tags, todos, agents FROM notes WHERE relative_path='a.md'", []).unwrap();
        fs::remove_file(root.join("a.md")).unwrap();
        let mut paths: Vec<String> = (0..650).map(|i| format!("missing-{i}.md")).collect();
        paths.push("a.md".into());
        paths.push("quote'%_?.md".into());
        let result = memo.read_note_tree_metadata_for_paths("background", &paths).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].relative_path, "a.md");
        assert!(result[0].favorited);
        assert_eq!(result[0].icon.as_deref(), Some("star"));
        assert_eq!(result[0].colors, vec![NoteColor::Red]);
    }

    #[test]
    fn note_refresh_can_reuse_a_watcher_content_snapshot() {
        let (_temp, memo, root) = background_fixture();
        let snapshot = "body read by the watcher\nsecond line";
        fs::write(root.join("snapshot.md"), "previous body").unwrap();
        memo.reconcile_note_index("background").unwrap();
        fs::write(root.join("snapshot.md"), snapshot).unwrap();

        memo.refresh_note_path_with_content("background", "snapshot.md", snapshot)
            .unwrap();

        let entries = memo.read_note_entries("background").unwrap();
        let entry = entries
            .iter()
            .find(|entry| entry.relative_path == "snapshot.md")
            .unwrap();
        assert_eq!(entry.preview, "body read by the watcher");
    }

    #[test]
    fn schema_fast_path_opens_while_another_connection_holds_the_writer_lock() {
        let (_temp, memo, _root) = background_fixture();
        let writer = memo.open_note_index_connection("background").unwrap();
        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        // Authoritative warm schema requires no CREATE/INSERT operations.
        let reader = memo.open_note_index_connection("background").unwrap();
        assert!(note_schema_is_current(&reader, "background").unwrap());
        writer.execute_batch("ROLLBACK").unwrap();
    }

    #[test]
    fn schema_fast_path_checks_missing_objects_and_replaced_database() {
        let (_temp, memo, _root) = background_fixture();
        let conn = memo.open_note_index_connection("background").unwrap();
        conn.execute_batch("DROP TABLE note_content_revisions").unwrap();
        assert!(!note_schema_is_current(&conn, "background").unwrap());
        drop(conn);
        assert!(note_schema_is_current(&memo.open_note_index_connection("background").unwrap(), "background").unwrap());
        let path = memo.notebook_db_path("background").unwrap();
        fs::remove_file(path).unwrap();
        // A newly opened file must initialize even in the same process.
        assert!(note_schema_is_current(&memo.open_note_index_connection("background").unwrap(), "background").unwrap());
    }

    #[test]
    fn schema_fast_path_rejects_wrong_notebook_and_version() {
        let (_temp, memo, _root) = background_fixture();
        let conn = memo.open_note_index_connection("background").unwrap();
        assert!(note_schema_is_current(&conn, "another").is_err());
        conn.execute("UPDATE note_index_meta SET value='999' WHERE key='schema_version'", []).unwrap();
        assert!(memo.open_note_index_connection("background").is_err());
        let version: String = conn.query_row("SELECT value FROM note_index_meta WHERE key='schema_version'", [], |row| row.get(0)).unwrap();
        assert_eq!(version, "999");
    }

    #[test]
    fn note_page_reads_projection_without_repairing_or_opening_markdown() {
        let (_temp, memo, root) = background_fixture();
        fs::write(root.join("a.md"), "# Indexed\nOriginal body").unwrap();
        memo.reconcile_note_index("background").unwrap();
        let before = memo.read_indexed_note_entry_by_path("background", "a.md").unwrap().unwrap();
        // The watcher has not processed this external change yet. A list query
        // must keep the index snapshot rather than repairing the selected rows.
        fs::write(root.join("a.md"), "# Changed\nDifferent body").unwrap();
        let page = memo.read_note_page("background", "all", None, None, "updatedAt", i64::MAX, 0, 0, None, 51).unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].preview, before.preview);
        assert_eq!(page[0].updated_at, before.updated_at);
        // Even a temporarily missing source file cannot break the index query.
        fs::remove_file(root.join("a.md")).unwrap();
        assert_eq!(memo.read_note_page("background", "all", None, None, "createdAt", i64::MAX, 0, 0, None, 51).unwrap().len(), 1);
    }

    #[test]
    fn cached_counts_do_not_create_or_scan_a_cold_notebook() {
        let (_temp, memo, root) = background_fixture();
        fs::write(root.join("a.md"), "untouched").unwrap();
        assert_eq!(memo.cached_note_count("background").unwrap(), None);
        assert!(!root.join(".flowix/notebook.db").exists());
    }

    #[test]
    fn cached_counts_treat_an_old_database_without_projection_as_unknown() {
        let (_temp, memo, _root) = background_fixture();
        let path = memo.notebook_db_path("background").unwrap();
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE legacy_data (value TEXT); INSERT INTO legacy_data VALUES ('keep');").unwrap();
        assert_eq!(memo.cached_note_count("background").unwrap(), None);
        let value: String = conn.query_row("SELECT value FROM legacy_data", [], |row| row.get(0)).unwrap();
        assert_eq!(value, "keep");
        let tables: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name='notes'", [], |row| row.get(0)).unwrap();
        assert_eq!(tables, 0);
    }

    #[test]
    fn background_scan_reports_busy_instead_of_claiming_completion() {
        let (_temp, memo, _root) = background_fixture();
        let _guard = memo.operation_locks().notebook_maintenance("background", "test_busy").unwrap();
        assert_eq!(memo.reconcile_note_index_background("background", &|| true).unwrap_err().kind(), io::ErrorKind::WouldBlock);
        // Preserve the older passive API's documented skip behavior.
        assert_eq!(memo.reconcile_note_index("background").unwrap(), NoteIndexReconcileReport::default());
    }

    #[test]
    fn cold_tag_queries_request_preparation_without_scanning() {
        let (_temp, memo, root) = background_fixture();
        fs::write(root.join("a.md"), "#tag\nbody").unwrap();
        assert_eq!(memo.read_tag_usage_summary_for_notebook_id(Some("background")).unwrap_err().kind(), io::ErrorKind::WouldBlock);
        assert_eq!(memo.read_tag_prefix_counts_for_notebook_id(Some("background")).unwrap_err().kind(), io::ErrorKind::WouldBlock);
        assert_eq!(memo.note_count("background").unwrap(), 0);
        assert_eq!(memo.cached_note_count("background").unwrap(), None);
    }

    #[test]
    fn cancelled_cold_index_can_resume_without_changing_source_files() {
        let (_temp, memo, root) = background_fixture();
        fs::write(root.join("a.md"), "# Keep\nbody").unwrap();
        assert_eq!(memo.reconcile_note_index_background("background", &|| false).unwrap_err().kind(), io::ErrorKind::Interrupted);
        assert_eq!(memo.cached_note_count("background").unwrap(), None);
        memo.reconcile_note_index_background("background", &|| true).unwrap();
        assert_eq!(memo.cached_note_count("background").unwrap(), Some(1));
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "# Keep\nbody");
    }

    #[test]
    fn cancelled_warm_refresh_keeps_the_previous_projection_readable() {
        let (_temp, memo, root) = background_fixture();
        fs::write(root.join("a.md"), "a").unwrap();
        memo.reconcile_note_index_background("background", &|| true).unwrap();
        fs::write(root.join("b.md"), "b").unwrap();
        assert!(memo.reconcile_note_index_background("background", &|| false).is_err());
        assert_eq!(memo.read_note_entries("background").unwrap().len(), 1);
        memo.reconcile_note_index_background("background", &|| true).unwrap();
        assert_eq!(memo.read_note_entries("background").unwrap().len(), 2);
    }

    #[test]
    fn parser_upgrade_refreshes_preview_without_html_comments() {
        let (_temp, memo, root) = background_fixture();
        let content = "<!-- hidden metadata -->\nVisible text";
        fs::write(root.join("a.md"), content).unwrap();
        memo.reconcile_note_index("background").unwrap();
        let conn = memo.open_note_index_connection("background").unwrap();
        conn.execute("UPDATE notes SET preview='<!-- hidden metadata -->'", []).unwrap();
        conn.execute("UPDATE note_index_meta SET value='10' WHERE key='parser_version'", []).unwrap();
        drop(conn);

        assert!(!memo.note_index_is_ready("background").unwrap());
        assert_eq!(memo.reconcile_note_index("background").unwrap().updated, 1);
        assert_eq!(memo.read_note_entries("background").unwrap()[0].preview, "Visible text");
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), content);
    }

    #[test]
    fn parser_upgrade_repairs_null_tag_properties_without_changing_note() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir_all(&root).unwrap();
        let content = "---\ntags: null\n哈哈哈: \"111\"\n测试111日起: 2026-10-13\ntest: hhhhh\n---\nbody\n";
        let path = root.join("哈哈-1哈哈哈.md");
        fs::write(&path, content).unwrap();
        let store = MemoFile::new(temp.path().join("config"));
        store.write_notebook_configs(&[NotebookConfig {
            id: "nb_null_tags".into(), name: "Null tags".into(), icon: None,
            path: root.to_string_lossy().into_owned(), is_default: true,
            sort: 0, created_at: 0, updated_at: 0,
        }]).unwrap();
        store.reconcile_note_index("nb_null_tags").unwrap();
        // Reproduce a version-7 projection: the hash is current but parsing
        // null tags discarded every frontmatter property.
        let conn = store.open_note_index_connection("nb_null_tags").unwrap();
        conn.execute("UPDATE notes SET properties_json='{}'", []).unwrap();
        conn.execute("UPDATE note_index_meta SET value='7' WHERE key='parser_version'", []).unwrap();
        drop(conn);

        assert!(!store.note_index_is_ready("nb_null_tags").unwrap());
        let report = store.reconcile_note_index("nb_null_tags").unwrap();
        assert_eq!(report.updated, 1);
        let note = store.read_note_entries("nb_null_tags").unwrap().remove(0);
        assert_eq!(note.properties["哈哈哈"], "111");
        assert_eq!(note.properties["测试111日起"], "2026-10-13");
        assert_eq!(note.properties["test"], "hhhhh");
        assert_eq!(fs::read_to_string(path).unwrap(), content);
        assert_eq!(store.reconcile_note_index("nb_null_tags").unwrap().unchanged, 1);
    }


    #[test]
    fn mixed_v2_and_note_tables_keep_current_note_rows() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir_all(&root).unwrap();
        let store = MemoFile::new(temp.path().join("config"));
        store.write_notebook_configs(&[NotebookConfig {
            id: "nb_test".into(), name: "Test".into(), icon: None,
            path: root.to_string_lossy().into_owned(), is_default: true,
            sort: 0, created_at: 0, updated_at: 0,
        }]).unwrap();
        let conn = store.open_note_index_connection("nb_test").unwrap();
        conn.execute("INSERT INTO notes (relative_path, size_bytes, content_hash, title, preview, properties_json, indexed_at) VALUES ('current.md', 1, 'hash', 'Current', '', '{}', 1)", []).unwrap();
        conn.execute_batch("CREATE TABLE v2_index_meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE v2_notes (relative_path TEXT PRIMARY KEY);
            INSERT INTO v2_notes VALUES ('old.md');
            CREATE VIRTUAL TABLE v2_note_search USING fts5(body);
            INSERT INTO v2_note_search (body) VALUES ('old');
            CREATE TABLE memos (relative_path TEXT PRIMARY KEY);
            INSERT INTO memos VALUES ('legacy-note.md');").unwrap();
        drop(conn);

        // Legacy projection cleanup is part of startup schema initialization,
        // while ordinary reads keep the common connection path lightweight.
        store.initialize_note_index_schema("nb_test").unwrap();
        let conn = store.open_note_index_connection("nb_test").unwrap();
        let note: String = conn.query_row("SELECT relative_path FROM notes", [], |row| row.get(0)).unwrap();
        assert_eq!(note, "current.md");
        let memo_path: String = conn
            .query_row("SELECT relative_path FROM memos", [], |row| row.get(0))
            .unwrap();
        assert_eq!(memo_path, "legacy-note.md");
        let old_tables: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'v2_%'", [], |row| row.get(0)).unwrap();
        assert_eq!(old_tables, 0);
    }

    #[test]
    fn v2_only_projection_rebuilds_from_markdown() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir_all(root.join(".flowix")).unwrap();
        fs::write(root.join("new.md"), "# New note\n").unwrap();
        let store = MemoFile::new(temp.path().join("config"));
        store.write_notebook_configs(&[NotebookConfig {
            id: "nb_test".into(), name: "Test".into(), icon: None,
            path: root.to_string_lossy().into_owned(), is_default: true,
            sort: 0, created_at: 0, updated_at: 0,
        }]).unwrap();
        let conn = Connection::open(root.join(".flowix/notebook.db")).unwrap();
        conn.execute_batch("CREATE TABLE v2_index_meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE v2_notes (relative_path TEXT PRIMARY KEY);
            INSERT INTO v2_notes VALUES ('stale.md');").unwrap();
        drop(conn);

        assert!(!store.note_index_is_ready("nb_test").unwrap());
        store.reconcile_note_index("nb_test").unwrap();
        let entries = store.read_note_entries("nb_test").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].relative_path, "new.md");
        let expected_size = fs::metadata(root.join("new.md")).unwrap().len();
        assert_eq!(entries[0].size_bytes, expected_size);
        assert_eq!(store.read_indexed_note_entry_by_path("nb_test", "new.md").unwrap().unwrap().size_bytes, expected_size);
        assert_eq!(store.derive_note_entry_from_disk("nb_test", "new.md").unwrap().size_bytes, expected_size);
    }

    #[test]
    fn search_backfills_old_notebooks_and_tracks_path_changes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir_all(&root).unwrap();
        let note = root.join("检索.md");
        fs::write(&note, "---\ntags: [项目]\n---\n这里有苹果香蕉。\n").unwrap();
        let mut store = MemoFile::new(temp.path().join("config"));
        store
            .write_notebook_configs(&[NotebookConfig {
                id: "nb_search".into(),
                name: "Search".into(),
                icon: None,
                path: root.to_string_lossy().into_owned(),
                is_default: true,
                sort: 0,
                created_at: 0,
                updated_at: 0,
            }])
            .unwrap();
        store.set_current_notebook(Some("nb_search".into()));
        store.reconcile_note_index("nb_search").unwrap();

        // Simulate a notebook database written before the search projection.
        let conn = store.open_note_index_connection("nb_search").unwrap();
        conn.execute("DELETE FROM note_search_fts", []).unwrap();
        conn.execute(
            "DELETE FROM note_index_meta WHERE key='note_search_fts_version'",
            [],
        )
        .unwrap();
        drop(conn);

        assert_eq!(
            store
                .search_notes("nb_search", "苹果香蕉", 10)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store.search_notes("nb_search", "苹果", 10).unwrap().len(),
            1
        );
        assert_eq!(
            store.search_notes("nb_search", "项目", 10).unwrap()[0].matched_in,
            "tag"
        );

        fs::write(&note, "新的搜索内容。\n").unwrap();
        store.refresh_note_path("nb_search", "检索.md").unwrap();
        assert!(store
            .search_notes("nb_search", "苹果香蕉", 10)
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .search_notes("nb_search", "搜索内容", 10)
                .unwrap()
                .len(),
            1
        );

        fs::remove_file(&note).unwrap();
        store.refresh_note_path("nb_search", "检索.md").unwrap();
        assert!(store
            .search_notes("nb_search", "搜索内容", 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn builds_and_reconciles_from_markdown_without_memo_ids() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(
            root.join("sub/a.md"),
            "---\ntags: [work]\n---\n# A\nFirst\n",
        )
        .unwrap();
        let mut store = MemoFile::new(temp.path().join("config"));
        store
            .write_notebook_configs(&[NotebookConfig {
                id: "nb_test".into(),
                name: "Test".into(),
                icon: None,
                path: root.to_string_lossy().into_owned(),
                is_default: true,
                sort: 0,
                created_at: 0,
                updated_at: 0,
            }])
            .unwrap();
        store.set_current_notebook(Some("nb_test".into()));

        let first = store.reconcile_note_index("nb_test").unwrap();
        assert_eq!(first.added, 1);
        assert_eq!(store.reconcile_note_index("nb_test").unwrap().unchanged, 1);
        let conn = store.open_note_index_connection("nb_test").unwrap();
        let path: String = conn
            .query_row("SELECT relative_path FROM notes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(path, "sub/a.md");
        let legacy_tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='memos'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(legacy_tables, 0);
        let path_entries = store.read_note_entries("nb_test").unwrap();
        assert_eq!(path_entries.len(), 1);
        assert_eq!(path_entries[0].relative_path, "sub/a.md");
        assert_eq!(path_entries[0].title, "a");
        assert_eq!(path_entries[0].tags, vec!["work"]);
        let mut service = crate::service::NoteService::new(&store);
        assert_eq!(
            service.list_notes_by_path("nb_test").unwrap()[0].relative_path,
            "sub/a.md"
        );
        let opened = service.get_note_by_path("nb_test", "sub/a.md").unwrap();
        assert_eq!(opened.body, "---\ntags: [work]\n---\n# A\nFirst\n");
        conn.execute("DELETE FROM notes WHERE relative_path='sub/a.md'", [])
            .unwrap();
        assert_eq!(
            service
                .get_note_by_path("nb_test", "sub/a.md")
                .unwrap()
                .entry
                .title,
            "a"
        );
        let tags: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes n, json_each(n.tags) t WHERE t.value = 'work'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tags, 1);
        drop(conn);
        assert_eq!(store.cached_note_count("nb_test").unwrap(), Some(1));
        assert_eq!(
            store
                .occupied_filenames_in_directory("nb_test", Some("sub"))
                .unwrap(),
            vec!["a.md"]
        );
        let summary = store
            .read_tag_usage_summary_for_notebook_id(Some("nb_test"))
            .unwrap();
        assert_eq!(summary.0, vec!["work"]);
        assert_eq!(summary.2, 1);
        assert_eq!(
            store
                .read_tag_prefix_counts_for_notebook_id(Some("nb_test"))
                .unwrap()["work"],
            1
        );

        fs::write(root.join("sub/a.md"), "# A\nChanged\n").unwrap();
        assert_eq!(store.reconcile_note_index("nb_test").unwrap().updated, 1);
        fs::remove_file(root.join("sub/a.md")).unwrap();
        assert_eq!(store.reconcile_note_index("nb_test").unwrap().removed, 1);
    }

    #[test]
    fn content_revisions_survive_a_path_rename() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("a.md"), "# A\nbody\n").unwrap();
        let mut store = MemoFile::new(temp.path().join("config"));
        store
            .write_notebook_configs(&[NotebookConfig {
                id: "nb_test".into(),
                name: "Test".into(),
                icon: None,
                path: root.to_string_lossy().into_owned(),
                is_default: true,
                sort: 0,
                created_at: 0,
                updated_at: 0,
            }])
            .unwrap();
        store.set_current_notebook(Some("nb_test".into()));

        store
            .commit_note_content_revision("nb_test", "a.md", "hash-1", "change-1")
            .unwrap();
        let moved = store.move_note_by_path("nb_test", "a.md", "sub").unwrap();

        let revision = store
            .read_note_content_revision_for_notebook("nb_test", &moved)
            .unwrap()
            .expect("revision must follow the rename");
        assert_eq!(revision.revision, 1);
        assert_eq!(revision.change_id, "change-1");
        assert!(store
            .read_note_content_revision_for_notebook("nb_test", "a.md")
            .unwrap()
            .is_none());
    }

    #[test]
    fn moves_note_by_path_without_a_legacy_memo_row() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("a.md"), "# A\nbody\n").unwrap();
        let mut store = MemoFile::new(temp.path().join("config"));
        store
            .write_notebook_configs(&[NotebookConfig {
                id: "nb_test".into(),
                name: "Test".into(),
                icon: None,
                path: root.to_string_lossy().into_owned(),
                is_default: true,
                sort: 0,
                created_at: 0,
                updated_at: 0,
            }])
            .unwrap();
        store.set_current_notebook(Some("nb_test".into()));
        store.reconcile_note_index("nb_test").unwrap();
        let created_at = store
            .read_note_entry_by_path("nb_test", "a.md")
            .unwrap()
            .unwrap()
            .created_at;

        let moved = store.move_note_by_path("nb_test", "a.md", "sub").unwrap();

        assert_eq!(moved, "sub/a.md");
        assert!(!root.join("a.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("sub/a.md")).unwrap(),
            "# A\nbody\n"
        );
        let entries = store.read_note_entries("nb_test").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].relative_path, "sub/a.md");
        assert_eq!(entries[0].created_at, created_at);
        let conn = store.open_note_index_connection("nb_test").unwrap();
        let legacy_tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='memos'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(legacy_tables, 0);
    }

    #[test]
    fn note_projection_coexists_with_path_keyed_memo_rows_in_the_same_notebook_db() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir_all(&root).unwrap();
        let mut store = MemoFile::new(temp.path().join("config"));
        store
            .write_notebook_configs(&[NotebookConfig {
                id: "nb_test".into(),
                name: "Test".into(),
                icon: None,
                path: root.to_string_lossy().into_owned(),
                is_default: true,
                sort: 0,
                created_at: 0,
                updated_at: 0,
            }])
            .unwrap();
        store.set_current_notebook(Some("nb_test".into()));
        let created = store
            .create_memo("Legacy and Note", "# Legacy and Note\n", None)
            .unwrap();
        let conn = store.open_note_index_connection("nb_test").unwrap();
        let immediate_path: String = conn
            .query_row("SELECT relative_path FROM notes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(immediate_path, created.relative_path);
        drop(conn);
        // Creation already writes the current parsed projection, so a full scan
        // sees it as unchanged.
        assert_eq!(store.reconcile_note_index("nb_test").unwrap().unchanged, 1);
        let conn = store.open_note_index_connection("nb_test").unwrap();
        let memo_path: String = conn
            .query_row("SELECT relative_path FROM memos", [], |row| row.get(0))
            .unwrap();
        assert_eq!(memo_path, created.relative_path);
        let note_path: String = conn
            .query_row("SELECT relative_path FROM notes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(note_path, created.relative_path);
        drop(conn);
        let conn = store.open_memo_index_db_for_notebook_id("nb_test").unwrap();
        conn.execute(
            "UPDATE memos SET preview='stale memo preview' WHERE relative_path=?1",
            params![created.relative_path],
        )
        .unwrap();
        drop(conn);
        let mut service = crate::service::NoteService::new(&store);
        let service_list = service.list("nb_test").unwrap();
        assert_ne!(service_list[0].preview, "stale memo preview");
        store
            .write_memo(&created.relative_path, "# Changed\nnew body\n")
            .unwrap();
        let conn = store.open_note_index_connection("nb_test").unwrap();
        let title: String = conn
            .query_row("SELECT title FROM notes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(title, "Legacy and Note");
        drop(conn);
        store
            .delete_memo_result_global(&created.relative_path)
            .unwrap();
        let conn = store.open_note_index_connection("nb_test").unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }


}
