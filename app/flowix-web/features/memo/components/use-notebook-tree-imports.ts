import { useCallback } from 'react';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { files, dialogs } from '@platform/tauri/client';
import type { FolderTreeController } from './use-folder-tree';
import {
  normalizeNotebookMoveFailure,
  showNotebookMoveFailureToasts,
  type NotebookMoveFailure,
} from './notebook-move-failure-toast';
import { getNotebookFolderImportErrorKey } from './notebook-folder-import';

const logger = createLogger('notebook-file-tree');

interface UseNotebookTreeImportsOptions {
  notebookPath: string;
  refreshDirectory: FolderTreeController['refresh'];
}

/** Owns the picker/import/refresh workflow for the notebook file tree. */
export function useNotebookTreeImports({ notebookPath, refreshDirectory }: UseNotebookTreeImportsOptions) {
  const { t } = useI18n();

  const handleImportFiles = useCallback(async (targetDirectoryPath: string) => {
    const selectedPaths = await dialogs.selectFiles({ multiple: true });
    if (!selectedPaths?.length) return;

    const failures: NotebookMoveFailure[] = [];
    for (const sourcePath of selectedPaths) {
      try {
        await files.importFile(sourcePath, targetDirectoryPath, notebookPath);
      } catch (error) {
        logger.warn('importing file into notebook tree failed', { error, sourcePath, targetDirectoryPath });
        failures.push(normalizeNotebookMoveFailure(error));
      }
    }
    await refreshDirectory(targetDirectoryPath);
    if (failures.length > 0) {
      showNotebookMoveFailureToasts(
        t,
        selectedPaths.length - failures.length,
        failures.length,
        failures,
      );
    }
  }, [notebookPath, refreshDirectory, t]);

  const handleImportFolder = useCallback(async (targetDirectoryPath: string) => {
    let sourceDirectoryPath: string | null | undefined;
    let progressToastId: string | number | undefined;
    try {
      sourceDirectoryPath = await dialogs.selectImportDirectory();
      if (!sourceDirectoryPath) return;
      progressToastId = toast.info(t('memo.fileTree.importFolderInProgress'), { duration: Number.POSITIVE_INFINITY });
      await files.importFolder(sourceDirectoryPath, targetDirectoryPath, notebookPath);
      await refreshDirectory(targetDirectoryPath);
      toast.dismiss(progressToastId);
      progressToastId = undefined;
      toast.success(t('memo.fileTree.importFolderSuccess'));
    } catch (error) {
      logger.warn('importing folder into notebook tree failed', { error, sourceDirectoryPath, targetDirectoryPath });
      if (sourceDirectoryPath) {
        try {
          await refreshDirectory(targetDirectoryPath);
        } catch (refreshError) {
          logger.warn('refreshing notebook tree after folder import failed', { refreshError, targetDirectoryPath });
        }
      }
      toast.error(t(getNotebookFolderImportErrorKey(error)));
    } finally {
      if (progressToastId !== undefined) toast.dismiss(progressToastId);
    }
  }, [notebookPath, refreshDirectory, t]);

  return { handleImportFiles, handleImportFolder };
}
