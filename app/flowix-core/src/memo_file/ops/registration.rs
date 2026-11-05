use super::*;

impl MemoFile {
    /// Register a physical Markdown path without changing its content.
    pub fn register_existing_file(&self, path: &Path) -> Result<Memo, String> {
        let _guard = self.current_index_io.lock().expect("index_io poisoned");
        self.register_existing_file_locked(path)
    }


    pub fn register_existing_file_for_notebook_id(
        &self,
        notebook_id: &str,
        path: &Path,
    ) -> Result<Memo, String> {
        let _guard = self.current_index_io.lock().expect("index_io poisoned");
        self.register_existing_file_for_notebook_id_locked(notebook_id, path)
    }

    pub fn register_existing_file_as_new_for_notebook_id(
        &self,
        notebook_id: &str,
        path: &Path,
    ) -> Result<Memo, String> {
        self.register_existing_file_for_notebook_id(notebook_id, path)
    }

    pub(super) fn register_existing_file_as_new_locked(&self, path: &Path) -> Result<Memo, String> {
        self.register_existing_file_locked(path)
    }

    pub(super) fn register_existing_file_locked(&self, path: &Path) -> Result<Memo, String> {
        self.register_existing_file_for_notebook_id_locked(
            &self.current_notebook_id_for_index(),
            path,
        )
    }

    pub(super) fn register_existing_file_for_notebook_id_locked(
        &self,
        notebook_id: &str,
        path: &Path,
    ) -> Result<Memo, String> {
        self.register_path_locked(notebook_id, path)
    }

    fn register_path_locked(
        &self,
        notebook_id: &str,
        path: &Path,
    ) -> Result<Memo, String> {
        if !path.is_md() || !path.is_file() {
            return Err(format!("not an existing Markdown file: {}", path.display()));
        }
        let base = self.memo_base_for_notebook_id_result(notebook_id)?;
        let relative_path = notebook_relative_path(&base, path)?;
        if let Some(memo) =
            self.find_memo_by_relative_path_for_notebook_id(notebook_id, &relative_path)
        {
            return self.reload_memo_inner_for_notebook_id_locked(notebook_id, memo);
        }
        let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
        let now = chrono::Utc::now().timestamp_millis();
        let mut memo = Memo {
            filename: filename_from_notebook_relative_path(&relative_path),
            relative_path,
            preview: String::new(),
            thumbnail: None,
            tags: vec![],
            todos: vec![],
            agents: vec![],
            created_at: now,
            updated_at: now,
            favorited: false,
            icon: None,
            colors: vec![],
            properties: serde_json::json!({}),
        };
        apply_derived_memo_fields(&mut memo, &content);
        MemoFile::sync_index_on_write_for_notebook_id_locked(self, notebook_id, &memo)
            .map_err(|error| format!("sync memo index failed: {error}"))?;
        Ok(memo)
    }
}
