import { captureLatestDocumentContent, reconcileUnsavedExternalDocumentChange } from '../../store/document-session-service';
import { useEffect } from 'react';
import { getCurrentWindow } from '@platform/tauri/window';

import { hasDocumentUnsavedChanges } from '@features/document/store/document-session-service';
import type { DocumentIdentity } from '@features/document/store/document-identity';
import { translate } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { toast } from '@/lib/toast';
import { canonicalPath } from '@/lib/path';
import { consumeExpectedExternalDocumentEvent } from '@features/document/store/external-document-operation';
import { createLogger } from '@/lib/logger';
import {
  windows,
  type ExternalDocumentChangedEvent,
} from '@platform/tauri/client';

interface UseExternalDocumentChangeWatchOptions {
  filePath: string;
  identity: DocumentIdentity;
  scopePath: string | null;
  clearSaveTimer: () => void;
  reloadDocument: (path: string, options?: { preservePending?: boolean; showLoading?: boolean }) => Promise<void>;
}

const logger = createLogger('external-document-watch');

export function useExternalDocumentChangeWatch({
  filePath,
  identity,
  scopePath,
  clearSaveTimer,
  reloadDocument,
}: UseExternalDocumentChangeWatchOptions) {
  useEffect(() => {
    if (!filePath) return;

    let disposed = false;
    let leaseId: string | null = null;
    let unlisten: (() => void) | null = null;
    const currentPath = canonicalPath(filePath);

    void (async () => {
      logger.debug('registering', {
        windowLabel: getCurrentWindow().label,
      });
      unlisten = await getCurrentWindow().listen<ExternalDocumentChangedEvent>(
        'external-document-changed',
        async ({ payload }) => {
          logger.debug('change received', {
            kind: payload.kind,
            revision: payload.revision,
            source: payload.source,
            originWindowLabel: payload.originWindowLabel,
            matchesCurrentDocument: canonicalPath(payload.path) === currentPath,
          });
          if (disposed || canonicalPath(payload.path) !== currentPath) return;
          if (payload.source === 'user_edit' && payload.originWindowLabel === getCurrentWindow().label) return;
          if (consumeExpectedExternalDocumentEvent(
            payload.path,
            payload.kind,
            payload.revision,
          )) return;
          captureLatestDocumentContent(identity);
          if (payload.kind === 'deleted') {
            const language = getCurrentAppLanguage();
            toast.warning(translate(language, 'document.external.changeWarning'), { duration: 5000 });
            return;
          }
          if (hasDocumentUnsavedChanges(identity)) {
            // The write boundary performs the shared diffy merge under the
            // cross-process file lock. A real overlap surfaces the conflict UI.
            await reconcileUnsavedExternalDocumentChange(identity, filePath, scopePath);
            return;
          }
          clearSaveTimer();
          await reloadDocument(filePath, { preservePending: false, showLoading: false });
        },
      );
      if (disposed) {
        unlisten();
        unlisten = null;
        return;
      }
      leaseId = await windows.watchExternalDocument(filePath, scopePath);
      logger.debug('registered', {
        leaseId,
        windowLabel: getCurrentWindow().label,
      });
      if (disposed && leaseId) {
        void windows.unwatchExternalDocument(leaseId);
        leaseId = null;
      }
    })().catch((error) => {
      if (!disposed) logger.warn('registration failed', { error });
    });

    return () => {
      disposed = true;
      unlisten?.();
      if (leaseId) void windows.unwatchExternalDocument(leaseId);
    };
  }, [filePath, identity, scopePath, clearSaveTimer, reloadDocument]);
}
