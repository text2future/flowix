'use client';

import { useEffect } from "react";
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
  refreshAppDerivedMetadata,
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
import {
  syncAppAgentConversationRestore,
  replaceActiveMemoPath,
  openBrowserColumnMemoById,
  removeBrowserColumnTabsByMemoId,
  replaceBrowserColumnMemoPath,
} from '@features/workspace/public/app-api';

const logger = createLogger('main-window-effects');

export function MainWindowEffects() {
  const { t } = useI18n();
  const mainWindowTitle = t("window.main.title");

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
    // The main window owns the critical library bootstrap. It resolves the
    // authoritative notebook and first memo query before document restoration,
    // so MemoList never has to race this work from a mount effect.
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
          openMemoInBrowserColumn: async (memoId) => {
            await openBrowserColumnMemoById(memoId);
          },
          reportOpenFailure: (error) => {
            logger.warn('open created note in browser column failed', { error });
            toast.error(error instanceof Error ? error.message : String(error));
          },
          handleMemoCreated: applyAppMemoCreated,
          handleMemoUpdated: applyAppMemoUpdated,
          handleMemoDeleted: applyAppMemoDeleted,
          removeBrowserColumnTabsByMemoId: (memoId) => removeBrowserColumnTabsByMemoId(memoId),
          handleTagsRenamed: applyAppTagsRenamed,
          handleTagsDeleted: applyAppTagsDeleted,
          replaceActiveMemoPath: (memoId, path) => {
            replaceActiveMemoPath(memoId, path);
          },
          replaceBrowserColumnMemoPath: (memoId, path) => {
            replaceBrowserColumnMemoPath(memoId, path);
          },
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
