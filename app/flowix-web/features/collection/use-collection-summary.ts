import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { canonicalPath } from '@/lib/path';
import { subscribe } from '@platform/tauri/event-bus';
import type { CollectionChangedEvent } from '@platform/tauri/client';
import { readCollectionSummary, type FolderCollectionSummary } from '@features/collection/public/folder-api';

type Snapshot = FolderCollectionSummary | 'missing' | null;
/** One live summary per collection address, shared by all workspace hosts. */
const entries = new Map<string, ReturnType<typeof createEntry>>();
function createEntry(key: string, path: string, scope: string | null, notebookId: string | null) {
  let snapshot: Snapshot = null;
  let sequence = 0;
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined;
  const publish = (next: Snapshot) => {
    if (snapshot && snapshot !== 'missing' && next && next !== 'missing'
      && snapshot.collectionId === next.collectionId && next.revision < snapshot.revision) return;
    sequence += 1;
    snapshot = next;
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
    subscribe(listener: () => void) {
      entries.set(key, entry);
      listeners.add(listener);
      if (listeners.size === 1) {
        stop = subscribe<CollectionChangedEvent>('collection-changed', (event) => {
          if (notebookId && event.notebookId !== notebookId) return;
          const current = snapshot && snapshot !== 'missing' ? snapshot : null;
          if (current && event.collectionId && event.collectionId !== current.collectionId) return;
          if ((!current || !event.collectionId) && event.relativePath && scope
            && canonicalPath(`${scope}/${event.relativePath}`) !== canonicalPath(path)) return;
          void refresh();
        }, { onListenerReady: () => { void refresh(); } });
        void refresh();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) { stop?.(); stop = undefined; sequence += 1; snapshot = null; if (entries.get(key) === entry) entries.delete(key); }
      };
    },
  };
  return entry;
}

export function useCollectionSummary(path: string, scope: string | null, notebookId: string | null) {
  const entry = useMemo(() => {
    const key = JSON.stringify([canonicalPath(path), scope ? canonicalPath(scope) : null, notebookId]);
    let current = entries.get(key);
    if (!current) { current = createEntry(key, path, scope, notebookId); entries.set(key, current); }
    return current;
  }, [path, scope, notebookId]);
  const summary = useSyncExternalStore(entry.subscribe, entry.getSnapshot, entry.getSnapshot);
  const setSummary = useCallback((next: Exclude<Snapshot, null>) => entry.publish(next), [entry]);
  return [summary, setSummary] as const;
}
