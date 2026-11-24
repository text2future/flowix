use super::*;
use crate::models::CloudAccount;

impl SyncStore {
    pub(super) fn initialize_account_schema(connection: &Connection) -> Result<(), SyncError> {
        connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS session_restore_policy (
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                blocked INTEGER NOT NULL CHECK(blocked IN (0, 1))
            );
            INSERT OR IGNORE INTO session_restore_policy(singleton, blocked) VALUES (1, 0);
            CREATE TABLE IF NOT EXISTS cloud_account (
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                user_id TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            "#,
        )?;
        Ok(())
    }

    pub fn save_account(&self, account: &CloudAccount) -> Result<(), SyncError> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        let previous_user = transaction
            .query_row(
                "SELECT user_id FROM cloud_account WHERE singleton = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if previous_user
            .as_deref()
            .is_some_and(|user_id| user_id != account.user.id)
        {
            clear_path_sync_state(&transaction)?;
        }
        transaction.execute(
            r#"INSERT INTO cloud_account(singleton, user_id, payload_json, updated_at)
               VALUES (1, ?1, ?2, ?3)
               ON CONFLICT(singleton) DO UPDATE SET user_id = excluded.user_id,
                 payload_json = excluded.payload_json, updated_at = excluded.updated_at"#,
            params![
                account.user.id,
                serde_json::to_string(account).map_err(|error| {
                    SyncError::InvalidState(format!("serialize cloud account: {error}"))
                })?,
                now
            ],
        )?;
        transaction.execute(
            "UPDATE session_restore_policy SET blocked = 0 WHERE singleton = 1",
            [],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn clear_account(&self) -> Result<(), SyncError> {
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "UPDATE session_restore_policy SET blocked = 1 WHERE singleton = 1",
            [],
        )?;
        clear_path_sync_state(&transaction)?;
        transaction.execute("DELETE FROM cloud_account", [])?;
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn session_restore_blocked(&self) -> Result<bool, SyncError> {
        Ok(self.open()?.query_row(
            "SELECT blocked FROM session_restore_policy WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?)
    }

    pub fn account(&self) -> Result<Option<CloudAccount>, SyncError> {
        self.open()?
            .query_row(
                "SELECT payload_json FROM cloud_account WHERE singleton = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|payload| {
                serde_json::from_str(&payload).map_err(|error| {
                    SyncError::InvalidState(format!("invalid stored cloud account: {error}"))
                })
            })
            .transpose()
    }
}

fn clear_path_sync_state(transaction: &rusqlite::Transaction<'_>) -> Result<(), SyncError> {
    transaction.execute_batch(
        r#"
        DELETE FROM path_notebooks;
        DELETE FROM v4_path_state;
        DELETE FROM v4_dir_scan;
        DELETE FROM v4_notebook_state;
        DELETE FROM v4_directory_state;
        DELETE FROM v4_pending_stamp;
        "#,
    )?;
    Ok(())
}
