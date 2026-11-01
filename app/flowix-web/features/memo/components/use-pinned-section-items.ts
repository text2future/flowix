'use client';

import { useMemo } from 'react';

import { canonicalPath } from '@/lib/path';
import type { DocTreeItem } from '@platform/tauri/client';
import { flattenFolderSubtrees, type FolderTreeSort } from './use-folder-tree';
import type { PinnedTreeItem } from './use-notebook-pinned-notes';

interface UsePinnedSectionItemsOptions {
  /** Pinned notes, documents and collections, newest first. */
  entries: PinnedTreeItem[];
  /** Pinned folder full paths in sidebar order; these render above `entries`. */
  folderPaths: readonly string[];
  /** Every loaded tree item, used to resolve a pinned folder's own node. */
  loadedItems: readonly DocTreeItem[];
  nodes: ReadonlyMap<string, DocTreeItem>;
  /** Pinned-group-local expand state, decoupled from the files tree's. */
  expanded: ReadonlySet<string>;
  sort: FolderTreeSort;
}

function folderRow(
  item: DocTreeItem,
  depth: number,
  expanded: ReadonlySet<string>,
  pinnedKeys: ReadonlySet<string>,
): PinnedTreeItem {
  const key = canonicalPath(item.fullPath);
  return {
    ...item,
    id: `pinned-folder:${key}`,
    // Folders pin one path at a time: a subfolder that is only visible because
    // its parent is pinned is not pinned itself, so it must not carry the flag.
    pinned: pinnedKeys.has(key),
    pinnedEntryKind: 'folder',
    pinnedDepth: depth,
    pinnedExpanded: expanded.has(key),
  };
}

/**
 * A note or document shown because its parent folder is pinned. It is not
 * itself pinned, so it keeps its own backend flag and opens like a tree row.
 */
function subtreeRow(item: DocTreeItem, depth: number): PinnedTreeItem {
  return {
    ...item,
    id: `pinned-folder-child:${canonicalPath(item.fullPath)}`,
    pinnedEntryKind: item.resourceKind === 'note' ? 'note' : 'document',
    pinnedDepth: depth,
  };
}

/**
 * A pinned folder that was never expanded in this session has no loaded node.
 * Synthesize the row so it still shows up; expanding loads it through the tree
 * controller and the next render picks up the real node.
 */
function syntheticFolder(fullPath: string): DocTreeItem {
  return {
    id: `pinned-folder:${canonicalPath(fullPath)}`,
    fullPath,
    name: fullPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? fullPath,
    type: 'folder',
    parentId: null,
    children: null,
    sizeBytes: null,
    modifiedMs: 0,
    createdMs: null,
    memoCreatedMs: null,
  };
}

/**
 * The pinned section renders pinned folders first, then the mixed pinned
 * entries. Folders keep their subtree so they can be expanded in place; the
 * files tree still lists them untouched.
 */
export function buildPinnedSectionItems({
  entries,
  folderPaths,
  loadedItems,
  nodes,
  expanded,
  sort,
}: UsePinnedSectionItemsOptions): PinnedTreeItem[] {
  if (folderPaths.length === 0) return entries;
  const byPath = new Map(loadedItems.map((item) => [canonicalPath(item.fullPath), item] as const));
  const roots: DocTreeItem[] = [];
  for (const path of folderPaths) {
    const key = canonicalPath(path);
    const resolved = byPath.get(key);
    if (resolved?.type === 'folder') roots.push(resolved);
    else roots.push(syntheticFolder(path));
  }
  const pinnedKeys = new Set(folderPaths.map((path) => canonicalPath(path)));
  // Every pinned folder is a root of its own; passing the set keeps a pinned
  // subfolder from being rendered a second time (indented) under its parent.
  const rows = flattenFolderSubtrees({ nodes }, roots, expanded, sort, folderPaths, pinnedKeys);
  // Belt and braces: duplicate entries in `folderPaths` still render once.
  const seen = new Set<string>();
  const folderItems: PinnedTreeItem[] = [];
  for (const { item, depth } of rows) {
    const key = canonicalPath(item.fullPath);
    if (seen.has(key)) continue;
    seen.add(key);
    folderItems.push(
      item.type === 'folder' ? folderRow(item, depth, expanded, pinnedKeys) : subtreeRow(item, depth),
    );
  }
  return [...folderItems, ...entries];
}

export function usePinnedSectionItems(options: UsePinnedSectionItemsOptions): PinnedTreeItem[] {
  const { entries, folderPaths, loadedItems, nodes, expanded, sort } = options;
  return useMemo(
    () => buildPinnedSectionItems({ entries, folderPaths, loadedItems, nodes, expanded, sort }),
    [entries, expanded, folderPaths, loadedItems, nodes, sort],
  );
}
