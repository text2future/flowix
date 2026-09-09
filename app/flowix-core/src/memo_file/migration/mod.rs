//! Ordered application-data migrations executed before normal startup.
//!
//! Add one module and one registry entry for every structural data change.
//! A version is persisted only after its migration succeeds, so interrupted
//! upgrades retry the unfinished version on the next launch.

mod v001;
mod v002;

use std::io;

use rusqlite::{params, OptionalExtension};

use super::{notebook::sqlite_to_io, MemoFile};

pub const LATEST_DATA_MIGRATION_VERSION: u32 = 2;

struct Migration {
    version: u32,
    run: fn(&MemoFile) -> io::Result<()>,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        run: v001::run,
    },
    Migration {
        version: 2,
        run: v002::run,
    },
];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DataMigrationReport {
    pub from_version: u32,
    pub to_version: u32,
    pub applied: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NotebookMigrationReport {
    pub moved_files: usize,
    pub rebuilt_tags: usize,
}

impl MemoFile {
    /// Ensure the notebook's directory-level data is ready before a disk
    /// reconciliation. This is needed when a notebook is imported and its
    /// Markdown files have not been registered in the index yet.
    pub fn ensure_notebook_structure_migration(&self, notebook_id: &str) -> io::Result<usize> {
        let notebook = self
            .get_notebook_config_by_id(notebook_id)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "notebook not found"))?;
        let root = std::path::Path::new(&notebook.path);
        if !root.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("notebook directory missing: {}", root.display()),
            ));
        }

        Self::ensure_notebook_manifest(&notebook)?;
        let internal = self.migrate_notebook_internal_data(notebook_id)?;
        if !internal.completed {
            return Err(io::Error::other(format!(
                "notebook migration incomplete: {}",
                internal.warnings.join("; ")
            )));
        }
        Ok(internal.moved_files)
    }

    /// Bring one available notebook through every notebook-scoped migration.
    ///
    /// The application-level migration version cannot cover notebooks that are
    /// added after startup, or notebooks that are temporarily unavailable.
    /// Callers should use this method when a notebook is imported or selected.
    pub fn ensure_notebook_migrations(
        &self,
        notebook_id: &str,
    ) -> io::Result<NotebookMigrationReport> {
        let moved_files = self.ensure_notebook_structure_migration(notebook_id)?;
        let rebuilt_tags = self.ensure_tag_union_index_for_notebook_id(notebook_id)?;
        Ok(NotebookMigrationReport {
            moved_files,
            rebuilt_tags,
        })
    }

    /// Run every unfinished structural migration in version order.
    pub fn run_pending_data_migrations(&self) -> io::Result<DataMigrationReport> {
        let _process_guard = self.acquire_cross_process_write_lock()?;
        let conn = self.open_index_db()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS data_migration_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                version INTEGER NOT NULL
            );
            INSERT OR IGNORE INTO data_migration_state (id, version) VALUES (1, 0);",
        )
        .map_err(sqlite_to_io)?;
        let from_version = conn
            .query_row(
                "SELECT version FROM data_migration_state WHERE id = 1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(sqlite_to_io)?
            .unwrap_or(0)
            .max(0) as u32;
        drop(conn);

        let mut current_version = from_version;
        let mut applied = 0;
        for migration in MIGRATIONS {
            if migration.version <= current_version {
                continue;
            }
            (migration.run)(self)?;
            let conn = self.open_index_db()?;
            conn.execute(
                "UPDATE data_migration_state SET version = ?1 WHERE id = 1",
                params![migration.version as i64],
            )
            .map_err(sqlite_to_io)?;
            current_version = migration.version;
            applied += 1;
        }

        Ok(DataMigrationReport {
            from_version,
            to_version: current_version,
            applied,
        })
    }

    #[cfg(test)]
    pub(crate) fn data_migration_version(&self) -> io::Result<u32> {
        let conn = self.open_index_db()?;
        conn.query_row(
            "SELECT version FROM data_migration_state WHERE id = 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|version| version.max(0) as u32)
        .map_err(sqlite_to_io)
    }
}
