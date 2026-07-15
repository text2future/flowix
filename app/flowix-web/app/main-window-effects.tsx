'use client';

import { useEffect } from "react";
import { useAgentEvents } from "@features/agent/hooks/use-agent-events";
import { listenToAgentAccessChanges } from "@platform/tauri/client";
import { useAgentAccessStore } from "@features/agent/store/agent-access-store";
import { useAgentRuntimeStore } from "@features/agent/store/agent-runtime-store";
import { useAgentConversationStore } from "@features/agent/store/agent-conversation-store";
import { prewarmNotebookCache, invalidateNotebookCache } from "@features/editor/extensions/note-link";
import { invalidateMentionNotes } from "@features/editor/extensions/note-mention";
import { invalidateMentionTags } from "@features/editor/extensions/tag-mention";
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
      unsubscribe = registerMemoEventHandler(() => {
        invalidateMentionNotes();
        invalidateMentionTags();
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
