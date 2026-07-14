// v3 改造: 原 `finalizeMemoRename` 走 `memoNeedsFilenameFinalize` 检测
// 物理路径是否需要 finalize (旧 P1 修复遗留: 写盘后 memo index `path`
// 字段临时态 vs 物理文件 rename 之间的 race)。v3 后:
// - 物理 rename 不再发生 (filename 由 memo index 持有, 后端 rename_memo
//   一次同步物理文件 + memo index, 没有 race 窗口)
// - memo index `path` 字段已删, memo 物理路径 = notebookPath + memo.filename
// - 后端 `finalize_memo_filename` IPC 已变成 no-op 兼容保留
//
// 所以前端这条 finalize 路径整体简化为 no-op ── hook 保留 callback
// 形态 (document-container 仍会调 `onEditingFinished={finalizeMemoRename}`),
// 但内部不做任何 IPC, 立刻 resolve。

import { useCallback } from 'react';

import type { MemoItem } from '@features/memo';

interface UseDocumentFinalizeOptions {
  filePath: string;
  memoId: string | null;
  notebookId: string | null;
  notebookPath: string | null;
  isExternalDocument: boolean;
  clearSaveTimer: () => void;
  saveDoc: (content: string, path: string, options?: { refreshList?: boolean; force?: boolean }) => Promise<void>;
  setState: React.Dispatch<React.SetStateAction<{
    fullContent: string;
    isLoading: boolean;
    error: string | null;
    isScrolled: boolean;
    isNewlyCreated: boolean;
    charCount: number;
    tokenCount: number;
    createdAt: string;
    updatedAt: string;
    updatedAtDate: Date | null;
    isFavorited: boolean;
    frontmatterMeta: Record<string, unknown>;
  }>>;
  upsertMemo: (memo: MemoItem) => void;
  openMemoDocument: (params: {
    memoId: string;
    path: string | null;
    notebookId?: string | null;
    notebookPath?: string | null;
  }) => Promise<void>;
}

export function useDocumentFinalize(_options: UseDocumentFinalizeOptions) {
  // no-op: v3 后 finalize 路径已无意义。保留 callback 形态给
  // document-container 的 onEditingFinished 接口兼容, 实际不做事。
  const finalizeMemoRename = useCallback(async (_opts?: {
    updateEditorState?: boolean;
    refreshList?: boolean;
  }) => {
    // intentionally empty
  }, []);

  return { finalizeMemoRename };
}
