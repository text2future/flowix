import { useCallback } from 'react';

import { toast } from '@/lib/toast';
import { markdownPaths as filterMarkdownPaths, useMarkdownFileDrop } from '@features/document/components/use-markdown-file-drop';
import { windows } from '@platform/tauri/client';
import { useI18n } from '@features/i18n';
import { errorMessage } from '@/lib/error-message';
import { FullscreenDragOverlay } from './fullscreen-drag-overlay';

export function MarkdownFileDropOverlay() {
  const { t } = useI18n();
  const openMarkdownPath = useCallback((path: string) => windows.openMarkdownPathTab(path), []);
  const handleDropError = useCallback((error: unknown) => {
    console.warn('[MarkdownFileDropOverlay] Failed to open dropped Markdown:', error);
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
