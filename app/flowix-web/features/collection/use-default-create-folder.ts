import { useCallback, useEffect, useState } from 'react';

import { createLogger } from '@/lib/logger';
import {
  canonicalDirectoryPath,
  notebookRelativeDirectoryPath,
  parentDirectoryPath,
} from '@/lib/path';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { files } from '@platform/tauri/client/desktop';
import { subscribe } from '@platform/tauri/event-bus';

const logger = createLogger('use-default-create-folder');

/**
 * Tracks the "default create folder" preference of the displayed collection’s notebook for
 * the collection titlebar toggle. Subscribes to preference change events so
 * edits from other surfaces stay in sync.
 */
export function useDefaultCreateFolder(selectedNotebook: { id: string; path: string } | null) {
  const { t } = useI18n();
  const [defaultCreateFolderState, setDefaultCreateFolderState] = useState<{
    notebookId: string;
    path: string | null;
  } | null>(null);
  const defaultCreateFolder = defaultCreateFolderState !== null
    && selectedNotebook != null
    && defaultCreateFolderState.notebookId === selectedNotebook.id
    ? defaultCreateFolderState.path
    : null;

  const notebookId = selectedNotebook?.id;
  const notebookPath = selectedNotebook?.path;
  useEffect(() => {
    let current = true;
    const refreshDefaultFolder = () => {
      if (!notebookId || !notebookPath) return;
      void files.getNotebookViewPreferences(notebookPath).then((preferences) => {
        if (current) setDefaultCreateFolderState({
          notebookId: notebookId,
          path: preferences.defaultCreateFolder ?? null,
        });
      }).catch((error) => {
        logger.warn('load notebook default create folder for titlebar failed', { error, notebookId: notebookId });
        if (current) setDefaultCreateFolderState({ notebookId: notebookId, path: null });
      });
    };
    if (!notebookId || !notebookPath) {
      setDefaultCreateFolderState(null);
      return () => { current = false; };
    }
    refreshDefaultFolder();
    const unsubscribe = subscribe<{ notebookPath: string; defaultCreateFolderChanged: boolean }>(
      'notebook-view-preferences-changed',
      ({ notebookPath: changedPath, defaultCreateFolderChanged }) => {
        if (defaultCreateFolderChanged
          && canonicalDirectoryPath(changedPath) === canonicalDirectoryPath(notebookPath)) {
          refreshDefaultFolder();
        }
      },
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, [notebookId, notebookPath]);

  const handleToggleDefaultFolder = useCallback(async (target: {
    filePath: string;
    notebookPath: string;
    notebookId: string;
  }) => {
    const folderPath = parentDirectoryPath(target.filePath, target.notebookPath);
    const relativeFolder = notebookRelativeDirectoryPath(target.notebookPath, folderPath);
    if (relativeFolder === null) return;
    try {
      const preferences = await files.getNotebookViewPreferences(target.notebookPath);
      const isDefaultFolder = (preferences.defaultCreateFolder ?? null) === relativeFolder;
      const nextDefaultFolder = isDefaultFolder ? null : relativeFolder;
      await files.setNotebookViewPreferences(target.notebookPath, {
        ...preferences,
        defaultCreateFolder: nextDefaultFolder,
      });
      setDefaultCreateFolderState({ notebookId: target.notebookId, path: nextDefaultFolder });
      toast.success(t(isDefaultFolder
        ? 'memo.fileTree.defaultCreateFolderCleared'
        : 'memo.fileTree.defaultCreateFolderSet'));
    } catch (error) {
      logger.warn('set default create folder from collection titlebar failed', { error, folderPath });
      toast.error(t('memo.fileTree.preferenceSaveFailed'));
    }
  }, [t]);

  return { defaultCreateFolderState, defaultCreateFolder, handleToggleDefaultFolder };
}
