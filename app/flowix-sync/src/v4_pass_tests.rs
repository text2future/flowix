//! Tests for the pass orchestrator.
//!
//! The wiring is where each earlier decision gets its inputs, and the inputs
//! are where the design quietly breaks: a listing that failed being read as an
//! empty directory, a tombstone read as an empty note, a probe answered after
//! the decision was made. None of those show up in `reconcile`'s table, so they
//! are asserted here against a fake bucket.
//!
//! No network: `ObjectSource` is the seam, and the only pass that runs end to
//! end does deletions, which touch nothing but the notebook on disk.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use chrono::{TimeZone, Utc};

use super::*;
use crate::object_store::{ListedObject, StorageQuota};
use crate::reconcile::{Baseline, DirScanRecord, SyncAction, Upload, UploadReason};
use crate::v4::{credential_fingerprint, ScannedLocalFile, V4NotebookState, V4PathState};
use crate::v4_apply::{object_key, ArchiveReason, LocalRead, LocalStamp};

const NB: &str = "nb_notes";
/// 2026-11-22T12:00:00Z. A round number because `LastModified` is
/// second-granular, so nothing finer can round-trip anyway.
const NOW: i64 = 1_795_377_600_000;
const MINUTE: i64 = 60_000;

struct FakeObject {
    size: u64,
    mtime: i64,
    tombstone: bool,
    content_hash: Option<String>,
}

#[derive(Default)]
struct FakeBucket {
    objects: BTreeMap<String, FakeObject>,
    /// The `Date` header the backend reports. `None` simulates a gateway that
    /// strips it, which must not be read as "no clock needed".
    date_millis: Option<i64>,
    /// Prefixes whose listing returns a 500.
    fail_prefixes: BTreeSet<String>,
    /// Keys whose `HEAD` returns a 500.
    fail_heads: BTreeSet<String>,
    page_size: usize,
    list_calls: Vec<(String, Option<String>)>,
    head_calls: Vec<String>,
    puts: Vec<(String, Vec<u8>)>,
    fail_put: bool,
}

impl FakeBucket {
    fn new() -> Self {
        Self {
            date_millis: Some(NOW),
            page_size: 1000,
            ..Default::default()
        }
    }

    fn file(mut self, path: &str, size: u64, mtime: i64) -> Self {
        self.objects.insert(
            object_key(NB, path),
            FakeObject {
                size,
                mtime,
                tombstone: false,
                content_hash: Some(format!("sha256:{path}")),
            },
        );
        self
    }

    fn tombstone(mut self, path: &str, mtime: i64) -> Self {
        self.objects.insert(
            object_key(NB, path),
            FakeObject {
                size: 0,
                mtime,
                tombstone: true,
                content_hash: None,
            },
        );
        self
    }

    fn stamp(mut self, dir: &str, mtime: i64) -> Self {
        self.objects.insert(
            stamp_key(NB, dir),
            FakeObject {
                size: 48,
                mtime,
                tombstone: false,
                content_hash: None,
            },
        );
        self
    }

    fn date(mut self, millis: Option<i64>) -> Self {
        self.date_millis = millis;
        self
    }

    fn failing_list(mut self, prefix: &str) -> Self {
        self.fail_prefixes.insert(prefix.to_string());
        self
    }

    fn failing_head(mut self, path: &str) -> Self {
        self.fail_heads.insert(object_key(NB, path));
        self
    }

    fn listed(&self) -> Vec<&str> {
        self.list_calls
            .iter()
            .map(|(prefix, _)| prefix.as_str())
            .collect()
    }
}

fn rfc1123(millis: i64) -> String {
    Utc.timestamp_millis_opt(millis)
        .unwrap()
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string()
}

fn object_list_error() -> SyncError {
    SyncError::Api {
        status: 500,
        code: "OBJECT_STORE_LIST_FAILED".to_string(),
        message: "upstream exploded".to_string(),
        details: None,
    }
}

impl ObjectSource for FakeBucket {
    fn list(
        &mut self,
        prefix: String,
        cursor: Option<String>,
        delimiter: Option<String>,
    ) -> BoxFuture<'_, Result<ListPage, SyncError>> {
        self.list_calls.push((prefix.clone(), delimiter.clone()));
        let result = if self
            .fail_prefixes
            .iter()
            .any(|failed| prefix.starts_with(failed.as_str()))
        {
            Err(object_list_error())
        } else {
            let matching: Vec<&String> = self
                .objects
                .keys()
                .filter(|key| key.starts_with(prefix.as_str()))
                .filter(|key| match delimiter.as_deref() {
                    // One directory means direct children only: everything
                    // after the prefix must contain no separator.
                    Some("/") => !key[prefix.len()..].contains('/'),
                    _ => true,
                })
                .collect();
            let total = matching.len();
            let offset: usize = cursor.and_then(|value| value.parse().ok()).unwrap_or(0);
            let page: Vec<ListedObject> = matching
                .into_iter()
                .skip(offset)
                .take(self.page_size)
                .map(|key| {
                    let object = &self.objects[key];
                    ListedObject {
                        key: key.clone(),
                        last_modified: rfc1123(object.mtime),
                        size: object.size,
                        etag: format!("\"{}\"", key.len()),
                    }
                })
                .collect();
            let consumed = offset + page.len();
            let next_cursor = if consumed < total {
                Some(format!("{consumed}"))
            } else {
                None
            };
            Ok(ListPage {
                objects: page,
                common_prefixes: Vec::new(),
                next_cursor,
                server_date_millis: self.date_millis,
            })
        };
        Box::pin(async move { result })
    }

    fn head(&mut self, key: String) -> BoxFuture<'_, Result<Option<RemoteObject>, SyncError>> {
        self.head_calls.push(key.clone());
        let result = if self.fail_heads.contains(&key) {
            Err(SyncError::Api {
                status: 500,
                code: "OBJECT_STORE_HEAD_FAILED".to_string(),
                message: "upstream exploded".to_string(),
                details: None,
            })
        } else {
            Ok(self.objects.get(&key).map(|object| RemoteObject {
                path: key.clone(),
                mtime_millis: object.mtime,
                size: object.size,
                content_hash: object.content_hash.clone(),
                etag: None,
                tombstone: object.tombstone,
            }))
        };
        Box::pin(async move { result })
    }

    fn put(&mut self, key: String, body: Vec<u8>) -> BoxFuture<'_, Result<(), SyncError>> {
        self.puts.push((key.clone(), body));
        if self.fail_put {
            return Box::pin(async { Err(object_list_error()) });
        }
        // Writing a stamp moves its `LastModified`, which is the only thing
        // another device's gate reads.
        let date = self.date_millis.unwrap_or(NOW);
        self.objects.insert(
            key.to_string(),
            FakeObject {
                size: 48,
                mtime: date,
                tombstone: false,
                content_hash: None,
            },
        );
        Box::pin(async { Ok(()) })
    }
}

/// In-memory notebook, the same shape as the one in `v4_apply_tests`.
struct MemoryLocal {
    files: Mutex<BTreeMap<String, Vec<u8>>>,
    archived: Mutex<Vec<String>>,
}

impl MemoryLocal {
    fn new(paths: &[&str]) -> Self {
        Self {
            files: Mutex::new(
                paths
                    .iter()
                    .map(|path| ((*path).to_string(), vec![b'x'; 8]))
                    .collect(),
            ),
            archived: Mutex::new(Vec::new()),
        }
    }
}

impl LocalStore for MemoryLocal {
    fn is_syncable_path(&self, _path: &str) -> bool {
        true
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

    fn archive(&self, path: &str, _bytes: &[u8], _reason: ArchiveReason) -> Result<(), SyncError> {
        self.archived.lock().unwrap().push(path.to_string());
        Ok(())
    }

    fn remove(&self, path: &str) -> Result<(), SyncError> {
        self.files.lock().unwrap().remove(path);
        Ok(())
    }

    fn remove_if_unchanged(&self, path: &str, expected: &[u8]) -> Result<bool, SyncError> {
        let mut files = self.files.lock().unwrap();
        if files.get(path).map(Vec::as_slice) != Some(expected) {
            return Ok(false);
        }
        files.remove(path);
        Ok(true)
    }
}

fn credentials() -> ObjectStoreCredentials {
    ObjectStoreCredentials {
        backend_id: "r2-primary".into(),
        scheme: "s3-v4".into(),
        endpoint: "https://0123456789abcdef.r2.cloudflarestorage.com".into(),
        bucket: "flowix-blobs".into(),
        region: "auto".into(),
        access_key_id: "parent".into(),
        secret_access_key: "derived".into(),
        session_token: None,
        token_header: "x-amz-security-token".into(),
        meta_prefix: "x-amz-meta-".into(),
        prefix: "u/usr_abc/".into(),
        mode: "read-write".into(),
        expires_at: NOW + 3_600_000,
    }
}

fn fingerprint(credentials: &ObjectStoreCredentials) -> String {
    credential_fingerprint(
        &credentials.backend_id,
        &credentials.bucket,
        &credentials.prefix,
    )
}

fn store_bound_to(credentials: &ObjectStoreCredentials) -> (tempfile::TempDir, SyncStore) {
    let temp = tempfile::tempdir().unwrap();
    let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
    store
        .v4_save_notebook_state(&V4NotebookState {
            notebook_id: NB.to_string(),
            grace_until: None,
            credential_fingerprint: fingerprint(credentials),
        })
        .unwrap();
    (temp, store)
}

fn path_state(path: &str, size: u64, mtime: i64, baseline: i64) -> V4PathState {
    V4PathState {
        path: path.to_string(),
        display_path: path.to_string(),
        content_hash: Some("sha256:old".to_string()),
        local_size: size,
        local_mtime_millis: mtime,
        last_synced_at: baseline,
        remote_etag: None,
        pending_since: None,
    }
}

fn scan(paths: &[(&str, u64, i64)]) -> Vec<ScannedLocalFile> {
    paths
        .iter()
        .map(|(path, size, mtime)| ScannedLocalFile::new(*path, *size, *mtime).unwrap())
        .collect()
}

fn pass_request<'a>(scanned: &'a [ScannedLocalFile], force: bool) -> PassRequest<'a> {
    PassRequest {
        notebook_id: NB,
        device_id: "mac-7f3a",
        scanned,
        force,
        quota: None,
    }
}

fn quiet_dir(dir: &str, stamp: i64, scanned_at: i64) -> BTreeMap<String, DirScanRecord> {
    [(
        dir.to_string(),
        DirScanRecord {
            stamp_millis: stamp,
            scanned_at_millis: scanned_at,
        },
    )]
    .into_iter()
    .collect()
}

fn tags(plan: &ReconcilePlan) -> Vec<&'static str> {
    plan.actions.iter().map(SyncAction::kind_tag).collect()
}

#[tokio::test]
async fn mass_remote_deletion_aborts_before_changing_existing_baselines() {
    let credentials = credentials();
    let (_temp, store) = store_bound_to(&credentials);
    let mut bucket = FakeBucket::new();
    let mut states = Vec::new();
    let mut scanned = Vec::new();
    for n in 0..20 {
        let path = format!("{n}.md");
        states.push(path_state(&path, 8, 1_000, NOW - MINUTE));
        scanned.push(ScannedLocalFile::new(&path, 8, 1_000).unwrap());
        bucket = bucket.tombstone(&path, NOW);
    }
    store.v4_save_path_states(NB, &states).unwrap();
    for _ in 0..2 {
        let error = plan_pass(
            &mut bucket,
            &credentials,
            &store,
            &pass_request(&scanned, true),
        )
        .await
        .err()
        .expect("mass deletion must be blocked");
        assert!(error.to_string().contains("CLOUD_MASS_DELETE_BLOCKED"));
        assert_eq!(store.v4_snapshot(NB).unwrap().states.len(), 20);
        assert!(bucket.puts.is_empty());
    }
}

#[tokio::test]
async fn a_quiet_pass_pays_for_one_stamp_listing_and_nothing_else() {
    let credentials = credentials();
    let (_temp, store) = store_bound_to(&credentials);
    store
        .v4_save_path_states(NB, &[path_state("notes/a.md", 8, 1_000, NOW - MINUTE)])
        .unwrap();
    // Scanned after the last write to the directory, so the same-second race
    // is settled and the stamp has nothing new to say.
    store
        .v4_save_dir_scans(NB, &quiet_dir("notes", NOW - 5 * MINUTE, NOW - 4 * MINUTE))
        .unwrap();

    let mut bucket = FakeBucket::new()
        .file("notes/a.md", 8, NOW - MINUTE)
        .stamp("notes", NOW - 5 * MINUTE);
    let scanned = scan(&[("notes/a.md", 8, 1_000)]);
    let prepared = plan_pass(
        &mut bucket,
        &credentials,
        &store,
        &pass_request(&scanned, false),
    )
    .await
    .unwrap();

    assert_eq!(
        bucket.listed(),
        vec![stamp_prefix(NB).as_str()],
        "only the s/ listing"
    );
    assert!(prepared.listed_dirs.is_empty(), "the stamp had not moved");
    assert!(prepared.plan.actions.is_empty());
    assert!(bucket.head_calls.is_empty());
}

#[tokio::test]
async fn a_stamp_that_moved_lists_exactly_that_directory() {
    let credentials = credentials();
    let (_temp, store) = store_bound_to(&credentials);
    store
        .v4_save_path_states(NB, &[path_state("notes/a.md", 8, 1_000, NOW - MINUTE)])
        .unwrap();
    let mut records = quiet_dir("notes", NOW - 5 * MINUTE, NOW - 5 * MINUTE);
    // `archive` was scanned long after its stamp was written: settled.
    records.extend(quiet_dir("archive", NOW - 5 * MINUTE, NOW - 4 * MINUTE));
    store.v4_save_dir_scans(NB, &records).unwrap();

    let mut bucket = FakeBucket::new()
        .file("notes/a.md", 8, NOW - MINUTE)
        .file("archive/b.md", 8, NOW - MINUTE)
        .stamp("notes", NOW)
        .stamp("archive", NOW - 5 * MINUTE);
    let scanned = scan(&[("notes/a.md", 8, 1_000)]);
    let prepared = plan_pass(
        &mut bucket,
        &credentials,
        &store,
        &pass_request(&scanned, false),
    )
    .await
    .unwrap();

    assert_eq!(
        bucket.listed(),
        vec![stamp_prefix(NB).as_str(), "nb/nb_notes/f/notes/"],
        "only the directory whose stamp moved",
    );
    // The delimiter is what keeps `f/notes/` from also returning `f/notes/deep/*`.
    assert_eq!(bucket.list_calls[1].1.as_deref(), Some("/"));
    assert_eq!(prepared.listed_dirs, vec!["notes"]);
    assert!(
        prepared.plan.actions.is_empty(),
        "same size, same stamp: converged"
    );
}

/// A tombstone is zero bytes and a `list` returns no metadata, so without the
/// `HEAD` it reads as an empty note and the download overwrites the note with
/// nothing.
#[tokio::test]
async fn a_tombstone_is_resolved_by_head_before_it_can_be_downloaded() {
    let credentials = credentials();
    let (_temp, store) = store_bound_to(&credentials);
    store
        .v4_save_path_states(NB, &[path_state("notes/a.md", 8, 1_000, NOW - MINUTE)])
        .unwrap();

    let mut bucket = FakeBucket::new()
        .tombstone("notes/a.md", NOW)
        .stamp("notes", NOW);
    let scanned = scan(&[("notes/a.md", 8, 1_000)]);
    let prepared = plan_pass(
        &mut bucket,
        &credentials,
        &store,
        &pass_request(&scanned, false),
    )
    .await
    .unwrap();

    assert_eq!(bucket.head_calls, vec![object_key(NB, "notes/a.md")]);
    assert!(prepared.listing.observed["notes/a.md"].tombstone);
    assert_eq!(tags(&prepared.plan), vec!["delete-local"]);
}

/// An empty note is also zero bytes; the same `HEAD` must leave it a file.
#[tokio::test]
async fn an_empty_note_is_not_mistaken_for_a_deletion() {
    let credentials = credentials();
    let (_temp, store) = store_bound_to(&credentials);
    store
        .v4_save_path_states(NB, &[path_state("notes/empty.md", 0, 1_000, NOW - MINUTE)])
        .unwrap();

    let mut bucket = FakeBucket::new()
        .file("notes/empty.md", 0, NOW - MINUTE)
        .stamp("notes", NOW);
    let scanned = scan(&[("notes/empty.md", 0, 1_000)]);
    let prepared = plan_pass(
        &mut bucket,
        &credentials,
        &store,
        &pass_request(&scanned, false),
    )
    .await
    .unwrap();

    assert_eq!(bucket.head_calls, vec![object_key(NB, "notes/empty.md")]);
    assert!(!prepared.listing.observed["notes/empty.md"].tombstone);
    assert!(prepared.plan.actions.is_empty());
}

/// A failed listing must not become "the directory is empty": that would
/// delete every local file in it.
#[tokio::test]
async fn a_failed_directory_listing_deletes_nothing() {
    let credentials = credentials();
    let (_temp, store) = store_bound_to(&credentials);
    store
        .v4_save_path_states(NB, &[path_state("notes/a.md", 8, 1_000, NOW - MINUTE)])
        .unwrap();
    store
        .v4_save_dir_scans(NB, &quiet_dir("notes", NOW - MINUTE, NOW - MINUTE))
        .unwrap();

    let mut bucket = FakeBucket::new()
        .stamp("notes", NOW)
        .failing_list("nb/nb_notes/f/notes/");
    let scanned = scan(&[("notes/a.md", 8, 1_000)]);
    let prepared = plan_pass(
        &mut bucket,
        &credentials,
        &store,
        &pass_request(&scanned, false),
    )
    .await
    .unwrap();

    assert!(
        !prepared.listing.observed_dirs.contains("notes"),
        "absence proves nothing here"
    );
    assert!(
        prepared.listed_dirs.is_empty(),
        "a failed listing is not a listing"
    );
    assert!(prepared.plan.actions.is_empty());
    assert_eq!(prepared.list_failures.len(), 1);
    assert_eq!(prepared.list_failures[0].path, "notes");
}

/// The probe exists so a blind dirty file neither clobbers a newer remote nor
/// waits a whole interval: its answer has to feed *this* pass.
#[tokio::test]
async fn a_probe_answer_is_judged_in_the_same_pass() {
    let credentials = credentials();
    let (_temp, store) = store_bound_to(&credentials);
    store
        .v4_save_path_states(NB, &[path_state("notes/a.md", 8, 1_000, NOW - MINUTE)])
        .unwrap();
    // Stamp unchanged since the last scan, so the directory is skipped and the
    // dirty file starts out "remote unknown".
    store
        .v4_save_dir_scans(NB, &quiet_dir("notes", NOW - 5 * MINUTE, NOW - 4 * MINUTE))
        .unwrap();

    let mut bucket = FakeBucket::new()
        .file("notes/a.md", 20, NOW)
        .stamp("notes", NOW - 5 * MINUTE);
    // Edited here: size and mtime both moved off the baseline.
    let scanned = scan(&[("notes/a.md", 20, 9_000)]);
    let prepared = plan_pass(
        &mut bucket,
        &credentials,
        &store,
        &pass_request(&scanned, false),
    )
    .await
    .unwrap();

    assert_eq!(bucket.head_calls, vec![object_key(NB, "notes/a.md")]);
    assert_eq!(
        tags(&prepared.plan),
        vec!["download:conflict"],
        "remote is newer, once probed"
    );
    assert_eq!(
        prepared.plan.stats.probes, 0,
        "the probe itself is not left in the plan"
    );
}

#[tokio::test]
async fn a_probe_404_turns_a_dirty_file_into_a_resurrection() {
    let credentials = credentials();
    let (_temp, store) = store_bound_to(&credentials);
    store
        .v4_save_path_states(NB, &[path_state("notes/gone.md", 8, 1_000, NOW - MINUTE)])
        .unwrap();
    store
        .v4_save_dir_scans(NB, &quiet_dir("notes", NOW - 5 * MINUTE, NOW - 4 * MINUTE))
        .unwrap();

    let mut bucket = FakeBucket::new().stamp("notes", NOW - 5 * MINUTE);
    let scanned = scan(&[("notes/gone.md", 20, 9_000)]);
    let prepared = plan_pass(
        &mut bucket,
        &credentials,
        &store,
        &pass_request(&scanned, false),
    )
    .await
    .unwrap();

    assert_eq!(tags(&prepared.plan), vec!["upload:resurrect"]);
}

/// A `HEAD` that failed is not a 404. Keeping the key unknown defers it a pass,
/// which is the only safe reading of an unreadable answer.
#[tokio::test]
async fn a_failed_probe_defers_instead_of_deciding() {
    let credentials = credentials();
    let (_temp, store) = store_bound_to(&credentials);
    store
        .v4_save_path_states(NB, &[path_state("notes/a.md", 8, 1_000, NOW - MINUTE)])
        .unwrap();
    store
        .v4_save_dir_scans(NB, &quiet_dir("notes", NOW - 5 * MINUTE, NOW - 4 * MINUTE))
        .unwrap();

    let mut bucket = FakeBucket::new()
        .stamp("notes", NOW - 5 * MINUTE)
        .failing_head("notes/a.md");
    let scanned = scan(&[("notes/a.md", 20, 9_000)]);
    let prepared = plan_pass(
        &mut bucket,
        &credentials,
        &store,
        &pass_request(&scanned, false),
    )
    .await
    .unwrap();

    assert!(prepared.plan.actions.is_empty());
    assert!(prepared.listing.unknown_keys.contains("notes/a.md"));
    assert_eq!(prepared.list_failures.len(), 1);
}

/// A local folder that exists nowhere in the bucket has no stamp, so a
/// stamp-only gate would never list it and its first note could never upload.
#[tokio::test]
async fn a_brand_new_local_directory_is_listed_even_without_a_stamp() {
    let credentials = credentials();
    let (_temp, store) = store_bound_to(&credentials);

    let mut bucket = FakeBucket::new();
    let scanned = scan(&[("brand-new/note.md", 8, 1_000)]);
    let prepared = plan_pass(
        &mut bucket,
        &credentials,
        &store,
        &pass_request(&scanned, false),
    )
    .await
    .unwrap();

    assert_eq!(
        bucket.listed(),
        vec![stamp_prefix(NB).as_str(), "nb/nb_notes/f/brand-new/"],
    );
    assert_eq!(tags(&prepared.plan), vec!["upload:new"]);
}

#[tokio::test]
async fn the_forced_sweep_enumerates_everything_in_one_listing() {
    let credentials = credentials();
    let (_temp, store) = store_bound_to(&credentials);
    store
        .v4_save_path_states(NB, &[path_state("notes/a.md", 8, 1_000, NOW - MINUTE)])
        .unwrap();
    store
        .v4_save_dir_scans(NB, &quiet_dir("notes", NOW - 5 * MINUTE, NOW - 4 * MINUTE))
        .unwrap();

    let mut bucket = FakeBucket::new()
        .file("notes/a.md", 8, NOW - MINUTE)
        .file("elsewhere/deep/b.md", 8, NOW - MINUTE)
        .stamp("notes", NOW - 5 * MINUTE);
    let scanned = scan(&[("notes/a.md", 8, 1_000)]);
    let prepared = plan_pass(
        &mut bucket,
        &credentials,
        &store,
        &pass_request(&scanned, true),
    )
    .await
    .unwrap();

    assert_eq!(
        bucket.listed(),
        vec![stamp_prefix(NB).as_str(), notebook_prefix(NB).as_str()],
    );
    assert_eq!(bucket.list_calls[1].1, None, "recursive, not one level");
    assert_eq!(
        prepared.listed_dirs,
        vec!["elsewhere/deep", "notes"],
        "the sweep is authoritative for every directory",
    );
    // `elsewhere/deep/b.md` is new to this device and has to come down.
    assert_eq!(tags(&prepared.plan), vec!["download:new"]);
}

/// Rebinding resets the old bucket's baselines and opens a delete grace window.
#[tokio::test]
async fn rebinding_moves_baselines_to_the_switch_instant() {
    let credentials = credentials();
    let (_temp, store) = store_bound_to(&credentials);
    store
        .v4_save_path_states(NB, &[path_state("notes/a.md", 8, 1_000, NOW - MINUTE)])
        .unwrap();
    store
        .v4_save_notebook_state(&V4NotebookState {
            notebook_id: NB.to_string(),
            grace_until: None,
            credential_fingerprint: "sha256:somewhere-else".to_string(),
        })
        .unwrap();

    // Migrated content: the object is there, its stamp is the migration time.
    let mut bucket = FakeBucket::new()
        .file("notes/a.md", 8, NOW)
        .stamp("notes", NOW);
    let scanned = scan(&[("notes/a.md", 8, 1_000)]);
    let prepared = plan_pass(
        &mut bucket,
        &credentials,
        &store,
        &pass_request(&scanned, false),
    )
    .await
    .unwrap();

    assert!(prepared.rebound);
    assert!(
        !prepared.allows_deletes,
        "a rebind always opens the grace window"
    );
    // Baseline == remote stamp, so nothing is transferred even though every
    // `LastModified` in the bucket is brand new.
    assert!(prepared.plan.actions.is_empty());
    let state = store.v4_notebook_state(NB).unwrap().unwrap();
    assert_eq!(state.grace_until, Some(NOW + BIND_GRACE_MS));
    assert_eq!(state.credential_fingerprint, fingerprint(&credentials));
}

/// A rebind that left the bucket empty is an operator error. Deleting the
/// notebook is not an acceptable response to it.
#[tokio::test]
async fn an_empty_bucket_right_after_a_rebind_deletes_nothing() {
    let credentials = credentials();
    let (_temp, store) = store_bound_to(&credentials);
    store
        .v4_save_path_states(NB, &[path_state("notes/a.md", 8, 1_000, NOW - MINUTE)])
        .unwrap();
    store
        .v4_save_notebook_state(&V4NotebookState {
            notebook_id: NB.to_string(),
            grace_until: None,
            credential_fingerprint: "sha256:somewhere-else".to_string(),
        })
        .unwrap();

    let mut bucket = FakeBucket::new();
    let scanned = scan(&[("notes/a.md", 8, 1_000)]);
    let prepared = plan_pass(
        &mut bucket,
        &credentials,
        &store,
        &pass_request(&scanned, false),
    )
    .await
    .unwrap();

    assert!(prepared.rebound);
    assert!(!prepared.allows_deletes);
    assert_eq!(tags(&prepared.plan), vec!["defer:grace"]);
}

/// Without a server clock nothing may be deleted, but syncing must not stop:
/// uploads and downloads are safe, deletions are not.
#[tokio::test]
async fn a_missing_date_header_suppresses_deletes_but_not_transfers() {
    let credentials = credentials();
    let (_temp, store) = store_bound_to(&credentials);
    store
        .v4_save_path_states(
            NB,
            &[
                path_state("notes/a.md", 8, 1_000, NOW - MINUTE),
                path_state("notes/b.md", 8, 1_000, NOW - MINUTE),
            ],
        )
        .unwrap();

    let mut bucket = FakeBucket::new()
        .file("notes/b.md", 40, NOW)
        .date(None)
        .stamp("notes", NOW);
    let scanned = scan(&[("notes/a.md", 8, 1_000), ("notes/b.md", 8, 1_000)]);
    let prepared = plan_pass(
        &mut bucket,
        &credentials,
        &store,
        &pass_request(&scanned, false),
    )
    .await
    .unwrap();

    assert!(!prepared.clock_trusted);
    assert!(!prepared.allows_deletes);
    // `a.md` is absent remotely and there is no clock to run the window on.
    assert_eq!(
        tags(&prepared.plan),
        vec!["defer:grace", "download:remote-new"]
    );
}

/// The whole pass, end to end, on the one path that needs no HTTP: a remote
/// deletion. Asserts what actually survives in the state tables.
#[tokio::test]
async fn a_confirmed_remote_deletion_executes_and_drops_its_row() {
    let credentials = credentials();
    let (_temp, store) = store_bound_to(&credentials);
    store
        .v4_save_path_states(NB, &[path_state("notes/a.md", 8, 1_000, NOW - MINUTE)])
        .unwrap();

    let mut bucket = FakeBucket::new()
        .tombstone("notes/a.md", NOW)
        .stamp("notes", NOW);
    let scanned = scan(&[("notes/a.md", 8, 1_000)]);
    let request = pass_request(&scanned, false);
    let http = reqwest::Client::new();
    let local = MemoryLocal::new(&["notes/a.md"]);

    let mut env = PassEnv {
        source: &mut bucket,
        http: &http,
        credentials: &credentials,
        credential_resolver: &credentials,
        store: &store,
        local: &local,
    };
    let notified = std::sync::atomic::AtomicUsize::new(0);
    let progress = std::sync::Mutex::new(Vec::new());
    let report = run_pass_with_progress(
        &mut env,
        &request,
        Utc.timestamp_millis_opt(NOW).unwrap(),
        Some(&|direction| {
            if direction.is_some() {
                notified.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        }),
        Some(&|done, total| progress.lock().unwrap().push((done, total))),
    )
    .await
    .unwrap();
    assert_eq!(notified.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert_eq!(*progress.lock().unwrap(), vec![(0, 1), (1, 1)]);

    assert!(report.did_work());
    assert!(local
        .archived
        .lock()
        .unwrap()
        .contains(&"notes/a.md".to_string()));
    assert!(local.files.lock().unwrap().is_empty());
    let snapshot = store.v4_snapshot(NB).unwrap();
    assert!(snapshot.states.is_empty(), "the row goes with the file");
    assert_eq!(snapshot.dir_scans["notes"].stamp_millis, NOW);
    assert!(
        bucket.puts.is_empty(),
        "a local deletion writes no stamp: the tombstone already did"
    );
}

#[tokio::test]
async fn quiet_pass_does_not_signal_a_transfer() {
    let credentials = credentials();
    let (_temp, store) = store_bound_to(&credentials);
    let mut bucket = FakeBucket::new();
    let scanned = scan(&[]);
    let request = pass_request(&scanned, false);
    let http = reqwest::Client::new();
    let local = MemoryLocal::new(&[]);
    let mut env = PassEnv {
        source: &mut bucket,
        http: &http,
        credentials: &credentials,
        credential_resolver: &credentials,
        store: &store,
        local: &local,
    };
    let notified = std::sync::atomic::AtomicUsize::new(0);
    run_pass_with_progress(
        &mut env,
        &request,
        Utc.timestamp_millis_opt(NOW).unwrap(),
        Some(&|direction| {
            if direction.is_some() {
                notified.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        }),
        None,
    )
    .await
    .unwrap();
    assert_eq!(notified.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[tokio::test]
async fn cancellation_keeps_completed_action_checkpoint() {
    use crate::reconcile::{Download, DownloadReason};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let mut credentials = credentials();
    credentials.endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (_temp, store) = store_bound_to(&credentials);
    store
        .v4_save_path_states(NB, &[path_state("notes/a.md", 8, 1_000, NOW - MINUTE)])
        .unwrap();
    let mut bucket = FakeBucket::new()
        .tombstone("notes/a.md", NOW)
        .stamp("notes", NOW);
    let scanned = scan(&[("notes/a.md", 8, 1_000)]);
    let request = pass_request(&scanned, false);
    let mut prepared = plan_pass(&mut bucket, &credentials, &store, &request)
        .await
        .unwrap();
    assert!(matches!(
        prepared.plan.actions.first(),
        Some(SyncAction::DeleteLocal(_))
    ));
    prepared.plan.actions.push(SyncAction::Download(Download {
        path: "stalled.md".into(),
        reason: DownloadReason::NewToDevice,
        backup: None,
    }));
    let local = MemoryLocal::new(&["notes/a.md"]);
    let http = reqwest::Client::new();
    let mut env = PassEnv {
        source: &mut bucket,
        http: &http,
        credentials: &credentials,
        credential_resolver: &credentials,
        store: &store,
        local: &local,
    };
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(250),
        execute_pass(
            &mut env,
            &request,
            &prepared,
            Utc.timestamp_millis_opt(NOW).unwrap()
        )
    )
    .await
    .is_err());
    assert!(local.files.lock().unwrap().is_empty());
    assert!(!store
        .v4_snapshot(NB)
        .unwrap()
        .states
        .contains_key("notes/a.md"));
}

#[tokio::test]
async fn interrupted_publish_retries_queued_stamp_after_read_only_pass() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let mut credentials = credentials();
    credentials.endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (_temp, store) = store_bound_to(&credentials);
    let mut bucket = FakeBucket::new();
    let scanned = scan(&[("notes/a.md", 8, 1_000)]);
    let request = pass_request(&scanned, false);
    let mut prepared = plan_pass(&mut bucket, &credentials, &store, &request)
        .await
        .unwrap();
    prepared.plan.actions = vec![SyncAction::Upload(Upload {
        path: "notes/a.md".into(),
        reason: UploadReason::New,
    })];
    let local = MemoryLocal::new(&["notes/a.md"]);
    let http = reqwest::Client::new();
    let mut env = PassEnv {
        source: &mut bucket,
        http: &http,
        credentials: &credentials,
        credential_resolver: &credentials,
        store: &store,
        local: &local,
    };
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(250),
        execute_pass(
            &mut env,
            &request,
            &prepared,
            Utc.timestamp_millis_opt(NOW).unwrap()
        )
    )
    .await
    .is_err());
    assert_eq!(store.v4_pending_stamps(NB).unwrap(), ["notes"]);
    prepared.plan.actions.clear();
    prepared.writable = false;
    execute_pass(
        &mut env,
        &request,
        &prepared,
        Utc.timestamp_millis_opt(NOW).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(store.v4_pending_stamps(NB).unwrap(), ["notes"]);
    prepared.writable = true;
    execute_pass(
        &mut env,
        &request,
        &prepared,
        Utc.timestamp_millis_opt(NOW).unwrap(),
    )
    .await
    .unwrap();
    assert!(store.v4_pending_stamps(NB).unwrap().is_empty());
    assert!(bucket
        .puts
        .iter()
        .any(|(key, _)| key == &stamp_key(NB, "notes")));
}

#[tokio::test]
async fn failed_stamp_remains_queued_until_a_later_success() {
    let credentials = credentials();
    let (_temp, store) = store_bound_to(&credentials);
    store.v4_queue_stamps(NB, &["notes".into()]).unwrap();
    let mut bucket = FakeBucket::new();
    let scanned = scan(&[]);
    let request = pass_request(&scanned, false);
    let prepared = plan_pass(&mut bucket, &credentials, &store, &request)
        .await
        .unwrap();
    bucket.fail_put = true;
    let local = MemoryLocal::new(&[]);
    let http = reqwest::Client::new();
    let mut env = PassEnv {
        source: &mut bucket,
        http: &http,
        credentials: &credentials,
        credential_resolver: &credentials,
        store: &store,
        local: &local,
    };
    let report = execute_pass(
        &mut env,
        &request,
        &prepared,
        Utc.timestamp_millis_opt(NOW).unwrap(),
    )
    .await
    .unwrap();
    assert!(!report.stamp_failures.is_empty());
    assert_eq!(store.v4_pending_stamps(NB).unwrap(), ["notes"]);
    bucket.fail_put = false;
    let mut env = PassEnv {
        source: &mut bucket,
        http: &http,
        credentials: &credentials,
        credential_resolver: &credentials,
        store: &store,
        local: &local,
    };
    let report = execute_pass(
        &mut env,
        &request,
        &prepared,
        Utc.timestamp_millis_opt(NOW).unwrap(),
    )
    .await
    .unwrap();
    assert!(report.stamp_failures.is_empty());
    assert!(store.v4_pending_stamps(NB).unwrap().is_empty());
}

#[test]
fn pending_stamps_are_scoped_to_the_current_binding_and_notebook() {
    let credentials = credentials();
    let (_temp, store) = store_bound_to(&credentials);
    store
        .v4_queue_stamps(NB, &["notes".into(), "notes".into()])
        .unwrap();
    store
        .v4_queue_stamps("other", &["other-dir".into()])
        .unwrap();
    assert_eq!(store.v4_pending_stamps(NB).unwrap(), ["notes"]);
    store
        .v4_rebind_credential(NB, "new-target", NOW, NOW + BIND_GRACE_MS)
        .unwrap();
    assert!(store.v4_pending_stamps(NB).unwrap().is_empty());
    assert_eq!(store.v4_pending_stamps("other").unwrap(), ["other-dir"]);
    store.v4_clear_notebook("other").unwrap();
    assert!(store.v4_pending_stamps("other").unwrap().is_empty());
}

#[test]
fn pending_stamps_block_an_unknown_remote_and_are_cleared_on_logout() {
    let temp = tempfile::tempdir().unwrap();
    let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
    store.v4_queue_stamps(NB, &["notes".into()]).unwrap();
    assert!(store.validate_remote_target("custom-target").is_err());
    assert!(store.bind_remote_target("custom-target").is_err());
    store.clear_account().unwrap();
    assert!(store.v4_pending_stamps(NB).unwrap().is_empty());
    assert!(store.bind_remote_target("custom-target").is_ok());
}

#[test]
fn stamp_keys_round_trip_for_the_root_and_nested_directories() {
    assert_eq!(stamp_key(NB, ""), "nb/nb_notes/s/.json");
    assert_eq!(stamp_dir(NB, "nb/nb_notes/s/.json").as_deref(), Some(""));
    assert_eq!(stamp_key(NB, "项目/2026"), "nb/nb_notes/s/项目/2026.json");
    assert_eq!(
        stamp_dir(NB, "nb/nb_notes/s/项目/2026.json").as_deref(),
        Some("项目/2026")
    );
    // A directory whose name ends in `.json` survives one round trip.
    assert_eq!(
        stamp_dir(NB, "nb/nb_notes/s/a.json.json").as_deref(),
        Some("a.json")
    );

    // Anything that is not a stamp is not silently read as one.
    assert_eq!(stamp_dir(NB, "nb/nb_notes/s/folder/"), None);
    assert_eq!(stamp_dir(NB, "nb/other/s/notes.json"), None);

    assert_eq!(file_prefix(NB, ""), "nb/nb_notes/f/");
    assert_eq!(file_prefix(NB, "notes"), "nb/nb_notes/f/notes/");
    assert_eq!(
        relative_path(NB, "nb/nb_notes/f/notes/a.md").as_deref(),
        Some("notes/a.md")
    );
    assert_eq!(relative_path(NB, "nb/other/f/notes/a.md"), None);
    assert_eq!(relative_path(NB, "nb/nb_notes/s/.json"), None);
}

#[test]
fn a_stamp_body_carries_no_state_another_device_could_clobber() {
    let body = stamp_body("notes", NOW, "mac-7f3a");
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(parsed["schema"], 1);
    assert_eq!(parsed["path"], "notes");
    assert_eq!(parsed["lastChangeAt"], NOW);
    assert_eq!(parsed["deviceId"], "mac-7f3a");
    // Appearance fields would be overwritten wholesale by whoever touches the
    // directory next, so they must not live in the hot stamp.
    assert!(parsed.get("icon").is_none());
}

#[test]
fn baselines_skip_transferred_paths_and_stamps_only_cover_successes() {
    let credentials = credentials();
    let (_temp, store) = store_bound_to(&credentials);
    let scanned = scan(&[
        ("notes/a.md", 8, 1_000),
        ("notes/b.md", 8, 1_000),
        ("notes/c.md", 8, 1_000),
        ("drafts/d.md", 8, 1_000),
    ]);

    let plan = ReconcilePlan {
        baselines: vec![
            Baseline {
                path: "notes/a.md".into(),
                mtime_millis: NOW,
                clear_dirty: false,
            },
            // Transferred, so its own state (exact remote stamp, real hash) wins.
            Baseline {
                path: "notes/b.md".into(),
                mtime_millis: NOW,
                clear_dirty: true,
            },
            // Gone from disk: a baseline would record a file that is not there.
            Baseline {
                path: "notes/vanished.md".into(),
                mtime_millis: NOW,
                clear_dirty: false,
            },
        ],
        actions: vec![
            SyncAction::Upload(Upload {
                path: "notes/b.md".into(),
                reason: UploadReason::LocalAhead,
            }),
            SyncAction::Upload(Upload {
                path: "notes/c.md".into(),
                reason: UploadReason::New,
            }),
            SyncAction::Upload(Upload {
                path: "drafts/d.md".into(),
                reason: UploadReason::New,
            }),
        ],
        touch_dirs: ["drafts".to_string(), "notes".to_string()]
            .into_iter()
            .collect(),
        forget: vec!["notes/gone-everywhere.md".into()],
        ..Default::default()
    };

    let prepared = PassPlan {
        server_now_millis: NOW,
        clock_trusted: true,
        snapshot: store.v4_snapshot(NB).unwrap(),
        stamps: [
            ("notes".to_string(), NOW - MINUTE),
            ("drafts".to_string(), NOW),
        ]
        .into_iter()
        .collect(),
        listing: RemoteListing::default(),
        plan,
        listed_dirs: vec!["drafts".to_string(), "notes".to_string()],
        list_failures: Vec::new(),
        rebound: false,
        allows_deletes: true,
        writable: true,
    };
    let applied = ApplyOutcome {
        states: Vec::new(),
        removed: Vec::new(),
        probes: BTreeMap::new(),
        failures: vec![ApplyFailure {
            path: "drafts/d.md".to_string(),
            message: "timed out".to_string(),
        }],
    };

    let updates = state_updates(&scanned, &prepared, &applied);

    let kept: Vec<&str> = updates
        .states
        .iter()
        .map(|state| state.path.as_str())
        .collect();
    assert_eq!(kept, vec!["notes/a.md"]);
    assert_eq!(updates.states[0].local_mtime_millis, 1_000);
    assert_eq!(updates.states[0].last_synced_at, NOW);

    // Two uploads in `notes` collapse into one stamp; `drafts` failed, so its
    // directory must keep looking stale or the next pass would skip it.
    assert_eq!(updates.stamp_dirs, vec!["notes"]);
    assert_eq!(updates.removed, vec!["notes/gone-everywhere.md"]);
    assert_eq!(
        updates.dir_scans["notes"],
        DirScanRecord {
            stamp_millis: NOW - MINUTE,
            scanned_at_millis: NOW
        },
    );
    assert_eq!(updates.dir_scans["drafts"].stamp_millis, NOW);
}

#[test]
fn a_broken_cursor_stops_pagination_instead_of_spinning() {
    assert_eq!(
        next_cursor(None, Some("1".into())).unwrap().as_deref(),
        Some("1")
    );
    assert_eq!(
        next_cursor(Some("1"), Some("2".into())).unwrap().as_deref(),
        Some("2")
    );
    assert!(next_cursor(Some("1"), Some("1".into())).is_err());
    assert_eq!(next_cursor(None, None).unwrap(), None);
}

#[test]
fn scoped_bucket_listing_is_converted_to_notebook_keys() {
    let page = ListPage {
        objects: vec![ListedObject {
            key: "u/usr_abc/nb/book/f/a.md".into(),
            last_modified: String::new(),
            size: 1,
            etag: String::new(),
        }],
        common_prefixes: vec!["u/usr_abc/nb/book/f/notes/".into()],
        next_cursor: None,
        server_date_millis: None,
    };
    let page = unscoped_page(page, "u/usr_abc/").unwrap();
    assert_eq!(page.objects[0].key, "nb/book/f/a.md");
    assert_eq!(page.common_prefixes[0], "nb/book/f/notes/");
    assert!(unscoped_page(page, "u/usr_other/").is_err());
}

#[tokio::test]
async fn pagination_collects_every_page_of_a_stamp_listing() {
    let credentials = credentials();
    let (_temp, store) = store_bound_to(&credentials);

    let mut bucket = FakeBucket {
        page_size: 2,
        ..FakeBucket::new()
    };
    for dir in ["a", "b", "c", "d", "e"] {
        bucket = bucket.stamp(dir, NOW - MINUTE);
    }
    let prepared = plan_pass(&mut bucket, &credentials, &store, &pass_request(&[], true))
        .await
        .unwrap();

    assert_eq!(prepared.stamps.len(), 5, "five stamps over three pages");
    assert_eq!(prepared.stamps["e"], NOW - MINUTE);
}

/// Over quota, the server stops signing write scope (§7). The pass must then
/// pull what it can and defer every publish — retrying an upload that the
/// credential cannot authorise would 403 forever and tell the user nothing.
#[tokio::test]
async fn read_only_official_proxy_keeps_confirmed_deletes_but_defers_uploads() {
    let mut credentials = credentials();
    credentials.mode = "read".into();
    let (_temp, store) = store_bound_to(&credentials);
    store
        .v4_save_path_states(NB, &[path_state("notes/a.md", 8, 1_000, NOW - MINUTE)])
        .unwrap();
    store
        .v4_set_pending_deletions(
            NB,
            &[("notes/a.md".to_string(), NOW - 10 * MINUTE)]
                .into_iter()
                .collect(),
        )
        .unwrap();
    let scanned = scan(&[("notes/new.md", 4, 1_000)]);
    let mut bucket = FakeBucket::new().file("notes/a.md", 8, NOW - MINUTE);
    let prepared = super::planning::plan_pass_with_proxy(
        &mut bucket,
        &credentials,
        &store,
        &pass_request(&scanned, true),
        true,
    )
    .await
    .unwrap();
    assert!(tags(&prepared.plan).contains(&"write-tombstone"));
    assert!(tags(&prepared.plan).contains(&"defer:read-only"));
}

#[tokio::test]
async fn read_only_proxy_executes_and_checkpoints_confirmed_deletion() {
    struct Proxy {
        credential: ObjectStoreCredentials,
        paths: Mutex<Vec<String>>,
    }
    #[async_trait::async_trait]
    impl crate::object_store::CredentialResolver for Proxy {
        async fn resolve(&self, _: i64) -> Result<ObjectStoreCredentials, SyncError> {
            Ok(self.credential.clone())
        }
        fn supports_deletion_proxy(&self) -> bool {
            true
        }
        async fn proxy_tombstone(&self, _: &str, path: &str, _: &str) -> Result<(), SyncError> {
            self.paths.lock().unwrap().push(path.to_string());
            Ok(())
        }
    }
    let mut credentials = credentials();
    credentials.mode = "read".into();
    let (_temp, store) = store_bound_to(&credentials);
    store
        .v4_save_path_states(NB, &[path_state("notes/a.md", 8, 1_000, NOW - MINUTE)])
        .unwrap();
    store
        .v4_set_pending_deletions(
            NB,
            &[("notes/a.md".to_string(), NOW - 10 * MINUTE)]
                .into_iter()
                .collect(),
        )
        .unwrap();
    let proxy = Proxy {
        credential: credentials.clone(),
        paths: Mutex::new(Vec::new()),
    };
    let mut bucket = FakeBucket::new().file("notes/a.md", 8, NOW - MINUTE);
    let local = MemoryLocal::new(&[]);
    let http = reqwest::Client::new();
    let mut env = PassEnv {
        source: &mut bucket,
        http: &http,
        credentials: &credentials,
        credential_resolver: &proxy,
        store: &store,
        local: &local,
    };
    let report = run_pass(
        &mut env,
        &pass_request(&[], true),
        Utc.timestamp_millis_opt(NOW).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(*proxy.paths.lock().unwrap(), ["notes/a.md"]);
    assert!(report.applied.failures.is_empty());
    assert!(store.v4_pending_stamps(NB).unwrap().is_empty());
    assert!(!store
        .v4_snapshot(NB)
        .unwrap()
        .states
        .contains_key("notes/a.md"));
}

#[tokio::test]
async fn failed_proxy_deletion_keeps_confirmation_and_retries_without_full_sweep() {
    struct RetryProxy {
        credential: ObjectStoreCredentials,
        calls: Mutex<usize>,
    }
    #[async_trait::async_trait]
    impl crate::object_store::CredentialResolver for RetryProxy {
        async fn resolve(&self, _: i64) -> Result<ObjectStoreCredentials, SyncError> {
            Ok(self.credential.clone())
        }
        fn supports_deletion_proxy(&self) -> bool {
            true
        }
        async fn proxy_tombstone(&self, _: &str, _: &str, _: &str) -> Result<(), SyncError> {
            let mut calls = self.calls.lock().unwrap();
            *calls += 1;
            if *calls == 1 {
                Err(object_list_error())
            } else {
                Ok(())
            }
        }
        async fn proxy_deletion_stamp(&self, _: &str, _: &str) -> Result<(), SyncError> {
            Err(SyncError::Api {
                status: 409,
                code: "STORAGE_DELETE_CONFLICT".into(),
                message: "not deleted".into(),
                details: None,
            })
        }
    }
    let mut credentials = credentials();
    credentials.mode = "read".into();
    let (_temp, store) = store_bound_to(&credentials);
    store
        .v4_save_path_states(NB, &[path_state("notes/a.md", 8, 1_000, NOW - MINUTE)])
        .unwrap();
    let first_seen = NOW - 10 * MINUTE;
    store
        .v4_set_pending_deletions(
            NB,
            &[("notes/a.md".to_string(), first_seen)]
                .into_iter()
                .collect(),
        )
        .unwrap();
    let proxy = RetryProxy {
        credential: credentials.clone(),
        calls: Mutex::new(0),
    };
    let mut bucket = FakeBucket::new().file("notes/a.md", 8, NOW - MINUTE);
    let local = MemoryLocal::new(&[]);
    let http = reqwest::Client::new();
    let mut env = PassEnv {
        source: &mut bucket,
        http: &http,
        credentials: &credentials,
        credential_resolver: &proxy,
        store: &store,
        local: &local,
    };
    let first = run_pass(
        &mut env,
        &pass_request(&[], true),
        Utc.timestamp_millis_opt(NOW).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(first.applied.failures.len(), 1);
    assert_eq!(
        store.v4_snapshot(NB).unwrap().states["notes/a.md"].pending_since,
        Some(first_seen)
    );
    let second = run_pass(
        &mut env,
        &pass_request(&[], false),
        Utc.timestamp_millis_opt(NOW).unwrap(),
    )
    .await
    .unwrap();
    assert!(second.applied.failures.is_empty());
    assert_eq!(*proxy.calls.lock().unwrap(), 2);
    assert!(!store
        .v4_snapshot(NB)
        .unwrap()
        .states
        .contains_key("notes/a.md"));
}

#[tokio::test]
async fn a_read_only_credential_defers_publishes_and_writes_no_stamp() {
    let mut credentials = credentials();
    credentials.mode = "read".to_string();
    credentials.expires_at = NOW + 3_600_000;
    let (_temp, store) = store_bound_to(&credentials);

    // A local file the device never published: normally `upload:new`.
    let scanned = scan(&[("notes/brand-new.md", 4, 1_000)]);
    let mut bucket = FakeBucket::new();
    let prepared = plan_pass(
        &mut bucket,
        &credentials,
        &store,
        &pass_request(&scanned, false),
    )
    .await
    .unwrap();

    assert!(!prepared.writable);
    assert_eq!(prepared.plan.actions.len(), 1);
    assert_eq!(prepared.plan.actions[0].kind_tag(), "defer:read-only");
    assert_eq!(
        prepared.plan.stats.uploads, 0,
        "nothing may look publishable"
    );
    // A stamp bump here would make every other device re-list this directory on
    // every pass while the account stays read-only.
    assert!(prepared.plan.touch_dirs.is_empty());
}

/// A quota the control plane already reported is honoured before the credential
/// expires. Without this the account keeps attempting uploads for the rest of the
/// token's fifteen minutes, paying a 403 per object to learn what the issued
/// quota already said.
#[tokio::test]
async fn an_exhausted_quota_defers_publishes_like_a_read_only_credential() {
    let credentials = credentials();
    assert!(
        credentials.can_write(),
        "the credential itself must still allow writes"
    );
    let (_temp, store) = store_bound_to(&credentials);
    let scanned = scan(&[("notes/brand-new.md", 4, 1_000)]);
    let mut bucket = FakeBucket::new();
    let quota = StorageQuota {
        mode: "read-write".to_string(),
        used_bytes: Some(10_000),
        limit_bytes: Some(10_000),
        expires_at: None,
    };
    let mut request = pass_request(&scanned, false);
    request.quota = Some(&quota);

    let prepared = plan_pass(&mut bucket, &credentials, &store, &request)
        .await
        .unwrap();

    assert!(!prepared.writable);
    assert_eq!(prepared.plan.actions[0].kind_tag(), "defer:read-only");
    assert_eq!(prepared.plan.stats.uploads, 0);
    // Nothing was published, so no stamp may be bumped — otherwise every other
    // device re-lists this directory on every pass while the account stays full.
    assert!(prepared.plan.touch_dirs.is_empty());
}

/// A zero limit means "no capacity configured for this grant", not "full". Read
/// the other way it would silently stop every free account from publishing.
#[tokio::test]
async fn a_zero_limit_is_not_an_exhausted_quota() {
    let credentials = credentials();
    let (_temp, store) = store_bound_to(&credentials);
    let scanned = scan(&[("notes/brand-new.md", 4, 1_000)]);
    let mut bucket = FakeBucket::new();
    let quota = StorageQuota {
        mode: "read-write".to_string(),
        used_bytes: Some(0),
        limit_bytes: Some(0),
        expires_at: None,
    };
    let mut request = pass_request(&scanned, false);
    request.quota = Some(&quota);

    let prepared = plan_pass(&mut bucket, &credentials, &store, &request)
        .await
        .unwrap();

    assert!(prepared.writable);
    assert_eq!(prepared.plan.actions[0].kind_tag(), "upload:new");
}

/// Reading is still allowed: an unpublished local file waits, but a remote one
/// must still arrive. Otherwise a quota-blocked account would also stop
/// receiving edits, which is not what "read-only" means.
#[tokio::test]
async fn a_read_only_credential_still_applies_downloads() {
    let mut credentials = credentials();
    credentials.mode = "read".to_string();
    let (_temp, store) = store_bound_to(&credentials);

    let mut bucket = FakeBucket::new()
        .file("notes/remote.md", 6, NOW - MINUTE)
        .stamp("notes", NOW);
    bucket.date_millis = Some(NOW);

    let prepared = plan_pass(&mut bucket, &credentials, &store, &pass_request(&[], false))
        .await
        .unwrap();

    assert!(!prepared.writable);
    assert_eq!(prepared.plan.actions[0].kind_tag(), "download:new");
    assert_eq!(prepared.plan.stats.downloads, 1);
}

#[tokio::test]
async fn direct_source_heads_overlap_and_keep_input_order() {
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
                    assert!(request.starts_with("HEAD "));
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
            "both HEADs must start before either completes"
        );
        requests
            .remove("b")
            .unwrap()
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .unwrap();
        requests.remove("a").unwrap().write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nx-amz-meta-deleted: 1\r\nConnection: close\r\n\r\n").unwrap();
    });
    let mut credentials = credentials();
    credentials.endpoint = endpoint;
    let http = reqwest::Client::new();
    let mut source = DirectSource {
        http: &http,
        credentials: &credentials,
        credential_resolver: &credentials,
    };
    let results = source
        .head_many(vec![object_key(NB, "a.md"), object_key(NB, "b.md")])
        .await;
    server.join().unwrap();
    assert_eq!(results.len(), 2);
    assert!(results[0].as_ref().unwrap().as_ref().unwrap().tombstone);
    assert!(results[1].as_ref().unwrap().is_none());
}

#[tokio::test]
async fn direct_source_enumerates_independent_directories_in_parallel() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::Duration;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let server = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut requests = Vec::new();
        while requests.len() < 2 && std::time::Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut data = [0; 2048];
                    let count = stream.read(&mut data).unwrap();
                    assert!(String::from_utf8_lossy(&data[..count]).starts_with("GET "));
                    requests.push(stream);
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
            "both listings must start before either completes"
        );
        let body = "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>";
        for mut stream in requests.into_iter().rev() {
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        }
    });
    let mut credentials = credentials();
    credentials.endpoint = endpoint;
    let http = reqwest::Client::new();
    let mut source = DirectSource {
        http: &http,
        credentials: &credentials,
        credential_resolver: &credentials,
    };
    let results = source
        .list_directories(NB.into(), vec!["a".into(), "b".into()])
        .await;
    server.join().unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].0, "a");
    assert_eq!(results[1].0, "b");
    assert!(results.into_iter().all(|(_, _, result)| result.is_ok()));
}
