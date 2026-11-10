use super::*;

impl AccountService {
    pub async fn register(
        &self,
        email: &str,
        password: &str,
        display_name: &str,
    ) -> Result<CloudState, SyncError> {
        let generation = self.begin_auth_attempt();
        let auth = self.client.register(email, password, display_name).await?;
        self.accept_auth(
            generation,
            V2CloudAccount {
                user: auth.user,
                protocol_epoch: crate::v2::PROTOCOL_EPOCH,
            },
            auth.session.into(),
            false,
        )
    }

    pub async fn login(&self, email: &str, password: &str) -> Result<CloudState, SyncError> {
        self.login_with_restore(email, password, false).await
    }

    /// Sign in, optionally reviving an account that is still inside its
    /// deletion grace window.
    ///
    /// The server answers a plain login on a deleted account with
    /// `410 ACCOUNT_DELETED_RESTORABLE` and the deadline; the caller shows that
    /// to the user and repeats the request with `restore_deleted` once the user
    /// agrees. Credentials are verified on both requests — the flag only says
    /// what to do *after* authentication succeeds, it is not a way in.
    pub async fn login_with_restore(
        &self,
        email: &str,
        password: &str,
        restore_deleted: bool,
    ) -> Result<CloudState, SyncError> {
        let generation = self.begin_auth_attempt();
        let auth = self
            .client
            .login(email, password, restore_deleted)
            .await?;
        self.accept_auth(
            generation,
            V2CloudAccount {
                user: auth.user,
                protocol_epoch: crate::v2::PROTOCOL_EPOCH,
            },
            auth.session.into(),
            auth.restored,
        )
    }

    pub async fn apple_challenge(&self) -> Result<AppleAuthChallenge, SyncError> {
        self.client.apple_challenge().await
    }

    pub async fn sign_in_with_apple(
        &self,
        authorization: &AppleAuthorization,
    ) -> Result<CloudState, SyncError> {
        let generation = self.begin_auth_attempt();
        let auth = self.client.apple_exchange(authorization).await?;
        self.accept_auth(
            generation,
            V2CloudAccount {
                user: auth.user,
                protocol_epoch: crate::v2::PROTOCOL_EPOCH,
            },
            auth.session.into(),
            auth.restored,
        )
    }

    /// Starts an external login; later authentication actions supersede its callback.
    pub fn begin_google_sign_in(&self) -> u64 {
        self.begin_auth_attempt()
    }

    pub async fn sign_in_with_google_desktop(
        &self,
        code: &str,
        state: &str,
        code_verifier: &str,
        generation: u64,
    ) -> Result<CloudState, SyncError> {
        drop(self.require_auth_generation(generation)?);
        let auth = self
            .client
            .google_desktop_exchange(code, state, code_verifier)
            .await?;
        self.accept_auth(
            generation,
            V2CloudAccount {
                user: auth.user,
                protocol_epoch: crate::v2::PROTOCOL_EPOCH,
            },
            auth.session.into(),
            auth.restored,
        )
    }

    pub async fn link_apple(
        &self,
        authorization: &AppleAuthorization,
    ) -> Result<CloudState, SyncError> {
        let generation = self.auth_generation();
        let access_token = self.access_token(generation).await?;
        let first = self.client.apple_link(&access_token, authorization).await;
        if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token(generation).await?;
            self.client.apple_link(&refreshed, authorization).await?;
        } else {
            first?;
        }
        let _generation = self.require_auth_generation(generation)?;
        self.state()
    }

    pub fn session_generation(&self) -> u64 {
        self.auth_generation()
    }

    pub(crate) async fn restore_at_generation(
        &self,
        refresh_token: &str,
        generation: u64,
    ) -> Result<CloudState, SyncError> {
        {
            let _generation = self.require_auth_generation(generation)?;
            if self
                .auth
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .session
                .is_some()
            {
                return Err(SyncError::NotAuthenticated);
            }
        }
        let account = self.store.v2_account()?;
        let refreshed = match self.client.refresh(refresh_token).await {
            Ok(refreshed) => refreshed,
            Err(error) if error.is_invalid_refresh_token() => {
                let (_, cleanup) = self.clear_auth_at_generation(generation, || {
                    self.delete_persisted_refresh_token()
                })?;
                if let Err(cleanup_error) = cleanup {
                    tracing::warn!("failed to remove invalid cloud refresh token: {cleanup_error}");
                }
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        let runtime: RuntimeSession = refreshed.session.into();
        // Preserve rotation before any fallible account metadata work.
        {
            let _generation = self.require_auth_generation(generation)?;
            let mut auth = self.auth.write().unwrap_or_else(|p| p.into_inner());
            self.persist_auth_token(&mut auth, &runtime.refresh_token);
        }
        let account = match account {
            Some(account) => account,
            None => V2CloudAccount {
                user: self.client.me(&runtime.access_token).await?.user,
                protocol_epoch: crate::v2::PROTOCOL_EPOCH,
            },
        };
        self.accept_auth(generation, account, runtime, false)
    }

    fn accept_auth(
        &self,
        generation: u64,
        account: V2CloudAccount,
        runtime: RuntimeSession,
        restored: bool,
    ) -> Result<CloudState, SyncError> {
        self.install_authenticated_session(generation, account, runtime, restored)?;
        self.state()
    }

    pub(crate) fn install_authenticated_session(
        &self,
        generation: u64,
        account: V2CloudAccount,
        runtime: RuntimeSession,
        restored: bool,
    ) -> Result<u64, SyncError> {
        let mut current_generation = self.require_auth_generation(generation)?;
        let mut auth = self.auth.write().unwrap_or_else(|p| p.into_inner());
        self.store.save_v2_account(&account)?;
        self.persist_auth_token(&mut auth, &runtime.refresh_token);
        auth.error = None;
        auth.session = Some(runtime);
        auth.restored = restored;
        *self
            .account_entitlement
            .write()
            .unwrap_or_else(|p| p.into_inner()) = AccountEntitlementState::default();
        auth.status = CloudAuthStatus::Authenticated;
        auth.revision = auth.revision.saturating_add(1);
        *current_generation = current_generation.saturating_add(1);
        let next_generation = *current_generation;
        drop(auth);
        drop(current_generation);
        self.notify_state_change();
        self.entitlement_retry.notify_one();
        Ok(next_generation)
    }

    /// Clear local authentication immediately and return a handle for remote revocation.
    pub fn begin_logout(&self) -> PendingLogout {
        let (refresh_token, local_cleanup) =
            self.clear_auth_with_cleanup(|| self.delete_persisted_refresh_token());
        PendingLogout {
            refresh_token,
            local_cleanup,
        }
    }

    /// Revoke a session after its local state and dependent UI have been cleared.
    pub async fn finish_logout(&self, pending: PendingLogout) -> Result<(), SyncError> {
        let remote_logout = if let Some(refresh_token) = pending.refresh_token {
            self.client.logout_with_refresh_token(&refresh_token).await
        } else {
            Ok(())
        };
        if let Err(error) = pending.local_cleanup {
            if let Err(remote_error) = remote_logout {
                tracing::warn!(
                    "failed to revoke Flowix Cloud session during local logout: {remote_error}"
                );
            }
            return Err(error);
        }
        remote_logout
    }

    pub async fn logout(&self) -> Result<(), SyncError> {
        self.finish_logout(self.begin_logout()).await
    }

    fn clear_auth_with_cleanup(
        &self,
        cleanup: impl FnOnce() -> Result<(), SyncError>,
    ) -> (Option<String>, Result<(), SyncError>) {
        self.clear_auth_inner(None, cleanup)
            .expect("unconditional logout cannot be superseded")
    }

    pub(super) fn clear_auth_at_generation(
        &self,
        expected_generation: u64,
        cleanup: impl FnOnce() -> Result<(), SyncError>,
    ) -> Result<(Option<String>, Result<(), SyncError>), SyncError> {
        self.clear_auth_inner(Some(expected_generation), cleanup)
    }

    fn clear_auth_inner(
        &self,
        expected_generation: Option<u64>,
        cleanup: impl FnOnce() -> Result<(), SyncError>,
    ) -> Result<(Option<String>, Result<(), SyncError>), SyncError> {
        let mut generation = self
            .auth_generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if expected_generation.is_some_and(|expected| *generation != expected) {
            return Err(SyncError::NotAuthenticated);
        }
        *generation = generation.saturating_add(1);
        let mut auth = self.auth.write().unwrap_or_else(|p| p.into_inner());
        let token = auth.session.take().map(|session| session.refresh_token);
        *self
            .account_entitlement
            .write()
            .unwrap_or_else(|p| p.into_inner()) = AccountEntitlementState::default();
        auth.pending_credential = None;
        auth.status = CloudAuthStatus::SignedOut;
        auth.restored = false;
        auth.revision = auth.revision.saturating_add(1);
        let account_result = self.store.clear_v2_account();
        let cleanup_result = cleanup();
        if cleanup_result.is_err() {
            auth.pending_credential = Some(CredentialWrite::Delete);
            self.credential_retry.notify_one();
        }
        auth.error = account_result.as_ref().err().map(ToString::to_string);
        auth.credential_error = cleanup_result.as_ref().err().map(ToString::to_string);
        drop(auth);
        drop(generation);
        self.notify_state_change();
        Ok((token, account_result.and(cleanup_result)))
    }

    fn begin_auth_attempt(&self) -> u64 {
        let mut generation = self
            .auth_generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *generation = generation.saturating_add(1);
        let next = *generation;
        let mut auth = self.auth.write().unwrap_or_else(|p| p.into_inner());
        let changed = auth.status == CloudAuthStatus::Restoring;
        if changed {
            auth.status = CloudAuthStatus::SignedOut;
            auth.error = None;
            auth.revision = auth.revision.saturating_add(1);
        }
        drop(auth);
        drop(generation);
        if changed {
            self.notify_state_change();
        }
        next
    }

    pub(crate) fn auth_generation(&self) -> u64 {
        *self
            .auth_generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn require_auth_generation(
        &self,
        expected: u64,
    ) -> Result<std::sync::MutexGuard<'_, u64>, SyncError> {
        let generation = self
            .auth_generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *generation != expected {
            return Err(SyncError::NotAuthenticated);
        }
        Ok(generation)
    }

    fn install_refreshed_session(
        &self,
        generation: u64,
        expected_refresh_token: &str,
        next: RuntimeSession,
    ) -> Result<String, SyncError> {
        let guard = self.require_auth_generation(generation)?;
        let mut auth = self.auth.write().unwrap_or_else(|p| p.into_inner());
        if !auth
            .session
            .as_ref()
            .is_some_and(|session| session.refresh_token == expected_refresh_token)
        {
            return Err(SyncError::NotAuthenticated);
        }
        let access_token = next.access_token.clone();
        self.persist_auth_token(&mut auth, &next.refresh_token);
        auth.session = Some(next);
        auth.revision = auth.revision.saturating_add(1);
        drop(auth);
        drop(guard);
        self.notify_state_change();
        Ok(access_token)
    }

    fn session_for_generation(&self, generation: u64) -> Result<RuntimeSession, SyncError> {
        let _guard = self.require_auth_generation(generation)?;
        self.auth
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .session
            .clone()
            .ok_or(SyncError::NotAuthenticated)
    }

    pub(crate) async fn access_token(&self, generation: u64) -> Result<String, SyncError> {
        let current = self.session_for_generation(generation)?;
        let now = chrono::Utc::now().timestamp_millis();
        if current.access_token_expires_at > now + 30_000 {
            return Ok(current.access_token);
        }
        if current.refresh_token_expires_at <= now {
            let (_, cleanup) = self
                .clear_auth_at_generation(generation, || self.delete_persisted_refresh_token())?;
            if let Err(error) = cleanup {
                tracing::warn!("failed to remove expired cloud refresh token: {error}");
            }
            return Err(SyncError::NotAuthenticated);
        }
        self.refresh_access_token(&current.access_token, generation)
            .await
    }

    pub(crate) async fn force_refresh_access_token(
        &self,
        generation: u64,
    ) -> Result<String, SyncError> {
        let stale_access_token = self.session_for_generation(generation)?.access_token;
        self.refresh_access_token(&stale_access_token, generation)
            .await
    }

    async fn refresh_access_token(
        &self,
        stale_access_token: &str,
        generation: u64,
    ) -> Result<String, SyncError> {
        let _guard = self.refresh_lock.lock().await;
        let current = self.session_for_generation(generation)?;
        // Another concurrent request already rotated this session while we
        // were waiting for the lock; reuse its result instead of rotating the
        // new refresh token a second time.
        if current.access_token != stale_access_token {
            return Ok(current.access_token);
        }
        if current.refresh_token_expires_at <= chrono::Utc::now().timestamp_millis() {
            let (_, cleanup) = self
                .clear_auth_at_generation(generation, || self.delete_persisted_refresh_token())?;
            cleanup?;
            return Err(SyncError::NotAuthenticated);
        }
        let refreshed = match self.client.refresh(&current.refresh_token).await {
            Ok(refreshed) => refreshed,
            Err(error) if error.is_invalid_refresh_token() => {
                let (_, cleanup) = self.clear_auth_at_generation(generation, || {
                    self.delete_persisted_refresh_token()
                })?;
                if let Err(cleanup_error) = cleanup {
                    tracing::warn!("failed to remove invalid cloud refresh token: {cleanup_error}");
                }
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        self.install_refreshed_session(generation, &current.refresh_token, refreshed.session.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SyncManager, V2AccountSyncReport};
    use std::future::Future;

    struct NoopWake;
    impl std::task::Wake for NoopWake {
        fn wake(self: std::sync::Arc<Self>) {}
    }

    fn ready<Output>(future: impl std::future::Future<Output = Output>) -> Output {
        let waker = std::task::Waker::from(std::sync::Arc::new(NoopWake));
        let mut context = std::task::Context::from_waker(&waker);
        match std::pin::pin!(future).as_mut().poll(&mut context) {
            std::task::Poll::Ready(output) => output,
            std::task::Poll::Pending => panic!("operation unexpectedly waited"),
        }
    }

    fn sign_in(manager: &SyncManager, token: &str) -> u64 {
        let generation = manager.account().begin_auth_attempt();
        manager
            .account()
            .install_authenticated_session(
                generation,
                V2CloudAccount {
                    user: crate::models::CloudUser {
                        id: token.into(),
                        email: "test@example.test".into(),
                        display_name: "Test".into(),
                        region: "non_mainland".into(),
                    },
                    protocol_epoch: crate::v2::PROTOCOL_EPOCH,
                },
                runtime(token),
                false,
            )
            .unwrap()
    }

    #[test]
    fn old_requests_cannot_borrow_another_accounts_token() {
        let directory = tempfile::tempdir().unwrap();
        let manager = SyncManager::new(
            "https://cloud.example.test",
            directory.path().join("sync.db"),
        )
        .unwrap();
        let first = sign_in(&manager, "first");
        assert_eq!(
            ready(manager.account().access_token(first)).unwrap(),
            "access-first"
        );
        let second = sign_in(&manager, "second");
        assert!(ready(manager.account().access_token(first)).is_err());
        assert!(ready(manager.account().force_refresh_access_token(first)).is_err());
        assert_eq!(
            ready(manager.account().access_token(second)).unwrap(),
            "access-second"
        );
    }

    #[test]
    fn same_session_rotation_can_reuse_the_new_access_token() {
        let directory = tempfile::tempdir().unwrap();
        let manager = SyncManager::new(
            "https://cloud.example.test",
            directory.path().join("sync.db"),
        )
        .unwrap();
        let generation = sign_in(&manager, "first");
        manager
            .account()
            .install_refreshed_session(generation, "first", runtime("rotated"))
            .unwrap();
        assert_eq!(
            ready(
                manager
                    .account()
                    .refresh_access_token("access-first", generation)
            )
            .unwrap(),
            "access-rotated"
        );
    }

    #[test]
    fn accepted_login_invalidates_requests_started_during_authentication() {
        let directory = tempfile::tempdir().unwrap();
        let manager = SyncManager::new(
            "https://cloud.example.test",
            directory.path().join("sync.db"),
        )
        .unwrap();
        let during_attempt = manager.account().auth_generation() + 1;
        let installed = sign_in(&manager, "account");
        assert!(installed > during_attempt);
        assert!(ready(manager.account().access_token(during_attempt)).is_err());
    }

    #[test]
    fn queued_refresh_rechecks_identity_after_acquiring_its_lock() {
        let directory = tempfile::tempdir().unwrap();
        let manager = SyncManager::new(
            "https://cloud.example.test",
            directory.path().join("sync.db"),
        )
        .unwrap();
        let first = sign_in(&manager, "first");
        let guard = manager.account().refresh_lock.try_lock().unwrap();
        let mut request = Box::pin(
            manager
                .account()
                .refresh_access_token("access-first", first),
        );
        let waker = std::task::Waker::from(std::sync::Arc::new(NoopWake));
        assert!(request
            .as_mut()
            .poll(&mut std::task::Context::from_waker(&waker))
            .is_pending());
        sign_in(&manager, "second");
        drop(guard);
        assert!(matches!(ready(request), Err(SyncError::NotAuthenticated)));
    }

    #[test]
    fn stale_and_unbound_reports_do_not_apply_files_or_advance_cursor() {
        let directory = tempfile::tempdir().unwrap();
        let manager = SyncManager::new(
            "https://cloud.example.test",
            directory.path().join("sync.db"),
        )
        .unwrap();
        let first = sign_in(&manager, "first");
        let mut report = V2AccountSyncReport::default();
        report.auth_generation = Some(first);
        report.cursor = 100;
        sign_in(&manager, "second");
        let applied = std::cell::Cell::new(false);
        let cursor = manager.store().v2_cursor().unwrap();
        assert!(manager
            .complete_v2_sync_with_apply(&report, None, || {
                applied.set(true);
                Ok(())
            })
            .is_err());
        assert!(!applied.get());
        assert_eq!(manager.store().v2_cursor().unwrap(), cursor);
        assert!(manager
            .complete_v2_account_sync(&V2AccountSyncReport::default())
            .is_err());
        report.auth_generation = Some(manager.account().auth_generation());
        assert!(manager
            .complete_v2_sync_with_apply(&report, None, || Err(SyncError::InvalidState(
                "apply failed".into()
            )))
            .is_err());
        assert_eq!(manager.store().v2_cursor().unwrap(), cursor);
    }

    fn runtime(token: &str) -> RuntimeSession {
        RuntimeSession {
            access_token: format!("access-{token}"),
            access_token_expires_at: i64::MAX,
            refresh_token: token.into(),
            refresh_token_expires_at: i64::MAX,
        }
    }

    #[test]
    fn begin_logout_clears_local_session_before_remote_revocation() {
        let directory = tempfile::tempdir().unwrap();
        let manager = SyncManager::new(
            "https://cloud.example.test",
            directory.path().join("sync.db"),
        )
        .unwrap();
        let generation = sign_in(&manager, "current");

        let pending = manager.begin_logout();

        assert!(!manager.state().unwrap().authenticated);
        assert!(manager.session_generation() > generation);
        assert_eq!(pending.refresh_token.as_deref(), Some("current"));
        assert!(pending.local_cleanup.is_ok());
    }

    #[test]
    fn late_refresh_cannot_restore_a_logged_out_session() {
        let directory = tempfile::tempdir().unwrap();
        let manager = SyncManager::new(
            "https://cloud.example.test",
            directory.path().join("sync.db"),
        )
        .unwrap();
        let generation = manager.account().begin_auth_attempt();
        manager.account().auth.write().unwrap().session = Some(runtime("first"));
        assert_eq!(
            manager
                .account()
                .clear_auth_with_cleanup(|| Ok(()))
                .0
                .as_deref(),
            Some("first")
        );
        assert!(manager
            .account()
            .install_refreshed_session(generation, "first", runtime("late"))
            .is_err());
        assert!(manager.account().auth.read().unwrap().session.is_none());
        assert!(!manager.state().unwrap().authenticated);
    }

    #[test]
    fn only_current_auth_attempt_and_refresh_token_can_commit() {
        let directory = tempfile::tempdir().unwrap();
        let manager = SyncManager::new(
            "https://cloud.example.test",
            directory.path().join("sync.db"),
        )
        .unwrap();
        let first = manager.account().begin_auth_attempt();
        let second = manager.account().begin_auth_attempt();
        assert!(manager.account().require_auth_generation(first).is_err());
        manager.account().auth.write().unwrap().session = Some(runtime("current"));
        assert!(manager
            .account()
            .install_refreshed_session(second, "wrong", runtime("bad"))
            .is_err());
        assert_eq!(
            manager
                .account()
                .install_refreshed_session(second, "current", runtime("next"))
                .unwrap(),
            "access-next"
        );
        assert_eq!(
            manager
                .account()
                .auth
                .read()
                .unwrap()
                .session
                .as_ref()
                .map(|session| session.refresh_token.as_str()),
            Some("next")
        );
    }

    #[test]
    fn failed_secret_cleanup_still_invalidates_the_local_session() {
        let directory = tempfile::tempdir().unwrap();
        let manager = SyncManager::new(
            "https://cloud.example.test",
            directory.path().join("sync.db"),
        )
        .unwrap();
        manager.account().auth.write().unwrap().session = Some(runtime("current"));
        let (_, cleanup) = manager.account().clear_auth_with_cleanup(|| {
            Err(SyncError::InvalidState("secret store unavailable".into()))
        });
        assert!(cleanup.is_err());
        assert!(manager.account().auth.read().unwrap().session.is_none());
        assert!(!manager.state().unwrap().authenticated);
    }
    #[test]
    fn token_save_is_serialized_with_logout() {
        struct BlockingStore {
            token: std::sync::Mutex<Option<String>>,
            entered: std::sync::mpsc::Sender<()>,
            release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
        }
        impl RefreshTokenStore for BlockingStore {
            fn load(&self) -> Result<Option<String>, String> {
                Ok(self.token.lock().unwrap().clone())
            }
            fn save(&self, token: &str) -> Result<(), String> {
                self.entered.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
                *self.token.lock().unwrap() = Some(token.into());
                Ok(())
            }
            fn delete(&self) -> Result<(), String> {
                *self.token.lock().unwrap() = None;
                Ok(())
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let store = Arc::new(BlockingStore {
            token: std::sync::Mutex::new(None),
            entered: entered_tx,
            release: std::sync::Mutex::new(release_rx),
        });
        let manager = SyncManager::new_with_token_store(
            "https://cloud.example.test",
            directory.path().join("sync.db"),
            store.clone(),
        )
        .unwrap();
        let login_manager = manager.clone();
        let login = std::thread::spawn(move || sign_in(&login_manager, "current"));
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert!(manager.account().auth_generation.try_lock().is_err());
        let logout_manager = manager.clone();
        let logout = std::thread::spawn(move || {
            logout_manager
                .account()
                .clear_auth_with_cleanup(|| {
                    logout_manager.account().delete_persisted_refresh_token()
                })
                .1
        });
        release_tx.send(()).unwrap();
        login.join().unwrap();
        logout.join().unwrap().unwrap();
        assert!(store.token.lock().unwrap().is_none());
        let state = manager.state().unwrap();
        assert!(!state.authenticated);
        assert_eq!(state.auth_status, CloudAuthStatus::SignedOut);
    }

    #[test]
    fn failed_persistence_is_a_login_warning_and_retries_only_current_session() {
        struct Store {
            fail: std::sync::atomic::AtomicBool,
            token: std::sync::Mutex<Option<String>>,
        }
        impl RefreshTokenStore for Store {
            fn load(&self) -> Result<Option<String>, String> {
                Ok(self.token.lock().unwrap().clone())
            }
            fn save(&self, token: &str) -> Result<(), String> {
                if self.fail.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err("disk unavailable".into());
                }
                *self.token.lock().unwrap() = Some(token.into());
                Ok(())
            }
            fn delete(&self) -> Result<(), String> {
                *self.token.lock().unwrap() = None;
                Ok(())
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(Store {
            fail: std::sync::atomic::AtomicBool::new(true),
            token: std::sync::Mutex::new(None),
        });
        let manager = SyncManager::new_with_token_store(
            "https://cloud.example.test",
            directory.path().join("sync.db"),
            store.clone(),
        )
        .unwrap();
        let first = sign_in(&manager, "first");
        let state = manager.state().unwrap();
        assert!(state.authenticated);
        assert!(state.auth_error.is_some());
        let second = sign_in(&manager, "second");
        store.fail.store(false, std::sync::atomic::Ordering::SeqCst);
        assert!(manager.account().session_for_generation(first).is_err());
        assert!(store.token.lock().unwrap().is_none());
        manager.account().flush_pending_credentials();
        assert_eq!(
            ready(manager.account().access_token(second)).unwrap(),
            "access-second"
        );
        assert_eq!(store.token.lock().unwrap().as_deref(), Some("second"));
        assert!(manager.state().unwrap().auth_error.is_none());
    }
    struct FaultyStore {
        token: std::sync::Mutex<Option<String>>,
        fail_save: std::sync::atomic::AtomicBool,
        fail_delete: std::sync::atomic::AtomicBool,
    }
    impl RefreshTokenStore for FaultyStore {
        fn load(&self) -> Result<Option<String>, String> {
            Ok(self.token.lock().unwrap().clone())
        }
        fn save(&self, token: &str) -> Result<(), String> {
            if self.fail_save.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("disk unavailable".into());
            }
            *self.token.lock().unwrap() = Some(token.into());
            Ok(())
        }
        fn delete(&self) -> Result<(), String> {
            if self.fail_delete.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("disk unavailable".into());
            }
            *self.token.lock().unwrap() = None;
            Ok(())
        }
    }

    #[tokio::test(start_paused = true)]
    async fn failed_save_recovers_in_background_without_another_cloud_request() {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(FaultyStore {
            token: std::sync::Mutex::new(None),
            fail_save: std::sync::atomic::AtomicBool::new(true),
            fail_delete: std::sync::atomic::AtomicBool::new(false),
        });
        let manager = SyncManager::new_with_token_store(
            "https://cloud.example.test",
            directory.path().join("sync.db"),
            store.clone(),
        )
        .unwrap();
        sign_in(&manager, "current");
        let revision = manager.state().unwrap().revision;
        let service_manager = manager.clone();
        let service = tokio::spawn(async move {
            service_manager.run_session_service().await;
        });
        tokio::task::yield_now().await;
        assert!(store.token.lock().unwrap().is_none());
        store
            .fail_save
            .store(false, std::sync::atomic::Ordering::SeqCst);
        tokio::time::advance(std::time::Duration::from_secs(2)).await;
        tokio::task::yield_now().await;
        assert_eq!(store.token.lock().unwrap().as_deref(), Some("current"));
        let state = manager.state().unwrap();
        assert!(state.authenticated);
        assert!(state.auth_error.is_none());
        assert!(state.revision > revision);
        service.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn failed_logout_deletion_is_retried_without_restoring_the_session() {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(FaultyStore {
            token: std::sync::Mutex::new(None),
            fail_save: std::sync::atomic::AtomicBool::new(false),
            fail_delete: std::sync::atomic::AtomicBool::new(true),
        });
        let manager = SyncManager::new_with_token_store(
            "https://cloud.example.test",
            directory.path().join("sync.db"),
            store.clone(),
        )
        .unwrap();
        sign_in(&manager, "current");
        let (_, cleanup) = manager
            .account()
            .clear_auth_with_cleanup(|| manager.account().delete_persisted_refresh_token());
        assert!(cleanup.is_err());
        assert!(!manager.state().unwrap().authenticated);
        let service_manager = manager.clone();
        let service = tokio::spawn(async move {
            service_manager.run_session_service().await;
        });
        tokio::task::yield_now().await;
        store
            .fail_delete
            .store(false, std::sync::atomic::Ordering::SeqCst);
        tokio::time::advance(std::time::Duration::from_secs(2)).await;
        tokio::task::yield_now().await;
        assert!(store.token.lock().unwrap().is_none());
        let state = manager.state().unwrap();
        assert_eq!(state.auth_status, CloudAuthStatus::SignedOut);
        assert!(state.auth_error.is_none());
        service.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn pending_logout_deletion_cannot_delete_a_new_accounts_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(FaultyStore {
            token: std::sync::Mutex::new(None),
            fail_save: std::sync::atomic::AtomicBool::new(false),
            fail_delete: std::sync::atomic::AtomicBool::new(true),
        });
        let manager = SyncManager::new_with_token_store(
            "https://cloud.example.test",
            directory.path().join("sync.db"),
            store.clone(),
        )
        .unwrap();
        sign_in(&manager, "old");
        manager
            .account()
            .clear_auth_with_cleanup(|| manager.account().delete_persisted_refresh_token())
            .1
            .unwrap_err();
        let service_manager = manager.clone();
        let service = tokio::spawn(async move {
            service_manager.run_session_service().await;
        });
        tokio::task::yield_now().await;
        sign_in(&manager, "new");
        store
            .fail_delete
            .store(false, std::sync::atomic::Ordering::SeqCst);
        tokio::time::advance(std::time::Duration::from_secs(2)).await;
        tokio::task::yield_now().await;
        assert_eq!(store.load().unwrap().as_deref(), Some("new"));
        assert_eq!(manager.state().unwrap().account.unwrap().user.id, "new");
        service.abort();
    }
    #[test]
    fn google_callback_is_superseded_by_login_logout_and_new_attempts() {
        let directory = tempfile::tempdir().unwrap();
        let manager = SyncManager::new(
            "https://cloud.example.test",
            directory.path().join("sync.db"),
        )
        .unwrap();
        let first = manager.begin_google_sign_in();
        sign_in(&manager, "email");
        assert!(matches!(
            ready(manager.sign_in_with_google_desktop("code", "state", "verifier", first)),
            Err(SyncError::NotAuthenticated)
        ));
        let second = manager.begin_google_sign_in();
        let _ = manager.account().clear_auth_with_cleanup(|| Ok(()));
        assert!(matches!(
            ready(manager.sign_in_with_google_desktop("code", "state", "verifier", second)),
            Err(SyncError::NotAuthenticated)
        ));
        let third = manager.begin_google_sign_in();
        let fourth = manager.begin_google_sign_in();
        assert!(manager.account().require_auth_generation(third).is_err());
        assert!(manager.account().require_auth_generation(fourth).is_ok());
    }

    #[test]
    fn credential_retry_preserves_unrelated_database_error() {
        let directory = tempfile::tempdir().unwrap();
        let manager = SyncManager::new(
            "https://cloud.example.test",
            directory.path().join("sync.db"),
        )
        .unwrap();
        {
            let mut auth = manager.account().auth.write().unwrap();
            auth.error = Some("database cleanup failed".into());
            auth.credential_error = Some("token delete failed".into());
            auth.pending_credential = Some(CredentialWrite::Delete);
        }
        assert!(manager.account().flush_pending_credentials());
        assert_eq!(
            manager.state().unwrap().auth_error.as_deref(),
            Some("database cleanup failed")
        );
        assert!(manager
            .account()
            .auth
            .read()
            .unwrap()
            .credential_error
            .is_none());
    }
}
