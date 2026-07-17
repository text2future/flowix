//! Memo index storage backed by the global `index.db`.

use std::fs;
use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use super::derivation::{extract_agent_threads_from_body, extract_thumbnail};
use super::frontmatter::extract_frontmatter_properties;
use super::notebook::sqlite_to_io;
use super::types::{
    AgentThreadItem, Memo, MemoColor, MemoIndexEntry, MemoIndexFile, MemoLocation, MemoTodoEntry,
    NotebookConfig, TodoItem,
};
use super::MemoFile;

fn color_to_str(color: MemoColor) -> &'static str {
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

fn color_from_str(value: &str) -> Option<MemoColor> {
    match value {
        "red" => Some(MemoColor::Red),
        "orange" => Some(MemoColor::Orange),
        "yellow" => Some(MemoColor::Yellow),
        "green" => Some(MemoColor::Green),
        "cyan" => Some(MemoColor::Cyan),
        "blue" => Some(MemoColor::Blue),
        "gray" => Some(MemoColor::Gray),
        _ => None,
    }
}

impl MemoFile {
    pub fn storage_title_from_filename(filename: &str) -> String {
        let stem = filename.strip_suffix(".md").unwrap_or(filename).to_string();
        let safe_title = Self::sanitize_memo_filename_component(&stem);
        if safe_title.is_empty() {
            chrono::Local::now().format("untitled-%Y-%m-%d").to_string()
        } else {
            safe_title
        }
    }

    pub(crate) fn current_notebook_id_for_index(&self) -> String {
        self.current_notebook_id_value()
            .or_else(|| {
                self.read_notebook_configs()
                    .ok()
                    .and_then(|configs| configs.into_iter().next())
                    .map(|cfg| cfg.id)
            })
            .unwrap_or_else(|| "nb_default".to_string())
    }

    fn notebook_id_for_index(&self, notebook_id: Option<&str>) -> String {
        notebook_id
            .map(str::to_string)
            .unwrap_or_else(|| self.current_notebook_id_for_index())
    }

    fn memo_base_for_notebook_id(&self, notebook_id: &str) -> PathBuf {
        self.read_notebook_configs()
            .ok()
            .and_then(|configs| configs.into_iter().find(|cfg| cfg.id == notebook_id))
            .map(|config| PathBuf::from(config.path))
            .unwrap_or_else(|| self.get_default_notebook_path())
    }

    fn ensure_memo_tables(&self, conn: &Connection) -> std::io::Result<()> {
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS memo_index_state (
                notebook_id TEXT PRIMARY KEY,
                version INTEGER NOT NULL,
                last_updated INTEGER NOT NULL,
                migrated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS memos (
                id TEXT PRIMARY KEY,
                notebook_id TEXT NOT NULL,
                filename TEXT NOT NULL,
                preview TEXT NOT NULL,
                thumbnail TEXT,
                thumbnail_checked INTEGER NOT NULL DEFAULT 0,
                agents_checked INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                favorited INTEGER NOT NULL,
                icon TEXT,
                properties TEXT NOT NULL DEFAULT '{}',
                FOREIGN KEY(notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
                UNIQUE(notebook_id, filename)
            );
            CREATE INDEX IF NOT EXISTS idx_memos_notebook_created
                ON memos(notebook_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memos_notebook_updated
                ON memos(notebook_id, updated_at DESC);
            CREATE TABLE IF NOT EXISTS memo_tags (
                memo_id TEXT NOT NULL,
                tag TEXT NOT NULL,
                PRIMARY KEY(memo_id, tag),
                FOREIGN KEY(memo_id) REFERENCES memos(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS memo_colors (
                memo_id TEXT NOT NULL,
                color TEXT NOT NULL,
                position INTEGER NOT NULL,
                PRIMARY KEY(memo_id, color),
                FOREIGN KEY(memo_id) REFERENCES memos(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS memo_todos (
                memo_id TEXT NOT NULL,
                content TEXT NOT NULL,
                status TEXT NOT NULL,
                priority TEXT NOT NULL DEFAULT '',
                time_range TEXT NOT NULL DEFAULT '',
                owner TEXT NOT NULL DEFAULT '',
                assignee TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0,
                position INTEGER NOT NULL,
                PRIMARY KEY(memo_id, content),
                FOREIGN KEY(memo_id) REFERENCES memos(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS memo_agents (
                memo_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                agent_type TEXT NOT NULL DEFAULT '',
                position INTEGER NOT NULL,
                PRIMARY KEY(memo_id, thread_id),
                FOREIGN KEY(memo_id) REFERENCES memos(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_memo_agents_memo_id
                ON memo_agents(memo_id);
            "#,
        )
        .map_err(sqlite_to_io)?;
        Ok(())
    }

    pub(crate) fn open_memo_index_db(&self) -> std::io::Result<Connection> {
        let conn = self.open_index_db()?;
        self.ensure_memo_tables(&conn)?;
        Ok(conn)
    }

    fn mark_index_state(
        &self,
        conn: &Connection,
        notebook_id: &str,
        version: u32,
        last_updated: i64,
    ) -> std::io::Result<()> {
        conn.execute(
            r#"
            INSERT INTO memo_index_state
                (notebook_id, version, last_updated, migrated_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(notebook_id) DO UPDATE SET
                version = MAX(memo_index_state.version, excluded.version),
                last_updated = MAX(memo_index_state.last_updated + 1, excluded.last_updated)
            "#,
            params![
                notebook_id,
                version as i64,
                last_updated,
                chrono::Utc::now().timestamp_millis(),
            ],
        )
        .map_err(sqlite_to_io)?;
        Ok(())
    }

    fn replace_notebook_index_in_db(
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

    fn upsert_entry_in_tx(
        tx: &rusqlite::Transaction<'_>,
        notebook_id: &str,
        entry: &MemoIndexEntry,
    ) -> std::io::Result<()> {
        tx.execute(
            r#"
            INSERT INTO memos
                (id, notebook_id, filename, preview, thumbnail, thumbnail_checked, agents_checked, created_at, updated_at, favorited, icon, properties)
            VALUES (?1, ?2, ?3, ?4, ?5, 1, 1, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(id) DO UPDATE SET
                notebook_id = excluded.notebook_id,
                filename = excluded.filename,
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
        Self::replace_entry_children_in_tx(tx, entry)
    }

    fn replace_entry_children_in_tx(
        tx: &rusqlite::Transaction<'_>,
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

    fn read_index_from_db(
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
                SELECT id, filename, preview, thumbnail, created_at, updated_at, favorited, icon, properties
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

    fn current_cached_index(&self, notebook_id: &str) -> std::io::Result<Option<MemoIndexFile>> {
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

    fn backfill_missing_properties(
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

            let path = memo_base.join(&entry.filename);
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

    fn backfill_missing_thumbnails(
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

            let path = memo_base.join(&entry.filename);
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

    fn backfill_missing_agents(
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

            let path = memo_base.join(&entry.filename);
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

    fn read_entry_tags(&self, conn: &Connection, memo_id: &str) -> std::io::Result<Vec<String>> {
        let mut stmt = conn
            .prepare("SELECT tag FROM memo_tags WHERE memo_id = ?1 ORDER BY rowid ASC")
            .map_err(sqlite_to_io)?;
        let rows = stmt
            .query_map(params![memo_id], |row| row.get(0))
            .map_err(sqlite_to_io)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_to_io)
    }

    fn read_entry_colors(
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

    fn read_entry_todos(&self, conn: &Connection, memo_id: &str) -> std::io::Result<Vec<TodoItem>> {
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

    fn read_entry_agents(
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
                    let is_default: i64 = row.get(13)?;
                    Ok((
                        MemoIndexEntry {
                            id: memo_id,
                            filename: row.get(1)?,
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
                            id: row.get(9)?,
                            name: row.get(10)?,
                            icon: row.get(11)?,
                            path: row.get(12)?,
                            is_default: is_default != 0,
                            created_at: row.get(14)?,
                            updated_at: row.get(15)?,
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

    pub fn read_used_tag_ids(&self) -> std::io::Result<Vec<String>> {
        let list = self.read_index_result()?.unwrap_or_default();
        Self::used_tag_ids_from_index(list)
    }

    pub fn read_used_tag_ids_for_notebook_id(
        &self,
        notebook_id: Option<&str>,
    ) -> std::io::Result<Vec<String>> {
        let list = self
            .read_index_for_notebook_id(notebook_id)?
            .unwrap_or_default();
        Self::used_tag_ids_from_index(list)
    }

    pub fn read_tag_usage_summary_for_notebook_id(
        &self,
        notebook_id: Option<&str>,
    ) -> std::io::Result<(Vec<String>, Vec<(String, usize)>, usize, usize, usize)> {
        let notebook_id = self.notebook_id_for_index(notebook_id);
        let _ = self.read_index_for_notebook_id(Some(&notebook_id));
        let conn = self.open_memo_index_db()?;
        let total_count = conn
            .query_row(
                "SELECT COUNT(*) FROM memos WHERE notebook_id = ?1",
                params![notebook_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(sqlite_to_io)? as usize;
        let agent_memo_count = conn
            .query_row(
                r#"
                SELECT COUNT(DISTINCT ma.memo_id)
                FROM memo_agents ma
                JOIN memos m ON m.id = ma.memo_id
                WHERE m.notebook_id = ?1
                "#,
                params![notebook_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(sqlite_to_io)? as usize;
        let todo_memo_count = conn
            .query_row(
                r#"
                SELECT COUNT(DISTINCT mt.memo_id)
                FROM memo_todos mt
                JOIN memos m ON m.id = mt.memo_id
                WHERE m.notebook_id = ?1
                "#,
                params![notebook_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(sqlite_to_io)? as usize;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT mt.tag, COUNT(*)
                FROM memo_tags mt
                JOIN memos m ON m.id = mt.memo_id
                WHERE m.notebook_id = ?1
                GROUP BY mt.tag
                ORDER BY mt.tag COLLATE NOCASE ASC
                "#,
            )
            .map_err(sqlite_to_io)?;
        let rows = stmt
            .query_map(params![notebook_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as usize))
            })
            .map_err(sqlite_to_io)?;
        let tag_counts = rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_to_io)?;
        let used_tag_ids = tag_counts.iter().map(|(tag, _)| tag.clone()).collect();
        Ok((
            used_tag_ids,
            tag_counts,
            total_count,
            agent_memo_count,
            todo_memo_count,
        ))
    }

    fn used_tag_ids_from_index(list: MemoIndexFile) -> std::io::Result<Vec<String>> {
        let mut used = Vec::new();
        for memo in list.memos {
            for tag in memo.tags {
                if !used.contains(&tag) {
                    used.push(tag);
                }
            }
        }
        Ok(used)
    }

    /// 路径式 tag 的 prefix → 去重 memo 数。每个真实 tag `T` 拆出
    /// 所有前缀 (`T` 自身 + `T` 的每级祖先 fullPath), 然后每个 prefix
    /// 收集所有"挂载了 T 的 memo id", 取 set 长度 (即有任意 tag
    /// 落在 prefix 之下的 distinct memo 数)。
    ///
    /// **为什么需要**: 之前侧栏 tree 用 `tagCounts` 累加, 一个 memo
    /// 既有 `#中国/湖南` 又有 `#中国/广东` 会被 `中国` 节点算两次。
    /// 现在用 distinct memo_id, 1 个 memo 即使挂了多个子 tag, 父节点
    /// 也只算 1。
    ///
    /// O(N×L) where N = (tag, memo) pairs, L = 平均路径深度。典型
    /// 库 (10K memos × 3 tags × depth 2) ~ 60K HashMap insert, 远低于
    /// 1ms, 不需要 SQL 聚合优化。
    pub fn read_tag_prefix_counts_for_notebook_id(
        &self,
        notebook_id: Option<&str>,
    ) -> std::io::Result<std::collections::HashMap<String, usize>> {
        use std::collections::{HashMap, HashSet};

        let conn = self.open_memo_index_db()?;
        let notebook_id = self.notebook_id_for_index(notebook_id);

        let mut stmt = conn
            .prepare(
                "SELECT mt.tag, mt.memo_id
                 FROM memo_tags mt
                 JOIN memos m ON m.id = mt.memo_id
                 WHERE m.notebook_id = ?1",
            )
            .map_err(sqlite_to_io)?;
        let pairs: Vec<(String, String)> = stmt
            .query_map(rusqlite::params![&notebook_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(sqlite_to_io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_to_io)?;

        let mut prefix_to_memos: HashMap<String, HashSet<String>> = HashMap::new();
        for (tag, memo_id) in &pairs {
            let segments: Vec<&str> = tag.split('/').collect();
            for i in 1..=segments.len() {
                let prefix = segments[..i].join("/");
                prefix_to_memos
                    .entry(prefix)
                    .or_default()
                    .insert(memo_id.clone());
            }
        }

        Ok(prefix_to_memos
            .into_iter()
            .map(|(k, v)| (k, v.len()))
            .collect())
    }

    pub fn read_todo_metadata_entries(&self, sort: &str) -> std::io::Result<Vec<MemoTodoEntry>> {
        self.read_todo_metadata_entries_for_notebook_id(None, sort)
    }

    pub fn read_todo_metadata_entries_for_notebook_id(
        &self,
        notebook_id: Option<&str>,
        sort: &str,
    ) -> std::io::Result<Vec<MemoTodoEntry>> {
        let notebook_id = self.notebook_id_for_index(notebook_id);
        let conn = self.open_memo_index_db()?;
        let order = if sort == "updatedAt" {
            "t.updated_at DESC, t.created_at DESC"
        } else {
            "t.created_at DESC, t.updated_at DESC"
        };
        let sql = format!(
            r#"
            SELECT t.content, t.status, t.memo_id, t.priority, t.time_range, t.owner, t.assignee,
                   t.created_at, t.updated_at
            FROM memo_todos t
            JOIN memos m ON m.id = t.memo_id
            WHERE m.notebook_id = ?1
            ORDER BY {order}
            "#
        );
        let mut stmt = conn.prepare(&sql).map_err(sqlite_to_io)?;
        let rows = stmt
            .query_map(params![notebook_id], |row| {
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
}
