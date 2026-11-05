'use client';

import { useCallback, useMemo } from 'react';

import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { parentDirectoryPath } from '@/lib/path';
import {
  files,
  type CollectionIndexItem,
  type DocTreeItem,
  type MediaLibraryListItem,
  type TableDocumentListItem,
} from '@platform/tauri/client';
import { buildCollectionPinTargets, resolveTreePinRoute, type CollectionPinKind } from './collection-pin-routing';
import type { PinnedTreeItem } from './use-notebook-pinned-notes';

const logger = createLogger('pinned-entry-actions');

interface UsePinnedEntryActionsOptions {
  notebookId: string | null;
  notebookPath: string;
  removePinnedItem: (itemId: string) => void;
  /** Refresh one folder so the row's pin flag follows the backend. */
  refreshDirectory: (directoryPath: string) => Promise<void>;
  refreshTables: () => Promise<void>;
  refreshMediaLibraries: () => Promise<void>;
  refreshWorkDocumentCollections: () => Promise<void>;
  /** Path-keyed catalogs (`canonicalPath`);
   *  they tell a collection row apart from a plain document row. */
  tableDocumentByPath: ReadonlyMap<string, TableDocumentListItem>;
  mediaLibraryByPath: ReadonlyMap<string, MediaLibraryListItem>;
  workDocumentCollectionByPath: ReadonlyMap<string, CollectionIndexItem>;
  /** Unpin a folder; folders live in view preferences, not the indexes. */
  toggleFolderPinned: (folderPath: string) => void | Promise<void>;
}

/** Pin entry a file-tree row should show, and the command behind it. */
export interface TreePinProps {
  pinned: boolean | undefined;
  onTogglePinned: ((nextPinned: boolean) => void) | undefined;
}

/**
 * Pin toggles for documents and collections. Notes stay on frontmatter and keep
 * their own menu, so they deliberately have no entry here.
 */
export function usePinnedEntryActions({
  notebookId,
  notebookPath,
  removePinnedItem,
  refreshDirectory,
  refreshTables,
  refreshMediaLibraries,
  refreshWorkDocumentCollections,
  tableDocumentByPath,
  mediaLibraryByPath,
  workDocumentCollectionByPath,
  toggleFolderPinned,
}: UsePinnedEntryActionsOptions) {
  const { t } = useI18n();

  const toggleDocumentPinned = useCallback(async (item: DocTreeItem, nextPinned: boolean) => {
    try {
      await files.setDocumentPinned(item.fullPath, notebookPath, nextPinned);
    } catch (error) {
      toast.error(t(nextPinned ? 'document.command.pinFailed' : 'document.command.unpinFailed'));
      logger.warn('failed to toggle document pinned state', { error, path: item.fullPath });
      return;
    }
    if (!nextPinned) removePinnedItem(item.id);
    // The write already landed; a failed reload only leaves the row stale.
    await refreshDirectory(parentDirectoryPath(item.fullPath, notebookPath)).catch((error) => {
      logger.warn('failed to refresh directory after pin change', { error, path: item.fullPath });
    });
  }, [notebookPath, refreshDirectory, removePinnedItem, t]);

  /** Only the catalog that owns the collection needs reloading; the unknown
   *  case (no kind) still refreshes all three. */
  const refreshCollectionCatalog = useCallback(async (kind?: CollectionPinKind) => {
    if (kind === 'table') return refreshTables();
    if (kind === 'media_library') return refreshMediaLibraries();
    if (kind === 'work_documents') return refreshWorkDocumentCollections();
    await Promise.all([refreshTables(), refreshMediaLibraries(), refreshWorkDocumentCollections()]);
  }, [refreshTables, refreshMediaLibraries, refreshWorkDocumentCollections]);

  const toggleCollectionPinned = useCallback(async (
    collectionId: string,
    nextPinned: boolean,
    { pinnedItemId, kind }: { pinnedItemId?: string; kind?: CollectionPinKind } = {},
  ) => {
    if (!notebookId) return;
    try {
      await files.setCollectionPinned(notebookId, collectionId, nextPinned);
    } catch (error) {
      toast.error(t(nextPinned ? 'document.command.pinFailed' : 'document.command.unpinFailed'));
      logger.warn('failed to toggle collection pinned state', { error, collectionId });
      return;
    }
    if (!nextPinned && pinnedItemId) removePinnedItem(pinnedItemId);
    // The write already landed; a failed reload only leaves the row stale.
    await refreshCollectionCatalog(kind).catch((error) => {
      logger.warn('failed to refresh collection catalog after pin change', { error, collectionId });
    });
  }, [notebookId, refreshCollectionCatalog, removePinnedItem, t]);

  // Collections keep their pin in `collection_state`, so a collection row must
  // pin by identity; the tree only knows documents and would otherwise send
  // every `.yaml` collection through the document command, which rejects it.
  const collectionPinByPath = useMemo(
    () => buildCollectionPinTargets(tableDocumentByPath, mediaLibraryByPath, workDocumentCollectionByPath),
    [tableDocumentByPath, mediaLibraryByPath, workDocumentCollectionByPath],
  );

  /** The pin entry a file-tree row shows, and the command it runs. */
  const treePinProps = useCallback((item: DocTreeItem, itemPath: string): TreePinProps => {
    const route = resolveTreePinRoute(item, collectionPinByPath.get(itemPath));
    if (route.kind === 'none') return { pinned: undefined, onTogglePinned: undefined };
    if (route.kind === 'collection') {
      const { collectionId, pinned, kind } = route.target;
      return {
        pinned,
        onTogglePinned: (next: boolean) => { void toggleCollectionPinned(collectionId, next, { kind }); },
      };
    }
    return {
      pinned: undefined,
      onTogglePinned: (next: boolean) => { void toggleDocumentPinned(item, next); },
    };
  }, [collectionPinByPath, toggleCollectionPinned, toggleDocumentPinned]);

  const pinnedRowToggle = useCallback((item: PinnedTreeItem) => {
    if (item.pinnedEntryKind === 'folder') {
      // A folder inside the pinned group is either pinned itself or shown only
      // because its parent is; both directions work here. The tree toggle is
      // blind, so only call it when the requested state actually differs.
      const isPinned = item.pinned === true;
      return (next: boolean) => { if (next !== isPinned) void toggleFolderPinned(item.fullPath); };
    }
    if (item.pinnedEntryKind === 'collection') {
      const collectionId = item.pinnedCollectionId;
      if (!collectionId) return undefined;
      return (next: boolean) => {
        void toggleCollectionPinned(collectionId, next, {
          pinnedItemId: item.id,
          kind: item.pinnedCollectionType,
        });
      };
    }
    if (item.pinnedEntryKind === 'document') {
      return (next: boolean) => { void toggleDocumentPinned(item, next); };
    }
    return undefined;
  }, [toggleCollectionPinned, toggleDocumentPinned, toggleFolderPinned]);

  return {
    toggleDocumentPinned,
    toggleCollectionPinned,
    treePinProps,
    pinnedRowToggle,
  };
}
