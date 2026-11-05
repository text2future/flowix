'use client';

import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useI18n } from "@/lib/i18n";
import { subscribeAppActiveAgentConversation } from "@features/document/public/app-api";
import {
  mountNotebookBackgroundUpdates,
  mountMemoListRefreshService,
  applyAppMemoCreated,
  applyAppMemoDeleted,
  applyAppMemoUpdated,
  applyAppTagsDeleted,
  applyAppTagsRenamed,
  getAppSelectedNotebookId,
  getAppNotebookPath,
  refreshAppDerivedMetadata,
  refreshAppTodoCount,
} from "@features/memo/public/app-api";
// Data modules only: the extension barrels also export TipTap Node views,
// which pulled ProseMirror into the desktop startup graph.
import { invalidateMentionNotes } from "@features/editor/extensions/note-mention/note-mention-data";
import {
  invalidateMentionTags,
  setNotebookIdProvider,
} from "@features/editor/extensions/tag-mention/tag-mention-data";
import { toast } from "@/lib/toast";
import { handleMainWindowMemoEvent } from "./main-window-memo-event-handler";
import type { MemoEvent } from "@/types/memo";
import {
  mountOpenTargetListener,
  unmountOpenTargetListener,
} from "@features/memo/public/app-api";
import { initializeMainWindowStartup } from './main-window-startup';
import { createLogger } from '@/lib/logger';
import { joinNotebookMemoPath } from '@/lib/path';
import { acceptWorkspaceDocumentLinkSave } from '@features/memo/public/app-api';
import { subscribeWorkspaceDocumentSaves } from '@features/document/public/workspace-api';
import {
  syncAppAgentConversationRestore,
  removeBrowserColumnContentByPath,
} from '@features/workspace/public/app-api';
import { clearWorkspaceTargetForDeletedFile } from '@features/workspace/public/shell-api';
import {
  dismissNavigationFailure,
  retryLastNavigation,
  useWorkspaceNavigationFailure,
} from '@features/workspace/public/main-window-api';
import {
  clearActionableNotice,
  upsertActionableNotice,
} from '@features/notifications/actionable-notice-store';
import { notifyCreatedDocument, removeCreatedDocumentNotices } from './created-document-notices';
import { mountMainWindowNotebookEvents } from './main-window-notebook-events';
import { mountMainWindowHeartbeat } from './main-window-heartbeat';

const logger = createLogger('main-window-effects');
const NAVIGATION_FAILURE_NOTICE_ID = 'workspace-navigation-failure';

export function MainWindowEffects() {
  const { t } = useI18n();
  const mainWindowTitle = t("window.main.title");
  const navigationFailure = useWorkspaceNavigationFailure();

  useEffect(() => {
    if (!navigationFailure) {
      clearActionableNotice(NAVIGATION_FAILURE_NOTICE_ID);
      return;
    }
    upsertActionableNotice({
      id: NAVIGATION_FAILURE_NOTICE_ID,
      priority: 100,
      tone: 'error',
      title: t('shell.navigation.failed'),
      message: navigationFailure.message,
      actions: [{ id: 'retry', label: t('error.retry'), run: retryLastNavigation }],
      dismissible: true,
      onDismiss: dismissNavigationFailure,
      revision: navigationFailure.requestId,
    });
  }, [navigationFailure, t]);

  useEffect(() => () => clearActionableNotice(NAVIGATION_FAILURE_NOTICE_ID), []);

  useEffect(() => mountNotebookBackgroundUpdates(), []);
  useEffect(() => mountMemoListRefreshService(), []);

  useEffect(() => {
    return subscribeWorkspaceDocumentSaves(acceptWorkspaceDocumentLinkSave);
  }, []);

  useEffect(() => {
    setNotebookIdProvider(
      getAppSelectedNotebookId,
    );
    return () => {
      setNotebookIdProvider(() => null);
    };
  }, []);

  useEffect(() => {
    return subscribeAppActiveAgentConversation(syncAppAgentConversationRestore);
  }, []);

  useEffect(() => {
    // The main window resolves notebook identity before document restoration.
    // Cards, folders, and conversations then own their view data independently.
    const startup = initializeMainWindowStartup();
    mountOpenTargetListener(startup);
    void startup.catch((error) => {
      logger.warn('restore workspace failed', { error });
    });
    return () => unmountOpenTargetListener();
  }, []);

  useEffect(() => {
    document.title = mainWindowTitle;
    void getCurrentWindow().setTitle(mainWindowTitle).catch(() => {
      // Browser preview or unavailable Tauri window API.
    });
  }, [mainWindowTitle]);

  useEffect(() => mountMainWindowNotebookEvents(), []);

  // Diagnostics only: the native side records a stalled renderer when a
  // visible, restored window stops reporting.
  useEffect(() => mountMainWindowHeartbeat(), []);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let unsubscribeDerived: (() => void) | undefined;
    let disposed = false;

    void import("@/lib/memo-dispatcher").then(({ registerMemoEventHandler, registerMemoDerivedRefreshHandler }) => {
      if (disposed) return;
      unsubscribeDerived = registerMemoDerivedRefreshHandler((event) => {
        invalidateMentionNotes();
        invalidateMentionTags();
        if (getAppSelectedNotebookId() === event.notebookId) {
          refreshAppDerivedMetadata(event);
        } else if (event.derivedChanged.todos) {
          refreshAppTodoCount(event.notebookId);
        }
      });
      unsubscribe = registerMemoEventHandler((event) => {
        handleMainWindowMemoEvent(event, {
          getSelectedNotebookId: getAppSelectedNotebookId,
          invalidateMentionCaches: () => {
            invalidateMentionNotes();
            invalidateMentionTags();
          },
          notifyCreatedNote: async (notebookId, relativePath) => {
            const notebookPath = await getAppNotebookPath(notebookId);
            const path = notebookPath && joinNotebookMemoPath(notebookPath, relativePath);
            if (!path || !notebookPath) throw new Error('Created note path is unavailable');
            notifyCreatedDocument(path, notebookPath, notebookId);
          },
          reportNotificationFailure: (error) => {
            logger.warn('queue created document notification failed', { error });
            toast.error(error instanceof Error ? error.message : String(error));
          },
          handleMemoCreated: applyAppMemoCreated,
          handleMemoUpdated: applyAppMemoUpdated,
          handleMemoDeleted: applyAppMemoDeleted,
          removeBrowserColumnContentByPath: (path) => {
            removeCreatedDocumentNotices(path);
            removeBrowserColumnContentByPath(path);
          },
          clearWorkspaceTargetByPath: (path) => {
            void clearWorkspaceTargetForDeletedFile(path).catch((error) =>
              logger.warn('clear deleted document target failed', { error, path }));
          },
          handleTagsRenamed: applyAppTagsRenamed,
          handleTagsDeleted: applyAppTagsDeleted,
          refreshSelectedNotebookMetadata,
          refreshBackgroundTodoCount: refreshAppTodoCount,
        });
      });
    });

    return () => {
      disposed = true;
      unsubscribe?.();
      unsubscribeDerived?.();
    };
  }, []);

  return null;
}

function refreshSelectedNotebookMetadata(event: MemoEvent): void {
  // tags_renamed / tags_deleted 不走这条路径 (handler 早返回了), 但函
  // 数类型是 MemoEvent 联合, 需要在这里收窄 ── 这两个 kind 没有
  // derivedChanged 字段。
  if (event.kind === 'tags_renamed' || event.kind === 'tags_deleted') return;
  refreshAppDerivedMetadata(event);
}
