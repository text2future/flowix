use super::*;

impl SyncStore {
    pub fn new(path: impl AsRef<Path>) -> Result<Self, SyncError> {
        let store = Self::new_uninitialized(path);
        store.initialize_schema()?;
        Ok(store)
    }

    pub fn new_uninitialized(path: impl AsRef<Path>) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
            schema_ready: Default::default(),
            schema_lock: Default::default(),
        }
    }

    pub fn initialize_schema(&self) -> Result<(), SyncError> {
        let _guard = self.schema_lock.lock().unwrap_or_else(|p| p.into_inner());
        self.initialize_schema_locked()
    }

    /// Background runtime fallback after best-effort startup migrations.
    pub fn initialize_runtime_schema(&self) -> Result<(), SyncError> {
        let _guard = self.schema_lock.lock().unwrap_or_else(|p| p.into_inner());
        if let Err(error) = self.initialize_schema_locked() {
            if !flowix_core::memo_file::database_file_is_corrupt(&self.path).unwrap_or(false) {
                return Err(error);
            }
            tracing::warn!(%error, "sync migration skipped; recreating runtime database");
            self.schema_ready
                .store(false, std::sync::atomic::Ordering::Release);
            flowix_core::memo_file::discard_database_for_runtime(&self.path);
            self.initialize_schema_locked()?;
        }
        Ok(())
    }

    fn initialize_schema_locked(&self) -> Result<(), SyncError> {
        flowix_core::memo_file::with_corrupt_database_rebuild(&self.path, || {
            let connection = self.open_raw().map_err(std::io::Error::other)?;
            Self::initialize_account_schema(&connection).map_err(std::io::Error::other)?;
            Self::initialize_path_notebook_schema(&connection).map_err(std::io::Error::other)?;
            Self::initialize_v4_schema(&connection).map_err(std::io::Error::other)?;
            Self::initialize_remote_schema(&connection).map_err(std::io::Error::other)?;
            connection
                .query_row(
                    "SELECT blocked FROM session_restore_policy WHERE singleton=1",
                    [],
                    |row| row.get::<_, bool>(0),
                )
                .optional()
                .map_err(std::io::Error::other)?;
            Ok(())
        })
        .map_err(|error| SyncError::InvalidState(format!("initialize sync database: {error}")))?;
        self.schema_ready
            .store(true, std::sync::atomic::Ordering::Release);
        Ok(())
    }

    pub(super) fn open(&self) -> Result<Connection, SyncError> {
        // Early Cloud UI/API requests initialize on demand; the local shell
        // never waits for this database or the operating-system credential store.
        if !self.schema_ready.load(std::sync::atomic::Ordering::Acquire) {
            let _guard = self.schema_lock.lock().unwrap_or_else(|p| p.into_inner());
            if !self.schema_ready.load(std::sync::atomic::Ordering::Acquire) {
                self.initialize_schema_locked()?;
            }
        }
        self.open_raw()
    }

    fn open_raw(&self) -> Result<Connection, SyncError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                SyncError::InvalidState(format!("create sync directory: {error}"))
            })?;
        }
        let connection = Connection::open(&self.path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            "#,
        )?;
        Ok(connection)
    }
}

#[cfg(test)]
mod storage_rebuild_tests {
    use super::*;

    #[test]
    fn deferred_store_initializes_on_first_use_and_coalesces_concurrent_readers() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("cloud/sync.db");
        let store = SyncStore::new_uninitialized(&path);
        assert!(!path.exists());
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let store = store.clone();
                std::thread::spawn(move || store.session_restore_blocked().unwrap())
            })
            .collect();
        for handle in handles {
            assert!(!handle.join().unwrap());
        }
        assert!(path.is_file());
        assert!(!path.parent().unwrap().join("rebuild-backups").exists());
    }

    #[test]
    fn runtime_sync_write_lock_preserves_existing_rows() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("sync.db");
        let store = SyncStore::new(&path).unwrap();
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('keep'); BEGIN IMMEDIATE;").unwrap();
        assert!(store.initialize_runtime_schema().is_err());
        connection.execute_batch("ROLLBACK;").unwrap();
        assert_eq!(
            connection
                .query_row("SELECT value FROM retained", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "keep"
        );
        assert!(!temp.path().join("rebuild-backups").exists());
    }

    #[test]
    fn runtime_sync_storage_recreates_even_when_backup_fails() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("sync.db");
        std::fs::write(&path, b"broken sync database").unwrap();
        std::fs::write(temp.path().join("rebuild-backups"), b"blocked").unwrap();
        let store = SyncStore::new_uninitialized(&path);
        store.initialize_runtime_schema().unwrap();
        assert!(!store.session_restore_blocked().unwrap());
    }

    #[test]
    fn invalid_sync_database_is_backed_up_and_recreated() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("sync.db");
        std::fs::write(&path, b"invalid sync database").unwrap();
        let store = SyncStore::new(&path).unwrap();
        assert!(!store.session_restore_blocked().unwrap());
        assert!(temp.path().join("rebuild-backups").exists());
    }
}
