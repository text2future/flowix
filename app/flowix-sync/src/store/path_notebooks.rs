use super::*;
use crate::state::{
    PathNotebookLink, PathNotebookMetadata, PendingNotebookAction, PendingNotebookChange,
};

impl SyncStore {
    pub(super) fn initialize_path_notebook_schema(
        connection: &Connection,
    ) -> Result<(), SyncError> {
        connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS path_notebooks (
                notebook_id TEXT PRIMARY KEY,
                enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
                name TEXT NOT NULL,
                icon TEXT,
                sort_order INTEGER NOT NULL,
                manifest_uploaded INTEGER NOT NULL DEFAULT 0 CHECK(manifest_uploaded IN (0, 1)),
                generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
                pending_action TEXT CHECK(pending_action IN ('put', 'delete')),
                updated_at INTEGER NOT NULL
            );
            "#,
        )?;
        Ok(())
    }

    pub fn path_notebook(&self, notebook_id: &str) -> Result<Option<PathNotebookLink>, SyncError> {
        self.open()?
            .query_row(
                "SELECT notebook_id, enabled, updated_at FROM path_notebooks WHERE notebook_id = ?1",
                params![notebook_id],
                |row| {
                    Ok(PathNotebookLink {
                        notebook_id: row.get(0)?,
                        enabled: row.get(1)?,
                        updated_at: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn path_enabled_notebooks(&self) -> Result<Vec<PathNotebookLink>, SyncError> {
        let connection = self.open()?;
        let mut statement = connection.prepare(
            "SELECT notebook_id, enabled, updated_at FROM path_notebooks
             WHERE enabled = 1 AND (pending_action IS NULL OR pending_action != 'delete')
             ORDER BY updated_at, notebook_id",
        )?;
        let entries = statement
            .query_map([], |row| {
                Ok(PathNotebookLink {
                    notebook_id: row.get(0)?,
                    enabled: row.get(1)?,
                    updated_at: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::from)?;
        Ok(entries)
    }

    pub fn set_path_notebook(
        &self,
        notebook: &PathNotebookMetadata,
        enabled: bool,
    ) -> Result<PathNotebookLink, SyncError> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        let current = transaction
            .query_row(
                "SELECT enabled, name, icon, sort_order, manifest_uploaded, generation, pending_action
                 FROM path_notebooks WHERE notebook_id = ?1",
                params![notebook.id],
                |row| {
                    Ok((
                        row.get::<_, bool>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, bool>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, Option<String>>(6)?,
                    ))
                },
            )
            .optional()?;

        let (manifest_uploaded, generation, pending_action) = match current {
            None => (false, 1, enabled.then(|| "put".to_owned())),
            Some((was_enabled, name, icon, sort_order, uploaded, generation, pending)) => {
                let metadata_changed = name != notebook.name
                    || icon != notebook.icon
                    || sort_order != notebook.sort_order;
                let should_publish = enabled && (!was_enabled || metadata_changed || !uploaded);
                let next_generation = if should_publish {
                    generation.saturating_add(1)
                } else {
                    generation
                };
                let next_action = if should_publish {
                    Some("put".to_owned())
                } else if !uploaded && !enabled && pending.as_deref() == Some("put") {
                    None
                } else {
                    pending
                };
                (uploaded, next_generation, next_action)
            }
        };

        transaction.execute(
            r#"INSERT INTO path_notebooks
                 (notebook_id, enabled, name, icon, sort_order, manifest_uploaded, generation, pending_action, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
               ON CONFLICT(notebook_id) DO UPDATE SET
                 enabled = excluded.enabled, name = excluded.name, icon = excluded.icon,
                 sort_order = excluded.sort_order, manifest_uploaded = excluded.manifest_uploaded,
                 generation = excluded.generation, pending_action = excluded.pending_action,
                 updated_at = excluded.updated_at"#,
            params![
                notebook.id,
                enabled,
                notebook.name,
                notebook.icon,
                notebook.sort_order,
                manifest_uploaded,
                generation,
                pending_action,
                now,
            ],
        )?;
        let link = PathNotebookLink {
            notebook_id: notebook.id.clone(),
            enabled,
            updated_at: now,
        };
        transaction.commit()?;
        Ok(link)
    }

    pub fn record_path_notebook_change(
        &self,
        notebook: &PathNotebookMetadata,
    ) -> Result<bool, SyncError> {
        let Some(current) = self.path_notebook(&notebook.id)? else {
            return Ok(false);
        };
        if !current.enabled {
            return Ok(false);
        }
        self.set_path_notebook(notebook, true)?;
        Ok(true)
    }

    pub fn record_path_notebook_delete(&self, notebook_id: &str) -> Result<(), SyncError> {
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        let current = transaction
            .query_row(
                "SELECT manifest_uploaded, generation FROM path_notebooks WHERE notebook_id = ?1",
                params![notebook_id],
                |row| Ok((row.get::<_, bool>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?;
        if let Some((_uploaded, generation)) = current {
            transaction.execute(
                "UPDATE path_notebooks SET enabled = 0, pending_action = 'delete', generation = ?2, updated_at = ?3 WHERE notebook_id = ?1",
                params![notebook_id, generation.saturating_add(1), chrono::Utc::now().timestamp_millis()],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn pending_path_notebook_changes(&self) -> Result<Vec<PendingNotebookChange>, SyncError> {
        let connection = self.open()?;
        let mut statement = connection.prepare(
            "SELECT notebook_id, generation, pending_action FROM path_notebooks
             WHERE pending_action IS NOT NULL ORDER BY updated_at, notebook_id",
        )?;
        let entries = statement
            .query_map([], |row| {
                let action: String = row.get(2)?;
                Ok(PendingNotebookChange {
                    notebook_id: row.get(0)?,
                    generation: row.get(1)?,
                    action: match action.as_str() {
                        "put" => PendingNotebookAction::Put,
                        _ => PendingNotebookAction::Delete,
                    },
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::from)?;
        Ok(entries)
    }

    pub fn ack_path_notebook_change(
        &self,
        notebook_id: &str,
        generation: i64,
        action: PendingNotebookAction,
    ) -> Result<(), SyncError> {
        let connection = self.open()?;
        match action {
            PendingNotebookAction::Put => {
                connection.execute(
                    "UPDATE path_notebooks SET manifest_uploaded = 1, pending_action = NULL, updated_at = ?3
                     WHERE notebook_id = ?1 AND generation = ?2 AND pending_action = 'put'",
                    params![notebook_id, generation, chrono::Utc::now().timestamp_millis()],
                )?;
            }
            PendingNotebookAction::Delete => {
                connection.execute(
                    "DELETE FROM path_notebooks WHERE notebook_id = ?1 AND generation = ?2 AND pending_action = 'delete'",
                    params![notebook_id, generation],
                )?;
            }
        }
        Ok(())
    }
}

