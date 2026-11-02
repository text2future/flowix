import { canonicalDirectoryPath, canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { createLogger } from '@/lib/logger';
import { perfCount } from '@/lib/perf-probe';
import { subscribeNotebookChanges, type NotebookChange } from '@platform/tauri/notebook-change-events';
import type { NoteEntry } from '@platform/tauri/client';
import { NoteMetadataProjection, type NoteMetadata } from '../model/note-metadata';
import { noteRepository } from './note-repository';

export const noteMetadata = new NoteMetadataProjection();
export interface NotebookMetadataScope { notebookId: string; notebookPath: string }
export interface NotebookMetadataChange {
  change: NotebookChange | null;
  /** null means the sender and local projection do not know the previous state. */
  favoriteChanged: boolean | null;
}
const logger = createLogger('note-metadata');
const scopes = new Map<string, { listeners: Set<(event: NotebookMetadataChange) => void>; stop: () => void }>();
const reads = new Map<string, Promise<void>>();
const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
export const metadataFromEntry = (entry: NoteMetadata): NoteMetadata => ({ icon: entry.icon, colors: entry.colors, favorited: entry.favorited });

/** All views share path reads, freshness checks and missing-data semantics. */
export function refreshNoteMetadata(scope: NotebookMetadataScope, relativePath: string, force = false): Promise<void> {
  const path = joinNotebookMemoPath(scope.notebookPath, relativePath);
  if (!path) return Promise.resolve();
  const pending = reads.get(path);
  if (pending && !force) return pending;
  if (force) noteMetadata.invalidate(path);
  const release = noteMetadata.retainRead(path);
  const checkpoint = noteMetadata.checkpoint();
  const operation = Promise.resolve().then(() => noteRepository.getIndexed(scope.notebookId, relativePath)).then((entry: NoteEntry | null) => {
    if (reads.get(path) === operation) noteMetadata.mergeSnapshot(path, entry && metadataFromEntry(entry), checkpoint);
  }).catch((error) => {
    // An unavailable index is not a deletion. Keep the confirmed metadata stale.
    if (reads.get(path) === operation && noteMetadata.get(path).revision <= checkpoint) noteMetadata.invalidate(path);
    logger.warn('metadata read failed', { error, path });
  }).finally(() => { release(); if (reads.get(path) === operation) reads.delete(path); });
  reads.set(path, operation);
  return operation;
}

/** Refresh once on attachment, not on every stale notification or failed read. */
export function observeNoteMetadata(scope: NotebookMetadataScope, path: string, listener: () => void) {
  const stop = noteMetadata.subscribe(path, listener);
  const stopScope = subscribeNotebookMetadata(scope);
  const root = canonicalDirectoryPath(scope.notebookPath);
  const key = canonicalPath(path);
  const status = noteMetadata.get(key).status;
  if (within(key, root) && key !== root && (status === 'pending' || status === 'stale')) {
    void refreshNoteMetadata(scope, key.slice(root === '/' ? 1 : root.length + 1));
  }
  return () => { stop(); stopScope(); };
}

/** One native subscription per mounted notebook, including listener recovery. */
export function subscribeNotebookMetadata(scope: NotebookMetadataScope, listener: (event: NotebookMetadataChange) => void = () => {}) {
  const root = canonicalDirectoryPath(scope.notebookPath);
  const key = JSON.stringify([scope.notebookId, root]);
  let shared = scopes.get(key);
  if (!shared) {
    const listeners = new Set<(event: NotebookMetadataChange) => void>();
    const reconcile = () => {
      for (const path of noteMetadata.paths()) if (within(path, root)) noteMetadata.invalidate(path);
      // Probe: a whole-notebook invalidation re-reads every observed path, so
      // this is the fan-out cost a single directory reconcile imposes on the
      // renderer. Read it with `__flowixPerf.dump()`.
      let rereads = 0;
      for (const path of noteMetadata.observedPaths()) {
        if (!within(path, root)) continue;
        rereads += 1;
        void refreshNoteMetadata(scope, path.slice(root.length + 1), true);
      }
      perfCount('metadata-reconcile', 1, { rereads, listeners: listeners.size });
      for (const receive of listeners) receive({ change: null, favoriteChanged: null });
    };
    const stop = subscribeNotebookChanges((change) => {
      if (change.notebookId !== scope.notebookId) return;
      const path = change.relativePath && joinNotebookMemoPath(root, change.relativePath);
      let favoriteChanged: boolean | null = null;
      if (change.kind === 'resource-updated' && path) {
        const before = change.previousFavorited ?? noteMetadata.get(path).value?.favorited;
        favoriteChanged = before === undefined ? null : before !== change.entry.favorited;
        noteMetadata.update(path, metadataFromEntry(change.entry));
      } else if (change.kind === 'resource-deleted' && path) {
        noteMetadata.deletePrefix(path);
      } else if (change.kind === 'query-invalidated') {
        if (path) {
          noteMetadata.invalidate(path);
          void refreshNoteMetadata(scope, change.relativePath!, true);
        } else reconcile();
      } else if (change.kind === 'path-moved') {
        const previous = joinNotebookMemoPath(root, change.previousRelativePath);
        if (previous && path) {
          for (const candidate of noteMetadata.paths()) {
            if (within(candidate, previous)) {
              const value = noteMetadata.get(candidate).value;
              if (value) noteMetadata.update(`${path}${candidate.slice(previous.length)}`, value);
            }
          }
          noteMetadata.deletePrefix(previous);
        }
      }
      for (const receive of listeners) receive({ change, favoriteChanged });
    }, { onListenerReady: reconcile });
    shared = { listeners, stop };
    scopes.set(key, shared);
  }
  shared.listeners.add(listener);
  return () => {
    shared!.listeners.delete(listener);
    if (!shared!.listeners.size) { shared!.stop(); scopes.delete(key); }
  };
}

/** Seed a transport snapshot at the revision captured before its IPC read. */
export function mergeNoteMetadata(path: string, value: NoteMetadata | null | undefined, checkpoint: number) {
  return noteMetadata.mergeSnapshot(canonicalPath(path), value && metadataFromEntry(value), checkpoint).value;
}
