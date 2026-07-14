import type { AgentChunk } from '@/types/agent';
import type { AgentTypeKey } from '@/types/agent';
import {
  emptyThreadState,
  type ThreadState,
} from '@features/agent/store/thread-runtime-state';

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

/**
 * Runtime-only session migration ── chat-store.threadStates 层面的
 * local → canonical session id 合并: threadTypes / externalSessionResolutions
 * 都同步更新, 但 messages 走 conversation store. 这条 helper 是 chat-store
 * 唯一允许把 runtime 状态从 local id 合并到 session id 的入口 ── 同时被
 * session_resolved chunk / backend snapshot / Thread Card cache resolve
 * 三条路径共享, 避免重复实现。
 */
export function applyExternalSessionResolved(
  state: ExternalSessionStateInput,
  localThreadId: string,
  sessionId: string,
  agentType: AgentTypeKey,
): ExternalSessionResolvedState {
  const fromState = state.threadStates[localThreadId] ?? emptyThreadState();
  const toState = state.threadStates[sessionId] ?? emptyThreadState();

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
        isLoading: toState.isLoading || fromState.isLoading,
        activeRunId: toState.activeRunId ?? fromState.activeRunId,
        runs: { ...toState.runs, ...fromState.runs },
        oldestSequence: toState.oldestSequence ?? fromState.oldestSequence,
        hasMoreHistory: toState.hasMoreHistory || fromState.hasMoreHistory,
        loadingMore: toState.loadingMore || fromState.loadingMore,
      },
    },
  };
}