use super::*;

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

    pub(crate) fn notebook_id_for_index(&self, notebook_id: Option<&str>) -> String {
        notebook_id
            .map(str::to_string)
            .unwrap_or_else(|| self.current_notebook_id_for_index())
    }

    pub(super) fn memo_base_for_notebook_id(&self, notebook_id: &str) -> PathBuf {
        self.read_notebook_configs()
            .ok()
            .and_then(|configs| configs.into_iter().find(|cfg| cfg.id == notebook_id))
            .map(|config| PathBuf::from(config.path))
            .unwrap_or_else(|| self.get_default_notebook_path())
    }

    fn ensure_memo_tables(&self, conn: &Connection) -> std::io::Result<()> {
        // Remove retired ID-backed state even if an earlier upgrade already
        // replaced `memos.id` but left these tables behind.
        let (has_legacy_id, has_retired_id_tables): (bool, bool) = conn
            .query_row(
                "SELECT
                    EXISTS(SELECT 1 FROM pragma_table_info('memos') WHERE name = 'id')
                        OR EXISTS(SELECT 1 FROM pragma_table_info('memo_agents') WHERE name = 'memo_id')
                        OR EXISTS(SELECT 1 FROM pragma_table_info('memo_colors') WHERE name = 'memo_id'),
                    EXISTS(
                        SELECT 1 FROM sqlite_master
                        WHERE type = 'table'
                          AND name IN (
                              'memo_content_revisions',
                              'pending_external_memo_creates',
                              'memo_lifecycles',
                              'schema_migrations'
                          )
                    )",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(sqlite_to_io)?;
        if has_retired_id_tables {
            conn.execute_batch(
                "DROP TABLE IF EXISTS memo_content_revisions;
                 DROP TABLE IF EXISTS pending_external_memo_creates;
                 DROP TABLE IF EXISTS memo_lifecycles;
                 DROP TABLE IF EXISTS schema_migrations;",
            )
            .map_err(sqlite_to_io)?;
        }

        // Rebuild the older cache if any of its tables still use memo IDs.
        // Markdown remains the source of truth for every dropped projection.
        if has_legacy_id {
            conn.execute_batch(
                "DROP TABLE IF EXISTS memo_todos;
                 DROP TABLE IF EXISTS memo_tags;
                 DROP TABLE IF EXISTS memo_agents;
                 DROP TABLE IF EXISTS memo_colors;
                 DROP TABLE IF EXISTS memos;
                 DROP TABLE IF EXISTS memo_index_state;",
            )
            .map_err(sqlite_to_io)?;
        }
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS notebooks (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                icon TEXT,
                path TEXT NOT NULL UNIQUE,
                is_default INTEGER NOT NULL,
                sort INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS memo_index_state (
                notebook_id TEXT PRIMARY KEY,
                version INTEGER NOT NULL,
                last_updated INTEGER NOT NULL,
                migrated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS notebook_data_migrations (
                notebook_id TEXT NOT NULL,
                migration_key TEXT NOT NULL,
                version INTEGER NOT NULL,
                completed_at INTEGER NOT NULL,
                PRIMARY KEY(notebook_id, migration_key)
            );
            CREATE TABLE IF NOT EXISTS memos (
                notebook_id TEXT NOT NULL,
                filename TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                preview TEXT NOT NULL,
                thumbnail TEXT,
                thumbnail_checked INTEGER NOT NULL DEFAULT 0,
                agents_checked INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                favorited INTEGER NOT NULL,
                icon TEXT,
                properties TEXT NOT NULL DEFAULT '{}',
                PRIMARY KEY(relative_path),
                FOREIGN KEY(notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_memos_notebook_created
                ON memos(notebook_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memos_notebook_updated
                ON memos(notebook_id, updated_at DESC);
            CREATE TABLE IF NOT EXISTS notebook_tags (
                notebook_id TEXT NOT NULL,
                path TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(notebook_id, path),
                FOREIGN KEY(notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_notebook_tags_notebook
                ON notebook_tags(notebook_id);
            CREATE TABLE IF NOT EXISTS memo_colors (
                relative_path TEXT NOT NULL,
                color TEXT NOT NULL,
                position INTEGER NOT NULL,
                PRIMARY KEY(relative_path, color),
                FOREIGN KEY(relative_path) REFERENCES memos(relative_path) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS memo_agents (
                relative_path TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                agent_type TEXT NOT NULL DEFAULT '',
                position INTEGER NOT NULL,
                PRIMARY KEY(relative_path, thread_id),
                FOREIGN KEY(relative_path) REFERENCES memos(relative_path) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_memo_agents_relative_path
                ON memo_agents(relative_path);
            "#,
        )
        .map_err(sqlite_to_io)?;
        conn.execute_batch(
            "DROP TRIGGER IF EXISTS trg_memo_tags_register_notebook_tag; \
             DROP TABLE IF EXISTS memo_tags; \
             DROP TABLE IF EXISTS memo_todos;",
        )
        .map_err(sqlite_to_io)?;
        Ok(())
    }

    fn ensure_local_notebook_row(
        &self,
        conn: &Connection,
        notebook_id: &str,
    ) -> std::io::Result<()> {
        let config = self.get_notebook_config_by_id(notebook_id).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("notebook not found: {notebook_id}"),
            )
        })?;
        conn.execute(
            "INSERT INTO notebooks (id, name, icon, path, is_default, sort, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name, icon = excluded.icon, path = excluded.path,
               is_default = excluded.is_default, sort = excluded.sort,
               created_at = excluded.created_at, updated_at = excluded.updated_at",
            params![
                config.id,
                config.name,
                config.icon,
                config.path,
                if config.is_default { 1 } else { 0 },
                config.sort,
                config.created_at,
                config.updated_at,
            ],
        )
        .map_err(sqlite_to_io)?;
        Ok(())
    }

    pub(crate) fn open_memo_index_db_for_notebook_id(
        &self,
        notebook_id: &str,
    ) -> std::io::Result<Connection> {
        let conn = self.open_notebook_db(notebook_id)?;
        self.ensure_memo_tables(&conn)?;
        self.ensure_local_notebook_row(&conn, notebook_id)?;
        Ok(conn)
    }

    pub(crate) fn open_memo_index_db(&self) -> std::io::Result<Connection> {
        let notebook_id = self.current_notebook_id_for_index();
        self.open_memo_index_db_for_notebook_id(&notebook_id)
    }

    /// Atomically records a stable content revision for one note, addressed by
    /// `(notebook_id, relative_path)`.
    ///
    /// Re-observing identical bytes returns the existing revision/change id.
    /// Returning to an older hash after another commit is a new transition and
    /// therefore advances the counter as well.
    pub fn commit_note_content_revision(
        &self,
        notebook_id: &str,
        relative_path: &str,
        content_hash: &str,
        next_change_id: &str,
    ) -> std::io::Result<NoteContentCommit> {
        self.commit_note_content_revision_internal(
            notebook_id,
            relative_path,
            content_hash,
            next_change_id,
            None,
        )?
        .ok_or_else(|| std::io::Error::other("unconditional revision commit was rejected"))
    }

    pub fn commit_note_content_revision_if_current(
        &self,
        notebook_id: &str,
        relative_path: &str,
        content_hash: &str,
        next_change_id: &str,
        expected: Option<&NoteContentRevision>,
    ) -> std::io::Result<Option<NoteContentCommit>> {
        self.commit_note_content_revision_internal(
            notebook_id,
            relative_path,
            content_hash,
            next_change_id,
            Some(expected),
        )
    }

    fn commit_note_content_revision_internal(
        &self,
        notebook_id: &str,
        relative_path: &str,
        content_hash: &str,
        next_change_id: &str,
        expected: Option<Option<&NoteContentRevision>>,
    ) -> std::io::Result<Option<NoteContentCommit>> {
        let mut conn = self.open_note_index_connection(notebook_id)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_to_io)?;
        let current = tx
            .query_row(
                "SELECT content_hash, local_revision, change_id, updated_at
                 FROM note_content_revisions WHERE notebook_id = ?1 AND relative_path = ?2",
                params![notebook_id, relative_path],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(sqlite_to_io)?;

        if let Some(expected) = expected {
            let matches = match (expected, current.as_ref()) {
                (None, None) => true,
                (Some(expected), Some((hash, revision, change_id, _))) => {
                    expected.relative_path == relative_path
                        && expected.content_hash == *hash
                        && expected.revision == *revision
                        && expected.change_id == *change_id
                }
                _ => false,
            };
            if !matches {
                return Ok(None);
            }
        }

        if let Some((existing_hash, revision, change_id, updated_at)) = current.as_ref() {
            if existing_hash == content_hash {
                tx.commit().map_err(sqlite_to_io)?;
                return Ok(Some(NoteContentCommit {
                    state: NoteContentRevision {
                        notebook_id: notebook_id.to_string(),
                        relative_path: relative_path.to_string(),
                        content_hash: existing_hash.clone(),
                        revision: *revision,
                        change_id: change_id.clone(),
                        updated_at: *updated_at,
                    },
                    changed: false,
                }));
            }
        }

        let revision = current
            .as_ref()
            .map(|(_, revision, _, _)| revision.saturating_add(1))
            .unwrap_or(1);
        let updated_at = chrono::Utc::now().timestamp_millis();
        tx.execute(
            r#"
            INSERT INTO note_content_revisions
                (notebook_id, relative_path, content_hash, local_revision, change_id, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(notebook_id, relative_path) DO UPDATE SET
                content_hash = excluded.content_hash,
                local_revision = excluded.local_revision,
                change_id = excluded.change_id,
                updated_at = excluded.updated_at
            "#,
            params![
                notebook_id,
                relative_path,
                content_hash,
                revision,
                next_change_id,
                updated_at,
            ],
        )
        .map_err(sqlite_to_io)?;
        tx.commit().map_err(sqlite_to_io)?;

        Ok(Some(NoteContentCommit {
            state: NoteContentRevision {
                notebook_id: notebook_id.to_string(),
                relative_path: relative_path.to_string(),
                content_hash: content_hash.to_string(),
                revision,
                change_id: next_change_id.to_string(),
                updated_at,
            },
            changed: true,
        }))
    }

    /// Mutation callers already know the notebook. Avoid opening every local
    /// database, especially for newly created notes with no revision yet.
    pub fn read_note_content_revision_for_notebook(
        &self,
        notebook_id: &str,
        relative_path: &str,
    ) -> std::io::Result<Option<NoteContentRevision>> {
        let conn = self.open_note_index_connection(notebook_id)?;
        conn.query_row(
            "SELECT content_hash, local_revision, change_id, updated_at
             FROM note_content_revisions WHERE notebook_id = ?1 AND relative_path = ?2",
            params![notebook_id, relative_path],
            |row| {
                Ok(NoteContentRevision {
                    notebook_id: notebook_id.to_string(),
                    relative_path: relative_path.to_string(),
                    content_hash: row.get(0)?,
                    revision: row.get(1)?,
                    change_id: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(sqlite_to_io)
    }

    /// Carry the path-keyed revision stream over when a note is renamed or
    /// moved. A missing source row is not an error (the note may simply have
    /// no revision history yet).
    pub fn rekey_note_content_revision(
        &self,
        notebook_id: &str,
        old_relative_path: &str,
        new_relative_path: &str,
    ) -> std::io::Result<()> {
        if old_relative_path == new_relative_path {
            return Ok(());
        }
        let mut conn = self.open_note_index_connection(notebook_id)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_to_io)?;
        tx.execute(
            "UPDATE OR REPLACE note_content_revisions
             SET relative_path = ?3 WHERE notebook_id = ?1 AND relative_path = ?2",
            params![notebook_id, old_relative_path, new_relative_path],
        )
        .map_err(sqlite_to_io)?;
        tx.commit().map_err(sqlite_to_io)?;
        Ok(())
    }

    pub(super) fn mark_index_state(
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

    pub fn notebook_data_migration_version(
        &self,
        notebook_id: &str,
        migration_key: &str,
    ) -> std::io::Result<Option<u32>> {
        let read_version = |conn: &Connection| {
            conn.query_row(
                "SELECT version FROM notebook_data_migrations
                 WHERE notebook_id = ?1 AND migration_key = ?2",
                params![notebook_id, migration_key],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map(|version| version.map(|value| value.max(0) as u32))
            .map_err(sqlite_to_io)
        };

        // Completed notebook migrations are checked on every startup. Read
        // their marker without running the full memo schema setup and legacy
        // import. A new notebook still takes the normal initialization path.
        let path = self.notebook_db_path(notebook_id)?;
        if path.is_file() {
            let conn =
                Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .map_err(sqlite_to_io)?;
            conn.busy_timeout(std::time::Duration::from_secs(10))
                .map_err(sqlite_to_io)?;
            let has_marker_table: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master
                     WHERE type = 'table' AND name = 'notebook_data_migrations')",
                    [],
                    |row| row.get(0),
                )
                .map_err(sqlite_to_io)?;
            if has_marker_table {
                return read_version(&conn);
            }
        }
        // Reading a marker must never initialize or retire legacy Memo tables.
        Ok(None)
    }

    pub fn mark_notebook_data_migration(
        &self,
        notebook_id: &str,
        migration_key: &str,
        version: u32,
    ) -> std::io::Result<()> {
        // Recording an artifact migration does not require the legacy Memo schema:
        // ensure_memo_tables may discard ID-backed tables and revision history.
        let conn = self.open_notebook_db(notebook_id)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS notebook_data_migrations (
            notebook_id TEXT NOT NULL, migration_key TEXT NOT NULL,
            version INTEGER NOT NULL, completed_at INTEGER NOT NULL,
            PRIMARY KEY(notebook_id, migration_key));",
        )
        .map_err(sqlite_to_io)?;
        conn.execute(
            "INSERT INTO notebook_data_migrations
                (notebook_id, migration_key, version, completed_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(notebook_id, migration_key) DO UPDATE SET
                version = MAX(notebook_data_migrations.version, excluded.version),
                completed_at = excluded.completed_at",
            params![
                notebook_id,
                migration_key,
                version as i64,
                chrono::Utc::now().timestamp_millis(),
            ],
        )
        .map_err(sqlite_to_io)?;
        Ok(())
    }
}
