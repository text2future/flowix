import type { AgentChunk, AgentTypeKey } from "@/types/agent";
import { agentClient } from "@features/agent/store/agent-client";
import type { ChatStore } from "@features/agent/store/chat-store";
import type { ThreadState } from "@features/agent/store/thread-runtime-state";
import { useAgentConversationStore } from "@features/agent/store/agent-conversation-store";

const REPLAY_PAGE_SIZE = 1000;
const AGENT_CHUNK_KINDS = new Set<AgentChunk["kind"]>([
  "stream_start",
  "text",
  "reasoning",
  "tool_call",
  "tool_result",
  "error",
  "usage",
  "stream_end",
  "session_resolved",
]);
const DISPLAY_CHUNK_KINDS = new Set<AgentChunk["kind"]>([
  "text",
  "reasoning",
  "tool_call",
  "tool_result",
  "error",
]);

function resetReplayState(state: ThreadState | undefined): ThreadState {
  return {
    messages: [],
    isLoading: false,
    activeRunId: null,
    runs: {},
    pendingAssistantId: null,
    pendingReasoningId: null,
    oldestSequence: null,
    hasMoreHistory: false,
    loadingMore: state?.loadingMore ?? false,
  };
}

function parseReplayChunk(normalizedJson: string): AgentChunk | null {
  try {
    const value = JSON.parse(normalizedJson) as AgentChunk;
    if (!value || typeof value !== "object") return null;
    if (!AGENT_CHUNK_KINDS.has(value.kind)) return null;
    return value;
  } catch (err) {
    console.warn("[AgentExternalReplay] skipped malformed event payload:", err);
    return null;
  }
}

function resetThreadsForReplay(
  set: (updater: (state: ChatStore) => Partial<ChatStore>) => void,
  threadIds: Iterable<string>,
  typeKey: AgentTypeKey,
): void {
  const ids = Array.from(new Set(Array.from(threadIds).filter(Boolean)));
  if (ids.length === 0) return;
  useAgentConversationStore.getState().resetMessageStates(ids);
  set((state) => {
    const threadStates = { ...state.threadStates };
    const threadTypes = { ...state.threadTypes };
    for (const id of ids) {
      threadStates[id] = resetReplayState(threadStates[id]);
      threadTypes[id] = threadTypes[id] ?? typeKey;
    }
    return { threadStates, threadTypes };
  });
}

export async function replayExternalEventsForThread(
  set: (updater: (state: ChatStore) => Partial<ChatStore>) => void,
  get: () => ChatStore,
  typeKey: AgentTypeKey,
  threadId: string,
): Promise<boolean> {
  let afterId: number | null = null;
  let replayedDisplay = false;
  const resetThreadIds = new Set<string>();
  resetThreadsForReplay(set, [threadId], typeKey);
  resetThreadIds.add(threadId);

  for (;;) {
    const events = await agentClient.externalEvents(
      threadId,
      afterId,
      REPLAY_PAGE_SIZE,
    );
    if (events.length === 0) break;

    const newThreadIds = events
      .map((event) => event.threadId)
      .filter((id) => !resetThreadIds.has(id));
    if (newThreadIds.length > 0) {
      resetThreadsForReplay(set, newThreadIds, typeKey);
      for (const id of newThreadIds) resetThreadIds.add(id);
    }

    for (const event of events) {
      const chunk = parseReplayChunk(event.normalizedJson);
      if (!chunk) continue;
      if (DISPLAY_CHUNK_KINDS.has(chunk.kind)) replayedDisplay = true;
      get().dispatchAgentChunk(chunk);
    }

    afterId = events[events.length - 1]?.id ?? afterId;
    if (events.length < REPLAY_PAGE_SIZE) break;
  }
  get().flushAgentEventBuffer();
  return replayedDisplay;
}
