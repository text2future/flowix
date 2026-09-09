use std::collections::HashMap;

use super::*;

impl MemoFile {
    /// Read every notebook's memo count with one grouped index query.
    pub fn memo_counts_by_notebook(&self) -> std::io::Result<HashMap<String, usize>> {
        let conn = self.open_memo_index_db()?;
        let mut statement = conn
            .prepare("SELECT notebook_id, COUNT(*) FROM memos GROUP BY notebook_id")
            .map_err(sqlite_to_io)?;
        let rows = statement
            .query_map([], |row| {
                let notebook_id: String = row.get(0)?;
                let count: i64 = row.get(1)?;
                Ok((notebook_id, usize::try_from(count).unwrap_or(0)))
            })
            .map_err(sqlite_to_io)?;

        let mut counts = HashMap::new();
        for row in rows {
            let (notebook_id, count) = row.map_err(sqlite_to_io)?;
            counts.insert(notebook_id, count);
        }
        Ok(counts)
    }

    pub fn read_index(&self) -> Option<MemoIndexFile> {
        let notebook_id = self.current_notebook_id_for_index();
        if let Ok(Some(cached)) = self.current_cached_index(&notebook_id) {
            return Some(cached);
        }
        let conn = match self.open_memo_index_db() {
            Ok(conn) => conn,
            Err(e) => {
                eprintln!("[index.db] open failed: {e}");
                return None;
            }
        };

        let list = match self.read_index_from_db(&conn, &notebook_id) {
            Ok(list) => list,
            Err(e) => {
                eprintln!("[index.db] read failed: {e}");
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

        let conn = self.open_memo_index_db()?;
        self.read_index_from_db(&conn, &notebook_id)
    }

    pub fn resolve_memo_location(&self, memo_id: &str) -> std::io::Result<Option<MemoLocation>> {
        let conn = self.open_memo_index_db()?;
        let row = conn
            .query_row(
                r#"
                SELECT
                    m.id,
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
                WHERE m.id = ?1
                LIMIT 1
                "#,
                params![memo_id],
                |row| {
                    let memo_id: String = row.get(0)?;
                    let is_default: i64 = row.get(14)?;
                    Ok((
                        MemoIndexEntry {
                            id: memo_id,
                            filename: row.get(1)?,
                            relative_path: row.get(2)?,
                            preview: row.get(3)?,
                            thumbnail: row.get(4)?,
                            tags: Vec::new(),
                            todos: Vec::new(),
                            agents: Vec::new(),
                            created_at: row.get(5)?,
                            updated_at: row.get(6)?,
                            favorited: row.get::<_, i64>(7)? != 0,
                            icon: row.get(8)?,
                            colors: Vec::new(),
                            properties: serde_json::from_str::<serde_json::Value>(
                                &row.get::<_, String>(9)?,
                            )
                            .unwrap_or_else(|_| serde_json::json!({})),
                        },
                        NotebookConfig {
                            id: row.get(10)?,
                            name: row.get(11)?,
                            icon: row.get(12)?,
                            path: row.get(13)?,
                            is_default: is_default != 0,
                            sort: 0,
                            created_at: row.get(15)?,
                            updated_at: row.get(16)?,
                        },
                    ))
                },
            )
            .optional()
            .map_err(sqlite_to_io)?;

        let Some((mut memo, notebook)) = row else {
            return Ok(None);
        };
        memo.tags = self.read_entry_tags(&conn, &memo.id)?;
        memo.colors = self.read_entry_colors(&conn, &memo.id)?;
        memo.todos = self.read_entry_todos(&conn, &memo.id)?;
        memo.agents = self.read_entry_agents(&conn, &memo.id)?;
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
        let conn = self.open_memo_index_db()?;
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
        let conn = self.open_memo_index_db()?;
        self.replace_notebook_index_in_db(&conn, notebook_id, list)?;
        if self.current_notebook_id_for_index() == notebook_id {
            *self.index_cache.write().expect("index_cache poisoned") = Some(list.clone());
        }
        Ok(())
    }

    pub fn memo_to_index_entry(memo: &Memo) -> MemoIndexEntry {
        MemoIndexEntry {
            id: memo.id.clone(),
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
            id: entry.id.clone(),
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
        let mut conn = self.open_memo_index_db()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_to_io)?;
        Self::upsert_entry_in_tx(&tx, notebook_id, &Self::memo_to_index_entry(memo))?;
        self.mark_index_state(
            &tx,
            notebook_id,
            MemoIndexFile::default().version,
            chrono::Utc::now().timestamp_millis(),
        )?;
        tx.commit().map_err(sqlite_to_io)?;
        if self.current_notebook_id_for_index() == notebook_id {
            let refreshed = self.read_index_from_db(&conn, notebook_id)?;
            *self.index_cache.write().expect("index_cache poisoned") = refreshed;
        }
        Ok(())
    }

    pub fn sync_to_index_only(&self, memo: &Memo) -> std::io::Result<()> {
        self.sync_index_on_write(memo)
    }

    pub fn sync_index_on_delete(&self, memo_id: &str) -> std::io::Result<()> {
        let _guard = self.current_index_io.lock().expect("index_io poisoned");
        self.sync_index_on_delete_locked(memo_id)
    }

    pub fn sync_index_on_delete_locked(&self, memo_id: &str) -> std::io::Result<()> {
        let notebook_id = self.current_notebook_id_for_index();
        self.sync_index_on_delete_for_notebook_id_locked(&notebook_id, memo_id)
    }

    pub fn sync_index_on_delete_for_notebook_id_locked(
        &self,
        notebook_id: &str,
        memo_id: &str,
    ) -> std::io::Result<()> {
        let mut conn = self.open_memo_index_db()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_to_io)?;
        tx.execute(
            "DELETE FROM memos WHERE notebook_id = ?1 AND id = ?2",
            params![notebook_id, memo_id],
        )
        .map_err(sqlite_to_io)?;
        self.mark_index_state(
            &tx,
            notebook_id,
            MemoIndexFile::default().version,
            chrono::Utc::now().timestamp_millis(),
        )?;
        tx.commit().map_err(sqlite_to_io)?;
        if self.current_notebook_id_for_index() == notebook_id {
            let refreshed = self.read_index_from_db(&conn, notebook_id)?;
            *self.index_cache.write().expect("index_cache poisoned") = refreshed;
        }
        Ok(())
    }
}
