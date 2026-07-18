'use client';

import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useI18n } from "@features/i18n";
import { windows } from "@platform/tauri/client";
import { useDocumentStore } from "@features/document/store/document-store";
import { useMemoStore } from "@features/memo/store/memo-store";
import { useTagStore } from "@features/memo/store/tag-store";
import { useTodoCountStore } from "@features/memo/store/todo-count-store";
import { invalidateMentionNotes } from "@features/editor/extensions/note-mention";
import { invalidateMentionTags } from "@features/editor/extensions/tag-mention";
import { toast } from "@/lib/toast";
import { handleMainWindowMemoEvent } from "./main-window-memo-event-handler";
import type { MemoEvent } from "@/types/memo";
import {
  mountOpenTargetListener,
  unmountOpenTargetListener,
} from "@platform/open-target";

export function MainWindowEffects() {
  const { t } = useI18n();
  const mainWindowTitle = t("window.main.title");

  useEffect(() => {
    document.title = mainWindowTitle;
    void getCurrentWindow().setTitle(mainWindowTitle).catch(() => {
      // Browser preview or unavailable Tauri window API.
    });
  }, [mainWindowTitle]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let disposed = false;

    void import("@/lib/memo-dispatcher").then(({ registerMemoEventHandler }) => {
      if (disposed) return;
      unsubscribe = registerMemoEventHandler((event) => {
        handleMainWindowMemoEvent(event, {
          getSelectedNotebookId: () => useMemoStore.getState().selectedNotebook?.id ?? null,
          invalidateMentionCaches: () => {
            invalidateMentionNotes();
            invalidateMentionTags();
          },
          openNoteTab: windows.openNoteTab,
          reportOpenFailure: (error) => {
            console.warn("[MainWindowEffects] open created note window failed", error);
            toast.error(error instanceof Error ? error.message : String(error));
          },
          handleMemoCreated: (memo) => useMemoStore.getState().handleMemoCreated(memo),
          handleMemoUpdated: (memo) => useMemoStore.getState().handleMemoUpdated(memo),
          handleMemoDeleted: (memoId) => useMemoStore.getState().handleMemoDeleted(memoId),
          replaceActiveMemoPath: (memoId, path) => {
            useDocumentStore.getState().replaceActiveMemoPath(memoId, path);
          },
          refreshSelectedNotebookMetadata,
          refreshBackgroundTodoCount: (notebookId) => {
            void useTodoCountStore.getState().loadTodoCount(notebookId);
          },
        });
      });
    });

    return () => {
      disposed = true;
      unsubscribe?.();
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
  const { notebookId, derivedChanged } = event;
  if (derivedChanged.tags || derivedChanged.agents || derivedChanged.todos) {
    void useTagStore.getState().loadTags(notebookId);
    useTagStore.getState().triggerMetadataRefresh();
  }
  if (derivedChanged.todos) {
    void useTodoCountStore.getState().loadTodoCount(notebookId);
  }
}
