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

/**
 * 旧版 localStorage 形状 (Week 1 之前的 chat-store 持久化字段)。
 * Week 1 把它们从 `ChatStore` 接口移除 (避免"接口里挂着没人写的字段"),
 * 但迁移一次 localStorage 仍需要读取这些值。`mergeChatPersisted` 通过类型断言
 * 把 `persistedState as LegacyPersistedChatStore` 一次性读出, 折到新
 * 字段 (`activeThreadIds` / `currentThreadTitles` / `threadLists`), 然后
 * partialize 不再写, 老数据自然被新数据覆盖。
 *
 * 新代码禁止读这个类型 ── 它只服务于 localStorage 迁移。任何"运行时
 * 单 thread 状态"需求用 `activeThreadIds[type]` 而不是 `activeThreadId`。
 */
export interface LegacyPersistedChatStore {
  activeThreadId?: string;
  activeCodexThreadId?: string;
  activeClaudeThreadId?: string;
  currentThreadTitle?: string;
  currentCodexThreadTitle?: string;
  currentClaudeThreadTitle?: string;
  threadList?: ThreadListItem[];
  codexThreadList?: ThreadListItem[];
  claudeThreadList?: ThreadListItem[];
}

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
 * 持久化, 避免双源漂移。 旧 `activeThreadId` / `currentThreadTitle` 等 legacy
 * 字段已冻结, 不再写入 (迁移逻辑放在 `mergeChatPersisted` 里处理一次性兼容)。
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
 * 把 localStorage 持久化数据合并进当前 store state。 处理三层数据:
 * 1. activeAgentTypeKey 走 normalizeAgentTypeKey + isAgentTypeSelectable, 回退
 *    到 DEFAULT_AGENT_TYPE_KEY (防止旧版本错误的 type key 把 runtime 路由
 *    弄崩)。
 * 2. legacy 字段 (activeThreadId / currentThreadTitle / threadList 等
 *    per-agent-prefixed 旧 key) 折算到 per-type map。
 * 3. 自 persisted 的新字段直接覆盖 current 对应字段。
 * 4. `threadStates` / `lastRunningRunsReconciledAt` 总是取 current ── runtime
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

  // 一次性把 legacy 字段读出来, 折到新字段里 ── 旧 localStorage 兼容。
  // 后续 setState 不会再写 legacy 字段, 下次 partialize 也不再 persist,
  // 老数据自然被新数据覆盖。`legacy` 字段在 ChatStore 接口里已删,
  // 这里通过独立的 LegacyPersistedChatStore 类型 + 类型断言读取,
  // 避免让 ChatStore 持有"只能被 merge 读到"的孤儿字段 ── 见上文
  // `LegacyPersistedChatStore` 的定义。
  const legacy = persistedState as LegacyPersistedChatStore | undefined;
  const legacyFlowixThreadId = legacy?.activeThreadId;
  const legacyCodexThreadId = legacy?.activeCodexThreadId;
  const legacyClaudeThreadId = legacy?.activeClaudeThreadId;
  const legacyFlowixTitle = legacy?.currentThreadTitle;
  const legacyCodexTitle = legacy?.currentCodexThreadTitle;
  const legacyClaudeTitle = legacy?.currentClaudeThreadTitle;
  const legacyFlowixList = legacy?.threadList;
  const legacyCodexList = legacy?.codexThreadList;
  const legacyClaudeList = legacy?.claudeThreadList;

  // 当 persisted 完全不存在时, 保持 current 现有的 map 形状 ── 不要给
  // 三个 type key 强行塞 undefined 值, 否则与 current (空 map) 不深相等。
  const hasPersisted =
    !!persistedState &&
    (Object.keys(persistedState).length > 0 || legacy !== undefined);

  // 每个 type 走 fallback: persisted[type] ?? legacy[type] (lists 多一层 ?? [])。
  // 新类型字段优先于 legacy 单值字段, 与原 chat-store 行为一致。
  const activeThreadIds: AgentTypeMap<string | undefined> = hasPersisted
    ? {
        flowix:
          persistedState?.activeThreadIds?.flowix ?? legacyFlowixThreadId,
        codex:
          persistedState?.activeThreadIds?.codex ?? legacyCodexThreadId,
        claude:
          persistedState?.activeThreadIds?.claude ?? legacyClaudeThreadId,
      }
    : current.activeThreadIds;
  const currentThreadTitles: AgentTypeMap<string | undefined> = hasPersisted
    ? {
        flowix:
          persistedState?.currentThreadTitles?.flowix ?? legacyFlowixTitle,
        codex:
          persistedState?.currentThreadTitles?.codex ?? legacyCodexTitle,
        claude:
          persistedState?.currentThreadTitles?.claude ?? legacyClaudeTitle,
      }
    : current.currentThreadTitles;
  const threadLists: AgentTypeMap<ThreadListItem[]> = hasPersisted
    ? {
        flowix: persistedState?.threadLists?.flowix ?? legacyFlowixList ?? [],
        codex: persistedState?.threadLists?.codex ?? legacyCodexList ?? [],
        claude:
          persistedState?.threadLists?.claude ?? legacyClaudeList ?? [],
      }
    : current.threadLists;
  return {
    ...current,
    ...persistedState,
    activeThreadIds,
    activeAgentTypeKey: typeKey,
    lastRunningRunsReconciledAt: current.lastRunningRunsReconciledAt,
    threadStates: current.threadStates,
    threadTypes: persistedState?.threadTypes ?? current.threadTypes,
    threadLists,
    currentThreadTitles,
    agentPermissionMode: normalizeCodexPermissionMode(
      persistedState?.agentPermissionMode ?? current.agentPermissionMode,
    ),
    // 见 partialize 注释 ── 必须从持久化态恢复, 否则重启后 chunk 路由会断。
    externalSessionResolutions:
      persistedState?.externalSessionResolutions ??
      current.externalSessionResolutions,
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