import {
  DEFAULT_AGENT_TYPE_KEY,
  isAgentTypeSelectable,
  normalizeAgentTypeKey,
} from '@/lib/agent-types';
import { normalizeCodexPermissionMode } from '@features/agent/runtime/agent-runtime-spec';
import {
  DEFAULT_AGENT_SESSION_META,
  type AgentSessionMeta,
} from '@features/agent/store/session-state';

/** Restore only the current session metadata shape. Runtime data is rebuilt. */
export function rehydrateSessionMeta(persisted: unknown): AgentSessionMeta {
  const own = (persisted as { sessionMeta?: AgentSessionMeta } | null | undefined)?.sessionMeta;
  const defaults = DEFAULT_AGENT_SESSION_META;
  const base: AgentSessionMeta = own && typeof own === 'object'
    ? {
        ...defaults,
        ...own,
        threadLists: defaults.threadLists,
        lastRunningRunsReconciledAt: defaults.lastRunningRunsReconciledAt,
        settings: { ...defaults.settings, ...(own.settings ?? {}) },
      }
    : { ...defaults, settings: { ...defaults.settings } };

  const typeKey = normalizeAgentTypeKey(base.activeAgentTypeKey);
  base.activeAgentTypeKey = isAgentTypeSelectable(typeKey)
    ? typeKey
    : DEFAULT_AGENT_TYPE_KEY;
  base.currentThreadTitles ??= {};
  base.settings.agentPermissionMode = normalizeCodexPermissionMode(
    base.settings.agentPermissionMode,
  );
  return base;
}
