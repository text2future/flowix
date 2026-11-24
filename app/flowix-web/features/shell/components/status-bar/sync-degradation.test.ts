import { expect, it } from 'vitest';
import { degradedSyncState, selectedNotebookSyncStatuses, stabilizeTransferPhase, updateNotebookSyncFailures } from './sync-degradation';

it('reports nothing for a healthy pass or without a health report', () => {
  expect(degradedSyncState([])).toBeNull();
  expect(degradedSyncState([{ writable: true, allowsDeletes: true }])).toBeNull();
  // An absent flag is not evidence that the latest path pass was degraded.
  expect(degradedSyncState([{}])).toBeNull();
  expect(degradedSyncState([{ writable: null, allowsDeletes: null }])).toBeNull();
});

it('turns a refused write scope into the read-only state', () => {
  // Over quota: the control plane signs a read-only credential, so every upload
  // defers and the pass still reports success.
  expect(degradedSyncState([{ writable: false, allowsDeletes: true }])).toBe('readOnly');
  expect(degradedSyncState([{ writable: false }])).toBe('readOnly');
});

it('reports paused deletions as the milder state', () => {
  expect(degradedSyncState([{ writable: true, allowsDeletes: false }])).toBeNull();
  expect(degradedSyncState([{ writable: true, deletionDeferred: true }])).toBe('deletesPaused');
  expect(degradedSyncState([{ deletionDeferred: true }])).toBe('deletesPaused');
});

it('surfaces the worst notebook when several disagree', () => {
  // Deletions paused on one notebook must not hide that another cannot upload.
  expect(degradedSyncState([
    { writable: true, deletionDeferred: true },
    { writable: false, allowsDeletes: true },
  ])).toBe('readOnly');
  // Order must not matter.
  expect(degradedSyncState([
    { writable: false, allowsDeletes: true },
    { writable: true, deletionDeferred: true },
  ])).toBe('readOnly');
});


it('only shows sync status for the selected notebook', () => {
  const old = { state: 'syncing', writable: false };
  const current = { state: 'success', writable: true };
  const statuses = new Map([['old', old], ['current', current]]);
  expect(selectedNotebookSyncStatuses(statuses, 'current')).toEqual([current]);
  expect(selectedNotebookSyncStatuses(statuses, 'old')).toEqual([old]);
  expect(selectedNotebookSyncStatuses(statuses, 'missing')).toEqual([]);
  expect(selectedNotebookSyncStatuses(statuses, null)).toEqual([]);
});


it('keeps the previous error during retries and clears it only after success', () => {
  const failure = { notebookId: 'a', state: 'error', startedAt: 10, lastError: 'upload failed' };
  let failures = updateNotebookSyncFailures(new Map(), failure);
  failures = updateNotebookSyncFailures(failures, { notebookId: 'a', state: 'syncing', startedAt: 11, lastError: null });
  expect(failures.get('a')).toEqual(failure);
  failures = updateNotebookSyncFailures(failures, { notebookId: 'a', state: 'success', startedAt: 9, lastError: null });
  expect(failures.get('a')).toEqual(failure);
  failures = updateNotebookSyncFailures(failures, { notebookId: 'a', state: 'success', startedAt: 11, lastError: null });
  expect(failures.has('a')).toBe(false);
});


it('keeps the cloud visible between transfer batches and clears it on completion', () => {
  const upload = { runId: 'a', state: 'syncing', phase: 'upload' };
  const idle = stabilizeTransferPhase(upload, { ...upload, phase: 'transfer-idle' });
  expect(idle.phase).toBe('upload');
  expect(stabilizeTransferPhase(idle, { ...upload, phase: 'actions' }).phase).toBe('upload');
  expect(stabilizeTransferPhase(idle, { ...upload, state: 'success', phase: 'complete' }).phase).toBe('complete');
  expect(stabilizeTransferPhase(idle, { ...upload, runId: 'b', phase: 'actions' }).phase).toBe('actions');
});
