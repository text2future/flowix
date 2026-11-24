use std::collections::BTreeSet;

use chrono::Utc;

use super::{
    collect, list_stamps, notebook_prefix, quota_exhausted, resolve_tombstones, ObjectSource,
    PassPlan, PassRequest, BIND_GRACE_MS,
};
use crate::error::SyncError;
use crate::object_store::ObjectStoreCredentials;
use crate::reconcile::{
    dir_of, directories_to_scan, reconcile, Defer, DeferReason, ReconcilePlan, RemoteListing,
    SyncAction,
};
use crate::store::SyncStore;
use crate::v4::{build_local_view, credential_fingerprint, V4NotebookState};
use crate::v4_apply::{object_key, ApplyFailure};

/// Enumerates remote state and builds the action plan without transferring file bodies.
///
/// This is not a read-only preview: on first binding or a target change it
/// persists the binding and resets the relevant local baselines and grace period.
pub async fn plan_pass(
    source: &mut dyn ObjectSource,
    credentials: &ObjectStoreCredentials,
    store: &SyncStore,
    request: &PassRequest<'_>,
) -> Result<PassPlan, SyncError> {
    plan_pass_with_proxy(source, credentials, store, request, false).await
}

pub(super) async fn plan_pass_with_proxy(
    source: &mut dyn ObjectSource,
    credentials: &ObjectStoreCredentials,
    store: &SyncStore,
    request: &PassRequest<'_>,
    deletion_proxy: bool,
) -> Result<PassPlan, SyncError> {
    let notebook_id = request.notebook_id;

    // L0: one listing of the stamps is the whole steady-state cost.
    let stamps = list_stamps(source, notebook_id).await?;
    let (server_now_millis, clock_trusted) = match stamps.server_date_millis {
        Some(millis) => (millis, true),
        None => {
            tracing::warn!(
                notebook_id,
                "object store omitted the Date header; using the device clock and suppressing deletes"
            );
            (Utc::now().timestamp_millis(), false)
        }
    };

    let fingerprint = credential_fingerprint(
        &credentials.backend_id,
        &credentials.bucket,
        &credentials.prefix,
    );
    let rebound = bind_if_needed(store, notebook_id, &fingerprint, server_now_millis)?;
    let notebook_state = store
        .v4_notebook_state(notebook_id)?
        .unwrap_or_else(|| V4NotebookState::new(notebook_id, &fingerprint));
    let snapshot = store.v4_snapshot(notebook_id)?;
    // The gate never looks at `allow_deletes`, only at the file list, so the
    // view is built once here and rebuilt below with the final flag.
    let gate_view = build_local_view(&snapshot, request.scanned, request.device_id, true);

    let mut listing = RemoteListing::default();
    let mut list_failures = Vec::new();
    let mut listed_dirs = Vec::new();

    if request.force {
        // The sweep. One recursive listing covers every directory, so every
        // directory counts as enumerated and every absence is real.
        match collect(
            source,
            &notebook_prefix(notebook_id),
            None,
            notebook_id,
            &mut listing,
        )
        .await
        {
            Ok(()) => {
                let mut dirs: BTreeSet<String> = listing
                    .observed
                    .keys()
                    .map(|path| dir_of(path).to_string())
                    .collect();
                dirs.extend(
                    gate_view
                        .files
                        .iter()
                        .map(|file| dir_of(&file.path).to_string()),
                );
                dirs.extend(stamps.dirs.keys().cloned());
                listed_dirs = dirs.into_iter().collect();
                listing.observed_dirs.extend(listed_dirs.iter().cloned());
            }
            Err(error) => list_failures.push(ApplyFailure {
                path: "<sweep>".to_string(),
                message: error.to_string(),
            }),
        }
    } else {
        let due = directories_to_scan(
            &gate_view,
            &stamps.dirs,
            &snapshot.dir_scans,
            server_now_millis,
            false,
        );
        let results = source
            .list_directories(notebook_id.to_string(), due.clone())
            .await;
        let mut results = results.into_iter();
        for expected in due {
            let Some((dir, partial, result)) = results.next() else {
                list_failures.push(ApplyFailure {
                    path: expected,
                    message: "missing directory listing result".into(),
                });
                continue;
            };
            if dir != expected {
                list_failures.push(ApplyFailure {
                    path: expected,
                    message: "directory listing result out of order".into(),
                });
                continue;
            }
            for object in partial.observed.into_values() {
                listing.observe(object);
            }
            match result {
                Ok(()) => {
                    listing.observed_dirs.insert(dir.clone());
                    listed_dirs.push(dir);
                }
                Err(error) => list_failures.push(ApplyFailure {
                    path: dir,
                    message: error.to_string(),
                }),
            }
        }
    }

    // A `list` cannot tell a tombstone from an empty note: both are zero bytes
    // and the marker lives in metadata. Resolving this is not optional — a
    // tombstone read as a file downloads as an empty body and overwrites the
    // note with nothing.
    resolve_tombstones(source, notebook_id, &mut listing, &mut list_failures).await;

    // A changed credential fingerprint says the bucket binding changed; it
    // does not prove that any operator-side data copy completed. If known local
    // state meets an empty bucket, keep deletes suppressed until remote content
    // appears instead of treating the empty listing as a mass deletion.
    let bucket_looks_unbound =
        rebound && listing.observed.is_empty() && !snapshot.states.is_empty();
    if bucket_looks_unbound {
        tracing::warn!(
            notebook_id,
            "bucket is empty right after a rebind; suppressing deletes"
        );
    }
    let allows_deletes =
        clock_trusted && !bucket_looks_unbound && notebook_state.allows_deletes(server_now_millis);
    let local_view = build_local_view(
        &snapshot,
        request.scanned,
        request.device_id,
        allows_deletes,
    );

    let mut plan = reconcile(&local_view, &listing, server_now_millis);
    // `probe` exists so a single `HEAD` can be cheaper than guessing; the
    // answer has to feed *this* pass, otherwise a dirty file in an unlisted
    // directory waits a full interval for nothing.
    if plan
        .actions
        .iter()
        .any(|action| matches!(action, SyncAction::Probe(_)))
    {
        let paths = probe_paths(&plan);
        let keys = paths
            .iter()
            .map(|path| object_key(notebook_id, path))
            .collect();
        let mut results = source.head_many(keys).await.into_iter();
        for path in paths {
            let result = results
                .next()
                .unwrap_or_else(|| Err(SyncError::InvalidState("missing HEAD result".into())));
            match result {
                Ok(Some(mut object)) => {
                    // `HEAD` answers about the key, not the notebook path.
                    object.path = path;
                    listing.observe(object);
                }
                Ok(None) => listing.mark_missing(&path),
                // Keep it unknown: a 500 must not become evidence of absence.
                Err(error) => {
                    listing.mark_unknown(&path);
                    list_failures.push(ApplyFailure {
                        path,
                        message: error.to_string(),
                    });
                }
            }
        }
        plan = reconcile(&local_view, &listing, server_now_millis);
    }
    // Whatever still wants a probe had a failed `HEAD`; defer it a pass rather
    // than retrying inside this one.
    plan.actions
        .retain(|action| !matches!(action, SyncAction::Probe(_)));
    plan.stats.probes = 0;

    // A read-only credential cannot publish, and a full account must not try.
    // Planning an upload that will 403 on every pass is worse than deferring it:
    // the pass still pulls (read scope allows GET) and `writable` lets the caller
    // explain the silence.
    let writable = credentials.can_write() && !quota_exhausted(request.quota);
    if !writable {
        let mut blocked = 0usize;
        plan.actions = plan
            .actions
            .into_iter()
            .map(|action| match action {
                SyncAction::Upload(upload) => {
                    blocked += 1;
                    SyncAction::Defer(Defer {
                        path: upload.path,
                        reason: DeferReason::ReadOnly,
                    })
                }
                SyncAction::WriteTombstone(tombstone) if !deletion_proxy => {
                    blocked += 1;
                    SyncAction::Defer(Defer {
                        path: tombstone.path,
                        reason: DeferReason::ReadOnly,
                    })
                }
                other => other,
            })
            .collect();
        plan.stats.uploads = 0;
        if !deletion_proxy {
            plan.stats.tombstones = 0;
        }
        plan.stats.deferred += blocked;
        // Planning an upload also reserved a stamp write for its directory.
        // Nothing was published, so bumping the stamp would only make every
        // other device re-list those directories — on every single pass.
        plan.touch_dirs = BTreeSet::new();
    }

    guard_mass_deletion(&plan, snapshot.states.len())?;

    Ok(PassPlan {
        server_now_millis,
        clock_trusted,
        snapshot,
        stamps: stamps.dirs,
        listing,
        plan,
        listed_dirs,
        list_failures,
        rebound,
        allows_deletes,
        writable,
    })
}

// Abort the whole pass before any file operations or checkpoints. A user can
// restore accidentally missing files and retry; repeated polling cannot
// gradually consume a blocked batch.
fn guard_mass_deletion(plan: &ReconcilePlan, known_paths: usize) -> Result<(), SyncError> {
    let deletions = plan
        .actions
        .iter()
        .filter(|action| {
            matches!(
                action,
                SyncAction::DeleteLocal(_) | SyncAction::WriteTombstone(_)
            )
        })
        .count();
    if deletions >= 20 && deletions.saturating_mul(2) >= known_paths {
        return Err(SyncError::InvalidState(format!(
            "CLOUD_MASS_DELETE_BLOCKED: {deletions} of {known_paths} known files would be deleted; restore the missing files and retry"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod mass_deletion_tests {
    use super::*;
    use crate::reconcile::{DeleteLocal, Tombstone, Upload, UploadReason};

    #[test]
    fn blocks_large_deletion_batches_but_allows_small_or_sparse_ones() {
        let mut plan = ReconcilePlan::default();
        for n in 0..20 {
            let path = format!("{n}.md");
            plan.actions.push(if n % 2 == 0 {
                SyncAction::DeleteLocal(DeleteLocal { path })
            } else {
                SyncAction::WriteTombstone(Tombstone { path })
            });
        }
        plan.actions.push(SyncAction::Upload(Upload {
            path: "new.md".into(),
            reason: UploadReason::New,
        }));
        assert!(guard_mass_deletion(&plan, 40)
            .unwrap_err()
            .to_string()
            .contains("CLOUD_MASS_DELETE_BLOCKED"));
        assert!(guard_mass_deletion(&plan, 41).is_ok());
        plan.actions.remove(0);
        assert!(guard_mass_deletion(&plan, 20).is_ok());
    }
}

fn probe_paths(plan: &ReconcilePlan) -> Vec<String> {
    plan.actions
        .iter()
        .filter_map(|action| match action {
            SyncAction::Probe(probe) => Some(probe.path.clone()),
            _ => None,
        })
        .collect()
}

/// Binds the notebook to this credential, or rebinds it after a bucket switch.
///
/// The store changes the binding in one transaction: pending deletions are
/// cleared, baselines move to the new bucket's clock, and a grace window opens
/// so an empty bucket cannot be mistaken for a mass deletion.
fn bind_if_needed(
    store: &SyncStore,
    notebook_id: &str,
    fingerprint: &str,
    server_now_millis: i64,
) -> Result<bool, SyncError> {
    match store.v4_notebook_state(notebook_id)? {
        Some(state) if state.credential_fingerprint == fingerprint => Ok(false),
        _ => {
            store.v4_rebind_credential(
                notebook_id,
                fingerprint,
                server_now_millis,
                server_now_millis + BIND_GRACE_MS,
            )?;
            Ok(true)
        }
    }
}
