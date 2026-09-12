import { useCallback, useEffect, useRef, useState } from 'react';

import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { notebookCreateErrorMessage } from '@platform/tauri/errors';
import { listenToNotebookImportStatus } from '@platform/tauri/client';
import { notebookRepository } from '@features/memo/services/memo-repository';
import {
  resolveNotebookImportStatusEffect,
  type NotebookCreationState,
} from '@features/memo/hooks/create-notebook-flow-state';
import { useMemoStore, useTagStore, type Notebook } from '@features/memo/store';
import { clearWorkspaceDocument } from '@features/workspace/use-cases/workspace-navigation';

const NOTEBOOK_CREATE_SCAN_TIMEOUT_MS = 30_000;
const NOTEBOOK_IMPORT_POLL_INTERVAL_MS = 500;
const NOTEBOOK_IMPORT_POLL_MAX_ATTEMPTS = 1_200;

interface CreateNotebookInput {
  name: string;
  path?: string;
  icon?: string | null;
  cloudNotebookId?: string;
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
  const createInFlightRef = useRef(false);
  const activeImportNotebookIdRef = useRef<string | null>(null);
  const importMonitorGenerationRef = useRef(0);

  const clearCreateNotebookScanTimeout = useCallback(() => {
    if (createNotebookScanTimeoutRef.current === null) return;
    window.clearTimeout(createNotebookScanTimeoutRef.current);
    createNotebookScanTimeoutRef.current = null;
  }, []);

  useEffect(() => clearCreateNotebookScanTimeout, [clearCreateNotebookScanTimeout]);

  const handleImportStatus = useCallback(
    (importStatus: Parameters<typeof resolveNotebookImportStatusEffect>[1]) => {
      const trackedNotebookId = activeImportNotebookIdRef.current;
      if (!trackedNotebookId) return;
      const effect = resolveNotebookImportStatusEffect(
        trackedNotebookId,
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
      if (importStatus.status !== 'started') {
        activeImportNotebookIdRef.current = null;
      }
    },
    [onMemoListLoadingChange, onMemoListReloadNeeded, t],
  );

  useEffect(() => {
    return listenToNotebookImportStatus(handleImportStatus);
  }, [handleImportStatus]);

  const monitorImportStatus = useCallback(async (notebookId: string, generation: number) => {
    for (let attempt = 0; attempt < NOTEBOOK_IMPORT_POLL_MAX_ATTEMPTS; attempt += 1) {
      if (
        importMonitorGenerationRef.current !== generation
        || activeImportNotebookIdRef.current !== notebookId
      ) return;

      try {
        const status = await notebookRepository.getImportStatus(notebookId);
        if (status && status.status !== 'started') {
          handleImportStatus(status);
          return;
        }
      } catch (error) {
        // Events remain the primary path. A transient status query failure
        // should not turn a running import into a false error.
        console.warn('[MemoList] Failed to query notebook import status:', error);
      }

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, NOTEBOOK_IMPORT_POLL_INTERVAL_MS);
      });
    }
  }, [handleImportStatus]);

  const createNotebook = useCallback(
    async ({ name, path, icon, cloudNotebookId }: CreateNotebookInput): Promise<Notebook | null> => {
      const notebookName = name.trim();
      const notebookPath = path?.trim() || undefined;
      if (!notebookName || (cloudNotebookId && !notebookPath)) return null;
      if (createInFlightRef.current) return null;
      createInFlightRef.current = true;

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
        const pathForCreate = notebookPath ?? '';
        const created = await (cloudNotebookId
          ? notebookRepository.createFromCloud(cloudNotebookId, notebookName, pathForCreate, icon)
          : notebookRepository.create(notebookName, notebookPath, icon)) as Notebook | null;

        if (!created) {
          toast.error(t('memo.list.createFailed'));
          setCreationState({ status: 'failed', message: t('memo.list.createFailed') });
          return null;
        }

        const memoStore = useMemoStore.getState();
        const existingNotebooks = memoStore.notebooks;
        const nextNotebooks = existingNotebooks.some((notebook) => notebook.id === created.id)
          ? existingNotebooks.map((notebook) => notebook.id === created.id ? created : notebook)
          : [...existingNotebooks, created];

        memoStore.setNotebooks(nextNotebooks);
        memoStore.setSelectedNotebook(created);
        memoStore.setSelectedMemo(null);
        memoStore.setMemos([]);
        void clearWorkspaceDocument();
        useTagStore.getState().setSelectedTagId(null);
        onMemoListQueryReset();
        onMemoListLoadingChange(true);
        onMemoListReloadNeeded();

        if (cloudNotebookId) {
          setCreationState({ status: 'idle' });
        } else {
          const generation = ++importMonitorGenerationRef.current;
          activeImportNotebookIdRef.current = created.id;
          setCreationState({ status: 'importing', notebookId: created.id });
          try {
            await notebookRepository.startImport(created.id);
            void monitorImportStatus(created.id, generation);
          } catch (error) {
            const message = notebookCreateErrorMessage(error, t);
            activeImportNotebookIdRef.current = null;
            onMemoListLoadingChange(false);
            setCreationState({ status: 'failed', message });
            toast.error(message);
          }
        }

        // The returned notebook is authoritative for the critical path. The
        // complete list refresh is best-effort and must not delay selection.
        void notebookRepository.list()
          .then((freshNotebooks) => {
            useMemoStore.getState().setNotebooks(freshNotebooks as Notebook[]);
          })
          .catch((error) => {
            console.warn('[MemoList] Failed to refresh notebook list:', error);
          });
        return created;
      } catch (error) {
        console.warn('[MemoList] Failed to create notebook:', error);
        const message = notebookCreateErrorMessage(error, t);
        toast.error(message);
        setCreationState({ status: 'failed', message });
        onMemoListLoadingChange(false);
        return null;
      } finally {
        createInFlightRef.current = false;
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
