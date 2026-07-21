import type { AgentTypeKey } from "@/types/agent";
import { getAgentType } from "@/lib/agent-types";
import { listHistoryThreads } from "@features/agent/store/thread-history";
import { defaultThreadTitle } from "@features/agent/store/thread-titles";
import {
  activeThreadUpdate,
  threadListUpdate,
  titleUpdate,
  getThreadListForType,
  type AgentTypeMap,
} from "@features/agent/store/chat-thread-accessors";
import type { ThreadState, ThreadsMap } from "@features/agent/store/thread-runtime-state";
import type { ChatStore } from "@features/agent/store/chat-store";
import { findHistoryThreadInfo } from "@features/agent/store/thread-history";
import { replayExternalEventsForThread } from "@features/agent/store/external-event-replay";

/**
 * 加载 thread 历史 (messages + title) ── loadThread / loadCodexThread 等
 * 共享的内部逻辑。 调用 conversationStore.loadMessages 拉消息 + 拉
 * threadInfo (含 title) → 写 threadStates / activeThreadIds / title。
 */
export async function loadThreadForType(
  set: (updater: (state: ChatStore) => Partial<ChatStore>) => void,
  get: () => ChatStore,
  typeKey: AgentTypeKey,
  threadId: string,
): Promise<void> {
  const type = getAgentType(typeKey);
  try {
    const { useAgentConversationStore } = await import(
      "@features/agent/store/agent-conversation-store"
    );
    const threadInfo = await findHistoryThreadInfo(
      type.key,
      threadId,
      getThreadListForType(get(), type.key),
    );
    set((state) => {
      const existing = state.threadStates[threadId] ?? emptyThreadState();
      return {
        ...activeThreadUpdate(state, type.key, threadId),
        threadTypes: {
          ...state.threadTypes,
          [threadId]: state.threadTypes[threadId] ?? type.key,
        },
        threadStates: {
          ...state.threadStates,
          [threadId]: {
            ...existing,
            pendingAssistantId: null,
            pendingReasoningId: null,
          },
        },
        ...titleUpdate(
          state,
          type.key,
          threadInfo?.title ?? defaultThreadTitle(type.key),
        ),
      };
    });
    if (type.key !== "flowix") {
      const replayedDisplay = await replayExternalEventsForThread(
        set,
        get,
        type.key,
        threadId,
      );
      if (!replayedDisplay) {
        await useAgentConversationStore.getState().loadMessages(type.key, threadId);
      }
      return;
    }
    await useAgentConversationStore.getState().loadMessages(type.key, threadId);
  } catch (err) {
    console.error(`Failed to load ${type.name} thread:`, err);
  }
}

/**
 * 加载某 agent 的 thread 列表 ── 所有 loadThread*List 共用的实现。
 */
export async function loadThreadListForType(
  set: (updater: (state: ChatStore) => Partial<ChatStore>) => void,
  typeKey: AgentTypeKey,
  errorLabel: string,
): Promise<void> {
  const type = getAgentType(typeKey);
  try {
    const threads = await listHistoryThreads(type.key);
    set((state) => threadListUpdate(state, type.key, threads));
  } catch (err) {
    console.error(`Failed to load ${errorLabel} thread list:`, err);
  }
}

/**
 * 加载 external / custom agent 的 thread 列表 ── 在 loadLocalAgentThreadList
 * 路径上, flowix / codex / claude / hermes 这四个有专属 action 不走这里,
 * 仅 gemini / openclaw 等 fall through。
 */
export async function loadLocalAgentThreadList(
  set: (updater: (state: ChatStore) => Partial<ChatStore>) => void,
  typeKey: AgentTypeKey,
): Promise<void> {
  const type = getAgentType(typeKey);
  if (
    type.key === "flowix" ||
    type.key === "codex" ||
    type.key === "claude" ||
    type.key === "hermes"
  ) {
    return;
  }
  try {
    const threads = await listHistoryThreads(type.key);
    set((state) => threadListUpdate(state, type.key, threads));
  } catch (err) {
    console.error(`Failed to load ${type.name} thread list:`, err);
  }
}

/**
 * emptyThreadState 的本地小写版 ── 跟 thread-runtime-state.ts 同形, 但
 * 保持模块独立, 不反向依赖 (避免 chat-store → load-thread-actions →
 * thread-runtime-state 同时被 chat-store 直接 import 的循环)。
 */
function emptyThreadState(): ThreadState {
  return {
    messages: [],
    isLoading: false,
    activeRunId: null,
    runs: {},
    pendingAssistantId: null,
    pendingReasoningId: null,
    oldestSequence: null,
    hasMoreHistory: false,
    loadingMore: false,
  };
}

/**
 * 构造一组 load* actions ── 每个 action 接受 (set, get) 由 chat-store
 * factory 注入。 这样 chat-store 只需薄薄一层 wrapper, 不必把 store closure
 * 散布到本模块。
 */
export function createLoadThreadActions(
  set: (updater: (state: ChatStore) => Partial<ChatStore>) => void,
  get: () => ChatStore,
): {
  loadThreadList: () => Promise<void>;
  loadThread: (threadId: string) => Promise<void>;
  loadCodexThreadList: () => Promise<void>;
  loadCodexThread: (threadId: string) => Promise<void>;
  loadClaudeThreadList: () => Promise<void>;
  loadClaudeThread: (threadId: string) => Promise<void>;
  loadHermesThreadList: () => Promise<void>;
  loadHermesThread: (threadId: string) => Promise<void>;
  loadAgentThread: (typeKey: AgentTypeKey, threadId: string) => Promise<void>;
  loadLocalAgentThreadList: (typeKey: AgentTypeKey) => Promise<void>;
} {
  return {
    loadThreadList: () => loadThreadListForType(set, "flowix", "thread"),
    loadThread: (threadId) => loadThreadForType(set, get, "flowix", threadId),
    loadCodexThreadList: () => loadThreadListForType(set, "codex", "Codex"),
    loadCodexThread: (threadId) => loadThreadForType(set, get, "codex", threadId),
    loadClaudeThreadList: () => loadThreadListForType(set, "claude", "Claude Code"),
    loadClaudeThread: (threadId) =>
      loadThreadForType(set, get, "claude", threadId),
    loadHermesThreadList: () => loadThreadListForType(set, "hermes", "Hermes"),
    loadHermesThread: (threadId) =>
      loadThreadForType(set, get, "hermes", threadId),
    loadAgentThread: async (typeKey, threadId) => {
      const type = getAgentType(typeKey);
      return loadThreadForType(set, get, type.key, threadId);
    },
    loadLocalAgentThreadList: async (typeKey) => {
      return loadLocalAgentThreadList(set, typeKey);
    },
  };
}

// 显式 re-export ── createLoadThreadActions 的接受参数只导出 set / get 类型推断需要。
export type { ThreadsMap, AgentTypeMap };
