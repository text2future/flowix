'use client';

import { useCallback } from 'react';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { useI18n } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';

type RepositoryFileHost = 0 | 1;

const logger = createLogger('notebook-repositories-open');

/**
 * Repository (资料文件夹) documents default to the Work column, matching notes
 * and collections in the file tree; the row menu opens them in the Browser
 * column instead.
 */
export function useRepositoryFileOpen(): {
  openRepositoryFile: (path: string, scopePath: string) => void;
  openRepositoryFileInBrowser: (path: string, scopePath: string) => void;
} {
  const { t } = useI18n();
  const open = useCallback((path: string, scopePath: string, index: RepositoryFileHost) => {
    void openWorkspaceSurface({
      index: index,
      target: { kind: 'external', path, scopePath, transitionId: null },
    }).catch((error) => {
      logger.warn('failed to open repository file', { error, path, index });
      toast.error(t('memo.fileTree.openFailed'));
    });
  }, [t]);
  return {
    openRepositoryFile: useCallback((path: string, scopePath: string) => {
      open(path, scopePath, 0);
    }, [open]),
    openRepositoryFileInBrowser: useCallback((path: string, scopePath: string) => {
      open(path, scopePath, 1);
    }, [open]),
  };
}
