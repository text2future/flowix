import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { canonicalPath } from '@/lib/path';
import { subscribe } from '@platform/tauri/event-bus';
import type { CollectionChangedEvent } from '@platform/tauri/client';
import { readCollectionSummary, type FolderCollectionSummary } from '@features/collection/public/folder-api';
import { subscribeLocalCollectionChanges } from './events';

type Snapshot = FolderCollectionSummary | 'missing' | null;
/** One live summary per collection address, shared by all workspace hosts. */
const entries = new Map<string, ReturnType<typeof createEntry>>();
const entryKey = (path: string, scope: string | null, notebookId: string | null) =>
  JSON.stringify([canonicalPath(path), scope ? canonicalPath(scope) : null, notebookId]);

// Move the live entry rather than allocating an unobserved destination cache.
// Its existing subscribers own its lifetime, even if navigation never follows.
subscribeLocalCollectionChanges(({ notebookId, previousPath, item }) => {
  for (const [key, entry] of [...entries]) {
    const [path, scope, id] = JSON.parse(key) as [string, string | null, string | null];
    if (id !== notebookId || !scope || path !== canonicalPath(previousPath)) continue;
    const snapshot = entry.getSnapshot();
    if (!snapshot || snapshot === 'missing' || snapshot.collectionId !== item.collectionId) continue;
    const nextPath = `${scope}/${item.relativePath}`;
    entry.relocate(nextPath, item.revision ?? undefined);
  }
});

function createEntry(path: string, scope: string | null, notebookId: string | null) {
  let snapshot: Snapshot = null;
  let sequence = 0;
  let addressRevision = 0;
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined;
  const publish = (next: Snapshot) => {
    if (snapshot && snapshot !== 'missing' && next && next !== 'missing'
      && snapshot.collectionId === next.collectionId && next.revision < snapshot.revision) return;
    sequence += 1;
    snapshot = next;
    if (next && next !== 'missing') addressRevision = Math.max(addressRevision, next.revision);
    for (const listener of listeners) listener();
  };
  const refresh = async () => {
    const request = ++sequence;
    if (!path || !scope) { publish('missing'); return; }
    try {
      const next = await readCollectionSummary(path, scope);
      if (request === sequence) publish(next ?? 'missing');
    } catch {
      // Keep a usable snapshot during a transient refresh failure.
      if (request === sequence && snapshot === null) publish('missing');
    }
  };
  const entry = {
    getSnapshot: () => snapshot,
    publish,
    relocate(nextPath: string, revision?: number) {
      if (revision !== undefined) {
        if (revision < addressRevision) return;
        addressRevision = revision;
      }
      if (canonicalPath(path) === canonicalPath(nextPath)) return;
      const previousKey = entryKey(path, scope, notebookId);
      if (entries.get(previousKey) === entry) entries.delete(previousKey);
      path = nextPath;
      const nextKey = entryKey(path, scope, notebookId);
      const destination = entries.get(nextKey);
      if (destination && destination !== entry) destination.publish(snapshot);
      else entries.set(nextKey, entry);
      // Invalidate any read of the old address, then revalidate in place.
      sequence += 1;
      if (listeners.size > 0) void refresh();
    },
    subscribe(listener: () => void) {
      entries.set(entryKey(path, scope, notebookId), entry);
      listeners.add(listener);
      if (listeners.size === 1) {
        stop = subscribe<CollectionChangedEvent>('collection-changed', (event) => {
          if (notebookId && event.notebookId !== notebookId) return;
          if (scope && event.notebookPath && canonicalPath(event.notebookPath) !== canonicalPath(scope)) return;
          const current = snapshot && snapshot !== 'missing' ? snapshot : null;
          if (current && event.collectionId && event.collectionId !== current.collectionId) return;
          if (event.revision !== undefined && event.revision < addressRevision) return;
          if ((!current || !event.collectionId) && event.relativePath && scope
            && canonicalPath(`${scope}/${event.relativePath}`) !== canonicalPath(path)) return;
          // The desktop event can precede the mutation response. Follow its
          // confirmed identity immediately instead of reading the deleted path.
          if (current && event.collectionId && event.relativePath && scope) {
            const nextPath = `${scope}/${event.relativePath}`;
            if (canonicalPath(nextPath) !== canonicalPath(path)) {
              entry.relocate(nextPath, event.revision);
              return;
            }
          }
          void refresh();
        }, { onListenerReady: () => { void refresh(); } });
        void refresh();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stop?.(); stop = undefined; sequence += 1; snapshot = null; addressRevision = 0;
          for (const [address, cached] of entries) if (cached === entry) entries.delete(address);
        }
      };
    },
  };
  return entry;
}

export function useCollectionSummary(path: string, scope: string | null, notebookId: string | null) {
  const entry = useMemo(() => {
    const key = entryKey(path, scope, notebookId);
    let current = entries.get(key);
    if (!current) { current = createEntry(path, scope, notebookId); entries.set(key, current); }
    return current;
  }, [path, scope, notebookId]);
  const summary = useSyncExternalStore(entry.subscribe, entry.getSnapshot, entry.getSnapshot);
  const setSummary = useCallback((next: Exclude<Snapshot, null>) => entry.publish(next), [entry]);
  return [summary, setSummary] as const;
}
