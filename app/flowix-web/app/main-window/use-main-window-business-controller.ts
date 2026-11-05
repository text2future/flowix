import { useCallback, useEffect, useRef, useState } from 'react';
import type { PluginDescriptor } from '@platform/tauri/client';
import { notebooks as notebooksClient } from '@platform/tauri/client';
import { notebookDeleteErrorMessage } from '@platform/tauri/errors';
import { useI18n } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { fireAndForget } from '@/lib/fire-and-forget';
import { toast } from '@/lib/toast';
import { useSettingsStore } from '@/lib/store/settings-store';
import {
  getLastPersistedWorkspaceNotebookId,
  setCurrentWorkspaceNotebook,
  type Notebook,
  useWorkspaceMemoViewModel,
} from '@features/memo/public/workspace-api';
import {
  clearPluginWorkbenchTarget,
  reconcileDeletedNotebook,
  selectNotebook,
  useWorkspaceNavigationPhase,
  useWorkspaceTargetKind,
} from '@features/workspace/public/main-window-api';
import {
  documentIdentityFromFile,
  getWorkspaceDocumentState,
  saveWorkspaceDocumentPath,
} from '@features/document/public/workspace-api';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { switchFolderCollectionType, type CollectionType } from '@features/collection/public/folder-api';

const logger = createLogger('main-window-business-controller');

export interface MainWindowBusinessController {
  notebookToDelete: Notebook | null;
  notebookCreateRequest: number;
  cancelDeleteNotebook(): void;
  confirmDeleteNotebook(deleteLocalFiles: boolean): Promise<void>;
  createNotebook(): void;
  deleteNotebook(notebook: Notebook): void;
  editNotebook(notebook: Notebook): void;
  openPlugin(plugin: PluginDescriptor): Promise<void>;
  switchFolderCollectionType(target: {
    filePath: string;
    notebookPath: string;
    notebookId: string;
  }, type: CollectionType): Promise<void>;
  selectNotebook(notebook: Notebook): void;
}

export function useMainWindowBusinessController(): MainWindowBusinessController {
  const { t } = useI18n();
  const {
    selectedNotebook,
    startupPhase,
    setActiveFilter,
    setActivePluginId,
    triggerRefresh,
  } = useWorkspaceMemoViewModel();
  const setMemoListVisible = useSettingsStore((state) => state.setMemoListVisible);
  const workColumnTargetKind = useWorkspaceTargetKind();
  const navigationPhase = useWorkspaceNavigationPhase();
  const [notebookToDelete, setNotebookToDelete] = useState<Notebook | null>(null);
  const [notebookCreateRequest, setNotebookCreateRequest] = useState(0);
  const syncedNotebookIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (navigationPhase === 'loading' || startupPhase !== 'ready') return;
    const notebookId = selectedNotebook?.id ?? null;
    if (syncedNotebookIdRef.current === notebookId) return;
    if (getLastPersistedWorkspaceNotebookId() === notebookId) {
      syncedNotebookIdRef.current = notebookId;
      return;
    }
    syncedNotebookIdRef.current = notebookId;
    void setCurrentWorkspaceNotebook(notebookId).catch((error) => {
      logger.warn('sync current notebook failed', { error });
      syncedNotebookIdRef.current = undefined;
    });
  }, [navigationPhase, selectedNotebook?.id, startupPhase]);

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
    void selectNotebook(notebook).catch((error) => {
      logger.warn('select notebook failed', { error });
    });
  }, [selectedNotebook?.id]);

  const handleEditNotebook = useCallback((notebook: Notebook) => {
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent<Notebook>('flowix:open-edit-notebook', { detail: notebook }));
    }, 0);
  }, []);

  const handleDeleteNotebook = useCallback((notebook: Notebook) => {
    setTimeout(() => setNotebookToDelete(notebook), 0);
  }, []);

  const confirmDeleteNotebook = useCallback(async (deleteLocalFiles: boolean) => {
    const target = notebookToDelete;
    if (!target) return;
    try {
      if (selectedNotebook?.id === target.id) {
        const active = getWorkspaceDocumentState().activeExternalSession;
        if (active && !await saveWorkspaceDocumentPath(
          documentIdentityFromFile(active.fileIdentity),
          active.fileIdentity.path,
          active.scopePath,
        )) {
          toast.error(t('notebook.delete.saveCurrentDocumentFailed'));
          return;
        }
      }
      const deleted = await notebooksClient.delete(target.id, deleteLocalFiles);
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
      await openWorkspaceSurface({ index: 0, target: { kind: 'plugin-workbench', plugin } });
      setMemoListVisible(true);
    } catch (error) {
      logger.warn('open plugin failed to clear document', { error });
    }
  }, [setActiveFilter, setActivePluginId, setMemoListVisible, workColumnTargetKind]);

  const handleSwitchFolderCollectionType = useCallback(async (
    target: { filePath: string; notebookPath: string; notebookId: string },
    type: CollectionType,
  ) => {
    try {
      const collectionId = await switchFolderCollectionType(target.filePath, target.notebookPath, type);
      await openWorkspaceSurface({
        index: 0,
        target: { kind: 'collection-reference', notebookId: target.notebookId, collectionId, viewId: null, collectionKind: type },
        options: { history: 'skip', refresh: true },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '切换视图类型失败');
    }
  }, []);

  useEffect(() => {
    const handleRequest = (event: Event) => {
      const detail = (event as CustomEvent<{
        filePath?: string;
        notebookPath?: string;
        notebookId?: string;
        type?: CollectionType;
      }>).detail;
      if (!detail?.filePath || !detail.notebookPath || !detail.notebookId || !detail.type) return;
      fireAndForget(
        handleSwitchFolderCollectionType({
          filePath: detail.filePath,
          notebookPath: detail.notebookPath,
          notebookId: detail.notebookId,
        }, detail.type),
        'main-window:switch-folder-collection-type',
      );
    };
    window.addEventListener('flowix:request-switch-folder-collection-type', handleRequest);
    return () => window.removeEventListener('flowix:request-switch-folder-collection-type', handleRequest);
  }, [handleSwitchFolderCollectionType]);

  return {
    notebookToDelete,
    notebookCreateRequest,
    cancelDeleteNotebook: () => setNotebookToDelete(null),
    confirmDeleteNotebook,
    createNotebook: () => setNotebookCreateRequest((request) => request + 1),
    deleteNotebook: handleDeleteNotebook,
    editNotebook: handleEditNotebook,
    openPlugin,
    switchFolderCollectionType: handleSwitchFolderCollectionType,
    selectNotebook: handleSelectNotebook,
  };
}
