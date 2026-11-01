import { useCallback } from 'react';

import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { product } from '@platform/tauri/client';

const logger = createLogger('use-media-actions');

type MediaTarget = { filePath: string; notebookPath: string | null };

/**
 * Titlebar actions for media surfaces: copy the file path, reveal the file in
 * the OS file manager, and request deletion through the window-level event
 * that the external file deletion hook listens for.
 */
export function useMediaActions(mediaTarget: MediaTarget | null) {
  const { t } = useI18n();

  const handleCopyMediaLink = useCallback(async () => {
    if (!mediaTarget) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(mediaTarget.filePath);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = mediaTarget.filePath;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        textarea.style.pointerEvents = 'none';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      toast.success(t('document.command.copySuccess'));
    } catch (error) {
      logger.warn('[MainLayout] Failed to copy media link:', { error: error });
      toast.error(t('document.command.copyFailed'));
    }
  }, [mediaTarget, t]);

  const handleRevealMedia = useCallback(() => {
    if (!mediaTarget) return;
    void product.revealInFileManager(mediaTarget.filePath).catch((error) => {
      logger.warn('[MainLayout] Failed to reveal media in file manager:', { error: error });
      toast.error(t('memo.fileTree.openFailed'));
    });
  }, [mediaTarget, t]);

  const handleRequestDeleteMedia = useCallback(() => {
    if (!mediaTarget?.notebookPath) return;
    window.dispatchEvent(new CustomEvent('flowix:request-delete-media', {
      detail: {
        filePath: mediaTarget.filePath,
        notebookPath: mediaTarget.notebookPath,
      },
    }));
  }, [mediaTarget]);

  return { handleCopyMediaLink, handleRevealMedia, handleRequestDeleteMedia };
}
