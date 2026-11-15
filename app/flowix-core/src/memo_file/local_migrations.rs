//! Shared device-local migration journal. Both historical journal layouts are accepted.
use rusqlite::Connection;
use std::io;

pub fn initialize_local_migration_table(conn: &mut Connection) -> io::Result<()> {
    let columns = {
        let mut statement = conn
            .prepare("PRAGMA table_info(local_migrations)")
            .map_err(io::Error::other)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(io::Error::other)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(io::Error::other)?
    };
    if columns.is_empty() {
        conn.execute_batch("CREATE TABLE local_migrations (migration_key TEXT PRIMARY KEY, completed_at INTEGER NOT NULL DEFAULT 0);").map_err(io::Error::other)?;
    } else if columns.iter().any(|name| name == "key")
        && !columns.iter().any(|name| name == "migration_key")
    {
        let tx = conn.transaction().map_err(io::Error::other)?;
        tx.execute_batch("ALTER TABLE local_migrations RENAME TO local_migrations_old;
            CREATE TABLE local_migrations (migration_key TEXT PRIMARY KEY, completed_at INTEGER NOT NULL DEFAULT 0);
            INSERT INTO local_migrations (migration_key, completed_at) SELECT key, 0 FROM local_migrations_old;
            DROP TABLE local_migrations_old;").map_err(io::Error::other)?;
        tx.commit().map_err(io::Error::other)?;
    } else if !columns.iter().any(|name| name == "migration_key")
        || !columns.iter().any(|name| name == "completed_at")
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported local_migrations schema",
        ));
    }
    Ok(())
}

/// Notebook jobs shared by execution and startup pending detection.
#[derive(Clone, Copy)]
pub enum NotebookInitializationJob {
    ResetLegacyStorage,
    InitializeSchema,
    MigrateMediaResourceIdentity,
    MigrateResourceCatalog,
    IndexWorkDocuments,
    /// 旧版「文件夹集合」的 `.index.yaml` → `folder_index` 表。
    MigrateFolderIndex,
}

impl NotebookInitializationJob {
    pub const ALL: [Self; 6] = [
        Self::ResetLegacyStorage,
        Self::InitializeSchema,
        Self::MigrateMediaResourceIdentity,
        Self::MigrateResourceCatalog,
        Self::IndexWorkDocuments,
        Self::MigrateFolderIndex,
    ];

    pub fn key(self, notebook_id: &str) -> String {
        let prefix = match self {
            Self::ResetLegacyStorage => "storage_reset_v1",
            Self::InitializeSchema => "storage_schema_v1",
            Self::MigrateMediaResourceIdentity => "media_resource_identity_v1",
            Self::MigrateResourceCatalog => "resource_catalog_v1",
            Self::IndexWorkDocuments => "work_documents_resource_index_v1",
            Self::MigrateFolderIndex => "folder_index_legacy_v1",
        };
        format!("{prefix}:notebook:{notebook_id}")
    }
}
