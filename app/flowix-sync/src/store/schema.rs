use super::*;

impl SyncStore {
    pub fn new(path: impl AsRef<Path>) -> Result<Self, SyncError> {
        let store = Self {
            path: path.as_ref().to_path_buf(),
        };
        store.open()?;
        Ok(store)
    }

    pub(super) fn open(&self) -> Result<Connection, SyncError> {
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
        Self::initialize_v2_schema(&connection)?;
        Ok(connection)
    }
}
