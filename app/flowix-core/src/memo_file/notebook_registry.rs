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
        self.config_dir.join("index.db")
    }

    pub(super) fn open(&self) -> std::io::Result<Connection> {
        if let Some(parent) = self.db_path().parent() {
            fs::create_dir_all(parent)?;
        }
        let mut conn = Connection::open(self.db_path()).map_err(sqlite_to_io)?;
        conn.busy_timeout(Duration::from_secs(10))
            .map_err(sqlite_to_io)?;
        let has_sort_column = conn
            .prepare("PRAGMA table_info(notebooks)")
            .map_err(sqlite_to_io)?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(sqlite_to_io)?
            .filter_map(Result::ok)
            .any(|name| name == "sort");
        if !has_sort_column {
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
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
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
            CREATE INDEX IF NOT EXISTS idx_notebooks_is_default
                ON notebooks(is_default);
            CREATE INDEX IF NOT EXISTS idx_notebooks_sort
                ON notebooks(sort);
            CREATE TABLE IF NOT EXISTS app_state (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS notebook_setup_jobs (
                notebook_id TEXT PRIMARY KEY REFERENCES notebooks(id) ON DELETE CASCADE,
                template_id TEXT,
                status TEXT NOT NULL,
                stage TEXT NOT NULL,
                completed_files INTEGER NOT NULL DEFAULT 0,
                total_files INTEGER NOT NULL DEFAULT 0,
                message TEXT,
                report_json TEXT,
                overwrite_existing INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            );
            "#,
        )
        .map_err(sqlite_to_io)?;
        let has_setup_report = conn
            .prepare("PRAGMA table_info(notebook_setup_jobs)")
            .map_err(sqlite_to_io)?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(sqlite_to_io)?
            .filter_map(Result::ok)
            .any(|name| name == "report_json");
        if !has_setup_report {
            conn.execute_batch("ALTER TABLE notebook_setup_jobs ADD COLUMN report_json TEXT;")
                .map_err(sqlite_to_io)?;
        }
        let has_setup_overwrite = conn
            .prepare("PRAGMA table_info(notebook_setup_jobs)")
            .map_err(sqlite_to_io)?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(sqlite_to_io)?
            .filter_map(Result::ok)
            .any(|name| name == "overwrite_existing");
        if !has_setup_overwrite {
            conn.execute_batch(
                "ALTER TABLE notebook_setup_jobs ADD COLUMN overwrite_existing INTEGER NOT NULL DEFAULT 0;",
            )
            .map_err(sqlite_to_io)?;
        }
        if !has_sort_column {
            let tx = conn.transaction().map_err(sqlite_to_io)?;
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
        Ok(conn)
    }
}
