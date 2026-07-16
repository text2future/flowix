import { useCallback, useEffect, useRef, useState } from 'react';

import { toast } from '@/lib/toast';
import { useDocumentStore } from '@features/document';
import { useI18n } from '@features/i18n';
import { notebookCreateErrorMessage } from '@platform/tauri/errors';
import { listenToNotebookImportStatus } from '@platform/tauri/client';
import { notebookRepository } from '@features/memo/services/memo-repository';
import {
  resolveNotebookImportStatusEffect,
  type NotebookCreationState,
} from '@features/memo/hooks/create-notebook-flow-state';
import { useMemoStore, useTagStore, type Notebook } from '@features/memo/store';

const NOTEBOOK_CREATE_SCAN_TIMEOUT_MS = 30_000;

interface CreateNotebookInput {
  name: string;
  path: string;
  icon?: string | null;
}

interface UseCreateNotebookFlowOptions {
  onMemoListReloadNeeded: () => void;
  onMemoListQueryReset: () => void;
  onMemoListLoadingChange: (loading: boolean) => void;
}

export function useCreateNotebookFlow({
  onMemoListReloadNeeded,
  onMemoListQueryReset,
  onMemoListLoadingChange,
}: UseCreateNotebookFlowOptions) {
  const { t } = useI18n();
  const [creationState, setCreationState] = useState<NotebookCreationState>({
    status: 'idle',
  });
  const [blockingLoadingText, setBlockingLoadingText] = useState<string | null>(null);
  const createNotebookScanTimeoutRef = useRef<number | null>(null);

  const clearCreateNotebookScanTimeout = useCallback(() => {
    if (createNotebookScanTimeoutRef.current === null) return;
    window.clearTimeout(createNotebookScanTimeoutRef.current);
    createNotebookScanTimeoutRef.current = null;
  }, []);

  useEffect(() => clearCreateNotebookScanTimeout, [clearCreateNotebookScanTimeout]);

  useEffect(() => {
    return listenToNotebookImportStatus((importStatus) => {
      const state = useMemoStore.getState();
      const effect = resolveNotebookImportStatusEffect(
        state.selectedNotebook?.id,
        importStatus,
        t('memo.list.createFailed'),
      );
      if (!effect) return;

      setCreationState(effect.creationState);
      if (effect.reloadMemoList) {
        onMemoListReloadNeeded();
      }
      if (effect.stopMemoListLoading) {
        onMemoListLoadingChange(false);
      }
      if (effect.errorMessage) {
        toast.error(effect.errorMessage);
      }
    });
  }, [onMemoListLoadingChange, onMemoListReloadNeeded, t]);

  const createNotebook = useCallback(
    async ({ name, path, icon }: CreateNotebookInput): Promise<Notebook | null> => {
      const notebookName = name.trim();
      const notebookPath = path.trim();
      if (!notebookName || !notebookPath) return null;

      setCreationState({ status: 'creating' });
      setBlockingLoadingText(t('memo.list.scanningLibrary'));
      clearCreateNotebookScanTimeout();
      createNotebookScanTimeoutRef.current = window.setTimeout(() => {
        createNotebookScanTimeoutRef.current = null;
        setBlockingLoadingText(null);
        toast.warning(t('memo.list.scanningStillRunning'));
      }, NOTEBOOK_CREATE_SCAN_TIMEOUT_MS);
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });

      try {
        const created = await notebookRepository.create(
          notebookName,
          notebookPath,
          icon,
        ) as Notebook | null;

        if (!created) {
          toast.error(t('memo.list.createFailed'));
          setCreationState({ status: 'failed', message: t('memo.list.createFailed') });
          return null;
        }

        const notebooksResult = await notebookRepository.list();
        const nextNotebooks = notebooksResult?.length ? notebooksResult as Notebook[] : [created];
        const nextNotebook = nextNotebooks.find((notebook) => notebook.id === created.id) ?? created;
        const memoStore = useMemoStore.getState();

        memoStore.setNotebooks(nextNotebooks);
        memoStore.setSelectedNotebook(nextNotebook);
        memoStore.setSelectedMemo(null);
        memoStore.setMemos([]);
        useDocumentStore.getState().clearDocument();
        useTagStore.getState().setSelectedTagId(null);
        onMemoListQueryReset();
        onMemoListLoadingChange(true);
        setCreationState({ status: 'importing', notebookId: created.id });
        onMemoListReloadNeeded();
        return created;
      } catch (error) {
        console.warn('[MemoList] Failed to create notebook:', error);
        const message = notebookCreateErrorMessage(error);
        toast.error(message);
        setCreationState({ status: 'failed', message });
        return null;
      } finally {
        clearCreateNotebookScanTimeout();
        setBlockingLoadingText(null);
      }
    },
    [
      clearCreateNotebookScanTimeout,
      onMemoListLoadingChange,
      onMemoListQueryReset,
      onMemoListReloadNeeded,
      t,
    ],
  );

  return {
    blockingLoadingText,
    createNotebook,
    creationState,
  };
}
