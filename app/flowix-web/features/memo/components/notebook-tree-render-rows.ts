import { canonicalDirectoryPath, canonicalPath, parentDirectoryPath, samePath } from '@/lib/path';
import type { DocTreeItem } from '@platform/tauri/client';

export interface NotebookTreeDraftState {
  requestId: number;
  parentPath: string;
  value: string;
}

export interface NotebookTreeNodeRenderRow {
  kind: 'node';
  key: string;
  item: DocTreeItem;
  depth: number;
  parentPath: string;
  posInSet?: number;
  setSize?: number;
}

export interface NotebookTreeDraftRenderRow {
  kind: 'draft';
  key: string;
  draft: NotebookTreeDraftState;
  depth: number;
  parentPath: string;
}

export type NotebookTreeRenderRow = NotebookTreeNodeRenderRow | NotebookTreeDraftRenderRow;

function attachTreeSiblingMetadata(rows: NotebookTreeRenderRow[]): NotebookTreeRenderRow[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== 'node') continue;
    counts.set(row.parentPath, (counts.get(row.parentPath) ?? 0) + 1);
  }
  const positions = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== 'node') continue;
    const position = (positions.get(row.parentPath) ?? 0) + 1;
    positions.set(row.parentPath, position);
    row.posInSet = position;
    row.setSize = counts.get(row.parentPath);
  }
  return rows;
}

export function buildNotebookTreeRenderRows(
  visibleItems: readonly { item: DocTreeItem; depth: number }[],
  notebookPath: string,
  draft: NotebookTreeDraftState | null,
): NotebookTreeRenderRow[] {
  const root = canonicalDirectoryPath(notebookPath);
  const rows: NotebookTreeRenderRow[] = visibleItems.map(({ item, depth }) => ({
    kind: 'node',
    key: `node:${canonicalPath(item.fullPath)}`,
    item,
    depth,
    parentPath: parentDirectoryPath(item.fullPath, root),
  }));
  if (!draft) return attachTreeSiblingMetadata(rows);

  const parentPath = canonicalDirectoryPath(draft.parentPath);
  const parentIndex = parentPath === root
    ? -1
    : rows.findIndex((row) => row.kind === 'node' && samePath(row.item.fullPath, parentPath));
  if (parentPath !== root && parentIndex < 0) return attachTreeSiblingMetadata(rows);

  const parentDepth = parentIndex < 0 ? -1 : rows[parentIndex].depth;
  const childDepth = parentDepth + 1;
  const rangeStart = parentIndex + 1;
  let rangeEnd = rows.length;
  for (let index = rangeStart; index < rows.length; index += 1) {
    if (rows[index].depth <= parentDepth) {
      rangeEnd = index;
      break;
    }
  }

  let insertionIndex = -1;
  for (let index = rangeStart; index < rangeEnd; index += 1) {
    const row = rows[index];
    if (
      row.kind === 'node'
      && row.depth === childDepth
      && samePath(row.parentPath, parentPath)
      && row.item.type === 'folder'
    ) {
      insertionIndex = index;
      break;
    }
  }

  if (insertionIndex < 0) insertionIndex = rangeStart;

  rows.splice(insertionIndex, 0, {
    kind: 'draft',
    key: `draft:${draft.requestId}`,
    draft,
    depth: childDepth,
    parentPath,
  });
  return attachTreeSiblingMetadata(rows);
}
