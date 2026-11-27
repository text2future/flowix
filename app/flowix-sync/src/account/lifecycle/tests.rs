use super::*;
use crate::SyncManager;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

struct MemoryTokens(Mutex<Option<String>>);
impl RefreshTokenStore for MemoryTokens {
    fn load(&self) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn save(&self, token: &str) -> Result<(), String> {
        *self.0.lock().unwrap() = Some(token.into());
        Ok(())
    }
    fn delete(&self) -> Result<(), String> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}

// Use actual HTTP responses so recovery exercises the production transport,
// error classification, token rotation and authentication commit together.
struct Server {
    url: String,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    fn new(handler: impl Fn(&str) -> (u16, Value) + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let handler = Arc::new(handler);
        let thread = std::thread::spawn(move || {
            let mut workers = Vec::new();
            while !stopped.load(Ordering::SeqCst) {
                let Ok((mut socket, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(1));
                    continue;
                };
                let handler = handler.clone();
                workers.push(std::thread::spawn(move || {
                    socket.set_nonblocking(false).unwrap();
                    socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                    let mut request = Vec::new();
                    let mut buffer = [0; 2048];
                    loop {
                        let count = match socket.read(&mut buffer) {
                            Ok(count) => count,
                            Err(error) if matches!(error.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock) => return,
                            Err(error) => panic!("mock HTTP read failed: {error}"),
                        };
                        if count == 0 { return; }
                        request.extend_from_slice(&buffer[..count]);
                        if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                            let headers = String::from_utf8_lossy(&request[..end]);
                            let size: usize = headers.lines().find_map(|line| line.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap())).unwrap_or(0);
                            if request.len() >= end + 4 + size { break; }
                        }
                    }
                    let headers = String::from_utf8_lossy(&request);
                    let path = headers.lines().next().unwrap().split_whitespace().nth(1).unwrap();
                    let (status, body) = handler(path);
                    let body = body.to_string();
                    let response = format!("HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    let _ = socket.write_all(response.as_bytes());
                }));
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
        Self {
            url,
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.thread.take().unwrap().join().unwrap();
    }
}

fn user(id: &str) -> Value {
    json!({ "id": id, "email": format!("{id}@example.test"), "displayName": id })
}
fn session(id: &str) -> Value {
    json!({ "accessToken": format!("access-{id}"), "accessTokenExpiresAt": 4_102_444_800_000_i64,
        "refreshToken": id, "refreshTokenExpiresAt": 4_102_444_800_000_i64 })
}
fn seed_account(manager: &SyncManager, id: &str) {
    manager
        .store()
        .save_account(&CloudAccount {
            user: serde_json::from_value(user(id)).unwrap(),
        })
        .unwrap();
}
fn policy() -> SessionPolicy {
    SessionPolicy {
        initial_wait: Duration::from_millis(30),
        retry_start: Duration::from_millis(10),
        retry_max: Duration::from_millis(20),
    }
}

#[tokio::test]
async fn membership_refresh_updates_cached_account_region() {
    let server = Server::new(|path| match path {
        "/v1/auth/login" => (200, json!({"data": {"session": session("first"), "user": user("first")}})),
        "/v2/entitlements/current" => (200, entitlement()),
        "/v1/auth/me" => (200, json!({"data": {"user": {"id": "first", "email": "first@example.test", "displayName": "first", "region": "mainland"}}})),
        _ => panic!("unexpected request {path}"),
    });
    let directory = tempfile::tempdir().unwrap();
    let manager = SyncManager::new(&server.url, directory.path().join("sync.db")).unwrap();
    manager.login("first@example.test", "password").await.unwrap();
    assert_eq!(manager.state().unwrap().account.unwrap().user.region, "non_mainland");
    manager.refresh_membership().await.unwrap();
    assert_eq!(manager.state().unwrap().account.unwrap().user.region, "mainland");
}
async fn wait_for(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn recovery_timeout_opens_login_and_manual_login_supersedes_late_refresh() {
    let (release, gate) = std::sync::mpsc::channel();
    let gate = Mutex::new(gate);
    let server = Server::new(move |path| match path {
        "/v1/auth/refresh" => {
            gate.lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(2))
                .unwrap();
            (
                200,
                json!({ "data": { "session": session("rotated-old") } }),
            )
        }
        "/v1/auth/login" => (
            200,
            json!({ "data": { "session": session("new"), "user": user("new") } }),
        ),
        "/v1/auth/me" => (200, json!({ "data": { "user": user("new") } })),
        _ => panic!("unexpected request {path}"),
    });
    let directory = tempfile::tempdir().unwrap();
    let tokens = Arc::new(MemoryTokens(Mutex::new(Some("old".into()))));
    let manager = SyncManager::new_with_token_store(
        &server.url,
        directory.path().join("sync.db"),
        tokens.clone(),
    )
    .unwrap();
    seed_account(&manager, "old");
    let recovering = manager.clone();
    let recovery = tokio::spawn(async move {
        recovering.account().restore_saved_session(policy()).await;
    });
    wait_for(|| manager.state().unwrap().auth_status == CloudAuthStatus::SignedOut).await;
    assert!(manager.state().unwrap().auth_error.is_some());
    let signed_in = manager.login("new@example.test", "password").await.unwrap();
    assert!(signed_in.authenticated);
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), recovery)
        .await
        .unwrap()
        .unwrap();
    let current = manager.state().unwrap();
    assert_eq!(current.account.unwrap().user.id, "new");
    assert!(current.auth_error.is_none());
    assert_eq!(tokens.load().unwrap().as_deref(), Some("new"));
    assert_eq!(current.revision, signed_in.revision);
}

#[tokio::test]
async fn transient_failure_retries_and_persisted_rotation_survives_restart() {
    let requests = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let server = Server::new(move |path| {
        assert_eq!(path, "/v1/auth/refresh");
        if count.fetch_add(1, Ordering::SeqCst) == 0 {
            (
                503,
                json!({ "error": { "code": "TEMPORARY", "message": "unavailable" } }),
            )
        } else {
            (200, json!({ "data": { "session": session("rotated") } }))
        }
    });
    let directory = tempfile::tempdir().unwrap();
    let tokens = Arc::new(MemoryTokens(Mutex::new(Some("old".into()))));
    let database = directory.path().join("sync.db");
    let manager =
        SyncManager::new_with_token_store(&server.url, &database, tokens.clone()).unwrap();
    seed_account(&manager, "account");
    manager.account().restore_saved_session(policy()).await;
    assert!(manager.state().unwrap().authenticated);
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    assert_eq!(tokens.load().unwrap().as_deref(), Some("rotated"));
    drop(manager);
    let restarted = SyncManager::new_with_token_store(&server.url, &database, tokens).unwrap();
    assert_eq!(
        restarted.state().unwrap().auth_status,
        CloudAuthStatus::Restoring
    );
    restarted.account().restore_saved_session(policy()).await;
    assert!(restarted.state().unwrap().authenticated);
    assert_eq!(
        restarted.state().unwrap().account.unwrap().user.id,
        "account"
    );
}

#[tokio::test]
async fn invalid_refresh_clears_local_credentials_and_stops_recovery() {
    let server = Server::new(|_| {
        (
            401,
            json!({ "error": { "code": "INVALID_REFRESH_TOKEN", "message": "expired" } }),
        )
    });
    let directory = tempfile::tempdir().unwrap();
    let tokens = Arc::new(MemoryTokens(Mutex::new(Some("invalid".into()))));
    let manager = SyncManager::new_with_token_store(
        &server.url,
        directory.path().join("sync.db"),
        tokens.clone(),
    )
    .unwrap();
    seed_account(&manager, "account");
    manager.account().restore_saved_session(policy()).await;
    assert_eq!(
        manager.state().unwrap().auth_status,
        CloudAuthStatus::SignedOut
    );
    assert!(tokens.load().unwrap().is_none());
    assert!(manager.state().unwrap().account.is_none());
}

fn entitlement() -> Value {
    json!({ "data": {
        "membership": { "active": true, "startsAt": null, "expiresAt": null },
        "usage": { "usedBytes": 10, "quotaBytes": 100, "availableBytes": 90,
                   "noteCount": 1, "readOnly": false }
    } })
}

#[tokio::test]
async fn ai_credit_snapshot_refreshes_and_clears_on_failure_and_logout() {
    let fail = Arc::new(AtomicBool::new(false));
    let server_fail = fail.clone();
    let server = Server::new(move |path| match path {
        "/v1/auth/login" => (200, json!({"data": {"session": session("first"), "user": user("first")}})),
        "/v1/account/ai-credits" if server_fail.load(Ordering::SeqCst) =>
            (503, json!({"error": {"code": "UNAVAILABLE", "message": "offline"}})),
        "/v1/account/ai-credits" => (200, json!({"data": {"balanceMicrocredits": 1_000_000}})),
        _ => panic!("unexpected request {path}"),
    });
    let directory = tempfile::tempdir().unwrap();
    let manager = AccountService::new(&server.url, directory.path().join("sync.db")).unwrap();
    manager.login("first@example.test", "password").await.unwrap();
    manager.ai_credit_balance().await.unwrap();
    let ready = manager.state().unwrap();
    assert_eq!(ready.ai_credits.status, CloudAiCreditStatus::Ready);
    assert_eq!(ready.ai_credits.data.unwrap().balance_microcredits, 1_000_000);
    assert!(ready.ai_credits.updated_at.is_some());
    fail.store(true, Ordering::SeqCst);
    assert!(manager.ai_credit_balance().await.is_err());
    let failed = manager.state().unwrap();
    assert_eq!(failed.ai_credits.status, CloudAiCreditStatus::Error);
    assert!(failed.ai_credits.data.is_none());
    assert!(failed.revision > ready.revision);
    let _pending = manager.begin_logout();
    assert_eq!(manager.state().unwrap().ai_credits.status, CloudAiCreditStatus::Unknown);
    assert!(manager.ai_credit_balance().await.is_err());
    assert_eq!(manager.state().unwrap().ai_credits.status, CloudAiCreditStatus::Unknown);
}

#[tokio::test]
async fn simultaneous_ai_credit_requests_share_a_refresh_and_preserve_the_snapshot() {
    let (release, gate) = std::sync::mpsc::channel();
    let gate = Mutex::new(gate);
    let requests = Arc::new(AtomicUsize::new(0));
    let counted = requests.clone();
    let server = Server::new(move |path| match path {
        "/v1/auth/login" => (200, json!({"data": {"session": session("first"), "user": user("first")}})),
        "/v1/account/ai-credits" => {
            if counted.fetch_add(1, Ordering::SeqCst) == 1 {
                gate.lock().unwrap().recv_timeout(Duration::from_secs(2)).unwrap();
            }
            (200, json!({"data": {"balanceMicrocredits": 1_000_000}}))
        },
        _ => panic!("unexpected request {path}"),
    });
    let directory = tempfile::tempdir().unwrap();
    let manager = AccountService::new(&server.url, directory.path().join("sync.db")).unwrap();
    manager.login("first@example.test", "password").await.unwrap();
    manager.ai_credit_balance().await.unwrap();
    let worker = manager.clone();
    let first = tokio::spawn(async move { worker.ai_credit_balance().await });
    wait_for(|| requests.load(Ordering::SeqCst) == 2).await;
    let state = manager.state().unwrap();
    assert_eq!(state.ai_credits.status, CloudAiCreditStatus::Refreshing);
    assert_eq!(state.ai_credits.data.unwrap().balance_microcredits, 1_000_000);
    let second = manager.ai_credit_balance();
    tokio::pin!(second);
    tokio::select! {
        _ = &mut second => panic!("refresh completed before the response was released"),
        _ = tokio::time::sleep(Duration::from_millis(10)) => {}
    }
    release.send(()).unwrap();
    assert!(first.await.unwrap().is_ok());
    assert!(second.await.is_ok());
    assert_eq!(requests.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn ai_credit_response_from_previous_session_cannot_update_new_account() {
    let (release, gate) = std::sync::mpsc::channel();
    let gate = Mutex::new(gate);
    let requests = Arc::new(AtomicUsize::new(0));
    let counted = requests.clone();
    let logins = AtomicUsize::new(0);
    let server = Server::new(move |path| match path {
        "/v1/auth/login" => {
            let id = if logins.fetch_add(1, Ordering::SeqCst) == 0 { "first" } else { "second" };
            (200, json!({"data": {"session": session(id), "user": user(id)}}))
        },
        "/v1/account/ai-credits" => {
            counted.fetch_add(1, Ordering::SeqCst);
            gate.lock().unwrap().recv_timeout(Duration::from_secs(2)).unwrap();
            (200, json!({"data": {"balanceMicrocredits": 1_000_000}}))
        },
        _ => panic!("unexpected request {path}"),
    });
    let directory = tempfile::tempdir().unwrap();
    let manager = AccountService::new(&server.url, directory.path().join("sync.db")).unwrap();
    manager.login("first@example.test", "password").await.unwrap();
    let previous = manager.clone();
    let request = tokio::spawn(async move { previous.ai_credit_balance().await });
    wait_for(|| requests.load(Ordering::SeqCst) == 1).await;
    manager.login("second@example.test", "password").await.unwrap();
    release.send(()).unwrap();
    assert!(request.await.unwrap().is_err());
    let state = manager.state().unwrap();
    assert_eq!(state.account.unwrap().user.id, "second");
    assert_eq!(state.ai_credits.status, CloudAiCreditStatus::Unknown);
    assert!(state.ai_credits.data.is_none());
}

#[tokio::test]
async fn failed_membership_refresh_invalidates_shared_access_until_a_successful_retry() {
    let fail = Arc::new(AtomicBool::new(false));
    let server_fail = fail.clone();
    let server = Server::new(move |path| match path {
        "/v1/auth/login" => (
            200,
            json!({ "data": { "session": session("first"), "user": user("first") } }),
        ),
        "/v2/entitlements/current" if server_fail.load(Ordering::SeqCst) => (
            503,
            json!({ "error": { "code": "UNAVAILABLE", "message": "offline" } }),
        ),
        "/v2/entitlements/current" => (200, entitlement()),
        "/v1/auth/me" => (200, json!({"data": {"user": user("first")}})),
        _ => panic!("unexpected request {path}"),
    });
    let directory = tempfile::tempdir().unwrap();
    let manager = SyncManager::new(&server.url, directory.path().join("sync.db")).unwrap();
    manager
        .login("first@example.test", "password")
        .await
        .unwrap();
    manager.refresh_membership().await.unwrap();
    let verified_revision = manager.state().unwrap().revision;
    assert!(manager.state().unwrap().membership.is_some());
    fail.store(true, Ordering::SeqCst);
    assert!(manager.refresh_membership().await.is_err());
    let invalidated = manager.state().unwrap();
    assert!(invalidated.authenticated);
    assert!(invalidated.membership.is_none());
    assert!(invalidated.revision > verified_revision);
    assert!(manager.refresh_membership().await.is_err());
    assert!(manager.state().unwrap().membership.is_none());
    fail.store(false, Ordering::SeqCst);
    manager.refresh_membership().await.unwrap();
    assert!(manager.state().unwrap().membership.is_some());
}

#[tokio::test]
async fn concurrent_membership_requests_share_one_refresh_and_later_calls_refresh_again() {
    let requests = Arc::new(AtomicUsize::new(0));
    let counted = requests.clone();
    let (release, gate) = std::sync::mpsc::channel();
    let gate = Mutex::new(gate);
    let server = Server::new(move |path| match path {
        "/v1/auth/login" => (
            200,
            json!({ "data": { "session": session("first"), "user": user("first") } }),
        ),
        "/v1/auth/me" => (200, json!({ "data": { "user": user("account") } })),
        "/v2/entitlements/current" => {
            if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                gate.lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(2))
                    .unwrap();
            }
            (200, entitlement())
        }
        _ => panic!("unexpected request {path}"),
    });
    let directory = tempfile::tempdir().unwrap();
    let manager = SyncManager::new(&server.url, directory.path().join("sync.db")).unwrap();
    manager
        .login("first@example.test", "password")
        .await
        .unwrap();
    let first_manager = manager.clone();
    let first = tokio::spawn(async move { first_manager.refresh_membership().await });
    wait_for(|| requests.load(Ordering::SeqCst) == 1).await;
    let second = manager.refresh_membership();
    tokio::pin!(second);
    // Poll the second call while the first HTTP response is held at the gate.
    tokio::select! {
        _ = &mut second => panic!("refresh completed before the response was released"),
        _ = tokio::time::sleep(Duration::from_millis(10)) => {}
    }
    release.send(()).unwrap();
    assert!(first.await.unwrap().unwrap().active);
    assert!(second.await.unwrap().active);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    manager.refresh_membership().await.unwrap();
    assert_eq!(requests.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn account_changes_clear_membership_and_constructor_notifier_observes_first_login() {
    let accounts = AtomicUsize::new(0);
    let server = Server::new(move |path| match path {
        "/v1/auth/login" => {
            let id = if accounts.fetch_add(1, Ordering::SeqCst) == 0 {
                "first"
            } else {
                "second"
            };
            (
                200,
                json!({ "data": { "session": session(id), "user": user(id) } }),
            )
        }
        "/v2/entitlements/current" => (200, entitlement()),
        "/v1/auth/me" => (503, json!({"error": {"code": "UNAVAILABLE", "message": "offline"}})),
        "/v1/auth/logout/refresh" => (200, json!({ "data": {} })),
        _ => panic!("unexpected request {path}"),
    });
    let directory = tempfile::tempdir().unwrap();
    let observed = Arc::new(Mutex::new(Vec::<CloudState>::new()));
    let notifications = observed.clone();
    let manager = SyncManager::new_with_session_dependencies(
        &server.url,
        directory.path().join("sync.db"),
        Arc::new(MemoryTokens(Mutex::new(None))),
        Arc::new(move |state| notifications.lock().unwrap().push(state)),
    )
    .unwrap();
    manager
        .login("account@example.test", "password")
        .await
        .unwrap();
    assert!(observed.lock().unwrap().first().unwrap().authenticated);
    manager.refresh_membership().await.unwrap();
    assert!(manager.state().unwrap().membership.is_some());
    manager
        .login("account@example.test", "password")
        .await
        .unwrap();
    assert_eq!(manager.state().unwrap().account.unwrap().user.id, "second");
    assert!(manager.state().unwrap().membership.is_none());
    manager.refresh_membership().await.unwrap();
    manager.logout().await.unwrap();
    let state = manager.state().unwrap();
    assert!(!state.authenticated);
    assert!(state.membership.is_none());
    assert!(!observed.lock().unwrap().last().unwrap().authenticated);
}

#[tokio::test]
async fn late_membership_response_cannot_update_a_new_session() {
    let (release, gate) = std::sync::mpsc::channel();
    let gate = Mutex::new(gate);
    let requests = Arc::new(AtomicUsize::new(0));
    let counted = requests.clone();
    let server = Server::new(move |path| match path {
        "/v1/auth/login" => (
            200,
            json!({ "data": { "session": session("account"), "user": user("account") } }),
        ),
        "/v1/auth/me" => (200, json!({ "data": { "user": user("account") } })),
        "/v2/entitlements/current" => {
            counted.fetch_add(1, Ordering::SeqCst);
            gate.lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(2))
                .unwrap();
            (200, entitlement())
        }
        _ => panic!("unexpected request {path}"),
    });
    let directory = tempfile::tempdir().unwrap();
    let manager = SyncManager::new(&server.url, directory.path().join("sync.db")).unwrap();
    manager
        .login("account@example.test", "password")
        .await
        .unwrap();
    let old_manager = manager.clone();
    let old = tokio::spawn(async move { old_manager.refresh_membership().await });
    wait_for(|| requests.load(Ordering::SeqCst) == 1).await;
    manager
        .login("account@example.test", "password")
        .await
        .unwrap();
    release.send(()).unwrap();
    assert!(matches!(
        old.await.unwrap(),
        Err(SyncError::NotAuthenticated)
    ));
    assert!(manager.state().unwrap().membership.is_none());
}

#[tokio::test]
async fn restoration_without_account_cache_preserves_rotation_when_metadata_fails() {
    let metadata_calls = AtomicUsize::new(0);
    let server = Server::new(move |path| match path {
        "/v1/auth/refresh" => (200, json!({ "data": { "session": session("rotated") } })),
        "/v1/auth/me" => {
            if metadata_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                (
                    503,
                    json!({ "error": { "code": "UNAVAILABLE", "message": "offline" } }),
                )
            } else {
                (200, json!({ "data": { "user": user("restored") } }))
            }
        }
        _ => panic!("unexpected request {path}"),
    });
    let directory = tempfile::tempdir().unwrap();
    let tokens = Arc::new(MemoryTokens(Mutex::new(Some("original".into()))));
    let manager = SyncManager::new_with_token_store(
        &server.url,
        directory.path().join("sync.db"),
        tokens.clone(),
    )
    .unwrap();
    assert!(manager
        .account()
        .restore_at_generation("original", 0)
        .await
        .is_err());
    assert_eq!(tokens.load().unwrap().as_deref(), Some("rotated"));
    assert!(!manager.state().unwrap().authenticated);
    manager.account().restore_saved_session(policy()).await;
    let state = manager.state().unwrap();
    assert!(state.authenticated);
    assert_eq!(state.account.unwrap().user.id, "restored");
}

#[tokio::test]
async fn google_exchange_started_before_logout_cannot_reinstall_session() {
    let (release, gate) = std::sync::mpsc::channel();
    let gate = Mutex::new(gate);
    let entered = Arc::new(AtomicBool::new(false));
    let observed = entered.clone();
    let server = Server::new(move |path| match path {
        "/v1/auth/google/desktop/exchange" => {
            observed.store(true, Ordering::SeqCst);
            gate.lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(2))
                .unwrap();
            (
                200,
                json!({ "data": { "session": session("google"), "user": user("google") } }),
            )
        }
        "/v1/auth/me" => (200, json!({ "data": { "user": user("google") } })),
        _ => panic!("unexpected request {path}"),
    });
    let directory = tempfile::tempdir().unwrap();
    let manager = SyncManager::new(&server.url, directory.path().join("sync.db")).unwrap();
    let generation = manager.begin_google_sign_in();
    let exchanging = manager.clone();
    let exchange = tokio::spawn(async move {
        exchanging
            .sign_in_with_google_desktop("code", "state", "verifier", generation)
            .await
    });
    wait_for(|| entered.load(Ordering::SeqCst)).await;
    manager.logout().await.unwrap();
    release.send(()).unwrap();
    assert!(matches!(
        exchange.await.unwrap(),
        Err(SyncError::NotAuthenticated)
    ));
    assert!(!manager.state().unwrap().authenticated);
    assert!(manager.state().unwrap().account.is_none());
}

#[tokio::test]
async fn failed_logout_cleanup_cannot_restore_after_restart_and_explicit_login_unblocks() {
    struct Tokens {
        token: Mutex<Option<String>>,
        fail_delete: AtomicBool,
    }
    impl RefreshTokenStore for Tokens {
        fn load(&self) -> Result<Option<String>, String> {
            Ok(self.token.lock().unwrap().clone())
        }
        fn save(&self, token: &str) -> Result<(), String> {
            *self.token.lock().unwrap() = Some(token.into());
            Ok(())
        }
        fn delete(&self) -> Result<(), String> {
            if self.fail_delete.load(Ordering::SeqCst) {
                return Err("disk unavailable".into());
            }
            *self.token.lock().unwrap() = None;
            Ok(())
        }
    }
    let requests = Arc::new(AtomicUsize::new(0));
    let counted = requests.clone();
    let server = Server::new(move |path| {
        counted.fetch_add(1, Ordering::SeqCst);
        match path {
            "/v1/auth/login" => (
                200,
                json!({ "data": { "session": session("account"), "user": user("account") } }),
            ),
            "/v1/auth/logout/refresh" => (
                503,
                json!({ "error": { "code": "UNAVAILABLE", "message": "offline" } }),
            ),
            _ => panic!("unexpected request {path}"),
        }
    });
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("sync.db");
    let tokens = Arc::new(Tokens {
        token: Mutex::new(None),
        fail_delete: AtomicBool::new(true),
    });
    let manager =
        SyncManager::new_with_token_store(&server.url, &database, tokens.clone()).unwrap();
    manager
        .login("test@example.test", "password")
        .await
        .unwrap();
    assert!(manager.logout().await.is_err());
    assert!(tokens.load().unwrap().is_some());
    drop(manager);
    let restarted =
        SyncManager::new_with_token_store(&server.url, &database, tokens.clone()).unwrap();
    assert_eq!(
        restarted.state().unwrap().auth_status,
        CloudAuthStatus::SignedOut
    );
    let before = requests.load(Ordering::SeqCst);
    restarted.account().restore_saved_session(policy()).await;
    assert_eq!(requests.load(Ordering::SeqCst), before);
    assert!(!restarted.state().unwrap().authenticated);
    tokens.fail_delete.store(false, Ordering::SeqCst);
    assert!(restarted.account().flush_pending_credentials());
    assert!(tokens.load().unwrap().is_none());
    restarted
        .login("test@example.test", "password")
        .await
        .unwrap();
    assert!(!restarted.store().session_restore_blocked().unwrap());
    assert!(restarted.account().flush_pending_credentials());
    assert_eq!(tokens.load().unwrap().as_deref(), Some("account"));
    assert!(restarted.state().unwrap().authenticated);
}

#[tokio::test]
async fn cached_account_write_failure_does_not_discard_rotated_token() {
    let server = Server::new(move |path| match path {
        "/v1/auth/refresh" => (200, json!({ "data": { "session": session("rotated") } })),
        _ => panic!("unexpected request {path}"),
    });
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("sync.db");
    let tokens = Arc::new(MemoryTokens(Mutex::new(Some("original".into()))));
    let manager =
        SyncManager::new_with_token_store(&server.url, &database, tokens.clone()).unwrap();
    seed_account(&manager, "account");
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_account_update BEFORE UPDATE ON cloud_account BEGIN SELECT RAISE(ABORT, 'database write failed'); END;").unwrap();
    assert!(manager
        .account()
        .restore_at_generation("original", 0)
        .await
        .is_err());
    assert_eq!(tokens.load().unwrap().as_deref(), Some("rotated"));
    assert!(!manager.state().unwrap().authenticated);
    connection
        .execute_batch("DROP TRIGGER fail_account_update;")
        .unwrap();
    drop(manager);
    let restarted = SyncManager::new_with_token_store(&server.url, &database, tokens).unwrap();
    restarted.account().restore_saved_session(policy()).await;
    assert!(restarted.state().unwrap().authenticated);
}

#[tokio::test]
async fn signing_in_returns_before_background_entitlement_verification() {
    let server = Server::new(|path| match path {
        "/v1/auth/login" => (
            200,
            json!({"data": {"session": session("fast"), "user": user("fast")}}),
        ),
        _ => panic!("login must not wait for entitlement transport: {path}"),
    });
    let directory = tempfile::tempdir().unwrap();
    let manager = AccountService::new(&server.url, directory.path().join("sync.db")).unwrap();
    let state = manager
        .login("fast@example.test", "password")
        .await
        .unwrap();
    assert!(state.authenticated);
    assert_eq!(state.membership_status, CloudEntitlementStatus::Unknown);
    assert!(!manager.sync_access().can_read);
    // The process-owned service, rather than the login caller, consumes this wakeup.
    tokio::time::timeout(
        Duration::from_millis(100),
        manager.entitlement_retry.notified(),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn account_service_verifies_entitlement_immediately_after_login() {
    let server = Server::new(|path| match path {
        "/v1/auth/login" => (
            200,
            json!({"data": {"session": session("service"), "user": user("service")}}),
        ),
        "/v2/entitlements/current" => (200, entitlement()),
        "/v1/auth/me" => (200, json!({"data": {"user": user("service")}})),
        "/v1/account/ai-credits" => (200, json!({"data": {"balanceMicrocredits": 100}})),
        _ => panic!("unexpected request {path}"),
    });
    let directory = tempfile::tempdir().unwrap();
    let manager = AccountService::new(&server.url, directory.path().join("sync.db")).unwrap();
    let worker = manager.clone();
    let service = tokio::spawn(async move { worker.run_session_service().await });
    manager
        .login("service@example.test", "password")
        .await
        .unwrap();
    wait_for(|| manager.state().unwrap().membership_status == CloudEntitlementStatus::Verified)
        .await;
    service.abort();
    let _ = service.await;
}
