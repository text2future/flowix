import type {
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentPermissionMode,
  AgentTypeKey,
} from "@/types/agent";
import type { ThreadListItem } from "@/types";
import type { AgentConversationInstance } from "@features/agent/store/agent-conversation-types";

export interface AgentSessionMeta {
  /**
   * Runtime binding only: the thread each agent type currently attaches to for
   * sends, chunk attribution and persistence. It is deliberately column-free
   * (a thread is a thread), so it must never drive what a column *displays* —
   * display activation is read from that column's navigation target
   * (`useActiveAgentConversationInstanceId`). Wiring display to this slot makes
   * one column's navigation repaint the other column's conversation.
   */
  activeThreadIds: Partial<Record<AgentTypeKey, string | undefined>>;
  activeAgentTypeKey: AgentTypeKey;
  threadTypes: Record<string, AgentTypeKey>;
  threadLists: Partial<Record<AgentTypeKey, ThreadListItem[]>>;
  /**
   * Runtime fallback titles keyed by the product-owned thread id.
   *
   * This used to be keyed by AgentTypeKey, which made every Codex (or every
   * DSH) conversation share one mutable title during recovery.  A title is a
   * property of one product thread, never of an agent runtime.
   */
  currentThreadTitles: Partial<Record<string, string | undefined>>;
  externalSessionResolutions: Record<string, string>;
  lastRunningRunsReconciledAt: number | null;
  /** Legacy migration input; active preferences live in Agent Data Store. */
  settings: {
    agentPermissionMode: AgentPermissionMode;
    agentCodexModel: AgentCodexModel;
    agentCodexReasoningEffort: AgentCodexReasoningEffort;
  };
}

export const DEFAULT_AGENT_SESSION_META: AgentSessionMeta = {
  activeThreadIds: {},
  // DSH is optional and separately installed; a fresh Flowix session must not
  // select a runtime that may be absent.
  activeAgentTypeKey: "codex",
  threadTypes: {},
  threadLists: {},
  currentThreadTitles: {},
  externalSessionResolutions: {},
  lastRunningRunsReconciledAt: null,
  settings: {
    agentPermissionMode: "danger-full-access",
    agentCodexModel: "inherit",
    agentCodexReasoningEffort: "medium",
  },
};

export interface AgentConversationRegistry {
  instances: Record<string, AgentConversationInstance>;
}

export const EMPTY_AGENT_CONVERSATION_REGISTRY: AgentConversationRegistry = {
  instances: {},
};
