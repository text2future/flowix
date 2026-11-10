//! Account deletion and export, exercised through the production transport.
//!
//! These cases talk to a real socket instead of stubbing the client, because
//! what they protect is the *sequence*: delete on the server, then drop local
//! state only after the server confirmed. A stubbed client would let the order
//! regress without failing anything.
use super::*;
use crate::SyncManager;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

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

/// Minimal single-request-at-a-time HTTP server. Deletion and export are
/// sequential operations, so a worker pool would only add noise.
struct Server {
    url: String,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Server {
    fn new(handler: impl Fn(&str) -> (u16, Value) + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let thread = std::thread::spawn(move || {
            while !stopped.load(Ordering::SeqCst) {
                let Ok((mut socket, _)) = listener.accept() else {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                    continue;
                };
                socket
                    .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 2048];
                loop {
                    let count = match socket.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(count) => count,
                        Err(_) => break,
                    };
                    request.extend_from_slice(&buffer[..count]);
                    if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]);
                        let size: usize = headers
                            .lines()
                            .find_map(|line| {
                                line.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|value| value.trim().parse().unwrap())
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + size {
                            break;
                        }
                    }
                }
                let headers = String::from_utf8_lossy(&request);
                let path = headers
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap()
                    .to_string();
                let (status, body) = handler(&path);
                let body = body.to_string();
                let response = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes());
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

fn session() -> Value {
    json!({
        "accessToken": "access-1",
        "accessTokenExpiresAt": 4_102_444_800_000_i64,
        "refreshToken": "refresh-1",
        "refreshTokenExpiresAt": 4_102_444_800_000_i64,
    })
}

async fn signed_in(server: &Server) -> (SyncManager, Arc<MemoryTokens>, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let tokens = Arc::new(MemoryTokens(Mutex::new(None)));
    let manager = SyncManager::new_with_token_store(
        &server.url,
        directory.path().join("sync.db"),
        tokens.clone(),
    )
    .unwrap();
    let state = manager.login("a@example.test", "password").await.unwrap();
    assert!(state.authenticated);
    (manager, tokens, directory)
}

#[tokio::test]
async fn deleting_an_account_clears_local_state_only_after_the_server_confirms() {
    let server = Server::new(|path| match path {
        "/v1/auth/login" => (
            200,
            json!({ "data": { "user": user("a"), "session": session() } }),
        ),
        "/v1/account" => (
            200,
            json!({ "data": {
                "state": "restorable",
                "restorableUntil": 4_102_444_800_000_i64,
                "pendingSubscriptionCancellations": ["sub_1"],
            } }),
        ),
        _ => panic!("unexpected request {path}"),
    });
    let (manager, tokens, _directory) = signed_in(&server).await;
    assert!(manager.store().v2_account().unwrap().is_some());

    let outcome = manager.delete_account("a@example.test").await.unwrap();

    assert_eq!(outcome.state, "restorable");
    assert_eq!(outcome.restorable_until, Some(4_102_444_800_000));
    // A provider that refused must be reported, not swallowed: the account is
    // gone, so the user has to hear about a subscription that is still running.
    assert_eq!(outcome.pending_subscription_cancellations, vec!["sub_1"]);

    let state = manager.state().unwrap();
    assert!(!state.authenticated);
    assert!(state.account.is_none());
    assert!(!state.restored);
    // Nothing may survive that could re-upload the same notes later.
    assert!(manager.store().v2_account().unwrap().is_none());
    assert!(manager.store().session_restore_blocked().unwrap());
    assert_eq!(tokens.load().unwrap(), None);
}

#[tokio::test]
async fn deleting_a_gone_account_from_the_client_is_idempotent() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let server = Server::new(move |path| match path {
        "/v1/auth/login" => (
            200,
            json!({ "data": { "user": user("a"), "session": session() } }),
        ),
        // The server answers a repeated deletion with the same deadline
        // instead of an error the user cannot act on.
        "/v1/account" => {
            counter.fetch_add(1, Ordering::SeqCst);
            (
                200,
                json!({ "data": {
                    "state": "restorable",
                    "restorableUntil": 4_102_444_800_000_i64,
                    "pendingSubscriptionCancellations": [],
                } }),
            )
        }
        _ => panic!("unexpected request {path}"),
    });
    let (manager, _, _directory) = signed_in(&server).await;
    manager.delete_account("a@example.test").await.unwrap();
    // Already signed out locally; the request must fail cleanly rather than
    // pretend a second deletion happened.
    assert!(manager.delete_account("a@example.test").await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_deleted_account_reports_the_deadline_and_can_be_restored_explicitly() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let counter = attempts.clone();
    let server = Server::new(move |path| match path {
        "/v1/auth/login" => {
            if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                // First attempt: credentials are valid, but the account is
                // inside its deletion window. The deadline travels with the
                // refusal so the UI can offer recovery without another call.
                (
                    410,
                    json!({ "error": {
                        "code": "ACCOUNT_DELETED_RESTORABLE",
                        "message": "This account was deleted",
                        "details": { "restorableUntil": 4_102_444_800_000_i64 },
                    } }),
                )
            } else {
                (
                    200,
                    json!({ "data": {
                        "user": user("a"),
                        "session": session(),
                        "restored": true,
                    } }),
                )
            }
        }
        _ => panic!("unexpected request {path}"),
    });
    let directory = tempfile::tempdir().unwrap();
    let manager = SyncManager::new_with_token_store(
        &server.url,
        directory.path().join("sync.db"),
        Arc::new(MemoryTokens(Mutex::new(None))),
    )
    .unwrap();

    let refusal = manager.login("a@example.test", "password").await.unwrap_err();
    assert_eq!(refusal.api_code(), Some("ACCOUNT_DELETED_RESTORABLE"));
    match &refusal {
        SyncError::Api { details, .. } => {
            assert_eq!(
                details.as_ref().unwrap()["restorableUntil"],
                json!(4_102_444_800_000_i64)
            );
        }
        other => panic!("expected an API error, got {other:?}"),
    }

    let restored = manager
        .login_with_restore("a@example.test", "password", true)
        .await
        .unwrap();
    assert!(restored.authenticated);
    assert!(restored.restored);
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn export_returns_the_server_document_without_reshaping_it() {
    let server = Server::new(|path| match path {
        "/v1/auth/login" => (
            200,
            json!({ "data": { "user": user("a"), "session": session() } }),
        ),
        "/v1/account/export" => (
            200,
            json!({ "data": {
                "formatVersion": 1,
                "exportedAt": 1_700_000_000_000_i64,
                "account": { "id": "a", "email": "a@example.test" },
                "cloudSync": { "indexAvailable": false },
            } }),
        ),
        _ => panic!("unexpected request {path}"),
    });
    let (manager, _, _directory) = signed_in(&server).await;
    let document = manager.export_account().await.unwrap();
    assert_eq!(document["formatVersion"], json!(1));
    // `indexAvailable: false` must survive the trip: it means "the actor could
    // not answer", which is not the same as "you have no notes".
    assert_eq!(document["cloudSync"]["indexAvailable"], json!(false));
    assert!(document["account"].is_object());
}
