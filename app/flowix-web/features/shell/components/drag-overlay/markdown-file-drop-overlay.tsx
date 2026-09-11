import { useCallback } from 'react';

import { toast } from '@/lib/toast';
import {
  markdownPaths as filterMarkdownPaths,
  useMarkdownFileDrop,
} from '@features/document/public/shell-api';
import { openMarkdownInBrowserColumn } from '@features/workspace/public/browser-column-api';
import { useI18n } from '@/lib/i18n';
import { errorMessage } from '@/lib/error-message';
import { createLogger } from '@/lib/logger';
import { FullscreenDragOverlay } from './fullscreen-drag-overlay';

const logger = createLogger('markdown-file-drop-overlay');

export function MarkdownFileDropOverlay() {
  const { t } = useI18n();
  const openMarkdownPath = useCallback((path: string) => openMarkdownInBrowserColumn(path), []);
  const handleDropError = useCallback((error: unknown) => {
    logger.warn('failed to open dropped Markdown', { error });
    toast.error(errorMessage(error));
  }, []);
  const handleDropPaths = useCallback(async (paths: string[]) => {
    const markdownOnly = filterMarkdownPaths(paths);
    if (markdownOnly.length === 0) return;
    if (markdownOnly.length > 1) {
      toast.info(t('shell.dropOverlay.manyOpened', { count: markdownOnly.length }));
    }
    let previous: Promise<unknown> = Promise.resolve();
    for (const path of markdownOnly) {
      previous = previous.then(() => openMarkdownPath(path));
    }
    await previous;
  }, [openMarkdownPath, t]);
  const { isDraggingMarkdown } = useMarkdownFileDrop({
    onDropPaths: handleDropPaths,
    onDropError: handleDropError,
  });

  return <FullscreenDragOverlay visible={isDraggingMarkdown} />;
}
