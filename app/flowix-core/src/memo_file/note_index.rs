//! Rebuildable, path-keyed note projection in the existing notebook.db.
//!
//! This index never supplies bytes for a note. Markdown remains the source of
//! content and the projection can be discarded and rebuilt from the notebook.

use std::collections::{BTreeMap, HashMap, HashSet};
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
    notebook_path_from_relative, notebook_relative_path, AgentThreadItem, Memo, MemoFile,
    MemoIndexEntry, MemoTodoEntry, NoteColor, PathTodoEntry, TodoItem,
};

const SCHEMA_VERSION: i64 = 3;
// Version 9 tolerates legacy malformed tags while retaining ordinary properties.
const PARSER_VERSION: i64 = 9;
const NOTE_SEARCH_FTS_VERSION: i64 = 1;
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

#[derive(Debug, PartialEq, Eq)]
pub enum NoteWriteOutcome {
    Saved { content: String },
    Conflict { disk_content: String },
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

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct NoteTodoMigrationReport {
    pub notes_written: usize,
    pub tasks_written: usize,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct NotePropertyMigrationReport {
    pub notes_written: usize,
    pub properties_written: usize,
}

#[derive(Debug)]
struct LegacyNoteProperties {
    id: String,
    relative_path: String,
    created_at: i64,
    favorited: bool,
    icon: Option<String>,
    properties_json: String,
}

#[derive(Debug)]
struct LegacyTodoAttributes {
    todo_id: String,
    priority: String,
    time_range: String,
    owner: String,
    assignee: String,
    created_at: i64,
    updated_at: i64,
}

impl LegacyTodoAttributes {
    fn has_persistent_value(&self) -> bool {
        !self.priority.is_empty()
            || !self.time_range.is_empty()
            || !self.owner.is_empty()
            || !self.assignee.is_empty()
            || self.created_at != 0
            || self.updated_at != 0
    }

    fn json_value(&self) -> serde_json::Value {
        serde_json::json!({
            "priority": self.priority,
            "timeRange": self.time_range,
            "owner": self.owner,
            "assignee": self.assignee,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        })
    }
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
                .is_ignored_at(&root, Path::new(&parent_relative))
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
        let root = self.notebook_root_for_note(notebook_id)?;
        let path = self.validate_note_path(&root, relative_path, true)?;
        super::frontmatter::extract_document_metadata_tolerant(content)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
        match self.write_file_if_matches_for_notebook(notebook_id, &path, content, expected_content)? {
            super::FileWriteOutcome::Conflict { disk_content } => {
                Ok(NoteWriteOutcome::Conflict { disk_content })
            }
            super::FileWriteOutcome::Saved => {
                if let Err(error) = self.refresh_note_path(notebook_id, relative_path) {
                    mark_note_index_refresh_pending_logged(&root, notebook_id, relative_path);
                    tracing::warn!(
                        notebook_id,
                        relative_path,
                        "note saved but path index refresh failed: {error}"
                    );
                }
                Ok(NoteWriteOutcome::Saved {
                    content: content.to_string(),
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
                .is_ignored_at(&root, relative)
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
        if normalized != relative_path
            || super::FileManagementPolicy::from_notebook_root(root).is_index_ignored_at(root, relative)
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
                "SELECT EXISTS(SELECT 1 FROM note_tags WHERE tag = ?1)",
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
        let prefix = format!("{tag}/");
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT relative_path FROM note_tags \
                 WHERE tag = ?1 OR tag LIKE ?2 ESCAPE '\\' ORDER BY relative_path",
            )
            .map_err(io::Error::other)?;
        let rows = stmt
            .query_map(params![tag, format!("{prefix}%")], |row| row.get(0))
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

    /// Query the existing projection without refreshing it from the file.
    /// Table references use index presence as the source of truth.
    pub fn read_indexed_note_entry_by_path(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> io::Result<Option<NoteEntry>> {
        let conn = self.open_note_index_connection(notebook_id)?;
        let row: Option<(String, String, String, Option<String>, i64, i64, i64, Option<String>, String, String)> = conn
            .query_row(
                "SELECT relative_path, title, preview, thumbnail, created_at, updated_at, favorited, icon, colors_json, properties_json \
                 FROM notes WHERE relative_path=?1",
                params![relative_path],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?,
                    row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?)),
            )
            .optional()
            .map_err(io::Error::other)?;
        let Some((
            relative_path,
            title,
            preview,
            thumbnail,
            created_at,
            updated_at,
            favorited,
            icon,
            colors,
            properties,
        )) = row
        else {
            return Ok(None);
        };
        let mut entry = NoteEntry {
            relative_path,
            title,
            preview,
            thumbnail,
            tags: Vec::new(),
            todos: Vec::new(),
            agents: Vec::new(),
            created_at,
            updated_at,
            favorited: favorited != 0,
            icon,
            colors: serde_json::from_str(&colors).map_err(io::Error::other)?,
            properties: serde_json::from_str(&properties).map_err(io::Error::other)?,
        };
        let mut stmt = conn
            .prepare("SELECT tag FROM note_tags WHERE relative_path=?1 ORDER BY tag")
            .map_err(io::Error::other)?;
        entry.tags = stmt
            .query_map(params![&entry.relative_path], |row| row.get(0))
            .map_err(io::Error::other)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io::Error::other)?;
        let mut stmt = conn.prepare(
            "SELECT todo_id, content, status FROM note_todos WHERE relative_path=?1 ORDER BY position"
        ).map_err(io::Error::other)?;
        entry.todos = stmt
            .query_map(params![&entry.relative_path], |row| {
                Ok(TodoItem {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    status: row.get(2)?,
                })
            })
            .map_err(io::Error::other)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io::Error::other)?;
        let mut stmt = conn.prepare(
            "SELECT thread_id, title, agent_type FROM note_agents WHERE relative_path=?1 ORDER BY position"
        ).map_err(io::Error::other)?;
        entry.agents = stmt
            .query_map(params![&entry.relative_path], |row| {
                Ok(AgentThreadItem {
                    thread_id: row.get(0)?,
                    title: row.get(1)?,
                    agent_type: row.get(2)?,
                })
            })
            .map_err(io::Error::other)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io::Error::other)?;
        Ok(Some(entry))
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
        let mut derived = Memo {
            id: String::new(),
            filename: relative_path
                .rsplit('/')
                .next()
                .unwrap_or(relative_path)
                .to_owned(),
            relative_path: relative_path.to_owned(),
            preview: String::new(),
            thumbnail: None,
            tags: Vec::new(),
            todos: Vec::new(),
            agents: Vec::new(),
            created_at,
            updated_at,
            favorited: false,
            icon: None,
            colors: Vec::new(),
            properties: serde_json::json!({}),
        };
        super::apply_derived_memo_fields(&mut derived, &content);
        let title = display_title_from_relative_path(relative_path);
        Ok(NoteEntry {
            relative_path: derived.relative_path,
            title,
            preview: derived.preview,
            thumbnail: derived.thumbnail,
            tags: derived.tags,
            todos: derived.todos,
            agents: derived.agents,
            created_at: derived.created_at,
            updated_at: derived.updated_at,
            favorited: derived.favorited,
            icon: derived.icon,
            colors: derived.colors,
            properties: derived.properties,
        })
    }

    /// Read the path-keyed list without opening any legacy memo table.
    pub fn read_note_entries(&self, notebook_id: &str) -> io::Result<Vec<NoteEntry>> {
        if !self.note_index_is_ready(notebook_id)? {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "Note index is not ready",
            ));
        }
        let conn = self.open_note_index_connection(notebook_id)?;
        let mut stmt = conn.prepare(
            "SELECT relative_path, title, preview, thumbnail, created_at, updated_at, favorited, icon, colors_json, properties_json \
             FROM notes ORDER BY created_at ASC, relative_path ASC"
        ).map_err(io::Error::other)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                ))
            })
            .map_err(io::Error::other)?;
        let mut entries = Vec::new();
        for row in rows {
            let (
                relative_path,
                title,
                preview,
                thumbnail,
                created_at,
                updated_at,
                favorited,
                icon,
                colors,
                properties,
            ) = row.map_err(io::Error::other)?;
            entries.push(NoteEntry {
                relative_path,
                title,
                preview,
                thumbnail,
                tags: Vec::new(),
                todos: Vec::new(),
                agents: Vec::new(),
                created_at,
                updated_at,
                favorited: favorited != 0,
                icon,
                colors: serde_json::from_str(&colors).map_err(io::Error::other)?,
                properties: serde_json::from_str(&properties).map_err(io::Error::other)?,
            });
        }
        drop(stmt);
        let positions: HashMap<_, _> = entries
            .iter()
            .enumerate()
            .map(|(index, entry)| (entry.relative_path.clone(), index))
            .collect();
        let mut stmt = conn
            .prepare("SELECT relative_path, tag FROM note_tags ORDER BY relative_path, tag")
            .map_err(io::Error::other)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(io::Error::other)?;
        for row in rows {
            let (path, tag) = row.map_err(io::Error::other)?;
            if let Some(index) = positions.get(&path) {
                entries[*index].tags.push(tag);
            }
        }
        let mut stmt = conn.prepare(
            "SELECT relative_path, todo_id, content, status FROM note_todos ORDER BY relative_path, position"
        ).map_err(io::Error::other)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    TodoItem {
                        id: row.get(1)?,
                        content: row.get(2)?,
                        status: row.get(3)?,
                    },
                ))
            })
            .map_err(io::Error::other)?;
        for row in rows {
            let (path, todo) = row.map_err(io::Error::other)?;
            if let Some(index) = positions.get(&path) {
                entries[*index].todos.push(todo);
            }
        }
        let mut stmt = conn.prepare(
            "SELECT relative_path, thread_id, title, agent_type FROM note_agents ORDER BY relative_path, position"
        ).map_err(io::Error::other)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    AgentThreadItem {
                        thread_id: row.get(1)?,
                        title: row.get(2)?,
                        agent_type: row.get(3)?,
                    },
                ))
            })
            .map_err(io::Error::other)?;
        for row in rows {
            let (path, agent) = row.map_err(io::Error::other)?;
            if let Some(index) = positions.get(&path) {
                entries[*index].agents.push(agent);
            }
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
        self.ensure_note_search_index(notebook_id)?;
        let root = self.notebook_root_for_note(notebook_id)?;
        if !pending_note_index_refreshes(&root)?.is_empty() {
            self.verify_note_index(notebook_id)?;
        }
        let conn = self.open_note_index_connection(notebook_id)?;
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
                       SELECT 1 FROM note_tags t
                       WHERE t.relative_path=note_search_fts.relative_path
                         AND (t.tag=?4 OR substr(t.tag, 1, length(?4)+1)=?4 || '/')
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
                       SELECT 1 FROM note_tags t
                       WHERE t.relative_path=note_search_fts.relative_path
                         AND (t.tag=?4 OR substr(t.tag, 1, length(?4)+1)=?4 || '/')
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

    fn ensure_note_search_index(&self, notebook_id: &str) -> io::Result<()> {
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
            return Ok(());
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
                "SELECT COALESCE(group_concat(tag, ' '), '') FROM note_tags WHERE relative_path=?1",
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
        tx.commit().map_err(io::Error::other)
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
        if !self.note_index_is_ready(notebook_id)? {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "Note index is not ready",
            ));
        }
        let conn = self.open_note_index_connection(notebook_id)?;
        let date_column = if sort == "updatedAt" {
            "updated_at"
        } else {
            "created_at"
        };
        let mut sql = String::from("SELECT n.relative_path FROM notes n WHERE 1=1");
        let mut args: Vec<SqlValue> = Vec::new();
        match filter {
            "todos" => sql.push_str(
                " AND EXISTS (SELECT 1 FROM note_todos t WHERE t.relative_path=n.relative_path)",
            ),
            "agents" => sql.push_str(
                " AND EXISTS (SELECT 1 FROM note_agents a WHERE a.relative_path=n.relative_path)",
            ),
            "favorited" => sql.push_str(" AND n.favorited=1"),
            "tagged" => {
                if let Some(tag) = tag_id {
                    sql.push_str(" AND EXISTS (SELECT 1 FROM note_tags t WHERE t.relative_path=n.relative_path AND (t.tag=? OR substr(t.tag,1,length(?)+1)=?))");
                    args.push(tag.to_owned().into());
                    args.push(tag.to_owned().into());
                    args.push(format!("{tag}/").into());
                } else {
                    sql.push_str(" AND EXISTS (SELECT 1 FROM note_tags t WHERE t.relative_path=n.relative_path)");
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
        let paths = conn
            .prepare(&sql)
            .map_err(io::Error::other)?
            .query_map(rusqlite::params_from_iter(args), |row| {
                row.get::<_, String>(0)
            })
            .map_err(io::Error::other)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io::Error::other)?;
        paths
            .into_iter()
            .map(|path| {
                self.read_note_entry_by_path(notebook_id, &path)?
                    .ok_or_else(|| {
                        io::Error::new(io::ErrorKind::NotFound, "indexed note disappeared")
                    })
            })
            .collect()
    }

    /// Adapt the path-keyed list to the current ID-bearing API while migration
    /// of external callers is still in progress.
    pub(crate) fn list_note_entries_with_legacy_ids(
        &self,
        notebook_id: &str,
    ) -> io::Result<Option<Vec<MemoIndexEntry>>> {
        if !self.note_index_is_ready(notebook_id)? {
            return Ok(None);
        }
        let entries = self.read_note_entries(notebook_id)?;
        let conn = self.open_note_index_connection(notebook_id)?;
        let legacy_table: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='memos'",
                [],
                |row| row.get(0),
            )
            .map_err(io::Error::other)?;
        if legacy_table == 0 {
            return Ok(None);
        }
        let mut stmt = conn
            .prepare("SELECT relative_path, id FROM memos WHERE notebook_id=?1")
            .map_err(io::Error::other)?;
        let mappings = stmt
            .query_map(params![notebook_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(io::Error::other)?
            .collect::<Result<HashMap<_, _>, _>>()
            .map_err(io::Error::other)?;
        if entries.len() != mappings.len() {
            return Ok(None);
        }
        let mut adapted = Vec::with_capacity(entries.len());
        for entry in entries {
            let Some(id) = mappings.get(&entry.relative_path) else {
                return Ok(None);
            };
            adapted.push(MemoIndexEntry {
                id: id.clone(),
                filename: entry
                    .relative_path
                    .rsplit('/')
                    .next()
                    .unwrap_or(&entry.relative_path)
                    .to_owned(),
                relative_path: entry.relative_path,
                preview: entry.preview,
                thumbnail: entry.thumbnail.clone(),
                tags: entry.tags,
                todos: entry.todos,
                agents: entry.agents,
                created_at: entry.created_at,
                updated_at: entry.updated_at,
                favorited: entry.favorited,
                icon: entry.icon,
                colors: entry.colors,
                properties: entry.properties,
            });
        }
        Ok(Some(adapted))
    }
    pub(crate) fn note_index_is_ready(&self, notebook_id: &str) -> io::Result<bool> {
        let conn = self.open_note_index_connection(notebook_id)?;
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
        let agents = count("SELECT COUNT(DISTINCT relative_path) FROM note_agents")?;
        let todos = count("SELECT COUNT(DISTINCT relative_path) FROM note_todos")?;
        let mut stmt = conn
            .prepare(
                "SELECT tag, COUNT(*) FROM note_tags GROUP BY tag ORDER BY tag COLLATE NOCASE ASC",
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
            .prepare("SELECT tag, relative_path FROM note_tags")
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

    pub fn read_note_path_todos(
        &self,
        notebook_id: &str,
        sort: &str,
    ) -> io::Result<Vec<PathTodoEntry>> {
        let conn = self.open_note_index_connection(notebook_id)?;
        let order = if sort == "updatedAt" {
            "t.updated_at DESC, t.created_at DESC"
        } else {
            "t.created_at DESC, t.updated_at DESC"
        };
        let sql = format!(
            "SELECT t.relative_path, t.todo_id, t.content, t.status, t.priority, t.time_range, \
            t.owner, t.assignee, t.created_at, t.updated_at FROM note_todos t ORDER BY {order}"
        );
        let mut statement = conn.prepare(&sql).map_err(io::Error::other)?;
        let rows = statement
            .query_map([], |row| {
                Ok(PathTodoEntry {
                    notebook_id: notebook_id.to_owned(),
                    relative_path: row.get(0)?,
                    todo_id: row.get(1)?,
                    content: row.get(2)?,
                    status: row.get(3)?,
                    priority: row.get(4)?,
                    time_range: row.get(5)?,
                    owner: row.get(6)?,
                    assignee: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })
            .map_err(io::Error::other)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(io::Error::other)
    }

    /// The Note projection owns task content and metadata. The legacy ID join only supplies
    /// the current IPC field until task actions accept note paths directly.
    pub(crate) fn note_todo_entries_with_legacy_ids(
        &self,
        notebook_id: &str,
        sort: &str,
    ) -> io::Result<Option<Vec<MemoTodoEntry>>> {
        let conn = self.open_note_index_connection(notebook_id)?;
        let missing: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM note_todos t LEFT JOIN memos m \
             ON m.notebook_id = ?1 AND m.relative_path = t.relative_path \
             WHERE m.id IS NULL",
                params![notebook_id],
                |row| row.get(0),
            )
            .map_err(io::Error::other)?;
        if missing != 0 {
            return Ok(None);
        }
        let order = if sort == "updatedAt" {
            "t.updated_at DESC, t.created_at DESC"
        } else {
            "t.created_at DESC, t.updated_at DESC"
        };
        let sql = format!(
            "SELECT t.todo_id, t.content, t.status, m.id, t.priority, t.time_range, \
             t.owner, t.assignee, t.created_at, t.updated_at \
             FROM note_todos t JOIN memos m \
             ON m.notebook_id = ?1 AND m.relative_path = t.relative_path ORDER BY {order}"
        );
        let mut stmt = conn.prepare(&sql).map_err(io::Error::other)?;
        let rows = stmt
            .query_map(params![notebook_id], |row| {
                Ok(MemoTodoEntry {
                    todo_id: row.get(0)?,
                    content: row.get(1)?,
                    status: row.get(2)?,
                    memo_id: row.get(3)?,
                    priority: row.get(4)?,
                    time_range: row.get(5)?,
                    owner: row.get(6)?,
                    assignee: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })
            .map_err(io::Error::other)?;
        Ok(Some(
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(io::Error::other)?,
        ))
    }
    /// Move note properties that may exist only in the legacy index into the
    /// Markdown frontmatter. Existing file properties always win.
    pub fn migrate_note_properties_for_notebook(
        &self,
        notebook_id: &str,
    ) -> io::Result<NotePropertyMigrationReport> {
        let _write_guard = self.acquire_cross_process_write_lock()?;
        let _index_guard = self.current_index_io.lock().expect("index_io poisoned");
        let root = self
            .get_notebook_config_by_id(notebook_id)
            .map(|config| std::path::PathBuf::from(config.path))
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "notebook not found"))?;
        let conn = self.open_note_index_connection(notebook_id)?;
        let complete: Option<String> = conn
            .query_row(
                "SELECT value FROM note_index_meta WHERE key='note_properties_migrated'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(io::Error::other)?;
        if complete.as_deref() == Some("1") {
            return Ok(NotePropertyMigrationReport::default());
        }
        let has_legacy: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='memos'",
                [],
                |row| row.get(0),
            )
            .map_err(io::Error::other)?;
        if has_legacy == 0 {
            conn.execute(
                "INSERT INTO note_index_meta (key, value) VALUES ('note_properties_migrated','1') \
                ON CONFLICT(key) DO UPDATE SET value='1'",
                [],
            )
            .map_err(io::Error::other)?;
            return Ok(NotePropertyMigrationReport::default());
        }
        let mut statement = conn
            .prepare(
                "SELECT id, relative_path, created_at, favorited, icon, properties \
             FROM memos WHERE notebook_id=?1 ORDER BY relative_path",
            )
            .map_err(io::Error::other)?;
        let notes = statement
            .query_map(params![notebook_id], |row| {
                Ok(LegacyNoteProperties {
                    id: row.get(0)?,
                    relative_path: row.get(1)?,
                    created_at: row.get(2)?,
                    favorited: row.get::<_, i64>(3)? != 0,
                    icon: row.get(4)?,
                    properties_json: row.get(5)?,
                })
            })
            .map_err(io::Error::other)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io::Error::other)?;
        drop(statement);
        let legacy_created_times: Vec<_> = notes
            .iter()
            .filter(|note| note.created_at > 0)
            .map(|note| (note.relative_path.clone(), note.created_at))
            .collect();
        let mut report = NotePropertyMigrationReport::default();
        for note in notes {
            let stored_properties: serde_json::Value = serde_json::from_str(&note.properties_json)
                .map_err(|error| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!(
                            "invalid legacy properties for {}: {error}",
                            note.relative_path
                        ),
                    )
                })?;
            let stored_properties = stored_properties.as_object().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "legacy properties are not an object for {}",
                        note.relative_path
                    ),
                )
            })?;
            let path = notebook_path_from_relative(&root, &note.relative_path)
                .map_err(io::Error::other)?;
            let original = fs::read_to_string(&path)?;
            let metadata = super::extract_document_metadata(&original)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
            let existing = metadata.properties.as_object().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "frontmatter is not a mapping")
            })?;
            let mut values = serde_json::Map::new();
            if note.favorited && !existing.contains_key("flowix_favorited") {
                values.insert("flowix_favorited".into(), serde_json::json!(true));
            }
            if let Some(icon) = note.icon.filter(|value| !value.is_empty()) {
                if !existing.contains_key("flowix_icon") {
                    values.insert("flowix_icon".into(), serde_json::json!(icon));
                }
            }
            if !existing.contains_key("flowix_colors") {
                let mut colors = conn
                    .prepare("SELECT color FROM memo_colors WHERE memo_id=?1 ORDER BY position")
                    .map_err(io::Error::other)?
                    .query_map(params![note.id], |row| row.get::<_, String>(0))
                    .map_err(io::Error::other)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(io::Error::other)?;
                if !colors.is_empty() {
                    values.insert(
                        "flowix_colors".into(),
                        serde_json::json!(std::mem::take(&mut colors)),
                    );
                }
            }
            for (key, value) in stored_properties {
                if key != "key"
                    && key != "flowix_key"
                    && key != "flowix_created_at"
                    && !existing.contains_key(key)
                    && !values.contains_key(key)
                {
                    values.insert(key.clone(), value.clone());
                }
            }
            if values.is_empty() {
                continue;
            }
            let mut overrides = super::MergeOverrides::new();
            for (key, value) in &values {
                if key.is_empty() || key.contains(['\n', '\r']) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("invalid legacy property name in {}", note.relative_path),
                    ));
                }
                let yaml_key = if key
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
                {
                    key.clone()
                } else {
                    serde_json::to_string(key).map_err(io::Error::other)?
                };
                overrides.insert(yaml_key, value.to_string());
            }
            let updated = super::merge_frontmatter(&original, &overrides);
            let readback = super::extract_document_metadata(&updated)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
            for (key, value) in &values {
                if readback.properties.get(key) != Some(value) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("property {key} readback failed for {}", note.relative_path),
                    ));
                }
            }
            if fs::read_to_string(&path)? != original {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    format!(
                        "note changed during property migration: {}",
                        note.relative_path
                    ),
                ));
            }
            super::atomic_write_bytes(&path, updated.as_bytes())?;
            report.notes_written += 1;
            report.properties_written += values.len();
        }
        // Creation time remains index metadata. Seed it from the old index
        // once, without changing the Markdown file for this field.
        for (relative_path, created_at) in legacy_created_times {
            self.refresh_note_path(notebook_id, &relative_path)?;
            conn.execute(
                "UPDATE notes SET created_at=?2 WHERE relative_path=?1",
                params![relative_path, created_at],
            )
            .map_err(io::Error::other)?;
        }
        conn.execute(
            "INSERT INTO note_index_meta (key, value) VALUES ('note_properties_migrated','1') \
            ON CONFLICT(key) DO UPDATE SET value='1'",
            [],
        )
        .map_err(io::Error::other)?;
        Ok(report)
    }

    /// Persist non-derivable legacy task attributes in their Markdown note.
    /// The migration is idempotent. A mismatched task ID or conflicting
    /// frontmatter value aborts before writing that note.
    pub fn migrate_note_todo_metadata_for_notebook(
        &self,
        notebook_id: &str,
    ) -> io::Result<NoteTodoMigrationReport> {
        let _write_guard = self.acquire_cross_process_write_lock()?;
        let _index_guard = self.current_index_io.lock().expect("index_io poisoned");
        let root = self
            .get_notebook_config_by_id(notebook_id)
            .map(|config| std::path::PathBuf::from(config.path))
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "notebook not found"))?;
        let conn = self.open_note_index_connection(notebook_id)?;
        let complete: Option<String> = conn
            .query_row(
                "SELECT value FROM note_index_meta WHERE key='todo_metadata_migrated'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(io::Error::other)?;
        if complete.as_deref() == Some("1") {
            return Ok(NoteTodoMigrationReport::default());
        }
        let has_legacy: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='memo_todos'",
                [],
                |row| row.get(0),
            )
            .map_err(io::Error::other)?;
        if has_legacy == 0 {
            conn.execute(
                "INSERT INTO note_index_meta (key, value) VALUES ('todo_metadata_migrated', '1') \
                          ON CONFLICT(key) DO UPDATE SET value='1'",
                [],
            )
            .map_err(io::Error::other)?;
            return Ok(NoteTodoMigrationReport::default());
        }
        let mut stmt = conn
            .prepare("SELECT m.relative_path, t.todo_id, t.priority, t.time_range, t.owner, t.assignee, \
                      t.created_at, t.updated_at FROM memo_todos t \
                      JOIN memos m ON m.id=t.memo_id WHERE m.notebook_id=?1 ORDER BY m.relative_path, t.position")
            .map_err(io::Error::other)?;
        let rows = stmt
            .query_map(params![notebook_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    LegacyTodoAttributes {
                        todo_id: row.get(1)?,
                        priority: row.get(2)?,
                        time_range: row.get(3)?,
                        owner: row.get(4)?,
                        assignee: row.get(5)?,
                        created_at: row.get(6)?,
                        updated_at: row.get(7)?,
                    },
                ))
            })
            .map_err(io::Error::other)?;
        let mut by_path: BTreeMap<String, Vec<LegacyTodoAttributes>> = BTreeMap::new();
        for row in rows {
            let (path, attributes) = row.map_err(io::Error::other)?;
            if attributes.has_persistent_value() {
                by_path.entry(path).or_default().push(attributes);
            }
        }
        drop(stmt);
        let mut report = NoteTodoMigrationReport::default();
        for (relative_path, attributes) in by_path {
            let path =
                notebook_path_from_relative(&root, &relative_path).map_err(io::Error::other)?;
            let original = fs::read_to_string(&path)?;
            let with_ids = super::ensure_todo_ids_in_content(&original);
            let todos = super::extract_todos_from_body(&with_ids);
            let known_ids: HashSet<String> = todos.iter().map(|todo| todo.id.clone()).collect();
            if known_ids.len() != todos.len() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("duplicate task IDs in {relative_path}"),
                ));
            }
            let mut metadata = super::extract_document_metadata(&with_ids)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?
                .properties
                .get("flowix_todo_metadata")
                .and_then(serde_json::Value::as_object)
                .cloned()
                .unwrap_or_default();
            for attribute in &attributes {
                if !known_ids.contains(&attribute.todo_id) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!(
                            "legacy task {} is missing from {}",
                            attribute.todo_id, relative_path
                        ),
                    ));
                }
                let value = attribute.json_value();
                if let Some(existing) = metadata.get(&attribute.todo_id) {
                    if existing != &value {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            format!(
                                "task metadata conflict for {} in {}",
                                attribute.todo_id, relative_path
                            ),
                        ));
                    }
                } else {
                    metadata.insert(attribute.todo_id.clone(), value);
                }
            }
            let mut overrides = HashMap::new();
            overrides.insert(
                "flowix_todo_metadata".to_owned(),
                serde_json::Value::Object(metadata.clone()).to_string(),
            );
            let updated = super::merge_frontmatter(&with_ids, &overrides.into_iter().collect());
            let readback = super::extract_document_metadata(&updated)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
            if readback.properties.get("flowix_todo_metadata")
                != Some(&serde_json::Value::Object(metadata))
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("task metadata readback failed for {relative_path}"),
                ));
            }
            if updated != original {
                if fs::read_to_string(&path)? != original {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        format!("note changed during task metadata migration: {relative_path}"),
                    ));
                }
                super::atomic_write_bytes(&path, updated.as_bytes())?;
                report.notes_written += 1;
                report.tasks_written += attributes.len();
            }
        }
        conn.execute(
            "INSERT INTO note_index_meta (key, value) VALUES ('todo_metadata_migrated', '1') \
                      ON CONFLICT(key) DO UPDATE SET value='1'",
            [],
        )
        .map_err(io::Error::other)?;
        Ok(report)
    }

    /// Reconcile one notebook's Note projection with files on disk. Existing
    /// rows are checked by stat first and hashed only when their stat changes.
    /// This method intentionally does not touch the legacy memo tables.
    ///
    /// This passive/lazy path skips instead of blocking when another process is
    /// already reconciling the same notebook, so a background refresh never
    /// turns into a spurious 5s timeout error. The next read pass retries.
    pub fn reconcile_note_index(&self, notebook_id: &str) -> io::Result<NoteIndexReconcileReport> {
        self.reconcile_note_index_inner(notebook_id, false, true)
    }

    /// Hash every file, including entries whose size and mtime are unchanged.
    /// Use this for an occasional audit or after a suspected missed watcher event.
    ///
    /// Unlike [`Self::reconcile_note_index`], this explicit audit waits for the
    /// maintenance lock rather than skipping, so the caller can rely on a full
    /// pass having completed.
    pub fn verify_note_index(&self, notebook_id: &str) -> io::Result<NoteIndexReconcileReport> {
        self.reconcile_note_index_inner(notebook_id, true, false)
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
        self.reconcile_note_index_inner(notebook_id, false, false)
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
                        .map(|relative| !policy.is_index_ignored_at(&root, relative))
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
        let relative = Path::new(relative_path);
        let root = self
            .get_notebook_config_by_id(notebook_id)
            .map(|config| std::path::PathBuf::from(config.path))
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "notebook not found"))?;
        let policy = self.file_management_policy(notebook_id);
        if policy.is_index_ignored_at(&root, relative) || !is_markdown_note_path(relative) {
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
            notebook_id, &mut conn, &root, &path, true, false, &mut report,
        )
    }

    fn reconcile_note_index_inner(
        &self,
        notebook_id: &str,
        verify_hashes: bool,
        skip_if_busy: bool,
    ) -> io::Result<NoteIndexReconcileReport> {
        let _maintenance_guard = if skip_if_busy {
            let Some(guard) = self
                .operation_locks()
                .try_notebook_maintenance(notebook_id, "reconcile_note_index")?
            else {
                tracing::debug!(
                    notebook_id,
                    "note index reconcile skipped: another maintenance pass is in progress"
                );
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
        conn.execute(
            "INSERT INTO note_index_meta (key, value) VALUES ('build_state', 'building') \
                      ON CONFLICT(key) DO UPDATE SET value='building'",
            [],
        )
        .map_err(io::Error::other)?;
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
                            !policy.is_index_ignored_at(&root, relative)
                        })
                        .unwrap_or(false)
            })
        {
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
            if !seen.contains(&relative) {
                let candidate = notebook_path_from_relative(&root, &relative).map_err(io::Error::other)?;
                // The scan only nominates stale rows. A file may have appeared
                // after its directory was visited, so inspect it again under
                // the notebook lock and SQLite transaction.
                self.refresh_note_index_path_with_retry(
                    notebook_id, &mut conn, &root, &candidate, true, false, &mut report,
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
        report: &mut NoteIndexReconcileReport,
    ) -> io::Result<()> {
        conn.busy_timeout(Duration::ZERO).map_err(io::Error::other)?;
        let started = Instant::now();
        loop {
            let guard = self.operation_locks().notebook_read(notebook_id, "refresh_note_index_path")?;
            let mut attempt = NoteIndexReconcileReport::default();
            let result = Self::refresh_note_index_path(
                conn, root, path, verify_hashes, reparse_all, &mut attempt,
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
        if missing || policy.is_index_ignored_at(root, Path::new(&relative)) {
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
        let bytes = fs::read(path)?;
        let hash = format!("{:x}", Sha256::digest(&bytes));
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
        let content = String::from_utf8(bytes)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        let title = display_title_from_relative_path(&relative);
        let mut derived = Memo {
            id: String::new(),
            filename: relative.rsplit('/').next().unwrap_or(&relative).to_owned(),
            relative_path: relative.clone(),
            preview: String::new(),
            thumbnail: None,
            tags: Vec::new(),
            todos: Vec::new(),
            agents: Vec::new(),
            created_at: 0,
            updated_at: 0,
            favorited: false,
            icon: None,
            colors: Vec::new(),
            properties: serde_json::json!({}),
        };
        super::apply_derived_memo_fields(&mut derived, &content);
        tx.execute(
                "INSERT INTO notes (relative_path, size_bytes, modified_ns, content_hash, title, preview, thumbnail, properties_json, indexed_at, created_at, updated_at, favorited, icon, colors_json, filename, filename_lower) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16) \
                 ON CONFLICT(relative_path) DO UPDATE SET size_bytes=excluded.size_bytes, modified_ns=excluded.modified_ns, \
                 content_hash=excluded.content_hash, title=excluded.title, preview=excluded.preview, thumbnail=excluded.thumbnail, \
                 properties_json=excluded.properties_json, indexed_at=excluded.indexed_at, \
                 created_at=excluded.created_at, updated_at=excluded.updated_at, favorited=excluded.favorited, \
                 icon=excluded.icon, colors_json=excluded.colors_json, filename=excluded.filename, filename_lower=excluded.filename_lower",
                params![relative, size, modified_ns, hash, title, derived.preview, derived.thumbnail,
                    derived.properties.to_string(),
                    chrono::Utc::now().timestamp_millis(),
                    previous.as_ref().map(|(_, _, _, created)| *created).filter(|created| *created > 0)
                        .unwrap_or(file_created_ms),
                    modified_ns.unwrap_or(0) / 1_000_000,
                    i64::from(derived.favorited), derived.icon,
                     serde_json::to_string(&derived.colors).map_err(io::Error::other)?,
                     derived.filename, derived.filename.to_lowercase()],
            ).map_err(io::Error::other)?;
        tx.execute(
            "DELETE FROM note_tags WHERE relative_path = ?1",
            params![relative],
        )
        .map_err(io::Error::other)?;
        for tag in &derived.tags {
            tx.execute(
                "INSERT INTO note_tags (relative_path, tag) VALUES (?1, ?2)",
                params![relative, tag],
            )
            .map_err(io::Error::other)?;
        }
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
                super::extract_body_content(&content),
                derived.tags.join(" "),
                modified_ns.unwrap_or(0) / 1_000_000,
            ],
        )
        .map_err(io::Error::other)?;
        tx.execute(
            "DELETE FROM note_todos WHERE relative_path = ?1",
            params![relative],
        )
        .map_err(io::Error::other)?;
        for (position, todo) in derived.todos.iter().enumerate() {
            let attributes = derived
                .properties
                .get("flowix_todo_metadata")
                .and_then(|value| value.get(&todo.id));
            let string_field = |name| {
                attributes
                    .and_then(|value| value.get(name))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
            };
            let number_field = |name| {
                attributes
                    .and_then(|value| value.get(name))
                    .and_then(serde_json::Value::as_i64)
                    .unwrap_or(0)
            };
            tx.execute("INSERT INTO note_todos \
                    (relative_path, position, todo_id, content, status, priority, time_range, owner, assignee, created_at, updated_at) \
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    params![relative, position as i64, todo.id, todo.content, todo.status,
                        string_field("priority"), string_field("timeRange"), string_field("owner"),
                        string_field("assignee"), number_field("createdAt"), number_field("updatedAt")])
                    .map_err(io::Error::other)?;
        }
        tx.execute(
            "DELETE FROM note_agents WHERE relative_path = ?1",
            params![relative],
        )
        .map_err(io::Error::other)?;
        for (position, agent) in derived.agents.iter().enumerate() {
            tx.execute("INSERT INTO note_agents (relative_path, position, thread_id, title, agent_type) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![relative, position as i64, agent.thread_id, agent.title, agent.agent_type]).map_err(io::Error::other)?;
        }
        tx.commit().map_err(io::Error::other)?;
        if previous.is_some() {
            report.updated += 1;
        } else {
            report.added += 1;
        }
        Ok(())
    }

    pub(crate) fn open_note_index_connection(&self, notebook_id: &str) -> io::Result<Connection> {
        let path = self.notebook_db_path(notebook_id)?;
        let mut conn = Connection::open(path).map_err(io::Error::other)?;
        conn.busy_timeout(std::time::Duration::from_secs(10))
            .map_err(io::Error::other)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(io::Error::other)?;
        discard_legacy_v2_note_projection(&mut conn)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; \
            CREATE TABLE IF NOT EXISTS note_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); \
            CREATE TABLE IF NOT EXISTS notes (relative_path TEXT PRIMARY KEY, \
              size_bytes INTEGER NOT NULL, modified_ns INTEGER, content_hash TEXT NOT NULL, \
              title TEXT NOT NULL, preview TEXT NOT NULL, thumbnail TEXT, properties_json TEXT NOT NULL, indexed_at INTEGER NOT NULL, \
              created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, \
              favorited INTEGER NOT NULL DEFAULT 0, icon TEXT, colors_json TEXT NOT NULL DEFAULT '[]', \
              filename TEXT NOT NULL DEFAULT '', filename_lower TEXT NOT NULL DEFAULT ''); \
            CREATE TABLE IF NOT EXISTS note_tags (relative_path TEXT NOT NULL REFERENCES notes(relative_path) ON DELETE CASCADE, \
              tag TEXT NOT NULL, PRIMARY KEY(relative_path, tag)); \
            CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag); \
            CREATE INDEX IF NOT EXISTS idx_notes_created_page ON notes(favorited DESC, created_at DESC, relative_path DESC); \
            CREATE INDEX IF NOT EXISTS idx_notes_updated_page ON notes(favorited DESC, updated_at DESC, relative_path DESC); \
            CREATE TABLE IF NOT EXISTS note_todos (relative_path TEXT NOT NULL REFERENCES notes(relative_path) ON DELETE CASCADE, \
              position INTEGER NOT NULL, todo_id TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, \
              priority TEXT NOT NULL DEFAULT '', time_range TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL DEFAULT '', \
              assignee TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, \
              PRIMARY KEY(relative_path, position)); \
            CREATE TABLE IF NOT EXISTS note_agents (relative_path TEXT NOT NULL REFERENCES notes(relative_path) ON DELETE CASCADE, \
              position INTEGER NOT NULL, thread_id TEXT NOT NULL, title TEXT NOT NULL, agent_type TEXT NOT NULL, \
              PRIMARY KEY(relative_path, position)); \
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
        for (column, definition) in [
            ("priority", "TEXT NOT NULL DEFAULT ''"),
            ("time_range", "TEXT NOT NULL DEFAULT ''"),
            ("owner", "TEXT NOT NULL DEFAULT ''"),
            ("assignee", "TEXT NOT NULL DEFAULT ''"),
            ("created_at", "INTEGER NOT NULL DEFAULT 0"),
            ("updated_at", "INTEGER NOT NULL DEFAULT 0"),
        ] {
            let mut statement = conn
                .prepare("PRAGMA table_info(note_todos)")
                .map_err(io::Error::other)?;
            let names = statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(io::Error::other)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(io::Error::other)?;
            if !names.iter().any(|name| name == column) {
                conn.execute_batch(&format!(
                    "ALTER TABLE note_todos ADD COLUMN {column} {definition}"
                ))
                .map_err(io::Error::other)?;
            }
        }
        for (column, definition) in [
            ("thumbnail", "TEXT"),
            ("created_at", "INTEGER NOT NULL DEFAULT 0"),
            ("updated_at", "INTEGER NOT NULL DEFAULT 0"),
            ("favorited", "INTEGER NOT NULL DEFAULT 0"),
            ("icon", "TEXT"),
            ("colors_json", "TEXT NOT NULL DEFAULT '[]'"),
            ("filename", "TEXT NOT NULL DEFAULT ''"),
            ("filename_lower", "TEXT NOT NULL DEFAULT ''"),
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
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_notes_filename_page ON notes(favorited DESC, filename_lower ASC, filename ASC, relative_path ASC);")
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
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unsupported Note index schema version: {stored_version}"),
            ));
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
            CREATE TABLE memos (id TEXT PRIMARY KEY);
            INSERT INTO memos VALUES ('legacy-id');").unwrap();
        drop(conn);

        let conn = store.open_note_index_connection("nb_test").unwrap();
        let note: String = conn.query_row("SELECT relative_path FROM notes", [], |row| row.get(0)).unwrap();
        assert_eq!(note, "current.md");
        let legacy: String = conn.query_row("SELECT id FROM memos", [], |row| row.get(0)).unwrap();
        assert_eq!(legacy, "legacy-id");
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
        assert!(store
            .list_note_entries_with_legacy_ids("nb_test")
            .unwrap()
            .is_none());
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
                "SELECT COUNT(*) FROM note_tags WHERE tag = 'work'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tags, 1);
        drop(conn);
        assert_eq!(store.memo_counts_by_notebook().unwrap()["nb_test"], 1);
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
    fn legacy_revisions_backfill_into_the_path_keyed_table_once() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("Legacy.md"), "# Legacy\n").unwrap();
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
        // Register the file in the legacy id-keyed cache, then commit a
        // revision through the legacy API.
        let memo = store
            .register_existing_file_for_notebook_id("nb_test", &root.join("Legacy.md"))
            .map_err(|error| error.to_string())
            .unwrap();
        store
            .commit_memo_content_revision(&memo.id, "nb_test", "hash-legacy", "change-legacy")
            .unwrap();

        // First path-keyed read migrates the legacy row.
        let revision = store
            .read_note_content_revision_for_notebook("nb_test", "Legacy.md")
            .unwrap()
            .expect("legacy revision must be visible through the path key");
        assert_eq!(revision.revision, 1);
        assert_eq!(revision.change_id, "change-legacy");

        // A new path-keyed commit continues the same stream.
        let commit = store
            .commit_note_content_revision("nb_test", "Legacy.md", "hash-new", "change-new")
            .unwrap();
        assert!(commit.changed);
        assert_eq!(commit.state.revision, 2);
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
    fn note_projection_coexists_with_legacy_rows_in_the_same_notebook_db() {
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
        // Creation updates the Note projection immediately; the first full scan records the
        // parser version and reparses that row once.
        assert_eq!(store.reconcile_note_index("nb_test").unwrap().updated, 1);
        let conn = store.open_note_index_connection("nb_test").unwrap();
        let legacy_id: String = conn
            .query_row("SELECT id FROM memos", [], |row| row.get(0))
            .unwrap();
        assert_eq!(legacy_id, created.id);
        let note_path: String = conn
            .query_row("SELECT relative_path FROM notes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(note_path, created.relative_path);
        drop(conn);
        let conn = store.open_memo_index_db_for_notebook_id("nb_test").unwrap();
        conn.execute(
            "UPDATE memos SET preview='stale legacy preview' WHERE id=?1",
            params![created.id],
        )
        .unwrap();
        drop(conn);
        let listed = store
            .list_note_entries_with_legacy_ids("nb_test")
            .unwrap()
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_ne!(listed[0].preview, "stale legacy preview");
        assert_eq!(listed[0].id, created.id);
        let mut service = crate::service::NoteService::new(&store);
        let service_list = service.list("nb_test").unwrap();
        assert_ne!(service_list[0].preview, "stale legacy preview");
        store
            .write_memo(&created.id, "# Changed\nnew body\n")
            .unwrap();
        let conn = store.open_note_index_connection("nb_test").unwrap();
        let title: String = conn
            .query_row("SELECT title FROM notes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(title, "Legacy and Note");
        drop(conn);
        store.delete_memo_result_global(&created.id).unwrap();
        let conn = store.open_note_index_connection("nb_test").unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn legacy_task_attributes_survive_rebuilding_the_note_projection() {
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
            .create_memo("Tasks", "- [ ] keep this task\n", None)
            .unwrap();
        let conn = store.open_memo_index_db_for_notebook_id("nb_test").unwrap();
        conn.execute(
            "UPDATE memo_todos SET priority='high', owner='me', created_at=11 WHERE memo_id=?1",
            params![created.id],
        )
        .unwrap();
        drop(conn);

        let report = store
            .migrate_note_todo_metadata_for_notebook("nb_test")
            .unwrap();
        assert_eq!(report.notes_written, 1);
        assert_eq!(report.tasks_written, 1);
        assert_eq!(
            store
                .migrate_note_todo_metadata_for_notebook("nb_test")
                .unwrap()
                .notes_written,
            0
        );
        let content = fs::read_to_string(root.join(&created.relative_path)).unwrap();
        assert!(content.contains("flowix_todo_metadata:"));
        store.reconcile_note_index("nb_test").unwrap();
        let path_tasks = store.read_note_path_todos("nb_test", "createdAt").unwrap();
        assert_eq!(path_tasks.len(), 1);
        assert_eq!(path_tasks[0].relative_path, created.relative_path);
        assert_eq!(path_tasks[0].priority, "high");
        let conn = store.open_note_index_connection("nb_test").unwrap();
        let (priority, owner, created_at): (String, String, i64) = conn
            .query_row(
                "SELECT priority, owner, created_at FROM note_todos",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        let tasks = store
            .read_todo_metadata_entries_for_notebook_id(Some("nb_test"), "createdAt")
            .unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].memo_id, created.id);
        assert_eq!(tasks[0].priority, "high");
        assert_eq!(
            (priority.as_str(), owner.as_str(), created_at),
            ("high", "me", 11)
        );
        conn.execute("DELETE FROM notes", []).unwrap();
        drop(conn);
        store.reconcile_note_index("nb_test").unwrap();
        let conn = store.open_note_index_connection("nb_test").unwrap();
        let priority: String = conn
            .query_row("SELECT priority FROM note_todos", [], |row| row.get(0))
            .unwrap();
        assert_eq!(priority, "high");
    }

    #[test]
    fn legacy_note_properties_survive_rebuilding_and_file_values_win() {
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
            .create_memo(
                "Properties",
                "---\nflowix_icon: file-icon\n---\n# Properties\n",
                None,
            )
            .unwrap();
        let conn = store.open_memo_index_db_for_notebook_id("nb_test").unwrap();
        conn.execute(
            "UPDATE memos SET created_at=123, favorited=1, icon='index-icon' WHERE id=?1",
            params![created.id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memo_colors (memo_id,color,position) VALUES (?1,'blue',0)",
            params![created.id],
        )
        .unwrap();
        drop(conn);
        let report = store
            .migrate_note_properties_for_notebook("nb_test")
            .unwrap();
        assert_eq!(report.notes_written, 1);
        let content = fs::read_to_string(root.join(&created.relative_path)).unwrap();
        let properties = super::super::extract_document_metadata(&content)
            .unwrap()
            .properties;
        assert!(properties.get("flowix_created_at").is_none());
        assert_eq!(properties["flowix_favorited"], true);
        assert_eq!(properties["flowix_icon"], "file-icon");
        assert_eq!(properties["flowix_colors"], serde_json::json!(["blue"]));
        assert_eq!(
            store
                .migrate_note_properties_for_notebook("nb_test")
                .unwrap()
                .notes_written,
            0
        );
        store.reconcile_note_index("nb_test").unwrap();
        let conn = store.open_note_index_connection("nb_test").unwrap();
        let (created_at, icon): (i64, String) = conn
            .query_row("SELECT created_at, icon FROM notes", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!((created_at, icon.as_str()), (123, "file-icon"));
    }

    #[test]
    fn legacy_creation_time_stays_in_index_without_changing_markdown() {
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
        let created = store.create_memo("Plain", "# Plain\n", None).unwrap();
        let path = root.join(&created.relative_path);
        let original = fs::read(&path).unwrap();
        let conn = store.open_memo_index_db_for_notebook_id("nb_test").unwrap();
        conn.execute(
            "UPDATE memos SET created_at=123 WHERE id=?1",
            params![created.id],
        )
        .unwrap();
        drop(conn);

        let report = store
            .migrate_note_properties_for_notebook("nb_test")
            .unwrap();
        assert_eq!(report.notes_written, 0);
        assert_eq!(fs::read(&path).unwrap(), original);
        let conn = store.open_note_index_connection("nb_test").unwrap();
        let created_at: i64 = conn
            .query_row("SELECT created_at FROM notes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(created_at, 123);
    }
}
