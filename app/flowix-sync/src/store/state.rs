use super::*;
use crate::reconcile::DirScanRecord;
use crate::state::{DirectoryState, LocalSnapshot, NotebookState, PathState};
use std::collections::BTreeMap;

// The table names keep their `v4_` prefix: they are on disk in every existing
// installation, and renaming them would need a migration for no user benefit.
// Everything else in this crate now speaks in path-sync terms.
impl SyncStore {
    pub(super) fn initialize_state_schema(connection: &Connection) -> Result<(), SyncError> {
        connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS v4_path_state (
                notebook_id TEXT NOT NULL,
                path TEXT NOT NULL,
                display_path TEXT NOT NULL,
                content_hash TEXT,
                local_size INTEGER NOT NULL CHECK(local_size >= 0),
                local_mtime_millis INTEGER NOT NULL,
                last_synced_at INTEGER NOT NULL,
                pending_since INTEGER,
                remote_etag TEXT,
                PRIMARY KEY(notebook_id, path)
            );
            CREATE INDEX IF NOT EXISTS idx_v4_path_state_pending
                ON v4_path_state(notebook_id) WHERE pending_since IS NOT NULL;
            CREATE TABLE IF NOT EXISTS v4_dir_scan (
                notebook_id TEXT NOT NULL,
                dir TEXT NOT NULL,
                stamp_millis INTEGER NOT NULL,
                scanned_at_millis INTEGER NOT NULL,
                PRIMARY KEY(notebook_id, dir)
            );
            CREATE TABLE IF NOT EXISTS v4_pending_stamp (
                notebook_id TEXT NOT NULL,
                dir TEXT NOT NULL,
                PRIMARY KEY(notebook_id, dir)
            );
            CREATE TABLE IF NOT EXISTS v4_pending_proxy_delete (
                notebook_id TEXT NOT NULL,
                path TEXT NOT NULL,
                PRIMARY KEY(notebook_id, path)
            );
            CREATE TABLE IF NOT EXISTS v4_notebook_state (
                notebook_id TEXT PRIMARY KEY,
                grace_until INTEGER,
                credential_fingerprint TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS v4_directory_state (
                notebook_id TEXT NOT NULL,
                path TEXT NOT NULL,
                last_synced_at INTEGER NOT NULL,
                deleted INTEGER NOT NULL DEFAULT 0,
                local_mtime_millis INTEGER NOT NULL DEFAULT 0,
                pending_since INTEGER,
                PRIMARY KEY(notebook_id, path)
            );
            "#,
        )?;
        let has_remote_etag = {
            let mut statement = connection.prepare("PRAGMA table_info(v4_path_state)")?;
            let mut rows = statement.query([])?;
            let mut found = false;
            while let Some(row) = rows.next()? {
                if row.get::<_, String>(1)? == "remote_etag" {
                    found = true;
                    break;
                }
            }
            found
        };
        if !has_remote_etag {
            connection.execute("ALTER TABLE v4_path_state ADD COLUMN remote_etag TEXT", [])?;
        }
        // Older builds parked proxy deletions in the stamp queue, tagged with a
        // NUL-prefixed synthetic path. The stamp table now only holds
        // directories, so anything left over moves to its own table first:
        // otherwise the next pass would publish a directory stamp for a path
        // that is not a directory.
        //
        // Matched in Rust rather than SQL: SQLite's string functions stop at
        // NUL, so LIKE and substr cannot see this prefix at all.
        let legacy: Vec<(String, String)> = {
            let mut statement =
                connection.prepare("SELECT notebook_id, dir FROM v4_pending_stamp")?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for (notebook_id, dir) in legacy {
            let Some(path) = dir.strip_prefix("\0proxy/") else {
                continue;
            };
            connection.execute(
                "INSERT OR IGNORE INTO v4_pending_proxy_delete(notebook_id, path) VALUES (?1, ?2)",
                params![notebook_id, path],
            )?;
            connection.execute(
                "DELETE FROM v4_pending_stamp WHERE notebook_id = ?1 AND dir = ?2",
                params![notebook_id, dir],
            )?;
        }
        Ok(())
    }

    pub fn queue_stamps(&self, notebook_id: &str, dirs: &[String]) -> Result<(), SyncError> {
        if dirs.is_empty() {
            return Ok(());
        }
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        for dir in dirs {
            transaction.execute(
                "INSERT OR IGNORE INTO v4_pending_stamp(notebook_id, dir) VALUES (?1, ?2)",
                params![notebook_id, dir],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn pending_stamps(&self, notebook_id: &str) -> Result<Vec<String>, SyncError> {
        let connection = self.open()?;
        let mut statement = connection
            .prepare("SELECT dir FROM v4_pending_stamp WHERE notebook_id = ?1 ORDER BY dir")?;
        let rows = statement.query_map(params![notebook_id], |row| row.get(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn ack_stamp(&self, notebook_id: &str, dir: &str) -> Result<(), SyncError> {
        self.open()?.execute(
            "DELETE FROM v4_pending_stamp WHERE notebook_id = ?1 AND dir = ?2",
            params![notebook_id, dir],
        )?;
        Ok(())
    }

    /// Remembers deletions the official backend wants announced through its
    /// deletion proxy rather than as tombstone objects.
    ///
    /// They used to ride in the stamp queue behind a NUL-prefixed synthetic
    /// path, which meant every reader of that queue had to know the trick and a
    /// forgotten check would publish a directory stamp for a file path.
    pub fn queue_proxy_deletions(
        &self,
        notebook_id: &str,
        paths: &[String],
    ) -> Result<(), SyncError> {
        if paths.is_empty() {
            return Ok(());
        }
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        for path in paths {
            transaction.execute(
                "INSERT OR IGNORE INTO v4_pending_proxy_delete(notebook_id, path) VALUES (?1, ?2)",
                params![notebook_id, path],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn pending_proxy_deletions(&self, notebook_id: &str) -> Result<Vec<String>, SyncError> {
        let connection = self.open()?;
        let mut statement = connection.prepare(
            "SELECT path FROM v4_pending_proxy_delete WHERE notebook_id = ?1 ORDER BY path",
        )?;
        let rows = statement.query_map(params![notebook_id], |row| row.get(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn ack_proxy_deletion(&self, notebook_id: &str, path: &str) -> Result<(), SyncError> {
        self.open()?.execute(
            "DELETE FROM v4_pending_proxy_delete WHERE notebook_id = ?1 AND path = ?2",
            params![notebook_id, path],
        )?;
        Ok(())
    }

    pub fn directory_states(&self, notebook_id: &str) -> Result<Vec<DirectoryState>, SyncError> {
        let connection = self.open()?;
        let mut statement = connection.prepare(
            "SELECT path, last_synced_at, deleted, local_mtime_millis, pending_since
             FROM v4_directory_state WHERE notebook_id = ?1",
        )?;
        let rows = statement.query_map(params![notebook_id], |row| {
            Ok(DirectoryState {
                path: row.get(0)?,
                last_synced_at: row.get(1)?,
                deleted: row.get(2)?,
                local_mtime_millis: row.get(3)?,
                pending_since: row.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn save_directory_states(
        &self,
        notebook_id: &str,
        states: &[DirectoryState],
    ) -> Result<(), SyncError> {
        if states.is_empty() {
            return Ok(());
        }
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        {
            let mut statement = transaction.prepare(
                "INSERT INTO v4_directory_state
                    (notebook_id, path, last_synced_at, deleted, local_mtime_millis, pending_since)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(notebook_id, path) DO UPDATE SET
                    last_synced_at = excluded.last_synced_at,
                    deleted = excluded.deleted,
                    local_mtime_millis = excluded.local_mtime_millis,
                    pending_since = excluded.pending_since",
            )?;
            for state in states {
                statement.execute(params![
                    notebook_id,
                    state.path,
                    state.last_synced_at,
                    state.deleted,
                    state.local_mtime_millis,
                    state.pending_since,
                ])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn snapshot(&self, notebook_id: &str) -> Result<LocalSnapshot, SyncError> {
        let connection = self.open()?;
        let mut statement = connection.prepare(
            "SELECT path, display_path, content_hash, local_size, local_mtime_millis,
                    last_synced_at, pending_since, remote_etag
             FROM v4_path_state WHERE notebook_id = ?1",
        )?;
        let states = statement
            .query_map(params![notebook_id], |row| {
                Ok(PathState {
                    path: row.get(0)?,
                    display_path: row.get(1)?,
                    content_hash: row.get(2)?,
                    local_size: row.get::<_, i64>(3)? as u64,
                    local_mtime_millis: row.get(4)?,
                    last_synced_at: row.get(5)?,
                    pending_since: row.get(6)?,
                    remote_etag: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut statement = connection.prepare(
            "SELECT dir, stamp_millis, scanned_at_millis FROM v4_dir_scan WHERE notebook_id = ?1",
        )?;
        let dir_scans = statement
            .query_map(params![notebook_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    DirScanRecord {
                        stamp_millis: row.get(1)?,
                        scanned_at_millis: row.get(2)?,
                    },
                ))
            })?
            .collect::<Result<BTreeMap<_, _>, _>>()?;

        Ok(LocalSnapshot {
            states: states
                .into_iter()
                .map(|state| (state.path.clone(), state))
                .collect(),
            dir_scans,
        })
    }

    pub fn notebook_state(&self, notebook_id: &str) -> Result<Option<NotebookState>, SyncError> {
        let connection = self.open()?;
        connection
            .query_row(
                "SELECT grace_until, credential_fingerprint
                 FROM v4_notebook_state WHERE notebook_id = ?1",
                params![notebook_id],
                |row| {
                    Ok(NotebookState {
                        notebook_id: notebook_id.to_string(),
                        grace_until: row.get(0)?,
                        credential_fingerprint: row.get(1)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn save_path_states(
        &self,
        notebook_id: &str,
        states: &[PathState],
    ) -> Result<(), SyncError> {
        if states.is_empty() {
            return Ok(());
        }
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        {
            let mut statement = transaction.prepare(
                "INSERT INTO v4_path_state
                    (notebook_id, path, display_path, content_hash, local_size,
                     local_mtime_millis, last_synced_at, pending_since, remote_etag)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(notebook_id, path) DO UPDATE SET
                    display_path = excluded.display_path,
                    content_hash = excluded.content_hash,
                    local_size = excluded.local_size,
                    local_mtime_millis = excluded.local_mtime_millis,
                    last_synced_at = excluded.last_synced_at,
                    pending_since = excluded.pending_since,
                    remote_etag = excluded.remote_etag",
            )?;
            for state in states {
                statement.execute(params![
                    notebook_id,
                    state.path,
                    state.display_path,
                    state.content_hash,
                    state.local_size as i64,
                    state.local_mtime_millis,
                    state.last_synced_at,
                    state.pending_since,
                    state.remote_etag,
                ])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn remove_path_states(&self, notebook_id: &str, paths: &[String]) -> Result<(), SyncError> {
        if paths.is_empty() {
            return Ok(());
        }
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        {
            let mut statement = transaction
                .prepare("DELETE FROM v4_path_state WHERE notebook_id = ?1 AND path = ?2")?;
            for path in paths {
                statement.execute(params![notebook_id, path])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    /// Replaces the notebook's deletion-retry set with `pending`.
    ///
    /// Written as "clear then set" rather than a diff because the set is small
    /// and a diff would need to read the old rows first, widening the window
    /// where the table disagrees with the plan that produced it.
    pub fn set_pending_deletions(
        &self,
        notebook_id: &str,
        pending: &BTreeMap<String, i64>,
    ) -> Result<(), SyncError> {
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "UPDATE v4_path_state SET pending_since = NULL
             WHERE notebook_id = ?1 AND pending_since IS NOT NULL",
            params![notebook_id],
        )?;
        {
            let mut statement = transaction.prepare(
                "UPDATE v4_path_state SET pending_since = ?3
                 WHERE notebook_id = ?1 AND path = ?2",
            )?;
            for (path, since) in pending {
                statement.execute(params![notebook_id, path, since])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn save_dir_scans(
        &self,
        notebook_id: &str,
        scans: &BTreeMap<String, DirScanRecord>,
    ) -> Result<(), SyncError> {
        if scans.is_empty() {
            return Ok(());
        }
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        {
            let mut statement = transaction.prepare(
                "INSERT INTO v4_dir_scan (notebook_id, dir, stamp_millis, scanned_at_millis)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(notebook_id, dir) DO UPDATE SET
                    stamp_millis = excluded.stamp_millis,
                    scanned_at_millis = excluded.scanned_at_millis",
            )?;
            for (dir, record) in scans {
                statement.execute(params![
                    notebook_id,
                    dir,
                    record.stamp_millis,
                    record.scanned_at_millis
                ])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn save_notebook_state(&self, state: &NotebookState) -> Result<(), SyncError> {
        self.open()?.execute(
            "INSERT INTO v4_notebook_state
                (notebook_id, grace_until, credential_fingerprint)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(notebook_id) DO UPDATE SET
                grace_until = excluded.grace_until,
                credential_fingerprint = excluded.credential_fingerprint",
            params![
                state.notebook_id,
                state.grace_until,
                state.credential_fingerprint
            ],
        )?;
        Ok(())
    }

    /// Rebinds a notebook to a (possibly different) bucket.
    ///
    /// Returns `true` when the fingerprint actually changed. Three things must
    /// happen together, which is why this is one method and not three:
    ///
    /// * deletion retry markers are cleared so they do not trigger scans
    ///   against the new bucket;
    /// * every baseline is moved to `reset_baseline_to`, so a new bucket's
    ///   timestamps are compared with its clock rather than the old bucket's;
    /// * a grace window opens, because the new bucket is empty at first.
    ///
    /// Content hashes are deliberately kept for subsequent content comparisons.
    pub fn rebind_credential(
        &self,
        notebook_id: &str,
        fingerprint: &str,
        reset_baseline_to: i64,
        grace_until: i64,
    ) -> Result<bool, SyncError> {
        let mut connection = self.open()?;
        let previous: Option<String> = connection
            .query_row(
                "SELECT credential_fingerprint FROM v4_notebook_state WHERE notebook_id = ?1",
                params![notebook_id],
                |row| row.get(0),
            )
            .optional()?;
        let changed = previous.as_deref().is_none_or(|value| value != fingerprint);

        let transaction = connection.transaction()?;
        if changed {
            transaction.execute(
                "UPDATE v4_path_state
                 SET pending_since = NULL, last_synced_at = ?2
                 WHERE notebook_id = ?1",
                params![notebook_id, reset_baseline_to],
            )?;
            transaction.execute(
                "DELETE FROM v4_directory_state WHERE notebook_id = ?1",
                params![notebook_id],
            )?;
            transaction.execute(
                "DELETE FROM v4_pending_stamp WHERE notebook_id = ?1",
                params![notebook_id],
            )?;
        }
        transaction.execute(
            "INSERT INTO v4_notebook_state
                (notebook_id, grace_until, credential_fingerprint)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(notebook_id) DO UPDATE SET
                grace_until = excluded.grace_until,
                credential_fingerprint = excluded.credential_fingerprint",
            params![notebook_id, grace_until, fingerprint],
        )?;
        transaction.commit()?;
        Ok(changed)
    }

    /// Drops every state row for a notebook (unbind, or "start over").
    ///
    /// Content is never touched here: rows describe what the *cloud* had, so
    /// deleting them only makes the next pass re-upload rather than re-download.
    pub fn clear_notebook(&self, notebook_id: &str) -> Result<(), SyncError> {
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        for table in [
            "v4_path_state",
            "v4_dir_scan",
            "v4_notebook_state",
            "v4_directory_state",
            "v4_pending_stamp",
        ] {
            transaction.execute(
                &format!("DELETE FROM {table} WHERE notebook_id = ?1"),
                params![notebook_id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }
}
