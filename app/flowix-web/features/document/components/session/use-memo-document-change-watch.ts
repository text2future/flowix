import { useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

import {
  hasDocumentUnsavedChanges,
  isRecentSelfDocumentWrite,
  type DocumentIdentity,
} from '@features/document';
import { translate } from '@features/i18n';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { toast } from '@/lib/toast';
import { canonicalPath } from '@/lib/path';
import { registerMemoEventHandler } from '@/lib/memo-dispatcher';
import type { MemoEvent } from '@/types/memo';
import {
  handleSiblingWindowContentUpdate,
  type MemoContentUpdatedEvent,
} from './sibling-window-document-sync';

interface Options {
  filePath: string;
  identity: DocumentIdentity;
  clearSaveTimer: () => void;
  reloadDocument: (path: string, options?: { preservePending?: boolean; showLoading?: boolean }) => Promise<void>;
}

const CONFLICT_WARNING_COOLDOWN_MS = 5000;

export function useMemoDocumentChangeWatch({
  filePath,
  identity,
  clearSaveTimer,
  reloadDocument,
}: Options) {
  const lastConflictWarningAtRef = useRef(0);

  useEffect(() => {
    if (!filePath || identity.kind !== 'memo') return;
    const warnAboutConflict = () => {
      if (!hasDocumentUnsavedChanges(identity)) return;
      if (Date.now() - lastConflictWarningAtRef.current < CONFLICT_WARNING_COOLDOWN_MS) return;
      lastConflictWarningAtRef.current = Date.now();
      const language = useUserSettingsStore.getState().settings.language;
      toast.warning(translate(language, 'document.external.changeWarning'), { duration: 5000 });
    };

    const unsubscribeMemoEvents = registerMemoEventHandler(
      async (event: MemoEvent) => {
        if (event.kind !== 'updated' || event.source === 'user_edit' || !event.path) return;
        const updatedPath = canonicalPath(event.path);
        if (updatedPath !== canonicalPath(filePath)) return;
        if (isRecentSelfDocumentWrite(event.id, updatedPath)) return;
        if (hasDocumentUnsavedChanges(identity)) {
          warnAboutConflict();
          return;
        }
        clearSaveTimer();
        await reloadDocument(filePath, { preservePending: false, showLoading: false });
      },
      (event) => event.kind === 'updated' && event.source !== 'user_edit',
    );

    let disposed = false;
    let unsubscribeContentUpdates: (() => void) | null = null;
    void getCurrentWindow().listen<MemoContentUpdatedEvent>(
      'memo-content-updated',
      async ({ payload: event }) => {
        if (disposed) return;
        await handleSiblingWindowContentUpdate({
          event,
          identity,
          isDirty: hasDocumentUnsavedChanges(identity),
          onConflict: warnAboutConflict,
          clearSaveTimer,
          reloadDocument,
        });
      },
    ).then((unlisten) => {
      if (disposed) unlisten();
      else unsubscribeContentUpdates = unlisten;
    }).catch((error) => {
      console.warn('[memo-content-updated] listen failed:', error);
    });

    return () => {
      disposed = true;
      unsubscribeMemoEvents();
      unsubscribeContentUpdates?.();
    };
  }, [filePath, identity, clearSaveTimer, reloadDocument]);
}
