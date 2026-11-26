import { DEFAULT_AGENT_SESSION_META } from "@features/agent/store/session-state";
import { rehydrateSessionMeta } from "@features/agent/store/session-persistence";
import type { AgentSessionStore } from "@features/agent/store/agent-session-store-types";

/**
 * `agent-session-store` 的 zustand persist 配置。纯函数与组合根分离，
 * 让 store 文件只保留装配逻辑。
 */

export function migrateAgentSessionPersisted(
  persisted: unknown,
): Record<string, unknown> {
  return {
    ...(persisted as Record<string, unknown>),
    sessionMeta: rehydrateSessionMeta(persisted),
  };
}

export function partializeAgentSessionMeta(state: AgentSessionStore) {
  return {
    sessionMeta: {
      ...state.sessionMeta,
      threadLists: DEFAULT_AGENT_SESSION_META.threadLists,
      lastRunningRunsReconciledAt:
        DEFAULT_AGENT_SESSION_META.lastRunningRunsReconciledAt,
    },
  };
}

export function mergeAgentSessionPersisted(
  persisted: unknown,
  current: AgentSessionStore,
): AgentSessionStore {
  return {
    ...current,
    sessionMeta: rehydrateSessionMeta(persisted),
  };
}
