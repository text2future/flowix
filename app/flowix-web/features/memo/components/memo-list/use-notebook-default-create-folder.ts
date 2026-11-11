'use client';

import { useCallback, useEffect, useState } from 'react';
import { canonicalDirectoryPath } from '@/lib/path';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { subscribe } from '@platform/tauri/event-bus';
import { files } from '@platform/tauri/client';
import { useNoteStore } from '@features/memo/store/note-store';

const logger = createLogger('memo-list');

interface NotebookIdentity {
  id: string;
  path: string;
}

interface DefaultCreateFolderState {
  notebookId: string;
  path: string | null;
}

/** Loads and persists the selected notebook's default note folder preference. */
export function useNotebookDefaultCreateFolder(notebook: NotebookIdentity | null) {
  const { t } = useI18n();
  const [state, setState] = useState<DefaultCreateFolderState | null>(null);
  const notebookId = notebook?.id;
  const notebookPath = notebook?.path;
  const defaultCreateFolder = notebook && state?.notebookId === notebook.id ? state.path : null;
  const defaultCreateFolderReady = Boolean(notebook && state?.notebookId === notebook.id);

  useEffect(() => {
    let current = true;
    setState(null);
    if (notebookId === undefined || notebookPath === undefined) return () => { current = false; };

    void files.getNotebookViewPreferences(notebookPath)
      .then((preferences) => {
        if (current) setState({ notebookId, path: preferences.defaultCreateFolder ?? null });
      })
      .catch((error) => {
        logger.warn('load notebook view preferences failed', { error, notebookId });
        if (current) setState({ notebookId, path: null });
      });
    return () => { current = false; };
  }, [notebookId, notebookPath]);

  useEffect(() => subscribe<{ notebookPath: string; defaultCreateFolderChanged: boolean }>(
    'notebook-view-preferences-changed',
    ({ notebookPath, defaultCreateFolderChanged }) => {
      if (!defaultCreateFolderChanged) return;
      const selectedNotebook = useNoteStore.getState().selectedNotebook;
      if (!selectedNotebook
        || canonicalDirectoryPath(selectedNotebook.path) !== canonicalDirectoryPath(notebookPath)) return;
      void files.getNotebookViewPreferences(selectedNotebook.path).then((preferences) => {
        if (useNoteStore.getState().selectedNotebook?.id === selectedNotebook.id) {
          setState({ notebookId: selectedNotebook.id, path: preferences.defaultCreateFolder ?? null });
        }
      }).catch((error) => {
        logger.warn('refresh notebook default create folder failed', { error, notebookId: selectedNotebook.id });
      });
    },
  ), []);

  const handleSetDefaultCreateFolder = useCallback(async (folderPath: string) => {
    if (!notebook) return;
    const root = canonicalDirectoryPath(notebook.path);
    const folder = canonicalDirectoryPath(folderPath);
    if (folder !== root && !folder.startsWith(`${root}/`)) return;
    const relative = folder === root ? null : folder.slice(root.length + 1);
    try {
      const preferences = await files.getNotebookViewPreferences(notebook.path);
      const nextDefaultFolder = defaultCreateFolder === relative ? null : relative;
      await files.setNotebookViewPreferences(notebook.path, {
        ...preferences,
        defaultCreateFolder: nextDefaultFolder,
      });
      setState({ notebookId: notebook.id, path: nextDefaultFolder });
      toast.success(t(defaultCreateFolder === relative
        ? 'memo.fileTree.defaultCreateFolderCleared'
        : 'memo.fileTree.defaultCreateFolderSet'));
    } catch (error) {
      logger.warn('set notebook default create folder failed', { error, folderPath });
      toast.error(t('memo.fileTree.preferenceSaveFailed'));
    }
  }, [defaultCreateFolder, notebook, t]);

  const handleSaveDefaultCreateFolder = useCallback(async (folderPath: string | null): Promise<boolean> => {
    if (!notebook) return false;
    const normalizedPath = folderPath?.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || null;
    try {
      const preferences = await files.getNotebookViewPreferences(notebook.path);
      await files.setNotebookViewPreferences(notebook.path, {
        ...preferences,
        defaultCreateFolder: normalizedPath,
      });
      setState({ notebookId: notebook.id, path: normalizedPath });
      toast.success(t(normalizedPath
        ? 'memo.fileTree.defaultCreateFolderSet'
        : 'memo.fileTree.defaultCreateFolderCleared'));
      return true;
    } catch (error) {
      logger.warn('save default note folder failed', { error, folderPath });
      toast.error(t('memo.fileTree.preferenceSaveFailed'));
      return false;
    }
  }, [notebook, t]);

  return {
    defaultCreateFolder,
    defaultCreateFolderReady,
    handleSetDefaultCreateFolder,
    handleSaveDefaultCreateFolder,
  };
}
