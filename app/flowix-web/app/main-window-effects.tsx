'use client';

import { useEffect } from "react";
import { subscribe } from '@platform/tauri/event-bus';
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useI18n } from "@/lib/i18n";
import { subscribeAppActiveAgentConversation } from "@features/document/public/app-api";
import {
  applyAppMemoCreated,
  applyAppMemoDeleted,
  applyAppMemoUpdated,
  applyAppTagsDeleted,
  applyAppTagsRenamed,
  getAppSelectedNotebookId,
  getAppNotebookPath,
  refreshAppDerivedMetadata,
  refreshAppPathNoteMetadata,
  refreshAppTodoCount,
} from "@features/memo/public/app-api";
import { invalidateMentionNotes } from "@features/editor/extensions/note-mention";
import {
  invalidateMentionTags,
  setNotebookIdProvider,
} from "@features/editor/extensions/tag-mention";
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
import { resumePendingNoteLinkUpdates } from '@features/memo/public/app-api';
import { subscribeWorkspaceDocumentSaves } from '@features/document/public/workspace-api';
import {
  syncAppAgentConversationRestore,
  openBrowserColumnNotebookNote,
  removeBrowserColumnTabsByPath,
  applyNotebookPathMove,
} from '@features/workspace/public/app-api';

const logger = createLogger('main-window-effects');

export function MainWindowEffects() {
  const { t } = useI18n();
  const mainWindowTitle = t("window.main.title");

  useEffect(() => {
    resumePendingNoteLinkUpdates();
    return subscribeWorkspaceDocumentSaves(resumePendingNoteLinkUpdates);
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
    void initializeMainWindowStartup()
      .catch((error) => {
        logger.warn('restore workspace failed', { error });
      });
  }, []);

  useEffect(() => {
    document.title = mainWindowTitle;
    void getCurrentWindow().setTitle(mainWindowTitle).catch(() => {
      // Browser preview or unavailable Tauri window API.
    });
  }, [mainWindowTitle]);

  useEffect(() => {
    let moveChain = Promise.resolve();
    let disposed = false;
    const unsubscribe = subscribe<{ notebookId: string; relativePath: string; previousRelativePath?: string; directory?: boolean; deleted?: boolean }>(
      'flowix:path-note-changed',
      ({ notebookId, relativePath, previousRelativePath, directory, deleted }) => {
        invalidateMentionNotes();
        invalidateMentionTags();
        refreshAppPathNoteMetadata(notebookId);
        if (previousRelativePath && relativePath && !deleted) {
          moveChain = moveChain.then(async () => {
            const notebookPath = await getAppNotebookPath(notebookId);
            if (!disposed && notebookPath) applyNotebookPathMove({
              notebookId, notebookPath, previousRelativePath, relativePath,
              directory: directory === true,
            });
          }).catch((error) => logger.warn('rebase moved note path failed', { error, notebookId, relativePath }));
        }
        if (deleted && relativePath) {
          void getAppNotebookPath(notebookId).then((notebookPath) => {
            const path = notebookPath && joinNotebookMemoPath(notebookPath, relativePath);
            if (path) removeBrowserColumnTabsByPath(path);
          }).catch((error) => logger.warn('resolve deleted note path failed', { error, notebookId, relativePath }));
        }
      },
    );
    return () => { disposed = true; unsubscribe(); };
  }, []);

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
          openPathInBrowserColumn: async (notebookId, relativePath) => {
            const notebookPath = await getAppNotebookPath(notebookId);
            const path = notebookPath && joinNotebookMemoPath(notebookPath, relativePath);
            if (!path) throw new Error('Created note path is unavailable');
            await openBrowserColumnNotebookNote(path, notebookId, notebookPath);
          },
          reportOpenFailure: (error) => {
            logger.warn('open created note in browser column failed', { error });
            toast.error(error instanceof Error ? error.message : String(error));
          },
          handleMemoCreated: applyAppMemoCreated,
          handleMemoUpdated: applyAppMemoUpdated,
          handleMemoDeleted: applyAppMemoDeleted,
          removeBrowserColumnTabsByPath: (path) => removeBrowserColumnTabsByPath(path),
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

  useEffect(() => {
    void mountOpenTargetListener();
    return () => {
      unmountOpenTargetListener();
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
