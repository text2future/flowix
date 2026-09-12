//! Application service boundary shared by desktop, CLI, MCP, and future transports.
//!
//! `MemoFile` remains the storage/domain primitive. `MemoService` owns use-case rules
//! such as notebook resolution, global memo lookup, exact edits, validation, and typed
//! errors so transport adapters do not need to reimplement them.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::memo_file::{
    base_filename, notebook_path_from_relative, normalize_search_tag_filter,
    resolve_filename_conflict, Memo, MemoColor, MemoFile, MemoIndexEntry, MemoTodoEntry,
    MemoVersionMeta, MemoVersionSource, NotebookConfig,
};
use crate::search::{self, NotebookSearchResults};

const MAX_SEARCH_LIMIT: usize = 200;
const DEFAULT_MEMO_PAGE_SIZE: usize = 50;
const MAX_MEMO_PAGE_SIZE: usize = 100;
const MAX_MEMO_CURSOR_BYTES: usize = 4096;

pub struct MemoSaveReceipt {
    pub edited: EditedMemo,
    pub content: String,
    pub notebook_id: String,
    pub commit: Option<crate::memo_file::MemoContentRevision>,
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

#[derive(Debug, Clone)]
pub struct MemoPage {
    pub memos: Vec<Memo>,
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

/// Use-case facade over one `MemoFile` instance.
///
/// The service borrows the store instead of owning it, so Desktop can construct it from
/// its managed `MemoFile` while CLI/MCP can construct it from a short-lived instance.
pub struct MemoService<'a> {
    memo_file: &'a MemoFile,
}

impl<'a> MemoService<'a> {
    pub fn new(memo_file: &'a MemoFile) -> Self {
        Self { memo_file }
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
        Ok(self
            .memo_file
            .read_index_for_notebook_id(Some(&notebook.id))?
            .unwrap_or_default()
            .memos)
    }

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
            .unwrap_or(DEFAULT_MEMO_PAGE_SIZE)
            .clamp(1, MAX_MEMO_PAGE_SIZE);
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
                if value.len() > MAX_MEMO_CURSOR_BYTES {
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

    pub fn create_memo(
        &mut self,
        notebook_key: &str,
        body: &str,
    ) -> Result<CreatedMemo, FlowixError> {
        if body.trim().is_empty() {
            return Err(FlowixError::InvalidInput(
                "empty body, note not created".into(),
            ));
        }
        self.create_memo_named(Some(notebook_key), "Untitled", body)
    }

    /// Create from CLI/MCP and mark the operation for Desktop's watcher before
    /// the markdown file is published.
    pub fn create_external_memo(
        &mut self,
        notebook_key: &str,
        body: &str,
    ) -> Result<CreatedMemo, FlowixError> {
        if body.trim().is_empty() {
            return Err(FlowixError::InvalidInput(
                "empty body, note not created".into(),
            ));
        }
        let notebook = self.resolve_notebook(notebook_key)?;
        let _write_guard = self.memo_file.acquire_cross_process_write_lock()?;
        let memo = self.memo_file.create_external_memo_for_notebook_id(
            &notebook.id,
            "Untitled",
            body,
            None,
        )?;
        let path = notebook_path_from_relative(&PathBuf::from(&notebook.path), &memo.relative_path)
            .unwrap_or_else(|_| PathBuf::from(&notebook.path).join(&memo.filename));
        Ok(CreatedMemo {
            memo,
            notebook,
            path,
        })
    }

    /// Create a named memo from a separate CLI/tool process and mark it for
    /// Desktop's watcher before publishing the Markdown file.
    pub fn create_external_memo_named(
        &mut self,
        notebook_key: &str,
        title: &str,
        body: &str,
    ) -> Result<CreatedMemo, FlowixError> {
        if title.trim().is_empty() {
            return Err(FlowixError::InvalidInput(
                "empty title, note not created".into(),
            ));
        }
        let notebook = self.resolve_notebook(notebook_key)?;
        let _write_guard = self.memo_file.acquire_cross_process_write_lock()?;
        let memo =
            self.memo_file
                .create_external_memo_for_notebook_id(&notebook.id, title, body, None)?;
        let path = notebook_path_from_relative(&PathBuf::from(&notebook.path), &memo.relative_path)
            .unwrap_or_else(|_| PathBuf::from(&notebook.path).join(&memo.filename));
        Ok(CreatedMemo {
            memo,
            notebook,
            path,
        })
    }

    /// Create a memo with an explicit title while preserving Desktop's ability to
    /// create an empty document. When `notebook_key` is omitted, the store's current
    /// notebook/default fallback remains in effect.
    pub fn create_memo_named(
        &mut self,
        notebook_key: Option<&str>,
        title: &str,
        body: &str,
    ) -> Result<CreatedMemo, FlowixError> {
        self.create_memo_named_with_tag(notebook_key, title, body, None)
    }

    /// Create a memo and assign its initial document-membership tag through
    /// frontmatter. The body is never decorated with a synthetic `#tag`.
    pub fn create_memo_named_with_tag(
        &mut self,
        notebook_key: Option<&str>,
        title: &str,
        body: &str,
        tag: Option<&str>,
    ) -> Result<CreatedMemo, FlowixError> {
        self.create_memo_named_with_tag_in_directory(notebook_key, None, title, body, tag)
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
        let memo = if let Some(key) = notebook_key {
            let notebook = self.resolve_notebook(key)?;
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
        let location = self
            .memo_file
            .resolve_memo_location(&memo.id)?
            .ok_or_else(|| {
                FlowixError::Internal(format!(
                    "created note `{}` could not be resolved from the index",
                    memo.id
                ))
            })?;
        let notebook = location.notebook;
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
        memo_id: &str,
        notebook_key: &str,
        parent_relative_path: &str,
    ) -> Result<EditedMemo, FlowixError> {
        let _write_guard = self.memo_file.acquire_cross_process_write_lock()?;
        let resolved = self.resolve_memo(memo_id)?;
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
                memo_id,
                parent_relative_path,
            )
            .map_err(FlowixError::InvalidInput)?;
        Ok(EditedMemo {
            id: memo_id.to_string(),
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
        let (base, entries) = if let Some(key) = notebook_key {
            let notebook = self.resolve_notebook(key)?;
            let entries = self
                .memo_file
                .read_index_for_notebook_id(Some(&notebook.id))?
                .unwrap_or_default()
                .memos;
            (PathBuf::from(notebook.path), entries)
        } else {
            (
                self.memo_file.get_memo_base(),
                self.memo_file.read_index().unwrap_or_default().memos,
            )
        };
        let create_base = match parent_relative_path.filter(|path| !path.is_empty()) {
            Some(relative) => {
                notebook_path_from_relative(&base, relative).map_err(FlowixError::InvalidInput)?
            }
            None => base,
        };
        let candidate = base_filename(title);
        let occupied = entries
            .into_iter()
            .filter(|entry| {
                let parent = entry
                    .relative_path
                    .rsplit_once('/')
                    .map(|(parent, _)| parent);
                parent == parent_relative_path.filter(|path| !path.is_empty())
            })
            .map(|entry| entry.filename)
            .collect::<Vec<_>>();
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
        let _write_guard = self.memo_file.acquire_cross_process_write_lock()?;
        if old.is_empty() {
            return Err(FlowixError::InvalidInput(
                "edit: old_string cannot be empty".into(),
            ));
        }
        let resolved = self.resolve_memo(id_or_filename)?;
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
            .write_memo_preserving_filename_global(&resolved.id, &body)?;
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
        self.save_memo_with_receipt(id_or_filename, body, false, validate)
            .map(|receipt| (receipt.edited, receipt.content))
    }

    pub fn save_memo_with_receipt(
        &mut self,
        id_or_filename: &str,
        body: &str,
        create_auto_version: bool,
        validate: impl FnOnce(&ResolvedMemo, &str) -> Result<(), FlowixError>,
    ) -> Result<MemoSaveReceipt, FlowixError> {
        use sha2::{Digest, Sha256};
        let _write_guard = self.memo_file.acquire_cross_process_write_lock()?;
        let resolved = self.resolve_memo(id_or_filename)?;
        let current = std::fs::read_to_string(&resolved.path)?;
        validate(&resolved, &current)?;
        let old_bytes = current.len();
        let memo = self
            .memo_file
            .write_memo_preserving_filename_global(&resolved.id, body)?;
        let path = notebook_path_from_relative(
            &PathBuf::from(&resolved.notebook.path),
            &memo.relative_path,
        )
        .unwrap_or_else(|_| PathBuf::from(&resolved.notebook.path).join(&memo.filename));
        let content = std::fs::read_to_string(&path)?;
        let content_hash = format!("{:x}", Sha256::digest(content.as_bytes()));
        let commit = match self.memo_file.commit_memo_content_revision(
            &resolved.id,
            &resolved.notebook.id,
            &content_hash,
            &uuid::Uuid::new_v4().to_string(),
        ) {
            Ok(commit) => Some(commit.state),
            Err(error) => {
                tracing::warn!("Memo saved but revision persistence failed: {error}");
                None
            }
        };
        if create_auto_version {
            if let Err(error) = self
                .memo_file
                .maybe_create_auto_memo_version(&resolved.id, &content)
            {
                tracing::warn!("Memo saved but automatic version failed: {error}");
            }
        }
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
        let _write_guard = self.memo_file.acquire_cross_process_write_lock()?;
        let resolved = self.resolve_memo(id_or_filename)?;
        let old_bytes = std::fs::metadata(&resolved.path)
            .map(|metadata| metadata.len() as usize)
            .unwrap_or(0);
        let memo = self
            .memo_file
            .write_memo_preserving_filename_global(&resolved.id, body)?;
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
        let _write_guard = self.memo_file.acquire_cross_process_write_lock()?;
        let resolved = self.resolve_memo(id_or_filename)?;
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

    pub fn list_memo_versions(&mut self, memo_id: &str) -> Vec<MemoVersionMeta> {
        self.memo_file.list_memo_versions(memo_id)
    }

    pub fn read_memo_version(&mut self, memo_id: &str, version_id: &str) -> Option<String> {
        self.memo_file.read_memo_version(memo_id, version_id)
    }

    pub fn create_memo_version(
        &mut self,
        memo_id: &str,
        content: &str,
        source: MemoVersionSource,
    ) -> Result<Option<MemoVersionMeta>, FlowixError> {
        let _write_guard = self.memo_file.acquire_cross_process_write_lock()?;
        self.memo_file
            .create_memo_version(memo_id, content, source)
            .map_err(FlowixError::Io)
    }

    pub fn maybe_create_auto_memo_version(
        &mut self,
        memo_id: &str,
        content: &str,
    ) -> Result<Option<MemoVersionMeta>, FlowixError> {
        let _write_guard = self.memo_file.acquire_cross_process_write_lock()?;
        self.memo_file
            .maybe_create_auto_memo_version(memo_id, content)
            .map_err(FlowixError::Io)
    }

    pub fn delete_memo_version(&mut self, memo_id: &str, version_id: &str) -> bool {
        let Ok(_write_guard) = self.memo_file.acquire_cross_process_write_lock() else {
            return false;
        };
        self.memo_file.delete_memo_version(memo_id, version_id)
    }

    pub fn search_memos(
        &mut self,
        query: &str,
        notebook_filter: Option<&str>,
        tag_filter: Option<&str>,
        limit: usize,
    ) -> Result<NotebookSearchResults, FlowixError> {
        if query.trim().is_empty() {
            return Err(FlowixError::InvalidInput(
                "search query cannot be empty".into(),
            ));
        }
        if limit == 0 {
            return Err(FlowixError::InvalidInput(
                "search limit must be greater than 0".into(),
            ));
        }
        let normalized_tag_filter = match tag_filter {
            Some(raw) => Some(normalize_search_tag_filter(raw).ok_or_else(|| {
                FlowixError::InvalidInput(
                    "search tag filter must be a valid tag path (for example `项目/Flowix`)".into(),
                )
            })?),
            None => None,
        };
        let configs = self.list_notebooks()?;
        if let Some(filter) = notebook_filter {
            if !configs
                .iter()
                .any(|config| config.id == filter || config.name == filter)
            {
                return Err(FlowixError::NotFound(format!(
                    "no notebooks matched filter `{filter}`"
                )));
            }
        } else if configs.is_empty() {
            return Err(FlowixError::NotFound("no notebooks configured".into()));
        }
        Ok(search::search_notebooks_with_tag_filter(
            self.memo_file,
            &configs,
            notebook_filter,
            query,
            normalized_tag_filter.as_deref(),
            limit.min(MAX_SEARCH_LIMIT),
        ))
    }

    pub fn resolve_notebook(&mut self, key: &str) -> Result<NotebookConfig, FlowixError> {
        self.list_notebooks()?
            .into_iter()
            .find(|config| config.id == key)
            .or_else(|| {
                self.memo_file
                    .read_notebook_configs()
                    .ok()?
                    .into_iter()
                    .find(|config| config.name == key)
            })
            .ok_or_else(|| FlowixError::NotFound(format!("notebook `{key}` not found")))
    }

    pub fn resolve_memo(&mut self, id_or_filename: &str) -> Result<ResolvedMemo, FlowixError> {
        if let Some(location) = self.memo_file.resolve_memo_location(id_or_filename)? {
            let path = notebook_path_from_relative(
                &PathBuf::from(&location.notebook.path),
                &location.memo.relative_path,
            )
            .unwrap_or_else(|_| PathBuf::from(&location.notebook.path).join(&location.memo.filename));
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
    fn save_snapshot_does_not_change_when_a_later_writer_saves() {
        let (_directory, store) = service_fixture();
        let mut service = MemoService::new(&store);
        let created = service.create_memo("work", "# Note\noriginal\n").unwrap();
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
        let created = service.create_memo("work", "# Note\noriginal\n").unwrap();
        let first = service
            .save_memo_with_receipt(&created.memo.id, "# Note\nfirst\n", true, |_, _| Ok(()))
            .unwrap();
        let first_commit = first.commit.unwrap();
        let second = service
            .save_memo_with_receipt(&created.memo.id, "# Note\nsecond\n", false, |_, _| Ok(()))
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
        let versions = service.list_memo_versions(&created.memo.id);
        let version = versions
            .iter()
            .find(|version| version.content_hash == first_commit.content_hash)
            .unwrap();
        assert_eq!(
            service
                .read_memo_version(&created.memo.id, &version.id)
                .as_deref(),
            Some(first.content.as_str())
        );
    }

    #[test]
    fn rejected_save_preserves_file_name_content_and_index() {
        let (_temp, memo_file) = service_fixture();
        let mut service = MemoService::new(&memo_file);
        let created = service
            .create_memo("work", "# Original\n\nimportant\n")
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
    fn validation_runs_while_the_shared_write_lock_is_held() {
        let (temp, memo_file) = service_fixture();
        let mut service = MemoService::new(&memo_file);
        let created = service.create_memo("work", "# Note\nold\n").unwrap();
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
            .create_memo("work", "# Note\nold\n")
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
            .create_memo("Work Notes", "# Service note\n\nold text\n")
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
            .create_memo("work", "# Body heading\n\ncontent")
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
        let created = service.create_memo("work", "# Move me\n").unwrap();
        let old_path = created.path.clone();

        let moved = service
            .move_memo_to_directory(&created.memo.id, "work", "projects")
            .unwrap();

        assert_eq!(moved.path, temp.path().join("notes/projects/Untitled.md"));
        assert!(!old_path.exists());
        assert!(moved.path.exists());
        assert_eq!(
            moved.memo.unwrap().relative_path,
            "projects/Untitled.md"
        );
    }

    #[test]
    fn memo_pages_are_stable_and_do_not_repeat_items() {
        let (_temp, memo_file) = service_fixture();
        let mut service = MemoService::new(&memo_file);
        for index in 0..5 {
            service
                .create_memo("work", &format!("# Page note {index}\n"))
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
            .create_memo_named(Some("work"), "Zulu", "# Zulu\n")
            .unwrap();
        service
            .create_memo_named(Some("work"), "alpha", "# alpha\n")
            .unwrap();
        service
            .create_memo_named(Some("work"), "middle", "# middle\n")
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
            .list_memos_filtered_page(Some("work"), "all", "filenameDesc", None, None, None, Some(2))
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
        service.create_memo("work", "# Cursor note\n").unwrap();
        service.create_memo("work", "# Cursor note two\n").unwrap();
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
        service.create_memo("work", "# Work one\n").unwrap();
        service.create_memo("work", "# Work two\n").unwrap();
        service.create_memo("personal", "# Personal one\n").unwrap();

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
            .create_memo("work", "# Conflict\n\nrepeat repeat\n")
            .unwrap();
        let error = service
            .edit_memo_exact(&created.memo.id, "repeat", "changed", false)
            .unwrap_err();
        assert!(matches!(error, FlowixError::Conflict(_)));
    }

    #[test]
    fn search_validates_and_normalizes_tag_filter() {
        let (_temp, memo_file) = service_fixture();
        let mut service = MemoService::new(&memo_file);
        service
            .create_memo(
                "work",
                "---\ntags: [项目/Flowix/CLI]\n---\n# 发布计划\n\n正文关键词\n",
            )
            .unwrap();

        let results = service
            .search_memos("发布计划", None, Some("#项目/Flowix"), 10)
            .unwrap();
        assert_eq!(results.hits.len(), 1);

        let error = service
            .search_memos("发布计划", None, Some("项目//Flowix"), 10)
            .unwrap_err();
        assert!(matches!(error, FlowixError::InvalidInput(_)));
    }

    #[test]
    fn desktop_service_preserves_explicit_titles_empty_content_and_metadata() {
        let (_temp, memo_file) = service_fixture();
        let mut service = MemoService::new(&memo_file);

        let preview = service
            .preview_create_path(Some("work"), "Imported title")
            .unwrap();
        let created = service
            .create_memo_named(Some("work"), "Imported title", "")
            .unwrap();
        assert_eq!(created.path, preview);
        assert_eq!(created.memo.filename, "Imported title.md");

        let saved = service.save_memo(&created.memo.id, "").unwrap();
        assert_eq!(saved.memo.unwrap().filename, "Imported title.md");

        let mut metadata = service.memo_metadata(&created.memo.id).unwrap();
        metadata.favorited = true;
        service.sync_memo_metadata(&metadata).unwrap();
        assert!(service.memo_metadata(&created.memo.id).unwrap().favorited);

        let version = service
            .create_memo_version(&created.memo.id, "version body", MemoVersionSource::Manual)
            .unwrap()
            .unwrap();
        assert_eq!(
            service.read_memo_version(&created.memo.id, &version.id),
            Some("version body".to_string())
        );
    }

    #[test]
    fn rename_validation_rejects_a_stale_filename_before_mutation() {
        let (_temp, memo_file) = service_fixture();
        let mut service = MemoService::new(&memo_file);
        let created = service
            .create_memo_named(Some("work"), "Original", "body")
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
            .create_memo("work", "# Shared\n\nalpha beta\n")
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
