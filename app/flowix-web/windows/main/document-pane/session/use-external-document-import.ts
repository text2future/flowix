import { useCallback, useState } from 'react';

import { memos as memosClient } from '../../../../lib/tauri/client';
import type { MemoItem, Notebook } from '../../../../lib/store';
import { getActiveDocumentDraft, setActiveDocumentPath } from '../../../../lib/store';
import { resolveMemoDocumentPath } from './document-utils';

interface UseExternalDocumentImportOptions {
  filePath: string;
  isExternalDocument: boolean;
  selectedNotebook: Notebook | null;
  clearSaveTimer: () => void;
  saveDoc: (content: string, path: string) => Promise<void>;
  setSelectedMemo: (memo: MemoItem | null) => void;
  loadMemos: (params?: { notebookId?: string }) => Promise<void>;
  openMemoDocument: (params: {
    memoId: string;
    path: string | null;
    notebookId?: string | null;
    notebookPath?: string | null;
  }) => Promise<void>;
  setError: (message: string) => void;
}

export function useExternalDocumentImport({
  filePath,
  isExternalDocument,
  selectedNotebook,
  clearSaveTimer,
  saveDoc,
  setSelectedMemo,
  loadMemos,
  openMemoDocument,
  setError,
}: UseExternalDocumentImportOptions) {
  const [isImportingExternal, setIsImportingExternal] = useState(false);

  const handleSaveExternalToMemo = useCallback(async () => {
    if (!filePath || !isExternalDocument || isImportingExternal) return;

    clearSaveTimer();
    const draft = getActiveDocumentDraft();
    const path = draft?.path ?? filePath;
    const content = draft?.content ?? '';
    await saveDoc(content, path);

    setIsImportingExternal(true);
    try {
      const memo = await memosClient.importExternalDocumentToMemo(
        filePath,
        content,
        selectedNotebook?.id,
      ) as MemoItem | null;
      if (!memo) {
        setError('保存到 Memo 失败');
        return;
      }

      setSelectedMemo(memo);
      await loadMemos({ notebookId: selectedNotebook?.id });
      // Update the registry's current path to the freshly-imported
      // memo's path before openMemoDocument routes through the store.
      const nextPath = resolveMemoDocumentPath(selectedNotebook?.path, memo, filePath);
      setActiveDocumentPath({ kind: 'memo', id: memo.id }, nextPath);
      await openMemoDocument({
        memoId: memo.id,
        path: nextPath,
        notebookId: selectedNotebook?.id ?? null,
        notebookPath: selectedNotebook?.path ?? null,
      });
    } catch (error) {
      console.error('[DocumentContainer] Failed to import external document:', error);
      setError('保存到 Memo 失败');
    } finally {
      setIsImportingExternal(false);
    }
  }, [
    filePath,
    isExternalDocument,
    isImportingExternal,
    selectedNotebook,
    clearSaveTimer,
    saveDoc,
    setSelectedMemo,
    loadMemos,
    openMemoDocument,
    setError,
  ]);

  return {
    isImportingExternal,
    handleSaveExternalToMemo,
  };
}
