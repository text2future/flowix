/**
 * Test-only legacy-shape facade over the canonical AgentSessionStore.
 *
 * A few large behavior suites were originally authored against the flattened
 * chat/conversation stores. Keeping their assertions while routing every read
 * and write through this adapter lets those suites remain useful during the
 * final re-root without shipping a second production store or mirror.
 */
import {
  acquireAgentChunkBridge,
  DEFAULT_AGENT_SESSION_META,
  useAgentSessionStore,
  type AgentSessionMeta,
  type AgentSessionStore,
} from "@features/agent/store/agent-session-store";
import { emptyProjection, type ThreadProjection } from "@features/agent/store/session-reducer";
import type { ThreadState } from "@features/agent/store/thread-runtime-state";
import type { AgentConversationMessageState } from "@features/agent/store/agent-conversation-types";

function toThreadState(projection: ThreadProjection): ThreadState {
  return {
    messages: projection.messages,
    isLoading: projection.runs.isLoading,
    activeRunId: projection.runs.activeRunId,
    runs: projection.runs.runs,
    dshCommand: projection.runs.dshCommand,
    codexCommand: projection.runs.codexCommand,
    pendingAssistantId: projection.pending.assistantId,
    pendingReasoningId: projection.pending.reasoningId,
    lastRun: projection.runs.lastRun,
    oldestSequence: projection.pagination.oldestSequence,
    hasMoreHistory: projection.pagination.hasMoreHistory,
    loadingMore: projection.pagination.loadingMore,
  };
}

function fromThreadState(
  state: ThreadState,
  previous: ThreadProjection | undefined,
): ThreadProjection {
  return {
    messages: state.messages,
    pending: {
      assistantId: state.pendingAssistantId,
      reasoningId: state.pendingReasoningId,
    },
    pagination: {
      oldestSequence: state.oldestSequence,
      hasMoreHistory: state.hasMoreHistory,
      loadingInitial: previous?.pagination.loadingInitial ?? false,
      loadingMore: state.loadingMore,
    },
    runs: {
      isLoading: state.isLoading,
      activeRunId: state.activeRunId,
      runs: state.runs,
      lastRun: state.lastRun,
      dshCommand: state.dshCommand,
      codexCommand: state.codexCommand,
    },
  };
}

function toMessageState(projection: ThreadProjection): AgentConversationMessageState {
  return {
    messages: projection.messages,
    pendingAssistantId: projection.pending.assistantId,
    pendingReasoningId: projection.pending.reasoningId,
    oldestSequence: projection.pagination.oldestSequence,
    hasMoreHistory: projection.pagination.hasMoreHistory,
    loadingInitial: projection.pagination.loadingInitial,
    loadingMore: projection.pagination.loadingMore,
  };
}

type LegacyChatState = AgentSessionStore &
  AgentSessionMeta &
  AgentSessionMeta["settings"] & {
    threadStates: Record<string, ThreadState>;
  };

type LegacyConversationState = AgentSessionStore & {
  instances: AgentSessionStore["conversationRegistry"]["instances"];
  messageStates: Record<string, AgentConversationMessageState>;
};

function legacyChatState(): LegacyChatState {
  const state = useAgentSessionStore.getState();
  return {
    ...state,
    ...state.sessionMeta,
    ...state.sessionMeta.settings,
    threadStates: Object.fromEntries(
      Object.entries(state.threadProjections).map(([id, projection]) => [
        id,
        toThreadState(projection),
      ]),
    ),
  } as LegacyChatState;
}

function applyLegacyChatPatch(
  patch: Partial<LegacyChatState>,
  replace = false,
): void {
  if (replace) {
    useAgentSessionStore.setState({
      sessionMeta: DEFAULT_AGENT_SESSION_META,
      conversationRegistry: { instances: {} },
      threadProjections: {},
    });
  }
  if (!patch || typeof patch !== "object") return;
  if (patch.threadStates) {
    const previous = useAgentSessionStore.getState().threadProjections;
    const threadProjections = Object.fromEntries(
      Object.entries(patch.threadStates as Record<string, ThreadState>).map(
        ([id, threadState]) => [id, fromThreadState(threadState, previous[id])],
      ),
    );
    useAgentSessionStore.setState({ threadProjections });
  }
  const hasMeta =
    patch.activeThreadIds !== undefined ||
    patch.activeAgentTypeKey !== undefined ||
    patch.threadTypes !== undefined ||
    patch.threadLists !== undefined ||
    patch.currentThreadTitles !== undefined ||
    patch.externalSessionResolutions !== undefined ||
    patch.lastRunningRunsReconciledAt !== undefined;
  const hasSettings =
    patch.agentPermissionMode !== undefined ||
    patch.agentCodexModel !== undefined ||
    patch.agentCodexReasoningEffort !== undefined;
  if (hasMeta || hasSettings) {
    useAgentSessionStore.getState().setSessionMeta((meta) => ({
      ...meta,
      ...(patch.activeThreadIds !== undefined
        ? { activeThreadIds: patch.activeThreadIds }
        : {}),
      ...(patch.activeAgentTypeKey !== undefined
        ? { activeAgentTypeKey: patch.activeAgentTypeKey }
        : {}),
      ...(patch.threadTypes !== undefined ? { threadTypes: patch.threadTypes } : {}),
      ...(patch.threadLists !== undefined ? { threadLists: patch.threadLists } : {}),
      ...(patch.currentThreadTitles !== undefined
        ? { currentThreadTitles: patch.currentThreadTitles }
        : {}),
      ...(patch.externalSessionResolutions !== undefined
        ? { externalSessionResolutions: patch.externalSessionResolutions }
        : {}),
      ...(patch.lastRunningRunsReconciledAt !== undefined
        ? { lastRunningRunsReconciledAt: patch.lastRunningRunsReconciledAt }
        : {}),
      settings: {
        ...meta.settings,
        ...(patch.agentPermissionMode !== undefined
          ? { agentPermissionMode: patch.agentPermissionMode }
          : {}),
        ...(patch.agentCodexModel !== undefined
          ? { agentCodexModel: patch.agentCodexModel }
          : {}),
        ...(patch.agentCodexReasoningEffort !== undefined
          ? { agentCodexReasoningEffort: patch.agentCodexReasoningEffort }
          : {}),
      },
    }));
  }
}

export const useChatStore = {
  getState: legacyChatState,
  getInitialState: legacyChatState,
  setState(
    update:
      | Partial<LegacyChatState>
      | ((state: LegacyChatState) => Partial<LegacyChatState>),
    replace = false,
  ): void {
    const patch = typeof update === "function" ? update(legacyChatState()) : update;
    applyLegacyChatPatch(patch, replace);
  },
};

function legacyConversationState(): LegacyConversationState {
  const state = useAgentSessionStore.getState();
  return {
    ...state,
    instances: state.conversationRegistry.instances,
    messageStates: Object.fromEntries(
      Object.entries(state.threadProjections).map(([id, projection]) => [
        id,
        toMessageState(projection),
      ]),
    ),
  } as LegacyConversationState;
}

export const useAgentConversationStore = {
  getState: legacyConversationState,
  getInitialState: legacyConversationState,
  setState(
    update:
      | Partial<LegacyConversationState>
      | ((state: LegacyConversationState) => Partial<LegacyConversationState>),
    replace = false,
  ): void {
    const patch =
      typeof update === "function" ? update(legacyConversationState()) : update;
    if (replace) {
      useAgentSessionStore.setState({
        conversationRegistry: { instances: {} },
        threadProjections: {},
      });
    }
    if (patch?.instances) {
      useAgentSessionStore.setState({
        conversationRegistry: { instances: patch.instances },
      });
    }
    if (patch?.messageStates) {
      const current = useAgentSessionStore.getState().threadProjections;
      const threadProjections = { ...current };
      for (const [id, messageState] of Object.entries(
        patch.messageStates as Record<string, AgentConversationMessageState>,
      )) {
        const previous = current[id] ?? emptyProjection();
        threadProjections[id] = {
          ...previous,
          messages: messageState.messages,
          pending: {
            assistantId: messageState.pendingAssistantId,
            reasoningId: messageState.pendingReasoningId,
          },
          pagination: {
            oldestSequence: messageState.oldestSequence,
            hasMoreHistory: messageState.hasMoreHistory,
            loadingInitial: messageState.loadingInitial,
            loadingMore: messageState.loadingMore,
          },
        };
      }
      useAgentSessionStore.setState({ threadProjections });
    }
  },
};

export function selectRunningAgentConversationThreadIds(
  state: { instances: Record<string, { threadId: string | null }> },
  threadStates: Record<string, ThreadState>,
): string[] {
  return Array.from(
    new Set(
      Object.values(state.instances)
        .map((instance) => instance.threadId)
        .filter(
          (threadId): threadId is string =>
            !!threadId &&
            !!threadStates[threadId]?.isLoading &&
            !!threadStates[threadId]?.activeRunId,
        ),
    ),
  );
}

export { acquireAgentChunkBridge };
export type { ThreadState } from "@features/agent/store/thread-runtime-state";
export type {
  AgentConversationInstance,
  AgentConversationMessageState,
  AgentConversationRole,
  AgentConversationSource,
  CreateAgentConversationInstanceInput,
} from "@features/agent/store/agent-conversation-types";
