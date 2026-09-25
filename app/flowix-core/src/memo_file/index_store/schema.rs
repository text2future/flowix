use super::*;
use std::sync::{LazyLock, Mutex};

static MEMO_RELATIVE_PATH_MIGRATION_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

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

    pub(super) fn notebook_id_for_index(&self, notebook_id: Option<&str>) -> String {
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
            CREATE TABLE IF NOT EXISTS schema_migrations (
                migration_key TEXT PRIMARY KEY,
                completed_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS memos (
                id TEXT PRIMARY KEY,
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
                FOREIGN KEY(notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
                UNIQUE(notebook_id, relative_path)
            );
            CREATE INDEX IF NOT EXISTS idx_memos_notebook_created
                ON memos(notebook_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memos_notebook_updated
                ON memos(notebook_id, updated_at DESC);
            CREATE TABLE IF NOT EXISTS pending_external_memo_creates (
                memo_id TEXT PRIMARY KEY,
                notebook_id TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS memo_lifecycles (
                memo_id TEXT PRIMARY KEY,
                notebook_id TEXT NOT NULL,
                relative_path TEXT NOT NULL DEFAULT '',
                generation INTEGER NOT NULL DEFAULT 1,
                is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1)),
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                deleted_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_memo_lifecycles_notebook
                ON memo_lifecycles(notebook_id, is_deleted);
            CREATE TABLE IF NOT EXISTS memo_content_revisions (
                memo_id TEXT PRIMARY KEY,
                notebook_id TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                local_revision INTEGER NOT NULL,
                change_id TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(memo_id) REFERENCES memo_lifecycles(memo_id) ON DELETE RESTRICT
            );
            CREATE INDEX IF NOT EXISTS idx_memo_content_revisions_notebook
                ON memo_content_revisions(notebook_id);
            CREATE TABLE IF NOT EXISTS memo_tags (
                memo_id TEXT NOT NULL,
                tag TEXT NOT NULL,
                PRIMARY KEY(memo_id, tag),
                FOREIGN KEY(memo_id) REFERENCES memos(id) ON DELETE CASCADE
            );
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
            CREATE TRIGGER IF NOT EXISTS trg_memo_tags_register_notebook_tag
            AFTER INSERT ON memo_tags
            BEGIN
                INSERT OR IGNORE INTO notebook_tags
                    (notebook_id, path, created_at, updated_at)
                SELECT
                    m.notebook_id,
                    NEW.tag,
                    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
                    CAST(strftime('%s', 'now') AS INTEGER) * 1000
                FROM memos m
                WHERE m.id = NEW.memo_id;
            END;
            CREATE TABLE IF NOT EXISTS memo_colors (
                memo_id TEXT NOT NULL,
                color TEXT NOT NULL,
                position INTEGER NOT NULL,
                PRIMARY KEY(memo_id, color),
                FOREIGN KEY(memo_id) REFERENCES memos(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS memo_todos (
                memo_id TEXT NOT NULL,
                todo_id TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL,
                status TEXT NOT NULL,
                priority TEXT NOT NULL DEFAULT '',
                time_range TEXT NOT NULL DEFAULT '',
                owner TEXT NOT NULL DEFAULT '',
                assignee TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0,
                position INTEGER NOT NULL,
                PRIMARY KEY(memo_id, todo_id),
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
        self.migrate_memo_relative_paths(conn)?;
        self.migrate_memo_todo_ids(conn)?;
        self.migrate_memo_lifecycles(conn)?;
        conn.execute_batch(
            r#"
            INSERT OR IGNORE INTO notebook_tags
                (notebook_id, path, created_at, updated_at)
            SELECT DISTINCT
                m.notebook_id,
                mt.tag,
                CAST(strftime('%s', 'now') AS INTEGER) * 1000,
                CAST(strftime('%s', 'now') AS INTEGER) * 1000
            FROM memo_tags mt
            JOIN memos m ON m.id = mt.memo_id
            WHERE NOT EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE migration_key = 'notebook_tags_v1'
            );

            INSERT OR IGNORE INTO schema_migrations (migration_key, completed_at)
            VALUES (
                'notebook_tags_v1',
                CAST(strftime('%s', 'now') AS INTEGER) * 1000
            );
            "#,
        )
        .map_err(sqlite_to_io)?;
        Ok(())
    }

    /// Upgrade the v3 index where filename was the notebook-relative
    /// location. Keep filename as the basename and make relative_path the
    /// durable location identity so same-named notes can coexist in folders.
    fn migrate_memo_relative_paths(&self, conn: &Connection) -> std::io::Result<()> {
        // Multiple MemoFile instances can open the same index during startup.
        // The per-instance RMW mutex cannot protect schema setup, so combine a
        // process-wide guard with SQLite's write transaction. The second
        // connection re-checks the marker after it acquires the database lock.
        let _migration_guard = MEMO_RELATIVE_PATH_MIGRATION_LOCK
            .lock()
            .expect("memo migration lock poisoned");

        // Existing installations have the old UNIQUE(notebook_id, filename)
        // constraint, which cannot be dropped in place. Rebuild the metadata
        // table while preserving child tables and memo ids. SQLite DDL is
        // transactional, so a crash must leave either the old or new schema.
        conn.execute_batch("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;")
            .map_err(sqlite_to_io)?;
        let result = (|| -> std::io::Result<()> {
            let done: Option<String> = conn
                .query_row(
                    "SELECT migration_key FROM schema_migrations WHERE migration_key = 'memo_relative_paths_v1'",
                    [],
                    |row| row.get(0),
                )
                .optional()
                .map_err(sqlite_to_io)?;
            if done.is_some() {
                return Ok(());
            }

            let has_relative_path = conn
                .prepare("PRAGMA table_info(memos)")
                .and_then(|mut statement| {
                    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
                    rows.collect::<Result<Vec<_>, _>>()
                })
                .map_err(sqlite_to_io)?
                .into_iter()
                .any(|name| name == "relative_path");

            let recovery_table_exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memos_relative_paths_v1')",
                    [],
                    |row| row.get(0),
                )
                .map_err(sqlite_to_io)?;

            // Recover databases left by the earlier non-transactional
            // migration. It could copy every memo into the replacement table
            // and leave the live table empty without writing the marker.
            if has_relative_path {
                if recovery_table_exists {
                    let live_count: i64 = conn
                        .query_row("SELECT COUNT(*) FROM memos", [], |row| row.get(0))
                        .map_err(sqlite_to_io)?;
                    let recovery_count: i64 = conn
                        .query_row("SELECT COUNT(*) FROM memos_relative_paths_v1", [], |row| {
                            row.get(0)
                        })
                        .map_err(sqlite_to_io)?;
                    if live_count == 0 && recovery_count > 0 {
                        conn.execute_batch(
                            r#"
                            DROP TRIGGER IF EXISTS trg_memo_tags_register_notebook_tag;
                            DROP TABLE memos;
                            ALTER TABLE memos_relative_paths_v1 RENAME TO memos;
                            "#,
                        )
                        .map_err(sqlite_to_io)?;
                    } else {
                        conn.execute_batch("DROP TABLE memos_relative_paths_v1;")
                            .map_err(sqlite_to_io)?;
                    }
                }
                Self::finish_memo_relative_path_migration(conn)?;
                return Ok(());
            }

            conn.execute_batch("DROP TABLE IF EXISTS memos_relative_paths_v1;")
                .map_err(sqlite_to_io)?;
            conn.execute("ALTER TABLE memos ADD COLUMN relative_path TEXT", [])
                .map_err(sqlite_to_io)?;
            conn.execute_batch(
                r#"
                CREATE TABLE memos_relative_paths_v1 (
                    id TEXT PRIMARY KEY,
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
                    FOREIGN KEY(notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
                    UNIQUE(notebook_id, relative_path)
                );
                INSERT INTO memos_relative_paths_v1
                    (id, notebook_id, filename, relative_path, preview, thumbnail,
                     thumbnail_checked, agents_checked, created_at, updated_at,
                     favorited, icon, properties)
                SELECT id, notebook_id, filename,
                    COALESCE(NULLIF(relative_path, ''), filename),
                    preview, thumbnail, thumbnail_checked, agents_checked,
                    created_at, updated_at, favorited, icon, properties
                FROM memos;
                DROP TRIGGER IF EXISTS trg_memo_tags_register_notebook_tag;
                DROP TABLE memos;
                ALTER TABLE memos_relative_paths_v1 RENAME TO memos;
                "#,
            )
            .map_err(sqlite_to_io)?;
            Self::finish_memo_relative_path_migration(conn)?;
            Ok(())
        })();
        let transaction = match result {
            Ok(()) => conn.execute_batch("COMMIT;").map_err(sqlite_to_io),
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK;");
                Err(error)
            }
        };
        let restore = conn
            .execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(sqlite_to_io);
        transaction.and(restore)
    }

    fn finish_memo_relative_path_migration(conn: &Connection) -> std::io::Result<()> {
        conn.execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS idx_memos_notebook_created
                ON memos(notebook_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memos_notebook_updated
                ON memos(notebook_id, updated_at DESC);
            CREATE TRIGGER IF NOT EXISTS trg_memo_tags_register_notebook_tag
            AFTER INSERT ON memo_tags
            BEGIN
                INSERT OR IGNORE INTO notebook_tags
                    (notebook_id, path, created_at, updated_at)
                SELECT
                    m.notebook_id,
                    NEW.tag,
                    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
                    CAST(strftime('%s', 'now') AS INTEGER) * 1000
                FROM memos m
                WHERE m.id = NEW.memo_id;
            END;
            INSERT OR IGNORE INTO schema_migrations (migration_key, completed_at)
            VALUES ('memo_relative_paths_v1', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
            UPDATE memo_index_state
            SET version = version + 1,
                last_updated = MAX(
                    last_updated + 1,
                    CAST(strftime('%s', 'now') AS INTEGER) * 1000
                );
            "#,
        )
        .map_err(sqlite_to_io)
    }

    /// Upgrade the original `(memo_id, content)` todo key. Content is mutable
    /// and is not unique (two checklist rows may intentionally have the same
    /// text), so the durable child key must be `(memo_id, todo_id)`.
    fn migrate_memo_todo_ids(&self, conn: &Connection) -> std::io::Result<()> {
        let columns = conn
            .prepare("PRAGMA table_info(memo_todos)")
            .and_then(|mut statement| {
                let rows = statement.query_map([], |row| {
                    Ok((row.get::<_, String>(1)?, row.get::<_, i64>(5)?))
                })?;
                rows.collect::<Result<Vec<_>, _>>()
            })
            .map_err(sqlite_to_io)?;
        if columns.is_empty() {
            return Ok(());
        }
        let has_todo_id = columns.iter().any(|(name, _)| name == "todo_id");
        if !has_todo_id {
            conn.execute(
                "ALTER TABLE memo_todos ADD COLUMN todo_id TEXT NOT NULL DEFAULT ''",
                [],
            )
            .map_err(sqlite_to_io)?;
        }
        let todo_id_is_primary_key = columns
            .iter()
            .any(|(name, primary_key)| name == "todo_id" && *primary_key > 0);
        if todo_id_is_primary_key {
            return Ok(());
        }

        conn.execute_batch("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;")
            .map_err(sqlite_to_io)?;
        let result = (|| -> std::io::Result<()> {
            conn.execute_batch(
                r#"
                DROP TABLE IF EXISTS memo_todos_v2;
                CREATE TABLE memo_todos_v2 (
                    memo_id TEXT NOT NULL,
                    todo_id TEXT NOT NULL,
                    content TEXT NOT NULL,
                    status TEXT NOT NULL,
                    priority TEXT NOT NULL DEFAULT '',
                    time_range TEXT NOT NULL DEFAULT '',
                    owner TEXT NOT NULL DEFAULT '',
                    assignee TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT 0,
                    position INTEGER NOT NULL,
                    PRIMARY KEY(memo_id, todo_id),
                    FOREIGN KEY(memo_id) REFERENCES memos(id) ON DELETE CASCADE
                );
                "#,
            )
            .map_err(sqlite_to_io)?;
            let mut statement = conn
                .prepare(
                    "SELECT rowid, memo_id, todo_id, content, status, priority, time_range, owner, assignee, created_at, updated_at, position FROM memo_todos ORDER BY memo_id, position, rowid",
                )
                .map_err(sqlite_to_io)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, i64>(9)?,
                        row.get::<_, i64>(10)?,
                        row.get::<_, i64>(11)?,
                    ))
                })
                .map_err(sqlite_to_io)?;
            let rows = rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_to_io)?;
            drop(statement);
            for (
                rowid,
                memo_id,
                _legacy_todo_id,
                content,
                status,
                priority,
                time_range,
                owner,
                assignee,
                created_at,
                updated_at,
                position,
            ) in rows
            {
                // rowid is only used for migrating legacy rows. New and
                // imported rows receive their marker-derived id before they
                // reach this table.
                let todo_id = format!("todo-legacy-{rowid}");
                conn.execute(
                    r#"INSERT INTO memo_todos_v2
                       (memo_id, todo_id, content, status, priority, time_range, owner, assignee, created_at, updated_at, position)
                       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"#,
                    params![memo_id, todo_id, content, status, priority, time_range, owner, assignee, created_at, updated_at, position],
                )
                .map_err(sqlite_to_io)?;
            }
            conn.execute_batch(
                "DROP TABLE memo_todos; ALTER TABLE memo_todos_v2 RENAME TO memo_todos; CREATE INDEX IF NOT EXISTS idx_memo_todos_memo_id ON memo_todos(memo_id);",
            )
            .map_err(sqlite_to_io)?;
            Ok(())
        })();
        let transaction = match result {
            Ok(()) => conn.execute_batch("COMMIT;").map_err(sqlite_to_io),
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK;");
                Err(error)
            }
        };
        let restore = conn
            .execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(sqlite_to_io);
        transaction.and(restore)
    }

    /// Keep revisions after a memo row is deleted, but make their owner an
    /// explicit lifecycle record. This gives revision history a real foreign
    /// key without cascading away the state needed to publish a tombstone.
    fn migrate_memo_lifecycles(&self, conn: &Connection) -> std::io::Result<()> {
        let has_fk = conn
            .prepare("PRAGMA foreign_key_list(memo_content_revisions)")
            .and_then(|mut statement| {
                let rows = statement.query_map([], |row| row.get::<_, String>(2))?;
                rows.collect::<Result<Vec<_>, _>>()
            })
            .map_err(sqlite_to_io)?
            .into_iter()
            .any(|table| table == "memo_lifecycles");

        conn.execute_batch(
            r#"
            INSERT OR IGNORE INTO memo_lifecycles
                (memo_id, notebook_id, relative_path, generation, is_deleted, created_at, updated_at)
            SELECT id, notebook_id, relative_path, 1, 0, created_at, updated_at FROM memos;
            INSERT OR IGNORE INTO memo_lifecycles
                (memo_id, notebook_id, relative_path, generation, is_deleted, created_at, updated_at)
            SELECT memo_id, notebook_id, '', 1, 1, updated_at, updated_at
            FROM memo_content_revisions;
            "#,
        )
        .map_err(sqlite_to_io)?;
        if has_fk {
            return Ok(());
        }

        conn.execute_batch("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;")
            .map_err(sqlite_to_io)?;
        let result = (|| -> std::io::Result<()> {
            conn.execute_batch(
                r#"
                CREATE TABLE memo_content_revisions_v2 (
                    memo_id TEXT PRIMARY KEY,
                    notebook_id TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    local_revision INTEGER NOT NULL,
                    change_id TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    FOREIGN KEY(memo_id) REFERENCES memo_lifecycles(memo_id) ON DELETE RESTRICT
                );
                INSERT INTO memo_content_revisions_v2
                    (memo_id, notebook_id, content_hash, local_revision, change_id, updated_at)
                SELECT memo_id, notebook_id, content_hash, local_revision, change_id, updated_at
                FROM memo_content_revisions;
                DROP TABLE memo_content_revisions;
                ALTER TABLE memo_content_revisions_v2 RENAME TO memo_content_revisions;
                CREATE INDEX IF NOT EXISTS idx_memo_content_revisions_notebook
                    ON memo_content_revisions(notebook_id);
                "#,
            )
            .map_err(sqlite_to_io)
        })();
        let transaction = match result {
            Ok(()) => conn.execute_batch("COMMIT;").map_err(sqlite_to_io),
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK;");
                Err(error)
            }
        };
        let restore = conn
            .execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(sqlite_to_io);
        transaction.and(restore)
    }

    fn import_legacy_global_memo_index(
        &self,
        conn: &Connection,
        notebook_id: &str,
    ) -> std::io::Result<()> {
        let already_imported: Option<String> = conn
            .query_row(
                "SELECT value FROM notebook_index_meta WHERE key = 'legacy_global_index_import_v1'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(sqlite_to_io)?;
        if already_imported.is_some() {
            return Ok(());
        }

        let legacy_path = self.get_global_index_db_path();
        if !legacy_path.is_file() {
            conn.execute(
                "INSERT OR REPLACE INTO notebook_index_meta (key, value) VALUES ('legacy_global_index_import_v1', ?1)",
                ["missing"],
            )
            .map_err(sqlite_to_io)?;
            return Ok(());
        }

        let legacy = self.open_index_db()?;
        let has_memos: bool = legacy
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memos')",
                [],
                |row| row.get(0),
            )
            .map_err(sqlite_to_io)?;
        if !has_memos {
            conn.execute(
                "INSERT OR REPLACE INTO notebook_index_meta (key, value) VALUES ('legacy_global_index_import_v1', ?1)",
                ["empty"],
            )
            .map_err(sqlite_to_io)?;
            return Ok(());
        }

        let legacy_path_string = legacy_path.to_string_lossy().to_string();
        conn.execute("ATTACH DATABASE ?1 AS legacy_index", [&legacy_path_string])
            .map_err(sqlite_to_io)?;
        let result = (|| -> std::io::Result<()> {
            let tx = conn.unchecked_transaction().map_err(sqlite_to_io)?;

            tx.execute(
                "INSERT OR IGNORE INTO memo_lifecycles
                    (memo_id, notebook_id, relative_path, generation, is_deleted, created_at, updated_at, deleted_at)
                 SELECT memo_id, notebook_id, relative_path, generation, is_deleted, created_at, updated_at, deleted_at
                 FROM legacy_index.memo_lifecycles WHERE notebook_id = ?1",
                [notebook_id],
            )
            .map_err(sqlite_to_io)?;
            tx.execute(
                "INSERT OR IGNORE INTO memo_lifecycles
                    (memo_id, notebook_id, relative_path, generation, is_deleted, created_at, updated_at, deleted_at)
                 SELECT memo_id, notebook_id, '', 1, 1, updated_at, updated_at, NULL
                 FROM legacy_index.memo_content_revisions
                 WHERE notebook_id = ?1",
                [notebook_id],
            )
            .map_err(sqlite_to_io)
                .or_else(|error| {
                    // Older global indexes did not have revisions yet. The
                    // primary copy remains valid when that optional table is absent.
                    if error.to_string().contains("no such table") {
                        Ok(0)
                    } else {
                        Err(error)
                    }
                })?;
            tx.execute(
                "INSERT OR IGNORE INTO memos
                    (id, notebook_id, filename, relative_path, preview, thumbnail, thumbnail_checked, agents_checked, created_at, updated_at, favorited, icon, properties)
                 SELECT id, notebook_id, filename, relative_path, preview, thumbnail, thumbnail_checked, agents_checked, created_at, updated_at, favorited, icon, properties
                 FROM legacy_index.memos WHERE notebook_id = ?1",
                [notebook_id],
            )
            .map_err(sqlite_to_io)?;
            tx.execute(
                "INSERT OR IGNORE INTO memo_content_revisions
                    (memo_id, notebook_id, content_hash, local_revision, change_id, updated_at)
                 SELECT memo_id, notebook_id, content_hash, local_revision, change_id, updated_at
                 FROM legacy_index.memo_content_revisions WHERE notebook_id = ?1",
                [notebook_id],
            )
            .map_err(sqlite_to_io)
            .or_else(|error| {
                if error.to_string().contains("no such table") {
                    Ok(0)
                } else {
                    Err(error)
                }
            })?;
            tx.execute(
                "INSERT OR IGNORE INTO memo_tags (memo_id, tag)
                 SELECT mt.memo_id, mt.tag FROM legacy_index.memo_tags mt
                 JOIN legacy_index.memos m ON m.id = mt.memo_id
                 WHERE m.notebook_id = ?1",
                [notebook_id],
            )
            .map_err(sqlite_to_io)?;
            tx.execute(
                "INSERT OR IGNORE INTO memo_colors (memo_id, color, position)
                 SELECT mc.memo_id, mc.color, mc.position FROM legacy_index.memo_colors mc
                 JOIN legacy_index.memos m ON m.id = mc.memo_id
                 WHERE m.notebook_id = ?1",
                [notebook_id],
            )
            .map_err(sqlite_to_io)?;
            tx.execute(
                "INSERT OR IGNORE INTO memo_todos
                    (memo_id, todo_id, content, status, priority, time_range, owner, assignee, created_at, updated_at, position)
                 SELECT mt.memo_id, mt.todo_id, mt.content, mt.status, mt.priority, mt.time_range, mt.owner, mt.assignee, mt.created_at, mt.updated_at, mt.position
                 FROM legacy_index.memo_todos mt
                 JOIN legacy_index.memos m ON m.id = mt.memo_id
                 WHERE m.notebook_id = ?1",
                [notebook_id],
            )
            .map_err(sqlite_to_io)?;
            tx.execute(
                "INSERT OR IGNORE INTO memo_agents (memo_id, thread_id, title, agent_type, position)
                 SELECT ma.memo_id, ma.thread_id, ma.title, ma.agent_type, ma.position
                 FROM legacy_index.memo_agents ma
                 JOIN legacy_index.memos m ON m.id = ma.memo_id
                 WHERE m.notebook_id = ?1",
                [notebook_id],
            )
            .map_err(sqlite_to_io)?;
            tx.execute(
                "INSERT OR IGNORE INTO notebook_tags (notebook_id, path, created_at, updated_at)
                 SELECT notebook_id, path, created_at, updated_at
                 FROM legacy_index.notebook_tags WHERE notebook_id = ?1",
                [notebook_id],
            )
            .map_err(sqlite_to_io)
            .or_else(|error| {
                if error.to_string().contains("no such table") {
                    Ok(0)
                } else {
                    Err(error)
                }
            })?;
            tx.execute(
                "INSERT OR IGNORE INTO memo_index_state (notebook_id, version, last_updated, migrated_at)
                 SELECT notebook_id, version, last_updated, migrated_at
                 FROM legacy_index.memo_index_state WHERE notebook_id = ?1",
                [notebook_id],
            )
            .map_err(sqlite_to_io)
                .or_else(|error| {
                    if error.to_string().contains("no such table") {
                        Ok(0)
                    } else {
                        Err(error)
                    }
                })?;
            tx.execute(
                "INSERT OR IGNORE INTO notebook_data_migrations (notebook_id, migration_key, version, completed_at)
                 SELECT notebook_id, migration_key, version, completed_at
                 FROM legacy_index.notebook_data_migrations WHERE notebook_id = ?1",
                [notebook_id],
            )
            .map_err(sqlite_to_io)
                .or_else(|error| {
                    if error.to_string().contains("no such table") {
                        Ok(0)
                    } else {
                        Err(error)
                    }
                })?;
            tx.execute(
                "INSERT OR REPLACE INTO notebook_index_meta (key, value) VALUES ('legacy_global_index_import_v1', ?1)",
                ["complete"],
            )
            .map_err(sqlite_to_io)?;
            tx.commit().map_err(sqlite_to_io)
        })();
        let detach = conn.execute_batch("DETACH DATABASE legacy_index;");
        result.and(detach.map_err(sqlite_to_io))
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
        let conn = self.open_notebook_index_db(notebook_id)?;
        self.ensure_memo_tables(&conn)?;
        self.ensure_local_notebook_row(&conn, notebook_id)?;
        self.import_legacy_global_memo_index(&conn, notebook_id)?;
        Ok(conn)
    }

    pub(crate) fn open_memo_index_db(&self) -> std::io::Result<Connection> {
        let notebook_id = self.current_notebook_id_for_index();
        self.open_memo_index_db_for_notebook_id(&notebook_id)
    }

    /// Record an external-process create before its markdown file becomes visible.
    /// The Desktop watcher consumes this marker when it observes the filesystem event.
    pub fn mark_pending_external_memo_create(
        &self,
        memo_id: &str,
        notebook_id: &str,
    ) -> std::io::Result<()> {
        let conn = self.open_memo_index_db_for_notebook_id(notebook_id)?;
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "DELETE FROM pending_external_memo_creates WHERE created_at < ?1",
            params![now - EXTERNAL_CREATE_MARKER_TTL_MS],
        )
        .map_err(sqlite_to_io)?;
        conn.execute(
            r#"
            INSERT INTO pending_external_memo_creates (memo_id, notebook_id, created_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(memo_id) DO UPDATE SET
                notebook_id = excluded.notebook_id,
                created_at = excluded.created_at
            "#,
            params![memo_id, notebook_id, now],
        )
        .map_err(sqlite_to_io)?;
        Ok(())
    }

    /// Atomically claim an external create marker. A marker can produce at most one
    /// `Created` event even when the platform reports several filesystem events.
    pub fn consume_pending_external_memo_create(
        &self,
        memo_id: &str,
        notebook_id: &str,
    ) -> std::io::Result<bool> {
        let conn = self.open_memo_index_db_for_notebook_id(notebook_id)?;
        let cutoff = chrono::Utc::now().timestamp_millis() - EXTERNAL_CREATE_MARKER_TTL_MS;
        let changed = conn
            .execute(
                "DELETE FROM pending_external_memo_creates WHERE memo_id = ?1 AND notebook_id = ?2 AND created_at >= ?3",
                params![memo_id, notebook_id, cutoff],
            )
            .map_err(sqlite_to_io)?;
        Ok(changed > 0)
    }

    pub fn pending_external_memo_creates_for_notebook(
        &self,
        notebook_id: &str,
    ) -> std::io::Result<std::collections::HashSet<String>> {
        let conn = self.open_memo_index_db_for_notebook_id(notebook_id)?;
        let cutoff = chrono::Utc::now().timestamp_millis() - EXTERNAL_CREATE_MARKER_TTL_MS;
        let mut statement = conn
            .prepare(
                "SELECT memo_id FROM pending_external_memo_creates WHERE notebook_id = ?1 AND created_at >= ?2",
            )
            .map_err(sqlite_to_io)?;
        let rows = statement
            .query_map(params![notebook_id, cutoff], |row| row.get::<_, String>(0))
            .map_err(sqlite_to_io)?;
        let mut memo_ids = std::collections::HashSet::new();
        for row in rows {
            memo_ids.insert(row.map_err(sqlite_to_io)?);
        }
        Ok(memo_ids)
    }

    pub fn has_pending_external_memo_create(
        &self,
        memo_id: &str,
        notebook_id: &str,
    ) -> std::io::Result<bool> {
        let conn = self.open_memo_index_db_for_notebook_id(notebook_id)?;
        let cutoff = chrono::Utc::now().timestamp_millis() - EXTERNAL_CREATE_MARKER_TTL_MS;
        conn.query_row(
            "SELECT 1 FROM pending_external_memo_creates WHERE memo_id = ?1 AND notebook_id = ?2 AND created_at >= ?3",
            params![memo_id, notebook_id, cutoff],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
        .map_err(sqlite_to_io)
    }

    pub fn clear_pending_external_memo_create(&self, memo_id: &str) -> std::io::Result<()> {
        let conn = self.open_memo_index_db()?;
        conn.execute(
            "DELETE FROM pending_external_memo_creates WHERE memo_id = ?1",
            params![memo_id],
        )
        .map_err(sqlite_to_io)?;
        Ok(())
    }

    /// Atomically records a stable content revision for a memo.
    ///
    /// Re-observing identical bytes returns the existing revision/change id.
    /// Returning to an older hash after another commit is a new transition and
    /// therefore advances the counter as well.
    pub fn commit_memo_content_revision(
        &self,
        memo_id: &str,
        notebook_id: &str,
        content_hash: &str,
        next_change_id: &str,
    ) -> std::io::Result<MemoContentCommit> {
        self.commit_memo_content_revision_internal(
            memo_id,
            notebook_id,
            content_hash,
            next_change_id,
            None,
        )?
        .ok_or_else(|| std::io::Error::other("unconditional revision commit was rejected"))
    }

    pub fn commit_memo_content_revision_if_current(
        &self,
        memo_id: &str,
        notebook_id: &str,
        content_hash: &str,
        next_change_id: &str,
        expected: Option<&MemoContentRevision>,
    ) -> std::io::Result<Option<MemoContentCommit>> {
        self.commit_memo_content_revision_internal(
            memo_id,
            notebook_id,
            content_hash,
            next_change_id,
            Some(expected),
        )
    }

    fn commit_memo_content_revision_internal(
        &self,
        memo_id: &str,
        notebook_id: &str,
        content_hash: &str,
        next_change_id: &str,
        expected: Option<Option<&MemoContentRevision>>,
    ) -> std::io::Result<Option<MemoContentCommit>> {
        let mut conn = self.open_memo_index_db_for_notebook_id(notebook_id)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_to_io)?;
        // Revision rows may be created before the corresponding Markdown file
        // is indexed (for example while an external writer is committing a
        // save). Keep the lifecycle anchor in the same local index so the FK
        // remains valid without making the revision stream depend on a prior
        // memo-list refresh.
        tx.execute(
            "INSERT OR IGNORE INTO memo_lifecycles
                (memo_id, notebook_id, relative_path, generation, is_deleted, created_at, updated_at)
             VALUES (?1, ?2, '', 1, 0, ?3, ?3)",
            params![memo_id, notebook_id, chrono::Utc::now().timestamp_millis()],
        )
        .map_err(sqlite_to_io)?;
        let current = tx
            .query_row(
                "SELECT content_hash, local_revision, change_id, updated_at
                 FROM memo_content_revisions WHERE memo_id = ?1",
                params![memo_id],
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
                    expected.memo_id == memo_id
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
                return Ok(Some(MemoContentCommit {
                    state: MemoContentRevision {
                        memo_id: memo_id.to_string(),
                        notebook_id: notebook_id.to_string(),
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
            INSERT INTO memo_content_revisions
                (memo_id, notebook_id, content_hash, local_revision, change_id, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(memo_id) DO UPDATE SET
                notebook_id = excluded.notebook_id,
                content_hash = excluded.content_hash,
                local_revision = excluded.local_revision,
                change_id = excluded.change_id,
                updated_at = excluded.updated_at
            "#,
            params![
                memo_id,
                notebook_id,
                content_hash,
                revision,
                next_change_id,
                updated_at,
            ],
        )
        .map_err(sqlite_to_io)?;
        tx.commit().map_err(sqlite_to_io)?;

        Ok(Some(MemoContentCommit {
            state: MemoContentRevision {
                memo_id: memo_id.to_string(),
                notebook_id: notebook_id.to_string(),
                content_hash: content_hash.to_string(),
                revision,
                change_id: next_change_id.to_string(),
                updated_at,
            },
            changed: true,
        }))
    }

    pub fn read_memo_content_revision(
        &self,
        memo_id: &str,
    ) -> std::io::Result<Option<MemoContentRevision>> {
        for notebook in self.read_notebook_configs()? {
            let conn = self.open_memo_index_db_for_notebook_id(&notebook.id)?;
            let revision = conn
                .query_row(
                    "SELECT notebook_id, content_hash, local_revision, change_id, updated_at
                     FROM memo_content_revisions WHERE memo_id = ?1",
                    params![memo_id],
                    |row| {
                        Ok(MemoContentRevision {
                            memo_id: memo_id.to_string(),
                            notebook_id: row.get(0)?,
                            content_hash: row.get(1)?,
                            revision: row.get(2)?,
                            change_id: row.get(3)?,
                            updated_at: row.get(4)?,
                        })
                    },
                )
                .optional()
                .map_err(sqlite_to_io)?;
            if revision.is_some() {
                return Ok(revision);
            }
        }
        Ok(None)
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

    pub(crate) fn notebook_data_migration_version(
        &self,
        notebook_id: &str,
        migration_key: &str,
    ) -> std::io::Result<Option<u32>> {
        let conn = self.open_memo_index_db_for_notebook_id(notebook_id)?;
        self.ensure_memo_tables(&conn)?;
        conn.query_row(
            "SELECT version FROM notebook_data_migrations
             WHERE notebook_id = ?1 AND migration_key = ?2",
            params![notebook_id, migration_key],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map(|version| version.map(|value| value.max(0) as u32))
        .map_err(sqlite_to_io)
    }

    pub(crate) fn mark_notebook_data_migration(
        &self,
        notebook_id: &str,
        migration_key: &str,
        version: u32,
    ) -> std::io::Result<()> {
        let conn = self.open_memo_index_db_for_notebook_id(notebook_id)?;
        self.ensure_memo_tables(&conn)?;
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
