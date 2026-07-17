'use client';

import { useEffect } from "react";
import { useAgentEvents } from "@features/agent/hooks/use-agent-events";
import { listenToAgentAccessChanges, windows } from "@platform/tauri/client";
import { useAgentAccessStore } from "@features/agent/store/agent-access-store";
import { useAgentRuntimeStore } from "@features/agent/store/agent-runtime-store";
import { useAgentConversationStore } from "@features/agent/store/agent-conversation-store";
import { useDocumentStore } from "@features/document/store/document-store";
import { useMemoStore } from "@features/memo/store/memo-store";
import { useTagStore } from "@features/memo/store/tag-store";
import { useTodoCountStore } from "@features/memo/store/todo-count-store";
import { prewarmNotebookCache, invalidateNotebookCache } from "@features/editor/extensions/note-link";
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
  useAgentEvents();

  const refreshAgentRuntime = useAgentRuntimeStore((s) => s.refresh);
  useEffect(() => {
    void refreshAgentRuntime({ force: true });
  }, [refreshAgentRuntime]);

  const hydrateAgentConversations = useAgentConversationStore(
    (s) => s.hydrateFromBackend,
  );
  useEffect(() => {
    void hydrateAgentConversations();
  }, [hydrateAgentConversations]);

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
          openNoteWindow: windows.openNoteWindow,
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

  const loadAgentAccess = useAgentAccessStore((s) => s.loadInitial);
  useEffect(() => {
    void loadAgentAccess();
    return listenToAgentAccessChanges(() => {
      void loadAgentAccess();
      invalidateNotebookCache();
      invalidateMentionNotes();
      invalidateMentionTags();
      void prewarmNotebookCache();
    });
  }, [loadAgentAccess]);

  useEffect(() => {
    void prewarmNotebookCache();
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
