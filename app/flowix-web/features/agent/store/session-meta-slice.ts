import { useAgentDataStore } from "./agent-data-store";
import type {
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentPermissionMode,
  AgentTypeKey,
} from "@/types/agent";
import type { ThreadListItem } from "@/types";
import {
  DEFAULT_AGENT_SESSION_META,
  type AgentSessionMeta,
} from "@features/agent/store/session-state";

type SessionMetaContext = SessionMetaSlice & {
  activateThread(threadId: string): void;
};

type SessionSet = (
  updater: (state: SessionMetaContext) => Partial<SessionMetaContext>,
) => void;
type SessionGet = () => SessionMetaContext;

export interface SessionMetaSlice {
  sessionMeta: AgentSessionMeta;
  setSessionMeta(updater: (meta: AgentSessionMeta) => AgentSessionMeta): void;
  setThreadList(list: ThreadListItem[]): void;
  setActiveThreadId(threadId: string | undefined): void;
  setActiveCodexThreadId(threadId: string | undefined): void;
  setActiveClaudeThreadId(threadId: string | undefined): void;
  setActiveAgentTypeKey(typeKey: AgentTypeKey): void;
  setActiveAgentThread(
    typeKey: AgentTypeKey,
    threadId: string | undefined,
  ): void;
  bindThreadType(threadId: string, typeKey: AgentTypeKey): void;
  setAgentPermissionMode(mode: AgentPermissionMode): void;
  setAgentCodexModel(model: AgentCodexModel): void;
  setAgentCodexReasoningEffort(effort: AgentCodexReasoningEffort): void;
}

export function createSessionMetaSlice(
  set: SessionSet,
  get: SessionGet,
): SessionMetaSlice {
  const setActiveThread = (
    typeKey: AgentTypeKey,
    threadId: string | undefined,
    activateAgent: boolean,
  ) => {
    set((state) => {
      const meta = state.sessionMeta;
      // Opening a conversation that is already the active thread of its agent
      // type must not mint a new sessionMeta object: every column reading it
      // would re-render even though nothing changed.
      const unchanged = meta.activeThreadIds[typeKey] === threadId
        && (!activateAgent || meta.activeAgentTypeKey === typeKey)
        && (!threadId || meta.threadTypes[threadId] === typeKey);
      if (unchanged) return state;
      return {
        sessionMeta: {
          ...meta,
          ...(activateAgent ? { activeAgentTypeKey: typeKey } : {}),
          activeThreadIds: {
            ...meta.activeThreadIds,
            [typeKey]: threadId,
          },
          ...(threadId
            ? {
                threadTypes: {
                  ...meta.threadTypes,
                  [threadId]: typeKey,
                },
              }
            : {}),
        },
      };
    });
  };

  return {
    sessionMeta: DEFAULT_AGENT_SESSION_META,
    setSessionMeta: (updater) =>
      set((state) => ({ sessionMeta: updater(state.sessionMeta) })),
    setThreadList: (list) =>
      set((state) => ({
        sessionMeta: {
          ...state.sessionMeta,
          threadLists: {
            ...state.sessionMeta.threadLists,
            dsh: list,
          },
        },
      })),
    setActiveThreadId: (threadId) =>
      setActiveThread("dsh", threadId, false),
    setActiveCodexThreadId: (threadId) =>
      setActiveThread("codex", threadId, false),
    setActiveClaudeThreadId: (threadId) =>
      setActiveThread("claudecode", threadId, false),
    setActiveAgentTypeKey: (typeKey) =>
      set((state) => ({
        sessionMeta: { ...state.sessionMeta, activeAgentTypeKey: typeKey },
      })),
    setActiveAgentThread: (typeKey, threadId) =>
      setActiveThread(typeKey, threadId, true),
    bindThreadType: (threadId, typeKey) => {
      get().activateThread(threadId);
      set((state) => ({
        sessionMeta: {
          ...state.sessionMeta,
          threadTypes: {
            ...state.sessionMeta.threadTypes,
            [threadId]: typeKey,
          },
        },
      }));
    },
    setAgentPermissionMode: (mode) =>
      useAgentDataStore.getState().setUserPreference("codex", { permission: mode }),
    setAgentCodexModel: (model) =>
      useAgentDataStore.getState().setUserPreference("codex", { model: { id: model } }),
    setAgentCodexReasoningEffort: (effort) => {
      const store = useAgentDataStore.getState();
      store.rememberModelReasoning("codex", store.agents.codex.user.model, effort);
    },
  };
}
