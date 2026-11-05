//! Notebook registry storage.
//!
//! The authoritative notebook registry lives in `db/local.db` under the user
//! config directory (`~/.flowix/db/local.db` in production). Notebook-owned note
//! and media data live separately in `<notebook>/.flowix/notebook.db`.

use rusqlite::{params, Connection};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use super::file_io::atomic_write_bytes;
use super::types::{NotebookConfig, NotebookManifest};
use super::MemoFile;

pub(super) fn sqlite_to_io(error: rusqlite::Error) -> std::io::Error {
    std::io::Error::other(error)
}

impl MemoFile {
    pub const NOTEBOOK_MANIFEST_VERSION: u32 = 1;

    pub fn read_notebook_manifest(
        path: &std::path::Path,
    ) -> std::io::Result<Option<NotebookManifest>> {
        let manifest_path = path.join(".flowix/notebook.json");
        let bytes = match fs::read(&manifest_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let value: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        if value.get("formatVersion").is_none()
            && value.get("notebookId").is_none()
            && value.get("hiddenListFolders").is_some()
        {
            // A file-browser preference document is not a manifest.
            return Ok(None);
        }
        let manifest = serde_json::from_slice::<NotebookManifest>(&bytes)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        if manifest.format_version == 0 || manifest.notebook_id.trim().is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid notebook manifest",
            ));
        }
        Ok(Some(manifest))
    }

    pub fn ensure_notebook_manifest(config: &NotebookConfig) -> std::io::Result<NotebookManifest> {
        let root = std::path::Path::new(&config.path);
        if let Some(existing) = Self::read_notebook_manifest(root)? {
            if existing.notebook_id != config.id {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!(
                        "notebook manifest id {} conflicts with registry id {}",
                        existing.notebook_id, config.id
                    ),
                ));
            }
            return Ok(existing);
        }
        fs::create_dir_all(root.join(".flowix"))?;
        let manifest = NotebookManifest {
            format_version: Self::NOTEBOOK_MANIFEST_VERSION,
            notebook_id: config.id.clone(),
            created_at: config.created_at,
        };
        let body = serde_json::to_vec_pretty(&manifest)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        atomic_write_bytes(&root.join(".flowix/notebook.json"), &body)?;
        Ok(manifest)
    }

    /// Path-keyed note projection, media catalog and notebook-owned metadata.
    pub fn notebook_db_path(&self, notebook_id: &str) -> std::io::Result<PathBuf> {
        let notebook = self.get_notebook_config_by_id(notebook_id).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "notebook not found")
        })?;
        let root = PathBuf::from(notebook.path);
        if !root.is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("notebook directory missing: {}", root.display()),
            ));
        }
        let flowix_dir = root.join(".flowix");
        fs::create_dir_all(&flowix_dir)?;
        Ok(flowix_dir.join("notebook.db"))
    }

    /// Device-local notebook registry database. It stores registry state, not the active
    /// notebook's note catalog.
    pub fn registry_db_path(&self) -> PathBuf {
        self.registry.db_path()
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
        fs::create_dir_all(self.get_flowix_dir())?;
        fs::create_dir_all(self.get_memo_base().join("attachments"))?;
        Ok(())
    }

    /// Attempt migration only when registry data already exists. Missing or
    /// failed inputs are skipped; stage 2 owns cleanup and fresh-store creation.
    pub fn migrate_existing_registry_storage(&self) -> bool {
        let migration = (|| -> std::io::Result<bool> {
            let current = self.registry.db_path();
            let legacy = self.registry.config_dir.join("local.db");
            let source = if current.try_exists()? {
                current
            } else if legacy.try_exists()? {
                legacy
            } else {
                return Ok(false);
            };
            let connection =
                Connection::open_with_flags(source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .map_err(sqlite_to_io)?;
            connection
                .prepare("SELECT id FROM notebooks LIMIT 0")
                .map_err(sqlite_to_io)?;
            drop(connection);
            self.initialize_registry_storage()?;
            Ok(true)
        })();
        migration.unwrap_or_else(|error| {
            tracing::warn!(%error, "registry migration skipped");
            false
        })
    }

    /// Stage 2 creates missing registry tables without replacing other data.
    /// Only confirmed file corruption permits replacement of the entire store.
    pub fn initialize_runtime_registry_storage(&self) -> std::io::Result<()> {
        let initialize = || -> std::io::Result<()> {
            let _connection = self.registry.open_for_runtime_initialization()?;
            self.read_notebook_configs()?;
            self.read_selected_notebook_id()?;
            Ok(())
        };
        if let Err(error) = initialize() {
            if !super::database_file_is_corrupt(&self.registry.db_path()).unwrap_or(false) {
                return Err(error);
            }
            tracing::warn!(%error, "recreating corrupt notebook registry for runtime");
            super::discard_database_for_runtime(&self.registry.db_path());
            initialize()?;
        }
        Ok(())
    }

    /// Prepare the current registry schema and migrate its database directory.
    pub fn initialize_registry_storage(&self) -> std::io::Result<()> {
        super::database_layout::prepare_database_directory(
            &self.registry.config_dir,
            &["local.db"],
        )?;
        self.initialize_current_registry_storage()
    }

    /// Prepare only the current store. A completed installation must not inspect
    /// or copy legacy databases when a runtime dependency needs rebuilding.
    pub fn initialize_current_registry_storage(&self) -> std::io::Result<()> {
        // The registry is authoritative user data, never a disposable cache.
        // Initialization failures must leave it in place rather than publish an empty registry.
        let _connection = self.registry.open_for_initialization()?;
        self.read_notebook_configs()?;
        self.read_selected_notebook_id()?;
        if let Err(error) = self.workspace_connection() {
            tracing::warn!(%error, "notebook workspace initialization deferred; registry preserved");
        }
        Ok(())
    }

    /// Read a completion marker from the device-local migration journal.
    pub fn local_migration_completed(&self, key: &str) -> std::io::Result<bool> {
        let connection = self.registry.open()?;
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM local_migrations WHERE migration_key = ?1)",
                [key],
                |row| row.get(0),
            )
            .map_err(sqlite_to_io)
    }

    /// Record a completed device-local migration step.
    pub fn mark_local_migration_completed(&self, key: &str) -> std::io::Result<()> {
        let connection = self.registry.open()?;
        connection
            .execute(
                "INSERT OR IGNORE INTO local_migrations (migration_key, completed_at) VALUES (?1, CAST(strftime('%s','now') AS INTEGER) * 1000)",
                [key],
            )
            .map_err(sqlite_to_io)?;
        Ok(())
    }

    /// Whether a registered notebook still needs its legacy storage decision.
    /// Offline notebooks remain pending until their paths can be inspected.
    pub fn has_pending_notebook_storage_initialization(&self) -> std::io::Result<bool> {
        for notebook in self.read_notebook_configs()? {
            for job in super::NotebookInitializationJob::ALL {
                if !self.local_migration_completed(&job.key(&notebook.id))? {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    pub(super) fn open_registry_db(&self) -> std::io::Result<Connection> {
        self.registry.open()
    }

    /// Find a notebook config by id.
    pub fn get_notebook_config_by_id(&self, id: &str) -> Option<NotebookConfig> {
        let configs = self.read_notebook_configs().ok()?;
        configs.into_iter().find(|c| c.id == id)
    }

    /// Return the notebook most recently selected by the user interface.
    ///
    /// This is shared cross-process state. It is intentionally separate from
    /// `current_notebook_id`, which is only the operation context of one
    /// `MemoFile` instance. A stale value (for example after deletion) is
    /// treated as no selection.
    pub fn read_selected_notebook_id(&self) -> std::io::Result<Option<String>> {
        let conn = self.open_registry_db()?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT s.value
                FROM app_state s
                JOIN notebooks n ON n.id = s.value
                WHERE s.key = 'selected_notebook_id'
                "#,
            )
            .map_err(sqlite_to_io)?;
        let mut rows = stmt.query([]).map_err(sqlite_to_io)?;
        Ok(rows
            .next()
            .map_err(sqlite_to_io)?
            .map(|row| row.get(0))
            .transpose()
            .map_err(sqlite_to_io)?)
    }

    /// Persist the notebook selected by the user interface for Desktop, CLI,
    /// and MCP consumers that share this Flowix home.
    pub fn write_selected_notebook_id(&self, id: Option<&str>) -> std::io::Result<()> {
        let conn = self.open_registry_db()?;
        if let Some(id) = id {
            let exists = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM notebooks WHERE id = ?1)",
                    [id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(sqlite_to_io)?;
            if !exists {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("notebook {id} not found"),
                ));
            }
            conn.execute(
                r#"
                INSERT INTO app_state (key, value, updated_at)
                VALUES ('selected_notebook_id', ?1, ?2)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                "#,
                params![id, chrono::Utc::now().timestamp_millis()],
            )
            .map_err(sqlite_to_io)?;
        } else {
            conn.execute(
                "DELETE FROM app_state WHERE key = 'selected_notebook_id'",
                [],
            )
            .map_err(sqlite_to_io)?;
        }
        Ok(())
    }

    /// Read notebook configs from the user-level registry database.
    pub fn read_notebook_configs(&self) -> std::io::Result<Vec<NotebookConfig>> {
        let conn = self.open_registry_db()?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, name, icon, path, is_default, sort, created_at, updated_at
                FROM notebooks
                -- 用户拖拽顺序优先, 然后用 created_at + name 兜底 (旧库未
                -- normalize 时 sort 全部一致, 仍能保持稳定顺序)。
                ORDER BY pinned DESC, sort ASC, created_at ASC, name COLLATE NOCASE ASC
                "#,
            )
            .map_err(sqlite_to_io)?;
        let rows = stmt
            .query_map([], |row| {
                let is_default: i64 = row.get(4)?;
                // sort 列 NOT NULL DEFAULT 0, 老库升级路径已经 normalize 过;
                // 这里 COALESCE 兜底列存在但值缺失的极端情形。
                let sort: i64 = row.get::<_, Option<i64>>(5)?.unwrap_or(0);
                Ok(NotebookConfig {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    icon: row.get(2)?,
                    path: row.get(3)?,
                    is_default: is_default != 0,
                    sort,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })
            .map_err(sqlite_to_io)?;
        let configs = rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_to_io)?;

        *self
            .registry
            .configs_cache
            .write()
            .expect("notebook_configs_cache poisoned") = Some(configs.clone());
        Ok(configs)
    }

    /// Read device-local pin state for the global notebook selector.
    pub fn read_notebook_pin_states(&self) -> std::io::Result<HashSet<String>> {
        let conn = self.open_registry_db()?;
        let mut stmt = conn
            .prepare("SELECT id FROM notebooks WHERE pinned = 1")
            .map_err(sqlite_to_io)?;
        let pinned_ids = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(sqlite_to_io)?
            .collect::<Result<HashSet<_>, _>>()
            .map_err(sqlite_to_io)?;
        Ok(pinned_ids)
    }

    /// Update a notebook's device-local pin state without changing its drag order.
    pub fn set_notebook_pinned(&self, notebook_id: &str, pinned: bool) -> std::io::Result<bool> {
        let conn = self.open_registry_db()?;
        let changed = conn
            .execute(
                "UPDATE notebooks SET pinned = ?1 WHERE id = ?2",
                params![if pinned { 1 } else { 0 }, notebook_id],
            )
            .map_err(sqlite_to_io)?
            > 0;
        if changed {
            *self
                .registry
                .configs_cache
                .write()
                .expect("notebook_configs_cache poisoned") = None;
        }
        Ok(changed)
    }

    /// Registered notebook directories.
    pub fn registered_notebook_paths(&self) -> Vec<PathBuf> {
        self.read_notebook_configs()
            .unwrap_or_default()
            .into_iter()
            .map(|config| PathBuf::from(config.path))
            .collect()
    }

    /// Synchronize notebook rows in `local.db` without deleting unchanged
    /// notebook ids. Deleting and reinserting every row would trigger
    /// `ON DELETE CASCADE` on memo rows for notebooks that still exist.
    pub fn write_notebook_configs(&self, notebooks: &[NotebookConfig]) -> std::io::Result<()> {
        // Validate/write portable identities before changing the device-local
        // catalog, so a manifest conflict cannot leave the registry committed
        // to a different notebook identity.
        for notebook in notebooks {
            if std::path::Path::new(&notebook.path).is_dir() {
                Self::ensure_notebook_manifest(notebook)?;
            }
        }
        let mut conn = self.open_registry_db()?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(sqlite_to_io)?;
        {
            let mut stmt = tx
                .prepare(
                    r#"
                    INSERT INTO notebooks
                        (id, name, icon, path, is_default, sort, created_at, updated_at)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                    ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        icon = excluded.icon,
                        path = excluded.path,
                        is_default = excluded.is_default,
                        sort = excluded.sort,
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
                    config.sort,
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
            .registry
            .configs_cache
            .write()
            .expect("notebook_configs_cache poisoned") = Some(notebooks.to_vec());
        Ok(())
    }

    /// 分配一个新 notebook 的 sort: 已存在的最大 sort + 10, 步长 10 方便后续
    /// reorder 时直接在中间插入。空库从 10 起。
    ///
    /// 用于 `create_notebook_registry` 等新建入口; 跟读路径 ORDER BY sort ASC
    /// 配套, 保证新行自然落到末尾。
    pub fn next_notebook_sort(&self) -> std::io::Result<i64> {
        let conn = self.open_registry_db()?;
        let max_sort: Option<i64> = conn
            .query_row("SELECT MAX(sort) FROM notebooks", [], |row| row.get(0))
            .ok()
            .flatten();
        Ok(max_sort.map(|v| v + 10).unwrap_or(10))
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
            // 该默认 notebook 不持久化 (init_default_notebook_with_status
            // 注释明确: 不写盘, 留给用户选择), sort 占 0 即可。
            sort: 0,
            created_at: chrono::Utc::now().timestamp_millis(),
            updated_at: chrono::Utc::now().timestamp_millis(),
        };
        (default_nb, false)
    }
}
