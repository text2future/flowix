//! Tests for the executor. Everything that does not need a network goes here;
//! the transfer paths are covered by `object_store_ops` and by the desktop
//! integration, so these focus on dispatch, error isolation and the conflict
//! naming rule — the parts where a mistake corrupts data rather than retrying.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use chrono::{FixedOffset, TimeZone, Utc};

use super::*;
use crate::reconcile::{
    Defer, DeferReason, DeleteLocal, Download, DownloadReason, ReconcilePlan, SyncAction, Tombstone,
};
use crate::state::{state_after_transfer, LocalSnapshot, PathState};
use crate::ObjectStoreCredentials;

/// In-memory notebook. Tracks archives and can be told to fail removal, which
/// is how the error path gets exercised without a network.
struct MemoryStore {
    files: Mutex<BTreeMap<String, Vec<u8>>>,
    archived: Mutex<Vec<(String, ArchiveReason)>>,
    blocked_paths: BTreeSet<String>,
    fail_remove: bool,
    edit_after_archive: bool,
}

impl MemoryStore {
    fn new(files: &[(&str, &[u8])]) -> Self {
        Self {
            files: Mutex::new(
                files
                    .iter()
                    .map(|(path, bytes)| ((*path).to_string(), bytes.to_vec()))
                    .collect(),
            ),
            archived: Mutex::new(Vec::new()),
            blocked_paths: BTreeSet::new(),
            fail_remove: false,
            edit_after_archive: false,
        }
    }

    fn with_blocked_paths(files: &[(&str, &[u8])], blocked_paths: &[&str]) -> Self {
        Self {
            blocked_paths: blocked_paths
                .iter()
                .map(|path| (*path).to_string())
                .collect(),
            ..Self::new(files)
        }
    }

    fn failing_remove(files: &[(&str, &[u8])]) -> Self {
        Self {
            fail_remove: true,
            ..Self::new(files)
        }
    }

    fn paths(&self) -> Vec<String> {
        self.files.lock().unwrap().keys().cloned().collect()
    }
}

impl LocalStore for MemoryStore {
    fn is_syncable_path(&self, path: &str) -> bool {
        !self.blocked_paths.contains(path)
    }

    fn read(&self, path: &str) -> Result<Option<LocalRead>, SyncError> {
        Ok(self.files.lock().unwrap().get(path).map(|bytes| LocalRead {
            bytes: bytes.clone(),
            stamp: LocalStamp {
                size: bytes.len() as u64,
                mtime_millis: 1_000,
            },
        }))
    }

    fn write(&self, path: &str, bytes: &[u8]) -> Result<LocalStamp, SyncError> {
        self.files
            .lock()
            .unwrap()
            .insert(path.to_string(), bytes.to_vec());
        Ok(LocalStamp {
            size: bytes.len() as u64,
            mtime_millis: 2_000,
        })
    }

    fn create_exclusive(&self, path: &str, bytes: &[u8]) -> Result<Option<LocalStamp>, SyncError> {
        let mut files = self.files.lock().unwrap();
        if files.contains_key(path) {
            return Ok(None);
        }
        files.insert(path.to_string(), bytes.to_vec());
        Ok(Some(LocalStamp {
            size: bytes.len() as u64,
            mtime_millis: 2_000,
        }))
    }

    fn archive(&self, path: &str, _bytes: &[u8], reason: ArchiveReason) -> Result<(), SyncError> {
        self.archived
            .lock()
            .unwrap()
            .push((path.to_string(), reason));
        if self.edit_after_archive {
            self.files
                .lock()
                .unwrap()
                .insert(path.to_string(), b"new edit".to_vec());
        }
        Ok(())
    }

    fn remove(&self, path: &str) -> Result<(), SyncError> {
        if self.fail_remove {
            return Err(SyncError::InvalidState("permission denied".into()));
        }
        self.files.lock().unwrap().remove(path);
        Ok(())
    }

    fn remove_if_unchanged(&self, path: &str, expected: &[u8]) -> Result<bool, SyncError> {
        let mut files = self.files.lock().unwrap();
        if files.get(path).map(Vec::as_slice) != Some(expected) {
            return Ok(false);
        }
        if self.fail_remove {
            return Err(SyncError::InvalidState("permission denied".into()));
        }
        files.remove(path);
        Ok(true)
    }
}

#[tokio::test]
async fn remote_delete_does_not_remove_an_edit_after_archive() {
    let mut store = MemoryStore::new(&[("note.md", b"old")]);
    store.edit_after_archive = true;
    let credentials = credentials();
    let context = ApplyContext {
        credential_resolver: &credentials,
        notebook_id: "nb_1",
        device_id: "device",
    };
    let outcome = apply(
        &crate::http::HttpClient::pinned(reqwest::Client::new()),
        &context,
        &store,
        &plan_of(vec![SyncAction::DeleteLocal(DeleteLocal {
            path: "note.md".into(),
        })]),
        &snapshot_with(&["note.md"]),
        Utc::now(),
    )
    .await;
    assert_eq!(
        store.files.lock().unwrap().get("note.md").unwrap(),
        b"new edit"
    );
    assert!(outcome.removed.is_empty());
    assert_eq!(outcome.failures.len(), 1);
}

fn credentials() -> ObjectStoreCredentials {
    ObjectStoreCredentials {
        backend_id: "r2-primary".into(),
        scheme: "s3-v4".into(),
        endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com".into(),
        bucket: "flowix-blobs".into(),
        region: "auto".into(),
        access_key_id: "parent-access-key".into(),
        secret_access_key: "parent-secret".into(),
        session_token: None,
        token_header: "x-amz-security-token".into(),
        meta_prefix: "x-amz-meta-".into(),
        prefix: "u/usr_abc12345/".into(),
        mode: "read-write".into(),
        expires_at: 1_800_000_000_000,
    }
}

fn snapshot_with(paths: &[&str]) -> LocalSnapshot {
    let mut snapshot = LocalSnapshot::default();
    for path in paths {
        snapshot.states.insert(
            (*path).to_string(),
            PathState {
                display_path: (*path).to_string(),
                ..state_after_transfer(*path, *path, "sha256:aa", 4, 1_000, 2_000, None)
            },
        );
    }
    snapshot
}

fn plan_of(actions: Vec<SyncAction>) -> ReconcilePlan {
    ReconcilePlan {
        actions,
        ..ReconcilePlan::default()
    }
}

/// Serves one canned response per request and hands back what the client sent.
///
/// The difference from [`object_server`] is what happens when the client sends
/// *fewer* requests than were queued: this one gives up and returns. A pass that
/// refuses to act is a legitimate outcome, and encoding it as "the test hangs"
/// is how a real regression gets ignored for a week.
fn object_server_recorded(
    responses: Vec<&'static str>,
) -> (String, std::thread::JoinHandle<Vec<String>>) {
    use std::io::{Read, Write};
    use std::time::{Duration, Instant};

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let thread = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut seen = Vec::new();
        for response in responses {
            let mut accepted = None;
            while Instant::now() < deadline {
                match listener.accept() {
                    Ok(connection) => {
                        accepted = Some(connection);
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("accept: {error}"),
                }
            }
            let Some((mut stream, _)) = accepted else {
                break;
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 2048];
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let count = stream.read(&mut buf).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&buf[..count]);
            }
            seen.push(String::from_utf8_lossy(&request).to_string());
            stream.write_all(response.as_bytes()).unwrap();
        }
        seen
    });
    (endpoint, thread)
}

fn object_server(responses: Vec<&'static str>) -> (String, std::thread::JoinHandle<()>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let thread = std::thread::spawn(move || {
        for response in responses {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 2048];
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let count = stream.read(&mut buf).unwrap();
                assert_ne!(count, 0);
                request.extend_from_slice(&buf[..count]);
            }
            stream.write_all(response.as_bytes()).unwrap();
        }
    });
    (endpoint, thread)
}

#[tokio::test]
async fn download_that_became_a_tombstone_preserves_local_bytes_and_baseline() {
    let (endpoint, server) = object_server(vec![
        "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nx-amz-meta-deleted: 1\r\nConnection: close\r\n\r\n",
    ]);
    let mut credentials = credentials();
    credentials.endpoint = endpoint;
    let local = MemoryStore::new(&[("note.md", b"local")]);
    let context = ApplyContext {
        credential_resolver: &credentials,
        notebook_id: "nb_1",
        device_id: "device",
    };
    let plan = plan_of(vec![SyncAction::Download(Download {
        path: "note.md".into(),
        reason: DownloadReason::RemoteNew,
        backup: None,
    })]);
    let outcome = apply(
        &crate::http::HttpClient::pinned(reqwest::Client::new()),
        &context,
        &local,
        &plan,
        &snapshot_with(&["note.md"]),
        Utc::now(),
    )
    .await;
    server.join().unwrap();
    assert_eq!(
        local.files.lock().unwrap().get("note.md").unwrap(),
        b"local"
    );
    assert!(outcome.states.is_empty());
    assert_eq!(outcome.failures.len(), 1);
    assert!(local.archived.lock().unwrap().is_empty());
}

/// The tombstone is conditional on the ETag the listing observed. If the object
/// was replaced between that listing and our `PUT`, the follow-up `HEAD` sees a
/// live object where we expected a tombstone: the baseline must survive so the
/// next pass can reconcile the winner instead of forgetting the path.
#[tokio::test]
async fn tombstone_replaced_before_head_does_not_remove_baseline() {
    let (endpoint, server) = object_server_recorded(vec![
        "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nx-amz-meta-deleted: 0\r\nConnection: close\r\n\r\n",
    ]);
    let mut credentials = credentials();
    credentials.endpoint = endpoint;
    let local = MemoryStore::new(&[]);
    let context = ApplyContext {
        credential_resolver: &credentials,
        notebook_id: "nb_1",
        device_id: "device",
    };
    let plan = plan_of(vec![SyncAction::WriteTombstone(Tombstone {
        path: "note.md".into(),
        expected_etag: Some("\"v1\"".into()),
    })]);
    let outcome = apply(
        &crate::http::HttpClient::pinned(reqwest::Client::new()),
        &context,
        &local,
        &plan,
        &snapshot_with(&["note.md"]),
        Utc::now(),
    )
    .await;
    let requests = server.join().unwrap();

    assert_eq!(requests.len(), 2, "one PUT, one HEAD");
    assert!(
        requests[0].to_lowercase().contains("if-match: \"v1\""),
        "the tombstone must carry the observed ETag: {}",
        requests[0]
    );
    assert!(outcome.removed.is_empty());
    assert_eq!(outcome.failures.len(), 1);
    assert!(outcome.failures[0]
        .message
        .contains("deletion remains pending"));
}

/// A `412` is the server telling us the object moved under the tombstone. There
/// is nothing to verify afterwards — the conditional write never applied — so
/// the pass must stop there and leave the path pending rather than issue a
/// `HEAD` that would read the winner as evidence of a completed deletion.
#[tokio::test]
async fn a_rejected_conditional_tombstone_keeps_the_path_pending() {
    let (endpoint, server) = object_server_recorded(vec![
        "HTTP/1.1 412 Precondition Failed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    ]);
    let mut credentials = credentials();
    credentials.endpoint = endpoint;
    let local = MemoryStore::new(&[]);
    let context = ApplyContext {
        credential_resolver: &credentials,
        notebook_id: "nb_1",
        device_id: "device",
    };
    let plan = plan_of(vec![SyncAction::WriteTombstone(Tombstone {
        path: "note.md".into(),
        expected_etag: Some("\"v1\"".into()),
    })]);
    let outcome = apply(
        &crate::http::HttpClient::pinned(reqwest::Client::new()),
        &context,
        &local,
        &plan,
        &snapshot_with(&["note.md"]),
        Utc::now(),
    )
    .await;
    let requests = server.join().unwrap();

    assert_eq!(
        requests.len(),
        1,
        "a rejected PUT is never followed by a HEAD"
    );
    assert!(outcome.removed.is_empty());
    assert_eq!(outcome.failures.len(), 1);
    assert_eq!(outcome.failures[0].kind, FailureKind::Transient);
}

/// Without an observed ETag there is no safe conditional write, and an
/// unconditional one could delete a version this device never saw. The refusal
/// happens before any request leaves the process.
#[tokio::test]
async fn a_tombstone_without_an_observed_etag_is_refused_locally() {
    let mut credentials = credentials();
    // Port 9 is the discard port: nothing listens, so an accidental request
    // shows up as a connection error instead of a silent success.
    credentials.endpoint = "http://127.0.0.1:9".into();
    let local = MemoryStore::new(&[]);
    let context = ApplyContext {
        credential_resolver: &credentials,
        notebook_id: "nb_1",
        device_id: "device",
    };
    let plan = plan_of(vec![SyncAction::WriteTombstone(Tombstone {
        path: "note.md".into(),
        expected_etag: None,
    })]);
    let outcome = apply(
        &crate::http::HttpClient::pinned(reqwest::Client::new()),
        &context,
        &local,
        &plan,
        &snapshot_with(&["note.md"]),
        Utc::now(),
    )
    .await;

    assert!(outcome.removed.is_empty());
    assert_eq!(outcome.failures.len(), 1);
    assert!(
        outcome.failures[0]
            .message
            .contains("without an observed remote ETag"),
        "unexpected failure: {}",
        outcome.failures[0].message
    );
}

#[tokio::test]
async fn interrupted_or_corrupt_download_leaves_local_state_untouched() {
    for response in [
        // The server closes before the declared response body is complete.
        "HTTP/1.1 200 OK\r\nContent-Length: 10\r\nx-amz-meta-deleted: 0\r\nConnection: close\r\n\r\nshort",
        // A complete response with metadata for different bytes.
        "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nx-amz-meta-deleted: 0\r\nx-amz-meta-contenthash: sha256:wrong\r\nConnection: close\r\n\r\nshort",
        // A complete object without the required integrity metadata.
        "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nx-amz-meta-deleted: 0\r\nConnection: close\r\n\r\nshort",
    ] {
        let (endpoint, server) = object_server(vec![
            response,
            "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nx-amz-meta-deleted: 0\r\nx-amz-meta-contenthash: sha256:f9b0078b5df596d2ea19010c001bbd009e651de2c57e8fb7e355f31eb9d3f739\r\nConnection: close\r\n\r\nshort",
        ]);
        let mut credentials = credentials();
        credentials.endpoint = endpoint;
        let local = MemoryStore::new(&[("note.md", b"local")]);
        let context = ApplyContext {
            credential_resolver: &credentials,
            notebook_id: "nb_1",
            device_id: "device",
        };
        let plan = plan_of(vec![SyncAction::Download(Download {
            path: "note.md".into(),
            reason: DownloadReason::RemoteNew,
            backup: None,
        })]);
        let outcome = apply(
            &crate::http::HttpClient::pinned(reqwest::Client::new()),
            &context,
            &local,
            &plan,
            &snapshot_with(&["note.md"]),
            Utc::now(),
        )
        .await;
        assert_eq!(
            local.files.lock().unwrap().get("note.md").unwrap(),
            b"local"
        );
        assert!(outcome.states.is_empty());
        assert_eq!(outcome.failures.len(), 1);
        assert!(local.archived.lock().unwrap().is_empty());
        let retry = apply(
            &crate::http::HttpClient::pinned(reqwest::Client::new()),
            &context,
            &local,
            &plan,
            &snapshot_with(&["note.md"]),
            Utc::now(),
        )
        .await;
        server.join().unwrap();
        assert!(retry.succeeded());
        assert_eq!(retry.states.len(), 1);
        assert_eq!(
            local.files.lock().unwrap().get("note.md").unwrap(),
            b"short"
        );
    }
}

#[test]
fn object_key_is_scoped_by_notebook() {
    assert_eq!(object_key("nb_1", "notes/a.md"), "nb/nb_1/f/notes/a.md");
    assert_eq!(
        object_key("nb_1", "attachments/x.png"),
        "nb/nb_1/f/attachments/x.png"
    );
}

#[test]
fn content_hash_is_a_labelled_sha256() {
    // sha256("") — the value every empty-body signature uses.
    assert_eq!(
        content_hash(b""),
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(content_hash(b"a"), content_hash(b"a"));
    assert_ne!(content_hash(b"a"), content_hash(b"b"));
}

#[test]
fn conflict_names_read_like_a_human_wrote_them() {
    let at = FixedOffset::east_opt(8 * 3600)
        .unwrap()
        .with_ymd_and_hms(2026, 11, 22, 19, 56, 20)
        .unwrap();

    assert_eq!(
        conflict_copy_path("notes/Q4 规划.md", "mac-7f3a", at, 1),
        "notes/Q4 规划 (冲突 2026-11-22 19-56-20 mac-7f3a).md"
    );
    // Second conflict in the same second: the suffix is what keeps the first
    // copy from being overwritten.
    assert_eq!(
        conflict_copy_path("notes/Q4 规划.md", "mac-7f3a", at, 2),
        "notes/Q4 规划 (冲突 2026-11-22 19-56-20 mac-7f3a 2).md"
    );
    // Dots inside the stem belong to the stem.
    assert_eq!(
        conflict_copy_path("a.b.md", "mac-7f3a", at, 1),
        "a.b (冲突 2026-11-22 19-56-20 mac-7f3a).md"
    );
    // A dot in a *directory* is not an extension.
    assert_eq!(
        conflict_copy_path("notes.d/file", "mac-7f3a", at, 1),
        "notes.d/file (冲突 2026-11-22 19-56-20 mac-7f3a)"
    );
    // A dotfile has no stem, so it must not lose its name.
    assert_eq!(
        conflict_copy_path(".env", "mac-7f3a", at, 1),
        ".env (冲突 2026-11-22 19-56-20 mac-7f3a)"
    );
}

/// The label follows the machine's clock, not UTC: a person reads this name.
#[test]
fn conflict_names_use_the_given_offset() {
    let utc_evening = Utc.with_ymd_and_hms(2026, 11, 22, 11, 56, 20).unwrap();
    let shanghai = FixedOffset::east_opt(8 * 3600).unwrap();
    assert!(
        conflict_copy_path("a.md", "d", utc_evening.with_timezone(&shanghai), 1)
            .contains("19-56-20")
    );
    assert!(conflict_copy_path("a.md", "d", utc_evening.fixed_offset(), 1).contains("11-56-20"));
}

/// A delete is the only action that touches the notebook without a network, so
/// it is the one place the executor's dispatch can be checked end to end.
#[tokio::test]
async fn delete_archives_then_removes_and_drops_the_row() {
    let store = MemoryStore::new(&[("notes/a.md", b"aaaa")]);
    let snapshot = snapshot_with(&["notes/a.md"]);
    let plan = plan_of(vec![SyncAction::DeleteLocal(DeleteLocal {
        path: "notes/a.md".into(),
    })]);

    let credentials = credentials();
    let context = ApplyContext {
        credential_resolver: &credentials,
        notebook_id: "nb_1",
        device_id: "mac-7f3a",
    };
    let outcome = apply(
        &crate::http::HttpClient::pinned(reqwest::Client::new()),
        &context,
        &store,
        &plan,
        &snapshot,
        Utc::now(),
    )
    .await;

    assert!(outcome.succeeded());
    assert_eq!(outcome.removed, vec!["notes/a.md"]);
    assert!(store.paths().is_empty(), "the file is gone");
    assert_eq!(
        store.archived.lock().unwrap().as_slice(),
        &[("notes/a.md".to_string(), ArchiveReason::RemoteDeletion)],
        "bytes are archived before removal so the note can be restored in place"
    );
}

#[tokio::test]
async fn excluded_remote_path_is_rejected_before_local_delete_or_archive() {
    let store = MemoryStore::with_blocked_paths(
        &[("notes/.index.yaml", b"local configuration")],
        &["notes/.index.yaml"],
    );
    let snapshot = snapshot_with(&["notes/.index.yaml"]);
    let plan = plan_of(vec![SyncAction::DeleteLocal(DeleteLocal {
        path: "notes/.index.yaml".into(),
    })]);

    let credentials = credentials();
    let context = ApplyContext {
        credential_resolver: &credentials,
        notebook_id: "nb_1",
        device_id: "mac-7f3a",
    };
    let outcome = apply(
        &crate::http::HttpClient::pinned(reqwest::Client::new()),
        &context,
        &store,
        &plan,
        &snapshot,
        Utc::now(),
    )
    .await;

    assert_eq!(store.paths(), ["notes/.index.yaml"]);
    assert!(store.archived.lock().unwrap().is_empty());
    assert_eq!(outcome.failures.len(), 1);
    assert!(outcome.failures[0]
        .message
        .contains("excluded by the local notebook sync policy"));
}

/// One failing path must not stop the others: a locked file would otherwise
/// block the whole notebook forever.
#[test]
fn a_failing_action_is_recorded_without_aborting_the_pass() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let store = MemoryStore::failing_remove(&[("notes/a.md", b"aaaa"), ("notes/b.md", b"bbbb")]);
    let snapshot = snapshot_with(&["notes/a.md", "notes/b.md"]);
    let plan = plan_of(vec![
        SyncAction::DeleteLocal(DeleteLocal {
            path: "notes/a.md".into(),
        }),
        SyncAction::DeleteLocal(DeleteLocal {
            path: "notes/b.md".into(),
        }),
    ]);

    let credentials = credentials();
    let context = ApplyContext {
        credential_resolver: &credentials,
        notebook_id: "nb_1",
        device_id: "mac-7f3a",
    };
    let outcome = runtime.block_on(apply(
        &crate::http::HttpClient::pinned(reqwest::Client::new()),
        &context,
        &store,
        &plan,
        &snapshot,
        Utc::now(),
    ));

    assert!(!outcome.succeeded());
    assert_eq!(outcome.failures.len(), 2, "both were attempted");
    assert_eq!(outcome.failures[0].path, "notes/a.md");
    assert!(outcome.failures[0].message.contains("permission denied"));
    assert!(outcome.removed.is_empty(), "nothing is claimed as done");
    assert_eq!(store.paths().len(), 2, "the files are untouched");
}

#[test]
fn deferring_costs_nothing_and_reports_success() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let store = MemoryStore::new(&[]);
    let plan = plan_of(vec![SyncAction::Defer(Defer {
        path: "notes/a.md".into(),
        reason: DeferReason::RemoteUnknown,
    })]);

    let credentials = credentials();
    let context = ApplyContext {
        credential_resolver: &credentials,
        notebook_id: "nb_1",
        device_id: "mac-7f3a",
    };
    let outcome = runtime.block_on(apply(
        &crate::http::HttpClient::pinned(reqwest::Client::new()),
        &context,
        &store,
        &plan,
        &LocalSnapshot::default(),
        Utc::now(),
    ));

    assert!(outcome.succeeded());
    assert!(outcome.states.is_empty());
    assert!(outcome.failures.is_empty());
    assert!(
        store.archived.lock().unwrap().is_empty(),
        "nothing is archived for a defer"
    );
}

/// Two devices that "both changed" a file can produce identical bytes. Copying
/// them aside would leave the user a conflict file with nothing to reconcile.
#[test]
fn identical_content_earns_no_conflict_copy() {
    assert!(!keep_conflict_copy(b"same", &content_hash(b"same")));
    assert!(keep_conflict_copy(b"same", &content_hash(b"diff")));
    // Same length is not enough: this is exactly the case a size check misses.
    assert!(keep_conflict_copy(b"aaaa", &content_hash(b"aaab")));
}

#[tokio::test]
async fn independent_uploads_overlap_and_checkpoint_each_completion() {
    use crate::reconcile::{Upload, UploadReason};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::Duration;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let server = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut puts = Vec::new();
        while puts.len() < 2 && std::time::Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut data = [0; 2048];
                    let count = stream.read(&mut data).unwrap();
                    assert!(String::from_utf8_lossy(&data[..count]).starts_with("PUT "));
                    puts.push(stream);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(error) => panic!("accept: {error}"),
            }
        }
        assert_eq!(
            puts.len(),
            2,
            "both PUTs should start before either completes"
        );
        for mut stream in puts {
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .unwrap();
        }
        let hash = content_hash(b"same");
        let mut heads = 0;
        while heads < 2 && std::time::Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut data = [0; 2048];
                    let count = stream.read(&mut data).unwrap();
                    assert!(String::from_utf8_lossy(&data[..count]).starts_with("HEAD "));
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nx-amz-meta-contenthash: {hash}\r\nLast-Modified: Wed, 21 Oct 2015 07:28:00 GMT\r\nConnection: close\r\n\r\n").unwrap();
                    heads += 1;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(error) => panic!("accept: {error}"),
            }
        }
        assert_eq!(heads, 2);
    });
    let mut credentials = credentials();
    credentials.endpoint = endpoint;
    let local = MemoryStore::new(&[("a.md", b"same"), ("b.md", b"same")]);
    let context = ApplyContext {
        credential_resolver: &credentials,
        notebook_id: "nb_1",
        device_id: "device",
    };
    let plan = plan_of(
        ["a.md", "b.md"]
            .into_iter()
            .map(|path| {
                SyncAction::Upload(Upload {
                    path: path.into(),
                    reason: UploadReason::New,
                })
            })
            .collect(),
    );
    let mut checkpoints = Vec::new();
    let sizes = BTreeMap::from([("a.md".to_string(), 4), ("b.md".to_string(), 4)]);
    let outcome = apply_with_checkpoint_and_sizes(
        &crate::http::HttpClient::pinned(reqwest::Client::new()),
        &context,
        &local,
        &plan,
        &LocalSnapshot::default(),
        Utc::now(),
        &mut |outcome| {
            checkpoints.push(outcome.states.len());
            Ok(())
        },
        Some(&sizes),
    )
    .await;
    server.join().unwrap();
    assert!(outcome.failures.is_empty(), "{:?}", outcome.failures);
    assert_eq!(outcome.states.len(), 2);
    assert_eq!(checkpoints, vec![1, 2]);
}

#[tokio::test]
async fn downloads_overlap_but_apply_and_checkpoint_in_plan_order() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::Duration;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let server = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut requests = BTreeMap::new();
        while requests.len() < 2 && std::time::Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut data = [0; 2048];
                    let count = stream.read(&mut data).unwrap();
                    let request = String::from_utf8_lossy(&data[..count]);
                    assert!(request.starts_with("GET "));
                    let name = if request.contains("a.md") { "a" } else { "b" };
                    requests.insert(name, stream);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(error) => panic!("accept: {error}"),
            }
        }
        assert_eq!(
            requests.len(),
            2,
            "both GETs must start before either completes"
        );
        let hash = content_hash(b"same");
        // Reply to the later action first; application must still follow the plan.
        for name in ["b", "a"] {
            let mut stream = requests.remove(name).unwrap();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nx-amz-meta-contenthash: {hash}\r\nLast-Modified: Wed, 21 Oct 2015 07:28:00 GMT\r\nConnection: close\r\n\r\nsame").unwrap();
        }
    });
    let mut credentials = credentials();
    credentials.endpoint = endpoint;
    let local = MemoryStore::new(&[]);
    let context = ApplyContext {
        credential_resolver: &credentials,
        notebook_id: "nb_1",
        device_id: "device",
    };
    let plan = plan_of(
        ["a.md", "b.md"]
            .into_iter()
            .map(|path| {
                SyncAction::Download(Download {
                    path: path.into(),
                    reason: DownloadReason::NewToDevice,
                    backup: None,
                })
            })
            .collect(),
    );
    let mut checkpoints = Vec::new();
    let sizes = BTreeMap::from([("a.md".to_string(), 4), ("b.md".to_string(), 4)]);
    let outcome = apply_with_checkpoint_and_sizes(
        &crate::http::HttpClient::pinned(reqwest::Client::new()),
        &context,
        &local,
        &plan,
        &LocalSnapshot::default(),
        Utc::now(),
        &mut |outcome| {
            checkpoints.push(outcome.states.last().unwrap().path.clone());
            Ok(())
        },
        Some(&sizes),
    )
    .await;
    server.join().unwrap();
    assert!(outcome.failures.is_empty(), "{:?}", outcome.failures);
    assert_eq!(checkpoints, ["a.md", "b.md"]);
    assert_eq!(local.paths(), ["a.md", "b.md"]);
}

#[tokio::test]
async fn failed_download_does_not_block_an_independent_success() {
    let success = "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nx-amz-meta-contenthash: sha256:0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5\r\nConnection: close\r\n\r\nsame";
    let (endpoint, server) = object_server(vec![
        "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        success,
    ]);
    let mut credentials = credentials();
    credentials.endpoint = endpoint;
    let local = MemoryStore::new(&[]);
    let context = ApplyContext {
        credential_resolver: &credentials,
        notebook_id: "nb_1",
        device_id: "device",
    };
    let plan = plan_of(
        ["a.md", "b.md"]
            .into_iter()
            .map(|path| {
                SyncAction::Download(Download {
                    path: path.into(),
                    reason: DownloadReason::NewToDevice,
                    backup: None,
                })
            })
            .collect(),
    );
    let mut checkpoints = 0;
    let outcome = apply_with_checkpoint(
        &crate::http::HttpClient::pinned(reqwest::Client::new()),
        &context,
        &local,
        &plan,
        &LocalSnapshot::default(),
        Utc::now(),
        &mut |_| {
            checkpoints += 1;
            Ok(())
        },
    )
    .await;
    server.join().unwrap();
    assert_eq!(outcome.failures.len(), 1);
    assert_eq!(outcome.states.len(), 1);
    assert_eq!(local.paths().len(), 1);
    assert_eq!(checkpoints, 1);
}

#[tokio::test]
async fn download_preserves_edit_made_while_request_is_in_flight() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::time::Duration;

    let local = Arc::new(MemoryStore::new(&[("a.md", b"old")]));
    let server_local = local.clone();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut request = [0; 2048];
        let count = stream.read(&mut request).unwrap();
        assert!(String::from_utf8_lossy(&request[..count]).starts_with("GET "));
        server_local
            .files
            .lock()
            .unwrap()
            .insert("a.md".into(), b"new local edit".to_vec());
        let hash = content_hash(b"same");
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nx-amz-meta-contenthash: {hash}\r\nConnection: close\r\n\r\nsame").unwrap();
    });
    let mut credentials = credentials();
    credentials.endpoint = endpoint;
    let context = ApplyContext {
        credential_resolver: &credentials,
        notebook_id: "nb_1",
        device_id: "device",
    };
    let plan = plan_of(vec![SyncAction::Download(Download {
        path: "a.md".into(),
        reason: DownloadReason::RemoteNew,
        backup: None,
    })]);
    let outcome = apply(
        &crate::http::HttpClient::pinned(reqwest::Client::new()),
        &context,
        local.as_ref(),
        &plan,
        &snapshot_with(&["a.md"]),
        Utc::now(),
    )
    .await;
    server.join().unwrap();
    assert_eq!(
        local.files.lock().unwrap().get("a.md").unwrap(),
        b"new local edit"
    );
    assert!(outcome.states.is_empty());
    assert_eq!(outcome.failures.len(), 1);
}

#[tokio::test]
async fn large_or_unknown_uploads_do_not_overlap_other_uploads() {
    use crate::reconcile::{Upload, UploadReason};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::Duration;

    for known_large in [true, false] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let hash = content_hash(b"same");
            for method in ["PUT", "HEAD", "PUT", "HEAD"] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut data = [0; 2048];
                let count = stream.read(&mut data).unwrap();
                assert!(String::from_utf8_lossy(&data[..count]).starts_with(method));
                if method == "HEAD" {
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nx-amz-meta-contenthash: {hash}\r\nConnection: close\r\n\r\n").unwrap();
                } else {
                    stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        )
                        .unwrap();
                }
            }
        });
        let mut credentials = credentials();
        credentials.endpoint = endpoint;
        let local = MemoryStore::new(&[("a.md", b"same"), ("b.md", b"same")]);
        let context = ApplyContext {
            credential_resolver: &credentials,
            notebook_id: "nb_1",
            device_id: "device",
        };
        let plan = plan_of(
            ["a.md", "b.md"]
                .into_iter()
                .map(|path| {
                    SyncAction::Upload(Upload {
                        path: path.into(),
                        reason: UploadReason::New,
                    })
                })
                .collect(),
        );
        let mut sizes = BTreeMap::from([("b.md".to_string(), 4)]);
        if known_large {
            sizes.insert("a.md".into(), TRANSFER_BATCH_BYTES + 1);
        }
        let outcome = apply_with_checkpoint_and_sizes(
            &crate::http::HttpClient::pinned(reqwest::Client::new()),
            &context,
            &local,
            &plan,
            &LocalSnapshot::default(),
            Utc::now(),
            &mut |_| Ok(()),
            Some(&sizes),
        )
        .await;
        server.join().unwrap();
        assert!(outcome.failures.is_empty(), "{:?}", outcome.failures);
        assert_eq!(outcome.states.len(), 2);
    }
}
