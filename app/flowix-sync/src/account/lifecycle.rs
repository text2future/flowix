use super::*;
use std::time::Duration;

#[derive(Clone, Copy)]
struct SessionPolicy {
    initial_wait: Duration,
    retry_start: Duration,
    retry_max: Duration,
}

impl Default for SessionPolicy {
    fn default() -> Self {
        Self {
            initial_wait: Duration::from_secs(10),
            retry_start: Duration::from_secs(2),
            retry_max: Duration::from_secs(60),
        }
    }
}

impl AccountService {
    /// Run once for the lifetime of the desktop process. Dropping this future
    /// stops background recovery and credential retries.
    pub async fn run_session_service(&self) {
        let policy = SessionPolicy::default();
        tokio::join!(
            self.restore_saved_session(policy),
            self.retry_credentials(policy),
            self.refresh_entitlements_when_requested(),
            self.refresh_ai_credits_when_requested(),
        );
    }

    async fn refresh_ai_credits_when_requested(&self) {
        loop {
            self.ai_credits_retry.notified().await;
            if self.state().is_ok_and(|state| state.authenticated) {
                if let Err(error) = self.ai_credit_balance().await {
                    tracing::debug!(%error, "requested AI credit refresh failed");
                }
            }
        }
    }

    async fn refresh_entitlements_when_requested(&self) {
        loop {
            self.entitlement_retry.notified().await;
            if self.state().is_ok_and(|state| state.authenticated) {
                if let Err(error) = self.refresh_membership().await {
                    tracing::debug!(%error, "requested cloud entitlement refresh failed");
                }
            }
        }
    }

    async fn restore_saved_session(&self, policy: SessionPolicy) {
        let Some(store) = self.refresh_token_store.as_ref() else {
            return;
        };
        match self.store.session_restore_blocked() {
            Ok(true) => return,
            Ok(false) => {}
            Err(error) => {
                self.mark_restore_failed_at_generation(0, error.to_string());
                return;
            }
        }
        // Startup generation is fixed before the UI can begin login/logout.
        // An explicit authentication attempt permanently supersedes recovery.
        let generation = 0;
        let mut delay = policy.retry_start;
        loop {
            if self.auth_generation() != generation {
                return;
            }
            let pending_token = {
                let auth = self.auth.read().unwrap_or_else(|p| p.into_inner());
                match auth.pending_credential.as_ref() {
                    Some(CredentialWrite::Save(token)) => Some(token.clone()),
                    _ => None,
                }
            };
            let token = match pending_token
                .map(Some)
                .map(Ok)
                .unwrap_or_else(|| store.load())
            {
                Ok(Some(token)) => token,
                Ok(None) => {
                    if self
                        .state()
                        .is_ok_and(|state| state.auth_status == CloudAuthStatus::Restoring)
                    {
                        self.mark_restore_failed_at_generation(
                            generation,
                            "本地登录凭据已不存在，请重新登录",
                        );
                    }
                    return;
                }
                Err(error) => {
                    self.mark_restore_failed_at_generation(generation, error);
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(policy.retry_max);
                    continue;
                }
            };
            let attempt = self.restore_at_generation(&token, generation);
            tokio::pin!(attempt);
            let result = tokio::select! {
                result = &mut attempt => result,
                _ = tokio::time::sleep(policy.initial_wait) => {
                    self.mark_restore_failed_at_generation(generation, "登录恢复等待较久，可手动登录，后台将继续尝试恢复");
                    // Preserve the response: cancelling after server-side token
                    // rotation could discard the only usable refresh token.
                    attempt.await
                }
            };
            match result {
                Ok(_) => return,
                Err(error) if error.is_invalid_refresh_token() => return,
                Err(error) if restore_error_is_retryable(&error) => {
                    self.mark_restore_failed_at_generation(
                        generation,
                        "暂时无法恢复登录，可手动登录，后台将继续尝试恢复",
                    );
                    if self.auth_generation() != generation {
                        return;
                    }
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(policy.retry_max);
                }
                Err(error) => {
                    self.mark_restore_failed_at_generation(generation, error.to_string());
                    return;
                }
            }
        }
    }

    async fn retry_credentials(&self, policy: SessionPolicy) {
        loop {
            self.credential_retry.notified().await;
            let mut delay = policy.retry_start;
            while !self.flush_pending_credentials() {
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(policy.retry_max);
            }
        }
    }

    pub(super) fn flush_pending_credentials(&self) -> bool {
        let generation = self
            .auth_generation
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let mut auth = self.auth.write().unwrap_or_else(|p| p.into_inner());
        let Some(pending) = auth.pending_credential.as_ref() else {
            return true;
        };
        let result = match pending {
            CredentialWrite::Save(token) => self
                .refresh_token_store
                .as_ref()
                .map_or(Ok(()), |store| store.save(token)),
            CredentialWrite::Delete => self
                .refresh_token_store
                .as_ref()
                .map_or(Ok(()), |store| store.delete()),
        };
        let complete = result.is_ok();
        if complete {
            auth.pending_credential = None;
            auth.credential_error = None;
            auth.revision = auth.revision.saturating_add(1);
        }
        drop(auth);
        drop(generation);
        if complete {
            self.notify_state_change();
        }
        complete
    }
}

fn restore_error_is_retryable(error: &SyncError) -> bool {
    matches!(
        error,
        SyncError::Http(_)
            | SyncError::Api {
                status: 408 | 429 | 500..=599,
                ..
            }
    )
}

#[cfg(test)]
mod tests;
