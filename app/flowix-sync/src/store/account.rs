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
            CREATE TABLE IF NOT EXISTS cloud_sync_owner (
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                user_id TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS cloud_notebook_preferences (
                user_id TEXT NOT NULL,
                notebook_id TEXT NOT NULL,
                enabled INTEGER NOT NULL,
                needs_initial_upload INTEGER NOT NULL DEFAULT 0,
                name TEXT NOT NULL,
                icon TEXT,
                sort_order INTEGER NOT NULL,
                PRIMARY KEY (user_id, notebook_id)
            );
            CREATE TABLE IF NOT EXISTS cloud_account (
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                user_id TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            "#,
        )?;
        // Older installations stored the user ID only in payload_json. Run the
        // check and upgrade under one write transaction so concurrent app
        // processes cannot both attempt the ALTER, and a failed backfill leaves
        // the original database intact.
        let transaction = rusqlite::Transaction::new_unchecked(
            connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let has_user_id = {
            let mut columns = transaction.prepare("PRAGMA table_info(cloud_account)")?;
            let names = columns.query_map([], |row| row.get::<_, String>(1))?;
            names
                .collect::<Result<Vec<_>, _>>()?
                .iter()
                .any(|name| name == "user_id")
        };
        if !has_user_id {
            let payload = transaction
                .query_row(
                    "SELECT payload_json FROM cloud_account WHERE singleton = 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let user_id = payload
                .as_deref()
                .map(|payload| {
                    let account: CloudAccount = serde_json::from_str(payload).map_err(|error| {
                        SyncError::InvalidState(format!("migrate stored cloud account: {error}"))
                    })?;
                    if account.user.id.is_empty() {
                        return Err(SyncError::InvalidState(
                            "migrate stored cloud account: missing user ID".into(),
                        ));
                    }
                    Ok(account.user.id)
                })
                .transpose()?;
            transaction.execute_batch(
                "ALTER TABLE cloud_account ADD COLUMN user_id TEXT NOT NULL DEFAULT '';",
            )?;
            if let Some(user_id) = user_id {
                transaction.execute(
                    "UPDATE cloud_account SET user_id = ? WHERE singleton = 1",
                    [user_id],
                )?;
            }
        }
        let has_initial_upload = {
            let mut columns =
                transaction.prepare("PRAGMA table_info(cloud_notebook_preferences)")?;
            let names = columns.query_map([], |row| row.get::<_, String>(1))?;
            names
                .collect::<Result<Vec<_>, _>>()?
                .iter()
                .any(|name| name == "needs_initial_upload")
        };
        if !has_initial_upload {
            transaction.execute("ALTER TABLE cloud_notebook_preferences ADD COLUMN needs_initial_upload INTEGER NOT NULL DEFAULT 0", [])?;
        }
        transaction.commit()?;
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
        let state_owner: Option<String> = transaction
            .query_row(
                "SELECT user_id FROM cloud_sync_owner WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let custom_remote: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_remote_binding)", [], |row| row.get(0),
        )?;
        if !custom_remote && previous_user
            .as_deref()
            .or(state_owner.as_deref())
            .is_some_and(|user_id| user_id != account.user.id)
        {
            save_notebook_preferences(&transaction)?;
            clear_path_sync_state(&transaction)?;
        }
        // Bind the retained sync baselines to the account that created them.
        // Custom S3 state belongs to its own target, not to a Cloud account.
        transaction.execute(
            "INSERT INTO cloud_sync_owner(singleton, user_id) SELECT 1, ?1 WHERE NOT EXISTS (SELECT 1 FROM sync_remote_binding) ON CONFLICT(singleton) DO UPDATE SET user_id = excluded.user_id",
            params![account.user.id],
        )?;
        // Restore disabled choices and explicit first uploads. Previously
        // published notebooks are recovered only after remote verification.
        transaction.execute(
            r#"INSERT OR IGNORE INTO path_notebooks
               (notebook_id, enabled, name, icon, sort_order, manifest_uploaded, generation, pending_action, updated_at)
               SELECT notebook_id, enabled, name, icon, sort_order, 0, 1,
                      CASE WHEN enabled = 1 THEN 'put' ELSE NULL END, ?2
               FROM cloud_notebook_preferences
               WHERE user_id = ?1 AND (enabled = 0 OR needs_initial_upload = 1) AND NOT EXISTS (SELECT 1 FROM sync_remote_binding)"#,
            params![account.user.id, now],
        )?;
        transaction.execute(
            "DELETE FROM cloud_notebook_preferences WHERE user_id = ?1 AND (enabled = 0 OR needs_initial_upload = 1) AND NOT EXISTS (SELECT 1 FROM sync_remote_binding)",
            params![account.user.id],
        )?;
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
        self.clear_account_with_preferences(true)
    }

    pub(crate) fn clear_account_with_preferences(
        &self,
        preserve_preferences: bool,
    ) -> Result<(), SyncError> {
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "UPDATE session_restore_policy SET blocked = 1 WHERE singleton = 1",
            [],
        )?;
        // Retain sync state only for the same official-cloud account. Neither
        // credentials nor deleted-account state are retained.
        if !preserve_preferences {
            transaction.execute(
                "DELETE FROM cloud_notebook_preferences WHERE user_id = (SELECT user_id FROM cloud_account WHERE singleton = 1)",
                [],
            )?;
        }
        if preserve_preferences {
            save_notebook_preferences(&transaction)?;
        }
        let retain_baselines: bool = preserve_preferences && transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM cloud_account) AND NOT EXISTS(SELECT 1 FROM sync_remote_binding)",
            [], |row| row.get(0),
        )?;
        let custom_remote: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_remote_binding)", [], |row| row.get(0),
        )?;
        if !retain_baselines && !custom_remote {
            clear_path_sync_state(&transaction)?;
            transaction.execute("DELETE FROM cloud_sync_owner", [])?;
        }
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

fn save_notebook_preferences(transaction: &rusqlite::Transaction<'_>) -> Result<(), SyncError> {
    transaction.execute(
        r#"INSERT INTO cloud_notebook_preferences (user_id, notebook_id, enabled, needs_initial_upload, name, icon, sort_order)
           SELECT account.user_id, notebook.notebook_id, notebook.enabled,
                  CASE WHEN notebook.enabled = 1 AND notebook.manifest_uploaded = 0 AND notebook.pending_action = 'put' THEN 1 ELSE 0 END,
                  notebook.name, notebook.icon, notebook.sort_order
           FROM cloud_account AS account CROSS JOIN path_notebooks AS notebook
           WHERE account.singleton = 1 AND NOT EXISTS (SELECT 1 FROM sync_remote_binding)
             AND (notebook.pending_action IS NULL OR notebook.pending_action != 'delete')
           ON CONFLICT(user_id, notebook_id) DO UPDATE SET enabled=excluded.enabled,
             needs_initial_upload=excluded.needs_initial_upload, name=excluded.name, icon=excluded.icon, sort_order=excluded.sort_order"#,
        [],
    )?;
    Ok(())
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
        DELETE FROM v4_pending_proxy_delete;
        "#,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{state_after_transfer, PathNotebookMetadata, PendingNotebookAction};

    fn account(id: &str) -> CloudAccount {
        serde_json::from_value(serde_json::json!({
            "user": { "id": id, "email": "test@example.com", "displayName": "Test" }
        }))
        .unwrap()
    }

    fn notebook(id: &str) -> PathNotebookMetadata {
        PathNotebookMetadata {
            id: id.into(),
            name: id.into(),
            icon: None,
            sort_order: 0,
        }
    }

    #[test]
    fn logout_restores_only_the_same_accounts_notebook_choices() {
        let temp = tempfile::tempdir().unwrap();
        let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
        store.save_account(&account("first")).unwrap();
        store.set_path_notebook(&notebook("enabled"), true).unwrap();
        store
            .ack_path_notebook_change("enabled", 1, PendingNotebookAction::Put)
            .unwrap();
        store
            .set_path_notebook(&notebook("disabled"), false)
            .unwrap();
        store.clear_account().unwrap();
        assert!(store.path_notebook("enabled").unwrap().unwrap().enabled);
        store.save_account(&account("second")).unwrap();
        assert!(store.path_notebook("enabled").unwrap().is_none());
        store.clear_account().unwrap();
        store.save_account(&account("first")).unwrap();
        assert!(store.path_notebook("enabled").unwrap().is_none());
        assert!(!store.path_notebook("disabled").unwrap().unwrap().enabled);
        assert!(store
            .restore_remote_notebook(&notebook("enabled"), "first")
            .unwrap());
        assert!(store.path_notebook("enabled").unwrap().unwrap().enabled);
        assert!(!store
            .restore_remote_notebook(&notebook("disabled"), "first")
            .unwrap());
        assert!(!store.path_notebook("disabled").unwrap().unwrap().enabled);
        assert!(store.pending_path_notebook_changes().unwrap().is_empty());
    }

    #[test]
    fn account_switch_preserves_disabled_and_unverified_choices() {
        let temp = tempfile::tempdir().unwrap();
        let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
        store.save_account(&account("first")).unwrap();
        store.set_path_notebook(&notebook("enabled"), true).unwrap();
        store
            .ack_path_notebook_change("enabled", 1, PendingNotebookAction::Put)
            .unwrap();
        store
            .set_path_notebook(&notebook("disabled"), false)
            .unwrap();
        store.save_account(&account("second")).unwrap();
        store.save_account(&account("first")).unwrap();
        assert!(!store.path_notebook("disabled").unwrap().unwrap().enabled);
        // A second logout before the remote listing completes must retain the
        // pending preference, so it can still be recovered at the next login.
        store.clear_account().unwrap();
        store.save_account(&account("first")).unwrap();
        assert!(store
            .restore_remote_notebook(&notebook("enabled"), "first")
            .unwrap());
        assert!(!store
            .restore_remote_notebook(&notebook("disabled"), "first")
            .unwrap());
    }

    #[test]
    fn existing_preferences_schema_migrates_without_losing_choices() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("sync.db");
        let connection = Connection::open(&db).unwrap();
        connection.execute_batch(
            "CREATE TABLE cloud_notebook_preferences (user_id TEXT NOT NULL, notebook_id TEXT NOT NULL, enabled INTEGER NOT NULL, name TEXT NOT NULL, icon TEXT, sort_order INTEGER NOT NULL, PRIMARY KEY(user_id, notebook_id));
             INSERT INTO cloud_notebook_preferences VALUES ('first', 'disabled', 0, 'disabled', NULL, 0);",
        ).unwrap();
        drop(connection);
        let store = SyncStore::new(&db).unwrap();
        store.save_account(&account("first")).unwrap();
        assert!(!store.path_notebook("disabled").unwrap().unwrap().enabled);
    }

    #[test]
    fn same_account_logout_keeps_baselines_and_pending_initial_upload() {
        let temp = tempfile::tempdir().unwrap();
        let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
        store.save_account(&account("first")).unwrap();
        store.set_path_notebook(&notebook("enabled"), true).unwrap();
        let path = state_after_transfer(
            "notes/a.md",
            "notes/a.md",
            "sha256:aa",
            10,
            1000,
            2000,
            Some("old-etag".into()),
        );
        store.save_path_states("enabled", &[path.clone()]).unwrap();
        store
            .queue_proxy_deletions("enabled", &["notes/deleted.md".into()])
            .unwrap();
        store.clear_account().unwrap();
        store.save_account(&account("first")).unwrap();
        assert_eq!(
            store.snapshot("enabled").unwrap().states.get("notes/a.md"),
            Some(&path)
        );
        assert_eq!(
            store.pending_path_notebook_changes().unwrap()[0].action,
            PendingNotebookAction::Put
        );
        store.clear_account().unwrap();
        store.save_account(&account("second")).unwrap();
        assert!(store.snapshot("enabled").unwrap().states.is_empty());
        assert!(store.pending_proxy_deletions("enabled").unwrap().is_empty());
        assert!(store.path_notebook("enabled").unwrap().is_none());
        store.save_account(&account("first")).unwrap();
        assert_eq!(
            store.pending_path_notebook_changes().unwrap()[0].action,
            PendingNotebookAction::Put
        );
    }

    #[test]
    fn deleting_account_does_not_restore_notebook_choices() {
        let temp = tempfile::tempdir().unwrap();
        let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
        store.save_account(&account("first")).unwrap();
        store.set_path_notebook(&notebook("enabled"), true).unwrap();
        store.clear_account_with_preferences(false).unwrap();
        store.save_account(&account("first")).unwrap();
        assert!(store.path_notebook("enabled").unwrap().is_none());
    }

    #[test]
    fn account_changes_do_not_clear_custom_remote_state() {
        let temp = tempfile::tempdir().unwrap();
        let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
        store.bind_remote_target("custom-target").unwrap();
        store.set_path_notebook(&notebook("s3"), true).unwrap();
        let path = state_after_transfer("a.md", "a.md", "sha256:aa", 1, 2, 3, None);
        store.save_path_states("s3", &[path.clone()]).unwrap();
        store.save_account(&account("first")).unwrap();
        store.save_account(&account("second")).unwrap();
        store.clear_account().unwrap();
        assert!(store.path_notebook("s3").unwrap().unwrap().enabled);
        assert_eq!(store.snapshot("s3").unwrap().states.get("a.md"), Some(&path));
    }
}
