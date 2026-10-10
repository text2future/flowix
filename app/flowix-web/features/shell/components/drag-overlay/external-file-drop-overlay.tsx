import { useCallback } from 'react';
import { createPortal } from 'react-dom';

import { toast } from '@/lib/toast';
import { useExternalFileDrop } from '@features/document/public/shell-api';
import { errorMessage } from '@/lib/error-message';
import { createLogger } from '@/lib/logger';
import { useShellSelectedNotebook } from '@features/memo/public/shell-api';
import {
  openBrowserColumnDroppedFile,
  openExternalTarget,
} from '@features/workspace/public/shell-api';
import { FullscreenDragOverlay } from './fullscreen-drag-overlay';

const logger = createLogger('external-file-drop-overlay');

export function ExternalFileDropOverlay() {
  const selectedNotebook = useShellSelectedNotebook();
  const handleDropError = useCallback((error: unknown) => {
    logger.warn('failed to open dropped file', { error });
    toast.error(errorMessage(error));
  }, []);
  const handleDropPaths = useCallback(async (paths: string[], destination?: 'main-third' | 'browser-column') => {
    if (paths.length === 0) return;
    for (const path of paths) {
      if (destination === 'browser-column') {
        await openBrowserColumnDroppedFile(path);
      } else {
        await openExternalTarget(path, {
          destination: 'main-third',
          scopePath: selectedNotebook?.path ?? null,
        });
      }
    }
  }, [selectedNotebook?.path]);
  const { isDraggingFile, draggingDestination } = useExternalFileDrop({
    onDropPaths: handleDropPaths,
    onDropError: handleDropError,
  });

  const host = draggingDestination
    ? document.querySelector<HTMLElement>(`[data-workspace-host="${draggingDestination}"]`)
    : null;
  return host ? createPortal(<FullscreenDragOverlay visible={isDraggingFile} />, host) : null;
}
