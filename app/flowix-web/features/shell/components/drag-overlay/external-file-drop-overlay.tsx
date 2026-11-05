import { useCallback } from 'react';
import { createPortal } from 'react-dom';

import { toast } from '@/lib/toast';
import { useExternalFileDrop } from '@features/document/public/shell-api';
import { errorMessage } from '@/lib/error-message';
import { createLogger } from '@/lib/logger';
import { requestExternalDocumentOpen } from '@platform/open-target/types';
import { FullscreenDragOverlay } from './fullscreen-drag-overlay';

const logger = createLogger('external-file-drop-overlay');

export function ExternalFileDropOverlay() {
  const handleDropError = useCallback((error: unknown) => {
    logger.warn('failed to open dropped file', { error });
    toast.error(errorMessage(error));
  }, []);
  const handleDropPaths = useCallback((paths: string[], destination?: 0 | 1) => {
    requestExternalDocumentOpen({ filePaths: paths, source: 'drop', destination });
  }, []);
  const { isDraggingFile, draggingDestination } = useExternalFileDrop({
    onDropPaths: handleDropPaths,
    onDropError: handleDropError,
  });

  // Keep one visual overlay across Work and Browser while hit testing stays per host.
  const host = draggingDestination !== null
    ? document.querySelector<HTMLElement>('[data-workspace-drop-overlay-host]')
    : null;
  return host ? createPortal(<FullscreenDragOverlay visible={isDraggingFile} />, host) : null;
}
