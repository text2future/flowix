use std::collections::BTreeMap;

use chrono::{DateTime, Utc};

use super::{stamp_body, stamp_key, state_updates, PassEnv, PassPlan, PassReport, PassRequest};
use crate::apply::{
    self, ApplyContext, ApplyFailure, ApplyOutcome, ProgressObserver, TransferObserver,
};
use crate::error::SyncError;
use crate::reconcile::{dir_of, SyncAction};

/// Transfers, persistence and stamp bumps.
pub async fn execute_pass(
    env: &mut PassEnv<'_>,
    request: &PassRequest<'_>,
    prepared: &PassPlan,
    now: DateTime<Utc>,
) -> Result<PassReport, SyncError> {
    execute_pass_with_progress(env, request, prepared, now, None, None).await
}

pub(super) async fn execute_pass_with_progress(
    env: &mut PassEnv<'_>,
    request: &PassRequest<'_>,
    prepared: &PassPlan,
    now: DateTime<Utc>,
    on_transfer: Option<&TransferObserver<'_>>,
    on_progress: Option<&ProgressObserver<'_>>,
) -> Result<PassReport, SyncError> {
    let notebook_id = request.notebook_id;
    let mut stamped_dirs = Vec::new();
    let mut stamp_failures = Vec::new();
    if env.credential_resolver.supports_deletion_proxy() {
        for path in env.store.pending_proxy_deletions(notebook_id)? {
            match env
                .credential_resolver
                .proxy_deletion_stamp(notebook_id, &path)
                .await
            {
                Ok(()) => {
                    env.store.ack_proxy_deletion(notebook_id, &path)?;
                }
                // No tombstone remains to announce. Reconciliation will
                // examine the live/missing object again; a delayed write is
                // still covered by the periodic full sweep.
                Err(crate::error::SyncError::Api { status: 409, .. }) => {
                    env.store.ack_proxy_deletion(notebook_id, &path)?;
                }
                Err(error) => stamp_failures.push(ApplyFailure::from_error(&path, &error)),
            }
        }
    }
    if prepared.writable {
        // Drain work from an interrupted earlier pass before doing more writes.
        flush_pending_stamps(
            env,
            request,
            prepared.server_now_millis,
            &mut stamped_dirs,
            &mut stamp_failures,
        )
        .await?;
        // Queue before any PUT: cancellation can happen after a server accepts
        // a write but before the response or local checkpoint arrives.
        let planned_dirs: Vec<String> = prepared
            .plan
            .actions
            .iter()
            .filter_map(|action| match action {
                SyncAction::Upload(upload) => Some(dir_of(&upload.path).to_string()),
                SyncAction::WriteTombstone(tombstone) => Some(dir_of(&tombstone.path).to_string()),
                _ => None,
            })
            .collect();
        env.store.queue_stamps(notebook_id, &planned_dirs)?;
    }
    let context = ApplyContext {
        credential_resolver: env.credential_resolver,
        notebook_id,
        device_id: request.device_id,
    };
    let mut saved_states = 0;
    let mut saved_removals = 0;
    let mut checkpoint = |outcome: &ApplyOutcome| {
        env.store
            .save_path_states(notebook_id, &outcome.states[saved_states..])?;
        env.store
            .remove_path_states(notebook_id, &outcome.removed[saved_removals..])?;
        saved_states = outcome.states.len();
        saved_removals = outcome.removed.len();
        Ok(())
    };
    // Include both sides because downloads keep the prior local bytes until
    // the conditional write, and the remote size may differ from the scan.
    let mut sizes: BTreeMap<String, u64> = request
        .scanned
        .iter()
        .map(|file| (file.key.clone(), file.size))
        .collect();
    for (path, remote) in &prepared.listing.observed {
        sizes
            .entry(path.clone())
            .and_modify(|size| *size = size.saturating_add(remote.size))
            .or_insert(remote.size);
    }
    let mut execution_plan = prepared.plan.clone();
    let mut proxied = ApplyOutcome::default();
    if !prepared.writable && env.credential_resolver.supports_deletion_proxy() {
        execution_plan
            .actions
            .retain(|action| !matches!(action, SyncAction::WriteTombstone(_)));
        for action in &prepared.plan.actions {
            let SyncAction::WriteTombstone(item) = action else {
                continue;
            };
            let display = prepared
                .snapshot
                .states
                .get(&item.path)
                .map(|state| state.display_path.as_str())
                .unwrap_or(&item.path);
            env.store
                .queue_proxy_deletions(notebook_id, std::slice::from_ref(&item.path))?;
            let result = match crate::blocking::run(|| env.local.read(display)) {
                Ok(None) => match prepared
                    .listing
                    .observed
                    .get(&item.path)
                    .and_then(|object| object.etag.as_deref())
                {
                    Some(etag) => {
                        env.credential_resolver
                            .proxy_tombstone(notebook_id, &item.path, etag)
                            .await
                    }
                    None => Err(crate::error::SyncError::InvalidState(
                        "cannot delete without an observed remote ETag".into(),
                    )),
                },
                Ok(Some(_)) => Err(crate::error::SyncError::InvalidState(
                    "local file reappeared before deletion".into(),
                )),
                Err(error) => Err(error),
            };
            match result {
                Ok(()) => {
                    env.store.ack_proxy_deletion(notebook_id, &item.path)?;
                    env.store
                        .remove_path_states(notebook_id, std::slice::from_ref(&item.path))?;
                    proxied.removed.push(item.path.clone());
                }
                Err(error) => {
                    proxied
                        .failures
                        .push(ApplyFailure::from_error(item.path.clone(), &error));
                }
            }
        }
    }
    let mut applied = apply::apply_with_progress(
        env.http,
        &context,
        env.local,
        &execution_plan,
        &prepared.snapshot,
        now,
        &mut checkpoint,
        apply::ApplyOptions {
            sizes: Some(&sizes),
            max_upload_file_bytes: request.max_upload_file_bytes,
            on_transfer,
            on_progress,
        },
    )
    .await;
    applied.removed.extend(proxied.removed);
    applied.failures.extend(proxied.failures);
    let mut failed_deletions = BTreeMap::new();
    for action in &prepared.plan.actions {
        let path = match action {
            SyncAction::DeleteLocal(delete) => Some(&delete.path),
            SyncAction::WriteTombstone(tombstone) => Some(&tombstone.path),
            SyncAction::Download(download)
                if download.reason == crate::reconcile::DownloadReason::RemoteUpdateAfterDelete =>
            {
                Some(&download.path)
            }
            _ => None,
        };
        let Some(path) = path else {
            continue;
        };
        if applied.failures.iter().any(|failure| failure.path == *path) {
            let first_seen = prepared
                .snapshot
                .states
                .get(path)
                .and_then(|state| state.pending_since)
                .unwrap_or(prepared.server_now_millis);
            failed_deletions.insert(path.clone(), first_seen);
        }
    }
    let updates = state_updates(request.scanned, prepared, &applied);

    // Order matters only in one direction: a transferred path writes its own
    // state (exact remote stamp + hash), so it must land after the baseline
    // vector, which never covers a transferred path but is cheap insurance.
    env.store.save_path_states(notebook_id, &updates.states)?;
    env.store.save_path_states(notebook_id, &applied.states)?;
    env.store
        .remove_path_states(notebook_id, &updates.removed)?;
    let mut pending_deletions = prepared.plan.pending_deletions.clone();
    pending_deletions.extend(failed_deletions);
    env.store
        .set_pending_deletions(notebook_id, &pending_deletions)?;
    env.store.save_dir_scans(notebook_id, &updates.dir_scans)?;

    if prepared.writable {
        flush_pending_stamps(
            env,
            request,
            prepared.server_now_millis,
            &mut stamped_dirs,
            &mut stamp_failures,
        )
        .await?;
    }

    Ok(PassReport {
        server_now_millis: prepared.server_now_millis,
        listed_dirs: prepared.listed_dirs.clone(),
        plan: prepared.plan.clone(),
        applied,
        stamped_dirs,
        list_failures: prepared.list_failures.clone(),
        stamp_failures,
        rebound: prepared.rebound,
        allows_deletes: prepared.allows_deletes,
        writable: prepared.writable,
    })
}

async fn flush_pending_stamps(
    env: &mut PassEnv<'_>,
    request: &PassRequest<'_>,
    server_now_millis: i64,
    stamped: &mut Vec<String>,
    failures: &mut Vec<ApplyFailure>,
) -> Result<(), SyncError> {
    for dir in env.store.pending_stamps(request.notebook_id)? {
        let body = stamp_body(&dir, server_now_millis, request.device_id);
        match env
            .source
            .put(stamp_key(request.notebook_id, &dir), body)
            .await
        {
            Ok(()) => {
                env.store.ack_stamp(request.notebook_id, &dir)?;
                stamped.push(dir);
            }
            Err(error) => failures.push(ApplyFailure::from_error(dir, &error)),
        }
    }
    Ok(())
}
