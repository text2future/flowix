import { useCallback, useEffect, useRef, useState } from 'react';
import type { PluginDescriptor } from '@platform/tauri/client';
import { notebooks as notebooksClient } from '@platform/tauri/client';
import { notebookDeleteErrorMessage } from '@platform/tauri/errors';
import { useI18n } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { useSettingsStore } from '@/lib/store/settings-store';
import { useMemoStore, type Notebook } from '@features/memo';
import {
  clearPluginWorkbenchTarget,
  flushWorkspaceDocument,
  openPluginWorkbench,
  reconcileDeletedNotebook,
  selectNotebook,
  useWorkspaceNavigationPhase,
  useWorkspaceTargetKind,
} from '@features/workspace/public/main-window-api';

const logger = createLogger('main-window-business-controller');

export interface MainWindowBusinessController {
  notebookToDelete: Notebook | null;
  notebookCreateRequest: number;
  cancelDeleteNotebook(): void;
  confirmDeleteNotebook(): Promise<void>;
  createNotebook(): void;
  deleteNotebook(notebook: Notebook): void;
  editNotebook(notebook: Notebook): void;
  openPlugin(plugin: PluginDescriptor): Promise<void>;
  selectNotebook(notebook: Notebook): void;
}

export function useMainWindowBusinessController(): MainWindowBusinessController {
  const { t } = useI18n();
  const selectedNotebook = useMemoStore((state) => state.selectedNotebook);
  const setActiveFilter = useMemoStore((state) => state.setActiveFilter);
  const setActivePluginId = useMemoStore((state) => state.setActivePluginId);
  const triggerRefresh = useMemoStore((state) => state.triggerRefresh);
  const setMemoListVisible = useSettingsStore((state) => state.setMemoListVisible);
  const workColumnTargetKind = useWorkspaceTargetKind();
  const navigationPhase = useWorkspaceNavigationPhase();
  const [notebookToDelete, setNotebookToDelete] = useState<Notebook | null>(null);
  const [notebookCreateRequest, setNotebookCreateRequest] = useState(0);
  const syncedNotebookIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (navigationPhase === 'loading') return;
    const notebookId = selectedNotebook?.id ?? null;
    if (syncedNotebookIdRef.current === notebookId) return;
    syncedNotebookIdRef.current = notebookId;
    void notebooksClient.setCurrent(notebookId).catch((error) => {
      logger.warn('sync current notebook failed', { error });
      syncedNotebookIdRef.current = undefined;
    });
  }, [navigationPhase, selectedNotebook?.id]);

  useEffect(() => {
    const handleRequest = (event: Event) => {
      const notebook = (event as CustomEvent<Notebook>).detail;
      if (notebook) setNotebookToDelete(notebook);
    };
    window.addEventListener('flowix:request-delete-notebook', handleRequest as EventListener);
    return () => window.removeEventListener('flowix:request-delete-notebook', handleRequest as EventListener);
  }, []);

  const handleSelectNotebook = useCallback((notebook: Notebook) => {
    if (selectedNotebook?.id === notebook.id) return;
    void selectNotebook(notebook).then(() => {
      triggerRefresh();
    }).catch((error) => {
      logger.warn('select notebook failed', { error });
    });
  }, [selectedNotebook?.id, triggerRefresh]);

  const handleEditNotebook = useCallback((notebook: Notebook) => {
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent<Notebook>('flowix:open-edit-notebook', { detail: notebook }));
    }, 0);
  }, []);

  const handleDeleteNotebook = useCallback((notebook: Notebook) => {
    setTimeout(() => setNotebookToDelete(notebook), 0);
  }, []);

  const confirmDeleteNotebook = useCallback(async () => {
    const target = notebookToDelete;
    if (!target) return;
    try {
      if (selectedNotebook?.id === target.id) await flushWorkspaceDocument();
      const deleted = await notebooksClient.delete(target.id);
      if (!deleted) {
        toast.error(t('shell.notebook.deleteFailed'));
        return;
      }
      const notebooks = await notebooksClient.getAll();
      if (!notebooks) throw new Error('Notebook list is unavailable after deletion');
      await reconcileDeletedNotebook(target.id, notebooks);
      toast.success(t('shell.notebook.deleted'));
      triggerRefresh();
    } catch (error) {
      logger.warn('delete notebook failed', { error });
      toast.error(notebookDeleteErrorMessage(error, t));
    } finally {
      setNotebookToDelete(null);
    }
  }, [notebookToDelete, selectedNotebook?.id, t, triggerRefresh]);

  const openPlugin = useCallback(async (plugin: PluginDescriptor) => {
    if (plugin.manifest.kind === 'artifact-tool') {
      if (workColumnTargetKind === 'plugin-workbench') clearPluginWorkbenchTarget();
      setActiveFilter('all');
      setActivePluginId(plugin.manifest.id);
      setMemoListVisible(true);
      return;
    }
    try {
      await openPluginWorkbench(plugin);
      setMemoListVisible(true);
    } catch (error) {
      logger.warn('open plugin failed to clear document', { error });
    }
  }, [setActiveFilter, setActivePluginId, setMemoListVisible, workColumnTargetKind]);

  return {
    notebookToDelete,
    notebookCreateRequest,
    cancelDeleteNotebook: () => setNotebookToDelete(null),
    confirmDeleteNotebook,
    createNotebook: () => setNotebookCreateRequest((request) => request + 1),
    deleteNotebook: handleDeleteNotebook,
    editNotebook: handleEditNotebook,
    openPlugin,
    selectNotebook: handleSelectNotebook,
  };
}
