'use client';

import { useMemo } from 'react';

import { canonicalPath } from '@/lib/path';
import type { DocTreeItem } from '@platform/tauri/client';

import {
  buildNotebookTreeRenderModel,
  type NotebookTreeDraftState,
  type NotebookTreeRenderModel,
} from './notebook-tree-render-rows';
import type { NotebookTreeItemIndex } from './use-folder-tree';
import { buildLoadedTreeIndex } from './use-folder-tree';

export { buildNotebookTreeRenderModel };
export type { NotebookTreeDraftState, NotebookTreeRenderModel };

/**
 * 置顶分区的项补进索引。已加载树里的同名路径优先——置顶行多出来的
 * `pinnedDepth` 之类字段只是渲染用的，消费者要的是基础 DocTreeItem。
 *
 * 关键点是「没有新路径就返回原对象」：展开或折叠置顶文件夹时路径集合
 * 通常不变，索引引用保持稳定，下游（拖拽控制器、剪贴板）因此不重算。
 */
export function addPinnedTreeItems(
  base: NotebookTreeItemIndex,
  pinnedItems: readonly DocTreeItem[],
): NotebookTreeItemIndex {
  let itemByPath: Map<string, DocTreeItem> | null = null;
  let folderPaths: Set<string> | null = null;
  for (const item of pinnedItems) {
    const key = canonicalPath(item.fullPath);
    if ((itemByPath ?? base.itemByPath).has(key)) continue;
    itemByPath ??= new Map(base.itemByPath);
    itemByPath.set(key, item);
    if (item.type === 'folder') {
      folderPaths ??= new Set(base.folderPaths);
      folderPaths.add(key);
    }
  }
  return itemByPath ? { itemByPath, folderPaths: folderPaths ?? base.folderPaths } : base;
}

export function useLoadedTreeIndex(
  rootChildren: readonly DocTreeItem[],
  nodes: ReadonlyMap<string, DocTreeItem>,
): NotebookTreeItemIndex {
  return useMemo(() => buildLoadedTreeIndex({ rootChildren, nodes }), [rootChildren, nodes]);
}

export function useTreeItemIndex(
  loadedIndex: NotebookTreeItemIndex,
  pinnedItems: readonly DocTreeItem[],
): NotebookTreeItemIndex {
  return useMemo(() => addPinnedTreeItems(loadedIndex, pinnedItems), [loadedIndex, pinnedItems]);
}

export function useNotebookTreeRenderModel(
  visibleTreeItems: readonly { item: DocTreeItem; depth: number }[],
  notebookPath: string,
  draft: NotebookTreeDraftState | null,
): NotebookTreeRenderModel {
  return useMemo(
    () => buildNotebookTreeRenderModel(visibleTreeItems, notebookPath, draft),
    [visibleTreeItems, notebookPath, draft],
  );
}
