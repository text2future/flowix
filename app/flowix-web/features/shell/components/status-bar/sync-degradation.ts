/**
 * The part of a sync status this decision needs. Declared structurally instead
 * of importing `CloudSyncStatus` so the rule stays a pure function with no
 * platform dependency — it is the only interesting logic in the status bar and
 * it should be testable without a Tauri client.
 */
export interface SyncHealthFlags {
  writable?: boolean | null;
  allowsDeletes?: boolean | null;
  deletionDeferred?: boolean | null;
}

/**
 * The worst thing the sync engine reported about itself, or `null` when it has
 * nothing to complain about.
 *
 * A pass that cannot publish does not fail — it finishes with every upload
 * deferred and its counters at zero, which is indistinguishable from "nothing
 * to do" unless you read the flags. `writable === false` is the quota case: the
 * control plane refused write scope, so nothing leaves the device.
 * `deletionDeferred === true` means a deletion was held back by a safety gate.
 *
 * Read-only wins because it is strictly worse: the user is not backing up at
 * all. Only an explicit `false` counts — `undefined` means this activity did
 * not produce a health report, so it is not enough evidence for a warning.
 */
export type DegradedSync = 'readOnly' | 'deletesPaused';

export function degradedSyncState(statuses: Iterable<SyncHealthFlags>): DegradedSync | null {
  let deletesPaused = false;
  for (const status of statuses) {
    if (status.writable === false) return 'readOnly';
    if (status.deletionDeferred === true) deletesPaused = true;
  }
  return deletesPaused ? 'deletesPaused' : null;
}

/** Show only the current notebook's status, never a stale status from another notebook. */
export function selectedNotebookSyncStatuses<T>(
  statuses: ReadonlyMap<string, T>,
  notebookId: string | null | undefined,
): T[] {
  if (!notebookId) return [];
  const status = statuses.get(notebookId);
  return status === undefined ? [] : [status];
}

/** Keep the last failure visible while an automatic retry is running. */
export function updateNotebookSyncFailures<T extends { notebookId: string; state: string; startedAt: number; lastError?: string | null }>(
  previous: ReadonlyMap<string, T>, status: T,
): ReadonlyMap<string, T> {
  const current = previous.get(status.notebookId);
  if (current && status.startedAt < current.startedAt) return previous;
  if (status.state === 'error' && status.lastError) {
    const next = new Map(previous);
    next.set(status.notebookId, status);
    return next;
  }
  if (status.state === 'success' && current) {
    const next = new Map(previous);
    next.delete(status.notebookId);
    return next;
  }
  return previous;
}

/** Keep the transfer direction visible between batches in the same sync run. */
export function stabilizeTransferPhase<T extends { runId: string; state: string; phase: string }>(previous: T | undefined, next: T): T {
  if (previous?.runId === next.runId && next.state === 'syncing'
    && (next.phase === 'transfer-idle' || next.phase === 'actions')
    && (previous.phase === 'upload' || previous.phase === 'download')) {
    return { ...next, phase: previous.phase };
  }
  return next;
}
