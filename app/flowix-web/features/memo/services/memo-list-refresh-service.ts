import { getCurrentWindow } from '@platform/tauri/window';
import { subscribe } from '@platform/tauri/event-bus';
import { subscribeNotebookChanges } from '@platform/tauri/notebook-change-events';
import { useNoteStore } from '@features/memo/store/note-store';

import { noteRepository } from './note-repository';
import type { NoteEntry } from '@platform/tauri/client';
import { createLogger } from '@/lib/logger';

const logger = createLogger('memo-list-refresh');
export type IndexedMemoRefreshResult = 'updated' | 'failed' | 'skipped';
type PendingRead = { revision: number; cancelled: boolean; cancelWait?: () => void; promise: Promise<IndexedMemoRefreshResult> };
const pendingReads = new Map<string, PendingRead>();
const pathKey = (notebookId: string, path: string) => `${notebookId}\u0000${path.replace(/\\/g, '/')}`;

function cancelPathReads(notebookId: string, path: string, descendants = false): void {
  const key = pathKey(notebookId, path);
  for (const [candidate, pending] of pendingReads) {
    if (candidate !== key && !(descendants && candidate.startsWith(`${key}/`))) continue;
    pending.cancelled = true;
    pending.cancelWait?.();
    pendingReads.delete(candidate);
  }
}

function applyIndexedChange(notebookId: string, path: string, entry: NoteEntry | null): void {
  cancelPathReads(notebookId, path, entry === null);
  useNoteStore.getState().applyNoteListChange(notebookId, path, entry);
}

function retryDelay(pending: PendingRead, milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      pending.cancelWait = undefined;
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    pending.cancelWait = finish;
  });
}

/** Coalesce path invalidations and retry transient index unavailability twice.
 * Path identity changes are synchronous and independent of these metadata reads. */
export function refreshIndexedMemo(notebookId: string, path: string): Promise<IndexedMemoRefreshResult> {
  if (useNoteStore.getState().selectedNotebook?.id !== notebookId) return Promise.resolve('skipped');
  if (!path) {
    useNoteStore.getState().handleMemoListInvalidation(notebookId);
    return Promise.resolve('skipped');
  }
  const key = pathKey(notebookId, path);
  const existing = pendingReads.get(key);
  if (existing) {
    existing.revision += 1;
    existing.cancelWait?.();
    return existing.promise;
  }
  const pending: PendingRead = { revision: 0, cancelled: false, promise: Promise.resolve('skipped') };
  pendingReads.set(key, pending);
  pending.promise = (async (): Promise<IndexedMemoRefreshResult> => {
    try {
      for (let attempt = 0; !pending.cancelled; attempt += 1) {
        const revision = pending.revision;
        try {
          const entry = await noteRepository.getIndexed(notebookId, path);
          if (pending.cancelled) return 'skipped';
          if (revision !== pending.revision) { attempt = -1; continue; }
          if (entry || attempt >= 2) {
            applyIndexedChange(notebookId, path, entry);
            return 'updated';
          }
        } catch (error) {
          if (pending.cancelled) return 'skipped';
          if (revision !== pending.revision) { attempt = -1; continue; }
          if (attempt >= 2) {
            logger.warn('indexed note refresh failed', { notebookId, path, error });
            useNoteStore.getState().handleMemoListInvalidation(notebookId);
            return 'failed';
          }
        }
        await retryDelay(pending, attempt === 0 ? 120 : 360);
      }
      return 'skipped';
    } finally {
      if (pendingReads.get(key) === pending) pendingReads.delete(key);
    }
  })();
  return pending.promise;
}

const REFRESH_BATCH_WINDOW_MS = 24;

/** Owns application-level invalidation for the selected notebook's note views. */
export function mountMemoListRefreshService(): () => void {
  const cardUpdates = new Map<string, { notebookId: string; relativePath: string; entry: NoteEntry }>();
  let cardTimer: ReturnType<typeof setTimeout> | null = null;
  const flushCards = () => {
    if (cardTimer) clearTimeout(cardTimer);
    cardTimer = null;
    if (!cardUpdates.size) return;
    const changes = [...cardUpdates.values()];
    cardUpdates.clear();
    useNoteStore.getState().applyNoteListBatch(changes);
  };
  const pending = new Map<string, 'list' | 'notebook-views' | 'snapshot'>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let currentWindowLabel: string | null = null;
  try {
    currentWindowLabel = getCurrentWindow().label;
  } catch {
    // Browser preview has no Tauri window label.
  }

  const flush = () => {
    timer = null;
    if (disposed) return;
    const pendingNotebookIds = new Map(pending);
    pending.clear();
    const state = useNoteStore.getState();
    const selectedNotebookId = state.selectedNotebook?.id;
    if (!selectedNotebookId) return;
    const scope = pendingNotebookIds.get(selectedNotebookId);
    if (scope === 'notebook-views' || scope === 'snapshot') state.triggerNotebookMetadataRefresh();
    if (scope === 'snapshot') state.triggerMemoListRefresh();
    else if (scope) state.handleMemoListInvalidation(selectedNotebookId);
  };

  const schedule = (notebookId: string, scope: 'list' | 'notebook-views' | 'snapshot') => {
    if (disposed) return;
    const current = pending.get(notebookId);
    pending.set(notebookId, current === 'snapshot' || scope === 'snapshot' ? 'snapshot' : current === 'notebook-views' || scope === 'notebook-views'
      ? 'notebook-views'
      : 'list');
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, REFRESH_BATCH_WINDOW_MS);
  };

  const reconcileSelectedNotebook = () => {
    if (disposed) return;
    // Events received before recovery can no longer serve as a fresh snapshot.
    if (cardTimer) clearTimeout(cardTimer);
    cardTimer = null;
    cardUpdates.clear();
    for (const read of pendingReads.values()) { read.cancelled = true; read.cancelWait?.(); }
    pendingReads.clear();
    const notebookId = useNoteStore.getState().selectedNotebook?.id;
    if (notebookId) schedule(notebookId, 'snapshot');
  };

  const stopNotebookChanges = subscribeNotebookChanges((change) => {
    if (change.kind === 'resource-updated') {
      cancelPathReads(change.notebookId, change.relativePath);
      if (currentWindowLabel && change.originWindowLabel === currentWindowLabel) {
        flushCards();
        applyIndexedChange(change.notebookId, change.relativePath, change.entry);
      } else if (useNoteStore.getState().selectedNotebook?.id === change.notebookId) {
        const key = pathKey(change.notebookId, change.relativePath);
        // Fixed window: continuous notifications cannot postpone delivery forever.
        cardUpdates.delete(key);
        cardUpdates.set(key, { notebookId: change.notebookId, relativePath: change.relativePath, entry: change.entry });
        if (!cardTimer) cardTimer = setTimeout(flushCards, REFRESH_BATCH_WINDOW_MS);
      }
      return;
    }
    // Preserve ordering across edits, deletes and moves.
    flushCards();
    if (change.kind === 'query-invalidated' && change.relativePath) {
      void refreshIndexedMemo(change.notebookId, change.relativePath);
      return;
    }
    if (change.kind === 'resource-deleted') {
      // A folder deletion removes its loaded descendants as well.
      applyIndexedChange(change.notebookId, change.relativePath, null);
      return;
    }
    if (change.kind === 'path-moved') {
      cancelPathReads(change.notebookId, change.previousRelativePath, change.directory);
      cancelPathReads(change.notebookId, change.relativePath, change.directory);
      const state = useNoteStore.getState();
      // Rebase first, including the session overlay, before any async read can
      // complete or be superseded by a newer full-entry notification.
      state.rebaseNoteListPaths(change.notebookId, change.previousRelativePath, change.relativePath, change.directory);
      for (const note of useNoteStore.getState().notes) {
        if (note.notebookId !== change.notebookId) continue;
        if (note.relativePath === change.relativePath
          || (change.directory && note.relativePath.startsWith(`${change.relativePath}/`))) {
          void refreshIndexedMemo(change.notebookId, note.relativePath);
        }
      }
      return;
    }
    // The initiating window applies command-created notes from the command
    // result. Other windows refresh their own selected list projection.
    if (change.kind === 'resource-created'
      && currentWindowLabel
      && change.originWindowLabel === currentWindowLabel) return;
    schedule(change.notebookId, 'list');
  }, { onListenerReady: reconcileSelectedNotebook });
  const stopFileManagement = subscribe<{ notebookId: string; operationId?: string }>(
    'file-management-changed',
    ({ notebookId, operationId }) => {
      // Collection operations also publish a structured path change, which is
      // enough to refresh the list. Unscoped maintenance events affect all
      // notebook views, matching the previous broad refresh behavior.
      if (operationId) return;
      schedule(notebookId, 'notebook-views');
    },
    { onListenerReady: reconcileSelectedNotebook },
  );

  const stopNotebookRegistry = subscribe('notebooks-changed', () => {
    void useNoteStore.getState().loadNotebooks().catch(error => logger.warn('notebook registry refresh failed', { error }));
  });

  return () => {
    disposed = true;
    if (cardTimer) clearTimeout(cardTimer);
    cardUpdates.clear();
    if (timer) clearTimeout(timer);
    pending.clear();
    for (const read of pendingReads.values()) { read.cancelled = true; read.cancelWait?.(); }
    pendingReads.clear();
    stopNotebookChanges();
    stopFileManagement();
    stopNotebookRegistry();
  };
}
