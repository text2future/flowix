import { canonicalDirectoryPath, canonicalPath, samePath } from '@/lib/path';
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

export interface NotebookTreeRenderModel {
  rows: NotebookTreeRenderRow[];
  /** 行号索引，reveal 与键盘导航直接查，不再从 rows 里 flatMap 一遍。 */
  rowIndexByPath: Map<string, number>;
}

const NODE_ROW_KEY_PREFIX = 'node:';
const DRAFT_ROW_KEY_PREFIX = 'draft:';

/**
 * 父目录只做一次归一化：入参 `canonicalFilePath` 已经是 canonical 形式，
 * 所以这里不调 `parentDirectoryPath` —— 它内部还要再跑两遍 `canonicalPath`
 * 的正则替换，是这条链在大 V 下最贵的一段。语义与它逐字对齐（含 Windows
 * 盘符 `C:/` 必须保留斜杠这一条），由 `notebook-tree-render-rows.test.ts` 兜住。
 */
function parentDirectoryOfCanonical(canonicalFilePath: string, root: string): string {
  const trimmed = canonicalFilePath.replace(/\/+$/, '');
  const separatorIndex = trimmed.lastIndexOf('/');
  const parent = separatorIndex >= 0 ? trimmed.slice(0, separatorIndex + 1) : root;
  // A physical parent must keep the slash: C: is drive-relative on Windows.
  if (/^[a-z]:\/$/i.test(parent)) return parent;
  return parent.replace(/\/+$/, '') || (parent.startsWith('/') ? '/' : root);
}

/** 就地插入草稿行；父目录不在可见行里时不动。 */
function insertDraftRow(
  rows: NotebookTreeRenderRow[],
  root: string,
  draft: NotebookTreeDraftState,
): void {
  const parentPath = canonicalDirectoryPath(draft.parentPath);
  const parentIndex = parentPath === root
    ? -1
    : rows.findIndex((row) => row.kind === 'node' && samePath(row.item.fullPath, parentPath));
  if (parentPath !== root && parentIndex < 0) return;

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

  // 草稿插在本层最后一个文件夹之后，跟另一处“新建文件夹”落点保持一根线。
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
    key: `${DRAFT_ROW_KEY_PREFIX}${draft.requestId}`,
    draft,
    depth: childDepth,
    parentPath,
  });
}

/**
 * 建行、兄弟位序、行号索引一趟出齐。
 *
 * 这三样此前是两趟 + 一遍 `canonicalPath` 重算：行先 map 一遍，`attachTreeSiblingMetadata`
 * 再把行扫两遍（数兄弟、定位序），行号索引又扫一遍，而且每行路径要归一化
 * 四次（行 key、`parentDirectoryPath` 内部两次、索引键）。`visibleTreeItems`
 * 每次 `nodes` 变化都重建，这条链跟着一起跑。
 */
export function buildNotebookTreeRenderModel(
  visibleItems: readonly { item: DocTreeItem; depth: number }[],
  notebookPath: string,
  draft: NotebookTreeDraftState | null,
): NotebookTreeRenderModel {
  const root = canonicalDirectoryPath(notebookPath);
  const rows: NotebookTreeRenderRow[] = [];
  // 兄弟计数在建成行的那一趟顺手数掉；草稿行不计入 setSize（与旧行为一致）。
  const siblingCounts = new Map<string, number>();
  for (const { item, depth } of visibleItems) {
    const canonical = canonicalPath(item.fullPath);
    const parentPath = parentDirectoryOfCanonical(canonical, root);
    siblingCounts.set(parentPath, (siblingCounts.get(parentPath) ?? 0) + 1);
    rows.push({ kind: 'node', key: `${NODE_ROW_KEY_PREFIX}${canonical}`, item, depth, parentPath });
  }

  if (draft) insertDraftRow(rows, root, draft);

  // 位序与行号必须在插完草稿之后再定：草稿行会把后面的行号整体推一位。
  const positions = new Map<string, number>();
  const rowIndexByPath = new Map<string, number>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.kind !== 'node') continue;
    const position = (positions.get(row.parentPath) ?? 0) + 1;
    positions.set(row.parentPath, position);
    row.posInSet = position;
    row.setSize = siblingCounts.get(row.parentPath);
    rowIndexByPath.set(row.key.slice(NODE_ROW_KEY_PREFIX.length), index);
  }
  return { rows, rowIndexByPath };
}
