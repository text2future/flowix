use super::*;

impl SyncStore {
    pub(super) fn initialize_remote_schema(connection: &Connection) -> Result<(), SyncError> {
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS sync_remote_binding (
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                fingerprint TEXT NOT NULL
            );",
        )?;
        Ok(())
    }

    /// A sync database may be attached to one non-official target. Existing
    /// state of unknown origin is never silently assigned to another Remote.
    pub(crate) fn bind_remote_target(&self, fingerprint: &str) -> Result<(), SyncError> {
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        let existing: Option<String> = transaction
            .query_row(
                "SELECT fingerprint FROM sync_remote_binding WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        match existing {
            Some(value) if value == fingerprint => {}
            Some(_) => {
                return Err(SyncError::InvalidState(
                    "sync state belongs to a different storage target".into(),
                ));
            }
            None => {
                let occupied: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM path_notebooks) OR EXISTS(SELECT 1 FROM v4_notebook_state) OR EXISTS(SELECT 1 FROM v4_path_state) OR EXISTS(SELECT 1 FROM v4_directory_state) OR EXISTS(SELECT 1 FROM v4_pending_stamp)",
                    [], |row| row.get(0),
                )?;
                if occupied {
                    return Err(SyncError::InvalidState(
                        "existing sync state requires an explicit storage migration".into(),
                    ));
                }
                transaction.execute(
                    "INSERT INTO sync_remote_binding(singleton, fingerprint) VALUES(1, ?1)",
                    params![fingerprint],
                )?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn validate_remote_target(&self, fingerprint: &str) -> Result<(), SyncError> {
        let connection = self.open()?;
        let existing: Option<String> = connection
            .query_row(
                "SELECT fingerprint FROM sync_remote_binding WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        match existing {
            Some(value) if value == fingerprint => Ok(()),
            Some(_) => Err(SyncError::InvalidState(
                "sync state belongs to a different storage target".into(),
            )),
            None => {
                let occupied: bool = connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM path_notebooks) OR EXISTS(SELECT 1 FROM v4_notebook_state) OR EXISTS(SELECT 1 FROM v4_path_state) OR EXISTS(SELECT 1 FROM v4_directory_state) OR EXISTS(SELECT 1 FROM v4_pending_stamp)",
                    [], |row| row.get(0),
                )?;
                if occupied {
                    Err(SyncError::InvalidState(
                        "existing sync state requires an explicit storage migration".into(),
                    ))
                } else {
                    Ok(())
                }
            }
        }
    }

    /// Refuses to reuse non-official target state for an official session.
    pub(crate) fn require_official_remote(&self) -> Result<(), SyncError> {
        let connection = self.open()?;
        let bound: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_remote_binding WHERE singleton = 1)",
            [],
            |row| row.get(0),
        )?;
        if bound {
            return Err(SyncError::InvalidState(
                "sync state belongs to a non-official storage target".into(),
            ));
        }
        Ok(())
    }
}

