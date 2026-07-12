import type { AgentChunk, ChatMessage } from '@/types/agent';
import type { AgentTypeKey } from '@/types/agent';
import type { ThreadState } from '@features/agent/store/chat-store';

export type ExternalSessionThreadStates = Record<string, ThreadState>;

export interface ExternalSessionStateInput {
  threadStates: ExternalSessionThreadStates;
  threadTypes: Record<string, AgentTypeKey>;
  externalSessionResolutions: Record<string, string>;
}

export interface ExternalSessionResolvedState {
  threadStates: ExternalSessionThreadStates;
  threadTypes: Record<string, AgentTypeKey>;
  externalSessionResolutions: Record<string, string>;
}

export function resolveExternalChunkThreadId(
  chunk: AgentChunk,
  resolutions: Record<string, string>
): string {
  if (chunk.kind === 'session_resolved') return chunk.thread_id;
  return resolutions[chunk.thread_id] ?? chunk.thread_id;
}

export function resolveExternalChunkAgentType(
  chunk: AgentChunk,
  sourceThreadId: string,
  targetThreadId: string,
  threadTypes: Record<string, AgentTypeKey>
): AgentTypeKey | undefined {
  return chunk.agent_type ?? threadTypes[sourceThreadId] ?? threadTypes[targetThreadId];
}

export function applyExternalSessionResolved(
  state: ExternalSessionStateInput,
  localThreadId: string,
  sessionId: string,
  agentType: AgentTypeKey,
  mergeMessages: (existing: ChatMessage[], incoming: ChatMessage[]) => ChatMessage[],
  emptyThreadState: () => ThreadState
): ExternalSessionResolvedState {
  const fromState = state.threadStates[localThreadId] ?? emptyThreadState();
  const toState = state.threadStates[sessionId] ?? emptyThreadState();
  const messages = fromState.messages.length > 0
    ? mergeMessages(toState.messages, fromState.messages)
    : toState.messages;

  return {
    threadTypes: {
      ...state.threadTypes,
      [localThreadId]: agentType,
      [sessionId]: agentType,
    },
    externalSessionResolutions: {
      ...state.externalSessionResolutions,
      [localThreadId]: sessionId,
    },
    threadStates: {
      ...state.threadStates,
      [sessionId]: {
        ...toState,
        messages,
        isLoading: toState.isLoading || fromState.isLoading,
        activeRunId: toState.activeRunId ?? fromState.activeRunId,
        runs: { ...toState.runs, ...fromState.runs },
        pendingAssistantId: toState.pendingAssistantId ?? fromState.pendingAssistantId,
        pendingReasoningId: toState.pendingReasoningId ?? fromState.pendingReasoningId,
        oldestSequence: toState.oldestSequence ?? fromState.oldestSequence,
        hasMoreHistory: toState.hasMoreHistory || fromState.hasMoreHistory,
        loadingMore: toState.loadingMore || fromState.loadingMore,
      },
    },
  };
}
