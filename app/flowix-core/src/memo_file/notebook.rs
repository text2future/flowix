//! Notebook registry storage.
//!
//! The authoritative notebook registry lives in `index.db` under the user
//! config directory (`~/.flowix/index.db` in production). It is created with
//! schema on first call to `open_index_db` and read/written via SQLite.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use rusqlite::{params, Connection};

use super::types::NotebookConfig;
use super::MemoFile;

pub(super) fn sqlite_to_io(error: rusqlite::Error) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, error)
}

impl MemoFile {
    /// Global index database path under the user config directory.
    /// In production this is `~/.flowix/index.db`, located next to the rest of
    /// the user config so notebook registry data stays together.
    pub fn get_index_db_path(&self) -> PathBuf {
        self.config_dir.join("index.db")
    }

    /// Default notebook directory: `~/Documents/flowix`.
    pub fn get_default_notebook_path(&self) -> PathBuf {
        dirs::document_dir()
            .unwrap_or_else(|| PathBuf::from("/tmp"))
            .join("flowix")
    }

    /// Ensure the current notebook's storage directories exist.
    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        let base = self.get_memo_base();
        if self.current_notebook_id.is_some() && !base.is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("notebook directory missing: {}", base.display()),
            ));
        }
        fs::create_dir_all(&base)?;
        fs::create_dir_all(self.get_metadata_dir())?;
        fs::create_dir_all(self.get_memo_base().join("attachments"))?;
        Ok(())
    }

    pub(super) fn open_index_db(&self) -> std::io::Result<Connection> {
        if let Some(parent) = self.get_index_db_path().parent() {
            fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(self.get_index_db_path()).map_err(sqlite_to_io)?;
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS notebooks (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                icon TEXT,
                path TEXT NOT NULL UNIQUE,
                is_default INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_notebooks_is_default
                ON notebooks(is_default);
            "#,
        )
        .map_err(sqlite_to_io)?;
        Ok(conn)
    }

    /// Find a notebook config by id.
    pub fn get_notebook_config_by_id(&self, id: &str) -> Option<NotebookConfig> {
        let configs = self.read_notebook_configs().ok()?;
        configs.into_iter().find(|c| c.id == id)
    }

    /// Read notebook configs from the global `index.db`.
    pub fn read_notebook_configs(&self) -> std::io::Result<Vec<NotebookConfig>> {
        if let Some(cached) = self
            .notebook_configs_cache
            .read()
            .expect("notebook_configs_cache poisoned")
            .as_ref()
        {
            return Ok(cached.clone());
        }

        let conn = self.open_index_db()?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, name, icon, path, is_default, created_at, updated_at
                FROM notebooks
                ORDER BY created_at ASC, name COLLATE NOCASE ASC
                "#,
            )
            .map_err(sqlite_to_io)?;
        let rows = stmt
            .query_map([], |row| {
                let is_default: i64 = row.get(4)?;
                Ok(NotebookConfig {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    icon: row.get(2)?,
                    path: row.get(3)?,
                    is_default: is_default != 0,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })
            .map_err(sqlite_to_io)?;
        let configs = rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_to_io)?;

        *self
            .notebook_configs_cache
            .write()
            .expect("notebook_configs_cache poisoned") = Some(configs.clone());
        Ok(configs)
    }

    /// Registered notebook directories.
    pub fn registered_notebook_paths(&self) -> Vec<PathBuf> {
        self.read_notebook_configs()
            .unwrap_or_default()
            .into_iter()
            .map(|config| PathBuf::from(config.path))
            .collect()
    }

    /// Synchronize notebook rows in `index.db` without deleting unchanged
    /// notebook ids. Deleting and reinserting every row would trigger
    /// `ON DELETE CASCADE` on memo rows for notebooks that still exist.
    pub fn write_notebook_configs(&self, notebooks: &[NotebookConfig]) -> std::io::Result<()> {
        let mut conn = self.open_index_db()?;
        let tx = conn.transaction().map_err(sqlite_to_io)?;
        {
            let mut stmt = tx
                .prepare(
                    r#"
                    INSERT INTO notebooks
                        (id, name, icon, path, is_default, created_at, updated_at)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                    ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        icon = excluded.icon,
                        path = excluded.path,
                        is_default = excluded.is_default,
                        created_at = excluded.created_at,
                        updated_at = excluded.updated_at
                    "#,
                )
                .map_err(sqlite_to_io)?;
            for config in notebooks {
                stmt.execute(params![
                    config.id,
                    config.name,
                    config.icon,
                    config.path,
                    if config.is_default { 1 } else { 0 },
                    config.created_at,
                    config.updated_at,
                ])
                .map_err(sqlite_to_io)?;
            }
        }

        let keep_ids: HashSet<&str> = notebooks.iter().map(|config| config.id.as_str()).collect();
        let mut stmt = tx
            .prepare("SELECT id FROM notebooks")
            .map_err(sqlite_to_io)?;
        let existing_ids = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(sqlite_to_io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_to_io)?;
        drop(stmt);

        for id in existing_ids {
            if !keep_ids.contains(id.as_str()) {
                tx.execute("DELETE FROM notebooks WHERE id = ?1", params![id])
                    .map_err(sqlite_to_io)?;
            }
        }

        tx.commit().map_err(sqlite_to_io)?;

        *self
            .notebook_configs_cache
            .write()
            .expect("notebook_configs_cache poisoned") = Some(notebooks.to_vec());
        Ok(())
    }

    /// Return the first registered notebook, or a non-persisted placeholder
    /// when no notebook has been registered yet.
    pub fn init_default_notebook(&self) -> NotebookConfig {
        self.init_default_notebook_with_status().0
    }

    /// Return the first registered notebook and report whether this call created it.
    ///
    /// New installs intentionally do not auto-register `~/Documents/flowix`.
    /// The desktop UI asks the user to choose a notebook folder first, so this
    /// method must not write a default notebook as a startup side effect.
    pub fn init_default_notebook_with_status(&self) -> (NotebookConfig, bool) {
        if let Ok(configs) = self.read_notebook_configs() {
            if let Some(nb) = configs.first().cloned() {
                return (nb, false);
            }
        }

        let default_nb = NotebookConfig {
            id: "nb_default".to_string(),
            name: "Default Notebook".to_string(),
            icon: None,
            path: format!("{}/", self.get_default_notebook_path().to_string_lossy()),
            is_default: false,
            created_at: chrono::Utc::now().timestamp_millis(),
            updated_at: chrono::Utc::now().timestamp_millis(),
        };
        (default_nb, false)
    }
}
