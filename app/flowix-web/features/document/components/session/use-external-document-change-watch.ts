import { useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

import {
  hasDocumentUnsavedChanges,
  type DocumentIdentity,
} from '@features/document';
import { translate } from '@features/i18n';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { toast } from '@/lib/toast';
import { canonicalPath } from '@/lib/path';
import {
  windows,
  type ExternalDocumentChangedEvent,
} from '@platform/tauri/client';

interface UseExternalDocumentChangeWatchOptions {
  filePath: string;
  identity: DocumentIdentity;
  clearSaveTimer: () => void;
  reloadDocument: (path: string, options?: { preservePending?: boolean; showLoading?: boolean }) => Promise<void>;
}

// fs_watcher 单次外部写入可能发多次事件 (FSEvents 双触发 + 编辑器
// debounce save), cooldown 收敛冲突警告避免 toast 风暴。
const CONFLICT_WARNING_COOLDOWN_MS = 5000;

function debugDocumentSync(message: string, details: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  // eslint-disable-next-line no-console
  console.log(message, details);
}

export function useExternalDocumentChangeWatch({
  filePath,
  identity,
  clearSaveTimer,
  reloadDocument,
}: UseExternalDocumentChangeWatchOptions) {
  const lastConflictWarningAtRef = useRef(0);

  const maybeWarnAboutConflict = () => {
    if (!hasDocumentUnsavedChanges(identity)) return;
    if (Date.now() - lastConflictWarningAtRef.current < CONFLICT_WARNING_COOLDOWN_MS) return;
    lastConflictWarningAtRef.current = Date.now();
    const language = useUserSettingsStore.getState().settings.language;
    toast.warning(translate(language, 'document.external.changeWarning'), { duration: 5000 });
  };

  useEffect(() => {
    if (!filePath || identity.kind !== 'external') return;

    let disposed = false;
    let leaseId: string | null = null;
    let unlisten: (() => void) | null = null;
    const currentPath = canonicalPath(filePath);

    void (async () => {
      debugDocumentSync('[external-document-watch] registering', {
        path: currentPath,
        windowLabel: getCurrentWindow().label,
      });
      unlisten = await getCurrentWindow().listen<ExternalDocumentChangedEvent>(
        'external-document-changed',
        async ({ payload }) => {
          debugDocumentSync('[external-document-changed] received', {
            path: payload.path,
            kind: payload.kind,
            revision: payload.revision,
            currentPath,
          });
          if (disposed || canonicalPath(payload.path) !== currentPath) return;
          if (hasDocumentUnsavedChanges(identity)) {
            maybeWarnAboutConflict();
            return;
          }
          if (payload.kind === 'deleted') {
            const language = useUserSettingsStore.getState().settings.language;
            toast.warning(translate(language, 'document.external.changeWarning'), { duration: 5000 });
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
      leaseId = await windows.watchExternalDocument(filePath);
      debugDocumentSync('[external-document-watch] registered', {
        path: currentPath,
        leaseId,
        windowLabel: getCurrentWindow().label,
      });
      if (disposed && leaseId) {
        void windows.unwatchExternalDocument(leaseId);
        leaseId = null;
      }
    })().catch((error) => {
      if (!disposed) console.warn('[external-document-changed] watch failed:', error);
    });

    return () => {
      disposed = true;
      unlisten?.();
      if (leaseId) void windows.unwatchExternalDocument(leaseId);
    };
  }, [filePath, identity, clearSaveTimer, reloadDocument]);
}
