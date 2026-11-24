//! v4 durable state: the device side of the path-keyed design.
//!
//! Split the same way as `v2`: this module owns the value types and the pure
//! derivations, `store::v4` owns the SQL. Nothing here touches the file system
//! or the clock — `mtime`, `size` and `server_now` all arrive as arguments, so
//! the state layer can be tested without a notebook on disk.
//!
//! Three tables back it (see `docs/CLOUD_STORAGE_PATH_LWW_DESIGN.md` §14.1):
//!
//! * [`V4PathState`]  one row per path, written on every save (hot)
//! * [`crate::reconcile::DirScanRecord`]  one row per directory (warm)
//! * [`V4NotebookState`]  one row per notebook (cold)
//!
//! The reason these do not reuse `v2_note_states`: that table is keyed by
//! `note_id`, which the v4 engine never has (the path *is* the identity), and
//! it has `NOT NULL` revision/seq columns that have no v4 equivalent. Faking
//! values there would make the columns read as meaningful when they are not.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Local notebook metadata used to publish the path-sync manifest.
///
/// This deliberately does not carry indexed-protocol or cursor state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathNotebookMetadata {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub sort_order: i64,
}

/// Per-device choice to include a notebook in path-based cloud storage sync.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PathNotebookLink {
    pub notebook_id: String,
    pub enabled: bool,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingNotebookAction {
    Put,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingNotebookChange {
    pub notebook_id: String,
    pub generation: i64,
    pub action: PendingNotebookAction,
}

use unicode_normalization::UnicodeNormalization;

use crate::error::SyncError;
use crate::reconcile::{LocalFile, LocalView};

/// Conservative notebook-relative path limit that leaves room for the user,
/// notebook, and object-kind prefixes within S3's 1,024-byte key limit.
pub const MAX_NOTEBOOK_PATH_BYTES: usize = 900;

/// Cloud-visible notebook identity. The notebook ID is carried by the object
/// key (`nb/{id}/m/manifest.json`); this body contains only shared notebook
/// metadata and never a machine-specific local path or folder presentation
/// settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudNotebookManifest {
    pub schema: u32,
    pub name: String,
    pub icon: Option<String>,
    pub sort_order: i64,
    pub deleted: bool,
    pub created_at: i64,
}

impl CloudNotebookManifest {
    pub fn validate(&self) -> Result<(), SyncError> {
        if self.schema != 1 {
            return Err(SyncError::InvalidState(format!(
                "unsupported notebook manifest schema {}",
                self.schema
            )));
        }
        if !self.deleted && self.name.trim().is_empty() {
            return Err(SyncError::InvalidState(
                "active notebook manifest has an empty name".into(),
            ));
        }
        if self.name.len() > 512 || self.icon.as_ref().is_some_and(|icon| icon.len() > 128) {
            return Err(SyncError::InvalidState(
                "notebook manifest metadata exceeds its size limit".into(),
            ));
        }
        Ok(())
    }
}

/// A persistent directory presence/deletion record. File contents and folder
/// appearance are deliberately absent; the key path is the directory identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDirectoryMarker {
    pub schema: u32,
    pub path: String,
    pub deleted: bool,
}

impl CloudDirectoryMarker {
    pub fn validate(&self) -> Result<(), SyncError> {
        if self.schema != 1 {
            return Err(SyncError::InvalidState(format!(
                "unsupported directory marker schema {}",
                self.schema
            )));
        }
        let normalized = normalize_key_path(&self.path)?;
        if normalized != self.path {
            return Err(SyncError::InvalidState(
                "directory marker path is not normalized".into(),
            ));
        }
        Ok(())
    }
}

/// Device-local acknowledgement for a shared directory marker. Kept separate
/// from file state because a directory may be empty and therefore have no file
/// row to anchor it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V4DirectoryState {
    pub path: String,
    pub last_synced_at: i64,
    pub deleted: bool,
    pub local_mtime_millis: i64,
    pub pending_since: Option<i64>,
}

/// Turns a notebook-relative path into the object key's path component.
///
/// **NFC-normalised, original case preserved.** NFC matters because macOS
/// stores file names decomposed while Windows stores them composed: without it
/// the same `é` produces two different keys and "move on this device, delete on
/// that one" stops converging. Case is deliberately *not* folded — folding
/// would make distinct paths collide on case-sensitive filesystems.
///
/// `..` is rejected rather than folded: notebook-relative paths never contain
/// it, so seeing one means the caller handed us something that escaped the
/// notebook.
pub fn normalize_key_path(raw: &str) -> Result<String, SyncError> {
    let mut segments: Vec<String> = Vec::new();
    for segment in raw.split(['/', '\\']) {
        match segment {
            "" | "." => continue,
            ".." => {
                return Err(SyncError::InvalidState(format!(
                    "path {raw:?} escapes the notebook root"
                )));
            }
            other => segments.push(other.nfc().collect()),
        }
    }
    if segments.is_empty() {
        return Err(SyncError::InvalidState(format!(
            "path {raw:?} has no components"
        )));
    }
    let key = segments.join("/");
    if key.len() > MAX_NOTEBOOK_PATH_BYTES {
        return Err(SyncError::InvalidState(format!(
            "path {raw:?} exceeds {MAX_NOTEBOOK_PATH_BYTES} bytes as a notebook path"
        )));
    }
    Ok(key)
}

/// One path as the device last persisted it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V4PathState {
    /// Normalised key (see [`normalize_key_path`]).
    pub path: String,
    /// Relative path exactly as it exists on disk.
    ///
    /// Not redundant with `path`: normalisation rewrites the byte sequence on
    /// macOS (NFD on disk, NFC in the key), so opening the file needs the
    /// original.
    pub display_path: String,
    /// `sha256:<hex>` of the bytes last uploaded or downloaded. `None` until
    /// the first transfer: the design never hashes speculatively (§4.1).
    pub content_hash: Option<String>,
    /// Local size at the moment `local_mtime_millis` was recorded.
    pub local_size: u64,
    /// Local modification time at that same moment.
    pub local_mtime_millis: i64,
    /// Remote `LastModified` this path was last reconciled against, in ms. The
    /// only baseline the design keeps — no revision chain, no server sequence.
    pub last_synced_at: i64,
    /// ETag of the remote object as this device last left it.
    ///
    /// Not a content hash (it is an md5 or a multipart digest) and never
    /// compared with one. `LastModified` is second-resolution, so two devices
    /// writing the same key in the same second are indistinguishable by time;
    /// this is the only signal that the object was replaced. `None` until the
    /// first transfer, and for rows written before the column existed.
    pub remote_etag: Option<String>,
    /// First time the key was observed absent from a fully enumerated
    /// directory. Cleared the moment the key comes back or the deletion is
    /// applied.
    pub pending_since: Option<i64>,
}

impl V4PathState {
    /// Whether the bytes on disk differ from what was last persisted.
    ///
    /// Compares with `!=` on purpose: a restored or `touch`ed file can move its
    /// mtime backwards, and treating that as clean would silently skip an edit.
    /// The cost of a false positive is one unnecessary upload; the cost of a
    /// false negative is a lost edit.
    pub fn is_dirty(&self, size: u64, mtime_millis: i64) -> bool {
        size != self.local_size || mtime_millis != self.local_mtime_millis
    }
}

/// Per-notebook state that outlives any single path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V4NotebookState {
    pub notebook_id: String,
    /// Deletes are suppressed until this instant. Set when the notebook is
    /// first bound and again after a bucket switch (§13.2①): an empty new
    /// bucket must never be read as "the cloud deleted everything".
    pub grace_until: Option<i64>,
    /// `sha256(backendId|bucket|prefix)` of the credential the state belongs
    /// to. When it changes, pending deletions and baselines are meaningless —
    /// they describe a different bucket's `LastModified` clock.
    pub credential_fingerprint: String,
}

impl V4NotebookState {
    pub fn new(notebook_id: impl Into<String>, credential_fingerprint: impl Into<String>) -> Self {
        Self {
            notebook_id: notebook_id.into(),
            grace_until: None,
            credential_fingerprint: credential_fingerprint.into(),
        }
    }

    pub fn allows_deletes(&self, server_now_millis: i64) -> bool {
        self.grace_until
            .is_none_or(|until| server_now_millis >= until)
    }
}

/// One file as the local scanner sees it, already keyed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannedLocalFile {
    pub key: String,
    pub display_path: String,
    pub size: u64,
    pub mtime_millis: i64,
}

impl ScannedLocalFile {
    pub fn new(
        display_path: impl Into<String>,
        size: u64,
        mtime_millis: i64,
    ) -> Result<Self, SyncError> {
        let display_path = display_path.into();
        Ok(Self {
            key: normalize_key_path(&display_path)?,
            display_path,
            size,
            mtime_millis,
        })
    }
}

/// Everything the state layer contributes to a pass.
#[derive(Debug, Clone, Default)]
pub struct V4LocalSnapshot {
    /// Persisted state, keyed by normalised path.
    pub states: BTreeMap<String, V4PathState>,
    /// Directories and the last time each was actually enumerated.
    pub dir_scans: BTreeMap<String, crate::reconcile::DirScanRecord>,
}

/// Combines persisted state with a fresh scan into the [`LocalView`] that
/// `reconcile` consumes.
///
/// Two behaviours worth stating, because both are load-bearing:
///
/// * A file the state has never seen is `dirty` — it has never been uploaded.
/// * A path present in state but **missing** from the scan is *not* turned into
///   a deletion here. The remote side decides that; locally we only report what
///   exists. Dropping the row because the file vanished would erase the baseline
///   the next pass needs to tell "deleted here" from "never had it".
pub fn build_local_view(
    snapshot: &V4LocalSnapshot,
    scanned: &[ScannedLocalFile],
    device_id: &str,
    allow_deletes: bool,
) -> LocalView {
    let mut files = Vec::with_capacity(scanned.len());
    for file in scanned {
        let dirty = match snapshot.states.get(&file.key) {
            Some(state) => state.is_dirty(file.size, file.mtime_millis),
            None => true,
        };
        files.push(LocalFile::new(file.key.clone(), file.size).dirty_if(dirty));
    }

    LocalView {
        files,
        last_synced_at: snapshot
            .states
            .iter()
            .map(|(path, state)| (path.clone(), state.last_synced_at))
            .collect(),
        remote_etags: snapshot
            .states
            .iter()
            .filter_map(|(path, state)| {
                state
                    .remote_etag
                    .as_ref()
                    .filter(|etag| !etag.is_empty())
                    .map(|etag| (path.clone(), etag.clone()))
            })
            .collect(),
        pending_deletions: snapshot
            .states
            .iter()
            .filter_map(|(path, state)| state.pending_since.map(|since| (path.clone(), since)))
            .collect(),
        device_id: device_id.to_string(),
        allow_deletes,
    }
}

/// State to persist after a successful upload or download.
///
/// `remote_etag` is what the bucket reported for the key right after the
/// transfer; it is the baseline the next pass uses to notice a same-second
/// replacement (§4.3).
#[allow(clippy::too_many_arguments)]
pub fn state_after_transfer(
    key: impl Into<String>,
    display_path: impl Into<String>,
    content_hash: impl Into<String>,
    local_size: u64,
    local_mtime_millis: i64,
    remote_mtime_millis: i64,
    remote_etag: Option<String>,
) -> V4PathState {
    V4PathState {
        path: key.into(),
        display_path: display_path.into(),
        content_hash: Some(content_hash.into()),
        local_size,
        local_mtime_millis,
        last_synced_at: remote_mtime_millis,
        remote_etag,
        pending_since: None,
    }
}

/// Fingerprint that identifies "which bucket's clock do these baselines
/// belong to".
pub fn credential_fingerprint(backend_id: &str, bucket: &str, prefix: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    for part in [backend_id, bucket, prefix] {
        digest.update(part.as_bytes());
        digest.update([0u8]);
    }
    let hex: String = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("sha256:{hex}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_case_preserving_and_separator_agnostic() {
        assert_eq!(
            normalize_key_path("notes/plan.md").unwrap(),
            "notes/plan.md"
        );
        assert_eq!(
            normalize_key_path("./notes//plan.md").unwrap(),
            "notes/plan.md"
        );
        assert_eq!(
            normalize_key_path("/notes/plan.md").unwrap(),
            "notes/plan.md"
        );
        // Windows separators reach the same key.
        assert_eq!(
            normalize_key_path(r"notes\2026\q4.md").unwrap(),
            "notes/2026/q4.md"
        );
        // Case is an identity: folding it would need the display name in
        // metadata, which COS cannot hold.
        assert_eq!(
            normalize_key_path("Notes/Plan.MD").unwrap(),
            "Notes/Plan.MD"
        );
    }

    /// macOS gives NFD (`e` + combining acute), Windows gives NFC. Without
    /// folding, one file becomes two keys and cross-device deletes diverge.
    #[test]
    fn folds_unicode_composition_but_not_case() {
        let decomposed = "cafe\u{301}/re\u{301}sume\u{301}.md";
        let composed = "café/résumé.md";
        assert_eq!(
            normalize_key_path(decomposed).unwrap(),
            normalize_key_path(composed).unwrap()
        );
        assert_eq!(normalize_key_path(composed).unwrap(), composed);
    }

    #[test]
    fn rejects_escaping_and_empty_paths() {
        assert!(normalize_key_path("../secrets.md").is_err());
        assert!(normalize_key_path("notes/../../x.md").is_err());
        assert!(normalize_key_path("").is_err());
        assert!(normalize_key_path("/").is_err());
        assert!(normalize_key_path(".").is_err());
        // The relative path cap leaves room for the object key prefix (§2 rule 3).
        let at_limit = "a".repeat(MAX_NOTEBOOK_PATH_BYTES);
        assert_eq!(
            normalize_key_path(&at_limit).unwrap().len(),
            MAX_NOTEBOOK_PATH_BYTES
        );
        let over = "a".repeat(MAX_NOTEBOOK_PATH_BYTES + 1);
        assert!(normalize_key_path(&over).is_err());
    }

    #[test]
    fn an_unseen_file_is_dirty_and_a_restored_one_is_too() {
        let state = state_after_transfer("a.md", "a.md", "sha256:aa", 10, 1_000, 2_000, None);
        assert!(!state.is_dirty(10, 1_000));

        // Same length, different content: only the mtime betrays it.
        assert!(state.is_dirty(10, 1_001));
        // Size changed.
        assert!(state.is_dirty(11, 1_000));
        // mtime went *backwards* (restore from a backup), still an edit.
        assert!(state.is_dirty(10, 999));
    }

    #[test]
    fn local_view_marks_unknown_files_dirty_and_keeps_baselines() {
        let mut snapshot = V4LocalSnapshot::default();
        snapshot.states.insert(
            "notes/known.md".into(),
            V4PathState {
                pending_since: Some(5_000),
                ..state_after_transfer(
                    "notes/known.md",
                    "notes/known.md",
                    "sha256:aa",
                    10,
                    1_000,
                    2_000,
                    None,
                )
            },
        );

        let scanned = vec![
            ScannedLocalFile::new("notes/known.md", 10, 1_000).unwrap(),
            ScannedLocalFile::new("notes/fresh.md", 20, 3_000).unwrap(),
        ];
        let view = build_local_view(&snapshot, &scanned, "mac-7f3a", true);

        assert_eq!(view.files.len(), 2);
        assert!(!view.files[0].dirty, "unchanged file stays clean");
        assert!(view.files[1].dirty, "never uploaded");
        assert_eq!(view.last_synced_at.get("notes/known.md"), Some(&2_000));
        assert_eq!(view.pending_deletions.get("notes/known.md"), Some(&5_000));
        assert_eq!(view.device_id, "mac-7f3a");
        assert!(view.allow_deletes);
    }

    /// A vanished file keeps its baseline: the *remote* side decides whether
    /// the absence means "deleted here" or "someone else still has it".
    #[test]
    fn a_vanished_file_keeps_its_row() {
        let mut snapshot = V4LocalSnapshot::default();
        snapshot.states.insert(
            "gone.md".into(),
            state_after_transfer("gone.md", "gone.md", "sha256:aa", 10, 1_000, 2_000, None),
        );
        let view = build_local_view(&snapshot, &[], "mac-7f3a", true);
        assert!(view.files.is_empty());
        assert_eq!(view.last_synced_at.get("gone.md"), Some(&2_000));
    }

    #[test]
    fn fingerprint_changes_with_bucket_and_prefix_only() {
        let base = credential_fingerprint("r2-primary", "flowix", "u/usr_1/");
        assert_eq!(
            base,
            credential_fingerprint("r2-primary", "flowix", "u/usr_1/")
        );
        assert_ne!(
            base,
            credential_fingerprint("cos-mainland", "flowix", "u/usr_1/")
        );
        assert_ne!(
            base,
            credential_fingerprint("r2-primary", "other", "u/usr_1/")
        );
        assert_ne!(
            base,
            credential_fingerprint("r2-primary", "flowix", "u/usr_2/")
        );
    }

    #[test]
    fn grace_window_gates_deletes() {
        let mut state = V4NotebookState::new("nb_1", "sha256:aa");
        assert!(state.allows_deletes(0));
        state.grace_until = Some(10_000);
        assert!(!state.allows_deletes(9_999));
        assert!(state.allows_deletes(10_000));
    }
}
