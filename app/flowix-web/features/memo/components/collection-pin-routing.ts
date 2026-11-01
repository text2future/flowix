import { resourceKindFromPath } from '@features/content/public/content-api';

import { isCollectionIndexFilename, isMediaLibraryFilename, isTableDocumentFilename } from '@/lib/utils';

import type {
  CollectionIndexItem,
  DocTreeItem,
  MediaLibraryListItem,
  TableDocumentListItem,
} from '@platform/tauri/client';

/** Collection families whose pin lives in `collection_state`. */
export type CollectionPinKind = 'table' | 'media_library' | 'work_documents';

export interface CollectionPinTarget {
  collectionId: string;
  pinned: boolean;
  kind: CollectionPinKind;
}

/**
 * Path-keyed pin targets for the collection rows the catalogs know about.
 * Keys are already canonical — the caller builds these maps for the tree.
 */
export function buildCollectionPinTargets(
  tableDocuments: ReadonlyMap<string, TableDocumentListItem>,
  mediaLibraries: ReadonlyMap<string, MediaLibraryListItem>,
  workDocumentCollections: ReadonlyMap<string, CollectionIndexItem>,
): Map<string, CollectionPinTarget> {
  const targets = new Map<string, CollectionPinTarget>();
  for (const [path, table] of tableDocuments) {
    targets.set(path, { collectionId: table.collectionId, pinned: table.pinned === true, kind: 'table' });
  }
  for (const [path, library] of mediaLibraries) {
    targets.set(path, {
      collectionId: library.collectionId,
      pinned: library.pinned === true,
      kind: 'media_library',
    });
  }
  for (const [path, collection] of workDocumentCollections) {
    if (!collection.collectionId) continue;
    targets.set(path, {
      collectionId: collection.collectionId,
      pinned: collection.pinned === true,
      kind: 'work_documents',
    });
  }
  return targets;
}

/**
 * Which pin command a file-tree row must use.
 *
 * - `collection`: the row is an indexed collection; pin it by identity.
 * - `document`: a plain document; pin it through the resource catalog.
 * - `none`: no pin entry at all. Collection files the catalogs do not know —
 *   v1 `.table.yml` / `.lib.yaml` still being migrated, or a folder
 *   collection's `.index.yaml` — land here. Falling back to the document
 *   command is what used to raise "置顶失败": the resource-kind map has no
 *   entry for `.yaml`, so the command fails before it writes anything.
 */
export type TreePinRoute =
  | { kind: 'collection'; target: CollectionPinTarget }
  | { kind: 'document' }
  | { kind: 'none' };

export function resolveTreePinRoute(
  item: DocTreeItem,
  target: CollectionPinTarget | undefined,
): TreePinRoute {
  // Notes pin through frontmatter and keep their own menu. The tree does not
  // always send a resource kind, so fall back to the path like the row does.
  const resourceKind = item.resourceKind ?? resourceKindFromPath(item.name);
  if (item.type !== 'document' || resourceKind === 'note') return { kind: 'none' };
  if (target) return { kind: 'collection', target };
  if (
    isTableDocumentFilename(item.name)
    || isMediaLibraryFilename(item.name)
    || isCollectionIndexFilename(item.name)
  ) {
    return { kind: 'none' };
  }
  return { kind: 'document' };
}
