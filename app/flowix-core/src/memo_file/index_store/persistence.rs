use super::*;

impl MemoFile {
    pub(super) fn replace_notebook_index_in_db(
        &self,
        conn: &Connection,
        notebook_id: &str,
        list: &MemoIndexFile,
    ) -> std::io::Result<()> {
        let tx = conn.unchecked_transaction().map_err(sqlite_to_io)?;
        tx.execute(
            "DELETE FROM memos WHERE notebook_id = ?1",
            params![notebook_id],
        )
        .map_err(sqlite_to_io)?;
        for entry in &list.memos {
            Self::upsert_entry_in_tx(&tx, notebook_id, entry)?;
        }
        self.mark_index_state(&tx, notebook_id, list.version, list.last_updated)?;
        tx.commit().map_err(sqlite_to_io)?;
        Ok(())
    }

    pub(super) fn upsert_entry_in_tx(
        tx: &rusqlite::Transaction<'_>,
        notebook_id: &str,
        entry: &MemoIndexEntry,
    ) -> std::io::Result<()> {
        tx.execute(
            r#"
            INSERT INTO memos
                (id, notebook_id, filename, relative_path, preview, thumbnail, thumbnail_checked, agents_checked, created_at, updated_at, favorited, icon, properties)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 1, ?7, ?8, ?9, ?10, ?11)
            ON CONFLICT(id) DO UPDATE SET
                notebook_id = excluded.notebook_id,
                filename = excluded.filename,
                relative_path = excluded.relative_path,
                preview = excluded.preview,
                thumbnail = excluded.thumbnail,
                thumbnail_checked = 1,
                agents_checked = 1,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                favorited = excluded.favorited,
                icon = excluded.icon,
                properties = excluded.properties
            "#,
            params![
                entry.id,
                notebook_id,
                entry.filename,
                entry.relative_path,
                entry.preview,
                entry.thumbnail,
                entry.created_at,
                entry.updated_at,
                if entry.favorited { 1 } else { 0 },
                entry.icon,
                serde_json::to_string(&entry.properties).unwrap_or_else(|_| "{}".to_string()),
            ],
        )
        .map_err(sqlite_to_io)?;
        Self::replace_entry_children_in_tx(tx, notebook_id, entry)
    }

    fn replace_entry_children_in_tx(
        tx: &rusqlite::Transaction<'_>,
        notebook_id: &str,
        entry: &MemoIndexEntry,
    ) -> std::io::Result<()> {
        tx.execute(
            "DELETE FROM memo_tags WHERE memo_id = ?1",
            params![entry.id],
        )
        .map_err(sqlite_to_io)?;
        tx.execute(
            "DELETE FROM memo_colors WHERE memo_id = ?1",
            params![entry.id],
        )
        .map_err(sqlite_to_io)?;
        tx.execute(
            "DELETE FROM memo_todos WHERE memo_id = ?1",
            params![entry.id],
        )
        .map_err(sqlite_to_io)?;
        tx.execute(
            "DELETE FROM memo_agents WHERE memo_id = ?1",
            params![entry.id],
        )
        .map_err(sqlite_to_io)?;

        for tag in &entry.tags {
            tx.execute(
                "INSERT OR IGNORE INTO memo_tags (memo_id, tag) VALUES (?1, ?2)",
                params![entry.id, tag],
            )
            .map_err(sqlite_to_io)?;
            let now = chrono::Utc::now().timestamp_millis();
            for prefix in tag_path_prefixes(tag) {
                tx.execute(
                    "INSERT OR IGNORE INTO notebook_tags
                        (notebook_id, path, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?3)",
                    params![notebook_id, prefix, now],
                )
                .map_err(sqlite_to_io)?;
            }
        }
        for (position, color) in entry.colors.iter().enumerate() {
            tx.execute(
                "INSERT OR REPLACE INTO memo_colors (memo_id, color, position) VALUES (?1, ?2, ?3)",
                params![entry.id, color_to_str(*color), position as i64],
            )
            .map_err(sqlite_to_io)?;
        }
        let existing_todos = Self::read_existing_todo_metadata_in_tx(tx, &entry.id)?;
        let now = chrono::Utc::now().timestamp_millis();

        for (position, todo) in entry.todos.iter().enumerate() {
            let existing = existing_todos
                .iter()
                .find(|entry| entry.content == todo.content);
            let created_at = existing
                .map(|entry| entry.created_at)
                .filter(|value| *value > 0)
                .unwrap_or(entry.created_at);
            let updated_at = existing
                .filter(|entry| entry.status == todo.status)
                .map(|entry| entry.updated_at)
                .filter(|value| *value > 0)
                .unwrap_or(now);
            tx.execute(
                r#"
                INSERT OR REPLACE INTO memo_todos
                    (memo_id, content, status, priority, time_range, owner, assignee, created_at, updated_at, position)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                "#,
                params![
                    entry.id,
                    todo.content,
                    todo.status,
                    existing.map(|entry| entry.priority.as_str()).unwrap_or(""),
                    existing.map(|entry| entry.time_range.as_str()).unwrap_or(""),
                    existing.map(|entry| entry.owner.as_str()).unwrap_or(""),
                    existing.map(|entry| entry.assignee.as_str()).unwrap_or(""),
                    created_at,
                    updated_at,
                    position as i64,
                ],
            )
            .map_err(sqlite_to_io)?;
        }
        for (position, agent) in entry.agents.iter().enumerate() {
            tx.execute(
                r#"
                INSERT OR REPLACE INTO memo_agents
                    (memo_id, thread_id, title, agent_type, position)
                VALUES (?1, ?2, ?3, ?4, ?5)
                "#,
                params![
                    entry.id,
                    agent.thread_id,
                    agent.title,
                    agent.agent_type,
                    position as i64,
                ],
            )
            .map_err(sqlite_to_io)?;
        }
        Ok(())
    }

    fn read_existing_todo_metadata_in_tx(
        tx: &rusqlite::Transaction<'_>,
        memo_id: &str,
    ) -> std::io::Result<Vec<MemoTodoEntry>> {
        let mut stmt = tx
            .prepare(
                r#"
                SELECT content, status, memo_id, priority, time_range, owner, assignee, created_at, updated_at
                FROM memo_todos
                WHERE memo_id = ?1
                "#,
            )
            .map_err(sqlite_to_io)?;
        let rows = stmt
            .query_map(params![memo_id], |row| {
                Ok(MemoTodoEntry {
                    content: row.get(0)?,
                    status: row.get(1)?,
                    memo_id: row.get(2)?,
                    priority: row.get(3)?,
                    time_range: row.get(4)?,
                    owner: row.get(5)?,
                    assignee: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })
            .map_err(sqlite_to_io)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_to_io)
    }

    pub(super) fn read_index_from_db(
        &self,
        conn: &Connection,
        notebook_id: &str,
    ) -> std::io::Result<Option<MemoIndexFile>> {
        let state: Option<(u32, i64)> = conn
            .query_row(
                "SELECT version, last_updated FROM memo_index_state WHERE notebook_id = ?1",
                params![notebook_id],
                |row| Ok((row.get::<_, i64>(0)? as u32, row.get(1)?)),
            )
            .optional()
            .map_err(sqlite_to_io)?;
        let Some((version, last_updated)) = state else {
            return Ok(None);
        };

        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, filename, relative_path, preview, thumbnail, created_at, updated_at, favorited, icon, properties
                FROM memos
                WHERE notebook_id = ?1
                ORDER BY created_at ASC, rowid ASC
                "#,
            )
            .map_err(sqlite_to_io)?;
        let rows = stmt
            .query_map(params![notebook_id], |row| {
                let id: String = row.get(0)?;
                Ok(MemoIndexEntry {
                    id,
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
                })
            })
            .map_err(sqlite_to_io)?;
        let mut memos = rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_to_io)?;

        for entry in &mut memos {
            entry.tags = self.read_entry_tags(conn, &entry.id)?;
            entry.colors = self.read_entry_colors(conn, &entry.id)?;
            entry.todos = self.read_entry_todos(conn, &entry.id)?;
            entry.agents = self.read_entry_agents(conn, &entry.id)?;
        }
        let memo_base = self.memo_base_for_notebook_id(notebook_id);
        self.backfill_missing_properties(conn, notebook_id, &memo_base, &mut memos)?;
        self.backfill_missing_agents(conn, notebook_id, &memo_base, &mut memos)?;
        self.backfill_missing_thumbnails(conn, notebook_id, &memo_base, &mut memos)?;

        Ok(Some(MemoIndexFile {
            version,
            last_updated,
            memos,
        }))
    }

    pub(super) fn current_cached_index(
        &self,
        notebook_id: &str,
    ) -> std::io::Result<Option<MemoIndexFile>> {
        let cached = self
            .index_cache
            .read()
            .expect("index_cache poisoned")
            .clone();
        let Some(cached) = cached else {
            return Ok(None);
        };
        let conn = self.open_memo_index_db()?;
        let db_last_updated = conn
            .query_row(
                "SELECT last_updated FROM memo_index_state WHERE notebook_id = ?1",
                params![notebook_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(sqlite_to_io)?;
        Ok((db_last_updated == Some(cached.last_updated)).then_some(cached))
    }

    pub(super) fn backfill_missing_properties(
        &self,
        conn: &Connection,
        notebook_id: &str,
        memo_base: &std::path::Path,
        memos: &mut [MemoIndexEntry],
    ) -> std::io::Result<()> {
        for entry in memos {
            if entry
                .properties
                .as_object()
                .map(|map| !map.is_empty())
                .unwrap_or(false)
            {
                continue;
            }

            let path = super::super::notebook_path_from_relative(memo_base, &entry.relative_path)
                .unwrap_or_else(|_| memo_base.join(&entry.filename));
            let Ok(content) = fs::read_to_string(path) else {
                continue;
            };
            let properties = extract_frontmatter_properties(&content);
            if properties
                .as_object()
                .map(|map| map.is_empty())
                .unwrap_or(true)
            {
                continue;
            }

            conn.execute(
                "UPDATE memos SET properties = ?1 WHERE notebook_id = ?2 AND id = ?3",
                params![
                    serde_json::to_string(&properties).unwrap_or_else(|_| "{}".to_string()),
                    notebook_id,
                    entry.id,
                ],
            )
            .map_err(sqlite_to_io)?;
            entry.properties = properties;
        }
        Ok(())
    }

    pub(super) fn backfill_missing_thumbnails(
        &self,
        conn: &Connection,
        notebook_id: &str,
        memo_base: &std::path::Path,
        memos: &mut [MemoIndexEntry],
    ) -> std::io::Result<()> {
        for entry in memos {
            if entry.thumbnail.as_deref().unwrap_or("").trim().is_empty() {
                let checked = conn
                    .query_row(
                        "SELECT thumbnail_checked FROM memos WHERE notebook_id = ?1 AND id = ?2",
                        params![notebook_id, entry.id],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()
                    .map_err(sqlite_to_io)?
                    .unwrap_or(0);
                if checked != 0 {
                    continue;
                }
            } else {
                continue;
            }

            let path = super::super::notebook_path_from_relative(memo_base, &entry.relative_path)
                .unwrap_or_else(|_| memo_base.join(&entry.filename));
            let thumbnail = fs::read_to_string(path)
                .ok()
                .and_then(|content| extract_thumbnail(&content));

            conn.execute(
                "UPDATE memos SET thumbnail = ?1, thumbnail_checked = 1 WHERE notebook_id = ?2 AND id = ?3",
                params![thumbnail, notebook_id, entry.id],
            )
            .map_err(sqlite_to_io)?;
            entry.thumbnail = thumbnail;
        }
        Ok(())
    }

    pub(super) fn backfill_missing_agents(
        &self,
        conn: &Connection,
        notebook_id: &str,
        memo_base: &std::path::Path,
        memos: &mut [MemoIndexEntry],
    ) -> std::io::Result<()> {
        for entry in memos {
            if !entry.agents.is_empty() {
                continue;
            }

            let checked = conn
                .query_row(
                    "SELECT agents_checked FROM memos WHERE notebook_id = ?1 AND id = ?2",
                    params![notebook_id, entry.id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(sqlite_to_io)?
                .unwrap_or(0);
            if checked != 0 {
                continue;
            }

            let path = super::super::notebook_path_from_relative(memo_base, &entry.relative_path)
                .unwrap_or_else(|_| memo_base.join(&entry.filename));
            let agents = fs::read_to_string(path)
                .ok()
                .map(|content| extract_agent_threads_from_body(&content))
                .unwrap_or_default();

            let tx = conn.unchecked_transaction().map_err(sqlite_to_io)?;
            tx.execute(
                "DELETE FROM memo_agents WHERE memo_id = ?1",
                params![entry.id],
            )
            .map_err(sqlite_to_io)?;
            for (position, agent) in agents.iter().enumerate() {
                tx.execute(
                    r#"
                    INSERT OR REPLACE INTO memo_agents
                        (memo_id, thread_id, title, agent_type, position)
                    VALUES (?1, ?2, ?3, ?4, ?5)
                    "#,
                    params![
                        entry.id,
                        agent.thread_id,
                        agent.title,
                        agent.agent_type,
                        position as i64,
                    ],
                )
                .map_err(sqlite_to_io)?;
            }
            tx.execute(
                "UPDATE memos SET agents_checked = 1 WHERE notebook_id = ?1 AND id = ?2",
                params![notebook_id, entry.id],
            )
            .map_err(sqlite_to_io)?;
            tx.commit().map_err(sqlite_to_io)?;
            entry.agents = agents;
        }
        Ok(())
    }

    pub(super) fn read_entry_tags(
        &self,
        conn: &Connection,
        memo_id: &str,
    ) -> std::io::Result<Vec<String>> {
        let mut stmt = conn
            .prepare("SELECT tag FROM memo_tags WHERE memo_id = ?1 ORDER BY rowid ASC")
            .map_err(sqlite_to_io)?;
        let rows = stmt
            .query_map(params![memo_id], |row| row.get(0))
            .map_err(sqlite_to_io)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_to_io)
    }

    pub(super) fn read_entry_colors(
        &self,
        conn: &Connection,
        memo_id: &str,
    ) -> std::io::Result<Vec<MemoColor>> {
        let mut stmt = conn
            .prepare("SELECT color FROM memo_colors WHERE memo_id = ?1 ORDER BY position ASC")
            .map_err(sqlite_to_io)?;
        let rows = stmt
            .query_map(params![memo_id], |row| row.get::<_, String>(0))
            .map_err(sqlite_to_io)?;
        Ok(rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_to_io)?
            .into_iter()
            .filter_map(|color| color_from_str(&color))
            .collect())
    }

    pub(super) fn read_entry_todos(
        &self,
        conn: &Connection,
        memo_id: &str,
    ) -> std::io::Result<Vec<TodoItem>> {
        let mut stmt = conn
            .prepare(
                "SELECT content, status FROM memo_todos WHERE memo_id = ?1 ORDER BY position ASC",
            )
            .map_err(sqlite_to_io)?;
        let rows = stmt
            .query_map(params![memo_id], |row| {
                Ok(TodoItem {
                    content: row.get(0)?,
                    status: row.get(1)?,
                })
            })
            .map_err(sqlite_to_io)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_to_io)
    }

    pub(super) fn read_entry_agents(
        &self,
        conn: &Connection,
        memo_id: &str,
    ) -> std::io::Result<Vec<AgentThreadItem>> {
        let mut stmt = conn
            .prepare(
                "SELECT thread_id, title, agent_type FROM memo_agents WHERE memo_id = ?1 ORDER BY position ASC",
            )
            .map_err(sqlite_to_io)?;
        let rows = stmt
            .query_map(params![memo_id], |row| {
                Ok(AgentThreadItem {
                    thread_id: row.get(0)?,
                    title: row.get(1)?,
                    agent_type: row.get(2)?,
                })
            })
            .map_err(sqlite_to_io)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_to_io)
    }
}
