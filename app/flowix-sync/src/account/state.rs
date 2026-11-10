use super::*;

impl AccountService {
    /// Creates an in-memory session without persistent credentials or notifications.
    pub fn new(api_base: &str, database_path: impl AsRef<Path>) -> Result<Self, SyncError> {
        Self::create(api_base, database_path, None, Arc::new(|_| {}))
    }

    /// Creates a persistent session without state notifications (for headless callers).
    pub fn new_with_token_store(
        api_base: &str,
        database_path: impl AsRef<Path>,
        token_store: Arc<dyn RefreshTokenStore>,
    ) -> Result<Self, SyncError> {
        Self::create(api_base, database_path, Some(token_store), Arc::new(|_| {}))
    }

    /// Creates a persistent session manager with notifications wired before any transitions.
    pub fn new_with_session_dependencies(
        api_base: &str,
        database_path: impl AsRef<Path>,
        token_store: Arc<dyn RefreshTokenStore>,
        state_notifier: Arc<dyn Fn(CloudState) + Send + Sync>,
    ) -> Result<Self, SyncError> {
        Self::create(api_base, database_path, Some(token_store), state_notifier)
    }

    /// Desktop startup variant: defer database migrations and credential
    /// restoration to the initialization worker.
    pub fn new_with_session_dependencies_deferred(
        api_base: &str,
        database_path: impl AsRef<Path>,
        token_store: Arc<dyn RefreshTokenStore>,
        state_notifier: Arc<dyn Fn(CloudState) + Send + Sync>,
    ) -> Result<Self, SyncError> {
        Self::create_deferred(api_base, database_path, Some(token_store), state_notifier)
    }

    fn create(
        api_base: &str,
        database_path: impl AsRef<Path>,
        token_store: Option<Arc<dyn RefreshTokenStore>>,
        state_notifier: Arc<dyn Fn(CloudState) + Send + Sync>,
    ) -> Result<Self, SyncError> {
        let sync_store = SyncStore::new(database_path)?;
        let credential_retry = Arc::new(tokio::sync::Notify::new());
        let manager = Self {
            client: CloudClient::new(api_base)?,
            store: sync_store,
            auth: Arc::new(RwLock::new(AuthState::default())),
            account_entitlement: Arc::new(RwLock::new(AccountEntitlementState::default())),
            membership_refresh: Arc::new(tokio::sync::Mutex::new(None)),
            refresh_lock: Arc::new(tokio::sync::Mutex::new(())),
            auth_generation: Arc::new(std::sync::Mutex::new(0)),
            refresh_token_store: token_store,
            credential_retry,
            entitlement_retry: Arc::new(tokio::sync::Notify::new()),
            state_notifier,
        };
        manager.initialize_storage()?;
        Ok(manager)
    }

    fn create_deferred(
        api_base: &str,
        database_path: impl AsRef<Path>,
        token_store: Option<Arc<dyn RefreshTokenStore>>,
        state_notifier: Arc<dyn Fn(CloudState) + Send + Sync>,
    ) -> Result<Self, SyncError> {
        let mut auth = AuthState::default();
        if token_store.is_some() {
            auth.status = CloudAuthStatus::Restoring;
        }
        Ok(Self {
            client: CloudClient::new(api_base)?,
            store: SyncStore::new_uninitialized(database_path),
            auth: Arc::new(RwLock::new(auth)),
            account_entitlement: Arc::new(RwLock::new(AccountEntitlementState::default())),
            membership_refresh: Arc::new(tokio::sync::Mutex::new(None)),
            refresh_lock: Arc::new(tokio::sync::Mutex::new(())),
            auth_generation: Arc::new(std::sync::Mutex::new(0)),
            refresh_token_store: token_store,
            credential_retry: Arc::new(tokio::sync::Notify::new()),
            entitlement_retry: Arc::new(tokio::sync::Notify::new()),
            state_notifier,
        })
    }

    pub fn initialize_storage(&self) -> Result<(), SyncError> {
        self.store.initialize_schema()?;
        let restore_blocked = self.store.session_restore_blocked()?;
        let Some(token_store) = self.refresh_token_store.as_ref() else {
            return Ok(());
        };
        // Reading the OS credential store may block. Do not hold the auth lock,
        // and never overwrite login/logout that happened after the shell opened.
        if self.auth_generation() != 0 {
            return Ok(());
        }
        let token = if restore_blocked {
            Ok(None)
        } else {
            token_store.load()
        };
        let Ok(generation_guard) = self.require_auth_generation(0) else {
            return Ok(());
        };
        let mut auth = self.auth.write().unwrap_or_else(|p| p.into_inner());
        if auth.session.is_none() {
            let previous = (auth.status, auth.error.clone());
            auth.error = None;
            if restore_blocked {
                auth.status = CloudAuthStatus::SignedOut;
                auth.pending_credential = Some(CredentialWrite::Delete);
                self.credential_retry.notify_one();
            } else {
                match token {
                    Ok(Some(_)) => auth.status = CloudAuthStatus::Restoring,
                    Ok(None) => auth.status = CloudAuthStatus::SignedOut,
                    Err(error) => {
                        auth.status = CloudAuthStatus::Restoring;
                        auth.error = Some(error);
                    }
                }
            }
            // The deferred initial snapshot can still be in flight when the
            // background result is emitted. Give a changed result a newer revision.
            if previous != (auth.status, auth.error.clone()) {
                auth.revision = auth.revision.saturating_add(1);
            }
        }
        drop(auth);
        drop(generation_guard);
        Ok(())
    }

    pub(crate) fn store(&self) -> &SyncStore {
        &self.store
    }

    pub fn state(&self) -> Result<CloudState, SyncError> {
        let auth = self.auth.read().unwrap_or_else(|p| p.into_inner());
        let entitlement = self
            .account_entitlement
            .read()
            .unwrap_or_else(|p| p.into_inner());
        Ok(CloudState {
            revision: auth.revision,
            authenticated: auth.session.is_some(),
            auth_status: if auth.session.is_some() {
                CloudAuthStatus::Authenticated
            } else {
                auth.status
            },
            auth_error: auth.error.clone().or_else(|| auth.credential_error.clone()),
            account: self.store.v2_account()?,
            membership: entitlement.membership.clone(),
            membership_status: entitlement.status,
            membership_error: entitlement.error.clone(),
            sync_access: CloudSyncAccess::resolve(
                auth.session.is_some(),
                entitlement.status,
                entitlement.membership.as_ref(),
                chrono::Utc::now().timestamp_millis(),
            ),
            restored: auth.restored,
        })
    }

    pub fn sync_access(&self) -> CloudSyncAccess {
        let auth = self.auth.read().unwrap_or_else(|p| p.into_inner());
        let entitlement = self
            .account_entitlement
            .read()
            .unwrap_or_else(|p| p.into_inner());
        CloudSyncAccess::resolve(
            auth.session.is_some(),
            entitlement.status,
            entitlement.membership.as_ref(),
            chrono::Utc::now().timestamp_millis(),
        )
    }

    /// Sync stops only when the account identity or its entitlement cannot be
    /// established. A lapsed plan still reads and deletes, so this returns `Ok`.
    pub fn require_sync_access(&self) -> Result<CloudSyncAccess, SyncError> {
        let access = self.sync_access();
        if access.can_read {
            return Ok(access);
        }
        if access.restriction == Some(CloudSyncRestriction::SignedOut) {
            return Err(SyncError::NotAuthenticated);
        }
        Err(SyncError::Api {
            status: 402,
            code: "MEMBERSHIP_REQUIRED".into(),
            message: "Cloud access could not be verified for this account".into(),
            details: Some(serde_json::json!({ "restriction": access.restriction })),
        })
    }
}

#[cfg(test)]
mod deferred_startup_tests {
    use super::*;
    use crate::SyncManager;
    use std::sync::{mpsc, Mutex};
    use std::time::Duration;

    struct DelayedTokenStore {
        entered: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }
    impl RefreshTokenStore for DelayedTokenStore {
        fn load(&self) -> Result<Option<String>, String> {
            self.entered.send(()).unwrap();
            self.release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(3))
                .unwrap();
            Ok(Some("old-session".into()))
        }
        fn save(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn delete(&self) -> Result<(), String> {
            Ok(())
        }
    }

    struct EmptyTokenStore;
    impl RefreshTokenStore for EmptyTokenStore {
        fn load(&self) -> Result<Option<String>, String> {
            Ok(None)
        }
        fn save(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn delete(&self) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn deferred_credential_result_has_a_newer_revision_than_initial_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let manager = SyncManager::new_with_session_dependencies_deferred(
            "http://127.0.0.1:1",
            temp.path().join("sync.db"),
            Arc::new(EmptyTokenStore),
            Arc::new(|_| {}),
        )
        .unwrap();
        let before = manager.state().unwrap();
        assert_eq!(before.auth_status, CloudAuthStatus::Restoring);
        manager.initialize_storage().unwrap();
        let after = manager.state().unwrap();
        assert_eq!(after.auth_status, CloudAuthStatus::SignedOut);
        assert!(after.revision > before.revision);
        manager.initialize_storage().unwrap();
        assert_eq!(manager.state().unwrap().revision, after.revision);
    }

    #[tokio::test]
    async fn delayed_startup_credentials_cannot_overwrite_explicit_logout() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("sync.db");
        let (entered, started) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let manager = Arc::new(
            SyncManager::new_with_session_dependencies_deferred(
                "http://127.0.0.1:1",
                &path,
                Arc::new(DelayedTokenStore {
                    entered,
                    release: Mutex::new(wait),
                }),
                Arc::new(|_| {}),
            )
            .unwrap(),
        );
        assert!(!path.exists());
        assert!(started.try_recv().is_err());
        let worker_manager = manager.clone();
        let worker = std::thread::spawn(move || worker_manager.initialize_storage());
        started.recv_timeout(Duration::from_secs(3)).unwrap();
        manager.logout().await.unwrap();
        release.send(()).unwrap();
        worker.join().unwrap().unwrap();
        assert_eq!(
            manager.state().unwrap().auth_status,
            CloudAuthStatus::SignedOut
        );
    }
}
