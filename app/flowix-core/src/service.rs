//! Application service boundary shared by desktop, CLI, MCP, and future transports.
//!
//! `MemoFile` remains the storage/domain primitive. `MemoService` owns use-case rules
//! such as notebook resolution, global memo lookup, exact edits, validation, and typed
//! errors so transport adapters do not need to reimplement them.

use std::collections::HashMap;
use std::path::PathBuf;

use thiserror::Error;

use crate::memo_file::{
    base_filename, resolve_filename_conflict, Memo, MemoFile, MemoIndexEntry, MemoTodoEntry,
    MemoVersionMeta, MemoVersionSource, NotebookConfig,
};
use crate::search::{self, NotebookSearchResults};

const MAX_SEARCH_LIMIT: usize = 200;

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
        let mut counts = HashMap::new();
        for config in configs {
            let count = self
                .memo_file
                .read_index_for_notebook_id(Some(&config.id))?
                .unwrap_or_default()
                .memos
                .len();
            counts.insert(config.id.clone(), count);
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
        let title = derive_title(body);
        self.create_memo_named(Some(notebook_key), &title, body)
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
        let title = derive_title(body);
        let notebook = self.resolve_notebook(notebook_key)?;
        let _write_guard = self.memo_file.acquire_cross_process_write_lock()?;
        let memo = self.memo_file.create_external_memo_for_notebook_id(
            &notebook.id,
            &title,
            body,
            None,
        )?;
        let path = PathBuf::from(&notebook.path).join(&memo.filename);
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
        let _write_guard = self.memo_file.acquire_cross_process_write_lock()?;
        let memo = if let Some(key) = notebook_key {
            let notebook = self.resolve_notebook(key)?;
            self.memo_file
                .create_memo_for_notebook_id(&notebook.id, title, body, None)
        } else {
            self.memo_file.create_memo(title, body, None)
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
        let path = PathBuf::from(&notebook.path).join(&memo.filename);
        Ok(CreatedMemo {
            memo,
            notebook,
            path,
        })
    }

    /// Resolve the path that the next named create is expected to use. Desktop uses
    /// this immediately before creation to suppress its own filesystem watcher event.
    pub fn preview_create_path(
        &mut self,
        notebook_key: Option<&str>,
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
        let candidate = base_filename(title);
        let occupied = entries
            .into_iter()
            .map(|entry| entry.filename)
            .collect::<Vec<_>>();
        Ok(base.join(resolve_filename_conflict(&base, &candidate, &occupied)))
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
            .write_memo_renaming_on_title_change_global(&resolved.id, &body)?;
        let path = PathBuf::from(&resolved.notebook.path).join(&memo.filename);
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
        let _write_guard = self.memo_file.acquire_cross_process_write_lock()?;
        let resolved = self.resolve_memo(id_or_filename)?;
        let old_bytes = std::fs::metadata(&resolved.path)
            .map(|metadata| metadata.len() as usize)
            .unwrap_or(0);
        let memo = self
            .memo_file
            .write_memo_renaming_on_title_change_global(&resolved.id, body)?;
        let path = PathBuf::from(&resolved.notebook.path).join(&memo.filename);
        Ok(EditedMemo {
            id: resolved.id,
            memo: Some(memo),
            path,
            old_bytes,
            new_bytes: body.len(),
            dry_run: false,
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
        let path = PathBuf::from(&resolved.notebook.path).join(&memo.filename);
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
        let _write_guard = self.memo_file.acquire_cross_process_write_lock()?;
        let resolved = self.resolve_memo(id_or_filename)?;
        let memo = self.memo_file.rename_memo(&resolved.id, new_title)?;
        let path = PathBuf::from(&resolved.notebook.path).join(&memo.filename);
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
    ) -> Result<(Vec<String>, Vec<(String, usize)>, usize, usize, usize), FlowixError> {
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
        Ok(search::search_notebooks(
            self.memo_file,
            &configs,
            notebook_filter,
            query,
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
            let path = PathBuf::from(&location.notebook.path).join(&location.memo.filename);
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
                .find(|entry| entry.filename == wanted)
            {
                let path = PathBuf::from(&notebook.path).join(&entry.filename);
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

fn derive_title(body: &str) -> String {
    body.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.trim_start_matches('#').trim())
        .filter(|line| !line.is_empty())
        .map(|line| line.chars().take(80).collect())
        .unwrap_or_else(|| "untitled".to_string())
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
    fn service_covers_memo_lifecycle_and_filename_resolution() {
        let (_temp, mut memo_file) = service_fixture();
        let mut service = MemoService::new(&mut memo_file);
        let created = service
            .create_memo("Work Notes", "# Service note\n\nold text\n")
            .unwrap();
        assert!(created.path.exists());

        let document = service.get_memo("Service note").unwrap();
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
    fn exact_edit_reports_typed_conflicts() {
        let (_temp, mut memo_file) = service_fixture();
        let mut service = MemoService::new(&mut memo_file);
        let created = service
            .create_memo("work", "# Conflict\n\nrepeat repeat\n")
            .unwrap();
        let error = service
            .edit_memo_exact(&created.memo.id, "repeat", "changed", false)
            .unwrap_err();
        assert!(matches!(error, FlowixError::Conflict(_)));
    }

    #[test]
    fn desktop_service_preserves_explicit_titles_empty_content_and_metadata() {
        let (_temp, mut memo_file) = service_fixture();
        let mut service = MemoService::new(&mut memo_file);

        let preview = service
            .preview_create_path(Some("work"), "Imported title")
            .unwrap();
        let created = service
            .create_memo_named(Some("work"), "Imported title", "")
            .unwrap();
        assert_eq!(created.path, preview);
        assert_eq!(created.memo.filename, "Imported title.md");

        let saved = service.save_memo(&created.memo.id, "").unwrap();
        assert_eq!(saved.memo.unwrap().filename, "Untitled Memo.md");

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
    fn independent_services_serialize_exact_edits_to_the_same_memo() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let (temp, mut memo_file) = service_fixture();
        let created = MemoService::new(&mut memo_file)
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
