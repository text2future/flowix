use super::*;

impl SyncManager {
    pub async fn register(
        &self,
        email: &str,
        password: &str,
        display_name: &str,
    ) -> Result<AuthOutcome, SyncError> {
        let generation = self.begin_auth_attempt();
        let auth = self.client.register(email, password, display_name).await?;
        self.accept_auth(
            generation,
            V2CloudAccount {
                user: auth.user,
                protocol_epoch: crate::v2::PROTOCOL_EPOCH,
            },
            auth.session.into(),
        )
        .await
    }

    pub async fn login(&self, email: &str, password: &str) -> Result<AuthOutcome, SyncError> {
        let generation = self.begin_auth_attempt();
        let auth = self.client.login(email, password).await?;
        let runtime: RuntimeSession = auth.session.into();
        let me = self.client.me(&runtime.access_token).await?;
        self.accept_auth(
            generation,
            V2CloudAccount {
                user: me.user,
                protocol_epoch: crate::v2::PROTOCOL_EPOCH,
            },
            runtime,
        )
        .await
    }

    pub async fn apple_challenge(&self) -> Result<AppleAuthChallenge, SyncError> {
        self.client.apple_challenge().await
    }

    pub async fn sign_in_with_apple(
        &self,
        authorization: &AppleAuthorization,
    ) -> Result<AuthOutcome, SyncError> {
        let generation = self.begin_auth_attempt();
        let auth = self.client.apple_exchange(authorization).await?;
        let runtime: RuntimeSession = auth.session.into();
        let me = self.client.me(&runtime.access_token).await?;
        self.accept_auth(
            generation,
            V2CloudAccount {
                user: me.user,
                protocol_epoch: crate::v2::PROTOCOL_EPOCH,
            },
            runtime,
        )
        .await
    }

    pub async fn sign_in_with_google_desktop(
        &self,
        code: &str,
        state: &str,
        code_verifier: &str,
    ) -> Result<AuthOutcome, SyncError> {
        let generation = self.begin_auth_attempt();
        let auth = self.client.google_desktop_exchange(code, state, code_verifier).await?;
        let runtime: RuntimeSession = auth.session.into();
        let me = self.client.me(&runtime.access_token).await?;
        self.accept_auth(
            generation,
            V2CloudAccount {
                user: me.user,
                protocol_epoch: crate::v2::PROTOCOL_EPOCH,
            },
            runtime,
        )
        .await
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

    pub async fn restore(&self, refresh_token: &str) -> Result<AuthOutcome, SyncError> {
        self.restore_at_generation(refresh_token, self.session_restore_generation())
            .await
    }

    pub fn session_restore_generation(&self) -> u64 {
        self.auth_generation()
    }

    pub async fn restore_at_generation(
        &self,
        refresh_token: &str,
        generation: u64,
    ) -> Result<AuthOutcome, SyncError> {
        {
            let _generation = self.require_auth_generation(generation)?;
            if self
                .session
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_some()
            {
                return Err(SyncError::NotAuthenticated);
            }
        }
        let account = self
            .store
            .v2_account()?
            .ok_or(SyncError::NotAuthenticated)?;
        let refreshed = self.client.refresh(refresh_token).await?;
        self.accept_auth(generation, account, refreshed.session.into())
            .await
    }

    async fn accept_auth(
        &self,
        generation: u64,
        account: V2CloudAccount,
        runtime: RuntimeSession,
    ) -> Result<AuthOutcome, SyncError> {
        let refresh_token = runtime.refresh_token.clone();
        let committed_generation =
            self.install_authenticated_session(generation, account, runtime)?;
        let _ = self.refresh_membership().await;
        let _generation = self.require_auth_generation(committed_generation)?;
        Ok(AuthOutcome {
            state: self.state()?,
            refresh_token,
        })
    }

    fn install_authenticated_session(
        &self,
        generation: u64,
        account: V2CloudAccount,
        runtime: RuntimeSession,
    ) -> Result<u64, SyncError> {
        let mut current_generation = self.require_auth_generation(generation)?;
        self.store.save_v2_account(&account)?;
        *self
            .session
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(runtime);
        *self
            .last_error
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *current_generation = current_generation.saturating_add(1);
        Ok(*current_generation)
    }

    pub async fn logout(&self) -> Result<(), SyncError> {
        self.logout_with_cleanup(|| Ok(())).await
    }

    pub async fn logout_with_cleanup(
        &self,
        cleanup: impl FnOnce() -> Result<(), SyncError>,
    ) -> Result<(), SyncError> {
        let (refresh_token, local_cleanup) = self.clear_auth_with_cleanup(cleanup);
        let remote_logout = if let Some(refresh_token) = refresh_token {
            self.client.logout_with_refresh_token(&refresh_token).await
        } else {
            Ok(())
        };
        if let Err(error) = local_cleanup {
            if let Err(remote_error) = remote_logout {
                tracing::warn!("failed to revoke Flowix Cloud session during local logout: {remote_error}");
            }
            return Err(error);
        }
        remote_logout
    }

    fn clear_auth_with_cleanup(
        &self,
        cleanup: impl FnOnce() -> Result<(), SyncError>,
    ) -> (Option<String>, Result<(), SyncError>) {
        let mut generation = self
            .auth_generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *generation = generation.saturating_add(1);
        let token = self
            .session
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
            .map(|session| session.refresh_token);
        *self
            .membership
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        let account_result = self.store.clear_v2_account();
        let cleanup_result = cleanup();
        (token, account_result.and(cleanup_result))
    }

    fn begin_auth_attempt(&self) -> u64 {
        let mut generation = self
            .auth_generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *generation = generation.saturating_add(1);
        *generation
    }

    pub(super) fn auth_generation(&self) -> u64 {
        *self
            .auth_generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(super) fn require_auth_generation(
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
        let _generation = self.require_auth_generation(generation)?;
        let mut session = self
            .session
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !session
            .as_ref()
            .is_some_and(|current| current.refresh_token == expected_refresh_token)
        {
            return Err(SyncError::NotAuthenticated);
        }
        let access_token = next.access_token.clone();
        *session = Some(next);
        Ok(access_token)
    }

    fn session_for_generation(&self, generation: u64) -> Result<RuntimeSession, SyncError> {
        let _generation = self.require_auth_generation(generation)?;
        self.session
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or(SyncError::NotAuthenticated)
    }

    pub(super) async fn access_token(&self, generation: u64) -> Result<String, SyncError> {
        let current = self.session_for_generation(generation)?;
        let now = chrono::Utc::now().timestamp_millis();
        if current.access_token_expires_at > now + 30_000 {
            return Ok(current.access_token);
        }
        if current.refresh_token_expires_at <= now {
            return Err(SyncError::NotAuthenticated);
        }
        self.refresh_access_token(&current.access_token, generation)
            .await
    }

    pub(super) async fn force_refresh_access_token(
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
            return Err(SyncError::NotAuthenticated);
        }
        let refreshed = self.client.refresh(&current.refresh_token).await?;
        self.install_refreshed_session(generation, &current.refresh_token, refreshed.session.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        let generation = manager.begin_auth_attempt();
        manager
            .install_authenticated_session(
                generation,
                V2CloudAccount {
                    user: crate::models::CloudUser {
                        id: token.into(),
                        email: "test@example.test".into(),
                        display_name: "Test".into(),
                        system_role: "user".into(),
                    },
                    protocol_epoch: crate::v2::PROTOCOL_EPOCH,
                },
                runtime(token),
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
        assert_eq!(ready(manager.access_token(first)).unwrap(), "access-first");
        let second = sign_in(&manager, "second");
        assert!(ready(manager.access_token(first)).is_err());
        assert!(ready(manager.force_refresh_access_token(first)).is_err());
        assert_eq!(
            ready(manager.access_token(second)).unwrap(),
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
            .install_refreshed_session(generation, "first", runtime("rotated"))
            .unwrap();
        assert_eq!(
            ready(manager.refresh_access_token("access-first", generation)).unwrap(),
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
        let during_attempt = manager.auth_generation() + 1;
        let installed = sign_in(&manager, "account");
        assert!(installed > during_attempt);
        assert!(ready(manager.access_token(during_attempt)).is_err());
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
        let guard = manager.refresh_lock.try_lock().unwrap();
        let mut request = Box::pin(manager.refresh_access_token("access-first", first));
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
        let cursor = manager.store.v2_cursor().unwrap();
        assert!(manager
            .complete_v2_sync_with_apply(&report, None, || {
                applied.set(true);
                Ok(())
            })
            .is_err());
        assert!(!applied.get());
        assert_eq!(manager.store.v2_cursor().unwrap(), cursor);
        assert!(manager
            .complete_v2_account_sync(&V2AccountSyncReport::default())
            .is_err());
        report.auth_generation = Some(manager.auth_generation());
        assert!(manager
            .complete_v2_sync_with_apply(&report, None, || Err(SyncError::InvalidState(
                "apply failed".into()
            )))
            .is_err());
        assert_eq!(manager.store.v2_cursor().unwrap(), cursor);
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
    fn late_refresh_cannot_restore_a_logged_out_session() {
        let directory = tempfile::tempdir().unwrap();
        let manager = SyncManager::new(
            "https://cloud.example.test",
            directory.path().join("sync.db"),
        )
        .unwrap();
        let generation = manager.begin_auth_attempt();
        *manager.session.write().unwrap() = Some(runtime("first"));
        assert_eq!(
            manager.clear_auth_with_cleanup(|| Ok(())).0.as_deref(),
            Some("first")
        );
        assert!(manager
            .install_refreshed_session(generation, "first", runtime("late"))
            .is_err());
        assert!(manager.current_refresh_token().is_none());
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
        let first = manager.begin_auth_attempt();
        let second = manager.begin_auth_attempt();
        assert!(manager.require_auth_generation(first).is_err());
        *manager.session.write().unwrap() = Some(runtime("current"));
        assert!(manager
            .install_refreshed_session(second, "wrong", runtime("bad"))
            .is_err());
        assert_eq!(
            manager
                .install_refreshed_session(second, "current", runtime("next"))
                .unwrap(),
            "access-next"
        );
        assert_eq!(manager.current_refresh_token().as_deref(), Some("next"));
    }

    #[test]
    fn failed_secret_cleanup_still_invalidates_the_local_session() {
        let directory = tempfile::tempdir().unwrap();
        let manager = SyncManager::new(
            "https://cloud.example.test",
            directory.path().join("sync.db"),
        )
        .unwrap();
        *manager.session.write().unwrap() = Some(runtime("current"));
        let (_, cleanup) = manager.clear_auth_with_cleanup(|| {
            Err(SyncError::InvalidState("secret store unavailable".into()))
        });
        assert!(cleanup.is_err());
        manager.with_current_refresh_token(|token| assert!(token.is_none()));
        assert!(!manager.state().unwrap().authenticated);
    }
}
