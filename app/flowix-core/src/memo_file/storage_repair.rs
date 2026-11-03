//! Small startup helpers for recreatable application storage.
use std::{
    error::Error,
    fs, io,
    path::{Path, PathBuf},
};

/// Preserve a database and all its SQLite companions in one backup directory.
/// No replacement is attempted unless every existing component was preserved.
pub fn backup_database(path: &Path) -> io::Result<Option<PathBuf>> {
    backup_files(path, &["", "-wal", "-shm", "-journal"])
}

pub fn backup_storage_file(path: &Path) -> io::Result<Option<PathBuf>> {
    backup_files(path, &[""])
}

fn backup_files(path: &Path, suffixes: &[&str]) -> io::Result<Option<PathBuf>> {
    let mut sources = Vec::new();
    for suffix in suffixes {
        let mut name = path.as_os_str().to_os_string();
        name.push(suffix);
        let source = PathBuf::from(name);
        match fs::symlink_metadata(&source) {
            Ok(_) => sources.push(source),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    if sources.is_empty() {
        return Ok(None);
    }
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("storage path has no parent"))?;
    let backup = parent
        .join("rebuild-backups")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&backup)?;
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for source in sources {
        let target = backup.join(source.file_name().unwrap());
        if let Err(error) = fs::rename(&source, &target) {
            for (source, target) in moved.iter().rev() {
                if let Err(rollback) = fs::rename(target, source) {
                    return Err(io::Error::other(format!(
                        "backup failed: {error}; rollback failed: {rollback}; preserved files: {}",
                        backup.display()
                    )));
                }
            }
            return Err(error);
        }
        moved.push((source, target));
    }
    tracing::warn!(path = %path.display(), backup = %backup.display(), "preserved abnormal application storage before rebuilding");
    Ok(Some(backup))
}

/// Startup runtime fallback: preserve obsolete storage when possible, otherwise
/// discard it. Migration failures must not prevent creation of the new store.
/// Call only before runtime services start using this database.
pub fn discard_database_for_runtime(path: &Path) {
    let mut lock_name = path.as_os_str().to_os_string();
    lock_name.push(".rebuild.lock");
    let lock = match fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(PathBuf::from(lock_name))
    {
        Ok(lock) => lock,
        Err(error) => {
            tracing::warn!(%error, path = %path.display(), "runtime cleanup lock unavailable; skipping cleanup");
            return;
        }
    };
    if let Err(error) = fs2::FileExt::try_lock_exclusive(&lock) {
        tracing::warn!(%error, path = %path.display(), "runtime storage is in use; skipping cleanup");
        return;
    }
    if let Err(error) = backup_database(path) {
        tracing::warn!(%error, path = %path.display(), "runtime backup failed; discarding old storage");
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let mut name = path.as_os_str().to_os_string();
            name.push(suffix);
            let candidate = PathBuf::from(name);
            let result = match fs::symlink_metadata(&candidate) {
                Ok(metadata) if metadata.file_type().is_dir() => fs::remove_dir_all(&candidate),
                Ok(_) => fs::remove_file(&candidate),
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => Err(error),
            };
            if let Err(error) = result {
                tracing::warn!(%error, path = %candidate.display(), "runtime cleanup skipped");
            }
        }
    }
}

/// Busy, permission, disk-full and I/O errors must never move a live database.
pub fn is_rebuildable_storage_error(error: &(dyn Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(error) = current {
        if let Some(sqlite) = error.downcast_ref::<rusqlite::Error>() {
            return match sqlite {
                rusqlite::Error::SqlInputError { msg, .. } => [
                    "no such table",
                    "no such column",
                    "has no column",
                    "malformed",
                ]
                .iter()
                .any(|part| msg.contains(part)),
                rusqlite::Error::SqliteFailure(code, Some(message))
                    if code.code == rusqlite::ErrorCode::Unknown =>
                {
                    [
                        "no such table",
                        "no such column",
                        "has no column",
                        "malformed",
                    ]
                    .iter()
                    .any(|part| message.contains(part))
                }
                rusqlite::Error::SqliteFailure(code, _) => matches!(
                    code.code,
                    rusqlite::ErrorCode::DatabaseCorrupt
                        | rusqlite::ErrorCode::NotADatabase
                        | rusqlite::ErrorCode::SchemaChanged
                ),
                rusqlite::Error::InvalidColumnName(_)
                | rusqlite::Error::InvalidColumnType(..)
                | rusqlite::Error::FromSqlConversionFailure(..) => true,
                _ => false,
            };
        }
        if let Some(io) = error.downcast_ref::<io::Error>() {
            if io.kind() == io::ErrorKind::InvalidData {
                return true;
            }
            if let Some(inner) = io.get_ref() {
                current = Some(inner);
                continue;
            }
        }
        current = error.source();
    }
    false
}

/// A schema error or a temporary access failure does not prove file damage.
/// Only a failed SQLite integrity check permits replacing a shared database.
pub fn database_file_is_corrupt(path: &Path) -> io::Result<bool> {
    if !path.try_exists()? {
        return Ok(false);
    }
    let check = (|| -> rusqlite::Result<bool> {
        let connection = rusqlite::Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        connection.busy_timeout(std::time::Duration::from_millis(100))?;
        connection.query_row("PRAGMA quick_check", [], |row| {
            let report = row.get::<_, String>(0)?;
            // A CHECK/NOT NULL violation belongs to its table; it does not
            // establish damage to the shared database file or other modules.
            Ok(report.starts_with("*** in database")
                || report == "database disk image is malformed")
        })
    })();
    match check {
        Ok(corrupt) => Ok(corrupt),
        Err(rusqlite::Error::SqliteFailure(code, _))
            if matches!(
                code.code,
                rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase
            ) =>
        {
            Ok(true)
        }
        Err(error) => Err(io::Error::other(error)),
    }
}

/// For stores containing authoritative data: schema and access failures leave
/// the original file in place. Callers may fall back to temporary storage.
pub fn with_corrupt_database_rebuild<T>(
    path: &Path,
    initialize: impl FnMut() -> io::Result<T>,
) -> io::Result<T> {
    with_database_repair(path, initialize, |_| {
        database_file_is_corrupt(path).unwrap_or(false)
    })
}

/// The operation must release its connections before returning an error.
pub fn with_database_rebuild<T>(
    path: &Path,
    initialize: impl FnMut() -> io::Result<T>,
) -> io::Result<T> {
    with_database_repair(path, initialize, |error| {
        is_rebuildable_storage_error(error)
    })
}

fn with_database_repair<T>(
    path: &Path,
    mut initialize: impl FnMut() -> io::Result<T>,
    may_rebuild: impl Fn(&io::Error) -> bool,
) -> io::Result<T> {
    // Serialize initialization and repair across processes. Ordinary database
    // access must not call this helper or rename storage held by other readers.
    if let Some(parent) = path.parent() {
        ensure_storage_directory(parent)?;
    }
    let mut lock_path = path.as_os_str().to_os_string();
    lock_path.push(".rebuild.lock");
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(PathBuf::from(lock_path))?;
    fs2::FileExt::try_lock_exclusive(&lock)?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            backup_database(path)?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            backup_database(path)?;
        }
        _ => {}
    }
    match initialize() {
        Ok(value) => Ok(value),
        Err(error) if may_rebuild(&error) => {
            tracing::warn!(%error, path = %path.display(), "recreating abnormal application database");
            backup_database(path)?;
            initialize()
        }
        Err(error) => Err(error),
    }
}

pub fn ensure_storage_directory(path: &Path) -> io::Result<()> {
    if fs::symlink_metadata(path).is_ok() && !path.is_dir() {
        backup_storage_file(path)?;
    }
    fs::create_dir_all(path)
}

/// JSON owned by the application: preserve malformed input, then persist defaults.
pub fn read_or_create_json<T>(path: &Path, default: impl FnOnce() -> T) -> io::Result<T>
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    if let Some(parent) = path.parent() {
        ensure_storage_directory(parent)?;
    }
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(value) => return Ok(value),
            Err(_) => {
                backup_storage_file(path)?;
            }
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) if error.kind() == io::ErrorKind::IsADirectory => {
            backup_storage_file(path)?;
        }
        Err(error) => return Err(error),
    }
    let value = default();
    let bytes = serde_json::to_vec_pretty(&value).map_err(io::Error::other)?;
    super::atomic_write_bytes(path, &bytes)?;
    Ok(value)
}

#[cfg(test)]
mod storage_rebuild_tests {
    use super::*;
    use crate::memo_file::{prepare_database_directory, MemoFile, NotebookConfig};

    #[test]
    fn preserves_complete_sqlite_group() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("local.db");
        for suffix in ["", "-wal", "-shm", "-journal"] {
            fs::write(
                temp.path().join(format!("local.db{suffix}")),
                suffix.as_bytes(),
            )
            .unwrap();
        }
        let backup = backup_database(&path).unwrap().unwrap();
        for suffix in ["", "-wal", "-shm", "-journal"] {
            assert_eq!(
                fs::read(backup.join(format!("local.db{suffix}"))).unwrap(),
                suffix.as_bytes()
            );
            assert!(!temp.path().join(format!("local.db{suffix}")).exists());
        }
    }

    #[test]
    fn canonical_database_does_not_receive_legacy_wal() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("db")).unwrap();
        fs::write(temp.path().join("local.db"), b"legacy").unwrap();
        fs::write(temp.path().join("local.db-wal"), b"legacy wal").unwrap();
        fs::write(temp.path().join("db/local.db"), b"canonical").unwrap();
        prepare_database_directory(temp.path(), &["local.db"]).unwrap();
        assert_eq!(
            fs::read(temp.path().join("db/local.db")).unwrap(),
            b"canonical"
        );
        assert!(!temp.path().join("db/local.db-wal").exists());
        assert_eq!(
            fs::read(temp.path().join("local.db-wal")).unwrap(),
            b"legacy wal"
        );
    }

    #[test]
    fn invalid_registry_is_never_replaced_with_an_empty_database() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("db")).unwrap();
        let path = temp.path().join("db/local.db");
        fs::write(&path, b"broken registry").unwrap();
        fs::write(temp.path().join("local.db"), b"legacy input").unwrap();
        let memo = MemoFile::new(temp.path().to_path_buf());
        for _ in 0..2 {
            assert!(memo.initialize_registry_storage().is_err());
            assert_eq!(fs::read(&path).unwrap(), b"broken registry");
            assert_eq!(
                fs::read(temp.path().join("local.db")).unwrap(),
                b"legacy input"
            );
            assert!(!temp.path().join("db/rebuild-backups").exists());
        }
    }

    #[test]
    fn malformed_registry_schema_rolls_back_without_losing_rows() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("db")).unwrap();
        let path = temp.path().join("db/local.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE notebooks(id TEXT); INSERT INTO notebooks VALUES ('keep');",
        )
        .unwrap();
        drop(conn);
        let memo = MemoFile::new(temp.path().to_path_buf());
        assert!(memo.initialize_registry_storage().is_err());
        let conn = rusqlite::Connection::open(&path).unwrap();
        assert_eq!(
            conn.query_row("SELECT id FROM notebooks", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "keep"
        );
        let columns: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('notebooks')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(columns, 1, "partially added columns must roll back");
        assert!(!path.parent().unwrap().join("rebuild-backups").exists());
    }

    #[test]
    fn missing_previously_initialized_registry_is_not_recreated() {
        let temp = tempfile::tempdir().unwrap();
        let memo = MemoFile::new(temp.path().to_path_buf());
        memo.initialize_registry_storage().unwrap();
        fs::remove_dir_all(temp.path().join("db")).unwrap();
        assert!(memo.initialize_current_registry_storage().is_err());
        assert!(!memo.registry_db_path().exists());
    }

    #[test]
    fn legacy_registry_snapshot_preserves_wal_and_target_wins_on_retry() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("local.db");
        let conn = rusqlite::Connection::open(&legacy).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
            CREATE TABLE notebooks (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, path TEXT UNIQUE NOT NULL,
            is_default INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
            INSERT INTO notebooks VALUES ('keep', 'Original', 'icon', '/offline/notes', 1, 123, 456);").unwrap();
        let memo = MemoFile::new(temp.path().to_path_buf());
        memo.initialize_registry_storage().unwrap();
        assert!(legacy.exists());
        assert!(temp.path().join("local.db-wal").exists());
        let rows = memo.read_notebook_configs().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "keep");
        assert_eq!(rows[0].path, "/offline/notes");
        assert_eq!(rows[0].icon.as_deref(), Some("icon"));
        assert_eq!(rows[0].created_at, 123);
        conn.execute("UPDATE notebooks SET name='stale source'", [])
            .unwrap();
        memo.initialize_registry_storage().unwrap();
        assert_eq!(memo.read_notebook_configs().unwrap()[0].name, "Original");
        fs::remove_file(memo.registry_db_path()).unwrap();
        assert!(
            memo.initialize_registry_storage().is_err(),
            "do not restore a stale legacy registry over a lost initialized target"
        );
        assert!(!memo.registry_db_path().exists());
        assert!(legacy.exists());
    }

    #[test]
    fn migration_rejects_changes_to_existing_notebook_fields() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("db")).unwrap();
        let path = temp.path().join("db/local.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE notebooks (id TEXT PRIMARY KEY, name TEXT, icon TEXT, path TEXT,
            is_default INTEGER, created_at INTEGER, updated_at INTEGER);
            INSERT INTO notebooks VALUES ('keep','Original',NULL,'/offline',1,123,456);
            CREATE TRIGGER unexpected_migration_effect AFTER UPDATE ON notebooks BEGIN
                UPDATE notebooks SET name='unexpected change' WHERE id=NEW.id;
            END;",
        )
        .unwrap();
        drop(conn);
        let memo = MemoFile::new(temp.path().to_path_buf());
        let error = memo.initialize_current_registry_storage().unwrap_err();
        assert!(error.to_string().contains("changed existing registry data"));
        let conn = rusqlite::Connection::open(path).unwrap();
        assert_eq!(
            conn.query_row("SELECT name FROM notebooks", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "Original"
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('notebooks') WHERE name='sort'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert!(temp.path().join("db/registry-backups").is_dir());
    }

    #[test]
    fn unavailable_backup_blocks_core_schema_changes_without_modifying_notebooks() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("db")).unwrap();
        let memo = MemoFile::new(temp.path().to_path_buf());
        let conn = rusqlite::Connection::open(memo.registry_db_path()).unwrap();
        conn.execute_batch(
            "CREATE TABLE notebooks (id TEXT PRIMARY KEY,name TEXT,icon TEXT,path TEXT,
            is_default INTEGER,created_at INTEGER,updated_at INTEGER);
            INSERT INTO notebooks VALUES ('keep','Original',NULL,'/offline',1,123,456);",
        )
        .unwrap();
        fs::write(
            temp.path().join("db/registry-backups"),
            b"blocked backup directory",
        )
        .unwrap();
        assert!(memo.initialize_current_registry_storage().is_err());
        assert_eq!(
            conn.query_row("SELECT name FROM notebooks", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "Original"
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('notebooks') WHERE name='sort'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }

    #[test]
    fn runtime_cleanup_skips_a_store_owned_by_another_initializer() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("local.db");
        fs::write(&path, b"retained").unwrap();
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(temp.path().join("local.db.rebuild.lock"))
            .unwrap();
        fs2::FileExt::lock_exclusive(&lock).unwrap();
        discard_database_for_runtime(&path);
        assert_eq!(fs::read(&path).unwrap(), b"retained");
    }

    #[test]
    fn row_constraint_error_is_not_whole_file_corruption() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("local.db");
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TABLE retained(value INTEGER CHECK(value>0)); PRAGMA ignore_check_constraints=ON; INSERT INTO retained VALUES (-1);").unwrap();
        assert!(!database_file_is_corrupt(&path).unwrap());
    }

    #[test]
    fn runtime_registry_write_lock_preserves_healthy_notebook_rows() {
        let temp = tempfile::tempdir().unwrap();
        let memo = MemoFile::new(temp.path().to_path_buf());
        memo.initialize_current_registry_storage().unwrap();
        let connection = rusqlite::Connection::open(memo.registry_db_path()).unwrap();
        connection.execute_batch("INSERT INTO notebooks(id,name,path,is_default,created_at,updated_at) VALUES ('keep','Keep','/tmp/keep',1,1,1); BEGIN IMMEDIATE;").unwrap();
        assert!(memo.initialize_runtime_registry_storage().is_err());
        connection.execute_batch("ROLLBACK;").unwrap();
        let rows = memo.read_notebook_configs().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "keep");
        assert!(!temp.path().join("db/rebuild-backups").exists());
    }

    #[test]
    fn runtime_registry_missing_tables_preserve_other_modules() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("db")).unwrap();
        let connection = rusqlite::Connection::open(temp.path().join("db/local.db")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('keep');",
            )
            .unwrap();
        fs::write(temp.path().join("notebook-registry-initialized"), b"1").unwrap();
        let memo = MemoFile::new(temp.path().to_path_buf());
        memo.initialize_runtime_registry_storage().unwrap();
        assert!(memo.read_notebook_configs().unwrap().is_empty());
        assert_eq!(
            connection
                .query_row("SELECT value FROM retained", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "keep"
        );
    }

    #[test]
    fn runtime_registry_recreates_failed_migration_even_when_backup_fails() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("db")).unwrap();
        let path = temp.path().join("db/local.db");
        fs::write(&path, b"broken registry").unwrap();
        fs::write(temp.path().join("db/rebuild-backups"), b"blocked").unwrap();
        fs::write(temp.path().join("notebook-registry-initialized"), b"1").unwrap();
        let memo = MemoFile::new(temp.path().to_path_buf());
        memo.initialize_runtime_registry_storage().unwrap();
        assert!(memo.read_notebook_configs().unwrap().is_empty());
        memo.initialize_runtime_registry_storage().unwrap();
    }

    #[test]
    fn migration_without_data_leaves_creation_to_runtime() {
        let temp = tempfile::tempdir().unwrap();
        let memo = MemoFile::new(temp.path().to_path_buf());
        assert!(!memo.migrate_existing_registry_storage());
        assert!(!memo.registry_db_path().exists());
        assert!(memo.read_notebook_configs().unwrap().is_empty());
        assert!(memo.registry_db_path().exists());
    }

    #[test]
    fn empty_registry_migration_does_not_create_tables() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("db")).unwrap();
        let path = temp.path().join("db/local.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
        drop(conn);
        let memo = MemoFile::new(temp.path().to_path_buf());
        assert!(!memo.migrate_existing_registry_storage());
        let connection = rusqlite::Connection::open(&path).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM sqlite_master", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        drop(connection);
        assert!(!temp.path().join("notebook-registry-initialized").exists());
        memo.initialize_runtime_registry_storage().unwrap();
        assert!(memo.read_notebook_configs().unwrap().is_empty());
    }

    #[test]
    fn failed_migration_preserves_input_and_leaves_creation_to_runtime() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("db")).unwrap();
        let path = temp.path().join("db/local.db");
        fs::write(&path, b"broken registry").unwrap();
        let memo = MemoFile::new(temp.path().to_path_buf());
        assert!(!memo.migrate_existing_registry_storage());
        assert_eq!(fs::read(&path).unwrap(), b"broken registry");
        memo.initialize_runtime_registry_storage().unwrap();
        let backups = path.parent().unwrap().join("rebuild-backups");
        let backup = fs::read_dir(backups)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(
            fs::read(backup.join("local.db")).unwrap(),
            b"broken registry"
        );
        assert!(memo.read_notebook_configs().unwrap().is_empty());
    }

    #[test]
    fn interrupted_first_registry_initialization_can_be_retried() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("db")).unwrap();
        let path = temp.path().join("db/local.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
        drop(conn);
        assert!(fs::metadata(&path).unwrap().len() > 0);

        let memo = MemoFile::new(temp.path().to_path_buf());
        memo.initialize_current_registry_storage().unwrap();
        memo.initialize_current_registry_storage().unwrap();
        assert!(temp.path().join("notebook-registry-initialized").exists());
    }

    #[test]
    fn initialized_schema_free_registry_still_requires_recovery() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("db")).unwrap();
        let conn = rusqlite::Connection::open(temp.path().join("db/local.db")).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
        drop(conn);
        fs::write(temp.path().join("notebook-registry-initialized"), b"1").unwrap();
        let memo = MemoFile::new(temp.path().to_path_buf());
        assert!(memo.initialize_current_registry_storage().is_err());
    }

    #[test]
    fn unrelated_existing_database_is_not_initialized_as_an_empty_registry() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("db")).unwrap();
        let path = temp.path().join("db/local.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('keep');",
        )
        .unwrap();
        drop(conn);
        let memo = MemoFile::new(temp.path().to_path_buf());
        assert!(memo.initialize_current_registry_storage().is_err());
        let conn = rusqlite::Connection::open(path).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='notebooks'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT value FROM retained", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "keep"
        );
    }

    #[test]
    fn corrupt_legacy_registry_and_orphan_wal_require_recovery() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("local.db");
        fs::write(&legacy, b"broken source").unwrap();
        let memo = MemoFile::new(temp.path().to_path_buf());
        assert!(memo.initialize_registry_storage().is_err());
        assert_eq!(fs::read(&legacy).unwrap(), b"broken source");
        assert!(!memo.registry_db_path().exists());
        fs::remove_file(&legacy).unwrap();
        fs::write(temp.path().join("db/local.db-wal"), b"preserve wal").unwrap();
        assert!(memo.initialize_registry_storage().is_err());
        assert_eq!(
            fs::read(temp.path().join("db/local.db-wal")).unwrap(),
            b"preserve wal"
        );
        assert!(!memo.registry_db_path().exists());
    }

    #[test]
    fn malformed_json_is_preserved_and_defaults_are_persisted() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("preference.json");
        fs::write(&path, b"{broken").unwrap();
        let value: serde_json::Value =
            read_or_create_json(&path, || serde_json::json!({"language":"zh-CN"})).unwrap();
        assert_eq!(value["language"], "zh-CN");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&fs::read(&path).unwrap()).unwrap(),
            value
        );
        assert!(temp.path().join("rebuild-backups").exists());
    }

    #[test]
    fn busy_database_is_not_moved_or_rebuilt() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("local.db");
        fs::write(&path, b"keep").unwrap();
        let result: io::Result<()> = with_database_rebuild(&path, || {
            Err(io::Error::other(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
                None,
            )))
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"keep");
        assert!(!temp.path().join("rebuild-backups").exists());
    }

    #[test]
    fn notebook_database_rebuild_keeps_markdown_and_attachments() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notebook");
        fs::create_dir_all(root.join(".flowix")).unwrap();
        fs::create_dir_all(root.join("attachments")).unwrap();
        fs::write(root.join("kept.md"), b"# Keep this note\n").unwrap();
        fs::write(root.join("attachments/kept.bin"), b"attachment").unwrap();
        fs::write(
            root.join(".flowix/notebook.db"),
            b"invalid notebook database",
        )
        .unwrap();
        let memo = MemoFile::new(temp.path().join("config"));
        memo.write_notebook_configs(&[NotebookConfig {
            id: "nb_kept".into(),
            name: "Kept".into(),
            icon: None,
            path: root.to_string_lossy().into_owned(),
            is_default: false,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        }])
        .unwrap();
        // Database repair runs during schema initialization before indexing.
        memo.initialize_note_index_schema("nb_kept").unwrap();
        memo.reconcile_note_index_blocking("nb_kept").unwrap();
        assert_eq!(
            fs::read(root.join("kept.md")).unwrap(),
            b"# Keep this note\n"
        );
        assert_eq!(
            fs::read(root.join("attachments/kept.bin")).unwrap(),
            b"attachment"
        );
        assert!(root.join(".flowix/rebuild-backups").exists());
    }
}
