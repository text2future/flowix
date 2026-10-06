//! Schema migrations for the agent-session SQLite database.
//!
//! Pure schema operations on a `&mut Connection` -- no `ThreadManager` state.
//! Kept as a second `impl ThreadManager` block (alongside the main one in
//! `store.rs`) so the schema setup stays cohesive with the type it configures
//! and `new` / `new_in_memory` keep calling `Self::run_migrations`. Invoked
//! once at construction time.

use rusqlite::{params, Connection};

use super::error::ThreadError;

pub(super) const THREAD_DB_SCHEMA_VERSION: i64 = 12;
pub(super) const WAL_AUTOCHECKPOINT_PAGES: i64 = 4000;
pub(super) const WAL_JOURNAL_SIZE_LIMIT_BYTES: i64 = 64 * 1024 * 1024;

impl super::store::ThreadManager {
    pub(super) fn run_migrations(conn: &mut Connection) -> Result<(), ThreadError> {
        // These pragmas configure the current connection, so they must be
        // applied on every open even when the schema is already current.
        conn.execute_batch(
            "
            -- WAL lets high-frequency external-CLI event writes proceed
            -- concurrently with history reads, instead of blocking readers.
            -- `synchronous = NORMAL` is safe under WAL and the common choice.
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            ",
        )?;
        conn.pragma_update(None, "wal_autocheckpoint", WAL_AUTOCHECKPOINT_PAGES)?;
        conn.pragma_update(None, "journal_size_limit", WAL_JOURNAL_SIZE_LIMIT_BYTES)?;

        let current_version: i64 =
            conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if current_version == THREAD_DB_SCHEMA_VERSION {
            return Ok(());
        }
        if current_version > THREAD_DB_SCHEMA_VERSION {
            return Err(ThreadError::UnsupportedSchemaVersion {
                found: current_version,
                supported: THREAD_DB_SCHEMA_VERSION,
            });
        }

        conn.execute_batch(
            "

            CREATE TABLE IF NOT EXISTS threads (
                thread_id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                title TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS thread_messages (
                id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                llm_content TEXT,
                system_reminder_directory TEXT,
                timestamp TEXT NOT NULL,
                is_loading INTEGER,
                tool_call_id TEXT,
                tool_name TEXT,
                tool_data TEXT,
                tool_input TEXT,
                tool_calls TEXT,
                reasoning TEXT,
                is_completed INTEGER,
                is_collapsed INTEGER,
                sequence INTEGER NOT NULL,
                FOREIGN KEY(thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_sequence
                ON thread_messages(thread_id, sequence);

            CREATE TABLE IF NOT EXISTS thread_external_sessions (
                thread_id TEXT NOT NULL,
                runtime TEXT NOT NULL,
                external_session_id TEXT NOT NULL,
                session_metadata_json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (thread_id, runtime),
                UNIQUE (runtime, external_session_id),
                FOREIGN KEY(thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS agent_conversation_instances (
                instance_id TEXT PRIMARY KEY,
                agent_type TEXT NOT NULL,
                thread_id TEXT,
                runtime_config TEXT,
                frozen_cwd TEXT,
                source_kind TEXT NOT NULL DEFAULT 'thread-card',
                source_document_path TEXT,
                source_relative_path TEXT,
                source_memo_id TEXT,
                source_notebook_id TEXT,
                role_memo_id TEXT,
                role_address TEXT,
                role_name TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_agent_conversation_thread
                ON agent_conversation_instances(thread_id);

            DROP TABLE IF EXISTS agent_conversation_run_state;

            CREATE TABLE IF NOT EXISTS agent_external_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                runtime TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                event_key TEXT,
                event_kind TEXT,
                run_id TEXT,
                source_sequence INTEGER,
                source_subsequence INTEGER,
                normalized_json TEXT NOT NULL,
                raw_json TEXT,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
            );
            ",
        )?;

        // `CREATE TABLE IF NOT EXISTS` does not add columns to an existing
        // table. Builds prior to session metadata created
        // `thread_external_sessions` without this column, while
        // `migrate_external_thread_identity` reads it unconditionally. Add it
        // before that migration so startup does not fall back to the in-memory
        // thread store.
        Self::ensure_external_session_metadata_column(conn)?;
        Self::ensure_agent_conversation_frozen_cwd_column(conn)?;
        Self::ensure_agent_conversation_notebook_id_column(conn)?;
        Self::ensure_agent_conversation_schema(conn)?;
        Self::migrate_agent_external_events_table(conn)?;
        Self::ensure_agent_external_event_key_column(conn)?;
        Self::ensure_agent_external_event_metadata_columns(conn)?;
        // External CLI sessions used to be persisted under both the temporary
        // Flowix thread id and the provider session id. Reconciliation below
        // removes any colliding instance before the existing unique constraint
        // can reject the canonical-id update.
        Self::migrate_external_thread_identity(conn)?;
        // Phase 1 of the simplified thread model: create the new product
        // index and provider-specific bindings, then backfill them while the
        // legacy tables remain available to the old read/write paths. The
        // cut-over happens in a later migration once all callers are moved.
        Self::ensure_simplified_thread_schema(conn)?;
        Self::ensure_pi_thread_metadata_columns(conn)?;
        Self::ensure_path_and_legacy_role_columns(conn)?;
        // Role files are no longer part of conversations. Clear values from
        // historical columns before marking the schema current.
        conn.execute_batch(
            "UPDATE agent_conversation_instances SET role_memo_id = NULL, role_address = NULL, role_name = NULL;
             UPDATE agent_instances SET role_memo_id = NULL, role_address = NULL, role_name = NULL;",
        )?;
        conn.execute_batch(
            "
            CREATE INDEX IF NOT EXISTS idx_agent_external_events_thread
                ON agent_external_events(thread_id, id);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_external_events_idempotency
                ON agent_external_events(runtime, thread_id, event_key)
            WHERE event_key IS NOT NULL AND trim(event_key) <> '';
            CREATE INDEX IF NOT EXISTS idx_agent_external_events_turns
                ON agent_external_events(runtime, thread_id, event_kind, run_id, id);
            ",
        )?;
        conn.pragma_update(None, "user_version", THREAD_DB_SCHEMA_VERSION)?;

        Ok(())
    }

    /// Additive first phase of the thread-store migration.
    ///
    /// The new tables deliberately contain only product identity and external
    /// IDs. Codex/DSH history and runtime metadata remain owned by their
    /// runtimes; the old tables are retained until their callers are cut over.
    fn ensure_simplified_thread_schema(conn: &mut Connection) -> Result<(), ThreadError> {
        let tx = conn.transaction()?;
        tx.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS agent_instances (
                id TEXT PRIMARY KEY,
                agent TEXT NOT NULL,
                config_json TEXT,
                source TEXT NOT NULL DEFAULT 'thread-card',
                document_path TEXT,
                relative_path TEXT,
                memo_id TEXT,
                notebook_id TEXT,
                role_memo_id TEXT,
                role_address TEXT,
                role_name TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_agent_instances_notebook_updated
                ON agent_instances(notebook_id, updated_at DESC, id DESC);

            CREATE TABLE IF NOT EXISTS threads_index (
                id TEXT PRIMARY KEY,
                instance_id TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(instance_id) REFERENCES agent_instances(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_threads_index_updated
                ON threads_index(updated_at DESC);

            CREATE TABLE IF NOT EXISTS threads_codex (
                thread_id TEXT PRIMARY KEY,
                external_id TEXT NOT NULL UNIQUE,
                FOREIGN KEY(thread_id) REFERENCES threads_index(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS threads_dsh (
                thread_id TEXT PRIMARY KEY,
                external_id TEXT NOT NULL UNIQUE,
                FOREIGN KEY(thread_id) REFERENCES threads_index(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS threads_opencode (
                thread_id TEXT PRIMARY KEY,
                external_id TEXT NOT NULL UNIQUE,
                FOREIGN KEY(thread_id) REFERENCES threads_index(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS threads_hermes (
                thread_id TEXT PRIMARY KEY,
                external_id TEXT NOT NULL UNIQUE,
                FOREIGN KEY(thread_id) REFERENCES threads_index(id) ON DELETE CASCADE
            );

            -- Claude messages remain product-owned in agent_external_events.
            -- This branch stores only provider identity and reconciliation
            -- metadata, leaving room for Claude-specific evolution.
            CREATE TABLE IF NOT EXISTS threads_claude (
                thread_id TEXT PRIMARY KEY,
                external_id TEXT NOT NULL UNIQUE,
                project_path TEXT,
                transcript_path TEXT,
                last_reconciled_at INTEGER,
                schema_version INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY(thread_id) REFERENCES threads_index(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS threads_pi (
                thread_id TEXT PRIMARY KEY,
                external_id TEXT NOT NULL UNIQUE,
                session_file TEXT,
                cwd TEXT,
                schema_version INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY(thread_id) REFERENCES threads_index(id) ON DELETE CASCADE
            );
            ",
        )?;

        // Existing conversation instances are the canonical source for the
        // instance-side metadata during this additive phase. The old title and
        // thread binding are projected into the product index only.
        tx.execute_batch(
            "
            INSERT OR IGNORE INTO agent_instances (
                id, agent, config_json, source, document_path, memo_id,
                notebook_id, role_memo_id, role_name, created_at, updated_at
            )
            SELECT
                instance_id, agent_type, runtime_config, source_kind,
                source_document_path, source_memo_id, source_notebook_id,
                role_memo_id, role_name, created_at, updated_at
            FROM agent_conversation_instances;

            -- Preserve legacy product threads that predate an instance row by
            -- creating a deterministic dedicated instance. This avoids data
            -- loss and makes the new index's instance_id NOT NULL invariant
            -- valid for every existing product thread.
            INSERT OR IGNORE INTO agent_instances (
                id, agent, source, created_at, updated_at
            )
            SELECT
                'legacy-' || t.thread_id,
                t.agent_id,
                'dedicated',
                t.created_at,
                t.updated_at
            FROM threads t
            WHERE NOT EXISTS (
                SELECT 1 FROM agent_conversation_instances i
                WHERE i.thread_id = t.thread_id
            );

            INSERT OR IGNORE INTO threads_index (
                id, instance_id, title, created_at, updated_at
            )
            SELECT
                t.thread_id,
                COALESCE(i.instance_id, 'legacy-' || t.thread_id),
                t.title,
                t.created_at,
                t.updated_at
            FROM threads t
            LEFT JOIN agent_conversation_instances i
                ON i.thread_id = t.thread_id;

            INSERT OR IGNORE INTO threads_codex (thread_id, external_id)
            SELECT s.thread_id, s.external_session_id
            FROM thread_external_sessions s
            JOIN threads_index ti ON ti.id = s.thread_id
            WHERE s.runtime = 'codex'
              AND trim(s.external_session_id) <> '';

            INSERT OR IGNORE INTO threads_dsh (thread_id, external_id)
            SELECT s.thread_id, s.external_session_id
            FROM thread_external_sessions s
            JOIN threads_index ti ON ti.id = s.thread_id
            WHERE s.runtime = 'deepseek-harness'
              AND trim(s.external_session_id) <> '';

            INSERT OR IGNORE INTO threads_opencode (thread_id, external_id)
            SELECT s.thread_id, s.external_session_id
            FROM thread_external_sessions s
            JOIN threads_index ti ON ti.id = s.thread_id
            WHERE s.runtime = 'opencode'
              AND trim(s.external_session_id) <> '';

            INSERT OR IGNORE INTO threads_hermes (thread_id, external_id)
            SELECT s.thread_id, s.external_session_id
            FROM thread_external_sessions s
            JOIN threads_index ti ON ti.id = s.thread_id
            WHERE s.runtime = 'hermes'
              AND trim(s.external_session_id) <> '';

            INSERT OR IGNORE INTO threads_claude (
                thread_id, external_id, project_path, last_reconciled_at
            )
            SELECT
                s.thread_id,
                s.external_session_id,
                CASE WHEN json_valid(s.session_metadata_json)
                    THEN COALESCE(
                        json_extract(s.session_metadata_json, '$.cwd'),
                        json_extract(s.session_metadata_json, '$.metadata.cwd'),
                        json_extract(s.session_metadata_json, '$.message.cwd')
                    )
                END,
                s.updated_at
            FROM thread_external_sessions s
            JOIN threads_index ti ON ti.id = s.thread_id
            WHERE s.runtime = 'claude'
              AND trim(s.external_session_id) <> '';

            INSERT OR IGNORE INTO threads_pi (thread_id, external_id)
            SELECT s.thread_id, s.external_session_id
            FROM thread_external_sessions s
            JOIN threads_index ti ON ti.id = s.thread_id
            WHERE s.runtime = 'pi'
              AND trim(s.external_session_id) <> '';
            ",
        )?;

        tx.commit()?;
        Ok(())
    }

    fn ensure_pi_thread_metadata_columns(conn: &Connection) -> Result<(), ThreadError> {
        let mut stmt = conn.prepare("PRAGMA table_info(threads_pi)")?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        if !columns.iter().any(|column| column == "session_file") {
            conn.execute("ALTER TABLE threads_pi ADD COLUMN session_file TEXT", [])?;
        }
        if !columns.iter().any(|column| column == "cwd") {
            conn.execute("ALTER TABLE threads_pi ADD COLUMN cwd TEXT", [])?;
        }
        Ok(())
    }

    fn ensure_external_session_metadata_column(conn: &Connection) -> Result<(), ThreadError> {
        let mut stmt = conn.prepare("PRAGMA table_info(thread_external_sessions)")?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        if !columns
            .iter()
            .any(|column| column == "session_metadata_json")
        {
            conn.execute(
                "ALTER TABLE thread_external_sessions ADD COLUMN session_metadata_json TEXT",
                [],
            )?;
        }
        Ok(())
    }

    /// Move the server-owned cwd out of the frontend-owned runtime_config JSON.
    ///
    /// Existing builds stored `frozenCwd` in that JSON. A short-lived build
    /// could also lose it while retaining the original `workspaceSnapshot.cwd`;
    /// use that snapshot only as a one-time migration fallback. Runtime code
    /// never treats the snapshot as authoritative after this migration.
    fn ensure_agent_conversation_frozen_cwd_column(conn: &Connection) -> Result<(), ThreadError> {
        let mut stmt = conn.prepare("PRAGMA table_info(agent_conversation_instances)")?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        if columns.iter().any(|column| column == "frozen_cwd") {
            return Ok(());
        }
        conn.execute(
            "ALTER TABLE agent_conversation_instances ADD COLUMN frozen_cwd TEXT",
            [],
        )?;

        // Only databases upgraded from the JSON-based design take this path.
        // Fresh databases already have the column in CREATE TABLE and must not
        // turn a future frontend workspace snapshot into runtime authority.
        let mut stmt = conn.prepare(
            "SELECT instance_id, runtime_config
             FROM agent_conversation_instances
             WHERE runtime_config IS NOT NULL",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        for (instance_id, raw_config) in rows {
            let Ok(mut config) = serde_json::from_str::<serde_json::Value>(&raw_config) else {
                continue;
            };
            let migrated_cwd = config
                .get("frozenCwd")
                .and_then(serde_json::Value::as_str)
                .or_else(|| {
                    config
                        .get("workspaceSnapshot")
                        .and_then(|snapshot| snapshot.get("cwd"))
                        .and_then(serde_json::Value::as_str)
                })
                .map(str::trim)
                .filter(|cwd| !cwd.is_empty())
                .map(str::to_string);
            let removed_legacy_field = config
                .as_object_mut()
                .and_then(|object| object.remove("frozenCwd"))
                .is_some();
            let cleaned_config = removed_legacy_field
                .then(|| serde_json::to_string(&config).ok())
                .flatten();

            conn.execute(
                "UPDATE agent_conversation_instances
                 SET frozen_cwd = COALESCE(frozen_cwd, ?1),
                     runtime_config = COALESCE(?2, runtime_config)
                 WHERE instance_id = ?3",
                params![migrated_cwd, cleaned_config, instance_id],
            )?;
        }
        Ok(())
    }

    fn ensure_path_and_legacy_role_columns(conn: &Connection) -> Result<(), ThreadError> {
        for (table, required) in [
            (
                "agent_conversation_instances",
                &["role_address", "source_relative_path"][..],
            ),
            ("agent_instances", &["role_address", "relative_path"][..]),
        ] {
            let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
            let columns = stmt
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            for column in required {
                if !columns.iter().any(|existing| existing == column) {
                    conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} TEXT"), [])?;
                }
            }
        }
        Ok(())
    }

    /// Add `source_notebook_id` so conversation instances remember the owning
    /// notebook of their source note and the conversation list can be scoped per
    /// notebook. Idempotent: fresh databases already declare the column in
    /// `CREATE TABLE`; only databases created before this column take the
    /// `ALTER TABLE` path. No data backfill is possible — pre-column rows
    /// simply read back as `None` and remain visible in every notebook.
    fn ensure_agent_conversation_notebook_id_column(conn: &Connection) -> Result<(), ThreadError> {
        let mut stmt = conn.prepare("PRAGMA table_info(agent_conversation_instances)")?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        if columns.iter().any(|column| column == "source_notebook_id") {
            return Ok(());
        }
        conn.execute(
            "ALTER TABLE agent_conversation_instances ADD COLUMN source_notebook_id TEXT",
            [],
        )?;
        Ok(())
    }

    fn ensure_agent_conversation_schema(conn: &mut Connection) -> Result<(), ThreadError> {
        let mut columns_stmt = conn.prepare("PRAGMA table_info(agent_conversation_instances)")?;
        let columns = columns_stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(columns_stmt);

        let has_thread_foreign_key = {
            let mut stmt = conn.prepare("PRAGMA foreign_key_list(agent_conversation_instances)")?;
            let foreign_keys = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(6)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            foreign_keys.iter().any(|(table, from, to, on_delete)| {
                table == "threads"
                    && from == "thread_id"
                    && to == "thread_id"
                    && on_delete.eq_ignore_ascii_case("CASCADE")
            })
        };

        if !columns.iter().any(|column| column == "title") && has_thread_foreign_key {
            let tx = conn.transaction()?;
            tx.execute_batch(
                "
                -- The unique index was added after some releases had already
                -- written more than one instance for the same product thread.
                -- Pick one canonical row before creating the constraint. Prefer
                -- the newest row; on a timestamp tie, retain the row with the
                -- richer source linkage, then use instance_id for determinism.
                DELETE FROM agent_conversation_instances
                WHERE thread_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1
                    FROM agent_conversation_instances newer
                    WHERE newer.thread_id = agent_conversation_instances.thread_id
                      AND (
                        newer.updated_at > agent_conversation_instances.updated_at
                        OR (
                            newer.updated_at = agent_conversation_instances.updated_at
                            AND (
                                (newer.source_memo_id IS NOT NULL AND agent_conversation_instances.source_memo_id IS NULL)
                                OR (
                                    (newer.source_memo_id IS NOT NULL) = (agent_conversation_instances.source_memo_id IS NOT NULL)
                                    AND newer.source_document_path IS NOT NULL
                                    AND agent_conversation_instances.source_document_path IS NULL
                                )
                                OR (
                                    (newer.source_memo_id IS NOT NULL) = (agent_conversation_instances.source_memo_id IS NOT NULL)
                                    AND (newer.source_document_path IS NOT NULL) = (agent_conversation_instances.source_document_path IS NOT NULL)
                                    AND newer.instance_id > agent_conversation_instances.instance_id
                                )
                            )
                        )
                      )
                  );

                CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_conversation_thread_unique
                    ON agent_conversation_instances(thread_id)
                    WHERE thread_id IS NOT NULL;
                ",
            )?;
            tx.commit()?;
            return Ok(());
        }

        // Migrate useful legacy card titles into the product thread before the
        // duplicated instance title column is removed.
        if columns.iter().any(|column| column == "title") {
            conn.execute_batch(
                "
                UPDATE threads
                SET title = (
                    SELECT i.title
                    FROM agent_conversation_instances i
                    WHERE i.thread_id = threads.thread_id
                      AND trim(i.title) <> ''
                      AND lower(trim(i.title)) NOT IN (
                          'codex session',
                          'claude code session',
                          'hermes session'
                      )
                    ORDER BY i.updated_at DESC
                    LIMIT 1
                )
                WHERE lower(trim(title)) IN (
                    'codex session',
                    'claude code session',
                    'hermes session'
                )
                  AND EXISTS (
                    SELECT 1
                    FROM agent_conversation_instances i
                    WHERE i.thread_id = threads.thread_id
                      AND trim(i.title) <> ''
                      AND lower(trim(i.title)) NOT IN (
                          'codex session',
                          'claude code session',
                          'hermes session'
                      )
                  );
                ",
            )?;
        }

        // Legacy rows may point at a deleted product thread. The supported
        // pre-conversation representation is a NULL binding, so detach them
        // before rebuilding the table with the foreign key.
        conn.execute_batch(
            "
            UPDATE agent_conversation_instances
            SET thread_id = NULL
            WHERE thread_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM threads t
                  WHERE t.thread_id = agent_conversation_instances.thread_id
              );

            DELETE FROM agent_conversation_instances
            WHERE thread_id IS NOT NULL
              AND EXISTS (
                  SELECT 1
                  FROM agent_conversation_instances newer
                  WHERE newer.thread_id = agent_conversation_instances.thread_id
                    AND (
                        newer.updated_at > agent_conversation_instances.updated_at
                        OR (
                            newer.updated_at = agent_conversation_instances.updated_at
                            AND newer.instance_id > agent_conversation_instances.instance_id
                        )
                    )
              );
            ",
        )?;

        let tx = conn.transaction()?;
        tx.execute_batch(
            "
            DROP INDEX IF EXISTS idx_agent_conversation_thread;
            DROP INDEX IF EXISTS idx_agent_conversation_thread_unique;

            ALTER TABLE agent_conversation_instances
                RENAME TO agent_conversation_instances_legacy;

            CREATE TABLE agent_conversation_instances (
                instance_id TEXT PRIMARY KEY,
                agent_type TEXT NOT NULL,
                thread_id TEXT,
                runtime_config TEXT,
                frozen_cwd TEXT,
                source_kind TEXT NOT NULL DEFAULT 'thread-card',
                source_document_path TEXT,
                source_memo_id TEXT,
                source_notebook_id TEXT,
                role_memo_id TEXT,
                role_name TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
            );

            INSERT INTO agent_conversation_instances (
                instance_id, agent_type, thread_id, runtime_config, frozen_cwd,
                source_kind, source_document_path, source_memo_id, source_notebook_id,
                role_memo_id, role_name, created_at, updated_at
            )
            SELECT
                instance_id, agent_type, thread_id, runtime_config, frozen_cwd,
                source_kind, source_document_path, source_memo_id, source_notebook_id,
                role_memo_id, role_name, created_at, updated_at
            FROM agent_conversation_instances_legacy;

            DROP TABLE agent_conversation_instances_legacy;

            CREATE INDEX idx_agent_conversation_thread
                ON agent_conversation_instances(thread_id);
            CREATE UNIQUE INDEX idx_agent_conversation_thread_unique
                ON agent_conversation_instances(thread_id)
                WHERE thread_id IS NOT NULL;
            ",
        )?;
        tx.commit()?;
        Ok(())
    }

    fn migrate_agent_external_events_table(conn: &mut Connection) -> Result<(), ThreadError> {
        let mut stmt = conn.prepare("PRAGMA table_info(agent_external_events)")?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        let has_column = |name: &str| columns.iter().any(|column| column == name);
        let needs_rebuild = !has_column("runtime")
            || !has_column("normalized_json")
            || columns.iter().any(|column| {
                matches!(
                    column.as_str(),
                    "instance_id"
                        | "run_id"
                        | "external_session_id"
                        | "sequence"
                        | "kind"
                        | "role"
                        | "message_id"
                        | "tool_call_id"
                        | "agent_type"
                        | "payload_json"
                )
            });
        drop(stmt);
        if !needs_rebuild {
            return Ok(());
        }

        let id_expr = if has_column("id") { "id" } else { "rowid" };
        let runtime_expr = if has_column("runtime") {
            "COALESCE(runtime, '')"
        } else if has_column("agent_type") {
            "COALESCE(agent_type, '')"
        } else {
            "''"
        };
        let thread_id_expr = if has_column("thread_id") {
            "COALESCE(thread_id, '')"
        } else {
            "''"
        };
        let normalized_json_expr = if has_column("normalized_json") {
            "COALESCE(normalized_json, '{}')"
        } else if has_column("payload_json") {
            "COALESCE(payload_json, '{}')"
        } else {
            "'{}'"
        };
        let raw_json_expr = if has_column("raw_json") {
            "raw_json"
        } else {
            "NULL"
        };
        let created_at_expr = if has_column("created_at") {
            "COALESCE(created_at, CAST(strftime('%s','now') AS INTEGER) * 1000)"
        } else {
            "CAST(strftime('%s','now') AS INTEGER) * 1000"
        };

        let tx = conn.transaction()?;
        tx.execute_batch(&format!(
            "
            ALTER TABLE agent_external_events RENAME TO agent_external_events_legacy;

            CREATE TABLE agent_external_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                runtime TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                event_key TEXT,
                event_kind TEXT,
                run_id TEXT,
                source_sequence INTEGER,
                source_subsequence INTEGER,
                normalized_json TEXT NOT NULL,
                raw_json TEXT,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
            );

            INSERT INTO agent_external_events (
                id, runtime, thread_id, event_key, event_kind, run_id,
                source_sequence, source_subsequence,
                normalized_json, raw_json, created_at
            )
            SELECT
                {id_expr},
                {runtime_expr},
                {thread_id_expr},
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                {normalized_json_expr},
                {raw_json_expr},
                {created_at_expr}
            FROM agent_external_events_legacy
            WHERE EXISTS (
                SELECT 1
                FROM threads t
                WHERE t.thread_id = {thread_id_expr}
            )
            ORDER BY {id_expr} ASC;

            DROP TABLE agent_external_events_legacy;
            ",
        ))?;
        tx.commit()?;
        Ok(())
    }

    fn ensure_agent_external_event_key_column(conn: &Connection) -> Result<(), ThreadError> {
        let has_column = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM pragma_table_info('agent_external_events')
                WHERE name = 'event_key'
            )",
            [],
            |row| row.get::<_, bool>(0),
        )?;
        if !has_column {
            conn.execute(
                "ALTER TABLE agent_external_events ADD COLUMN event_key TEXT",
                [],
            )?;
        }
        Ok(())
    }

    fn ensure_agent_external_event_metadata_columns(conn: &Connection) -> Result<(), ThreadError> {
        for (name, sql_type) in [
            ("event_kind", "TEXT"),
            ("run_id", "TEXT"),
            ("source_sequence", "INTEGER"),
            ("source_subsequence", "INTEGER"),
        ] {
            let exists = conn.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM pragma_table_info('agent_external_events')
                    WHERE name = ?1
                )",
                [name],
                |row| row.get::<_, bool>(0),
            )?;
            if !exists {
                conn.execute(
                    &format!("ALTER TABLE agent_external_events ADD COLUMN {name} {sql_type}"),
                    [],
                )?;
            }
        }

        conn.execute_batch(
            "UPDATE agent_external_events
             SET event_kind = CASE WHEN json_valid(normalized_json)
                    THEN json_extract(normalized_json, '$.kind') END,
                 run_id = CASE WHEN json_valid(normalized_json)
                    THEN json_extract(normalized_json, '$.run_id') END,
                 source_sequence = CASE WHEN json_valid(normalized_json)
                    THEN json_extract(normalized_json, '$.source_sequence') END,
                 source_subsequence = CASE WHEN json_valid(normalized_json)
                    THEN json_extract(normalized_json, '$.source_subsequence') END
             WHERE event_kind IS NULL;",
        )?;
        Ok(())
    }

    fn migrate_external_thread_identity(conn: &mut Connection) -> Result<(), ThreadError> {
        let tx = conn.transaction()?;
        tx.execute_batch(
            "
            DROP TABLE IF EXISTS temp.external_session_aliases;
            DROP TABLE IF EXISTS temp.resolved_agent_conversation_instances;
            -- This index includes thread_id, which is rewritten below. Rebuild
            -- it after identity reconciliation so equivalent external events
            -- can be deduplicated under their canonical local thread id.
            DROP INDEX IF EXISTS idx_agent_external_events_idempotency;
            CREATE TEMP TABLE external_session_aliases AS
            SELECT
                s.thread_id AS local_thread_id,
                s.runtime AS runtime,
                s.external_session_id AS external_session_id,
                COALESCE(s.session_metadata_json, (
                    SELECT self.session_metadata_json
                    FROM thread_external_sessions self
                    WHERE self.thread_id = s.external_session_id
                      AND self.runtime = s.runtime
                      AND self.external_session_id = s.external_session_id
                    LIMIT 1
                )) AS session_metadata_json,
                s.created_at AS created_at,
                s.updated_at AS updated_at
            FROM thread_external_sessions s
            WHERE s.external_session_id IS NOT NULL
              AND s.external_session_id <> ''
              AND s.thread_id <> s.external_session_id
              AND NOT EXISTS (
                  SELECT 1
                  FROM thread_external_sessions newer
                  WHERE newer.external_session_id = s.external_session_id
                    AND newer.runtime = s.runtime
                    AND newer.thread_id <> newer.external_session_id
                    AND (
                        newer.updated_at > s.updated_at
                        OR (
                            newer.updated_at = s.updated_at
                            AND newer.thread_id > s.thread_id
                        )
                    )
              );

            INSERT OR IGNORE INTO threads (
                thread_id, agent_id, title, created_at, updated_at
            )
            SELECT
                a.local_thread_id,
                c.agent_id,
                c.title,
                min(c.created_at, a.created_at),
                max(c.updated_at, a.updated_at)
            FROM external_session_aliases a
            JOIN threads c ON c.thread_id = a.external_session_id;

            UPDATE threads
            SET title = (
                    SELECT c.title
                    FROM external_session_aliases a
                    JOIN threads c ON c.thread_id = a.external_session_id
                    WHERE a.local_thread_id = threads.thread_id
                      AND lower(trim(c.title)) NOT IN (
                          'codex session',
                          'claude code session',
                          'hermes session'
                      )
                    LIMIT 1
                ),
                updated_at = max(updated_at, (
                    SELECT c.updated_at
                    FROM external_session_aliases a
                    JOIN threads c ON c.thread_id = a.external_session_id
                    WHERE a.local_thread_id = threads.thread_id
                    LIMIT 1
                ))
            WHERE lower(trim(title)) IN (
                    'codex session',
                    'claude code session',
                    'hermes session'
                )
              AND EXISTS (
                  SELECT 1
                  FROM external_session_aliases a
                  JOIN threads c ON c.thread_id = a.external_session_id
                  WHERE a.local_thread_id = threads.thread_id
                    AND lower(trim(c.title)) NOT IN (
                        'codex session',
                        'claude code session',
                        'hermes session'
                )
              );

            -- A legacy external session can have both a temporary local card
            -- instance and a later provider-session instance. Both resolve to
            -- the same canonical thread id, so choose the newest record *before*
            -- rewriting thread_id. This keeps an existing unique index from
            -- rejecting the UPDATE and also repairs databases that were left in
            -- the pre-unique-index shape by an earlier build.
            CREATE TEMP TABLE resolved_agent_conversation_instances AS
            SELECT
                i.instance_id,
                COALESCE((
                    SELECT a.local_thread_id
                    FROM external_session_aliases a
                    WHERE a.external_session_id = i.thread_id
                    ORDER BY a.updated_at DESC, a.local_thread_id DESC
                    LIMIT 1
                ), i.thread_id) AS canonical_thread_id,
                i.updated_at,
                i.source_memo_id,
                i.source_document_path
            FROM agent_conversation_instances i
            WHERE i.thread_id IS NOT NULL;

            DELETE FROM agent_conversation_instances
            WHERE instance_id IN (
                SELECT stale.instance_id
                FROM resolved_agent_conversation_instances stale
                JOIN resolved_agent_conversation_instances newer
                  ON newer.canonical_thread_id = stale.canonical_thread_id
                 AND (
                    newer.updated_at > stale.updated_at
                    OR (
                        newer.updated_at = stale.updated_at
                        AND (
                            (newer.source_memo_id IS NOT NULL AND stale.source_memo_id IS NULL)
                            OR (
                                (newer.source_memo_id IS NOT NULL) = (stale.source_memo_id IS NOT NULL)
                                AND newer.source_document_path IS NOT NULL
                                AND stale.source_document_path IS NULL
                            )
                            OR (
                                (newer.source_memo_id IS NOT NULL) = (stale.source_memo_id IS NOT NULL)
                                AND (newer.source_document_path IS NOT NULL) = (stale.source_document_path IS NOT NULL)
                                AND newer.instance_id > stale.instance_id
                            )
                        )
                    )
                 )
            );

            UPDATE agent_conversation_instances
            SET thread_id = (
                    SELECT a.local_thread_id
                    FROM external_session_aliases a
                    WHERE a.external_session_id = agent_conversation_instances.thread_id
                    LIMIT 1
                ),
                updated_at = max(updated_at, (
                    SELECT t.updated_at
                    FROM external_session_aliases a
                    JOIN threads t ON t.thread_id = a.local_thread_id
                    WHERE a.external_session_id = agent_conversation_instances.thread_id
                    LIMIT 1
                ))
            WHERE thread_id IN (
                SELECT external_session_id FROM external_session_aliases
            );

            UPDATE agent_external_events
            SET thread_id = (
                    SELECT a.local_thread_id
                    FROM external_session_aliases a
                    WHERE a.external_session_id = agent_external_events.thread_id
                    LIMIT 1
                )
            WHERE thread_id IN (
                SELECT external_session_id FROM external_session_aliases
            );

            DELETE FROM threads
            WHERE thread_id IN (
                SELECT external_session_id FROM external_session_aliases
            );

            ALTER TABLE thread_external_sessions RENAME TO thread_external_sessions_legacy;

            CREATE TABLE thread_external_sessions (
                thread_id TEXT NOT NULL,
                runtime TEXT NOT NULL,
                external_session_id TEXT NOT NULL,
                session_metadata_json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (thread_id, runtime),
                UNIQUE (runtime, external_session_id),
                FOREIGN KEY(thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
            );

            INSERT OR REPLACE INTO thread_external_sessions (
                thread_id, runtime, external_session_id, session_metadata_json, created_at, updated_at
            )
            SELECT
                a.local_thread_id,
                a.runtime,
                a.external_session_id,
                a.session_metadata_json,
                a.created_at,
                a.updated_at
            FROM external_session_aliases a
            WHERE EXISTS (
                SELECT 1 FROM threads t WHERE t.thread_id = a.local_thread_id
            );

            DROP TABLE thread_external_sessions_legacy;
            DROP TABLE IF EXISTS temp.resolved_agent_conversation_instances;
            DROP TABLE IF EXISTS temp.external_session_aliases;
            ",
        )?;
        tx.commit()?;
        Ok(())
    }
}
