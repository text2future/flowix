use std::collections::BTreeSet;

use chrono::Utc;

use super::{
    collect, list_stamps, notebook_prefix, quota_exhausted, resolve_tombstones, ObjectSource,
    PassPlan, PassRequest, StampListing, BIND_GRACE_MS,
};
use crate::apply::{object_key, ApplyFailure, FailureKind};
use crate::error::SyncError;
use crate::object_store::ObjectStoreCredentials;
use crate::reconcile::{
    dir_of, directories_to_scan, reconcile, Defer, DeferReason, ReconcilePlan, RemoteListing,
    SyncAction,
};
use crate::state::{build_local_view, credential_fingerprint, LocalSnapshot, NotebookState};
use crate::store::SyncStore;

/// The state a plan is built from, gathered once.
///
/// Split out of planning so the planner itself stops writing to the database:
/// the first bind, or a bind after a target change, resets baselines and opens
/// a grace period. That has to happen *before* the plan is built, not as a
/// side effect of building it.
pub struct PreparedPass {
    pub(super) stamps: StampListing,
    pub server_now_millis: i64,
    pub clock_trusted: bool,
    pub rebound: bool,
    pub credential_writable: bool,
    pub(super) notebook_state: NotebookState,
    pub(super) snapshot: LocalSnapshot,
}

/// Lists the stamps, takes the server clock they carry, and settles the binding.
///
/// Everything here either touches the network or may write state; the plan
/// built from the result does neither.
pub async fn prepare_pass(
    source: &mut dyn ObjectSource,
    credentials: &ObjectStoreCredentials,
    store: &SyncStore,
    notebook_id: &str,
) -> Result<PreparedPass, SyncError> {
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
        .notebook_state(notebook_id)?
        .unwrap_or_else(|| NotebookState::new(notebook_id, &fingerprint));
    let snapshot = store.snapshot(notebook_id)?;
    Ok(PreparedPass {
        stamps,
        server_now_millis,
        clock_trusted,
        rebound,
        credential_writable: credentials.can_write(),
        notebook_state,
        snapshot,
    })
}

/// Enumerates remote state and builds the action plan without transferring file bodies.
///
/// Reads only what it is given: the listing, the clock and the baseline all
/// arrive in [`PreparedPass`], so a plan can be built without touching the
/// database at all.
pub async fn plan_pass(
    source: &mut dyn ObjectSource,
    request: &PassRequest<'_>,
    preparation: PreparedPass,
    deletion_proxy: bool,
) -> Result<PassPlan, SyncError> {
    let notebook_id = request.notebook_id;
    let PreparedPass {
        stamps,
        server_now_millis,
        clock_trusted,
        rebound,
        credential_writable,
        notebook_state,
        snapshot,
    } = preparation;
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
            Err(error) => list_failures.push(ApplyFailure::from_error("<sweep>", &error)),
        }
    } else {
        let mut due: BTreeSet<String> =
            directories_to_scan(&gate_view, &stamps.dirs, &snapshot.dir_scans, false)
                .into_iter()
                .collect();
        let scanned: BTreeSet<&str> = request
            .scanned
            .iter()
            .map(|file| file.key.as_str())
            .collect();
        for path in snapshot
            .states
            .keys()
            .filter(|path| !scanned.contains(path.as_str()))
        {
            due.insert(dir_of(path).to_string());
        }
        let due: Vec<String> = due.into_iter().collect();
        let results = source
            .list_directories(notebook_id.to_string(), due.clone())
            .await;
        let mut results = results.into_iter();
        for expected in due {
            let Some((dir, partial, result)) = results.next() else {
                list_failures.push(ApplyFailure::of(
                    expected,
                    FailureKind::Transient,
                    "missing directory listing result",
                ));
                continue;
            };
            if dir != expected {
                list_failures.push(ApplyFailure::of(
                    expected,
                    FailureKind::Transient,
                    "directory listing result out of order",
                ));
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
                Err(error) => list_failures.push(ApplyFailure::from_error(dir, &error)),
            }
        }
    }

    // A `list` cannot tell a tombstone from an empty note: both are zero bytes
    // and the marker lives in metadata. Resolving this is not optional — a
    // tombstone read as a file downloads as an empty body and overwrites the
    // note with nothing.
    resolve_tombstones(source, notebook_id, &mut listing, &mut list_failures).await;
    listed_dirs.retain(|dir| !listing.unknown_keys.iter().any(|path| dir_of(path) == dir));

    // A local absence and a listing omission are not enough to forget the
    // baseline: HEAD the exact key before treating both sides as absent.
    let scanned: BTreeSet<&str> = request
        .scanned
        .iter()
        .map(|file| file.key.as_str())
        .collect();
    let missing_local: Vec<String> = snapshot
        .states
        .keys()
        .filter(|path| {
            !scanned.contains(path.as_str())
                && matches!(
                    listing.state_for(path),
                    crate::reconcile::RemoteState::Missing
                )
                && !listing.missing_keys.contains(*path)
        })
        .cloned()
        .collect();
    if !missing_local.is_empty() {
        let keys = missing_local
            .iter()
            .map(|path| object_key(notebook_id, path))
            .collect();
        let mut results = source.head_many(keys).await.into_iter();
        for path in missing_local {
            match results
                .next()
                .unwrap_or_else(|| Err(SyncError::InvalidState("missing HEAD result".into())))
            {
                Ok(Some(mut object)) => {
                    object.path = path;
                    listing.observe(object);
                }
                Ok(None) => listing.mark_missing(&path),
                Err(error) => {
                    listing.mark_unknown(&path);
                    listed_dirs.retain(|dir| dir != dir_of(&path));
                    list_failures.push(ApplyFailure::from_error(path, &error));
                }
            }
        }
    }

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
                    list_failures.push(ApplyFailure::from_error(path, &error));
                }
            }
        }
        plan = reconcile(&local_view, &listing, server_now_millis);
    }
    // Listings can temporarily omit live objects. Confirm inferred remote
    // deletions by HEAD; resolved tombstones already provide positive evidence.
    let missing: Vec<String> = plan
        .actions
        .iter()
        .filter_map(|action| match action {
            SyncAction::DeleteLocal(item)
                if !listing.missing_keys.contains(&item.path)
                    && matches!(
                        listing.state_for(&item.path),
                        crate::reconcile::RemoteState::Missing
                    ) =>
            {
                Some(item.path.clone())
            }
            _ => None,
        })
        .collect();
    if !missing.is_empty() {
        let keys = missing
            .iter()
            .map(|path| object_key(notebook_id, path))
            .collect();
        let mut results = source.head_many(keys).await.into_iter();
        for path in missing {
            match results
                .next()
                .unwrap_or_else(|| Err(SyncError::InvalidState("missing HEAD result".into())))
            {
                Ok(Some(mut object)) => {
                    object.path = path;
                    listing.observe(object);
                }
                Ok(None) => listing.mark_missing(&path),
                Err(error) => {
                    listing.mark_unknown(&path);
                    // Do not checkpoint this listing: a later pass must retry
                    // the unresolved absence even if the stamp stays quiet.
                    listed_dirs.retain(|dir| dir != dir_of(&path));
                    list_failures.push(ApplyFailure::from_error(path, &error));
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
    let writable = credential_writable && !quota_exhausted(request.quota);
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

    defer_mass_deletion(
        &mut plan,
        snapshot.states.len(),
        request.allow_mass_deletion,
        server_now_millis,
    );

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

/// Below this many deletions a pass never asks for confirmation, whatever the
/// share of the notebook: twenty files leaving is a normal afternoon.
const MASS_DELETION_MIN: usize = 20;

/// A batch that deletes a large share of the notebook is either a deliberate
/// bulk delete or evidence that the scan or the listing is broken. Inside one
/// pass those two look identical, and neither answer is "delete and hope":
///
/// - failing the whole pass froze the notebook until the user restored files,
///   which for a real bulk delete means the sync never worked again;
/// - applying it turns one bad scan into a wiped notebook.
///
/// So the deletions alone are deferred, everything else in the plan still
/// runs and checkpoints, and each path keeps a pending marker so a later pass
/// (after the caller has asked the user) finishes the job. `allowed` is that
/// answer; it comes from the caller, never from the engine guessing.
fn defer_mass_deletion(
    plan: &mut ReconcilePlan,
    known_paths: usize,
    allowed: bool,
    server_now_millis: i64,
) {
    if allowed {
        return;
    }
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
    if deletions < MASS_DELETION_MIN || deletions.saturating_mul(2) < known_paths {
        return;
    }

    let mut deferred = 0;
    plan.actions = std::mem::take(&mut plan.actions)
        .into_iter()
        .map(|action| match action {
            SyncAction::DeleteLocal(item) => {
                deferred += 1;
                defer_mass(&mut plan.pending_deletions, &item.path, server_now_millis);
                SyncAction::Defer(Defer {
                    path: item.path,
                    reason: DeferReason::MassDeletionLocal,
                })
            }
            SyncAction::WriteTombstone(item) => {
                deferred += 1;
                defer_mass(&mut plan.pending_deletions, &item.path, server_now_millis);
                SyncAction::Defer(Defer {
                    path: item.path,
                    reason: DeferReason::MassDeletionRemote,
                })
            }
            other => other,
        })
        .collect();

    plan.stats.deletes = 0;
    plan.stats.tombstones = 0;
    plan.stats.deferred += deferred;
    plan.stats.mass_deletion_deferred = deferred;

    // A deferred deletion published nothing, so its directory must not be
    // stamped: every other device would re-list that directory on every pass
    // for as long as the batch waits. Keep only the directories that still
    // have a write of their own.
    let written: BTreeSet<String> = plan
        .actions
        .iter()
        .filter_map(|action| match action {
            SyncAction::Upload(upload) => Some(dir_of(&upload.path).to_string()),
            SyncAction::WriteTombstone(tombstone) => Some(dir_of(&tombstone.path).to_string()),
            _ => None,
        })
        .collect();
    plan.touch_dirs.retain(|dir| written.contains(dir));
}

/// The marker is what re-opens the directory next pass. Without it the plan
/// would never see these paths again — a stamp that did not move means "nothing
/// changed here", which is exactly wrong for a deletion that was refused.
fn defer_mass(pending: &mut std::collections::BTreeMap<String, i64>, path: &str, now: i64) {
    pending.entry(path.to_string()).or_insert(now);
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
/// The store changes the binding in one transaction: deletion retry markers
/// are cleared, baselines move to the new bucket's clock, and a grace window
/// opens so an empty bucket cannot be mistaken for a mass deletion.
fn bind_if_needed(
    store: &SyncStore,
    notebook_id: &str,
    fingerprint: &str,
    server_now_millis: i64,
) -> Result<bool, SyncError> {
    match store.notebook_state(notebook_id)? {
        Some(state) if state.credential_fingerprint == fingerprint => Ok(false),
        _ => {
            store.rebind_credential(
                notebook_id,
                fingerprint,
                server_now_millis,
                server_now_millis + BIND_GRACE_MS,
            )?;
            Ok(true)
        }
    }
}

#[cfg(test)]
mod mass_deletion_tests {
    use super::*;
    use crate::reconcile::{DeleteLocal, Tombstone, Upload, UploadReason};

    fn plan_with_deletions(count: usize) -> ReconcilePlan {
        let mut plan = ReconcilePlan::default();
        for n in 0..count {
            let path = format!("{n}.md");
            plan.actions.push(if n % 2 == 0 {
                SyncAction::DeleteLocal(DeleteLocal { path })
            } else {
                SyncAction::WriteTombstone(Tombstone {
                    path,
                    expected_etag: None,
                })
            });
        }
        plan.actions.push(SyncAction::Upload(Upload {
            path: "new.md".into(),
            reason: UploadReason::New,
        }));
        plan.touch_dirs.insert("0".to_string());
        plan.touch_dirs.insert(String::new());
        plan
    }

    #[test]
    fn a_large_batch_defers_only_the_deletions() {
        let mut plan = plan_with_deletions(20);
        defer_mass_deletion(&mut plan, 40, false, 7_000);

        assert_eq!(plan.stats.mass_deletion_deferred, 20);
        assert_eq!(plan.stats.deletes, 0);
        assert_eq!(plan.stats.tombstones, 0);
        assert_eq!(plan.stats.deferred, 20);
        assert_eq!(
            plan.actions
                .iter()
                .filter(|action| action.kind_tag().starts_with("defer:mass-deletion"))
                .count(),
            20
        );
        assert_eq!(
            plan.actions
                .iter()
                .filter(|action| action.kind_tag() == "defer:mass-deletion-remote")
                .count(),
            10,
            "the paths the cloud still had are the ones that would be published"
        );
        assert_eq!(
            plan.actions
                .iter()
                .filter(|action| action.kind_tag() == "defer:mass-deletion-local")
                .count(),
            10
        );
        assert_eq!(
            plan.actions
                .iter()
                .filter(|action| action.kind_tag() == "upload:new")
                .count(),
            1,
            "the upload still travels"
        );
        assert_eq!(plan.pending_deletions.len(), 20);
        assert_eq!(plan.pending_deletions["0.md"], 7_000);
        // Only the directory that still gets a write keeps its stamp bump.
        assert!(!plan.touch_dirs.contains("0"));
    }

    #[test]
    fn small_or_sparse_batches_are_left_alone() {
        // 20 deletions out of 41 known paths is under half: allowed.
        let mut plan = plan_with_deletions(20);
        defer_mass_deletion(&mut plan, 41, false, 7_000);
        assert_eq!(plan.stats.mass_deletion_deferred, 0);
        assert_eq!(plan.stats.deletes + plan.stats.tombstones, 0);

        // 19 of 20 is over half but under the floor: also allowed.
        let mut plan = plan_with_deletions(19);
        defer_mass_deletion(&mut plan, 20, false, 7_000);
        assert_eq!(plan.stats.mass_deletion_deferred, 0);
    }

    #[test]
    fn a_confirmed_batch_is_applied() {
        let mut plan = plan_with_deletions(20);
        defer_mass_deletion(&mut plan, 40, true, 7_000);
        assert_eq!(plan.stats.mass_deletion_deferred, 0);
        assert!(plan
            .actions
            .iter()
            .any(|action| action.kind_tag() == "write-tombstone"));
    }
}
