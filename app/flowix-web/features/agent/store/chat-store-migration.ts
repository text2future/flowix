import type { ThreadListItem } from "@/types";
import type {
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentPermissionMode,
  AgentTypeKey,
} from "@/types/agent";
import {
  DEFAULT_AGENT_TYPE_KEY,
  isAgentTypeSelectable,
  normalizeAgentTypeKey,
} from "@/lib/agent-types";
import { normalizeCodexPermissionMode } from "@features/agent/runtime/agent-runtime-spec";
import type { AgentTypeMap } from "@features/agent/store/chat-thread-accessors";
import type { ThreadsMap } from "@features/agent/store/thread-runtime-state";

export interface ChatPersistShape {
  // Runtime ── 这些不入 localStorage, 但 merge 时需要保持当前值。
  threadStates: ThreadsMap;
  // 持久化字段 ── partialize 选择写入的子集。
  activeThreadIds: AgentTypeMap<string | undefined>;
  activeAgentTypeKey: AgentTypeKey;
  threadTypes: Record<string, AgentTypeKey>;
  currentThreadTitles: AgentTypeMap<string | undefined>;
  agentPermissionMode: AgentPermissionMode;
  agentCodexModel: AgentCodexModel;
  agentCodexReasoningEffort: AgentCodexReasoningEffort;
  externalSessionResolutions: Record<string, string>;
  threadLists: AgentTypeMap<ThreadListItem[]>;
  // 最近一次 reconcile 时间 ── 也入 localStorage (下次启动跳过下一次 reconcile 调用)。
  lastRunningRunsReconciledAt: number | null;
}

/**
 * localStorage 白名单 ── 只写入这些字段。 `threadStates` 真源是 SQLite, 不
 * 持久化, 避免双源漂移。
 */
export function partializeChat(state: ChatPersistShape): {
  activeThreadIds: AgentTypeMap<string | undefined>;
  activeAgentTypeKey: AgentTypeKey;
  threadTypes: Record<string, AgentTypeKey>;
  currentThreadTitles: AgentTypeMap<string | undefined>;
  agentPermissionMode: AgentPermissionMode;
  agentCodexModel: AgentCodexModel;
  agentCodexReasoningEffort: AgentCodexReasoningEffort;
  externalSessionResolutions: Record<string, string>;
} {
  return {
    activeThreadIds: state.activeThreadIds,
    activeAgentTypeKey: state.activeAgentTypeKey,
    threadTypes: state.threadTypes,
    currentThreadTitles: state.currentThreadTitles,
    agentPermissionMode: state.agentPermissionMode,
    agentCodexModel: state.agentCodexModel,
    agentCodexReasoningEffort: state.agentCodexReasoningEffort,
    // 外部 runtime (Codex / Claude / Gemini / Hermes / OpenClaw) 的
    // local → session 映射 ── 不持久化的话, 进程重启后到达的 chunk
    // 会因为 `resolveExternalChunkThreadId` 找不到 mapping 而走 fallback
    // 落到 `chunk.thread_id`, 如果 CLI 后续用的是 resolved session_id
    // (而非 local launch id), chunk 就会被错路由。
    externalSessionResolutions: state.externalSessionResolutions,
  };
}

/**
 * 把 localStorage 持久化数据合并进当前 store state:
 * 1. activeAgentTypeKey 走 normalizeAgentTypeKey + isAgentTypeSelectable, 回退
 *    到 DEFAULT_AGENT_TYPE_KEY (防止旧版本错误的 type key 把 runtime 路由
 *    弄崩)。
 * 2. 自 persisted 的新字段直接覆盖 current 对应字段。
 * 3. `threadStates` / `lastRunningRunsReconciledAt` 总是取 current ── runtime
 *    状态不应从 localStorage 恢复 (真源 SQLite)。
 */
export function mergeChatPersisted(
  persisted: unknown,
  current: ChatPersistShape,
): ChatPersistShape {
  const persistedState = persisted as Partial<ChatPersistShape> | undefined;
  const normalizedTypeKey = normalizeAgentTypeKey(
    persistedState?.activeAgentTypeKey ?? current.activeAgentTypeKey,
  );
  const typeKey = isAgentTypeSelectable(normalizedTypeKey)
    ? normalizedTypeKey
    : DEFAULT_AGENT_TYPE_KEY;

  return {
    ...current,
    ...persistedState,
    activeAgentTypeKey: typeKey,
    lastRunningRunsReconciledAt: current.lastRunningRunsReconciledAt,
    threadStates: current.threadStates,
    agentPermissionMode: normalizeCodexPermissionMode(
      persistedState?.agentPermissionMode ?? current.agentPermissionMode,
    ),
  };
}

/**
 * 构造一个 partialize / merge 对 ── 给 zustand persist middleware 直接传入。
 * 这样 chat-store 可以完全不再关心持久化 schema 的细节。
 */
export function createChatPersister(): {
  partialize: (state: ChatPersistShape) => ReturnType<typeof partializeChat>;
  merge: (
    persisted: unknown,
    current: ChatPersistShape,
  ) => ChatPersistShape;
} {
  return {
    partialize: partializeChat,
    merge: mergeChatPersisted,
  };
}