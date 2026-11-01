import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { createLogger } from '@/lib/logger';
import { joinNotebookMemoPath } from '@/lib/path';
import { registerMemoEventHandler } from '@/lib/memo-dispatcher';
import type { DocTreeItem } from '@platform/tauri/client';
import { listenToPinnedChanges, pinnedEntries, type PinnedEntry } from '@platform/tauri/client/pinned';
import { noteMetadata, subscribeNotebookMetadata } from '../services/note-metadata-service';

const logger = createLogger('notebook-pinned-notes');
const EMPTY_PINNED_ITEMS: PinnedTreeItem[] = [];
const PINNED_PAGE_SIZE = 100;

export type PinnedEntryKind = 'note' | 'document' | 'collection' | 'folder';

/**
 * A pinned row. Notes keep the flag in frontmatter, documents in the resource
 * catalog, collections in `collection_state`; the pinned section renders all
 * three through the same tree row, so the row needs to know which entry it is
 * to route the open action and the unpin command. Folders join the same list
 * from view preferences and additionally carry their subtree.
 */
export interface PinnedTreeItem extends DocTreeItem {
  pinnedEntryKind: PinnedEntryKind;
  pinnedCollectionType?: 'table' | 'media_library' | 'work_documents';
  pinnedCollectionId?: string | null;
  /** Indent level inside the pinned group; entries sit at 0. */
  pinnedDepth?: number;
  /** Whether this row's subtree is expanded in the pinned group. */
  pinnedExpanded?: boolean;
}

interface PinnedPage {
  nextCursor?: string;
  hasMore: boolean;
  items: PinnedTreeItem[];
}

interface UseNotebookPinnedNotesOptions {
  notebookId: string | null;
  notebookPath: string;
  isActive: boolean;
  refreshTrigger: number;
}

function toPinnedItem(entry: PinnedEntry, notebookPath: string): PinnedTreeItem | null {
  const relativePath = entry.relativePath.replace(/\\/g, '/');
  const fullPath = joinNotebookMemoPath(notebookPath, relativePath);
  if (!fullPath) return null;
  const fileName = relativePath.split('/').pop() || relativePath;
  // Both notes and documents expose "first seen by Flowix" as created_at, so a
  // single ordering key keeps the mixed list stable across sources.
  const createdAt = entry.createdAt > 0 ? entry.createdAt : entry.modifiedMs;
  const base = {
    fullPath,
    type: 'document' as const,
    parentId: null,
    children: null,
    sizeBytes: entry.sizeBytes > 0 ? entry.sizeBytes : null,
    modifiedMs: entry.modifiedMs,
    createdMs: createdAt,
    memoCreatedMs: createdAt,
    pinned: true,
  };
  if (entry.entryKind === 'collection') {
    return {
      ...base,
      id: `pinned:collection:${entry.collectionId ?? relativePath}`,
      name: entry.title || fileName,
      resourceKind: 'other',
      pinnedEntryKind: 'collection',
      pinnedCollectionType: entry.kind as PinnedTreeItem['pinnedCollectionType'],
      pinnedCollectionId: entry.collectionId,
    };
  }
  if (entry.entryKind === 'note') {
    return {
      ...base,
      id: `pinned:${relativePath}`,
      name: fileName,
      resourceKind: 'note',
      memoMeta: { icon: null, colors: [], favorited: true },
      pinnedEntryKind: 'note',
    };
  }
  return {
    ...base,
    id: `pinned:document:${relativePath}`,
    name: fileName,
    resourceKind: 'other',
    pinnedEntryKind: 'document',
  };
}

export function useNotebookPinnedNotes({
  notebookId,
  notebookPath,
  isActive,
  refreshTrigger,
}: UseNotebookPinnedNotesOptions) {
  const [pages, setPages] = useState<PinnedPage[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const pageIndexRef = useRef(pageIndex);
  pageIndexRef.current = pageIndex;
  const metadataRevision = useSyncExternalStore(noteMetadata.subscribeAll, noteMetadata.checkpoint, noteMetadata.checkpoint);
  const [loadingInitial, setLoadingInitial] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestSequence = useRef(0);
  const loadingMoreRef = useRef(false);
  const loadedScope = useRef<{ notebookId: string; notebookPath: string } | null>(null);
  const [changeRevision, setChangeRevision] = useState(0);

  const toPinnedItems = useCallback((entries: PinnedEntry[], path: string): PinnedTreeItem[] =>
    entries.flatMap((entry) => {
      const item = toPinnedItem(entry, path);
      return item ? [item] : [];
    }), []);

  useEffect(() => {
    if (!notebookId) return;
    return subscribeNotebookMetadata({ notebookId, notebookPath }, ({ change, favoriteChanged }) => {
      if (change?.kind === 'resource-updated') {
        // Cache coverage is unrelated to membership. New senders supply the
        // previous pin state; legacy events use the shared projection baseline.
        if (favoriteChanged === true || (favoriteChanged === null && change.entry.favorited)) {
          setChangeRevision((revision) => revision + 1);
        }
      } else if (!change || change.kind !== 'resource-created' || change.source === 'external_tool') {
        setChangeRevision((revision) => revision + 1);
      }
    });
  }, [notebookId, notebookPath]);

  // Documents and collections have no frontmatter to watch, so their pin
  // changes arrive as one notebook-scoped event.
  useEffect(() => {
    if (!notebookId) return;
    const pending = listenToPinnedChanges((payload) => {
      if (payload.notebookId === notebookId) setChangeRevision((revision) => revision + 1);
    });
    return () => { void pending.then((unlisten) => unlisten()); };
  }, [notebookId]);

  useEffect(() => registerMemoEventHandler((event) => {
    if (event.notebookId !== notebookId || event.kind === 'tags_renamed' || event.kind === 'tags_deleted') return;
    if (event.kind === 'deleted' || event.source === 'cloud_sync') {
      setChangeRevision((revision) => revision + 1);
    }
  }), [notebookId]);

  useEffect(() => {
    if (!isActive) return;
    if (!notebookId) {
      loadedScope.current = null;
      setPages([]);
      setPageIndex(0);
      setLoadingInitial(false);
      return;
    }
    const sameScope = loadedScope.current?.notebookId === notebookId && loadedScope.current.notebookPath === notebookPath;
    const targetPage = sameScope ? pageIndexRef.current : 0;
    if (!sameScope) {
      setPages([]);
      setPageIndex(0);
    }
    let cancelled = false;
    const sequence = ++requestSequence.current;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setLoadingInitial(true);

    void (async () => {
      const nextPages: PinnedPage[] = [];
      let cursor: string | undefined;
      // Recovery and uncertain legacy events reconcile the existing page window
      // instead of silently moving the user back to the first page.
      for (let index = 0; index <= targetPage; index++) {
        const page = await pinnedEntries.list(notebookId, cursor, PINNED_PAGE_SIZE);
        if (cancelled || sequence !== requestSequence.current) return;
        cursor = page.nextCursor ?? undefined;
        nextPages.push({ nextCursor: cursor, hasMore: page.hasMore && Boolean(cursor),
          items: toPinnedItems(page.entries, notebookPath) });
        if (!page.hasMore || !cursor) break;
      }
      setPages(nextPages);
      setPageIndex(Math.min(targetPage, nextPages.length - 1));
      setLoadingInitial(false);
      loadedScope.current = { notebookId, notebookPath };
    })().catch((error) => {
      if (!cancelled) {
        logger.warn('failed to load pinned entries', { error, notebookPath });
        setLoadingInitial(false);
      }
    });

    return () => {
      cancelled = true;
      if (requestSequence.current === sequence) requestSequence.current += 1;
    };
  }, [isActive, notebookId, notebookPath, refreshTrigger, changeRevision, toPinnedItems]);

  const currentPage = pages[pageIndex];
  const hasPrevious = pageIndex > 0;
  const hasMore = pageIndex < pages.length - 1 || Boolean(currentPage?.hasMore && currentPage.nextCursor);

  const loadMore = useCallback(async () => {
    if (pageIndex < pages.length - 1) {
      setPageIndex(pageIndex + 1);
      return;
    }
    if (loadingInitial || !notebookId || !currentPage?.hasMore || !currentPage.nextCursor || loadingMoreRef.current) return;
    const sequence = requestSequence.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await pinnedEntries.list(notebookId, currentPage.nextCursor, PINNED_PAGE_SIZE);
      if (sequence !== requestSequence.current) return;
      const cursor = page.nextCursor ?? undefined;
      const nextIndex = pageIndex + 1;
      const items = toPinnedItems(page.entries, notebookPath);
      setPages((current) => [...current.slice(0, nextIndex), {
        nextCursor: cursor,
        hasMore: page.hasMore && Boolean(cursor),
        items,
      }]);
      setPageIndex(nextIndex);
    } catch (error) {
      if (sequence === requestSequence.current) {
        logger.warn('failed to load more pinned entries', { error, notebookPath });
      }
    } finally {
      if (sequence === requestSequence.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [currentPage, loadingInitial, notebookId, pageIndex, pages.length, notebookPath, toPinnedItems]);

  const loadPrevious = useCallback(() => {
    setPageIndex((current) => Math.max(0, current - 1));
  }, []);

  const removePinnedItem = useCallback((itemId: string) => {
    setPages((current) => current.map((page) => ({
      ...page,
      items: page.items.filter((item) => item.id !== itemId),
    })));
  }, []);

  const pinnedItems = useMemo(() => (currentPage?.items ?? EMPTY_PINNED_ITEMS).flatMap((item) => {
    // Only notes project into the metadata cache; documents and collections
    // carry their own pin flag from the backend query.
    if (item.pinnedEntryKind !== 'note') return [item];
    const snapshot = noteMetadata.get(item.fullPath);
    if (snapshot.status === 'deleted' || snapshot.value?.favorited === false) return [];
    return [snapshot.value ? { ...item, memoMeta: snapshot.value } : item];
  }), [currentPage?.items, metadataRevision]);

  return {
    pinnedItems,
    hasPrevious,
    hasMore,
    loadingInitial,
    loadingMore,
    loadPrevious,
    loadMore,
    removePinnedItem,
  };
}
