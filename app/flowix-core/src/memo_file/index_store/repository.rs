use super::*;

impl MemoFile {
    pub fn occupied_filenames_in_directory(
        &self,
        notebook_id: &str,
        parent: Option<&str>,
    ) -> std::io::Result<Vec<String>> {
        if !self.note_index_is_ready(notebook_id)? {
            self.reconcile_note_index_blocking(notebook_id)?;
        }
        self.note_occupied_filenames(notebook_id, parent)
    }
    pub fn read_index(&self) -> Option<MemoIndexFile> {
        let notebook_id = self.current_notebook_id_for_index();
        if let Ok(Some(cached)) = self.current_cached_index(&notebook_id) {
            return Some(cached);
        }
        let conn = match self.open_memo_index_db() {
            Ok(conn) => conn,
            Err(e) => {
                eprintln!("[notebook.db] open failed: {e}");
                return None;
            }
        };

        let list = match self.read_index_from_db(&conn, &notebook_id) {
            Ok(list) => list,
            Err(e) => {
                eprintln!("[notebook.db] read failed: {e}");
                return None;
            }
        }?;
        *self.index_cache.write().expect("index_cache poisoned") = Some(list.clone());
        Some(list)
    }

    pub fn read_index_for_notebook_id(
        &self,
        notebook_id: Option<&str>,
    ) -> std::io::Result<Option<MemoIndexFile>> {
        let notebook_id = self.notebook_id_for_index(notebook_id);
        if self.current_notebook_id_value().as_deref() == Some(notebook_id.as_str()) {
            return self.read_index_result();
        }

        let conn = self.open_memo_index_db_for_notebook_id(&notebook_id)?;
        self.read_index_from_db(&conn, &notebook_id)
    }

    pub fn resolve_note_location_for_notebook_id(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> std::io::Result<Option<MemoLocation>> {
        let notebook_config = self.get_notebook_config_by_id(notebook_id).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, format!("notebook not found: {notebook_id}"))
        })?;
        let conn = self.open_memo_index_db_for_notebook_id(notebook_id)?;
        let row = conn
                .query_row(
                    r#"
                SELECT
                    m.filename,
                    m.relative_path,
                    m.preview,
                    m.thumbnail,
                    m.created_at,
                    m.updated_at,
                    m.favorited,
                    m.icon,
                    m.properties,
                    n.id,
                    n.name,
                    n.icon,
                    n.path,
                    n.is_default,
                    n.created_at,
                    n.updated_at
                FROM memos m
                JOIN notebooks n ON n.id = m.notebook_id
                WHERE m.notebook_id = ?1 AND m.relative_path = ?2
                LIMIT 1
                "#,
                    params![notebook_id, relative_path],
                    |row| {
                        let is_default: i64 = row.get(13)?;
                        Ok((
                            MemoIndexEntry {
                                filename: row.get(0)?,
                                relative_path: row.get(1)?,
                                preview: row.get(2)?,
                                thumbnail: row.get(3)?,
                                tags: Vec::new(),
                                todos: Vec::new(),
                                agents: Vec::new(),
                                created_at: row.get(4)?,
                                updated_at: row.get(5)?,
                                favorited: row.get::<_, i64>(6)? != 0,
                                icon: row.get(7)?,
                                colors: Vec::new(),
                                properties: serde_json::from_str::<serde_json::Value>(
                                    &row.get::<_, String>(8)?,
                                )
                                .unwrap_or_else(|_| serde_json::json!({})),
                            },
                            NotebookConfig {
                                id: notebook_config.id.clone(),
                                name: notebook_config.name.clone(),
                                icon: notebook_config.icon.clone(),
                                path: notebook_config.path.clone(),
                                is_default: is_default != 0,
                                sort: notebook_config.sort,
                                created_at: notebook_config.created_at,
                                updated_at: notebook_config.updated_at,
                            },
                        ))
                    },
                )
                .optional()
                .map_err(sqlite_to_io)?;

        let Some((mut memo, notebook)) = row else {
            return Ok(None);
        };
            memo.colors = self.read_entry_colors(&conn, &memo.relative_path)?;
            memo.agents = self.read_entry_agents(&conn, &memo.relative_path)?;
            self.backfill_missing_properties(
                &conn,
                &notebook.id,
                &PathBuf::from(&notebook.path),
                std::slice::from_mut(&mut memo),
            )?;
            self.backfill_missing_agents(
                &conn,
                &notebook.id,
                &PathBuf::from(&notebook.path),
                std::slice::from_mut(&mut memo),
            )?;
            self.backfill_missing_thumbnails(
                &conn,
                &notebook.id,
                &PathBuf::from(&notebook.path),
                std::slice::from_mut(&mut memo),
            )?;

        Ok(Some(MemoLocation { memo, notebook }))
    }

    pub fn read_index_result(&self) -> std::io::Result<Option<MemoIndexFile>> {
        let notebook_id = self.current_notebook_id_for_index();
        if let Some(cached) = self.current_cached_index(&notebook_id)? {
            return Ok(Some(cached));
        }
        let conn = self.open_memo_index_db_for_notebook_id(&notebook_id)?;
        let list = self.read_index_from_db(&conn, &notebook_id)?;
        if let Some(list) = &list {
            *self.index_cache.write().expect("index_cache poisoned") = Some(list.clone());
        }
        Ok(list)
    }

    pub fn write_index(&self, list: &MemoIndexFile) -> std::io::Result<()> {
        let notebook_id = self.current_notebook_id_for_index();
        self.write_index_for_notebook_id(&notebook_id, list)
    }

    pub fn write_index_for_notebook_id(
        &self,
        notebook_id: &str,
        list: &MemoIndexFile,
    ) -> std::io::Result<()> {
        let conn = self.open_memo_index_db_for_notebook_id(notebook_id)?;
        self.replace_notebook_index_in_db(&conn, notebook_id, list)?;
        if self.current_notebook_id_for_index() == notebook_id {
            *self.index_cache.write().expect("index_cache poisoned") = Some(list.clone());
        }
        Ok(())
    }

    pub fn memo_to_index_entry(memo: &Memo) -> MemoIndexEntry {
        MemoIndexEntry {
            filename: memo.filename.clone(),
            relative_path: memo.relative_path.clone(),
            preview: memo.preview.clone(),
            thumbnail: memo.thumbnail.clone(),
            tags: memo.tags.clone(),
            todos: memo.todos.clone(),
            agents: memo.agents.clone(),
            created_at: memo.created_at,
            updated_at: memo.updated_at,
            favorited: memo.favorited,
            icon: memo.icon.clone(),
            colors: memo.colors.clone(),
            properties: memo.properties.clone(),
        }
    }

    pub fn index_entry_to_memo(entry: &MemoIndexEntry) -> Memo {
        Memo {
            filename: entry.filename.clone(),
            relative_path: entry.relative_path.clone(),
            preview: entry.preview.clone(),
            thumbnail: entry.thumbnail.clone(),
            tags: entry.tags.clone(),
            todos: entry.todos.clone(),
            agents: entry.agents.clone(),
            created_at: entry.created_at,
            updated_at: entry.updated_at,
            favorited: entry.favorited,
            icon: entry.icon.clone(),
            colors: entry.colors.clone(),
            properties: entry.properties.clone(),
        }
    }

    pub fn sync_index_on_write(&self, memo: &Memo) -> std::io::Result<()> {
        let _guard = self.current_index_io.lock().expect("index_io poisoned");
        self.sync_index_on_write_locked(memo)
    }

    pub fn sync_index_on_write_locked(&self, memo: &Memo) -> std::io::Result<()> {
        let notebook_id = self.current_notebook_id_for_index();
        self.sync_index_on_write_for_notebook_id_locked(&notebook_id, memo)
    }

    pub fn sync_index_on_write_for_notebook_id_locked(
        &self,
        notebook_id: &str,
        memo: &Memo,
    ) -> std::io::Result<()> {
        self.sync_index_on_write_for_notebook_id_locked_inner(notebook_id, memo)
    }

    fn sync_index_on_write_for_notebook_id_locked_inner(
        &self,
        notebook_id: &str,
        memo: &Memo,
    ) -> std::io::Result<()> {
        let mut conn = self.open_memo_index_db_for_notebook_id(notebook_id)?;
        let old_path: Option<String> = conn
            .query_row(
                "SELECT relative_path FROM memos WHERE notebook_id = ?1 AND relative_path = ?2",
                params![notebook_id, memo.relative_path],
                |row| row.get(0),
            )
            .optional()
            .map_err(sqlite_to_io)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_to_io)?;
        Self::upsert_entry_in_tx(&tx, notebook_id, &Self::memo_to_index_entry(memo))?;
        let updated_at = chrono::Utc::now().timestamp_millis();
        self.mark_index_state(
            &tx,
            notebook_id,
            MemoIndexFile::default().version,
            updated_at,
        )?;
        tx.commit().map_err(sqlite_to_io)?;
        if let Some(path) = old_path.filter(|path| path != &memo.relative_path) {
            self.refresh_note_path(notebook_id, &path)?;
        }
        self.refresh_note_path(notebook_id, &memo.relative_path)?;
        if self.current_notebook_id_for_index() == notebook_id {
            let mut cache = self.index_cache.write().expect("index_cache poisoned");
            if let Some(index) = cache.as_mut() {
                let entry = Self::memo_to_index_entry(memo);
                if let Some(existing) = index.memos.iter_mut().find(|item| item.relative_path == memo.relative_path) {
                    *existing = entry;
                } else {
                    index.memos.push(entry);
                }
                index.last_updated = updated_at;
            } else {
                drop(cache);
                let initialized = self.read_index_from_db(&conn, notebook_id)?;
                *self.index_cache.write().expect("index_cache poisoned") = initialized;
            }
        }
        Ok(())
    }


    pub fn sync_index_on_delete(&self, relative_path: &str) -> std::io::Result<()> {
        let _guard = self.current_index_io.lock().expect("index_io poisoned");
        self.sync_index_on_delete_locked(relative_path)
    }

    pub fn sync_index_on_delete_locked(&self, relative_path: &str) -> std::io::Result<()> {
        let notebook_id = self.current_notebook_id_for_index();
        self.sync_index_on_delete_for_notebook_id_locked(&notebook_id, relative_path)
    }

    pub fn sync_index_on_delete_for_notebook_id_locked(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> std::io::Result<()> {
        let mut conn = self.open_memo_index_db_for_notebook_id(notebook_id)?;
        let old_path: Option<String> = conn
            .query_row(
                "SELECT relative_path FROM memos WHERE notebook_id = ?1 AND relative_path = ?2",
                params![notebook_id, relative_path],
                |row| row.get(0),
            )
            .optional()
            .map_err(sqlite_to_io)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_to_io)?;
        tx.execute(
            "DELETE FROM memos WHERE notebook_id = ?1 AND relative_path = ?2",
            params![notebook_id, relative_path],
        )
        .map_err(sqlite_to_io)?;
        self.mark_index_state(
            &tx,
            notebook_id,
            MemoIndexFile::default().version,
            chrono::Utc::now().timestamp_millis(),
        )?;
        tx.commit().map_err(sqlite_to_io)?;
        if let Some(path) = old_path {
            self.refresh_note_path(notebook_id, &path)?;
        }
        if self.current_notebook_id_for_index() == notebook_id {
            let refreshed = self.read_index_from_db(&conn, notebook_id)?;
            *self.index_cache.write().expect("index_cache poisoned") = refreshed;
        }
        Ok(())
    }
}
