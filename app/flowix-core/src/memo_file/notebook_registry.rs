//! Device-local notebook registry database and its process-local cache.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use rusqlite::{params, Connection};

use super::notebook::sqlite_to_io;
use super::types::NotebookConfig;

pub(super) struct NotebookRegistry {
    pub(super) config_dir: PathBuf,
    pub(super) configs_cache: std::sync::RwLock<Option<Vec<NotebookConfig>>>,
}

impl NotebookRegistry {
    pub(super) fn new(config_dir: PathBuf) -> Self {
        Self {
            config_dir,
            configs_cache: std::sync::RwLock::new(None),
        }
    }

    pub(super) fn db_path(&self) -> PathBuf {
        self.config_dir.join("db").join("local.db")
    }

    pub(super) fn open(&self) -> std::io::Result<Connection> {
        self.open_with_legacy_migrations(false, false)
    }

    pub(super) fn open_for_initialization(&self) -> std::io::Result<Connection> {
        self.open_with_legacy_migrations(true, false)
    }

    pub(super) fn open_for_runtime_initialization(&self) -> std::io::Result<Connection> {
        self.open_with_legacy_migrations(true, true)
    }

    fn open_with_legacy_migrations(
        &self,
        run_legacy_migrations: bool,
        allow_missing_notebooks: bool,
    ) -> std::io::Result<Connection> {
        if let Some(parent) = self.db_path().parent() {
            fs::create_dir_all(parent)?;
        }
        let path = self.db_path();
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            if !metadata.file_type().is_file() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "notebook registry must be a regular file; automatic replacement is disabled",
                ));
            }
        }
        if !path.try_exists()? && !allow_missing_notebooks {
            let initialized = self.config_dir.join("notebook-registry-initialized");
            let companions = ["-wal", "-shm", "-journal"]
                .iter()
                .any(|suffix| path.with_file_name(format!("local.db{suffix}")).exists());
            if initialized.try_exists()?
                || companions
                || self.config_dir.join("local.db").try_exists()?
            {
                return Err(std::io::Error::new(std::io::ErrorKind::NotFound,
                    "notebook registry is missing; restore or migrate the existing registry before opening"));
            }
        }
        let existing_database = fs::metadata(&path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false)
            || self
                .config_dir
                .join("notebook-registry-initialized")
                .try_exists()?;
        let mut database = Connection::open(&path).map_err(sqlite_to_io)?;
        database
            .busy_timeout(Duration::from_secs(10))
            .map_err(sqlite_to_io)?;
        database
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
            )
            .map_err(sqlite_to_io)?;
        let has_registry: bool = database.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='notebooks')",
            [], |row| row.get(0),
        ).map_err(sqlite_to_io)?;
        if run_legacy_migrations && existing_database && has_registry {
            snapshot_before_registry_upgrade(&database, &path)?;
        }
        // All schema changes roll back together.
        let mut conn = database
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(sqlite_to_io)?;
        conn.busy_timeout(Duration::from_secs(10))
            .map_err(sqlite_to_io)?;
        let notebooks_table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='notebooks')",
                [],
                |row| row.get(0),
            )
            .map_err(sqlite_to_io)?;
        // An interrupted first initialization may leave only a SQLite header.
        // Resume only a schema-free store with no prior initialization or legacy
        // registry; never reinterpret existing user data as a fresh installation.
        let empty_first_initialization = !self
            .config_dir
            .join("notebook-registry-initialized")
            .try_exists()?
            && !self.config_dir.join("local.db").try_exists()?
            && conn
                .query_row("SELECT COUNT(*) FROM sqlite_master", [], |row| {
                    row.get::<_, i64>(0)
                })
                .map_err(sqlite_to_io)?
                == 0;
        if !notebooks_table_exists
            && existing_database
            && !empty_first_initialization
            && !allow_missing_notebooks
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "existing notebook registry has no notebooks table; recovery required",
            ));
        }
        let preserved_columns = if notebooks_table_exists && run_legacy_migrations {
            let mut statement = conn
                .prepare("PRAGMA table_info(notebooks)")
                .map_err(sqlite_to_io)?;
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(sqlite_to_io)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_to_io)?;
            columns
        } else {
            Vec::new()
        };
        let before = notebook_rows(&conn, &preserved_columns)?;
        let has_sort_column = conn
            .prepare("PRAGMA table_info(notebooks)")
            .map_err(sqlite_to_io)?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(sqlite_to_io)?
            .filter_map(Result::ok)
            .any(|name| name == "sort");
        let has_pinned_column = conn
            .prepare("PRAGMA table_info(notebooks)")
            .map_err(sqlite_to_io)?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(sqlite_to_io)?
            .filter_map(Result::ok)
            .any(|name| name == "pinned");
        if notebooks_table_exists && !has_sort_column && !run_legacy_migrations {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "notebook registry requires version initialization",
            ));
        }
        if notebooks_table_exists && !has_sort_column {
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS notebooks (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    icon TEXT,
                    path TEXT NOT NULL UNIQUE,
                    is_default INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                "#,
            )
            .map_err(sqlite_to_io)?;
            conn.execute_batch("ALTER TABLE notebooks ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;")
                .map_err(sqlite_to_io)?;
        }
        if notebooks_table_exists && !has_pinned_column {
            if !run_legacy_migrations {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "notebook registry requires pinned-column migration",
                ));
            }
            conn.execute_batch("ALTER TABLE notebooks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1));")
                .map_err(sqlite_to_io)?;
        }
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS notebooks (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                icon TEXT,
                path TEXT NOT NULL UNIQUE,
                is_default INTEGER NOT NULL,
                sort INTEGER NOT NULL DEFAULT 0,
                pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_notebooks_is_default
                ON notebooks(is_default);
            CREATE INDEX IF NOT EXISTS idx_notebooks_sort
                ON notebooks(sort);
            CREATE INDEX IF NOT EXISTS idx_notebooks_pinned_sort
                ON notebooks(pinned DESC, sort ASC);
            CREATE TABLE IF NOT EXISTS app_state (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS local_migrations (
                migration_key TEXT PRIMARY KEY,
                completed_at INTEGER NOT NULL DEFAULT 0
            );
            DROP TABLE IF EXISTS notebook_setup_jobs;
            DELETE FROM app_state WHERE key LIKE 'notebook_setup_%';
            "#,
        )
        .map_err(sqlite_to_io)?;
        if notebooks_table_exists && !has_sort_column {
            let tx = conn.savepoint().map_err(sqlite_to_io)?;
            let mut stmt = tx
                .prepare(
                    "SELECT id FROM notebooks WHERE sort = 0 \
                     ORDER BY created_at ASC, name COLLATE NOCASE ASC",
                )
                .map_err(sqlite_to_io)?;
            let ids: Vec<String> = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(sqlite_to_io)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_to_io)?;
            drop(stmt);
            for (index, id) in ids.iter().enumerate() {
                tx.execute(
                    "UPDATE notebooks SET sort = ?1 WHERE id = ?2 AND sort = 0",
                    params![((index as i64) + 1) * 10, id],
                )
                .map_err(sqlite_to_io)?;
            }
            tx.commit().map_err(sqlite_to_io)?;
        }
        if notebook_rows(&conn, &preserved_columns)? != before {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "notebook migration changed existing registry data; migration rolled back",
            ));
        }
        conn.commit().map_err(sqlite_to_io)?;
        let initialized = self.config_dir.join("notebook-registry-initialized");
        if !initialized.try_exists()? {
            super::atomic_write_bytes(&initialized, b"1")?;
        }
        Ok(database)
    }
}

// Compare every existing field, including fields unknown to this app version.
fn notebook_rows(
    conn: &Connection,
    columns: &[String],
) -> std::io::Result<Vec<Vec<rusqlite::types::Value>>> {
    if columns.is_empty() {
        return Ok(Vec::new());
    }
    let projection = columns
        .iter()
        .map(|name| format!("\"{}\"", name.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(",");
    let mut statement = conn
        .prepare(&format!("SELECT {projection} FROM notebooks ORDER BY id"))
        .map_err(sqlite_to_io)?;
    let rows = statement
        .query_map([], |row| {
            (0..columns.len())
                .map(|index| row.get(index))
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(sqlite_to_io)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_to_io)?;
    Ok(rows)
}

/// Keep one validated snapshot for each schema and notebook-identity state.
/// An auxiliary-only upgrade may be deferred when backup fails; changing the
/// authoritative notebook schema always requires a successful snapshot first.
fn snapshot_before_registry_upgrade(
    conn: &Connection,
    path: &std::path::Path,
) -> std::io::Result<()> {
    use sha2::{Digest, Sha256};
    let notebook_columns: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('notebooks') WHERE name IN ('id','name','icon','path','is_default','sort','pinned','created_at','updated_at')",
        [], |row| row.get(0)).map_err(sqlite_to_io)?;
    if notebook_columns == 9 {
        return Ok(());
    }
    let snapshot = (|| -> std::io::Result<()> {
        let mut statement = conn
            .prepare("PRAGMA table_info(notebooks)")
            .map_err(sqlite_to_io)?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(sqlite_to_io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_to_io)?;
        let rows = notebook_rows(conn, &columns)?;
        let mut statement = conn
            .prepare(
                "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND tbl_name = 'notebooks' ORDER BY type,name",
            )
            .map_err(sqlite_to_io)?;
        let schema = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(sqlite_to_io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_to_io)?;
        let digest = format!(
            "{:x}",
            Sha256::digest(format!("{schema:?}{columns:?}{rows:?}").as_bytes())
        );
        let directory = path
            .parent()
            .ok_or_else(|| std::io::Error::other("registry has no parent"))?
            .join("registry-backups")
            .join(format!("schema-v1-{digest}"));
        fs::create_dir_all(&directory)?;
        let target = directory.join("local.db");
        let validate = |candidate: &std::path::Path| -> std::io::Result<()> {
            let backup =
                Connection::open_with_flags(candidate, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .map_err(sqlite_to_io)?;
            let check: String = backup
                .query_row("PRAGMA quick_check", [], |row| row.get(0))
                .map_err(sqlite_to_io)?;
            if check != "ok" || notebook_rows(&backup, &columns)? != rows {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "registry backup validation failed",
                ));
            }
            Ok(())
        };
        if target.try_exists()? {
            return validate(&target);
        }
        // VACUUM INTO needs a nonexistent destination. The temporary directory
        // cleans up interrupted failures without leaving a partial reusable backup.
        let temporary = tempfile::tempdir_in(&directory)?;
        let staged = temporary.path().join("local.db");
        conn.execute("VACUUM INTO ?1", [staged.to_string_lossy().as_ref()])
            .map_err(sqlite_to_io)?;
        validate(&staged)?;
        fs::OpenOptions::new()
            .write(true)
            .open(&staged)?
            .sync_all()?;
        match fs::hard_link(&staged, &target) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => validate(&target),
            Err(error) => Err(error),
        }
    })();
    snapshot
}
