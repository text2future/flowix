import type { MemoItem, MemoStore } from '@features/memo';

// Re-exported for callers that import DocumentBuffer from this module.
// The canonical definition lives in lib/store/document-buffer.ts so that
// the document store layer (which is window-agnostic) can use it.
export type { DocumentBuffer } from '@features/document/store/document-buffer';

export function extractBodyContent(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

export function countTextUnits(content: string): number {
  const chineseChars = content.match(/\p{Script=Han}/gu)?.length ?? 0;
  const englishWords = content.match(/[A-Za-z]+/g)?.length ?? 0;

  return chineseChars + englishWords;
}

export function upsertFilenameFrontmatter(content: string, filename: string): string {
  const filenameLine = `filename: ${JSON.stringify(filename)}`;
  const match = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/);

  if (!match) {
    return `---\n${filenameLine}\n---\n${content}`;
  }

  const bodyStart = match[0].length;
  const frontmatter = /^filename\s*:/m.test(match[2])
    ? match[2].replace(/^filename\s*:.*$/m, filenameLine)
    : `${filenameLine}\n${match[2]}`;

  return `${match[1]}${frontmatter}${match[3]}${content.slice(bodyStart)}`;
}

export function joinPath(basePath: string, filePath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('/') || filePath.startsWith('\\')) {
    return filePath;
  }
  return `${basePath.replace(/[\\/]+$/, '')}/${filePath.replace(/^[\\/]+/, '')}`;
}

/**
 * 拼 memo 物理路径 ── v3 改造: 直接用 `memo.filename` (磁盘文件名, 含 .md)
 * 拼接到 notebookPath 根目录, 不再需要 `memo.path` 字段或 `#<id>` 后缀。
 */
export function resolveMemoDocumentPath(
  notebookPath: string | undefined,
  memo: MemoItem,
  fallbackPath: string,
): string {
  if (!notebookPath || !memo.filename) {
    return fallbackPath;
  }

  return joinPath(notebookPath, memo.filename);
}

export function findMemoById(
  state: Pick<MemoStore, 'memos' | 'selectedMemo'>,
  memoId: string | null | undefined,
): MemoItem | null {
  if (!memoId) return null;
  return state.memos.find((memo) => memo.id === memoId)
    ?? (state.selectedMemo?.id === memoId ? state.selectedMemo : null);
}

// `memoNeedsFilenameFinalize` 移除 ── v3 改造后物理 rename 不再发生
// (filename 由后端 memo index 持有, 后端 rename_memo 一次同步物理文件 +
// memo index, 物理路径不会"未及时更新"), 所以前端不再需要"写盘后
// 检测 path 是否需要 finalize"的兜底机制。
