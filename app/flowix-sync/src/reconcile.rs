//! Reconciliation: the pure decision layer of one sync pass.
//!
//! `reconcile` takes what the device knows, what one `list` returned, and the
//! deletions still awaiting confirmation, then produces the actions the I/O
//! layer should execute. No I/O, no clock reads: `server_now_millis` is the
//! object store's `Date` header, the only clock the design trusts (see
//! `docs/CLOUD_STORAGE_PATH_LWW_DESIGN.md` §4.2).
//!
//! Two rules carry most of the design, and both are pinned by the table test
//! at the bottom:
//!
//! * An absent key in a successfully listed directory is treated as deleted.
//!   Eventually consistent listings can therefore cause a premature deletion.
//! * A dirty local file is never overwritten without leaving the local bytes
//!   behind under a conflict name (§5).
//!
//! A third one is the mirror image and was added once the executor existed:
//! **a file that disappears from disk is a deletion to propagate, not a remote
//! file to download** — provided the device has a baseline for it. Without that,
//! an offline delete is undone by the next pass and a rename leaves both paths
//! present (§4.3.1).

use std::collections::{BTreeMap, BTreeSet};

/// `LastModified` has one-second granularity, and two writers in the same
/// second are indistinguishable by time. Stamps this close to "now" get
/// re-listed instead of trusted (§13.2③).
pub const STAMP_BOUNDARY_MS: i64 = 2_000;

/// A file as the device sees it, from a `stat` (plus a hash when the caller
/// already had to compute one on the upload path).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalFile {
    pub path: String,
    pub size: u64,
    /// `sha256:<hex>` of the local bytes. `None` when nobody has needed it —
    /// recomputing 5000 hashes per pass is pure waste (§4.1).
    pub content_hash: Option<String>,
    /// True when the file changed since `last_synced_at[path]`.
    pub dirty: bool,
}

impl LocalFile {
    pub fn new(path: impl Into<String>, size: u64) -> Self {
        Self {
            path: path.into(),
            size,
            content_hash: None,
            dirty: false,
        }
    }

    pub fn dirty(mut self) -> Self {
        self.dirty = true;
        self
    }

    /// Conditional form, so callers can pass a predicate result straight
    /// through instead of branching on a freshly built value.
    pub fn dirty_if(mut self, dirty: bool) -> Self {
        self.dirty = dirty;
        self
    }

    pub fn hashed(mut self, hash: impl Into<String>) -> Self {
        self.content_hash = Some(hash.into());
        self
    }
}

/// Everything the device contributes to a pass.
#[derive(Debug, Clone, Default)]
pub struct LocalView {
    pub files: Vec<LocalFile>,
    /// Path which the device last saw at remote `LastModified` (ms). This is
    /// the only baseline the design keeps — no revision chain, no server-side
    /// epoch.
    pub last_synced_at: BTreeMap<String, i64>,
    /// ETag of the remote object this device recorded when it last transferred
    /// the path.
    ///
    /// Not a content hash and never compared with one — its only job is to
    /// answer "is the object at this key still the one I left there?".
    /// `LastModified` has one-second resolution, so two devices that write the
    /// same path in the same second produce the same stamp with different
    /// bytes; without this signal that case reads as "unchanged" and the loser's
    /// edit disappears silently.
    pub remote_etags: BTreeMap<String, String>,
    /// Paths whose deletion publication or remote check needs retrying
    /// (path -> first pending at). The L1 gate uses these to re-list the
    /// containing directory even when its stamp has not changed.
    pub pending_deletions: BTreeMap<String, i64>,
    /// Used to name conflict copies only; never to order changes.
    pub device_id: String,
    /// False during the grace window after binding an account or switching
    /// buckets. Absence then carries no information, so nothing is deleted
    /// (§13.2①). Tombstones are positive evidence and still apply.
    pub allow_deletes: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteObject {
    /// Path relative to `f/`, original case preserved.
    pub path: String,
    /// Parsed `LastModified`, epoch milliseconds.
    pub mtime_millis: i64,
    pub size: u64,
    /// `sha256:<hex>` from the object's `contentHash` metadata. A `list` does
    /// not return metadata, so this is `None` unless the caller head-ed the
    /// object. ETag is deliberately not used here: it is an md5 (or a
    /// multipart digest) and can never be compared with a sha256.
    pub content_hash: Option<String>,
    /// Opaque version token, useful for logging only.
    pub etag: Option<String>,
    /// Zero-byte marker object: the file was deleted, but the key stays so
    /// "deleted in the cloud" and "not uploaded yet" stay distinguishable.
    pub tombstone: bool,
}

impl RemoteObject {
    pub fn file(path: impl Into<String>, mtime_millis: i64, size: u64) -> Self {
        Self {
            path: path.into(),
            mtime_millis,
            size,
            content_hash: None,
            etag: None,
            tombstone: false,
        }
    }

    pub fn tombstone(path: impl Into<String>, mtime_millis: i64) -> Self {
        Self {
            path: path.into(),
            mtime_millis,
            size: 0,
            content_hash: None,
            etag: None,
            tombstone: true,
        }
    }

    pub fn hashed(mut self, hash: impl Into<String>) -> Self {
        self.content_hash = Some(hash.into());
        self
    }
}

/// The result of one L1 expansion, plus whatever single-key evidence the
/// caller already has.
///
/// `observed_dirs` is what separates "the cloud says this is gone" from "I did
/// not look", so it must only be filled **after the last page of a directory
/// has been consumed** — a truncated listing is not an enumeration.
///
/// `missing_keys` is the same evidence for one key, obtained by a `HEAD` that
/// returned 404. It is deliberately separate from `observed_dirs`: a probe
/// proves nothing about the neighbouring files, so it must not authorise
/// deleting them.
///
/// `unknown_keys` is the opposite: a key whose directory *was* enumerated but
/// whose state a failed `HEAD` left undecided. It has to be tracked explicitly
/// because the directory test would otherwise report it as absent, and acting
/// on a 500 as if it were a 404 deletes the local copy of a file that is still
/// in the cloud.
#[derive(Debug, Clone, Default)]
pub struct RemoteListing {
    pub observed: BTreeMap<String, RemoteObject>,
    pub observed_dirs: BTreeSet<String>,
    pub missing_keys: BTreeSet<String>,
    pub unknown_keys: BTreeSet<String>,
}

impl RemoteListing {
    pub fn with_dirs<'a>(
        objects: impl IntoIterator<Item = RemoteObject>,
        dirs: impl IntoIterator<Item = &'a str>,
    ) -> Self {
        Self {
            observed: objects
                .into_iter()
                .map(|object| (object.path.clone(), object))
                .collect(),
            observed_dirs: dirs.into_iter().map(str::to_string).collect(),
            missing_keys: BTreeSet::new(),
            unknown_keys: BTreeSet::new(),
        }
    }

    pub fn observe(&mut self, object: RemoteObject) {
        self.missing_keys.remove(&object.path);
        self.unknown_keys.remove(&object.path);
        self.observed.insert(object.path.clone(), object);
    }

    /// Records a `HEAD` that returned 404 for exactly this key.
    pub fn mark_missing(&mut self, path: &str) {
        self.observed.remove(path);
        self.unknown_keys.remove(path);
        self.missing_keys.insert(path.to_string());
    }

    /// Records that the key's state could not be established (a failed request,
    /// not a 404). Absence of evidence must not become evidence of absence.
    pub fn mark_unknown(&mut self, path: &str) {
        self.observed.remove(path);
        self.missing_keys.remove(path);
        self.unknown_keys.insert(path.to_string());
    }

    pub fn state_for(&self, path: &str) -> RemoteState<'_> {
        if let Some(object) = self.observed.get(path) {
            return RemoteState::Observed(object);
        }
        if self.unknown_keys.contains(path) {
            return RemoteState::Unknown;
        }
        if self.missing_keys.contains(path) || self.observed_dirs.contains(dir_of(path)) {
            RemoteState::Missing
        } else {
            RemoteState::Unknown
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteState<'a> {
    /// The containing directory was enumerated and the key is not there.
    Missing,
    /// The containing directory was not enumerated this pass; absence means
    /// nothing.
    Unknown,
    Observed(&'a RemoteObject),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncAction {
    Upload(Upload),
    Download(Download),
    /// Remote deletion confirmed; the caller archives the bytes as a local
    /// version and then deletes the file, and drops its baseline. Keeping the
    /// baseline would let the next pass read the same missing key as a fresh
    /// local file and resurrect it.
    ///
    /// There is deliberately no `_trash/` directory: it would not match the
    /// `.*` hidden pattern, so the indexer would see the moved files as new
    /// notes and the next pass would upload them under `f/_trash/...` — a
    /// delete that duplicates. The version archive already keeps the bytes and
    /// keeps the note's identity (same path, same id, links intact).
    DeleteLocal(DeleteLocal),
    /// Head one key before deciding — used only when a dirty file sits in a
    /// directory that was not listed, where uploading blind could clobber a
    /// newer remote version.
    Probe(Probe),
    /// No I/O this pass, but keep the path in the pending set.
    Defer(Defer),
    /// The file vanished here but still exists there: write the tombstone so
    /// the deletion reaches every other device.
    ///
    /// Without this row a local delete (or a rename, which looks like a delete
    /// plus a create) would be read back as "new remote file" and downloaded
    /// onto the device that just removed it — the note comes back, and a rename
    /// leaves a duplicate. There is no local outbox to replay instead: pushing
    /// the deletion eagerly from the delete command cannot work offline, and
    /// the pass is the only thing that runs in every case.
    WriteTombstone(Tombstone),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Upload {
    pub path: String,
    pub reason: UploadReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadReason {
    /// Never synced before.
    New,
    /// Edited after the last sync; LWW decides, and this device is the writer.
    LocalAhead,
    /// Remote lost the file (tombstone or absent) but the local copy exists.
    Resurrect,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Download {
    pub path: String,
    pub reason: DownloadReason,
    /// Present when the local copy held unsynced edits. The caller writes
    /// those bytes aside before overwriting.
    pub backup: Option<ConflictBackup>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadReason {
    /// The device has no copy.
    NewToDevice,
    /// A locally deleted path changed remotely since the previous sync.
    RemoteUpdateAfterDelete,
    /// The device's copy was clean; the remote version wins after the local
    /// previous value is kept in bounded history.
    RemoteNew,
    /// Both sides changed; remote's timestamp won and local bytes are kept
    /// under a conflict name.
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictBackup {
    pub device_id: String,
    /// Server time of the winning write; the filename label only.
    pub at_millis: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeleteLocal {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tombstone {
    pub path: String,
    pub expected_etag: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probe {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Defer {
    pub path: String,
    pub reason: DeferReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeferReason {
    /// The containing directory was not listed; absence proves nothing.
    RemoteUnknown,
    /// Inside the post-bind / post-migration grace window.
    GracePeriod,
    /// The credential in hand is read-only (the account is over quota, or the
    /// write scope was revoked at the last renewal). Downloads still work;
    /// publishing cannot, so planning an upload would only produce a 403 on
    /// every pass.
    ReadOnly,
    /// A local file is larger than the selected remote's per-file upload cap.
    /// It stays local and is reconsidered on the next pass.
    FileTooLarge,
    /// The batch would delete a large share of the notebook in one pass, and
    /// the deletions run cloud -> device: the cloud already recorded them, so
    /// applying them removes local files.
    ///
    /// From inside a single pass a deliberate bulk delete and a broken scan or
    /// listing look identical, so the deletions wait for a caller that has
    /// asked the user. Everything else in the plan still runs; without this
    /// the whole pass failed and the notebook stopped syncing until the user
    /// put the files back.
    ///
    /// Which way the batch points decides what "undo" means and how the prompt
    /// reads: here the local copies are at stake, so undo has to upload them
    /// back instead of downloading.
    MassDeletionLocal,
    /// A large local disappearance about to be published: applying it removes
    /// the cloud copies that are the other devices' only remaining source.
    MassDeletionRemote,
}

impl SyncAction {
    /// Short stable tag for logs and for asserting the decision table.
    pub fn kind_tag(&self) -> &'static str {
        match self {
            SyncAction::Upload(upload) => match upload.reason {
                UploadReason::New => "upload:new",
                UploadReason::LocalAhead => "upload:local-ahead",
                UploadReason::Resurrect => "upload:resurrect",
            },
            SyncAction::Download(download) => match download.reason {
                DownloadReason::NewToDevice => "download:new",
                DownloadReason::RemoteUpdateAfterDelete => "download:delete-conflict",
                DownloadReason::RemoteNew => "download:remote-new",
                DownloadReason::Conflict => "download:conflict",
            },
            SyncAction::DeleteLocal(_) => "delete-local",
            SyncAction::WriteTombstone(_) => "write-tombstone",
            SyncAction::Probe(_) => "probe",
            SyncAction::Defer(defer) => match defer.reason {
                DeferReason::RemoteUnknown => "defer:remote-unknown",
                DeferReason::GracePeriod => "defer:grace",
                DeferReason::ReadOnly => "defer:read-only",
                DeferReason::FileTooLarge => "defer:file-too-large",
                DeferReason::MassDeletionLocal => "defer:mass-deletion-local",
                DeferReason::MassDeletionRemote => "defer:mass-deletion-remote",
            },
        }
    }
}

/// A new baseline for `last_synced_at`. After an upload the caller writes the
/// `LastModified` of its own PUT instead; this vector only covers remote
/// values the pass actually observed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Baseline {
    pub path: String,
    pub mtime_millis: i64,
    /// The local file now matches the remote byte-for-byte, so the dirty flag
    /// can be cleared without an upload.
    pub clear_dirty: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReconcileStats {
    pub uploads: usize,
    pub downloads: usize,
    pub deletes: usize,
    /// Tombstones written because the file is gone here but still there.
    pub tombstones: usize,
    pub probes: usize,
    pub deferred: usize,
    /// The subset of `deferred` that is waiting for a human to confirm a bulk
    /// delete. Counted separately because "nothing to do" and "we refused to
    /// delete a third of the notebook" deserve different UI.
    pub mass_deletion_deferred: usize,
    pub unchanged: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReconcilePlan {
    pub actions: Vec<SyncAction>,
    /// Directories needing a stamp bump. One write per directory per batch,
    /// never per file (§6).
    pub touch_dirs: BTreeSet<String>,
    pub baselines: Vec<Baseline>,
    /// The next pending-deletion set. Paths decided either way are gone from
    /// it; paths still blind keep their original first-seen time.
    pub pending_deletions: BTreeMap<String, i64>,
    /// Rows whose baseline must be dropped: both sides are gone, so the row
    /// would only make the next pass re-examine a path nobody has.
    pub forget: Vec<String>,
    pub stats: ReconcileStats,
}

/// The whole decision for one notebook.
///
/// `LocalView::pending_deletions` must be cleared whenever the credential
/// points at a different backend or bucket so old retry state does not cause
/// unnecessary reads against the new target. The binding grace period
/// (`allow_deletes = false`) independently prevents deletion during rebinding.
pub fn reconcile(
    local: &LocalView,
    remote: &RemoteListing,
    server_now_millis: i64,
) -> ReconcilePlan {
    let files: BTreeMap<&str, &LocalFile> = local
        .files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();
    let mut paths: BTreeSet<&str> = BTreeSet::new();
    paths.extend(files.keys().copied());
    paths.extend(remote.observed.keys().map(String::as_str));
    paths.extend(local.pending_deletions.keys().map(String::as_str));

    let mut plan = ReconcilePlan::default();
    for path in paths {
        let baseline = local.last_synced_at.get(path).copied();
        match (files.get(path).copied(), remote.state_for(path)) {
            (None, RemoteState::Missing) => {
                // Both sides are gone. The only way to get here is a pending
                // entry, so the row is dead weight: drop it.
                forget(&mut plan, path);
            }
            (None, RemoteState::Unknown) => {
                if let Some(first_seen) = local.pending_deletions.get(path) {
                    // A local deletion whose remote half could not be read.
                    // Keep the pending marker so the directory gate retries
                    // this path after its remote state becomes readable.
                    defer(&mut plan, path, DeferReason::RemoteUnknown);
                    plan.pending_deletions.insert(path.to_string(), *first_seen);
                }
            }
            (None, RemoteState::Observed(object)) if object.tombstone => {
                // The cloud already recorded the deletion; there is nothing
                // local to resurrect and nothing left to write.
                forget(&mut plan, path);
            }
            (None, RemoteState::Observed(object)) if baseline.is_some() => {
                // Preserve an update made on another device after our baseline.
                let known = local.remote_etags.get(path).map(String::as_str);
                let changed = (known.is_none() && object.etag.is_some())
                    || object_replaced(object, known)
                    || (!same_object(object, known) && object.mtime_millis > baseline.unwrap());
                if changed {
                    download(
                        &mut plan,
                        path,
                        DownloadReason::RemoteUpdateAfterDelete,
                        None,
                    );
                } else {
                    reconcile_disappeared(&mut plan, local, object);
                }
            }
            (None, RemoteState::Observed(object)) => {
                set_baseline(&mut plan, path, object.mtime_millis, false);
                download(&mut plan, path, DownloadReason::NewToDevice, None);
            }
            (Some(file), RemoteState::Observed(object)) if object.tombstone => {
                reconcile_tombstone(&mut plan, file, object, baseline);
            }
            (Some(file), RemoteState::Observed(object)) => {
                reconcile_present(&mut plan, local, file, object, baseline, server_now_millis);
            }
            (Some(file), RemoteState::Missing) => {
                reconcile_absent(&mut plan, local, file, baseline);
            }
            (Some(file), RemoteState::Unknown) => {
                if file.dirty {
                    plan.actions.push(SyncAction::Probe(Probe {
                        path: path.to_string(),
                    }));
                    plan.stats.probes += 1;
                } else if let Some(first_seen) = local.pending_deletions.get(path) {
                    // Keep retrying while the remote state is unknown.
                    defer(&mut plan, path, DeferReason::RemoteUnknown);
                    plan.pending_deletions.insert(path.to_string(), *first_seen);
                }
            }
        }
    }
    plan
}

/// A path this device synced before, now absent from disk while the cloud
/// still has it.
///
/// Once the remote state is known, propagate the disappearance immediately.
/// The binding grace period and unknown-remote safeguards still apply.
fn reconcile_disappeared(plan: &mut ReconcilePlan, local: &LocalView, object: &RemoteObject) {
    let path = object.path.as_str();
    if !local.allow_deletes {
        // A fresh bucket (first bind / bucket switch) can legitimately be
        // missing paths this device has; that says nothing about the disk.
        defer(plan, path, DeferReason::GracePeriod);
        return;
    }
    plan.actions.push(SyncAction::WriteTombstone(Tombstone {
        path: path.to_string(),
        expected_etag: object.etag.clone(),
    }));
    plan.stats.tombstones += 1;
    // The tombstone *is* a write under f/, so every other device only
    // notices through the directory stamp (§3.2).
    plan.touch_dirs.insert(dir_of(path).to_string());
}

fn forget(plan: &mut ReconcilePlan, path: &str) {
    plan.forget.push(path.to_string());
}

fn reconcile_tombstone(
    plan: &mut ReconcilePlan,
    file: &LocalFile,
    object: &RemoteObject,
    baseline: Option<i64>,
) {
    // An unsynced edit is never resolved by deleting it. The tombstone is the
    // stale side here, whatever the timestamps say.
    let deleted_after_our_last_sync = match baseline {
        Some(baseline) => object.mtime_millis >= baseline,
        None => false,
    };
    if file.dirty || !deleted_after_our_last_sync {
        upload(plan, &file.path, UploadReason::Resurrect);
        return;
    }
    delete_local(plan, &file.path);
}

fn reconcile_absent(
    plan: &mut ReconcilePlan,
    local: &LocalView,
    file: &LocalFile,
    baseline: Option<i64>,
) {
    // No baseline means the device cannot claim this path was ever synced, so
    // absence cannot be a deletion — it is a new local file.
    if file.dirty || baseline.is_none() {
        let reason = if baseline.is_none() {
            UploadReason::New
        } else {
            UploadReason::Resurrect
        };
        upload(plan, &file.path, reason);
        return;
    }
    if !local.allow_deletes {
        defer(plan, &file.path, DeferReason::GracePeriod);
        return;
    }
    delete_local(plan, &file.path);
}

fn reconcile_present(
    plan: &mut ReconcilePlan,
    local: &LocalView,
    file: &LocalFile,
    object: &RemoteObject,
    baseline: Option<i64>,
    server_now_millis: i64,
) {
    // The ETag the device recorded for this key last time. `None` for a path
    // never transferred (or state written before the column existed), which
    // disables the same-second check rather than guessing with it.
    let baseline_etag = local.remote_etags.get(&file.path).map(String::as_str);
    match compare(file, object, baseline, baseline_etag) {
        Comparison::Identical => {
            set_baseline(plan, &file.path, object.mtime_millis, file.dirty);
            plan.stats.unchanged += 1;
        }
        Comparison::Unchanged => {
            set_baseline(plan, &file.path, object.mtime_millis, false);
            plan.stats.unchanged += 1;
        }
        Comparison::Differs => {
            if !file.dirty {
                // Nothing unpublished on this side, so no visible conflict
                // copy is needed. The executor still saves the replaced local
                // bytes into bounded history before applying the remote value.
                download(plan, &file.path, DownloadReason::RemoteNew, None);
                set_baseline(plan, &file.path, object.mtime_millis, false);
                return;
            }
            if remote_wins(file, object, baseline, baseline_etag) {
                let backup = ConflictBackup {
                    device_id: local.device_id.clone(),
                    at_millis: server_now_millis,
                };
                download(plan, &file.path, DownloadReason::Conflict, Some(backup));
                set_baseline(plan, &file.path, object.mtime_millis, true);
            } else {
                upload(plan, &file.path, UploadReason::LocalAhead);
            }
        }
    }
}

enum Comparison {
    /// Both hashes are known and equal: the dirty flag can be cleared.
    Identical,
    /// Same size, clean local, and the remote stamp did not advance past the
    /// baseline — no transfer.
    Unchanged,
    Differs,
}

fn compare(
    file: &LocalFile,
    object: &RemoteObject,
    baseline: Option<i64>,
    baseline_etag: Option<&str>,
) -> Comparison {
    if let (Some(local_hash), Some(remote_hash)) = (&file.content_hash, &object.content_hash) {
        return if normalise_hash(local_hash) == normalise_hash(remote_hash) {
            Comparison::Identical
        } else {
            Comparison::Differs
        };
    }
    if object.size != file.size {
        return Comparison::Differs;
    }
    // Same size, same stamp, still a different object: someone replaced the key
    // within the same second. `LastModified` cannot see this, so the ETag is the
    // only witness. Checked before `dirty` so it also covers the clean-local
    // case, where the correct answer is "take the remote copy".
    if object_replaced(object, baseline_etag) {
        return Comparison::Differs;
    }
    // A dirty file whose size happens to match must not be declared identical:
    // same-length edits are the common case, and dropping the edit is silent
    // data loss. Only a hash can prove equality there.
    if file.dirty {
        return Comparison::Differs;
    }
    // R2 LIST exposes milliseconds while HEAD exposes whole seconds. An
    // unchanged ETag proves this is the same object even when LIST's timestamp
    // is slightly later than the HEAD timestamp stored after transfer.
    if same_object(object, baseline_etag) {
        return Comparison::Unchanged;
    }
    match baseline {
        Some(baseline) if object.mtime_millis > baseline => Comparison::Differs,
        _ => Comparison::Unchanged,
    }
}

/// Whether the key now holds a different object than the one this device left
/// there, judged only by ETag.
///
/// Empty ETags are ignored: a backend that omits them (or a multipart upload
/// whose digest we cannot compare) must fall back to the previous behaviour
/// rather than declaring every path changed.
fn object_replaced(object: &RemoteObject, baseline_etag: Option<&str>) -> bool {
    match (baseline_etag, object.etag.as_deref()) {
        (Some(known), Some(current)) => {
            let known = known.trim().trim_matches('"');
            let current = current.trim().trim_matches('"');
            !known.is_empty() && !current.is_empty() && known != current
        }
        _ => false,
    }
}

fn same_object(object: &RemoteObject, baseline_etag: Option<&str>) -> bool {
    matches!((baseline_etag, object.etag.as_deref()), (Some(known), Some(current)) if !known.trim().trim_matches('"').is_empty() && known.trim().trim_matches('"') == current.trim().trim_matches('"'))
}

fn normalise_hash(hash: &str) -> &str {
    hash.trim().trim_start_matches("sha256:")
}

/// `remote.mtime > baseline` means the cloud moved after the device's last
/// look, so the cloud wins. Equal seconds are ambiguous: both sides pick the
/// same winner by comparing content hashes, so two devices converge instead of
/// ping-ponging.
///
/// When the hashes are unknown — which is the case for every `list`-derived
/// object — the ETag answers the narrower question "was this key replaced since
/// I left my bytes there?". If it was, the remote side wins and the local bytes
/// are preserved as a conflict copy; that is the only branch where the loser of
/// a same-second race keeps its edit. Without an ETag baseline the local writer
/// still wins, which keeps the common case (remote untouched, local edited)
/// from being downloaded over.
fn remote_wins(
    file: &LocalFile,
    object: &RemoteObject,
    baseline: Option<i64>,
    baseline_etag: Option<&str>,
) -> bool {
    let Some(baseline) = baseline else {
        return false;
    };
    if same_object(object, baseline_etag) {
        return false;
    }
    if object.mtime_millis > baseline {
        return true;
    }
    if object.mtime_millis < baseline {
        return false;
    }
    if object_replaced(object, baseline_etag) {
        return true;
    }
    match (&file.content_hash, &object.content_hash) {
        (Some(local_hash), Some(remote_hash)) => {
            normalise_hash(remote_hash) > normalise_hash(local_hash)
        }
        _ => false,
    }
}

/// Removing a local file changes nothing in the cloud, so it must not bump a
/// directory stamp — whoever wrote the tombstone already did, and a second bump
/// just makes every other device re-list the directory for nothing.
fn delete_local(plan: &mut ReconcilePlan, path: &str) {
    plan.actions.push(SyncAction::DeleteLocal(DeleteLocal {
        path: path.to_string(),
    }));
    plan.stats.deletes += 1;
}

fn upload(plan: &mut ReconcilePlan, path: &str, reason: UploadReason) {
    plan.actions.push(SyncAction::Upload(Upload {
        path: path.to_string(),
        reason,
    }));
    plan.stats.uploads += 1;
    plan.touch_dirs.insert(dir_of(path).to_string());
}

fn download(
    plan: &mut ReconcilePlan,
    path: &str,
    reason: DownloadReason,
    backup: Option<ConflictBackup>,
) {
    plan.actions.push(SyncAction::Download(Download {
        path: path.to_string(),
        reason,
        backup,
    }));
    plan.stats.downloads += 1;
}

fn defer(plan: &mut ReconcilePlan, path: &str, reason: DeferReason) {
    plan.actions.push(SyncAction::Defer(Defer {
        path: path.to_string(),
        reason,
    }));
    plan.stats.deferred += 1;
}

fn set_baseline(plan: &mut ReconcilePlan, path: &str, mtime_millis: i64, clear_dirty: bool) {
    plan.baselines.push(Baseline {
        path: path.to_string(),
        mtime_millis,
        clear_dirty,
    });
}

/// Directory part of a notebook-relative path; `""` for the root.
pub fn dir_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(index) => &path[..index],
        None => "",
    }
}

/// What the device remembers about the last expansion of one directory.
///
/// The decision is anchored on `scanned_at_millis` rather than on the stamp we
/// saw, because a write landing in the same second as the scan leaves the
/// stamp unchanged. Comparing against "when I last looked" keeps unchanged
/// directories free while still catching that race.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DirScanRecord {
    /// Stamp observed at that scan; kept to detect a stamp that moved
    /// backwards (bucket migration rewrites `LastModified`).
    pub stamp_millis: i64,
    pub scanned_at_millis: i64,
}

/// The L1 gate: which directories are worth listing this pass.
///
/// The candidate set is deliberately the **union** of the remote stamps and the
/// local directories, not just the stamps. A directory this device created has
/// no `s/` object yet, so a stamp-only gate would never list it, its files
/// would forever read as "remote state unknown", and the first note in a new
/// folder could never be uploaded.
///
/// A directory is due when:
///
/// * it has never been scanned, or `force` is set (the periodic sweep);
/// * its stamp is newer than the last scan, or could still share that scan's
///   second (within [`STAMP_BOUNDARY_MS`]);
/// * its stamp moved backwards, meaning the backend rewrote `LastModified` and
///   no stamp comparison is trustworthy until it is re-read;
/// * it holds a pending deletion whose remote check or publication needs a
///   retry. A hard delete leaves no tombstone and bumps no stamp, so this is
///   the only thing that brings the directory back for another look.
///
/// Everything else is skipped, which is what keeps the pass O(changed dirs).
pub fn directories_to_scan(
    local: &LocalView,
    remote_stamps: &BTreeMap<String, i64>,
    scanned: &BTreeMap<String, DirScanRecord>,
    force: bool,
) -> Vec<String> {
    let mut candidates: BTreeSet<&str> = remote_stamps.keys().map(String::as_str).collect();
    for file in &local.files {
        candidates.insert(dir_of(&file.path));
    }
    let mut confirm: BTreeSet<&str> = BTreeSet::new();
    for path in local.pending_deletions.keys() {
        candidates.insert(dir_of(path));
        confirm.insert(dir_of(path));
    }

    let mut due: Vec<String> = candidates
        .into_iter()
        .filter(|dir| {
            if force || confirm.contains(dir) {
                return true;
            }
            let Some(record) = scanned.get(*dir) else {
                return true;
            };
            let Some(stamp) = remote_stamps.get(*dir) else {
                // No stamp and a record: the directory was listed before and
                // nothing has been written to it since (a normal write always
                // bumps the stamp), so there is nothing to re-read.
                return false;
            };
            if *stamp < record.stamp_millis {
                return true;
            }
            *stamp + STAMP_BOUNDARY_MS >= record.scanned_at_millis
        })
        .map(str::to_string)
        .collect();
    due.sort();
    due
}

#[cfg(test)]
#[path = "reconcile_simulation.rs"]
mod simulation;

#[cfg(test)]
#[path = "reconcile_tests.rs"]
mod tests;
