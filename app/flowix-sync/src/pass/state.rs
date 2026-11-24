use std::collections::{BTreeMap, BTreeSet};

use super::{PassPlan, StateUpdates};
use crate::reconcile::{dir_of, DirScanRecord, ReconcilePlan, SyncAction};
use crate::state::{ScannedLocalFile, PathState};
use crate::apply::ApplyOutcome;

/// Rows to persist. Pure, so the rules below are asserted without a database.
///
/// * A baseline is written **only** for a path no action touched. A transfer
///   writes its own state, and a *failed* transfer must not leave a baseline
///   behind — recording the stale local stat against the remote stamp would
///   make the next pass call the file "in sync" and drop the pending work.
/// * A row is dropped when both sides are gone, and when a local deletion was
///   propagated, so the table does not accumulate paths nobody has.
/// * `scanned_at_millis` is the server time of the listing, not the time the
///   upload finished. Being early only costs one extra re-list; being late
///   would skip a change written in between.
pub fn state_updates(
    scanned: &[ScannedLocalFile],
    prepared: &PassPlan,
    applied: &ApplyOutcome,
) -> StateUpdates {
    let index: BTreeMap<&str, &ScannedLocalFile> = scanned
        .iter()
        .map(|file| (file.key.as_str(), file))
        .collect();
    let failed: BTreeSet<&str> = applied
        .failures
        .iter()
        .map(|failure| failure.path.as_str())
        .collect();

    let transferred = action_paths(&prepared.plan);
    let mut states = Vec::with_capacity(prepared.plan.baselines.len());
    for baseline in &prepared.plan.baselines {
        let path = baseline.path.as_str();
        if transferred.contains(path) {
            continue;
        }
        let Some(file) = index.get(path) else {
            // The file is gone; absence is decided by the deletion rules, not
            // by a baseline for something that does not exist.
            continue;
        };
        let existing = prepared.snapshot.states.get(path);
        // The listing is authoritative here: this branch only runs for paths
        // the pass decided are in sync, so the ETag on record must be the one
        // the bucket just reported. Falling back to the stored value keeps the
        // column populated when a backend omits ETags from `list`.
        let remote_etag = prepared
            .listing
            .observed
            .get(path)
            .and_then(|object| object.etag.clone())
            .or_else(|| existing.and_then(|state| state.remote_etag.clone()));
        states.push(PathState {
            path: baseline.path.clone(),
            display_path: file.display_path.clone(),
            // Keeping the last known hash is correct here: this branch only
            // runs for paths that are clean (same size, same mtime), so the
            // bytes are the ones that hash describes.
            content_hash: existing.and_then(|state| state.content_hash.clone()),
            local_size: file.size,
            local_mtime_millis: file.mtime_millis,
            last_synced_at: baseline.mtime_millis,
            remote_etag,
            pending_since: None,
        });
    }

    let mut removed = applied.removed.clone();
    removed.extend(prepared.plan.forget.iter().cloned());

    let dir_scans = prepared
        .listed_dirs
        .iter()
        .map(|dir| {
            (
                dir.clone(),
                DirScanRecord {
                    stamp_millis: prepared.stamps.get(dir).copied().unwrap_or(0),
                    scanned_at_millis: prepared.server_now_millis,
                },
            )
        })
        .collect();

    let mut stamp_dirs: BTreeSet<String> = BTreeSet::new();
    for action in &prepared.plan.actions {
        let path = match action {
            SyncAction::Upload(upload) => &upload.path,
            SyncAction::WriteTombstone(tombstone) => &tombstone.path,
            _ => continue,
        };
        if failed.contains(path.as_str()) {
            continue;
        }
        stamp_dirs.insert(dir_of(path).to_string());
    }

    StateUpdates {
        states,
        removed,
        dir_scans,
        stamp_dirs: stamp_dirs.into_iter().collect(),
    }
}

fn action_paths(plan: &ReconcilePlan) -> BTreeSet<&str> {
    plan.actions
        .iter()
        .filter_map(|action| match action {
            SyncAction::Upload(upload) => Some(upload.path.as_str()),
            SyncAction::Download(download) => Some(download.path.as_str()),
            SyncAction::DeleteLocal(delete) => Some(delete.path.as_str()),
            SyncAction::WriteTombstone(tombstone) => Some(tombstone.path.as_str()),
            SyncAction::Probe(_) | SyncAction::Defer(_) => None,
        })
        .collect()
}

