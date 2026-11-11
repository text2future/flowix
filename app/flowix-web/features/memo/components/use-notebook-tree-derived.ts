'use client';

import { useMemo } from 'react';

import { canonicalPath } from '@/lib/path';
import type { DocTreeItem } from '@platform/tauri/client';

import {
  buildNotebookTreeRenderRows,
  type NotebookTreeDraftState,
  type NotebookTreeRenderRow,
} from './notebook-tree-render-rows';
import {
  buildLoadedTreeIndex,
  type NotebookTreeItemIndex,
  type VisibleTreeNode,
} from './use-folder-tree';

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
  let next: NotebookTreeItemIndex | null = null;
  for (const item of pinnedItems) {
    const key = canonicalPath(item.fullPath);
    if (base.itemByPath.has(key)) continue;
    next ??= {
      items: base.items,
      itemByPath: new Map(base.itemByPath),
      folderPaths: new Set(base.folderPaths),
    };
    next.itemByPath.set(key, item);
    if (item.type === 'folder') next.folderPaths.add(key);
  }
  return next ?? base;
}

export interface NotebookTreeRenderModel {
  rows: NotebookTreeRenderRow[];
  /** 行号索引，reveal 与键盘导航直接查，不再从 rows 里 flatMap 一遍。 */
  rowIndexByPath: Map<string, number>;
}

export function buildNotebookTreeRenderModel(
  visibleItems: readonly VisibleTreeNode[],
  notebookPath: string,
  draft: NotebookTreeDraftState | null,
): NotebookTreeRenderModel {
  const rows = buildNotebookTreeRenderRows(visibleItems, notebookPath, draft);
  const rowIndexByPath = new Map<string, number>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.kind === 'node') rowIndexByPath.set(canonicalPath(row.item.fullPath), index);
  }
  return { rows, rowIndexByPath };
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
  visibleTreeItems: readonly VisibleTreeNode[],
  notebookPath: string,
  draft: NotebookTreeDraftState | null,
): NotebookTreeRenderModel {
  return useMemo(
    () => buildNotebookTreeRenderModel(visibleTreeItems, notebookPath, draft),
    [visibleTreeItems, notebookPath, draft],
  );
}
