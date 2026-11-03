import { useCallback, useEffect, useRef, useState } from 'react';

import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { notebookCreateErrorMessage } from '@platform/tauri/errors';
import { listenToNotebookImportStatus } from '@platform/tauri/client';
import { notebookRepository } from '@features/memo/services/note-repository';
import {
  resolveNotebookImportStatusEffect,
  type NotebookCreationState,
} from '@features/memo/hooks/create-notebook-flow-state';
import { useNoteStore, type Notebook } from '@features/memo/store';
import { selectNotebook } from '@features/workspace/public/main-window-api';
import { createNotebookRegistration } from '@features/memo/services/notebook-creation-service';
import { resolveNotebookIconId } from '@features/memo/components/notebook-icon';

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
}

export function useCreateNotebookFlow({
  onMemoListReloadNeeded,
}: UseCreateNotebookFlowOptions) {
  const { t } = useI18n();
  const [creationState, setCreationState] = useState<NotebookCreationState>({
    status: 'idle',
  });
  const createInFlightRef = useRef(false);
  const registeredNotebookRef = useRef<{
    key: string;
    registration: Awaited<ReturnType<typeof createNotebookRegistration>>;
  } | null>(null);
  const activeImportNotebookIdRef = useRef<string | null>(null);
  const importMonitorGenerationRef = useRef(0);

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
      if (
        effect.reloadMemoList
        && useNoteStore.getState().selectedNotebook?.id === trackedNotebookId
      ) {
        onMemoListReloadNeeded();
      }
      if (effect.errorMessage) {
        toast.error(effect.errorMessage);
      }
      if (importStatus.status !== 'started') {
        activeImportNotebookIdRef.current = null;
      }
    },
    [onMemoListReloadNeeded, t],
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
      const notebookIcon = resolveNotebookIconId(icon);
      if (!notebookName || (cloudNotebookId && !notebookPath)) return null;
      if (createInFlightRef.current) return null;
      createInFlightRef.current = true;
      const registrationKey = JSON.stringify({ notebookName, notebookPath, icon: notebookIcon, cloudNotebookId });

      setCreationState({ status: 'creating' });

      try {
        let registration: Awaited<ReturnType<typeof createNotebookRegistration>>;
        if (registeredNotebookRef.current?.key === registrationKey) {
          registration = registeredNotebookRef.current.registration;
        } else {
          registeredNotebookRef.current = null;
          if (cloudNotebookId) {
            registration = {
              notebook: await notebookRepository.createFromCloud(
                cloudNotebookId,
                notebookName,
                notebookPath ?? '',
                notebookIcon,
                false,
              ),
              created: true,
              needsImport: false,
            };
          } else {
            registration = await createNotebookRegistration({
              name: notebookName,
              path: notebookPath,
              icon: notebookIcon,
              reuseExisting: true,
            });
          }
          registeredNotebookRef.current = { key: registrationKey, registration };
        }
        const created = registration.notebook as Notebook | null;

        if (!created) {
          registeredNotebookRef.current = null;
          toast.error(t('memo.list.createFailed'));
          setCreationState({ status: 'failed', message: t('memo.list.createFailed') });
          return null;
        }

        const memoStore = useNoteStore.getState();
        const existingNotebooks = memoStore.notebooks;
        const nextNotebooks = existingNotebooks.some((notebook) => notebook.id === created.id)
          ? existingNotebooks.map((notebook) => notebook.id === created.id ? created : notebook)
          : [...existingNotebooks, created];

        memoStore.setNotebooks(nextNotebooks);
        await selectNotebook(created);
        registeredNotebookRef.current = null;

        if (cloudNotebookId) {
          setCreationState({ status: 'idle' });
        } else if (registration.needsImport) {
          const generation = ++importMonitorGenerationRef.current;
          activeImportNotebookIdRef.current = created.id;
          setCreationState({ status: 'importing', notebookId: created.id });
          try {
            await notebookRepository.startImport(created.id);
            void monitorImportStatus(created.id, generation);
          } catch (error) {
            const message = notebookCreateErrorMessage(error, t);
            activeImportNotebookIdRef.current = null;
            setCreationState({ status: 'failed', message });
            toast.error(message);
          }
        } else {
          setCreationState({ status: 'idle' });
        }

        // The returned notebook is authoritative for the critical path. The
        // complete list refresh is best-effort and must not delay selection.
        void notebookRepository.list()
          .then((freshNotebooks) => {
            useNoteStore.getState().setNotebooks(freshNotebooks as Notebook[]);
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
        return null;
      } finally {
        createInFlightRef.current = false;
      }
    },
    [
      t,
    ],
  );

  return {
    createNotebook,
    creationState,
  };
}
