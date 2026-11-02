//! Application service boundary shared by desktop, CLI, MCP, and future transports.
//!
//! `MemoFile` remains the shared storage façade. `NoteService` is the public
//! path-keyed Note API.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::memo_file::{
    notebook_path_from_relative, MemoFile, NoteEntry, NoteSearchHit, NoteSummary, NoteWriteResult,
    NotebookConfig, NoteTitleFilter,
};

const DEFAULT_LIST_PAGE_SIZE: usize = 50;
const MAX_LIST_PAGE_SIZE: usize = 100;
const MAX_LIST_CURSOR_BYTES: usize = 4096;

/// Query values travel together so adding a predicate cannot shift positional arguments.
#[derive(Debug, Clone)]
pub struct NotePageQuery<'a> {
    pub filter: &'a str,
    pub sort: &'a str,
    pub tag_id: Option<&'a str>,
    pub color: Option<&'a str>,
    pub cursor: Option<&'a str>,
    pub limit: Option<usize>,
    pub title_filter: Option<&'a NoteTitleFilter>,
}

/// Opaque cursor for the path-keyed notebook list. Relative path is the stable
/// tie breaker for every ordering.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct NoteListCursor {
    notebook_id: String,
    filter: String,
    sort: String,
    tag_id: Option<String>,
    color: Option<String>,
    #[serde(default)]
    title_filter: Option<NoteTitleFilter>,
    favorited: bool,
    sort_value: i64,
    sort_text: Option<String>,
    sort_tiebreaker: Option<String>,
    relative_path: String,
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

/// Path-identified Note use cases. The path projection and Markdown file are
/// the note's only identities.
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

impl NoteService<'_> {
    /// List notes by notebook-relative path.
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
        self.query_note_page(notebook_key, NotePageQuery {
            filter, sort, tag_id, color, cursor,
            limit: requested_limit,
            title_filter: None,
        }, true)
    }

    /// Desktop reads must never turn an unavailable index into synchronous
    /// notebook maintenance. The background worker owns preparation.
    pub fn list_indexed_page(
        &mut self,
        notebook_key: &str,
        filter: &str,
        sort: &str,
        tag_id: Option<&str>,
        color: Option<&str>,
        cursor: Option<&str>,
        requested_limit: Option<usize>,
    ) -> Result<NotePage, FlowixError> {
        self.list_indexed_page_query(notebook_key, NotePageQuery {
            filter, sort, tag_id, color, cursor,
            limit: requested_limit,
            title_filter: None,
        })
    }

    pub fn list_indexed_page_query(
        &mut self,
        notebook_key: &str,
        query: NotePageQuery<'_>,
    ) -> Result<NotePage, FlowixError> {
        self.query_note_page(notebook_key, query, false)
    }

    fn query_note_page(
        &mut self,
        notebook_key: &str,
        query: NotePageQuery<'_>,
        prepare_index: bool,
    ) -> Result<NotePage, FlowixError> {
        let NotePageQuery {
            filter, sort, tag_id, color, cursor,
            limit: requested_limit, title_filter,
        } = query;
        if title_filter.is_some_and(|filter| !filter.is_valid()) {
            return Err(FlowixError::InvalidInput("invalid note title filter".into()));
        }
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
                    || page_cursor.title_filter.as_ref() != title_filter
                {
                    return Err(FlowixError::InvalidInput(
                        "path note cursor does not match the current query".into(),
                    ));
                }
            }
            let page = self.memo_file.read_note_page_with_title_filter(
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
                title_filter,
            );
            let mut notes = match page {
                Ok(notes) => notes,
                Err(error) if prepare_index && error.kind() == std::io::ErrorKind::WouldBlock => {
                    self.memo_file.reconcile_note_index(&notebook.id)?;
                    self.memo_file.read_note_page_with_title_filter(
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
                        title_filter,
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
                        title_filter: title_filter.cloned(),
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

    /// Open a Markdown note by notebook and relative path.
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
        match self.memo_file.write_note_by_path_with_result(
            &notebook.id,
            relative_path,
            content,
            expected_content,
        )? {
            NoteWriteResult::Conflict { disk_content } => {
                Ok(NoteSaveOutcome::Conflict { disk_content })
            }
            NoteWriteResult::Saved {
                content,
                index_entry,
            } => {
                let entry = match index_entry {
                    Some(entry) => entry,
                    None => self
                        .memo_file
                        .derive_note_entry_from_disk(&notebook.id, relative_path)?,
                };
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

impl<'a> NoteService<'a> {
    pub fn list(&mut self, notebook: &str) -> Result<Vec<NoteEntry>, FlowixError> {
        self.list_notes_by_path(notebook)
    }

    /// Title-only list for pickers. Recovers a cold index the same way `list`
    /// does, but never decodes the preview, todos, agents or properties of a
    /// note that only has to render one line of text.
    pub fn list_summaries(&mut self, notebook: &str) -> Result<Vec<NoteSummary>, FlowixError> {
        let notebook = self.resolve_notebook(notebook)?;
        match self.memo_file.read_note_summaries(&notebook.id) {
            Ok(summaries) => Ok(summaries),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                self.memo_file.reconcile_note_index(&notebook.id)?;
                Ok(self.memo_file.read_note_summaries(&notebook.id)?)
            }
            Err(error) => Err(FlowixError::Io(error)),
        }
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
    fn indexed_page_reports_pending_without_reconciling_a_cold_notebook() {
        let (temp, store) = service_fixture();
        std::fs::write(temp.path().join("notes/unindexed.md"), "# Not scanned").unwrap();
        let mut service = NoteService::new(&store);
        let error = service.list_indexed_page("work", "all", "createdAt", None, None, None, Some(50)).unwrap_err();
        assert!(matches!(error, FlowixError::Io(ref error) if error.kind() == std::io::ErrorKind::WouldBlock));
        assert!(!store.note_index_is_ready("work").unwrap());
        assert!(store.read_indexed_note_entry_by_path("work", "unindexed.md").unwrap().is_none());
        store.reconcile_note_index("work").unwrap();
        assert_eq!(service.list_indexed_page("work", "all", "createdAt", None, None, None, Some(50)).unwrap().notes.len(), 1);
    }

    #[test]
    fn title_filter_applies_before_pagination_and_is_bound_to_the_cursor() {
        let (_temp, store) = service_fixture();
        let mut service = NoteService::new(&store);
        for title in ["Other", "发布%_一", "发布%_二"] {
            service.create_note_by_path("work", None, title, "body").unwrap();
        }
        store.reconcile_note_index("work").unwrap();
        let filter = NoteTitleFilter {
            match_mode: "all".into(),
            conditions: vec![crate::memo_file::NoteTitleCondition { op: "contains".into(), value: "%_".into() }],
        };
        let query = NotePageQuery {
            filter: "all", sort: "filenameAsc", tag_id: None, color: None,
            cursor: None, limit: Some(1), title_filter: Some(&filter),
        };
        let first = service.list_indexed_page_query("work", query.clone()).unwrap();
        assert_eq!(first.notes.len(), 1);
        assert!(first.notes[0].title.contains("%_"));
        assert!(first.has_more);
        let second = service.list_indexed_page_query("work", NotePageQuery {
            cursor: first.next_cursor.as_deref(), ..query
        }).unwrap();
        assert_eq!(second.notes.len(), 1);
        assert_ne!(first.notes[0].relative_path, second.notes[0].relative_path);
        assert!(!second.has_more);
        assert!(service.list_indexed_page("work", "all", "filenameAsc", None, None, first.next_cursor.as_deref(), Some(1)).is_err());
    }

    #[test]
    fn save_returns_filename_title_and_first_body_line_preview() {
        let (_temp, store) = service_fixture();
        let mut service = NoteService::new(&store);
        service
            .create_note_by_path("work", None, "Filename title", "# Old preview\nOld body\n")
            .unwrap();

        let saved = service
            .save_note_by_path(
                "work",
                "Filename title.md",
                "# New preview\nNew body\n",
                Some("# Old preview\nOld body\n"),
            )
            .unwrap();
        let NoteSaveOutcome::Saved(document) = saved else {
            panic!("save should succeed without a content conflict");
        };

        assert_eq!(document.entry.title, "Filename title");
        assert_eq!(document.entry.preview, "New preview");
        assert_eq!(document.body, "# New preview\nNew body\n");
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


}
