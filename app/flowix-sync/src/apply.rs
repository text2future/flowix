//! Executing a [`ReconcilePlan`] against the bucket and the local notebook.
//!
//! The split mirrors the rest of this crate: the *decisions* are pure
//! (`reconcile`), the *transfers* are thin SigV4 wrappers (`object_store_ops`),
//! and the local file system arrives through [`LocalStore`] so nothing here
//! depends on Tauri, a notebook root, or an index. `flowix-desktop` supplies the
//! implementation; a test supplies an in-memory one.
//!
//! Failure policy: **one path failing never aborts the pass.** A 40 MB
//! attachment timing out must not block the other 200 files, and every action
//! here is idempotent, so a failed path simply reappears in the next plan. The
//! outcome carries the failures instead of returning early.

use std::collections::BTreeMap;

use chrono::{DateTime, FixedOffset, Offset, Utc};
use futures_util::stream::{FuturesOrdered, FuturesUnordered, StreamExt};
use sha2::{Digest, Sha256};

use crate::error::SyncError;
use crate::object_store::CredentialResolver;
use crate::object_store_ops::{self, DownloadedObject};
use crate::reconcile::{DownloadReason, ReconcilePlan, RemoteObject, SyncAction, UploadReason};
use crate::state::{state_after_transfer, LocalSnapshot, PathState};

pub use crate::error::FailureKind;

/// What the executor needs from the local side.
///
/// Paths are notebook-relative as they appear on disk (`PathState::display_path`),
/// never the normalised key: on macOS the key is NFC while the file name is
/// NFD, so only the display form can be opened.
pub trait LocalStore: Send + Sync {
    /// Whether `path` is part of notebook content that may cross the cloud
    /// boundary. The production adapter shares this rule with the scanner.
    /// The executor checks it before any remote request or local mutation so
    /// old or malformed objects cannot apply local-only configuration.
    fn is_syncable_path(&self, path: &str) -> bool;

    /// Reads the bytes **and** the stat of the same open handle.
    ///
    /// They must come from one handle: if the stamp were taken from a second
    /// `stat`, a save landing between the two would record the new mtime against
    /// the old bytes, marking the file clean and silently dropping that edit.
    fn read(&self, path: &str) -> Result<Option<LocalRead>, SyncError>;

    /// Writes atomically and reports the stamp the file system actually
    /// produced. The stamp must come from a `stat` after the rename, not from
    /// the clock: only then does `is_dirty` compare like with like.
    fn write(&self, path: &str, bytes: &[u8]) -> Result<LocalStamp, SyncError>;

    /// Replaces a path only if it still has the bytes observed before the
    /// remote transfer began. `None` means the file changed (or appeared) in
    /// the meantime, so the caller must leave it alone and reconcile again.
    /// Production adapters should override this with the notebook's file lock;
    /// the default keeps simple adapters safe for sequential use.
    fn write_if_unchanged(
        &self,
        path: &str,
        bytes: &[u8],
        expected: Option<&[u8]>,
    ) -> Result<Option<LocalStamp>, SyncError> {
        let current = self.read(path)?;
        let unchanged = match (current.as_ref(), expected) {
            (None, None) => true,
            (Some(current), Some(expected)) => current.bytes.as_slice() == expected,
            _ => false,
        };
        if !unchanged {
            return Ok(None);
        }
        self.write(path, bytes).map(Some)
    }

    /// Creates `path` only if it does not exist. `None` means the name is
    /// taken; the caller picks the next suffix.
    fn create_exclusive(&self, path: &str, bytes: &[u8]) -> Result<Option<LocalStamp>, SyncError>;

    /// Copies the observed bytes into the local version archive so a later
    /// restore keeps the path, the note id and its backlinks (§5).
    fn archive(&self, path: &str, bytes: &[u8], reason: ArchiveReason) -> Result<(), SyncError>;

    fn remove(&self, path: &str) -> Result<(), SyncError>;

    /// Remove only the bytes previously observed by the caller. The comparison
    /// and removal must be performed under the same file lock.
    fn remove_if_unchanged(&self, path: &str, expected: &[u8]) -> Result<bool, SyncError>;
}

/// Adapter that keeps the blocking file system calls off the async workers.
///
/// [`LocalStore`] is synchronous on purpose (file locks, atomic renames, `stat`),
/// so calling it from a future would run on a Tokio worker. `write_if_unchanged`
/// is overridden rather than left to the default implementation so a read plus a
/// write stays one hop instead of two.
struct OffThread<'a> {
    inner: &'a dyn LocalStore,
}

impl LocalStore for OffThread<'_> {
    fn is_syncable_path(&self, path: &str) -> bool {
        self.inner.is_syncable_path(path)
    }

    fn read(&self, path: &str) -> Result<Option<LocalRead>, SyncError> {
        crate::blocking::run(|| self.inner.read(path))
    }

    fn write(&self, path: &str, bytes: &[u8]) -> Result<LocalStamp, SyncError> {
        crate::blocking::run(|| self.inner.write(path, bytes))
    }

    fn write_if_unchanged(
        &self,
        path: &str,
        bytes: &[u8],
        expected: Option<&[u8]>,
    ) -> Result<Option<LocalStamp>, SyncError> {
        crate::blocking::run(|| self.inner.write_if_unchanged(path, bytes, expected))
    }

    fn create_exclusive(&self, path: &str, bytes: &[u8]) -> Result<Option<LocalStamp>, SyncError> {
        crate::blocking::run(|| self.inner.create_exclusive(path, bytes))
    }

    fn archive(&self, path: &str, bytes: &[u8], reason: ArchiveReason) -> Result<(), SyncError> {
        crate::blocking::run(|| self.inner.archive(path, bytes, reason))
    }

    fn remove(&self, path: &str) -> Result<(), SyncError> {
        crate::blocking::run(|| self.inner.remove(path))
    }

    fn remove_if_unchanged(&self, path: &str, expected: &[u8]) -> Result<bool, SyncError> {
        crate::blocking::run(|| self.inner.remove_if_unchanged(path, expected))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalStamp {
    pub size: u64,
    pub mtime_millis: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalRead {
    pub bytes: Vec<u8>,
    pub stamp: LocalStamp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveReason {
    /// The cloud deleted this path; keep the bytes before removing the file.
    RemoteDeletion,
    /// A remote version is about to overwrite unsynced local edits.
    ConflictBackup,
    /// A previously synchronized version is about to be replaced by a remote update.
    /// This uses the normal bounded version history rather than conflict retention.
    RemoteReplacement,
}

/// One path that could not be executed this pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyFailure {
    pub path: String,
    pub message: String,
    /// Why it failed. The message is for the user; this is for the retry loop
    /// and the status UI, which must not depend on message wording.
    pub kind: FailureKind,
}

impl ApplyFailure {
    pub fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            message: message.into(),
            kind: FailureKind::Unknown,
        }
    }

    pub fn of(path: impl Into<String>, kind: FailureKind, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            message: message.into(),
            kind,
        }
    }

    /// Carries the error's own classification into the outcome.
    pub fn from_error(path: impl Into<String>, error: &SyncError) -> Self {
        Self {
            path: path.into(),
            message: error.to_string(),
            kind: error.failure_kind(),
        }
    }

    /// A path the notebook's own rules keep out of the cloud.
    pub fn unsupported(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self::of(path, FailureKind::Unsupported, message)
    }

    pub fn retryable(&self) -> bool {
        self.kind.is_retryable()
    }
}

#[derive(Debug, Clone, Default)]
pub struct ApplyOutcome {
    /// State to upsert, already stamped with the server's `LastModified`.
    pub states: Vec<PathState>,
    /// Paths whose rows must be dropped (the file is gone here and there).
    pub removed: Vec<String>,
    /// `HEAD` results from this pass, keyed by notebook-relative path. A `None`
    /// value is a 404, which is single-key evidence and must not be widened to
    /// the directory (`RemoteListing::mark_missing`).
    pub probes: BTreeMap<String, Option<RemoteObject>>,
    pub failures: Vec<ApplyFailure>,
}

impl ApplyOutcome {
    pub fn succeeded(&self) -> bool {
        self.failures.is_empty()
    }
}

/// Maps a notebook-relative path onto its object key (§2).
pub fn object_key(notebook_id: &str, path: &str) -> String {
    format!("nb/{notebook_id}/f/{path}")
}

/// `Q4 规划 (冲突 2026-11-22 19-56-20 mac-7f3a).md`
///
/// The timestamp is for humans only. Uniqueness comes from probing for an
/// existing name (`create_exclusive`), because a bucket migration can make two
/// hundred files conflict in the same second on the same device — and a random
/// suffix, while unique, is unreadable in a file tree.
pub fn conflict_copy_path(
    path: &str,
    device_id: &str,
    at: DateTime<FixedOffset>,
    attempt: u32,
) -> String {
    let (stem, extension) = match path.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() && !extension.contains('/') => {
            (stem, Some(extension))
        }
        _ => (path, None),
    };
    // Local offset, not UTC: this label is read by a person looking at their
    // own clock. `:` would be illegal on Windows, hence `-`.
    let label = at.format("%Y-%m-%d %H-%M-%S");
    let suffix = if attempt <= 1 {
        String::new()
    } else {
        format!(" {attempt}")
    };
    let name = format!("{stem} (冲突 {label} {device_id}{suffix})");
    match extension {
        Some(extension) => format!("{name}.{extension}"),
        None => name,
    }
}

pub fn content_hash(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("sha256:{hex}")
}

/// Whether losing bytes are worth preserving before a remote copy overwrites
/// them.
///
/// Two devices that "both changed" a file can end up with byte-identical
/// content — a `touch`, a re-save with no edit, the same fix applied twice. A
/// conflict copy then is noise the user has to clean up, and the archived
/// version would be identical to its predecessor, so both are skipped.
pub fn keep_conflict_copy(losing: &[u8], incoming_hash: &str) -> bool {
    content_hash(losing) != incoming_hash
}

/// Everything about *where* a plan is applied, as opposed to *what* it says.
pub struct ApplyContext<'a> {
    pub credential_resolver: &'a dyn CredentialResolver,
    pub notebook_id: &'a str,
    /// Only used to label conflict copies.
    pub device_id: &'a str,
}

/// Transfer indicator: `Some(direction)` when the first transfer of a batch
/// starts, `None` when the last one ends.
pub(crate) type TransferObserver<'a> = dyn Fn(Option<&str>) + Send + Sync + 'a;

/// `(completed, total)` after each applied action.
pub(crate) type ProgressObserver<'a> = dyn Fn(usize, usize) + Send + Sync + 'a;

// A batch can transfer several files at once. Only clear the indicator after
// the last request finishes; dropping a cancelled future also releases it.
struct TransferTracker<'a> {
    count: std::sync::Mutex<usize>,
    notify: Option<&'a TransferObserver<'a>>,
}

impl<'b> TransferTracker<'b> {
    fn start<'a>(&'a self, direction: &'static str) -> TransferGuard<'a, 'b> {
        let mut count = self.count.lock().unwrap_or_else(|error| error.into_inner());
        *count += 1;
        if *count == 1 {
            if let Some(notify) = self.notify {
                notify(Some(direction));
            }
        }
        TransferGuard(self)
    }
}

struct TransferGuard<'a, 'b>(&'a TransferTracker<'b>);
impl Drop for TransferGuard<'_, '_> {
    fn drop(&mut self) {
        let mut count = self
            .0
            .count
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *count -= 1;
        if *count == 0 {
            if let Some(notify) = self.0.notify {
                notify(None);
            }
        }
    }
}

// Buffered bodies can be copied during signing and local application. Keep
// their combined estimated size modest; a single larger file is still allowed.
const TRANSFER_BATCH_BYTES: u64 = 16 * 1024 * 1024;

/// Executes `plan`. Never returns an error: everything that failed is in
/// [`ApplyOutcome::failures`], so the pass can still persist what succeeded.
pub async fn apply(
    http: &crate::http::HttpClient,
    context: &ApplyContext<'_>,
    local: &dyn LocalStore,
    plan: &ReconcilePlan,
    snapshot: &LocalSnapshot,
    now: DateTime<Utc>,
) -> ApplyOutcome {
    apply_with_checkpoint(http, context, local, plan, snapshot, now, &mut |_| Ok(())).await
}

/// Persist completed actions before starting the next network operation.
/// The callback is synchronous so cancellation cannot occur between an action
/// completing and its checkpoint being recorded.
pub async fn apply_with_checkpoint(
    http: &crate::http::HttpClient,
    context: &ApplyContext<'_>,
    local: &dyn LocalStore,
    plan: &ReconcilePlan,
    snapshot: &LocalSnapshot,
    now: DateTime<Utc>,
    checkpoint: &mut (dyn FnMut(&ApplyOutcome) -> Result<(), SyncError> + Send),
) -> ApplyOutcome {
    apply_with_checkpoint_and_sizes(http, context, local, plan, snapshot, now, checkpoint, None)
        .await
}

/// Size hints are estimates, not hard limits: files may change after scanning.
/// Unknown and individually large files run alone to avoid multiplying memory
/// pressure from the buffered S3 implementation.
pub(crate) async fn apply_with_checkpoint_and_sizes(
    http: &crate::http::HttpClient,
    context: &ApplyContext<'_>,
    local: &dyn LocalStore,
    plan: &ReconcilePlan,
    snapshot: &LocalSnapshot,
    now: DateTime<Utc>,
    checkpoint: &mut (dyn FnMut(&ApplyOutcome) -> Result<(), SyncError> + Send),
    sizes: Option<&BTreeMap<String, u64>>,
) -> ApplyOutcome {
    apply_with_progress(
        http,
        context,
        local,
        plan,
        snapshot,
        now,
        checkpoint,
        ApplyOptions {
            sizes,
            ..ApplyOptions::default()
        },
    )
    .await
}

/// Everything about *how* a plan is applied that does not change the plan
/// itself: memory hints and the two progress observers.
///
/// Grouped into one value because the alternatives are all `Option`s, and a
/// positional call with two `None`s says nothing about which knob is which at
/// the call site.
#[derive(Default)]
pub(crate) struct ApplyOptions<'a> {
    /// Per-file size estimates, used only to bound how many transfers run at
    /// once.
    pub sizes: Option<&'a BTreeMap<String, u64>>,
    /// Hard client-side ceiling checked against bytes read immediately before
    /// publishing, in case a file grew after the planning scan.
    pub max_upload_file_bytes: Option<u64>,
    /// Transfer indicator, shared with the batch tracker.
    pub on_transfer: Option<&'a TransferObserver<'a>>,
    /// Progress after each applied action.
    pub on_progress: Option<&'a ProgressObserver<'a>>,
}

pub(crate) async fn apply_with_progress(
    http: &crate::http::HttpClient,
    context: &ApplyContext<'_>,
    local: &dyn LocalStore,
    plan: &ReconcilePlan,
    snapshot: &LocalSnapshot,
    now: DateTime<Utc>,
    checkpoint: &mut (dyn FnMut(&ApplyOutcome) -> Result<(), SyncError> + Send),
    options: ApplyOptions<'_>,
) -> ApplyOutcome {
    let ApplyOptions {
        sizes,
        max_upload_file_bytes,
        on_transfer,
        on_progress,
    } = options;
    let mut outcome = ApplyOutcome::default();
    // Every local call below holds a file lock or touches the disk, so it must
    // not run directly on the worker that also drives the network futures.
    let local = OffThread { inner: local };
    let local: &dyn LocalStore = &local;
    let tracker = TransferTracker {
        count: std::sync::Mutex::new(0),
        notify: on_transfer,
    };

    let total = plan.actions.len();
    let mut completed = 0;
    if let Some(notify) = on_progress {
        notify(completed, total);
    }
    let mut actions = plan.actions.iter().peekable();
    while let Some(action) = actions.next() {
        // Overlap uploads for distinct paths, checkpointing each completion
        // before polling the next future.
        if matches!(action, SyncAction::Upload(_)) {
            let mut batch = vec![action];
            let mut paths = std::collections::BTreeSet::from([action_path(action)]);
            let mut estimated = sizes.and_then(|sizes| sizes.get(&action_path(action)).copied());
            while batch.len() < 4 {
                let Some(next @ SyncAction::Upload(_)) = actions.peek().copied() else {
                    break;
                };
                let next_path = action_path(next);
                if sizes.is_some() {
                    let next_size = sizes.and_then(|sizes| sizes.get(&next_path).copied());
                    let Some(total) = estimated
                        .zip(next_size)
                        .and_then(|(a, b)| a.checked_add(b))
                        .filter(|total| *total <= TRANSFER_BATCH_BYTES)
                    else {
                        break;
                    };
                    estimated = Some(total);
                }
                if !paths.insert(next_path) {
                    break;
                }
                batch.push(actions.next().expect("peeked action"));
            }
            let batch_len = batch.len();
            let mut pending = FuturesUnordered::new();
            for item in batch {
                let SyncAction::Upload(upload) = item else {
                    unreachable!()
                };
                let path = display_path(snapshot, &upload.path);
                if !local.is_syncable_path(&path) {
                    outcome.failures
                        .push(ApplyFailure::unsupported(
                            path,
                            "path is excluded by the local notebook sync policy",
                        ));
                    continue;
                }
                let tracker = &tracker;
                pending.push(async move {
                    let result = upload_one(
                        http,
                        context,
                        local,
                        snapshot,
                        &upload.path,
                        upload.reason,
                        max_upload_file_bytes,
                        Some(tracker),
                    )
                    .await;
                    (upload.path.clone(), result)
                });
            }
            while let Some((path, result)) = pending.next().await {
                match result {
                    Ok(state) => {
                        outcome.states.push(state);
                        if let Err(error) = checkpoint(&outcome) {
                            outcome.failures.push(ApplyFailure::of(
                                path,
                                FailureKind::Storage,
                                format!("could not persist sync progress: {error}"),
                            ));
                            return outcome;
                        }
                    }
                    Err(error) => outcome.failures.push(ApplyFailure::from_error(path, &error)),
                }
            }
            completed += batch_len;
            if let Some(notify) = on_progress {
                notify(completed, total);
            }
            continue;
        }
        if matches!(action, SyncAction::Download(_)) {
            // Fetch a small group concurrently, but apply it in plan order.
            // Local writes, conflict copies, and their checkpoints must not
            // race each other or a later destructive action.
            let mut batch = vec![action];
            let mut paths = std::collections::BTreeSet::from([action_path(action)]);
            let mut estimated = sizes.and_then(|sizes| sizes.get(&action_path(action)).copied());
            while batch.len() < 4 {
                let Some(next @ SyncAction::Download(_)) = actions.peek().copied() else {
                    break;
                };
                let next_path = action_path(next);
                if sizes.is_some() {
                    let next_size = sizes.and_then(|sizes| sizes.get(&next_path).copied());
                    let Some(total) = estimated
                        .zip(next_size)
                        .and_then(|(a, b)| a.checked_add(b))
                        .filter(|total| *total <= TRANSFER_BATCH_BYTES)
                    else {
                        break;
                    };
                    estimated = Some(total);
                }
                if !paths.insert(next_path) {
                    break;
                }
                batch.push(actions.next().expect("peeked action"));
            }
            let batch_len = batch.len();
            let mut pending = FuturesOrdered::new();
            for item in batch {
                let SyncAction::Download(download) = item else {
                    unreachable!()
                };
                let tracker = &tracker;
                pending.push_back(async move {
                    let display = display_path(snapshot, &download.path);
                    let result = if local.is_syncable_path(&display) {
                        let previous = local.read(&display);
                        match previous {
                            Ok(previous) => {
                                let _transfer = tracker.start("download");
                                object_store_ops::download(
                                    http,
                                    context.credential_resolver,
                                    &object_key(context.notebook_id, &download.path),
                                )
                                .await
                                .and_then(|value| {
                                    value.map(|object| (previous, object)).ok_or_else(|| {
                                        SyncError::InvalidState(format!(
                                            "{} disappeared between the decision and the download",
                                            download.path
                                        ))
                                    })
                                })
                            }
                            Err(error) => Err(error),
                        }
                    } else {
                        Err(SyncError::InvalidState(
                            "path is excluded by the local notebook sync policy".to_string(),
                        ))
                    };
                    (download, result)
                });
            }
            while let Some((download, result)) = pending.next().await {
                let result = result.and_then(|(previous, object)| {
                    apply_download(
                        context,
                        local,
                        snapshot,
                        &download.path,
                        download.reason,
                        now,
                        previous,
                        object,
                    )
                });
                match result {
                    Ok(state) => {
                        outcome.states.push(state);
                        if let Err(error) = checkpoint(&outcome) {
                            outcome.failures.push(ApplyFailure::of(
                                download.path.clone(),
                                FailureKind::Storage,
                                format!("could not persist sync progress: {error}"),
                            ));
                            return outcome;
                        }
                    }
                    Err(error) => outcome
                        .failures
                        .push(ApplyFailure::from_error(download.path.clone(), &error)),
                }
            }
            completed += batch_len;
            if let Some(notify) = on_progress {
                notify(completed, total);
            }
            continue;
        }
        if !matches!(action, SyncAction::Defer(_)) {
            let path = display_path(snapshot, &action_path(action));
            if !local.is_syncable_path(&path) {
                outcome.failures.push(ApplyFailure::unsupported(
                    path,
                    "path is excluded by the local notebook sync policy",
                ));
                completed += 1;
                if let Some(notify) = on_progress {
                    notify(completed, total);
                }
                continue;
            }
        }

        let result = match action {
            SyncAction::Upload(upload) => upload_one(
                http,
                context,
                local,
                snapshot,
                &upload.path,
                upload.reason,
                max_upload_file_bytes,
                Some(&tracker),
            )
            .await
            .map(|state| outcome.states.push(state)),
            SyncAction::Download(_) => unreachable!("downloads are processed in batches"),
            SyncAction::DeleteLocal(delete) => delete_one(local, snapshot, &delete.path)
                .map(|()| outcome.removed.push(delete.path.clone())),
            SyncAction::WriteTombstone(tombstone) => {
                let display = display_path(snapshot, &tombstone.path);
                match local.read(&display) {
                    Ok(None)
                        if tombstone
                            .expected_etag
                            .as_deref()
                            .is_some_and(|etag| !etag.trim().is_empty()) =>
                    {
                        object_store_ops::write_tombstone(
                            http,
                            context.credential_resolver,
                            &object_key(context.notebook_id, &tombstone.path),
                            tombstone.expected_etag.as_deref().unwrap(),
                        )
                        .await
                        .map(|_| outcome.removed.push(tombstone.path.clone()))
                    }
                    Ok(None) => Err(SyncError::InvalidState(
                        "cannot delete without an observed remote ETag".into(),
                    )),
                    Ok(Some(_)) => Err(SyncError::InvalidState(
                        "local file reappeared before deletion".into(),
                    )),
                    Err(error) => Err(error),
                }
            }
            SyncAction::Probe(probe) => object_store_ops::head(
                http,
                context.credential_resolver,
                &object_key(context.notebook_id, &probe.path),
            )
            .await
            .map(|remote| {
                let mut remote = remote;
                // `HEAD` reports the key, not the notebook-relative path.
                if let Some(object) = remote.as_mut() {
                    object.path = probe.path.clone();
                }
                outcome.probes.insert(probe.path.clone(), remote);
            }),
            // Nothing to execute: the path stays in the pending set.
            SyncAction::Defer(_) => Ok(()),
        };

        if let Err(error) = result {
            outcome
                .failures
                .push(ApplyFailure::from_error(action_path(action), &error));
        } else if let Err(error) = checkpoint(&outcome) {
            outcome.failures.push(ApplyFailure::of(
                action_path(action),
                FailureKind::Storage,
                format!("could not persist sync progress: {error}"),
            ));
            break;
        }
        completed += 1;
        if let Some(notify) = on_progress {
            notify(completed, total);
        }
    }

    outcome
}

fn action_path(action: &SyncAction) -> String {
    match action {
        SyncAction::Upload(upload) => upload.path.clone(),
        SyncAction::Download(download) => download.path.clone(),
        SyncAction::DeleteLocal(delete) => delete.path.clone(),
        SyncAction::WriteTombstone(tombstone) => tombstone.path.clone(),
        SyncAction::Probe(probe) => probe.path.clone(),
        SyncAction::Defer(defer) => defer.path.clone(),
    }
}

fn display_path(snapshot: &LocalSnapshot, key: &str) -> String {
    snapshot
        .states
        .get(key)
        .map(|state| state.display_path.clone())
        .unwrap_or_else(|| key.to_string())
}

async fn upload_one(
    http: &crate::http::HttpClient,
    context: &ApplyContext<'_>,
    local: &dyn LocalStore,
    snapshot: &LocalSnapshot,
    key: &str,
    reason: UploadReason,
    max_upload_file_bytes: Option<u64>,
    tracker: Option<&TransferTracker<'_>>,
) -> Result<PathState, SyncError> {
    let display = display_path(snapshot, key);
    let Some(LocalRead { bytes, stamp }) = local.read(&display)? else {
        return Err(SyncError::InvalidState(format!(
            "{display} disappeared before it could be uploaded"
        )));
    };
    if max_upload_file_bytes.is_some_and(|maximum| bytes.len() as u64 > maximum) {
        return Err(SyncError::InvalidState(
            "file grew beyond the per-file cloud upload limit after scanning; upload was skipped"
                .into(),
        ));
    }
    let hash = content_hash(&bytes);
    let size = bytes.len();
    let remote = object_store_ops::upload_with_progress(
        http,
        context.credential_resolver,
        &object_key(context.notebook_id, key),
        bytes.into(),
        &hash,
        || tracker.map(|tracker| tracker.start("upload")),
    )
    .await?;
    // The follow-up HEAD can observe another device's PUT if it raced with
    // ours. Never persist that object's metadata as the baseline for these
    // local bytes: leave this path dirty so the next pass can reconcile the
    // winning remote version and preserve this copy if it lost.
    if remote.content_hash.as_deref() != Some(hash.as_str()) {
        return Err(SyncError::InvalidState(format!(
            "{key} changed while this device was uploading; the local version remains pending"
        )));
    }
    tracing::trace!(path = key, ?reason, bytes = size, "upload complete");
    Ok(state_after_transfer(
        key,
        display,
        hash,
        stamp.size,
        stamp.mtime_millis,
        remote.mtime_millis,
        // The content-hash check above established that HEAD observed our
        // bytes, so this ETag is a valid baseline for this local version.
        remote.etag,
    ))
}

fn apply_download(
    context: &ApplyContext<'_>,
    local: &dyn LocalStore,
    snapshot: &LocalSnapshot,
    key: &str,
    reason: DownloadReason,
    now: DateTime<Utc>,
    previous: Option<LocalRead>,
    DownloadedObject { remote, bytes }: DownloadedObject,
) -> Result<PathState, SyncError> {
    let display = display_path(snapshot, key);
    if remote.tombstone {
        return Err(SyncError::InvalidState(format!(
            "{key} was deleted while its content was being downloaded; local data was left unchanged"
        )));
    }

    // The losing bytes are preserved twice on purpose: once as a visible copy
    // next to the file, once in the version archive. The archive survives the
    // user deleting the copy, and it keeps the original path's history.
    let incoming_hash = content_hash(&bytes);
    if remote.content_hash.as_deref() != Some(incoming_hash.as_str()) {
        return Err(SyncError::InvalidState(format!(
            "{key} failed its content-hash check; local data was left unchanged"
        )));
    }
    if matches!(reason, DownloadReason::Conflict) {
        if let Some(losing) = previous.as_ref() {
            // Both sides looked "changed" but produced the same bytes. The
            // local file was read anyway, so this test costs nothing.
            if keep_conflict_copy(&losing.bytes, &incoming_hash) {
                let conflict_at = now.with_timezone(&chrono::Local::now().offset().fix());
                let mut attempt = 1;
                loop {
                    let candidate =
                        conflict_copy_path(&display, context.device_id, conflict_at, attempt);
                    if local.create_exclusive(&candidate, &losing.bytes)?.is_some() {
                        break;
                    }
                    attempt += 1;
                    if attempt > 100 {
                        return Err(SyncError::InvalidState(format!(
                            "cannot find a free conflict name for {display}"
                        )));
                    }
                }
                local.archive(&display, &losing.bytes, ArchiveReason::ConflictBackup)?;
            }
        }
    } else if matches!(reason, DownloadReason::RemoteNew) {
        // A clean local copy may still be the only remaining copy of the
        // version that was just replaced in the bucket (for example, another
        // device wrote after our previous upload completed). Keep it in the
        // bounded path history before applying the remote value. This does not
        // create a visible conflict file for ordinary remote edits.
        if let Some(previous) = previous.as_ref() {
            if keep_conflict_copy(&previous.bytes, &incoming_hash) {
                local.archive(&display, &previous.bytes, ArchiveReason::RemoteReplacement)?;
            }
        }
    }

    let expected = previous.as_ref().map(|previous| previous.bytes.as_slice());
    let Some(stamp) = local.write_if_unchanged(&display, &bytes, expected)? else {
        return Err(SyncError::InvalidState(format!(
            "{display} changed while the remote version was downloading; local data was left in place"
        )));
    };
    Ok(state_after_transfer(
        key,
        display,
        incoming_hash,
        stamp.size,
        stamp.mtime_millis,
        remote.mtime_millis,
        remote.etag.clone(),
    ))
}

fn delete_one(
    local: &dyn LocalStore,
    snapshot: &LocalSnapshot,
    key: &str,
) -> Result<(), SyncError> {
    let display = display_path(snapshot, key);
    let Some(previous) = local.read(&display)? else {
        return Ok(());
    };
    local.archive(&display, &previous.bytes, ArchiveReason::RemoteDeletion)?;
    if !local.remove_if_unchanged(&display, &previous.bytes)? {
        return Err(SyncError::InvalidState(format!(
            "{display} changed while the remote deletion was being applied; local data was left in place"
        )));
    }
    Ok(())
}

#[cfg(test)]
#[path = "apply_tests.rs"]
mod tests;
