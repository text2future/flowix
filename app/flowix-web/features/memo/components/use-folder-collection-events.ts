'use client';

import { useCallback, useEffect, useRef } from 'react';

import { subscribe } from '@platform/tauri/event-bus';
import type { CollectionChangedEvent } from '@platform/tauri/client';
import { canonicalPath } from '@/lib/path';

import { isPathAtOrBelow } from './folder-tree-model';

/** How long a structural mutation suppresses the watcher events it provokes. */
const MUTATION_SUPPRESSION_MS = 2_000;

/**
 * `collection-changed` carries the collection's own rename/move, which arrives
 * *before* the filesystem watcher reports the same move. Rebasing here keeps the
 * tree in step with the collection transaction, and the guard it returns lets the
 * watcher path skip those same paths so the row does not flicker.
 *
 * Kept apart from `useFolderTree` because it is a self-contained subscription
 * with its own bookkeeping (applied sequence numbers, per-path suppression
 * timers) and none of the tree's read/generation machinery.
 */
export function useFolderCollectionEvents(
  rootKey: string,
  rebasePath: (previousPath: string, nextPath: string) => void,
): (paths: readonly string[] | undefined) => boolean {
  const mutationPathsRef = useRef(new Set<string>());
  const mutationDirectoriesRef = useRef(new Set<string>());

  const ignoreCollectionPathEvents = useCallback((paths: readonly string[] | undefined) => {
    if (!paths?.length) return false;
    const known = mutationPathsRef.current;
    const knownDirectories = mutationDirectoriesRef.current;
    if (!paths.every((path) => {
      const canonical = canonicalPath(path);
      return known.has(canonical)
        || [...knownDirectories].some((directory) => isPathAtOrBelow(canonical, directory))
        || /__collection_rename_/.test(path);
    })) return false;
    return true;
  }, []);

  useEffect(() => {
    const root = canonicalPath(rootKey).replace(/\/$/, '');
    const applied = new Map<string, number>();
    mutationPathsRef.current.clear();
    mutationDirectoriesRef.current.clear();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const stop = subscribe<CollectionChangedEvent>('collection-changed', (event) => {
      if (!event.notebookPath || !event.previousRelativePath || !event.relativePath) return;
      if (event.indexSequence < (applied.get(event.collectionId) ?? -1)) return;
      applied.set(event.collectionId, event.indexSequence);
      const previous = canonicalPath(`${event.notebookPath}/${event.directoryMove?.previousRelativePath ?? event.previousRelativePath}`);
      const nextPath = canonicalPath(`${event.notebookPath}/${event.directoryMove?.relativePath ?? event.relativePath}`);
      if (!previous.startsWith(`${root}/`) || !nextPath.startsWith(`${root}/`)) return;
      const known = mutationPathsRef.current;
      known.add(previous);
      known.add(nextPath);
      const previousDirectory = event.directoryMove ? previous : null;
      const nextDirectory = event.directoryMove ? nextPath : null;
      if (previousDirectory) mutationDirectoriesRef.current.add(previousDirectory);
      if (nextDirectory) mutationDirectoriesRef.current.add(nextDirectory);
      // Bound suppression to the immediately following filesystem notifications.
      const timer = setTimeout(() => {
        known.delete(previous);
        known.delete(nextPath);
        if (previousDirectory) mutationDirectoriesRef.current.delete(previousDirectory);
        if (nextDirectory) mutationDirectoriesRef.current.delete(nextDirectory);
        timers.delete(timer);
      }, MUTATION_SUPPRESSION_MS);
      timers.add(timer);
      if (previous === nextPath) return;
      rebasePath(previous, nextPath);
    });
    return () => {
      stop();
      for (const timer of timers) clearTimeout(timer);
    };
  }, [rootKey, rebasePath]);

  return ignoreCollectionPathEvents;
}
