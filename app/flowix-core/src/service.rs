//! Application service boundary shared by desktop, CLI, MCP, and future transports.
//!
//! `MemoFile` remains the shared storage façade. `NoteService` is the public
//! path-keyed Note API; `MemoService` retains Memo-ID compatibility use cases.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::memo_file::{
    base_filename, normalize_search_tag_filter, notebook_path_from_relative,
    resolve_filename_conflict, FileLockIntent, FileWriteGuard, Memo, MemoColor, MemoFile, MemoIndexEntry, MemoTodoEntry,
    NoteEntry, NoteSearchHit, NoteWriteOutcome, NotebookConfig,
};

const MAX_SEARCH_LIMIT: usize = 200;
const DEFAULT_LIST_PAGE_SIZE: usize = 50;
const MAX_LIST_PAGE_SIZE: usize = 100;
const MAX_LIST_CURSOR_BYTES: usize = 4096;

pub struct MemoSaveReceipt {
    pub edited: EditedMemo,
    pub content: String,
    pub notebook_id: String,
    pub commit: Option<crate::memo_file::NoteContentRevision>,
}

type TagUsageSummary = (Vec<String>, Vec<(String, usize)>, usize, usize, usize);

/// Opaque-to-transport cursor for a memo list query. The query identity is
/// included so a cursor cannot accidentally be reused after changing notebook,
/// filter, tag, color, or sort.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct MemoListCursor {
    notebook_id: Option<String>,
    filter: String,
    sort: String,
    tag_id: Option<String>,
    color: Option<String>,
    favorited: bool,
    sort_value: i64,
    #[serde(default)]
    sort_text: Option<String>,
    #[serde(default)]
    sort_tiebreaker: Option<String>,
    id: String,
}

/// Opaque cursor for the path-keyed notebook list. The path, rather than a
/// legacy memo id, is the stable tie breaker for every ordering.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct NoteListCursor {
    notebook_id: String,
    filter: String,
    sort: String,
    tag_id: Option<String>,
    color: Option<String>,
    favorited: bool,
    sort_value: i64,
    sort_text: Option<String>,
    sort_tiebreaker: Option<String>,
    relative_path: String,
}

#[derive(Debug, Clone)]
pub struct MemoPage {
    pub memos: Vec<Memo>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Clone)]
pub struct NotePage {
    pub notes: Vec<NoteEntry>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Error)]
pub enum FlowixError {
    #[error("{0}")]
    InvalidInput(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    PermissionDenied(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    CorruptData(String),
    #[error("{0}")]
    Internal(String),
}

#[derive(Debug, Clone)]
pub struct ResolvedMemo {
    pub id: String,
    pub entry: MemoIndexEntry,
    pub notebook: NotebookConfig,
    pub path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct MemoDocument {
    pub entry: MemoIndexEntry,
    pub notebook: NotebookConfig,
    pub path: PathBuf,
    pub body: String,
}

#[derive(Debug, Clone)]
pub struct NoteDocument {
    pub entry: NoteEntry,
    pub notebook: NotebookConfig,
    pub path: PathBuf,
    pub body: String,
}

#[derive(Debug, Clone)]
pub enum NoteSaveOutcome {
    Saved(NoteDocument),
    Conflict { disk_content: String },
}

#[derive(Debug, Clone)]
pub struct CreatedMemo {
    pub memo: Memo,
    pub notebook: NotebookConfig,
    pub path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct EditedMemo {
    pub id: String,
    pub memo: Option<Memo>,
    pub path: PathBuf,
    pub old_bytes: usize,
    pub new_bytes: usize,
    pub dry_run: bool,
}

#[derive(Debug, Clone)]
pub struct DeletedMemo {
    pub id: String,
    pub path: PathBuf,
    pub file_removed: bool,
}

/// Path-identified Note use cases. This service does not resolve or retain
/// Memo IDs; the path projection and Markdown file are its only identities.
pub struct NoteService<'a> {
    memo_file: &'a MemoFile,
}

impl<'a> NoteService<'a> {
    pub fn new(memo_file: &'a MemoFile) -> Self {
        Self { memo_file }
    }

    fn resolve_notebook(&self, key: &str) -> Result<NotebookConfig, FlowixError> {
        self.memo_file
            .read_notebook_configs()?
            .into_iter()
            .find(|config| config.id == key || config.name == key)
            .ok_or_else(|| FlowixError::NotFound(format!("notebook `{key}` not found")))
    }

    fn path_note_entry(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> Result<NoteEntry, FlowixError> {
        match self
            .memo_file
            .read_note_entry_by_path(notebook_id, relative_path)
        {
            Ok(Some(entry)) => Ok(entry),
            Ok(None) | Err(_) => self
                .memo_file
                .derive_note_entry_from_disk(notebook_id, relative_path)
                .map_err(FlowixError::Io),
        }
    }
}

/// Compatibility use-case facade over one `MemoFile` instance.
///
/// The service borrows the store instead of owning it, so Desktop can construct it from
/// its managed `MemoFile` while CLI/MCP can construct it from a short-lived instance.
/// Public path-identified Note operations belong to `NoteService`; this facade
/// keeps Memo-ID lookups and legacy command use cases.
pub struct MemoService<'a> {
    memo_file: &'a MemoFile,
}

impl<'a> MemoService<'a> {
    pub fn new(memo_file: &'a MemoFile) -> Self {
        Self { memo_file }
    }

    fn lock_resolved_memo(&self, resolved: &ResolvedMemo, operation: &str) -> Result<FileWriteGuard, FlowixError> {
        let guard = self.memo_file.operation_locks().file_write(
            &resolved.notebook.id,
            Path::new(&resolved.notebook.path),
            &resolved.path,
            FileLockIntent::Existing,
            operation,
        )?;
        let current = self.memo_file.get_notebook_config_by_id(&resolved.notebook.id)
            .ok_or_else(|| FlowixError::Conflict("notebook was removed while waiting for the file lock".into()))?;
        if std::fs::canonicalize(&current.path)? != std::fs::canonicalize(&resolved.notebook.path)? {
            return Err(FlowixError::Conflict("notebook root changed while waiting for the file lock".into()));
        }
        Ok(guard)
    }

    pub fn list_notebooks(&mut self) -> Result<Vec<NotebookConfig>, FlowixError> {
        self.memo_file
            .read_notebook_configs()
            .map_err(FlowixError::Io)
    }

    pub fn notebook_note_counts(
        &mut self,
        configs: &[NotebookConfig],
    ) -> Result<HashMap<String, usize>, FlowixError> {
        let mut counts = self.memo_file.memo_counts_by_notebook()?;
        let notebook_ids = configs
            .iter()
            .map(|config| config.id.as_str())
            .collect::<HashSet<_>>();
        counts.retain(|notebook_id, _| notebook_ids.contains(notebook_id.as_str()));
        for config in configs {
            counts.entry(config.id.clone()).or_insert(0);
        }
        Ok(counts)
    }

    pub fn list_memos(&mut self, notebook_key: &str) -> Result<Vec<MemoIndexEntry>, FlowixError> {
        let notebook = self.resolve_notebook(notebook_key)?;
        let mut entries = match self
            .memo_file
            .list_note_entries_with_legacy_ids(&notebook.id)?
        {
            Some(entries) => entries,
            None => {
                self.memo_file
                    .read_index_for_notebook_id(Some(&notebook.id))?
                    .unwrap_or_default()
                    .memos
            }
        };
        let policy = self.memo_file.file_management_policy(&notebook.id);
        entries.retain(|entry| {
            let relative_path = if entry.relative_path.is_empty() {
                &entry.filename
            } else {
                &entry.relative_path
            };
            !policy.is_index_ignored_at(Path::new(&notebook.path), Path::new(relative_path))
        });
        Ok(entries)
    }
}

impl NoteService<'_> {
    /// List notes by notebook-relative path, without legacy memo identities.
    pub(crate) fn list_notes_by_path(
        &mut self,
        notebook_key: &str,
    ) -> Result<Vec<NoteEntry>, FlowixError> {
        let notebook = self.resolve_notebook(notebook_key)?;
        match self.memo_file.read_note_entries(&notebook.id) {
            Ok(entries) => Ok(entries),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                // The unpaged list is used by plugin-filtered views. Give it
                // the same cold-index recovery as the paginated list path.
                self.memo_file.reconcile_note_index(&notebook.id)?;
                Ok(self.memo_file.read_note_entries(&notebook.id)?)
            }
            Err(error) => Err(FlowixError::Io(error)),
        }
    }

    /// Query a page directly from the rebuildable path index. This deliberately
    /// does not read or validate the legacy `memos` table.
    pub(crate) fn list_notes_by_path_page(
        &mut self,
        notebook_key: &str,
        filter: &str,
        sort: &str,
        tag_id: Option<&str>,
        color: Option<&str>,
        cursor: Option<&str>,
        requested_limit: Option<usize>,
    ) -> Result<NotePage, FlowixError> {
        let notebook = self.resolve_notebook(notebook_key)?;
        let limit = requested_limit
            .unwrap_or(DEFAULT_LIST_PAGE_SIZE)
            .clamp(1, MAX_LIST_PAGE_SIZE);
        let normalized_color = color.map(str::to_string);
        if let Some(value) = normalized_color.as_deref() {
            match value {
                "any" | "none" | "red" | "orange" | "yellow" | "green" | "cyan" | "blue"
                | "gray" => {}
                _ => {
                    return Err(FlowixError::InvalidInput(format!(
                        "unsupported note color filter `{value}`"
                    )))
                }
            }
        }

        let now = chrono::Utc::now().timestamp_millis();
        let week_start = crate::memo_file::time::start_of_this_week(now);
        let month_start = crate::memo_file::time::start_of_this_month(now);
        {
            let parsed_cursor = cursor
                .map(|value| {
                    if value.len() > MAX_LIST_CURSOR_BYTES {
                        return Err(FlowixError::InvalidInput(
                            "note list cursor is too large".into(),
                        ));
                    }
                    serde_json::from_str::<NoteListCursor>(value).map_err(|error| {
                        FlowixError::InvalidInput(format!("invalid path note cursor: {error}"))
                    })
                })
                .transpose()?;
            if let Some(page_cursor) = parsed_cursor.as_ref() {
                if page_cursor.notebook_id != notebook.id
                    || page_cursor.filter != filter
                    || page_cursor.sort != sort
                    || page_cursor.tag_id.as_deref() != tag_id
                    || page_cursor.color != normalized_color
                {
                    return Err(FlowixError::InvalidInput(
                        "path note cursor does not match the current query".into(),
                    ));
                }
            }
            let page = self.memo_file.read_note_page(
                &notebook.id,
                filter,
                tag_id,
                normalized_color.as_deref(),
                sort,
                now,
                week_start,
                month_start,
                parsed_cursor.as_ref().map(|cursor| {
                    (
                        cursor.favorited,
                        cursor.sort_value,
                        cursor.sort_text.as_deref(),
                        cursor.sort_tiebreaker.as_deref(),
                        cursor.relative_path.as_str(),
                    )
                }),
                limit + 1,
            );
            let mut notes = match page {
                Ok(notes) => notes,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    self.memo_file.reconcile_note_index(&notebook.id)?;
                    self.memo_file.read_note_page(
                        &notebook.id,
                        filter,
                        tag_id,
                        normalized_color.as_deref(),
                        sort,
                        now,
                        week_start,
                        month_start,
                        parsed_cursor.as_ref().map(|cursor| {
                            (
                                cursor.favorited,
                                cursor.sort_value,
                                cursor.sort_text.as_deref(),
                                cursor.sort_tiebreaker.as_deref(),
                                cursor.relative_path.as_str(),
                            )
                        }),
                        limit + 1,
                    )?
                }
                Err(error) => return Err(FlowixError::Io(error)),
            };
            let has_more = notes.len() > limit;
            notes.truncate(limit);
            let next_cursor = if has_more {
                notes.last().map(|note| {
                    serde_json::to_string(&NoteListCursor {
                        notebook_id: notebook.id.clone(),
                        filter: filter.into(),
                        sort: sort.into(),
                        tag_id: tag_id.map(str::to_string),
                        color: normalized_color.clone(),
                        favorited: note.favorited,
                        sort_value: note_sort_value(note, sort),
                        sort_text: note_sort_text(note, sort),
                        sort_tiebreaker: note_sort_tiebreaker(note, sort),
                        relative_path: note.relative_path.clone(),
                    })
                    .expect("path note cursor serialization cannot fail")
                })
            } else {
                None
            };
            return Ok(NotePage {
                notes,
                next_cursor,
                has_more,
            });
        }
    }

    pub(crate) fn create_note_by_path(
        &mut self,
        notebook_key: &str,
        parent_relative_path: Option<&str>,
        title: &str,
        content: &str,
    ) -> Result<NoteDocument, FlowixError> {
        let notebook = self.resolve_notebook(notebook_key)?;
        let relative_path = self.memo_file.create_note_by_path(
            &notebook.id,
            parent_relative_path,
            title,
            content,
        )?;
        let entry = self.path_note_entry(&notebook.id, &relative_path)?;
        let path = notebook_path_from_relative(&PathBuf::from(&notebook.path), &relative_path)
            .map_err(FlowixError::InvalidInput)?;
        let body = std::fs::read_to_string(&path)?;
        Ok(NoteDocument {
            entry,
            notebook,
            path,
            body,
        })
    }

    /// Open a Markdown note by notebook and relative path, with no memo ID lookup.
    pub(crate) fn get_note_by_path(
        &mut self,
        notebook_key: &str,
        relative_path: &str,
    ) -> Result<NoteDocument, FlowixError> {
        let notebook = self.resolve_notebook(notebook_key)?;
        let entry = self.path_note_entry(&notebook.id, relative_path)?;
        let path =
            notebook_path_from_relative(&PathBuf::from(&notebook.path), &entry.relative_path)
                .map_err(FlowixError::InvalidInput)?;
        let body = std::fs::read_to_string(&path)?;
        Ok(NoteDocument {
            entry,
            notebook,
            path,
            body,
        })
    }

    pub(crate) fn save_note_by_path(
        &mut self,
        notebook_key: &str,
        relative_path: &str,
        content: &str,
        expected_content: Option<&str>,
    ) -> Result<NoteSaveOutcome, FlowixError> {
        let notebook = self.resolve_notebook(notebook_key)?;
        match self.memo_file.write_note_by_path(
            &notebook.id,
            relative_path,
            content,
            expected_content,
        )? {
            NoteWriteOutcome::Conflict { disk_content } => {
                Ok(NoteSaveOutcome::Conflict { disk_content })
            }
            NoteWriteOutcome::Saved { content } => {
                let entry = self.path_note_entry(&notebook.id, relative_path)?;
                let path = notebook_path_from_relative(
                    &PathBuf::from(&notebook.path),
                    &entry.relative_path,
                )
                .map_err(FlowixError::InvalidInput)?;
                Ok(NoteSaveOutcome::Saved(NoteDocument {
                    entry,
                    notebook,
                    path,
                    body: content,
                }))
            }
        }
    }

    pub(crate) fn rename_note_by_path(
        &mut self,
        notebook_key: &str,
        relative_path: &str,
        new_title: &str,
        expected_content: Option<&str>,
    ) -> Result<NoteDocument, FlowixError> {
        let notebook = self.resolve_notebook(notebook_key)?;
        let new_relative_path = self.memo_file.rename_note_by_path(
            &notebook.id,
            relative_path,
            new_title,
            expected_content,
        )?;
        let entry = self.path_note_entry(&notebook.id, &new_relative_path)?;
        let path = notebook_path_from_relative(&PathBuf::from(&notebook.path), &new_relative_path)
            .map_err(FlowixError::InvalidInput)?;
        let body = std::fs::read_to_string(&path)?;
        Ok(NoteDocument {
            entry,
            notebook,
            path,
            body,
        })
    }

    pub(crate) fn move_note_by_path(
        &mut self,
        notebook_key: &str,
        relative_path: &str,
        parent_relative_path: &str,
    ) -> Result<NoteDocument, FlowixError> {
        let notebook = self.resolve_notebook(notebook_key)?;
        let new_relative_path =
            self.memo_file
                .move_note_by_path(&notebook.id, relative_path, parent_relative_path)?;
        let entry = self.path_note_entry(&notebook.id, &new_relative_path)?;
        let path = notebook_path_from_relative(&PathBuf::from(&notebook.path), &new_relative_path)
            .map_err(FlowixError::InvalidInput)?;
        let body = std::fs::read_to_string(&path)?;
        Ok(NoteDocument {
            entry,
            notebook,
            path,
            body,
        })
    }

    pub(crate) fn delete_note_by_path(
        &mut self,
        notebook_key: &str,
        relative_path: &str,
    ) -> Result<bool, FlowixError> {
        let notebook = self.resolve_notebook(notebook_key)?;
        Ok(self
            .memo_file
            .delete_note_by_path(&notebook.id, relative_path)?)
    }
}

impl MemoService<'_> {
    pub fn list_memos_filtered(
        &mut self,
        notebook_id: Option<&str>,
        filter: &str,
        sort: &str,
        tag_id: Option<&str>,
    ) -> Vec<Memo> {
        self.memo_file
            .read_all_memos_filtered_for_notebook_id(notebook_id, filter, sort, tag_id)
    }

    /// Return one stable page from a memo query.
    ///
    /// The current index implementation still scans the local metadata index
    /// to apply the existing filters, but only the requested page crosses the
    /// transport boundary. This is intentionally layered on top of the
    /// existing list query so filtering and ordering semantics stay identical.
    pub fn list_memos_filtered_page(
        &mut self,
        notebook_id: Option<&str>,
        filter: &str,
        sort: &str,
        tag_id: Option<&str>,
        color: Option<&str>,
        cursor: Option<&str>,
        requested_limit: Option<usize>,
    ) -> Result<MemoPage, FlowixError> {
        let limit = requested_limit
            .unwrap_or(DEFAULT_LIST_PAGE_SIZE)
            .clamp(1, MAX_LIST_PAGE_SIZE);
        let normalized_color = color.map(str::to_string);
        if let Some(value) = normalized_color.as_deref() {
            match value {
                "any" | "none" | "red" | "orange" | "yellow" | "green" | "cyan" | "blue"
                | "gray" => {}
                _ => {
                    return Err(FlowixError::InvalidInput(format!(
                        "unsupported memo color filter `{value}`"
                    )))
                }
            }
        }

        let mut all = self.list_memos_filtered(notebook_id, filter, sort, tag_id);
        if let Some(color) = normalized_color.as_deref() {
            all.retain(|memo| match color {
                "any" => !memo.colors.is_empty(),
                "none" => memo.colors.is_empty(),
                value => memo
                    .colors
                    .iter()
                    .any(|memo_color| memo_color_name(*memo_color) == value),
            });
        }

        let parsed_cursor = cursor
            .map(|value| {
                if value.len() > MAX_LIST_CURSOR_BYTES {
                    return Err(FlowixError::InvalidInput(
                        "memo list cursor is too large".to_string(),
                    ));
                }
                serde_json::from_str::<MemoListCursor>(value)
                    .map_err(|_| FlowixError::InvalidInput("invalid memo list cursor".to_string()))
            })
            .transpose()?;
        if let Some(ref page_cursor) = parsed_cursor {
            if page_cursor.notebook_id.as_deref() != notebook_id
                || page_cursor.filter != filter
                || page_cursor.sort != sort
                || page_cursor.tag_id.as_deref() != tag_id
                || page_cursor.color != normalized_color
            {
                return Err(FlowixError::InvalidInput(
                    "memo list cursor does not match the current query".to_string(),
                ));
            }
        }

        let start = parsed_cursor
            .as_ref()
            .map(|page_cursor| {
                all.iter()
                    .position(|memo| memo_is_after_cursor(memo, page_cursor, sort))
                    .unwrap_or(all.len())
            })
            .unwrap_or(0);
        let end = start.saturating_add(limit).min(all.len());
        let memos = all[start..end].to_vec();
        let has_more = end < all.len();
        let next_cursor = if has_more {
            memos.last().map(|memo| {
                serde_json::to_string(&MemoListCursor {
                    notebook_id: notebook_id.map(str::to_string),
                    filter: filter.to_string(),
                    sort: sort.to_string(),
                    tag_id: tag_id.map(str::to_string),
                    color: normalized_color.clone(),
                    favorited: memo.favorited,
                    sort_value: memo_sort_value(memo, sort),
                    sort_text: memo_sort_text(memo, sort),
                    sort_tiebreaker: memo_sort_tiebreaker(memo, sort),
                    id: memo.id.clone(),
                })
                .expect("memo list cursor serialization cannot fail")
            })
        } else {
            None
        };

        Ok(MemoPage {
            memos,
            next_cursor,
            has_more,
        })
    }

    pub fn list_all_memos(&mut self, notebook_id: Option<&str>) -> Vec<Memo> {
        self.memo_file.read_all_memos_for_notebook_id(notebook_id)
    }

    pub fn memo_metadata(&mut self, id_or_filename: &str) -> Result<Memo, FlowixError> {
        let resolved = self.resolve_memo(id_or_filename)?;
        Ok(MemoFile::index_entry_to_memo(&resolved.entry))
    }

    pub fn get_memo(&mut self, id_or_filename: &str) -> Result<MemoDocument, FlowixError> {
        let resolved = self.resolve_memo(id_or_filename)?;
        let body = std::fs::read_to_string(&resolved.path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                FlowixError::NotFound(format!(
                    "note `{}` is indexed but its Markdown file is missing",
                    resolved.id
                ))
            } else {
                FlowixError::Io(error)
            }
        })?;
        Ok(MemoDocument {
            entry: resolved.entry,
            notebook: resolved.notebook,
            path: resolved.path,
            body,
        })
    }

    pub fn create_memo_named_with_tag_in_directory(
        &mut self,
        notebook_key: Option<&str>,
        parent_relative_path: Option<&str>,
        title: &str,
        body: &str,
        tag: Option<&str>,
    ) -> Result<CreatedMemo, FlowixError> {
        let _write_guard = self.memo_file.acquire_cross_process_write_lock()?;
        let notebook = match notebook_key {
            Some(key) => Some(self.resolve_notebook(key)?),
            None => None,
        };
        let memo = if let Some(notebook) = notebook.as_ref() {
            match parent_relative_path.filter(|path| !path.is_empty()) {
                Some(parent) => self.memo_file.create_memo_for_notebook_id_in_directory(
                    &notebook.id,
                    parent,
                    title,
                    body,
                    tag,
                ),
                None => self
                    .memo_file
                    .create_memo_for_notebook_id(&notebook.id, title, body, tag),
            }
        } else {
            if parent_relative_path.is_some_and(|path| !path.is_empty()) {
                return Err(FlowixError::InvalidInput(
                    "a parent directory requires an explicit notebook".into(),
                ));
            }
            self.memo_file.create_memo(title, body, tag)
        }
        .map_err(FlowixError::Io)?;
        // Explicit notebook creation already resolved the target config, and the
        // storage operation returns the memo it just persisted. Avoid a global
        // cross-notebook id lookup here: a missed/stale catalog lookup used to
        // report failure after both the Markdown file and its local index row
        // had already been created.
        let notebook = match notebook {
            Some(notebook) => notebook,
            None => {
                self.memo_file
                    .resolve_memo_location(&memo.id)?
                    .ok_or_else(|| {
                        FlowixError::Internal(format!(
                            "created note `{}` could not be resolved from the index",
                            memo.id
                        ))
                    })?
                    .notebook
            }
        };
        let path = notebook_path_from_relative(&PathBuf::from(&notebook.path), &memo.relative_path)
            .unwrap_or_else(|_| PathBuf::from(&notebook.path).join(&memo.filename));
        Ok(CreatedMemo {
            memo,
            notebook,
            path,
        })
    }

    pub fn move_memo_to_directory(
        &mut self,
        id_or_path: &str,
        notebook_key: &str,
        parent_relative_path: &str,
    ) -> Result<EditedMemo, FlowixError> {
        self.move_memo_to_directory_checked(id_or_path, notebook_key, parent_relative_path, None)
    }

    pub fn move_memo_to_directory_checked(
        &mut self,
        id_or_path: &str,
        notebook_key: &str,
        parent_relative_path: &str,
        expected_cache_id: Option<&str>,
    ) -> Result<EditedMemo, FlowixError> {
        let _write_guard = self.memo_file.acquire_cross_process_write_lock()?;
        let resolved = self.resolve_memo(id_or_path)?;
        if expected_cache_id.is_some_and(|expected| expected != resolved.id) {
            return Err(FlowixError::Conflict(
                "document at path was replaced".into(),
            ));
        }
        let notebook = self.resolve_notebook(notebook_key)?;
        if resolved.notebook.id != notebook.id {
            return Err(FlowixError::Conflict(
                "memo does not belong to the selected notebook".into(),
            ));
        }
        let (memo, _old_path, path) = self
            .memo_file
            .move_memo_to_directory_for_notebook_id(
                &notebook.id,
                &resolved.id,
                parent_relative_path,
            )
            .map_err(FlowixError::InvalidInput)?;
        Ok(EditedMemo {
            id: resolved.id,
            memo: Some(memo),
            path,
            old_bytes: 0,
            new_bytes: 0,
            dry_run: false,
        })
    }

    /// Resolve the path that the next named create is expected to use. Desktop uses
    /// this immediately before creation to suppress its own filesystem watcher event.
    pub fn preview_create_path(
        &mut self,
        notebook_key: Option<&str>,
        title: &str,
    ) -> Result<PathBuf, FlowixError> {
        self.preview_create_path_in_directory(notebook_key, None, title)
    }

    pub fn preview_create_path_in_directory(
        &mut self,
        notebook_key: Option<&str>,
        parent_relative_path: Option<&str>,
        title: &str,
    ) -> Result<PathBuf, FlowixError> {
        let (base, notebook_id) = if let Some(key) = notebook_key {
            let notebook = self.resolve_notebook(key)?;
            (PathBuf::from(notebook.path), notebook.id)
        } else {
            (
                self.memo_file.get_memo_base(),
                self.memo_file.current_notebook_id_for_index(),
            )
        };
        let create_base = match parent_relative_path.filter(|path| !path.is_empty()) {
            Some(relative) => {
                notebook_path_from_relative(&base, relative).map_err(FlowixError::InvalidInput)?
            }
            None => base,
        };
        let candidate = base_filename(title);
        let occupied = self.memo_file.occupied_filenames_in_directory(
            &notebook_id,
            parent_relative_path.filter(|path| !path.is_empty()),
        )?;
        Ok(create_base.join(resolve_filename_conflict(
            &create_base,
            &candidate,
            &occupied,
        )))
    }

    pub fn edit_memo_exact(
        &mut self,
        id_or_filename: &str,
        old: &str,
        new: &str,
        dry_run: bool,
    ) -> Result<EditedMemo, FlowixError> {
        if old.is_empty() {
            return Err(FlowixError::InvalidInput(
                "edit: old_string cannot be empty".into(),
            ));
        }
        let resolved = self.resolve_memo(id_or_filename)?;
        let _file_guard = self.lock_resolved_memo(&resolved, "edit_memo_exact")?;
        let locked = self.resolve_memo(id_or_filename)?;
        if locked.id != resolved.id || locked.path != resolved.path {
            return Err(FlowixError::Conflict("document moved while waiting for the file lock".into()));
        }
        let current = std::fs::read_to_string(&resolved.path)?;
        let matches = current.matches(old).count();
        if matches == 0 {
            return Err(FlowixError::Conflict(format!(
                "edit: old_string not found in `{}` (whitespace, indentation, and line endings must match)",
                resolved.id
            )));
        }
        if matches > 1 {
            return Err(FlowixError::Conflict(format!(
                "edit: old_string matched {matches} times in `{}`; provide more surrounding context to make it unique",
                resolved.id
            )));
        }

        if dry_run {
            return Ok(EditedMemo {
                id: resolved.id,
                memo: None,
                path: resolved.path,
                old_bytes: old.len(),
                new_bytes: new.len(),
                dry_run: true,
            });
        }

        let body = current.replacen(old, new, 1);
        let memo = self
            .memo_file
            .write_memo_preserving_filename_under_file_lock(&resolved.id, &body, &_file_guard)?;
        let path = notebook_path_from_relative(
            &PathBuf::from(&resolved.notebook.path),
            &memo.relative_path,
        )
        .unwrap_or_else(|_| PathBuf::from(&resolved.notebook.path).join(&memo.filename));
        Ok(EditedMemo {
            id: resolved.id,
            memo: Some(memo),
            path,
            old_bytes: old.len(),
            new_bytes: new.len(),
            dry_run: false,
        })
    }

    pub fn replace_memo(
        &mut self,
        id_or_filename: &str,
        body: &str,
    ) -> Result<EditedMemo, FlowixError> {
        if body.trim().is_empty() {
            return Err(FlowixError::InvalidInput(
                "empty body, note not modified".into(),
            ));
        }
        self.save_memo(id_or_filename, body)
    }

    /// Save Desktop editor content, including an intentionally empty document.
    pub fn save_memo(
        &mut self,
        id_or_filename: &str,
        body: &str,
    ) -> Result<EditedMemo, FlowixError> {
        self.save_memo_with_validation(id_or_filename, body, |_, _| Ok(()))
    }

    pub fn save_memo_with_validation(
        &mut self,
        id_or_filename: &str,
        body: &str,
        validate: impl FnOnce(&ResolvedMemo, &str) -> Result<(), FlowixError>,
    ) -> Result<EditedMemo, FlowixError> {
        self.save_memo_with_snapshot(id_or_filename, body, validate)
            .map(|(edited, _)| edited)
    }

    pub fn save_memo_with_snapshot(
        &mut self,
        id_or_filename: &str,
        body: &str,
        validate: impl FnOnce(&ResolvedMemo, &str) -> Result<(), FlowixError>,
    ) -> Result<(EditedMemo, String), FlowixError> {
        self.save_memo_with_receipt(id_or_filename, body, validate)
            .map(|receipt| (receipt.edited, receipt.content))
    }

    pub fn save_memo_with_receipt(
        &mut self,
        id_or_filename: &str,
        body: &str,
        validate: impl FnOnce(&ResolvedMemo, &str) -> Result<(), FlowixError>,
    ) -> Result<MemoSaveReceipt, FlowixError> {
        use sha2::{Digest, Sha256};
        let resolved = self.resolve_memo(id_or_filename)?;
        let _file_guard = self.lock_resolved_memo(&resolved, "save_memo_with_receipt")?;
        let locked = self.resolve_memo(id_or_filename)?;
        if locked.id != resolved.id || locked.path != resolved.path {
            return Err(FlowixError::Conflict("document moved while waiting for the file lock".into()));
        }
        let current = std::fs::read_to_string(&resolved.path)?;
        validate(&resolved, &current)?;
        let old_bytes = current.len();
        let memo = self
            .memo_file
            .write_memo_preserving_filename_under_file_lock(&resolved.id, body, &_file_guard)?;
        let path = notebook_path_from_relative(
            &PathBuf::from(&resolved.notebook.path),
            &memo.relative_path,
        )
        .unwrap_or_else(|_| PathBuf::from(&resolved.notebook.path).join(&memo.filename));
        let content = std::fs::read_to_string(&path)?;
        let content_hash = format!("{:x}", Sha256::digest(content.as_bytes()));
        let commit = match self.memo_file.commit_note_content_revision(
            &resolved.notebook.id,
            &memo.relative_path,
            &content_hash,
            &uuid::Uuid::new_v4().to_string(),
        ) {
            Ok(commit) => Some(commit.state),
            Err(error) => {
                tracing::warn!("Memo saved but revision persistence failed: {error}");
                None
            }
        };
        Ok(MemoSaveReceipt {
            edited: EditedMemo {
                id: resolved.id,
                memo: Some(memo),
                path,
                old_bytes,
                new_bytes: content.len(),
                dry_run: false,
            },
            content,
            notebook_id: resolved.notebook.id,
            commit,
        })
    }

    pub fn save_memo_preserving_filename(
        &mut self,
        id_or_filename: &str,
        body: &str,
    ) -> Result<EditedMemo, FlowixError> {
        let resolved = self.resolve_memo(id_or_filename)?;
        let _file_guard = self.lock_resolved_memo(&resolved, "save_memo_preserving_filename")?;
        let locked = self.resolve_memo(id_or_filename)?;
        if locked.id != resolved.id || locked.path != resolved.path {
            return Err(FlowixError::Conflict("document moved while waiting for the file lock".into()));
        }
        let old_bytes = std::fs::metadata(&resolved.path)
            .map(|metadata| metadata.len() as usize)
            .unwrap_or(0);
        let memo = self
            .memo_file
            .write_memo_preserving_filename_under_file_lock(&resolved.id, body, &_file_guard)?;
        let path = notebook_path_from_relative(
            &PathBuf::from(&resolved.notebook.path),
            &memo.relative_path,
        )
        .unwrap_or_else(|_| PathBuf::from(&resolved.notebook.path).join(&memo.filename));
        Ok(EditedMemo {
            id: resolved.id,
            memo: Some(memo),
            path,
            old_bytes,
            new_bytes: body.len(),
            dry_run: false,
        })
    }

    pub fn rename_memo(
        &mut self,
        id_or_filename: &str,
        new_title: &str,
    ) -> Result<EditedMemo, FlowixError> {
        self.rename_memo_with_validation(id_or_filename, new_title, |_| Ok(()))
    }

    pub fn rename_memo_with_validation(
        &mut self,
        id_or_filename: &str,
        new_title: &str,
        validate: impl FnOnce(&ResolvedMemo) -> Result<(), FlowixError>,
    ) -> Result<EditedMemo, FlowixError> {
        let _write_guard = self.memo_file.acquire_cross_process_write_lock()?;
        let resolved = self.resolve_memo(id_or_filename)?;
        validate(&resolved)?;
        let memo = self.memo_file.rename_memo(&resolved.id, new_title)?;
        let path = notebook_path_from_relative(
            &PathBuf::from(&resolved.notebook.path),
            &memo.relative_path,
        )
        .unwrap_or_else(|_| PathBuf::from(&resolved.notebook.path).join(&memo.filename));
        Ok(EditedMemo {
            id: resolved.id,
            memo: Some(memo),
            path,
            old_bytes: 0,
            new_bytes: 0,
            dry_run: false,
        })
    }

    pub fn sync_memo_metadata(&mut self, memo: &Memo) -> Result<(), FlowixError> {
        let _write_guard = self.memo_file.acquire_cross_process_write_lock()?;
        self.memo_file.sync_metadata_only_global(memo)?;
        Ok(())
    }

    pub fn delete_memo(&mut self, id_or_filename: &str) -> Result<DeletedMemo, FlowixError> {
        self.delete_memo_checked(id_or_filename, None)
    }

    pub fn delete_memo_checked(
        &mut self,
        id_or_filename: &str,
        expected_cache_id: Option<&str>,
    ) -> Result<DeletedMemo, FlowixError> {
        let _write_guard = self.memo_file.acquire_cross_process_write_lock()?;
        let resolved = self.resolve_memo(id_or_filename)?;
        if expected_cache_id.is_some_and(|expected| expected != resolved.id) {
            return Err(FlowixError::Conflict(
                "document at path was replaced".into(),
            ));
        }
        let file_removed = self.memo_file.delete_memo_result_global(&resolved.id)?;
        Ok(DeletedMemo {
            id: resolved.id,
            path: resolved.path,
            file_removed,
        })
    }

    pub fn tag_usage_summary(
        &mut self,
        notebook_id: Option<&str>,
    ) -> Result<TagUsageSummary, FlowixError> {
        self.memo_file
            .read_tag_usage_summary_for_notebook_id(notebook_id)
            .map_err(FlowixError::Io)
    }

    pub fn todo_metadata(
        &mut self,
        notebook_id: Option<&str>,
        sort: &str,
    ) -> Result<Vec<MemoTodoEntry>, FlowixError> {
        self.memo_file
            .read_todo_metadata_entries_for_notebook_id(notebook_id, sort)
            .map_err(FlowixError::Io)
    }

    pub fn resolve_notebook(&mut self, key: &str) -> Result<NotebookConfig, FlowixError> {
        let notebooks = self.list_notebooks()?;
        notebooks
            .iter()
            .find(|config| config.id == key)
            .or_else(|| notebooks.iter().find(|config| config.name == key))
            .cloned()
            .ok_or_else(|| FlowixError::NotFound(format!("notebook `{key}` not found")))
    }

    pub fn resolve_memo(&mut self, id_or_filename: &str) -> Result<ResolvedMemo, FlowixError> {
        let requested = PathBuf::from(id_or_filename);
        if requested.is_absolute() {
            // Indexed ghosts have no file to canonicalize. Preserve exact path
            // lookup so they can be removed without consulting a memo ID.
            let requested = if requested.exists() {
                dunce::canonicalize(&requested)?
            } else {
                requested
            };
            for notebook in self.list_notebooks()? {
                let base = PathBuf::from(&notebook.path);
                let canonical_base = if requested.exists() {
                    dunce::canonicalize(&base).unwrap_or(base.clone())
                } else {
                    base.clone()
                };
                let Ok(relative) =
                    crate::memo_file::notebook_relative_path(&canonical_base, &requested)
                else {
                    continue;
                };
                let list = self
                    .memo_file
                    .read_index_for_notebook_id(Some(&notebook.id))?
                    .unwrap_or_default();
                if let Some(entry) = list
                    .memos
                    .into_iter()
                    .find(|entry| entry.relative_path == relative)
                {
                    return Ok(ResolvedMemo {
                        id: entry.id.clone(),
                        entry,
                        notebook,
                        path: requested,
                    });
                }
            }
            return Err(FlowixError::NotFound(format!(
                "indexed note path {id_or_filename} not found"
            )));
        }
        if let Some(location) = self.memo_file.resolve_memo_location(id_or_filename)? {
            let path = notebook_path_from_relative(
                &PathBuf::from(&location.notebook.path),
                &location.memo.relative_path,
            )
            .unwrap_or_else(|_| {
                PathBuf::from(&location.notebook.path).join(&location.memo.filename)
            });
            return Ok(ResolvedMemo {
                id: location.memo.id.clone(),
                entry: location.memo,
                notebook: location.notebook,
                path,
            });
        }

        let wanted = if id_or_filename.ends_with(".md") {
            id_or_filename.to_string()
        } else {
            format!("{id_or_filename}.md")
        };
        for notebook in self.list_notebooks()? {
            let list = self
                .memo_file
                .read_index_for_notebook_id(Some(&notebook.id))?
                .unwrap_or_default();
            if let Some(entry) = list
                .memos
                .into_iter()
                .find(|entry| entry.relative_path == wanted || entry.filename == wanted)
            {
                let path = notebook_path_from_relative(
                    &PathBuf::from(&notebook.path),
                    &entry.relative_path,
                )
                .unwrap_or_else(|_| PathBuf::from(&notebook.path).join(&entry.filename));
                return Ok(ResolvedMemo {
                    id: entry.id.clone(),
                    entry,
                    notebook,
                    path,
                });
            }
        }
        Err(FlowixError::NotFound(format!(
            "note `{id_or_filename}` not found"
        )))
    }

    /// A title request may carry the path from before another view renamed
    /// this memo. Recover only when its stable memo ID and expected filename
    /// still identify the current indexed entry.
    pub fn resolve_memo_for_title_rename(
        &mut self,
        requested_path: &str,
        expected_id: Option<&str>,
        expected_filename: Option<&str>,
    ) -> Result<ResolvedMemo, FlowixError> {
        let resolved = match self.resolve_memo(requested_path) {
            Ok(resolved) => resolved,
            Err(FlowixError::NotFound(_))
                if expected_id.is_some() && expected_filename.is_some() =>
            {
                self.resolve_memo(expected_id.unwrap())?
            }
            Err(error) => return Err(error),
        };
        if expected_id.is_some_and(|id| id != resolved.id) {
            return Err(FlowixError::Conflict(
                "document at path was replaced".into(),
            ));
        }
        if expected_filename.is_some_and(|name| name != resolved.entry.filename) {
            return Err(FlowixError::Conflict(
                "memo filename changed before rename".into(),
            ));
        }
        Ok(resolved)
    }
}

impl<'a> NoteService<'a> {
    pub fn list(&mut self, notebook: &str) -> Result<Vec<NoteEntry>, FlowixError> {
        self.list_notes_by_path(notebook)
    }

    pub fn list_page(
        &mut self,
        notebook: &str,
        filter: &str,
        sort: &str,
        tag_id: Option<&str>,
        color: Option<&str>,
        cursor: Option<&str>,
        limit: Option<usize>,
    ) -> Result<NotePage, FlowixError> {
        self.list_notes_by_path_page(notebook, filter, sort, tag_id, color, cursor, limit)
    }

    pub fn search(
        &mut self,
        notebook: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<NoteSearchHit>, FlowixError> {
        self.search_with_tag_filter(notebook, query, None, limit)
    }

    pub fn search_with_tag_filter(
        &mut self,
        notebook: &str,
        query: &str,
        tag_filter: Option<&str>,
        limit: usize,
    ) -> Result<Vec<NoteSearchHit>, FlowixError> {
        let notebook = self.resolve_notebook(notebook)?;
        Ok(self
            .memo_file
            .search_notes_with_tag_filter(&notebook.id, query, tag_filter, limit)?)
    }

    pub fn create(
        &mut self,
        notebook: &str,
        parent: Option<&str>,
        title: &str,
        content: &str,
    ) -> Result<NoteDocument, FlowixError> {
        self.create_note_by_path(notebook, parent, title, content)
    }

    pub fn get(
        &mut self,
        notebook: &str,
        relative_path: &str,
    ) -> Result<NoteDocument, FlowixError> {
        self.get_note_by_path(notebook, relative_path)
    }

    pub fn save(
        &mut self,
        notebook: &str,
        relative_path: &str,
        content: &str,
        expected_content: Option<&str>,
    ) -> Result<NoteSaveOutcome, FlowixError> {
        self.save_note_by_path(notebook, relative_path, content, expected_content)
    }

    pub fn rename(
        &mut self,
        notebook: &str,
        relative_path: &str,
        title: &str,
        expected_content: Option<&str>,
    ) -> Result<NoteDocument, FlowixError> {
        self.rename_note_by_path(notebook, relative_path, title, expected_content)
    }

    pub fn move_to(
        &mut self,
        notebook: &str,
        relative_path: &str,
        parent: &str,
    ) -> Result<NoteDocument, FlowixError> {
        self.move_note_by_path(notebook, relative_path, parent)
    }

    pub fn delete(&mut self, notebook: &str, relative_path: &str) -> Result<bool, FlowixError> {
        self.delete_note_by_path(notebook, relative_path)
    }

    pub fn delete_checked(&mut self, notebook: &str, relative_path: &str, expected_content: &str) -> Result<bool, FlowixError> {
        let notebook = self.resolve_notebook(notebook)?;
        match self.memo_file.delete_note_by_path_checked(&notebook.id, relative_path, Some(expected_content)) {
            Ok(removed) => Ok(removed),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                Err(FlowixError::Conflict("note changed before delete".into()))
            }
            Err(error) => Err(FlowixError::Io(error)),
        }
    }
}

fn memo_sort_value(memo: &Memo, sort: &str) -> i64 {
    if sort == "updatedAt" {
        memo.updated_at
    } else {
        memo.created_at
    }
}

fn memo_sort_text(memo: &Memo, sort: &str) -> Option<String> {
    match sort {
        "filenameAsc" | "filenameDesc" => Some(memo.filename.to_lowercase()),
        _ => None,
    }
}

fn memo_sort_tiebreaker(memo: &Memo, sort: &str) -> Option<String> {
    match sort {
        "filenameAsc" | "filenameDesc" => Some(memo.filename.clone()),
        _ => None,
    }
}

fn memo_color_name(color: MemoColor) -> &'static str {
    match color {
        MemoColor::Red => "red",
        MemoColor::Orange => "orange",
        MemoColor::Yellow => "yellow",
        MemoColor::Green => "green",
        MemoColor::Cyan => "cyan",
        MemoColor::Blue => "blue",
        MemoColor::Gray => "gray",
    }
}

fn memo_is_after_cursor(memo: &Memo, cursor: &MemoListCursor, sort: &str) -> bool {
    if memo.favorited != cursor.favorited {
        return memo.favorited < cursor.favorited;
    }

    if sort == "filenameAsc" || sort == "filenameDesc" {
        let memo_key = memo.filename.to_lowercase();
        let cursor_key = cursor.sort_text.as_deref().unwrap_or_default();
        let filename_order = memo_key
            .as_str()
            .cmp(cursor_key)
            .then_with(|| {
                memo.filename
                    .as_str()
                    .cmp(cursor.sort_tiebreaker.as_deref().unwrap_or_default())
            })
            .then_with(|| memo.id.as_str().cmp(cursor.id.as_str()));
        return if sort == "filenameDesc" {
            filename_order == Ordering::Less
        } else {
            filename_order == Ordering::Greater
        };
    }

    // The date list is sorted descending, so a lower key is later.
    memo_sort_value(memo, sort) < cursor.sort_value
        || (memo_sort_value(memo, sort) == cursor.sort_value && memo.id < cursor.id)
}

fn path_note_filename(relative_path: &str) -> &str {
    relative_path.rsplit('/').next().unwrap_or(relative_path)
}

fn note_sort_value(note: &NoteEntry, sort: &str) -> i64 {
    if sort == "updatedAt" {
        note.updated_at
    } else {
        note.created_at
    }
}

fn note_sort_text(note: &NoteEntry, sort: &str) -> Option<String> {
    matches!(sort, "filenameAsc" | "filenameDesc")
        .then(|| path_note_filename(&note.relative_path).to_lowercase())
}

fn note_sort_tiebreaker(note: &NoteEntry, sort: &str) -> Option<String> {
    matches!(sort, "filenameAsc" | "filenameDesc")
        .then(|| path_note_filename(&note.relative_path).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service_fixture() -> (tempfile::TempDir, MemoFile) {
        let temp = tempfile::tempdir().unwrap();
        let notebook_path = temp.path().join("notes");
        std::fs::create_dir_all(&notebook_path).unwrap();
        let memo_file = MemoFile::new(temp.path().join("config"));
        memo_file
            .write_notebook_configs(&[NotebookConfig {
                id: "work".into(),
                name: "Work Notes".into(),
                icon: None,
                path: format!("{}/", notebook_path.display()),
                is_default: true,
                sort: 0,
                created_at: 1,
                updated_at: 1,
            }])
            .unwrap();
        (temp, memo_file)
    }

    #[test]
    fn path_note_pages_do_not_require_legacy_memo_projection() {
        let (_temp, store) = service_fixture();
        let mut service = NoteService::new(&store);
        for title in ["Gamma", "Alpha", "Beta"] {
            service
                .create_note_by_path(
                    "work",
                    None,
                    title,
                    &format!("---\ntags: [project/work]\n---\n# {title}\nBody\n"),
                )
                .unwrap();
        }
        // Path creation does not write any memo-ID projection.
        assert!(store
            .list_note_entries_with_legacy_ids("work")
            .unwrap()
            .is_none());
        assert_eq!(
            store.read_note_entries("work").unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock,
            "the first list request must exercise the initial-index fallback"
        );

        // The first path-list request builds the Note index if startup's
        // background reconciliation has not completed yet.
        let first = service
            .list_notes_by_path_page(
                "work",
                "tagged",
                "filenameAsc",
                Some("project"),
                None,
                None,
                Some(2),
            )
            .unwrap();
        assert_eq!(
            first
                .notes
                .iter()
                .map(|note| path_note_filename(&note.relative_path))
                .collect::<Vec<_>>(),
            ["Alpha.md", "Beta.md"]
        );
        assert!(first.has_more);

        let second = service
            .list_notes_by_path_page(
                "work",
                "tagged",
                "filenameAsc",
                Some("project"),
                None,
                first.next_cursor.as_deref(),
                Some(2),
            )
            .unwrap();
        assert_eq!(second.notes.len(), 1);
        assert_eq!(
            path_note_filename(&second.notes[0].relative_path),
            "Gamma.md"
        );
        assert!(!second.has_more);
        assert!(second.next_cursor.is_none());
    }

    #[test]
    fn path_note_list_builds_index_when_not_ready() {
        let (_temp, store) = service_fixture();
        let mut service = NoteService::new(&store);
        service
            .create_note_by_path("work", None, "Cold start", "# Cold start\nBody\n")
            .unwrap();

        assert_eq!(
            store.read_note_entries("work").unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock,
            "the test must exercise an index that has not completed its initial scan"
        );

        let entries = service.list("work").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].relative_path, "Cold start.md");
        assert_eq!(entries[0].title, "Cold start");
        assert!(store.note_index_is_ready("work").unwrap());

        // Once built, subsequent list calls read the projection without
        // needing another recovery pass.
        assert_eq!(service.list("work").unwrap().len(), 1);
    }

    #[test]
    fn checked_path_delete_rejects_content_changed_since_read() {
        let (_temp, store) = service_fixture();
        let mut service = NoteService::new(&store);
        let created = service.create("work", None, "Delete conflict", "original").unwrap();
        std::fs::write(&created.path, "concurrent edit").unwrap();
        assert!(matches!(
            service.delete_checked("work", &created.entry.relative_path, "original"),
            Err(FlowixError::Conflict(_))
        ));
        assert_eq!(std::fs::read_to_string(&created.path).unwrap(), "concurrent edit");
    }

    #[test]
    fn date_sorted_path_pages_use_stable_database_cursor() {
        let (_temp, store) = service_fixture();
        let mut service = NoteService::new(&store);
        for title in ["Gamma", "Alpha", "Beta"] {
            service
                .create_note_by_path("work", None, title, &format!("# {title}\n"))
                .unwrap();
        }
        let first = service
            .list_notes_by_path_page("work", "all", "updatedAt", None, None, None, Some(2))
            .unwrap();
        assert_eq!(first.notes.len(), 2);
        assert!(first.has_more);
        let second = service
            .list_notes_by_path_page(
                "work",
                "all",
                "updatedAt",
                None,
                None,
                first.next_cursor.as_deref(),
                Some(2),
            )
            .unwrap();
        assert_eq!(second.notes.len(), 1);
        assert!(!second.has_more);
        let mut paths = first
            .notes
            .into_iter()
            .chain(second.notes)
            .map(|note| note.relative_path)
            .collect::<Vec<_>>();
        paths.sort();
        assert_eq!(paths, ["Alpha.md", "Beta.md", "Gamma.md"]);
    }

    #[test]
    fn path_delete_guards_replacement_and_removes_missing_index_entry() {
        let (_temp, store) = service_fixture();
        let mut service = MemoService::new(&store);
        let created = service.create_memo_named_with_tag_in_directory(Some("work"), None, "Untitled", "# Plain\n", None).unwrap();
        let path = created.path.to_string_lossy().into_owned();
        assert!(service
            .delete_memo_checked(&path, Some("anotherid"))
            .is_err());
        assert!(created.path.exists());
        std::fs::remove_file(&created.path).unwrap();
        assert!(
            service
                .delete_memo_checked(&path, Some(&created.memo.id))
                .unwrap()
                .file_removed
        );
        assert!(service.resolve_memo(&path).is_err());
    }

    #[test]
    fn path_save_and_rename_need_no_frontmatter_identity() {
        let (_temp, store) = service_fixture();
        let mut service = MemoService::new(&store);
        let created = service.create_memo_named_with_tag_in_directory(Some("work"), None, "Untitled", "# Plain\nbody\n", None).unwrap();
        assert_eq!(
            std::fs::read_to_string(&created.path).unwrap(),
            "# Plain\nbody\n"
        );
        let old = created.path.to_string_lossy().into_owned();
        let renamed = service.rename_memo(&old, "Renamed").unwrap();
        assert!(!created.path.exists());
        assert!(service.save_memo(&old, "stale overwrite").is_err());
        assert!(!created.path.exists(), "stale path must never be recreated");
        let content = "---\nflowix_colors: [blue]\n---\n# Plain\nupdated\n";
        service
            .save_memo(&renamed.path.to_string_lossy(), content)
            .unwrap();
        assert_eq!(std::fs::read_to_string(&renamed.path).unwrap(), content);
        let memo = store.read_memo_global(&created.memo.id).unwrap();
        assert_eq!(memo.colors.len(), 1);
        assert_eq!(memo.relative_path, "Renamed.md");
    }

    #[test]
    fn title_rename_recovers_a_stale_path_only_with_matching_id_and_filename() {
        let (_temp, store) = service_fixture();
        let mut service = MemoService::new(&store);
        let created = service.create_memo_named_with_tag_in_directory(Some("work"), None, "Untitled", "# Plain\n", None).unwrap();
        let original = created.path.to_string_lossy().into_owned();
        let id = created.memo.id;
        let renamed = service.rename_memo(&original, "Second").unwrap();
        let renamed_filename = renamed.memo.as_ref().unwrap().filename.clone();
        let current = service
            .resolve_memo_for_title_rename(&original, Some(&id), Some(&renamed_filename))
            .unwrap();
        assert_eq!(current.id, id);
        assert_eq!(current.path, renamed.path);
        let third = service
            .rename_memo_with_validation(&current.id, "Third", |_| Ok(()))
            .unwrap();
        assert!(third.path.exists());
        assert!(!renamed.path.exists());
        assert!(service
            .resolve_memo_for_title_rename(&original, Some(&id), Some("Second.md"))
            .is_err());
        assert!(service
            .resolve_memo_for_title_rename(&original, Some("wrong-id"), Some("Third.md"))
            .is_err());
        assert!(service
            .resolve_memo_for_title_rename(&original, None, None)
            .is_err());
        std::fs::write(&original, "# Replacement\n").unwrap();
        let replacement = store
            .register_existing_file_for_notebook_id("work", &PathBuf::from(&original))
            .unwrap();
        assert_ne!(replacement.id, id);
        assert!(service
            .resolve_memo_for_title_rename(&original, Some(&id), Some("Third.md"))
            .is_err());
    }

    #[test]
    fn directory_move_rebases_all_children_without_touching_markdown() {
        let (temp, store) = service_fixture();
        let base = temp.path().join("notes");
        let source = base.join("docs");
        std::fs::create_dir_all(source.join("nested")).unwrap();
        let content = "---\nflowix_colors: [green]\n---\n# Body\n";
        let file = source.join("nested/One.md");
        std::fs::write(&file, content).unwrap();
        let original = store
            .register_existing_file_for_notebook_id("work", &file)
            .unwrap();
        let target = base.join("manual");
        let changes = store.rename_indexed_path(&source, &target).unwrap();
        assert_eq!(changes.len(), 1);
        let memo = store.read_memo_global(&original.id).unwrap();
        assert_eq!(memo.relative_path, "manual/nested/One.md");
        assert_eq!(
            std::fs::read_to_string(target.join("nested/One.md")).unwrap(),
            content
        );
        assert!(MemoService::new(&store)
            .save_memo(&file.to_string_lossy(), "stale")
            .is_err());
        assert!(!source.exists());
    }

    #[test]
    fn path_resolution_never_falls_back_to_same_filename() {
        let (temp, store) = service_fixture();
        let mut service = MemoService::new(&store);
        service.create_memo_named_with_tag_in_directory(Some("work"), None, "Untitled", "# Same\noriginal", None).unwrap();
        let other = temp.path().join("outside/Same.md");
        std::fs::create_dir_all(other.parent().unwrap()).unwrap();
        std::fs::write(&other, "other").unwrap();
        assert!(service
            .save_memo(&other.to_string_lossy(), "wrong")
            .is_err());
        assert_eq!(std::fs::read_to_string(other).unwrap(), "other");
    }

    #[test]
    fn save_snapshot_does_not_change_when_a_later_writer_saves() {
        let (_directory, store) = service_fixture();
        let mut service = MemoService::new(&store);
        let created = service.create_memo_named_with_tag_in_directory(Some("work"), None, "Untitled", "# Note\noriginal\n", None).unwrap();
        let (edited, snapshot) = service
            .save_memo_with_snapshot(&created.memo.id, "# Note\nfirst\n", |_, _| Ok(()))
            .unwrap();
        service
            .save_memo(&created.memo.id, "# Note\nsecond\n")
            .unwrap();
        assert!(snapshot.ends_with("# Note\nfirst\n"));
        assert!(std::fs::read_to_string(edited.path)
            .unwrap()
            .ends_with("# Note\nsecond\n"));
    }

    #[test]
    fn save_receipt_binds_revision_version_and_content_before_the_next_writer() {
        use sha2::{Digest, Sha256};
        let (_directory, store) = service_fixture();
        let mut service = MemoService::new(&store);
        let created = service.create_memo_named_with_tag_in_directory(Some("work"), None, "Untitled", "# Note\noriginal\n", None).unwrap();
        let first = service
            .save_memo_with_receipt(&created.memo.id, "# Note\nfirst\n", |_, _| Ok(()))
            .unwrap();
        let first_commit = first.commit.unwrap();
        let second = service
            .save_memo_with_receipt(&created.memo.id, "# Note\nsecond\n", |_, _| Ok(()))
            .unwrap();
        let second_commit = second.commit.unwrap();
        assert_eq!(
            first_commit.content_hash,
            format!("{:x}", Sha256::digest(first.content.as_bytes()))
        );
        assert_eq!(
            second_commit.content_hash,
            format!("{:x}", Sha256::digest(second.content.as_bytes()))
        );
        assert!(second_commit.revision > first_commit.revision);
        assert_ne!(first_commit.change_id, second_commit.change_id);
        assert_eq!(first.notebook_id, "work");
    }

    #[test]
    fn rejected_save_preserves_file_name_content_and_index() {
        let (_temp, memo_file) = service_fixture();
        let mut service = MemoService::new(&memo_file);
        let created = service
            .create_memo_named_with_tag_in_directory(Some("work"), None, "Untitled", "# Original\n\nimportant\n", None)
            .unwrap();
        let original = std::fs::read_to_string(&created.path).unwrap();
        let before = service.get_memo(&created.memo.id).unwrap();
        let result = service.save_memo_with_validation(
            &created.memo.id,
            "# Renamed\n\nreplacement\n",
            |_, _| Err(FlowixError::Conflict("stale snapshot".to_string())),
        );
        assert!(matches!(result, Err(FlowixError::Conflict(_))));
        assert_eq!(std::fs::read_to_string(&created.path).unwrap(), original);
        let after = service.get_memo(&created.memo.id).unwrap();
        assert_eq!(after.entry.filename, before.entry.filename);
        assert_eq!(after.entry.updated_at, before.entry.updated_at);
        assert!(!created.path.parent().unwrap().join("Renamed.md").exists());
    }

    #[test]
    fn validation_holds_the_file_lock_and_allows_another_file() {
        let (temp, memo_file) = service_fixture();
        let mut service = MemoService::new(&memo_file);
        let created = service.create_memo_named_with_tag_in_directory(Some("work"), None, "Untitled", "# Note\nold\n", None).unwrap();
        let other = service.create_memo_named_with_tag_in_directory(Some("work"), None, "Untitled", "# Other\nold\n", None).unwrap();
        let lock_path = temp.path().join("config/.memo-write.lock");
        let result = service
            .save_memo_with_validation(&created.memo.id, "# Note\nnew\n", |_, current| {
                assert!(current.contains("old"));
                let probe = std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&lock_path)
                    .unwrap();
                assert!(fs2::FileExt::try_lock_exclusive(&probe).is_err());
                let _other_guard = memo_file.operation_locks().file_write(
                    "work", other.path.parent().unwrap(), &other.path,
                    crate::memo_file::FileLockIntent::Existing, "other_file_probe",
                ).unwrap();
                Ok(())
            })
            .unwrap();
        assert!(std::fs::read_to_string(result.path)
            .unwrap()
            .contains("new"));
    }

    #[test]
    fn concurrent_memo_saves_with_one_expected_snapshot_have_one_winner() {
        use std::sync::{Arc, Barrier};
        let (temp, memo_file) = service_fixture();
        let created = MemoService::new(&memo_file)
            .create_memo_named_with_tag_in_directory(Some("work"), None, "Untitled", "# Note\nold\n", None)
            .unwrap();
        let expected = std::fs::read_to_string(&created.path).unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let workers: Vec<_> = ["# Note\nfirst\n", "# Note\nsecond\n"]
            .into_iter()
            .map(|content| {
                let store = MemoFile::new(temp.path().join("config"));
                let id = created.memo.id.clone();
                let expected = expected.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    (
                        MemoService::new(&store).save_memo_with_validation(
                            &id,
                            content,
                            |_, current| {
                                if current != expected {
                                    return Err(FlowixError::Conflict("stale snapshot".into()));
                                }
                                Ok(())
                            },
                        ),
                        content,
                    )
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(
            results.iter().filter(|(result, _)| result.is_ok()).count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|(result, _)| matches!(result, Err(FlowixError::Conflict(_))))
                .count(),
            1
        );
        let winner = results.iter().find(|(result, _)| result.is_ok()).unwrap().1;
        let stored = std::fs::read_to_string(&created.path).unwrap();
        assert!(stored.ends_with(winner));
    }

    #[test]
    fn service_covers_memo_lifecycle_and_filename_resolution() {
        let (_temp, memo_file) = service_fixture();
        let mut service = MemoService::new(&memo_file);
        let created = service
            .create_memo_named_with_tag_in_directory(Some("Work Notes"), None, "Untitled", "# Service note\n\nold text\n", None)
            .unwrap();
        assert!(created.path.exists());

        let document = service.get_memo(&created.memo.id).unwrap();
        assert_eq!(document.entry.id, created.memo.id);
        assert!(document.body.contains("old text"));

        let edited = service
            .edit_memo_exact(&created.memo.id, "old text", "new text", false)
            .unwrap();
        assert!(!edited.dry_run);
        assert!(service
            .get_memo(&created.memo.id)
            .unwrap()
            .body
            .contains("new text"));

        let deleted = service.delete_memo(&created.memo.id).unwrap();
        assert!(deleted.file_removed);
        assert!(!deleted.path.exists());
    }

    #[test]
    fn create_memo_keeps_filename_independent_from_markdown_first_line() {
        let (_temp, memo_file) = service_fixture();
        let mut service = MemoService::new(&memo_file);
        let created = service
            .create_memo_named_with_tag_in_directory(Some("work"), None, "Untitled", "# Body heading\n\ncontent", None)
            .unwrap();

        assert!(created.memo.filename.starts_with("Untitled"));
        assert!(!created.memo.filename.starts_with("Body heading"));
        assert!(service
            .get_memo(&created.memo.id)
            .unwrap()
            .body
            .contains("# Body heading"));
    }

    #[test]
    fn creates_memo_in_existing_notebook_subdirectory() {
        let (temp, memo_file) = service_fixture();
        std::fs::create_dir_all(temp.path().join("notes/projects/alpha")).unwrap();
        let mut service = MemoService::new(&memo_file);

        let created = service
            .create_memo_named_with_tag_in_directory(
                Some("work"),
                Some("projects/alpha"),
                "Nested",
                "",
                None,
            )
            .unwrap();

        assert_eq!(created.memo.relative_path, "projects/alpha/Nested.md");
        assert_eq!(
            created.path,
            temp.path().join("notes/projects/alpha/Nested.md")
        );
        assert!(created.path.is_file());
        assert_eq!(
            service
                .resolve_memo(&created.memo.id)
                .unwrap()
                .entry
                .relative_path,
            "projects/alpha/Nested.md"
        );
    }

    #[test]
    fn rejects_create_parent_outside_notebook() {
        let (_temp, memo_file) = service_fixture();
        let mut service = MemoService::new(&memo_file);

        let error = service
            .create_memo_named_with_tag_in_directory(
                Some("work"),
                Some("../outside"),
                "Escaped",
                "",
                None,
            )
            .unwrap_err();

        assert!(matches!(error, FlowixError::Io(ref source)
            if source.kind() == std::io::ErrorKind::InvalidInput));
    }

    #[test]
    fn moves_memo_to_directory_and_updates_index_path() {
        let (temp, memo_file) = service_fixture();
        std::fs::create_dir_all(temp.path().join("notes/projects")).unwrap();
        let mut service = MemoService::new(&memo_file);
        let created = service.create_memo_named_with_tag_in_directory(Some("work"), None, "Untitled", "# Move me\n", None).unwrap();
        let old_path = created.path.clone();

        let moved = service
            .move_memo_to_directory(&created.memo.id, "work", "projects")
            .unwrap();

        assert_eq!(moved.path, temp.path().join("notes/projects/Untitled.md"));
        assert!(!old_path.exists());
        assert!(moved.path.exists());
        assert_eq!(moved.memo.unwrap().relative_path, "projects/Untitled.md");
    }

    #[test]
    fn memo_pages_are_stable_and_do_not_repeat_items() {
        let (_temp, memo_file) = service_fixture();
        let mut service = MemoService::new(&memo_file);
        for index in 0..5 {
            service
                .create_memo_named_with_tag_in_directory(Some("work"), None, "Untitled", &format!("# Page note {index}\n"), None)
                .unwrap();
        }

        let first = service
            .list_memos_filtered_page(Some("work"), "all", "createdAt", None, None, None, Some(2))
            .unwrap();
        assert_eq!(first.memos.len(), 2);
        assert!(first.has_more);
        let second = service
            .list_memos_filtered_page(
                Some("work"),
                "all",
                "createdAt",
                None,
                None,
                first.next_cursor.as_deref(),
                Some(2),
            )
            .unwrap();
        assert_eq!(second.memos.len(), 2);
        assert!(second.has_more);
        assert!(first
            .memos
            .iter()
            .all(|memo| !second.memos.iter().any(|next| next.id == memo.id)));

        let third = service
            .list_memos_filtered_page(
                Some("work"),
                "all",
                "createdAt",
                None,
                None,
                second.next_cursor.as_deref(),
                Some(2),
            )
            .unwrap();
        assert_eq!(third.memos.len(), 1);
        assert!(!third.has_more);
        assert!(third.next_cursor.is_none());
    }

    #[test]
    fn memo_pages_sort_by_filename_in_both_directions() {
        let (_temp, memo_file) = service_fixture();
        let mut service = MemoService::new(&memo_file);
        service
            .create_memo_named_with_tag_in_directory(Some("work"), None, "Zulu", "# Zulu\n", None)
            .unwrap();
        service
            .create_memo_named_with_tag_in_directory(Some("work"), None, "alpha", "# alpha\n", None)
            .unwrap();
        service
            .create_memo_named_with_tag_in_directory(Some("work"), None, "middle", "# middle\n", None)
            .unwrap();

        let asc = service
            .list_memos_filtered_page(
                Some("work"),
                "all",
                "filenameAsc",
                None,
                None,
                None,
                Some(2),
            )
            .unwrap();
        assert_eq!(
            asc.memos
                .iter()
                .map(|memo| memo.filename.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha.md", "middle.md"]
        );
        let asc_next = service
            .list_memos_filtered_page(
                Some("work"),
                "all",
                "filenameAsc",
                None,
                None,
                asc.next_cursor.as_deref(),
                Some(2),
            )
            .unwrap();
        assert_eq!(
            asc_next
                .memos
                .iter()
                .map(|memo| memo.filename.as_str())
                .collect::<Vec<_>>(),
            vec!["Zulu.md"]
        );

        let desc = service
            .list_memos_filtered_page(
                Some("work"),
                "all",
                "filenameDesc",
                None,
                None,
                None,
                Some(2),
            )
            .unwrap();
        assert_eq!(
            desc.memos
                .iter()
                .map(|memo| memo.filename.as_str())
                .collect::<Vec<_>>(),
            vec!["Zulu.md", "middle.md"]
        );
        let desc_next = service
            .list_memos_filtered_page(
                Some("work"),
                "all",
                "filenameDesc",
                None,
                None,
                desc.next_cursor.as_deref(),
                Some(2),
            )
            .unwrap();
        assert_eq!(
            desc_next
                .memos
                .iter()
                .map(|memo| memo.filename.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha.md"]
        );
    }

    #[test]
    fn memo_page_rejects_a_cursor_from_another_query() {
        let (_temp, memo_file) = service_fixture();
        let mut service = MemoService::new(&memo_file);
        service.create_memo_named_with_tag_in_directory(Some("work"), None, "Untitled", "# Cursor note\n", None).unwrap();
        service.create_memo_named_with_tag_in_directory(Some("work"), None, "Untitled", "# Cursor note two\n", None).unwrap();
        let first = service
            .list_memos_filtered_page(Some("work"), "all", "createdAt", None, None, None, Some(1))
            .unwrap();
        let error = service
            .list_memos_filtered_page(
                Some("work"),
                "favorited",
                "createdAt",
                None,
                None,
                first.next_cursor.as_deref(),
                Some(1),
            )
            .unwrap_err();
        assert!(matches!(error, FlowixError::InvalidInput(_)));
    }

    #[test]
    fn notebook_note_counts_returns_every_notebook_from_one_index_read() {
        let (temp, memo_file) = service_fixture();
        let personal_path = temp.path().join("personal");
        std::fs::create_dir_all(&personal_path).unwrap();
        let mut configs = memo_file.read_notebook_configs().unwrap();
        configs.push(NotebookConfig {
            id: "personal".into(),
            name: "Personal".into(),
            icon: None,
            path: format!("{}/", personal_path.display()),
            is_default: false,
            sort: 10,
            created_at: 2,
            updated_at: 2,
        });
        memo_file.write_notebook_configs(&configs).unwrap();

        let mut service = MemoService::new(&memo_file);
        service.create_memo_named_with_tag_in_directory(Some("work"), None, "Untitled", "# Work one\n", None).unwrap();
        service.create_memo_named_with_tag_in_directory(Some("work"), None, "Untitled", "# Work two\n", None).unwrap();
        service.create_memo_named_with_tag_in_directory(Some("personal"), None, "Untitled", "# Personal one\n", None).unwrap();

        let configs = service.list_notebooks().unwrap();
        let counts = service.notebook_note_counts(&configs).unwrap();
        assert_eq!(counts.get("work"), Some(&2));
        assert_eq!(counts.get("personal"), Some(&1));
    }

    #[test]
    fn exact_edit_reports_typed_conflicts() {
        let (_temp, memo_file) = service_fixture();
        let mut service = MemoService::new(&memo_file);
        let created = service
            .create_memo_named_with_tag_in_directory(Some("work"), None, "Untitled", "# Conflict\n\nrepeat repeat\n", None)
            .unwrap();
        let error = service
            .edit_memo_exact(&created.memo.id, "repeat", "changed", false)
            .unwrap_err();
        assert!(matches!(error, FlowixError::Conflict(_)));
    }

    #[test]
    fn desktop_service_preserves_explicit_titles_empty_content_and_metadata() {
        let (_temp, memo_file) = service_fixture();
        let mut service = MemoService::new(&memo_file);

        let preview = service
            .preview_create_path(Some("work"), "Imported title")
            .unwrap();
        let created = service
            .create_memo_named_with_tag_in_directory(Some("work"), None, "Imported title", "", None)
            .unwrap();
        assert_eq!(created.path, preview);
        assert_eq!(created.memo.filename, "Imported title.md");

        let saved = service.save_memo(&created.memo.id, "").unwrap();
        assert_eq!(saved.memo.unwrap().filename, "Imported title.md");

        let mut metadata = service.memo_metadata(&created.memo.id).unwrap();
        metadata.favorited = true;
        service.sync_memo_metadata(&metadata).unwrap();
        assert!(service.memo_metadata(&created.memo.id).unwrap().favorited);

    }

    #[test]
    fn rename_validation_rejects_a_stale_filename_before_mutation() {
        let (_temp, memo_file) = service_fixture();
        let mut service = MemoService::new(&memo_file);
        let created = service
            .create_memo_named_with_tag_in_directory(Some("work"), None, "Original", "body", None)
            .unwrap();

        let error = service
            .rename_memo_with_validation(&created.memo.id, "Renamed", |resolved| {
                if resolved.entry.filename != "Stale.md" {
                    return Err(FlowixError::Conflict("stale filename".into()));
                }
                Ok(())
            })
            .unwrap_err();

        assert!(matches!(error, FlowixError::Conflict(_)));
        assert_eq!(
            service.memo_metadata(&created.memo.id).unwrap().filename,
            "Original.md"
        );
        assert!(created.path.exists());
    }

    #[test]
    fn independent_services_serialize_exact_edits_to_the_same_memo() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let (temp, memo_file) = service_fixture();
        let created = MemoService::new(&memo_file)
            .create_memo_named_with_tag_in_directory(Some("work"), None, "Untitled", "# Shared\n\nalpha beta\n", None)
            .unwrap();
        let memo_id = created.memo.id;
        let config_dir = temp.path().join("config");
        let barrier = Arc::new(Barrier::new(2));

        let edits = [("alpha", "ALPHA"), ("beta", "BETA")];
        let handles = edits
            .into_iter()
            .map(|(old, new)| {
                let barrier = barrier.clone();
                let config_dir = config_dir.clone();
                let memo_id = memo_id.clone();
                thread::spawn(move || {
                    let memo_file = MemoFile::new(config_dir);
                    let mut service = MemoService::new(&memo_file);
                    barrier.wait();
                    service
                        .edit_memo_exact(&memo_id, old, new, false)
                        .expect("serialized edit");
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            handle.join().expect("join");
        }

        let verifier = MemoFile::new(config_dir);
        let body = MemoService::new(&verifier).get_memo(&memo_id).unwrap().body;
        assert!(body.contains("ALPHA BETA"), "final body: {body}");
    }
}
