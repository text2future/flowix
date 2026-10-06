use super::*;
use std::collections::HashMap;
use crate::v2::{
    V2CloudAccount, V2DirtyEntity, V2EntityType, V2FreezeOperation, V2InflightOperation,
    V2NoteState, V2NotebookState, V2OperationKind, V2RemoteApply, V2SyncedNotebook, PROTOCOL_EPOCH,
};

impl SyncStore {
    pub(super) fn initialize_v2_schema(connection: &Connection) -> Result<(), SyncError> {
        connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS v2_cloud_account (
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                user_id TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                protocol_epoch INTEGER NOT NULL CHECK(protocol_epoch = 2),
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS v2_sync_state (
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor >= 0),
                last_success_at INTEGER,
                updated_at INTEGER NOT NULL
            );
            INSERT OR IGNORE INTO v2_sync_state(singleton, cursor, updated_at)
            VALUES (1, 0, 0);
            CREATE TABLE IF NOT EXISTS v2_notebook_sync_state (
                notebook_id TEXT PRIMARY KEY,
                cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor >= 0),
                last_success_at INTEGER,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS v2_synced_notebooks (
                notebook_id TEXT PRIMARY KEY,
                enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
                bootstrap_required INTEGER NOT NULL DEFAULT 1 CHECK(bootstrap_required IN (0, 1)),
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS v2_note_states (
                note_id TEXT PRIMARY KEY,
                notebook_id TEXT NOT NULL,
                revision TEXT NOT NULL,
                content_hash TEXT,
                attachments_json TEXT NOT NULL DEFAULT '[]',
                filename TEXT NOT NULL,
                deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0, 1)),
                last_seq INTEGER NOT NULL CHECK(last_seq >= 0),
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_v2_note_states_notebook
                ON v2_note_states(notebook_id, last_seq);
            CREATE TABLE IF NOT EXISTS v2_notebook_states (
                notebook_id TEXT PRIMARY KEY,
                revision TEXT NOT NULL,
                metadata_hash TEXT NOT NULL,
                deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0, 1)),
                last_seq INTEGER NOT NULL CHECK(last_seq >= 0),
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS v2_dirty_entities (
                entity_type TEXT NOT NULL CHECK(entity_type IN ('notebook', 'note')),
                entity_id TEXT NOT NULL,
                notebook_id TEXT,
                generation INTEGER NOT NULL CHECK(generation > 0),
                operation_kind TEXT NOT NULL CHECK(operation_kind IN ('put', 'delete')),
                fingerprint TEXT NOT NULL,
                detected_at INTEGER NOT NULL,
                PRIMARY KEY(entity_type, entity_id)
            );
            CREATE TABLE IF NOT EXISTS v2_inflight_operations (
                operation_id TEXT PRIMARY KEY,
                entity_type TEXT NOT NULL CHECK(entity_type IN ('notebook', 'note')),
                entity_id TEXT NOT NULL,
                generation INTEGER NOT NULL CHECK(generation > 0),
                operation_kind TEXT NOT NULL CHECK(operation_kind IN ('put', 'delete')),
                base_revision TEXT,
                payload_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                UNIQUE(entity_type, entity_id, generation)
            );
            CREATE TABLE IF NOT EXISTS v2_retry_state (
                operation_id TEXT PRIMARY KEY REFERENCES v2_inflight_operations(operation_id) ON DELETE CASCADE,
                attempts INTEGER NOT NULL DEFAULT 0,
                next_retry_at INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS v2_pending_moves (
                from_note_id TEXT PRIMARY KEY,
                operation_id TEXT NOT NULL UNIQUE,
                notebook_id TEXT NOT NULL,
                from_path TEXT NOT NULL,
                to_note_id TEXT NOT NULL,
                to_path TEXT NOT NULL,
                base_revision TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            "#,
        )?;
        let has_fingerprint = connection
            .query_row(
                "SELECT 1 FROM pragma_table_info('v2_dirty_entities') WHERE name = 'fingerprint'",
                [],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !has_fingerprint {
            connection.execute(
                "ALTER TABLE v2_dirty_entities ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''",
                [],
            )?;
        }
        let has_attachments = connection
            .query_row(
                "SELECT 1 FROM pragma_table_info('v2_note_states') WHERE name = 'attachments_json'",
                [],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !has_attachments {
            connection.execute(
                "ALTER TABLE v2_note_states ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'",
                [],
            )?;
        }
        Ok(())
    }

    pub fn save_v2_account(&self, account: &V2CloudAccount) -> Result<(), SyncError> {
        if account.protocol_epoch != PROTOCOL_EPOCH {
            return Err(SyncError::InvalidState(format!(
                "unsupported cloud protocol epoch {}",
                account.protocol_epoch
            )));
        }
        let now = chrono::Utc::now().timestamp_millis();
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        let previous_user = transaction
            .query_row(
                "SELECT user_id FROM v2_cloud_account WHERE singleton = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if previous_user
            .as_deref()
            .is_some_and(|user_id| user_id != account.user.id)
        {
            transaction.execute_batch(
                r#"
                DELETE FROM v2_retry_state;
                DELETE FROM v2_pending_moves;
                DELETE FROM v2_inflight_operations;
                DELETE FROM v2_dirty_entities;
                DELETE FROM v2_note_states;
                DELETE FROM v2_notebook_states;
                DELETE FROM v2_notebook_sync_state;
                DELETE FROM v2_synced_notebooks;
                UPDATE v2_sync_state SET cursor = 0, last_success_at = NULL, updated_at = 0
                 WHERE singleton = 1;
                "#,
            )?;
        }
        transaction.execute(
            r#"INSERT INTO v2_cloud_account(singleton, user_id, payload_json, protocol_epoch, updated_at)
               VALUES (1, ?1, ?2, ?3, ?4)
               ON CONFLICT(singleton) DO UPDATE SET user_id = excluded.user_id,
                 payload_json = excluded.payload_json, protocol_epoch = excluded.protocol_epoch,
                 updated_at = excluded.updated_at"#,
            params![account.user.id, serde_json::to_string(account).map_err(|error| {
                SyncError::InvalidState(format!("serialize v2 cloud account: {error}"))
            })?, account.protocol_epoch, now],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn clear_v2_account(&self) -> Result<(), SyncError> {
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        transaction.execute_batch(
            r#"
            DELETE FROM v2_retry_state;
            DELETE FROM v2_pending_moves;
            DELETE FROM v2_inflight_operations;
            DELETE FROM v2_dirty_entities;
            DELETE FROM v2_note_states;
            DELETE FROM v2_notebook_states;
            DELETE FROM v2_notebook_sync_state;
            DELETE FROM v2_synced_notebooks;
            DELETE FROM v2_cloud_account;
            UPDATE v2_sync_state SET cursor = 0, last_success_at = NULL, updated_at = 0
             WHERE singleton = 1;
            "#,
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn v2_account(&self) -> Result<Option<V2CloudAccount>, SyncError> {
        self.open()?
            .query_row(
                "SELECT payload_json FROM v2_cloud_account WHERE singleton = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|payload| {
                serde_json::from_str(&payload).map_err(|error| {
                    SyncError::InvalidState(format!("invalid stored v2 cloud account: {error}"))
                })
            })
            .transpose()
    }

    pub fn v2_cursor(&self) -> Result<i64, SyncError> {
        self.open()?
            .query_row(
                "SELECT cursor FROM v2_sync_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .map_err(SyncError::from)
    }

    pub fn v2_notebook_cursor(&self, notebook_id: &str) -> Result<i64, SyncError> {
        let connection = self.open()?;
        connection.execute(
            "INSERT OR IGNORE INTO v2_notebook_sync_state(notebook_id, cursor, updated_at) VALUES (?1, 0, ?2)",
            params![notebook_id, chrono::Utc::now().timestamp_millis()],
        )?;
        connection
            .query_row(
                "SELECT cursor FROM v2_notebook_sync_state WHERE notebook_id = ?1",
                [notebook_id],
                |row| row.get(0),
            )
            .map_err(SyncError::from)
    }

    pub fn set_v2_notebook(
        &self,
        notebook_id: &str,
        enabled: bool,
    ) -> Result<V2SyncedNotebook, SyncError> {
        let now = chrono::Utc::now().timestamp_millis();
        let connection = self.open()?;
        connection.execute(
            r#"INSERT INTO v2_synced_notebooks
                 (notebook_id, enabled, bootstrap_required, created_at, updated_at)
               VALUES (?1, ?2, 1, ?3, ?3)
               ON CONFLICT(notebook_id) DO UPDATE SET
                 enabled = excluded.enabled,
                 bootstrap_required = CASE
                   WHEN v2_synced_notebooks.enabled = 0 AND excluded.enabled = 1 THEN 1
                   ELSE v2_synced_notebooks.bootstrap_required
                 END,
                 updated_at = excluded.updated_at"#,
            params![notebook_id, enabled, now],
        )?;
        connection.execute(
            "INSERT OR IGNORE INTO v2_notebook_sync_state(notebook_id, cursor, updated_at) VALUES (?1, 0, ?2)",
            params![notebook_id, now],
        )?;
        Self::read_v2_notebook(&connection, notebook_id)?.ok_or_else(|| {
            SyncError::InvalidState("v2 notebook state disappeared after write".into())
        })
    }

    pub fn v2_notebooks(&self, enabled_only: bool) -> Result<Vec<V2SyncedNotebook>, SyncError> {
        let connection = self.open()?;
        let mut statement = connection.prepare(
            r#"SELECT notebook_id, enabled, bootstrap_required, updated_at
                 FROM v2_synced_notebooks
                WHERE (?1 = 0 OR enabled = 1)
                ORDER BY created_at"#,
        )?;
        let rows = statement.query_map([enabled_only], |row| {
            Ok(V2SyncedNotebook {
                notebook_id: row.get(0)?,
                enabled: row.get(1)?,
                bootstrap_required: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(SyncError::from)
    }

    /// Count queued file operations by enabled notebook. Dirty note rows stay
    /// present while their frozen operation is in flight, so adding the
    /// inflight table here would count the same work twice.
    pub fn v2_pending_file_operation_counts(
        &self,
    ) -> Result<HashMap<String, i64>, SyncError> {
        let connection = self.open()?;
        let mut statement = connection.prepare(
            r#"SELECT notebook_id, COUNT(*) FROM (
                   SELECT dirty.notebook_id AS notebook_id
                     FROM v2_dirty_entities AS dirty
                     JOIN v2_synced_notebooks AS notebook
                       ON notebook.notebook_id = dirty.notebook_id
                    WHERE dirty.entity_type = 'note' AND notebook.enabled = 1
                   UNION ALL
                   SELECT movement.notebook_id AS notebook_id
                     FROM v2_pending_moves AS movement
                     JOIN v2_synced_notebooks AS notebook
                       ON notebook.notebook_id = movement.notebook_id
                    WHERE notebook.enabled = 1
               ) GROUP BY notebook_id"#,
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        rows.collect::<Result<HashMap<_, _>, _>>()
            .map_err(SyncError::from)
    }

    pub fn complete_v2_notebook_bootstrap(&self, notebook_id: &str) -> Result<(), SyncError> {
        self.open()?.execute(
            "UPDATE v2_synced_notebooks SET bootstrap_required = 0, updated_at = ?2 WHERE notebook_id = ?1",
            params![notebook_id, chrono::Utc::now().timestamp_millis()],
        )?;
        Ok(())
    }

    pub fn mark_v2_dirty(
        &self,
        entity_type: V2EntityType,
        entity_id: &str,
        notebook_id: Option<&str>,
        operation_kind: V2OperationKind,
        fingerprint: &str,
        detected_at: i64,
    ) -> Result<V2DirtyEntity, SyncError> {
        self.mark_v2_dirty_with_change(
            entity_type,
            entity_id,
            notebook_id,
            operation_kind,
            fingerprint,
            detected_at,
        )
        .map(|(dirty, _changed)| dirty)
    }

    /// Persist a dirty entity and report whether this observation represents
    /// a new logical generation. Repeated editor/watcher observations of the
    /// same operation and fingerprint keep the existing generation and must
    /// not schedule another cloud pass.
    pub fn mark_v2_dirty_with_change(
        &self,
        entity_type: V2EntityType,
        entity_id: &str,
        notebook_id: Option<&str>,
        operation_kind: V2OperationKind,
        fingerprint: &str,
        detected_at: i64,
    ) -> Result<(V2DirtyEntity, bool), SyncError> {
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        let current = transaction.query_row(
            "SELECT generation, operation_kind, fingerprint FROM v2_dirty_entities WHERE entity_type = ?1 AND entity_id = ?2",
            params![entity_type.as_str(), entity_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        ).optional()?;
        let changed = !matches!(
            &current,
            Some((_generation, current_kind, current_fingerprint))
                if current_kind == operation_kind.as_str()
                    && current_fingerprint == fingerprint
        );
        let next_generation = match &current {
            Some((generation, current_kind, current_fingerprint))
                if current_kind == operation_kind.as_str()
                    && current_fingerprint == fingerprint =>
            {
                *generation
            }
            Some((generation, _, _)) => generation.saturating_add(1),
            None => 1,
        };
        transaction.execute(
            r#"INSERT INTO v2_dirty_entities
                 (entity_type, entity_id, notebook_id, generation, operation_kind, fingerprint, detected_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
               ON CONFLICT(entity_type, entity_id) DO UPDATE SET
                 notebook_id = excluded.notebook_id, generation = excluded.generation,
                 operation_kind = excluded.operation_kind, fingerprint = excluded.fingerprint,
                 detected_at = CASE
                   WHEN v2_dirty_entities.generation = excluded.generation
                     THEN v2_dirty_entities.detected_at
                   ELSE excluded.detected_at
                 END"#,
            params![
                entity_type.as_str(),
                entity_id,
                notebook_id,
                next_generation,
                operation_kind.as_str(),
                fingerprint,
                detected_at
            ],
        )?;
        transaction.commit()?;
        Ok((
            V2DirtyEntity {
                entity_type,
                entity_id: entity_id.into(),
                notebook_id: notebook_id.map(str::to_owned),
                generation: next_generation,
                operation_kind,
                fingerprint: fingerprint.to_owned(),
                detected_at,
            },
            changed,
        ))
    }

    pub fn v2_dirty_entities(&self) -> Result<Vec<V2DirtyEntity>, SyncError> {
        let connection = self.open()?;
        let mut statement = connection.prepare(
            r#"SELECT entity_type, entity_id, notebook_id, generation,
                      operation_kind, fingerprint, detected_at
                 FROM v2_dirty_entities ORDER BY detected_at, entity_type, entity_id"#,
        )?;
        let rows = statement.query_map([], |row| {
            let entity_type: String = row.get(0)?;
            let operation_kind: String = row.get(4)?;
            Ok(V2DirtyEntity {
                entity_type: V2EntityType::parse(&entity_type)
                    .ok_or(rusqlite::Error::InvalidQuery)?,
                entity_id: row.get(1)?,
                notebook_id: row.get(2)?,
                generation: row.get(3)?,
                operation_kind: V2OperationKind::parse(&operation_kind)
                    .ok_or(rusqlite::Error::InvalidQuery)?,
                fingerprint: row.get(5)?,
                detected_at: row.get(6)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(SyncError::from)
    }

    pub fn v2_inflight_for_generation(
        &self,
        entity_type: V2EntityType,
        entity_id: &str,
        generation: i64,
    ) -> Result<Option<V2InflightOperation>, SyncError> {
        Self::read_v2_inflight(&self.open()?, entity_type, entity_id, generation)
    }

    pub fn freeze_v2_operation(
        &self,
        input: V2FreezeOperation<'_>,
    ) -> Result<V2InflightOperation, SyncError> {
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        let dirty_generation = transaction.query_row(
            "SELECT generation FROM v2_dirty_entities WHERE entity_type = ?1 AND entity_id = ?2",
            params![input.entity_type.as_str(), input.entity_id],
            |row| row.get::<_, i64>(0),
        ).optional()?;
        if dirty_generation != Some(input.generation) {
            return Err(SyncError::InvalidState(format!(
                "dirty generation changed before operation freeze: entity={}:{} expected={} actual={dirty_generation:?}",
                input.entity_type.as_str(), input.entity_id, input.generation
            )));
        }
        transaction.execute(
            r#"INSERT INTO v2_inflight_operations
                 (operation_id, entity_type, entity_id, generation, operation_kind,
                  base_revision, payload_json, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
               ON CONFLICT(entity_type, entity_id, generation) DO NOTHING"#,
            params![
                input.operation_id,
                input.entity_type.as_str(),
                input.entity_id,
                input.generation,
                input.operation_kind.as_str(),
                input.base_revision,
                input.payload_json,
                chrono::Utc::now().timestamp_millis()
            ],
        )?;
        let operation = Self::read_v2_inflight(
            &transaction,
            input.entity_type,
            input.entity_id,
            input.generation,
        )?
        .ok_or_else(|| SyncError::InvalidState("v2 inflight operation was not persisted".into()))?;
        transaction.execute(
            r#"INSERT OR IGNORE INTO v2_retry_state(operation_id, attempts, next_retry_at, updated_at)
               VALUES (?1, 0, 0, ?2)"#,
            params![operation.operation_id, chrono::Utc::now().timestamp_millis()],
        )?;
        transaction.commit()?;
        Ok(operation)
    }

    pub fn v2_inflight_due(&self, now: i64) -> Result<Vec<V2InflightOperation>, SyncError> {
        let connection = self.open()?;
        let mut statement = connection.prepare(
            r#"SELECT o.operation_id, o.entity_type, o.entity_id, o.generation,
                      o.operation_kind, o.base_revision, o.payload_json,
                      r.attempts, r.next_retry_at
                 FROM v2_inflight_operations o
                 JOIN v2_retry_state r ON r.operation_id = o.operation_id
                WHERE r.next_retry_at <= ?1
                ORDER BY o.created_at"#,
        )?;
        let rows = statement.query_map([now], Self::map_v2_inflight)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(SyncError::from)
    }

    pub fn v2_inflight_due_for_notebook(
        &self,
        now: i64,
        notebook_id: &str,
    ) -> Result<Vec<V2InflightOperation>, SyncError> {
        let connection = self.open()?;
        let mut statement = connection.prepare(
            r#"SELECT o.operation_id, o.entity_type, o.entity_id, o.generation,
                      o.operation_kind, o.base_revision, o.payload_json,
                      r.attempts, r.next_retry_at
                 FROM v2_inflight_operations o
                 JOIN v2_retry_state r ON r.operation_id = o.operation_id
                WHERE r.next_retry_at <= ?1
                  AND ((o.entity_type = 'notebook' AND o.entity_id = ?2)
                    OR (o.entity_type = 'note' AND o.entity_id IN (
                      SELECT entity_id FROM v2_dirty_entities
                       WHERE entity_type = 'note' AND notebook_id = ?2
                    )))
                ORDER BY o.created_at"#,
        )?;
        let rows = statement.query_map(params![now, notebook_id], Self::map_v2_inflight)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(SyncError::from)
    }

    /// A Markdown file can disappear locally while its memo-index row and a
    /// previously queued upload still exist.  The caller has elected to use
    /// the cloud copy as the recovery source, so the stale local operation
    /// must not win over the forthcoming bootstrap response.
    ///
    /// Keep the server-side note state intact: this is deliberately *not* a
    /// delete.  Requiring a notebook bootstrap makes the current cloud copy
    /// available to the local adapter again.
    pub fn recover_missing_v2_note(
        &self,
        notebook_id: &str,
        note_id: &str,
    ) -> Result<(), SyncError> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            r#"DELETE FROM v2_inflight_operations
                WHERE entity_type = ?1 AND entity_id = ?2"#,
            params![V2EntityType::Note.as_str(), note_id],
        )?;
        transaction.execute(
            r#"DELETE FROM v2_dirty_entities
                WHERE entity_type = ?1 AND entity_id = ?2"#,
            params![V2EntityType::Note.as_str(), note_id],
        )?;
        transaction.execute(
            r#"UPDATE v2_synced_notebooks
                   SET bootstrap_required = 1, updated_at = ?2
                 WHERE notebook_id = ?1 AND enabled = 1"#,
            params![notebook_id, now],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn discard_v2_unsynced_note(&self, note_id: &str) -> Result<(), SyncError> {
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "DELETE FROM v2_inflight_operations WHERE entity_type = 'note' AND entity_id = ?1",
            [note_id],
        )?;
        transaction.execute(
            "DELETE FROM v2_dirty_entities WHERE entity_type = 'note' AND entity_id = ?1",
            [note_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Replace a rejected local operation's base with the remote head only
    /// after the desktop adapter has merged or versioned the rejected local bytes.
    pub fn rebase_v2_note_after_conflict(
        &self,
        remote: &crate::v2::V2BootstrapNote,
    ) -> Result<(), SyncError> {
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "DELETE FROM v2_inflight_operations WHERE entity_type = 'note' AND entity_id = ?1",
            [&remote.id],
        )?;
        transaction.execute(
            "DELETE FROM v2_dirty_entities WHERE entity_type = 'note' AND entity_id = ?1",
            [&remote.id],
        )?;
        Self::write_v2_note_state(&transaction, &V2NoteState {
            note_id: remote.id.clone(),
            notebook_id: remote.notebook_id.clone(),
            revision: remote.revision.clone(),
            content_hash: remote.content_hash.clone(),
            filename: remote.filename.clone(),
            deleted: remote.deleted,
            last_seq: remote.sync_seq,
            attachments: remote.attachments.clone(),
        })?;
        transaction.execute(
            "UPDATE v2_synced_notebooks SET bootstrap_required = 1, updated_at = ?2 WHERE notebook_id = ?1 AND enabled = 1",
            params![remote.notebook_id, chrono::Utc::now().timestamp_millis()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn rebase_v2_moved_conflict(
        &self,
        source: &crate::v2::V2BootstrapNote,
        target: &crate::v2::V2BootstrapNote,
    ) -> Result<(), SyncError> {
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM v2_inflight_operations WHERE entity_type = 'note' AND entity_id = ?1", [&source.id])?;
        transaction.execute("DELETE FROM v2_dirty_entities WHERE entity_type = 'note' AND entity_id = ?1", [&source.id])?;
        for remote in [source, target] {
            Self::write_v2_note_state(&transaction, &V2NoteState {
                note_id: remote.id.clone(), notebook_id: remote.notebook_id.clone(),
                revision: remote.revision.clone(), content_hash: remote.content_hash.clone(),
                filename: remote.filename.clone(), deleted: remote.deleted,
                last_seq: remote.sync_seq, attachments: remote.attachments.clone(),
            })?;
        }
        transaction.execute(
            "UPDATE v2_synced_notebooks SET bootstrap_required = 1, updated_at = ?2 WHERE notebook_id = ?1 AND enabled = 1",
            params![source.notebook_id, chrono::Utc::now().timestamp_millis()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// A notebook delete supersedes every queued note operation below it.
    /// Leaving a stale note put behind could otherwise recreate a note after
    /// the parent notebook has been deleted remotely.
    pub fn discard_v2_note_operations_for_notebook(
        &self,
        notebook_id: &str,
    ) -> Result<(), SyncError> {
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            r#"DELETE FROM v2_inflight_operations
                WHERE entity_type = ?1
                  AND entity_id IN (
                    SELECT entity_id FROM v2_dirty_entities
                     WHERE entity_type = ?1 AND notebook_id = ?2
                  )"#,
            params![V2EntityType::Note.as_str(), notebook_id],
        )?;
        transaction.execute(
            r#"DELETE FROM v2_dirty_entities
                WHERE entity_type = ?1 AND notebook_id = ?2"#,
            params![V2EntityType::Note.as_str(), notebook_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn v2_next_retry_at(&self) -> Result<Option<i64>, SyncError> {
        self.open()?
            .query_row("SELECT MIN(next_retry_at) FROM v2_retry_state", [], |row| {
                row.get::<_, Option<i64>>(0)
            })
            .map_err(SyncError::from)
    }

    pub fn defer_v2_operation(
        &self,
        operation_id: &str,
        now: i64,
        message: &str,
    ) -> Result<i64, SyncError> {
        let connection = self.open()?;
        let attempts = connection.query_row(
            "SELECT attempts FROM v2_retry_state WHERE operation_id = ?1",
            [operation_id],
            |row| row.get::<_, i64>(0),
        )? + 1;
        let exponent = u32::try_from(attempts.saturating_sub(1).min(10)).unwrap_or(10);
        let delay = 5_000_i64.saturating_mul(2_i64.pow(exponent)).min(3_600_000);
        let next_retry_at = now.saturating_add(delay);
        connection.execute(
            r#"UPDATE v2_retry_state SET attempts = ?2, next_retry_at = ?3,
                 last_error = ?4, updated_at = ?1 WHERE operation_id = ?5"#,
            params![now, attempts, next_retry_at, message, operation_id],
        )?;
        Ok(next_retry_at)
    }

    pub fn acknowledge_v2_operation(
        &self,
        operation_id: &str,
        entity_type: V2EntityType,
        entity_id: &str,
        generation: i64,
        operation: &crate::v2::V2PushOperation,
        data: &crate::v2::V2OperationData,
    ) -> Result<(), SyncError> {
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        if data.entity_id != entity_id || data.entity_type != entity_type.as_str() {
            return Err(SyncError::InvalidState(format!(
                "cloud operation result does not match inflight entity: expected={}:{} actual={}:{}",
                entity_type.as_str(),
                entity_id,
                data.entity_type,
                data.entity_id
            )));
        }
        match operation {
            crate::v2::V2PushOperation::NotebookPut { notebook, .. } => {
                Self::write_v2_notebook_state_if_newer(
                    &transaction,
                    &V2NotebookState {
                        notebook_id: notebook.id.clone(),
                        revision: data.revision.clone(),
                        metadata_hash: crate::v2::v2_notebook_metadata_hash(
                            &notebook.name,
                            notebook.icon.as_deref(),
                            notebook.sort_order,
                        ),
                        deleted: data.deleted,
                        last_seq: data.sync_seq,
                    },
                )?;
            }
            crate::v2::V2PushOperation::NotebookDelete { notebook_id, .. } => {
                let current = Self::read_v2_notebook_state(&transaction, notebook_id)?
                    .ok_or_else(|| {
                        SyncError::InvalidState(format!(
                            "cannot acknowledge notebook delete without a local server head: {notebook_id}"
                        ))
                    })?;
                Self::write_v2_notebook_state_if_newer(
                    &transaction,
                    &V2NotebookState {
                        notebook_id: notebook_id.clone(),
                        revision: data.revision.clone(),
                        metadata_hash: current.metadata_hash,
                        deleted: data.deleted,
                        last_seq: data.sync_seq,
                    },
                )?;
            }
            crate::v2::V2PushOperation::NotePut { note, .. } => {
                Self::write_v2_note_state_if_newer(
                    &transaction,
                    &V2NoteState {
                        note_id: note.id.clone(),
                        notebook_id: note.notebook_id.clone(),
                        revision: data.revision.clone(),
                        content_hash: Some(note.content_hash.clone()),
                        filename: note.filename.clone(),
                        deleted: data.deleted,
                        last_seq: data.sync_seq,
                        attachments: note.attachments.clone(),
                    },
                )?;
            }
            crate::v2::V2PushOperation::NoteDelete { note_id, .. } => {
                let current =
                    Self::read_v2_note_state(&transaction, note_id)?.ok_or_else(|| {
                        SyncError::InvalidState(format!(
                            "cannot acknowledge note delete without a local server head: {note_id}"
                        ))
                    })?;
                Self::write_v2_note_state_if_newer(
                    &transaction,
                    &V2NoteState {
                        note_id: note_id.clone(),
                        notebook_id: current.notebook_id,
                        revision: data.revision.clone(),
                        content_hash: None,
                        filename: current.filename,
                        deleted: data.deleted,
                        last_seq: data.sync_seq,
                        attachments: Vec::new(),
                    },
                )?;
            }
            crate::v2::V2PushOperation::NoteMove { .. } => {
                return Err(SyncError::InvalidState("move requires its own two-head acknowledgement".into()));
            }
        }
        transaction.execute(
            "DELETE FROM v2_inflight_operations WHERE operation_id = ?1",
            [operation_id],
        )?;
        transaction.execute(
            "DELETE FROM v2_dirty_entities WHERE entity_type = ?1 AND entity_id = ?2 AND generation = ?3",
            params![entity_type.as_str(), entity_id, generation],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn save_v2_note_state(&self, state: &V2NoteState) -> Result<(), SyncError> {
        Self::write_v2_note_state(&self.open()?, state)
    }

    pub fn v2_note_state(&self, note_id: &str) -> Result<Option<V2NoteState>, SyncError> {
        Self::read_v2_note_state(&self.open()?, note_id)
    }

    pub fn v2_all_note_states(&self) -> Result<Vec<V2NoteState>, SyncError> {
        let connection = self.open()?;
        let mut statement = connection.prepare("SELECT note_id FROM v2_note_states")?;
        let ids = statement.query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.iter().map(|id| Self::read_v2_note_state(&connection, id).map(Option::unwrap)).collect()
    }

    pub fn enqueue_v2_move(
        &self,
        notebook_id: &str,
        from_path: &str,
        to_path: &str,
    ) -> Result<bool, SyncError> {
        if from_path == to_path || from_path.starts_with("attachments/") != to_path.starts_with("attachments/") {
            return Ok(false);
        }
        let from_note_id = crate::v2::v2_path_note_id(notebook_id, from_path);
        let to_note_id = crate::v2::v2_path_note_id(notebook_id, to_path);
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        let Some(source) = Self::read_v2_note_state(&transaction, &from_note_id)? else {
            return Ok(false);
        };
        if source.deleted || source.filename != from_path {
            return Ok(false);
        }
        if let Some(target) = Self::read_v2_note_state(&transaction, &to_note_id)? {
            // A path keeps its deterministic ID after deletion. Reusing that
            // tombstone is the normal way to move a file back to an earlier
            // path; only a live or mismatched target blocks the move.
            if !target.deleted || target.notebook_id != notebook_id || target.filename != to_path {
                return Ok(false);
            }
        }
        let operation_id = crate::v2::new_v2_operation_id();
        let inserted = transaction.execute(
            r#"INSERT OR IGNORE INTO v2_pending_moves
                 (from_note_id, operation_id, notebook_id, from_path, to_note_id, to_path, base_revision, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"#,
            params![from_note_id, operation_id, notebook_id, from_path, to_note_id, to_path,
                source.revision, chrono::Utc::now().timestamp_millis()],
        )?;
        if inserted > 0 {
            transaction.execute("DELETE FROM v2_inflight_operations WHERE entity_type = 'note' AND entity_id = ?1", [&from_note_id])?;
            transaction.execute("DELETE FROM v2_dirty_entities WHERE entity_type = 'note' AND entity_id = ?1", [&from_note_id])?;
        }
        transaction.commit()?;
        Ok(inserted > 0)
    }

    pub fn v2_pending_moves(&self) -> Result<Vec<crate::v2::V2PendingMove>, SyncError> {
        let connection = self.open()?;
        let mut statement = connection.prepare(
            "SELECT operation_id, notebook_id, from_note_id, from_path, to_note_id, to_path, base_revision FROM v2_pending_moves ORDER BY created_at",
        )?;
        let rows = statement.query_map([], |row| Ok(crate::v2::V2PendingMove {
            operation_id: row.get(0)?, notebook_id: row.get(1)?, from_note_id: row.get(2)?,
            from_path: row.get(3)?, to_note_id: row.get(4)?, to_path: row.get(5)?,
            base_revision: row.get(6)?,
        }))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(SyncError::from)
    }

    pub fn v2_pending_move(&self, operation_id: &str) -> Result<Option<crate::v2::V2PendingMove>, SyncError> {
        Ok(self.v2_pending_moves()?.into_iter().find(|item| item.operation_id == operation_id))
    }

    /// A rejected move is converted into a local conflict copy by the desktop
    /// adapter. Once those bytes are safe, discard the stale move and force a
    /// fresh tree snapshot so the current cloud paths are restored locally.
    pub fn discard_v2_move_after_conflict(
        &self,
        movement: &crate::v2::V2PendingMove,
    ) -> Result<(), SyncError> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "DELETE FROM v2_pending_moves WHERE operation_id = ?1",
            [&movement.operation_id],
        )?;
        for note_id in [&movement.from_note_id, &movement.to_note_id] {
            transaction.execute(
                "DELETE FROM v2_inflight_operations WHERE entity_type = 'note' AND entity_id = ?1",
                [note_id],
            )?;
            transaction.execute(
                "DELETE FROM v2_dirty_entities WHERE entity_type = 'note' AND entity_id = ?1",
                [note_id],
            )?;
        }
        transaction.execute(
            "UPDATE v2_synced_notebooks SET bootstrap_required = 1, updated_at = ?2 WHERE notebook_id = ?1 AND enabled = 1",
            params![movement.notebook_id, now],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn acknowledge_v2_move(
        &self,
        movement: &crate::v2::V2PendingMove,
        data: &crate::v2::V2OperationData,
    ) -> Result<(), SyncError> {
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        let source = Self::read_v2_note_state(&transaction, &movement.from_note_id)?
            .ok_or_else(|| SyncError::InvalidState("move source lost its local base".into()))?;
        let source_revision = data.source_revision.as_ref()
            .ok_or_else(|| SyncError::InvalidState("move response omitted source revision".into()))?;
        let source_seq = data.source_sync_seq
            .ok_or_else(|| SyncError::InvalidState("move response omitted source sequence".into()))?;
        Self::write_v2_note_state(&transaction, &V2NoteState {
            note_id: movement.from_note_id.clone(), notebook_id: movement.notebook_id.clone(),
            revision: source_revision.clone(), content_hash: None, filename: movement.from_path.clone(),
            deleted: true, last_seq: source_seq, attachments: Vec::new(),
        })?;
        Self::write_v2_note_state(&transaction, &V2NoteState {
            note_id: movement.to_note_id.clone(), notebook_id: movement.notebook_id.clone(),
            revision: data.revision.clone(), content_hash: source.content_hash,
            filename: movement.to_path.clone(), deleted: false, last_seq: data.sync_seq,
            attachments: source.attachments,
        })?;
        transaction.execute("DELETE FROM v2_pending_moves WHERE operation_id = ?1", [&movement.operation_id])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn v2_notebook_state(
        &self,
        notebook_id: &str,
    ) -> Result<Option<V2NotebookState>, SyncError> {
        Self::read_v2_notebook_state(&self.open()?, notebook_id)
    }

    pub fn commit_v2_sync_report(
        &self,
        remote: &[V2RemoteApply],
        cursor: i64,
        bootstrapped_notebooks: &[String],
        applied_at: i64,
    ) -> Result<(), SyncError> {
        self.commit_v2_sync_report_scoped(remote, cursor, bootstrapped_notebooks, applied_at, None)
    }

    pub fn commit_v2_notebook_sync_report(
        &self,
        notebook_id: &str,
        remote: &[V2RemoteApply],
        cursor: i64,
        bootstrapped_notebooks: &[String],
        applied_at: i64,
    ) -> Result<(), SyncError> {
        self.commit_v2_sync_report_scoped(
            remote,
            cursor,
            bootstrapped_notebooks,
            applied_at,
            Some(notebook_id),
        )
    }

    fn commit_v2_sync_report_scoped(
        &self,
        remote: &[V2RemoteApply],
        cursor: i64,
        bootstrapped_notebooks: &[String],
        applied_at: i64,
        notebook_scope: Option<&str>,
    ) -> Result<(), SyncError> {
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        let current_cursor = if let Some(notebook_id) = notebook_scope {
            transaction.execute(
                "INSERT OR IGNORE INTO v2_notebook_sync_state(notebook_id, cursor, updated_at) VALUES (?1, 0, ?2)",
                params![notebook_id, applied_at],
            )?;
            transaction.query_row(
                "SELECT cursor FROM v2_notebook_sync_state WHERE notebook_id = ?1",
                [notebook_id],
                |row| row.get::<_, i64>(0),
            )?
        } else {
            transaction.query_row(
                "SELECT cursor FROM v2_sync_state WHERE singleton = 1",
                [],
                |row| row.get::<_, i64>(0),
            )?
        };
        if cursor < current_cursor {
            return Err(SyncError::InvalidState(
                "refused to move the v2 cursor backwards".into(),
            ));
        }
        for change in remote {
            match change {
                V2RemoteApply::Notebook {
                    notebook_id,
                    name,
                    icon,
                    sort_order,
                    revision,
                    sync_seq,
                    deleted,
                } => {
                    let metadata_hash = crate::v2::v2_notebook_metadata_hash(
                        name.as_deref().unwrap_or_default(),
                        icon.as_deref(),
                        sort_order.unwrap_or_default(),
                    );
                    Self::write_v2_notebook_state(
                        &transaction,
                        &V2NotebookState {
                            notebook_id: notebook_id.clone(),
                            revision: revision.clone(),
                            metadata_hash,
                            deleted: *deleted,
                            last_seq: *sync_seq,
                        },
                    )?;
                    if *deleted {
                        transaction.execute(
                            "UPDATE v2_synced_notebooks SET enabled = 0, bootstrap_required = 1, updated_at = ?2 WHERE notebook_id = ?1",
                            params![notebook_id, applied_at],
                        )?;
                    }
                }
                V2RemoteApply::Note {
                    note_id,
                    notebook_id,
                    filename,
                    content_hash,
                    revision,
                    sync_seq,
                    deleted,
                    attachments,
                    ..
                } => Self::write_v2_note_state(
                    &transaction,
                    &V2NoteState {
                        note_id: note_id.clone(),
                        notebook_id: notebook_id.clone(),
                        revision: revision.clone(),
                        content_hash: content_hash.clone(),
                        filename: filename.clone(),
                        deleted: *deleted,
                        last_seq: *sync_seq,
                        attachments: if *deleted {
                            Vec::new()
                        } else {
                            attachments
                                .iter()
                                .map(|item| item.metadata.clone())
                                .collect()
                        },
                    },
                )?,
            }
        }
        for notebook_id in bootstrapped_notebooks {
            transaction.execute(
                "UPDATE v2_synced_notebooks SET bootstrap_required = 0, updated_at = ?2 WHERE notebook_id = ?1",
                params![notebook_id, applied_at],
            )?;
        }
        if let Some(notebook_id) = notebook_scope {
            transaction.execute(
                "UPDATE v2_notebook_sync_state SET cursor = ?1, last_success_at = ?2, updated_at = ?2 WHERE notebook_id = ?3",
                params![cursor, applied_at, notebook_id],
            )?;
        } else {
            transaction.execute(
                "UPDATE v2_sync_state SET cursor = ?1, last_success_at = ?2, updated_at = ?2 WHERE singleton = 1",
                params![cursor, applied_at],
            )?;
            transaction.execute(
                "UPDATE v2_notebook_sync_state SET cursor = ?1, last_success_at = ?2, updated_at = ?2",
                params![cursor, applied_at],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn commit_v2_cursor(&self, cursor: i64, applied_at: i64) -> Result<(), SyncError> {
        let changed = self.open()?.execute(
            r#"UPDATE v2_sync_state SET cursor = ?1, last_success_at = ?2, updated_at = ?2
                WHERE singleton = 1 AND cursor <= ?1"#,
            params![cursor, applied_at],
        )?;
        if changed != 1 {
            return Err(SyncError::InvalidState(
                "refused to move the v2 cursor backwards".into(),
            ));
        }
        Ok(())
    }

    fn read_v2_notebook(
        connection: &Connection,
        notebook_id: &str,
    ) -> Result<Option<V2SyncedNotebook>, SyncError> {
        connection.query_row(
            "SELECT notebook_id, enabled, bootstrap_required, updated_at FROM v2_synced_notebooks WHERE notebook_id = ?1",
            [notebook_id],
            |row| Ok(V2SyncedNotebook { notebook_id: row.get(0)?, enabled: row.get(1)?,
                bootstrap_required: row.get(2)?, updated_at: row.get(3)? }),
        ).optional().map_err(SyncError::from)
    }

    fn read_v2_inflight(
        connection: &Connection,
        entity_type: V2EntityType,
        entity_id: &str,
        generation: i64,
    ) -> Result<Option<V2InflightOperation>, SyncError> {
        connection
            .query_row(
                r#"SELECT o.operation_id, o.entity_type, o.entity_id, o.generation,
                      o.operation_kind, o.base_revision, o.payload_json,
                      r.attempts, r.next_retry_at
                 FROM v2_inflight_operations o
                 LEFT JOIN v2_retry_state r ON r.operation_id = o.operation_id
                WHERE o.entity_type = ?1 AND o.entity_id = ?2 AND o.generation = ?3"#,
                params![entity_type.as_str(), entity_id, generation],
                Self::map_v2_inflight,
            )
            .optional()
            .map_err(SyncError::from)
    }

    fn map_v2_inflight(row: &rusqlite::Row<'_>) -> rusqlite::Result<V2InflightOperation> {
        let entity_type: String = row.get(1)?;
        let operation_kind: String = row.get(4)?;
        Ok(V2InflightOperation {
            operation_id: row.get(0)?,
            entity_type: V2EntityType::parse(&entity_type)
                .ok_or_else(|| rusqlite::Error::InvalidQuery)?,
            entity_id: row.get(2)?,
            generation: row.get(3)?,
            operation_kind: V2OperationKind::parse(&operation_kind)
                .ok_or_else(|| rusqlite::Error::InvalidQuery)?,
            base_revision: row.get(5)?,
            payload_json: row.get(6)?,
            attempts: row.get::<_, Option<i64>>(7)?.unwrap_or(0),
            next_retry_at: row.get::<_, Option<i64>>(8)?.unwrap_or(0),
        })
    }

    fn write_v2_note_state(connection: &Connection, state: &V2NoteState) -> Result<(), SyncError> {
        let attachments_json = serde_json::to_string(&state.attachments).map_err(|error| {
            SyncError::InvalidState(format!("serialize v2 attachments: {error}"))
        })?;
        connection.execute(
            r#"INSERT INTO v2_note_states
                 (note_id, notebook_id, revision, content_hash, attachments_json, filename, deleted, last_seq, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
               ON CONFLICT(note_id) DO UPDATE SET notebook_id = excluded.notebook_id,
                 revision = excluded.revision, content_hash = excluded.content_hash,
                 attachments_json = excluded.attachments_json, filename = excluded.filename, deleted = excluded.deleted,
                 last_seq = excluded.last_seq, updated_at = excluded.updated_at"#,
            params![state.note_id, state.notebook_id, state.revision, state.content_hash,
                attachments_json,
                state.filename, state.deleted, state.last_seq,
                chrono::Utc::now().timestamp_millis()],
        )?;
        Ok(())
    }

    fn write_v2_note_state_if_newer(
        connection: &Connection,
        state: &V2NoteState,
    ) -> Result<(), SyncError> {
        let current = Self::read_v2_note_state(connection, &state.note_id)?;
        if current.is_none_or(|value| value.last_seq <= state.last_seq) {
            Self::write_v2_note_state(connection, state)?;
        }
        Ok(())
    }

    fn write_v2_notebook_state(
        connection: &Connection,
        state: &V2NotebookState,
    ) -> Result<(), SyncError> {
        connection.execute(
            r#"INSERT INTO v2_notebook_states
                 (notebook_id, revision, metadata_hash, deleted, last_seq, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)
               ON CONFLICT(notebook_id) DO UPDATE SET revision = excluded.revision,
                 metadata_hash = excluded.metadata_hash, deleted = excluded.deleted,
                 last_seq = excluded.last_seq, updated_at = excluded.updated_at"#,
            params![
                state.notebook_id,
                state.revision,
                state.metadata_hash,
                state.deleted,
                state.last_seq,
                chrono::Utc::now().timestamp_millis()
            ],
        )?;
        Ok(())
    }

    fn write_v2_notebook_state_if_newer(
        connection: &Connection,
        state: &V2NotebookState,
    ) -> Result<(), SyncError> {
        let current = Self::read_v2_notebook_state(connection, &state.notebook_id)?;
        if current.is_none_or(|value| value.last_seq <= state.last_seq) {
            Self::write_v2_notebook_state(connection, state)?;
        }
        Ok(())
    }

    fn read_v2_notebook_state(
        connection: &Connection,
        notebook_id: &str,
    ) -> Result<Option<V2NotebookState>, SyncError> {
        connection
            .query_row(
                r#"SELECT notebook_id, revision, metadata_hash, deleted, last_seq
                 FROM v2_notebook_states WHERE notebook_id = ?1"#,
                [notebook_id],
                |row| {
                    Ok(V2NotebookState {
                        notebook_id: row.get(0)?,
                        revision: row.get(1)?,
                        metadata_hash: row.get(2)?,
                        deleted: row.get(3)?,
                        last_seq: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(SyncError::from)
    }

    fn read_v2_note_state(
        connection: &Connection,
        note_id: &str,
    ) -> Result<Option<V2NoteState>, SyncError> {
        connection
            .query_row(
                r#"SELECT note_id, notebook_id, revision, content_hash, attachments_json, filename, deleted, last_seq
                 FROM v2_note_states WHERE note_id = ?1"#,
                [note_id],
                |row| {
                    Ok(V2NoteState {
                        note_id: row.get(0)?,
                        notebook_id: row.get(1)?,
                        revision: row.get(2)?,
                        content_hash: row.get(3)?,
                        attachments: serde_json::from_str(&row.get::<_, String>(4)?)
                            .map_err(|_| rusqlite::Error::InvalidQuery)?,
                        filename: row.get(5)?,
                        deleted: row.get(6)?,
                        last_seq: row.get(7)?,
                    })
                },
            )
            .optional()
            .map_err(SyncError::from)
    }
}
