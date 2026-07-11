import { create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";
import type { ChatMessage, ThreadListItem } from "@/types";
import type {
  AgentChunk,
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentEvent,
  AgentPermissionMode,
  AgentRunState,
  AgentTypeKey,
  RunInfo,
} from "@/types/agent";
import { STORAGE_KEYS } from "@/lib/constants";
import { useUserSettingsStore } from "@features/preferences/store/user-settings-store";
import { translate, type AppLanguage } from "@features/i18n";
import { stripSystemBlock } from "@features/agent/message";
import { applyExternalSessionResolved } from "@features/agent/store/external-session";
import { normalizeCodexPermissionMode } from "@features/agent/runtime/agent-runtime-spec";
import { agentClient, listenToAgentChunks } from "@features/agent/store/agent-client";
import {
  applyErrorChunk,
  applyReasoningChunk,
  applyTextChunk,
  applyToolCallChunk,
  applyToolResultChunk,
} from "@features/agent/store/apply-chunk";
import {
  applyOptimisticUserRun,
  createSendErrorMessage,
  prepareUserMessage,
} from "@features/agent/store/user-message";
import { dispatchChatStream } from "@features/agent/store/chat-stream";
import {
  filterRenderableHistoryMessages,
  findHistoryThreadInfo,
  getHistoryPage,
  getInitialThreadHistory,
  HISTORY_PAGE_SIZE,
  listHistoryThreads,
  mergeHistoricalMessages,
  prependHistoricalMessages,
} from "@features/agent/store/thread-history";
import { createStreamingBuffer } from "@features/agent/store/streaming-buffer";
import {
  createRunId,
  mapAgentChunkToEvent,
} from "@features/agent/events/agent-event-mapper";
import {
  recordAgentChunkMapped,
  recordAgentLifecycleEvent,
  recordAgentStopRequested,
} from "@features/agent/diagnostics/agent-run-trace";
import {
  applyRunEnded,
  applyRunFailed,
  applyRunStarted,
  applyRunUsage,
  applyRunStopped,
  applyRunToolState,
} from "@features/agent/store/run-lifecycle";
import {
  useAgentConversationStore,
  type AgentConversationRun,
  type AgentConversationInstance,
} from "@features/agent/store/agent-conversation-store";

/** 读取当前 AppLanguage ── zustand store 不在 React 树里也能用 .getState()。 */
function getLanguage(): AppLanguage {
  return useUserSettingsStore.getState().settings.language;
}

function syncThreadRenderableMessages(
  agentType: AgentTypeKey,
  threadId: string,
  messages: ChatMessage[],
): void {
  useAgentConversationStore
    .getState()
    .syncRenderableMessages(agentType, threadId, messages);
}

function releaseThreadRuntimeMessages(st: ThreadState): ThreadState {
  if (
    st.messages.length === 0 &&
    st.pendingAssistantId === null &&
    st.pendingReasoningId === null
  ) {
    return st;
  }
  return {
    ...st,
    messages: [],
    pendingAssistantId: null,
    pendingReasoningId: null,
  };
}

function getRenderableMessageCount(threadId: string): number {
  const canonicalMessages =
    useAgentConversationStore.getState().messageStates[threadId]?.messages;
  if (canonicalMessages) return canonicalMessages.length;
  return useChatStore.getState().threadStates[threadId]?.messages.length ?? 0;
}
import {
  DEFAULT_AGENT_TYPE_KEY,
  getAgentType,
  isAgentTypeSelectable,
  normalizeAgentTypeKey,
} from "@/lib/agent-types";

const RUNNING_RUN_OPTIMISTIC_GRACE_MS = 3000;

function optimisticUntilFromStartedAt(startedAt: number): number {
  return startedAt + RUNNING_RUN_OPTIMISTIC_GRACE_MS;
}


type AgentTypeMap<T> = Partial<Record<AgentTypeKey, T>>;

function isExternalAgentType(type: AgentTypeKey): boolean {
  return type !== "flowix";
}

function canPersistThreadTitle(type: AgentTypeKey): boolean {
  return !getAgentType(type).capabilities.externalSessionBacked;
}

function getActiveThreadIdForType(
  state: ChatStore,
  type: AgentTypeKey,
): string | undefined {
  return state.activeThreadIds[type];
}

function getThreadListForType(
  state: ChatStore,
  type: AgentTypeKey,
): ThreadListItem[] {
  return state.threadLists[type] ?? [];
}

function getCurrentTitleForType(
  state: ChatStore,
  type: AgentTypeKey,
): string | undefined {
  return state.currentThreadTitles[type];
}

function activeThreadUpdate(
  state: ChatStore,
  type: AgentTypeKey,
  threadId: string | undefined,
): Partial<ChatStore> {
  // 修复 #12: 之前 `activeAgentTypeKey: type` 是副作用 ── 切到 codex thread
  // 会顺带把 activeAgentTypeKey 改成 codex, 多 panel / 多 instance 并发场景
  // 下其中一个 panel 的 setActiveThreadId 会污染另一个 panel 的 send 路径。
  //
  // 现在只更新 activeThreadIds[type], activeAgentTypeKey 由 setActiveAgentThread
  // (跨 runtime 切换) / setActiveAgentTypeKey (纯 type 切换) 显式管理 ──
  // 与命名意图对齐。 内部 callers (loadThread / loadCodexThread / ...) 在被调用
  // 时 activeType.key 已经匹配, 所以该副作用本就是冗余的 ── 删掉零行为变化。
  return {
    activeThreadIds: {
      ...state.activeThreadIds,
      [type]: threadId,
    },
  };
}

function threadListUpdate(
  state: ChatStore,
  type: AgentTypeKey,
  list: ThreadListItem[],
): Partial<ChatStore> {
  return {
    threadLists: {
      ...state.threadLists,
      [type]: list,
    },
  };
}

function titleUpdate(
  state: ChatStore,
  type: AgentTypeKey,
  title: string | undefined,
): Partial<ChatStore> {
  return {
    currentThreadTitles: {
      ...state.currentThreadTitles,
      [type]: title,
    },
  };
}


function defaultExternalThreadTitle(type: AgentTypeKey): string {
  if (type === "codex")
    return translate(getLanguage(), "agent.codexSession.title");
  if (type === "claude")
    return translate(getLanguage(), "agent.claudeSession.title");
  return `${getAgentType(type).name} session`;
}

function normalizeThreadTitle(title: string | null | undefined): string {
  return stripSystemBlock(title ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 每个 thread 独立的运行态 ── 不再绑在"当前 active thread"上, 让 A
 * 对话在后台跑 / B 对话在前面写 / 重入 A 看到全部最新消息都能成立。
 *
 * 真源仍是 SQLite (`threadStates` 是实时增量缓存, 不进 zustand persist),
 * 切走时不需要做任何清理; 重入 thread 时调 `loadThread(tid)` 重新从
 * 磁盘 seed 一次, 再叠加 `stream_start/end` 之间的实时 chunk。
 *
 * `pendingAssistantId` / `pendingReasoningId` 是 dispatchAgentChunk
 * 内部的临时游标 ── 给 applyTextChunk / applyReasoningChunk 知道
 * 下一个 text/reasoning chunk 应该 append 到哪一行。流结束 / tool_call
 * 时归零。 业务 UI 不读这两个字段。
 */
export interface ThreadState {
  messages: ChatMessage[];
  isLoading: boolean;
  activeRunId: string | null;
  runs: Record<string, AgentRunState>;
  pendingAssistantId: string | null;
  pendingReasoningId: string | null;
  /**
   * 通用 metadata 协议 ── 最新一次 run 的展示快照。
   * runs[runId] 在正常完成时被清理,但 lastRun 仍保留 model / tokenUsage /
   * startedAt / endedAt 等关键 metadata,供 BadgeHoverCard 等"展示"层
   * 在 run 结束后仍可读。Provider-agnostic:对 Codex / Claude / Gemini /
   * Flowix / Hermes / OpenClaw 全部适用。
   */
  lastRun?: import("@/types/agent").LastRunSnapshot;
  /** Layer 4: 当前 in-memory messages 中最早一条的 sequence (作下一页 cursor).
   *  null = 尚未通过分页加载 (兼容旧 loadThread 全量路径) 或 thread 为空. */
  oldestSequence: number | null;
  /** Layer 4: 是否还有更早的历史可加载. false → 顶部不再 prefetch. */
  hasMoreHistory: boolean;
  /** Layer 4: 防止并发触发顶部加载 ── true 时 loadMoreHistory 直接 early return. */
  loadingMore: boolean;
}

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
 * 旧版 localStorage 形状 (Week 1 之前的 chat-store 持久化字段)。
 * Week 1 把它们从 `ChatStore` 接口移除 (避免"接口里挂着没人写的字段"),
 * 但迁移一次 localStorage 仍需要读取这些值。`merge` 函数里通过类型断言
 * 把 `persistedState as LegacyPersistedChatStore` 一次性读出, 折到新
 * 字段 (`activeThreadIds` / `currentThreadTitles` / `threadLists`), 然后
 * partialize 不再写, 老数据自然被新数据覆盖。
 *
 * 新代码禁止读这个类型 ── 它只服务于 localStorage 迁移。任何"运行时
 * 单 thread 状态"需求用 `activeThreadIds[type]` 而不是 `activeThreadId`。
 */
interface LegacyPersistedChatStore {
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

/** 派发器使用的局部 mutable 别名 ── 避免到处写 `as ThreadState`。 */
type ThreadsMap = Record<string, ThreadState>;

type ConversationRunPatch = Partial<
  Omit<AgentConversationRun, "runId" | "startedAt">
>;

function conversationUsagePatchFromState(
  st: ThreadState,
  runId: string,
): ConversationRunPatch | null {
  const run =
    st.runs[runId] ?? (st.lastRun?.runId === runId ? st.lastRun : undefined);
  if (!run?.tokenUsage) return null;

  return {
    inputTokens: run.tokenUsage.input,
    cachedInputTokens: run.tokenUsage.cachedInput,
    outputTokens: run.tokenUsage.output,
    reasoningOutputTokens: run.tokenUsage.reasoningOutput,
    totalTokens: run.tokenUsage.total,
    modelContextWindow: run.modelContextWindow,
    modelId: run.modelId,
    codexPlanType: run.codexPlanType,
    codexUsedPercent: run.codexUsedPercent,
    codexResetsAt: run.codexResetsAt,
    lastRunAt: run.lastRunAt,
  };
}

function syncConversationInstanceForEvent(
  event: AgentEvent,
  st: ThreadState,
): void {
  const instanceStore = useAgentConversationStore.getState();
  const eventInstance =
    instanceStore.findByRunId(event.runId) ??
    instanceStore.findByThreadId(event.threadId);

  if (event.kind === "session_resolved" && event.sessionId) {
    instanceStore.resolveSessionByThreadId(
      event.threadId,
      event.sessionId,
      event.agentType,
    );
    return;
  }

  if (!eventInstance) return;

  switch (event.kind) {
    case "stream_start":
      instanceStore.markRunStarted(eventInstance.instanceId, {
        runId: event.runId,
        startedAt: event.timestamp,
        model: event.model,
        modelId: event.model,
        lastRunAt: event.timestamp,
        reasoningEffort: event.reasoningEffort,
      });
      break;
    case "stream_end":
      instanceStore.markRunEnded(
        eventInstance.instanceId,
        event.reason ? "failed" : "completed",
        event.timestamp,
        event.reason,
      );
      instanceStore.updateRun(eventInstance.instanceId, {
        lastRunAt: event.timestamp,
      });
      break;
    case "tool_call":
      instanceStore.updateRun(eventInstance.instanceId, {
        currentTool: event.name,
      });
      break;
    case "tool_result":
      instanceStore.updateRun(eventInstance.instanceId, {
        currentTool: null,
      });
      break;
    case "error":
      instanceStore.markRunEnded(
        eventInstance.instanceId,
        "failed",
        event.timestamp,
        event.message,
      );
      instanceStore.updateRun(eventInstance.instanceId, {
        lastRunAt: event.timestamp,
      });
      break;
    case "usage": {
      const patch = conversationUsagePatchFromState(st, event.runId);
      if (patch) instanceStore.updateRun(eventInstance.instanceId, patch);
      break;
    }
  }
}

export interface ChatStore {
  threadStates: ThreadsMap;
  lastRunningRunsReconciledAt: number | null;
  activeThreadIds: AgentTypeMap<string | undefined>;
  activeAgentTypeKey: AgentTypeKey;
  threadTypes: Record<string, AgentTypeKey>;
  externalSessionResolutions: Record<string, string>;
  agentPermissionMode: AgentPermissionMode;
  agentCodexModel: AgentCodexModel;
  agentCodexReasoningEffort: AgentCodexReasoningEffort;
  threadLists: AgentTypeMap<ThreadListItem[]>;
  currentThreadTitles: AgentTypeMap<string | undefined>;

  // ── actions ──
  setThreadList: (list: ThreadListItem[]) => void;
  /**
   * 切换 active thread ── 各种组件 (document titlebar / thread card) 读
   * activeThreadId 来决定'当前显示哪个 thread'。 纯前端切换, 不发 IPC,
   * 不动 threadStates ── 跟 `loadThread` 的区别: loadThread 还会拉
   * threadInfo 设置 currentThreadTitle, 这里只切 active, 适合'我已经知道
   * threadId, 只想切过去显示'的场景。
   */
  setActiveThreadId: (threadId: string | undefined) => void;
  setActiveCodexThreadId: (threadId: string | undefined) => void;
  setActiveClaudeThreadId: (threadId: string | undefined) => void;
  setActiveAgentTypeKey: (typeKey: AgentTypeKey) => void;
  setActiveAgentThread: (
    typeKey: AgentTypeKey,
    threadId: string | undefined,
  ) => void;
  migrateThreadState: (
    fromThreadId: string,
    toThreadId: string,
    typeKey: AgentTypeKey,
  ) => void;
  bindThreadType: (threadId: string, typeKey: AgentTypeKey) => void;
  setAgentPermissionMode: (mode: AgentPermissionMode) => void;
  setAgentCodexModel: (model: AgentCodexModel) => void;
  setAgentCodexReasoningEffort: (effort: AgentCodexReasoningEffort) => void;
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
  loadThreadCache: (threadId: string) => Promise<void>;
  loadMoreHistory: (typeKey: AgentTypeKey, threadId: string) => Promise<void>;
  deleteThread: (threadId: string) => Promise<void>;
  renameAgentConversation: (input: {
    instanceId?: string | null;
    threadId?: string | null;
    title: string;
    typeKey?: AgentTypeKey;
  }) => Promise<void>;
  renameThread: (
    threadId: string,
    title: string,
    typeKey?: AgentTypeKey,
  ) => Promise<void>;
  sendMessageToThread: (
    threadId: string,
    content: string,
    typeKey?: AgentTypeKey,
    options?: {
      instanceId?: string;
      conversationTitle?: string;
      currentNoteContent?: string;
      agentRoleMemoId?: string;
      agentRoleName?: string;
      isFirstMessage?: boolean;
      /**
       * Role memo 的 markdown body ── caller (agent-thread-card 组件)
       * 已经在 await 路径里通过 memosClient.readMemo / read_document 拿到,
       * 这里直接拼到首条 user 消息末尾。 仅当 isFirstMessage=true 且
       * agentRoleMemoId 存在时, 才有意义; 其他情况会被忽略。
       */
      agentRoleBody?: string | null;
    },
  ) => Promise<void>;
  /**
   * 终止当前 active thread 的 in-flight chat_stream ── 后端 cancel
   * flag 翻转后, `chat_stream` 走 flush_cancel 退出, 触发 `StreamEnd`
   * chunk, `dispatchAgentChunk` 收敛 isLoading。 这里只负责发信号,
   * UI 状态由 chunk 事件收敛。
   */
  stopStream: () => Promise<void>;
  stopThreadRun: (threadId: string, runId?: string) => Promise<void>;
  dispatchAgentEvent: (event: AgentEvent) => void;
  /**
   * 全局 `agent-chunk` 派发器 ── 由 `useAgentEvents` 在 App.tsx 顶层
   * 挂的 listener 调一次, 按 `chunk.thread_id` 路由到 `threadStates[tid]`。
   * 这是后台多 chat 并行的核心: 一个 listener, 多个 thread_state,
   * chunk 自带 thread_id 自然分流。
   */
  dispatchAgentChunk: (chunk: AgentChunk) => void;
  /**
   * 后端运行快照 reconcile: 后端 `agent_running_threads` 是运行态真源,
   * 前端 registry 只做实时镜像。快照会补齐漏掉的 stream_start, 也会
   * 清掉前端残留的 running 标记。
   */
  reconcileRunningRunsFromSnapshot: (running: Record<string, RunInfo>) => void;
  reconcileRunningRuns: () => Promise<void>;
}

function threadRunUpdate(
  state: ChatStore,
  threadId: string,
  threadState: ThreadState,
): Pick<ChatStore, "threadStates"> {
  return {
    threadStates: {
      ...state.threadStates,
      [threadId]: threadState,
    },
  };
}

function reconcileThreadStatesFromRunningSnapshot(
  state: ChatStore,
  running: Record<string, RunInfo>,
  now: number,
): Pick<
  ChatStore,
  "threadStates" | "threadTypes" | "lastRunningRunsReconciledAt"
> {
  let nextThreadStates: ThreadsMap = { ...state.threadStates };
  let nextThreadTypes: Record<string, AgentTypeKey> = { ...state.threadTypes };
  const backendRunIds = new Set<string>();

  for (const [threadId, info] of Object.entries(running)) {
    const existing = nextThreadStates[threadId] ?? emptyThreadState();
    const agentType = normalizeAgentTypeKey(
      info.agentType ?? nextThreadTypes[threadId],
    );
    const runId = info.runId ?? existing.activeRunId ?? createRunId(threadId);
    const startedAt = info.startedAt || now;
    const event: AgentEvent = {
      kind: "stream_start",
      agentType,
      threadId,
      runId,
      timestamp: startedAt,
    };
    nextThreadStates[threadId] = applyRunStarted(existing, event, {
      startedAt,
      currentTool: info.currentTool ?? null,
    });
    nextThreadTypes[threadId] = agentType;
    backendRunIds.add(runId);
  }

  for (const [threadId, threadState] of Object.entries(nextThreadStates)) {
    if (!isThreadRunActive(threadState)) continue;
    const runId = threadState.activeRunId;
    if (!runId || backendRunIds.has(runId)) continue;
    const run = threadState.runs[runId];
    if ((run?.startedAt ? optimisticUntilFromStartedAt(run.startedAt) : 0) > now) {
      continue;
    }
    const { [runId]: _removed, ...runs } = threadState.runs;
    nextThreadStates[threadId] = {
      ...threadState,
      isLoading: false,
      activeRunId: null,
      pendingAssistantId: null,
      pendingReasoningId: null,
      runs,
    };
  }

  return {
    threadStates: nextThreadStates,
    threadTypes: nextThreadTypes,
    lastRunningRunsReconciledAt: now,
  };
}



function getConversationTitleForThread(
  state: ChatStore,
  type: AgentTypeKey,
  threadId: string,
): string {
  return (
    getThreadListForType(state, type).find((item) => item.threadId === threadId)
      ?.title ??
    (getActiveThreadIdForType(state, type) === threadId
      ? getCurrentTitleForType(state, type)
      : undefined) ??
    (isExternalAgentType(type)
      ? defaultExternalThreadTitle(type)
      : translate(getLanguage(), "agent.chat.newConversation"))
  );
}

/**
 * Ensure a conversation instance exists for `threadId`; return its id.
 *
 * When an instance for `threadId` already exists, the patch updates
 * agentType / title / threadId in place. Otherwise a new one is
 * created with `source: { kind: "thread-card" }` - `thread-card` is the
 * only remaining source discriminator (see `AgentConversationSource`).
 *
 * Used by `reconcileRunningRunsFromSnapshot` to backfill the status-bar
 * Agent runtime list from the backend running-threads snapshot.
 */
function ensureConversationInstanceForThread(
  threadId: string,
  type: AgentTypeKey,
  title: string,
  runId?: string | null,
): AgentConversationInstance {
  const instanceStore = useAgentConversationStore.getState();
  const nextTitle = normalizeThreadTitle(title);
  const existing =
    (runId ? instanceStore.findByRunId(runId) : null) ??
    instanceStore.findByThreadId(threadId);
  if (existing) {
    const shouldUpdateTitle =
      nextTitle &&
      (!isExternalAgentType(type) || nextTitle !== defaultExternalThreadTitle(type));
    return instanceStore.upsertInstance(existing.instanceId, {
      agentType: type,
      ...(shouldUpdateTitle ? { title: nextTitle } : {}),
      threadId,
    });
  }
  return instanceStore.createInstance({
    agentType: type,
    title: nextTitle,
    threadId,
    source: { kind: "thread-card" },
  });
}

export const useChatStore = create<ChatStore>()(
  subscribeWithSelector(
    persist(
    (set, get) => {

      return {
        threadStates: {},
        lastRunningRunsReconciledAt: null,
        activeThreadIds: {},
        activeAgentTypeKey: DEFAULT_AGENT_TYPE_KEY,
        threadTypes: {},
        externalSessionResolutions: {},
        agentPermissionMode: "danger-full-access",
        agentCodexModel: "inherit",
        agentCodexReasoningEffort: "medium",
        threadLists: {},
        currentThreadTitles: {},

        setThreadList: (list) => {          set((state) => threadListUpdate(state, "flowix", list));
        },
        setActiveThreadId: (threadId) =>
          set((state) => ({
            ...activeThreadUpdate(state, "flowix", threadId),
            ...(threadId
              ? { threadTypes: { ...state.threadTypes, [threadId]: "flowix" } }
              : {}),
          })),
        setActiveCodexThreadId: (threadId) =>
          set((state) => ({
            ...activeThreadUpdate(state, "codex", threadId),
            ...(threadId
              ? { threadTypes: { ...state.threadTypes, [threadId]: "codex" } }
              : {}),
          })),
        setActiveClaudeThreadId: (threadId) =>
          set((state) => ({
            ...activeThreadUpdate(state, "claude", threadId),
            ...(threadId
              ? { threadTypes: { ...state.threadTypes, [threadId]: "claude" } }
              : {}),
          })),
        setActiveAgentTypeKey: (typeKey) => {
          const type = getAgentType(typeKey);
          if (!isAgentTypeSelectable(type.key)) return;
          set({ activeAgentTypeKey: type.key });
        },
        setActiveAgentThread: (typeKey, threadId) => {
          const type = getAgentType(typeKey);
          set((state) => ({
            ...activeThreadUpdate(state, type.key, threadId),
            // 跨 runtime 切换入口 ── 同步 activeAgentTypeKey, 让后续
            // sendMessageToThread 路由到正确的 runtime。
            // (修复 #12: 让 `activeThreadUpdate` 变纯后, 这里显式补。)
            activeAgentTypeKey: type.key,
            ...(threadId
              ? { threadTypes: { ...state.threadTypes, [threadId]: type.key } }
              : {}),
          }));
        },
        migrateThreadState: (fromThreadId, toThreadId, typeKey) => {
          if (!fromThreadId || !toThreadId || fromThreadId === toThreadId)
            return;
          const type = getAgentType(typeKey);
          set((state) => {
            const fromState = state.threadStates[fromThreadId];
            if (!fromState) {
              return {
                ...activeThreadUpdate(state, type.key, toThreadId),
                // 跨 runtime resolve (e.g. Codex pending → session_id) ──
                // 同步 activeAgentTypeKey 让 sendMessageToThread 路由到正确 runtime。
                activeAgentTypeKey: type.key,
                threadTypes: {
                  ...state.threadTypes,
                  [toThreadId]: type.key,
                },
              };
            }
            const toState =
              state.threadStates[toThreadId] ?? emptyThreadState();
            const messages =
              fromState.messages.length > 0
                ? mergeHistoricalMessages(
                    toState.messages,
                    fromState.messages,
                    type.key,
                  )
                : toState.messages;
            return {
              ...activeThreadUpdate(state, type.key, toThreadId),
              // 同上, 跨 runtime resolve 显式设 activeAgentTypeKey。
              activeAgentTypeKey: type.key,
              threadTypes: {
                ...state.threadTypes,
                [fromThreadId]: type.key,
                [toThreadId]: type.key,
              },
              threadStates: {
                ...state.threadStates,
                [toThreadId]: {
                  ...toState,
                  messages,
                  isLoading: toState.isLoading || fromState.isLoading,
                  pendingAssistantId:
                    toState.pendingAssistantId ?? fromState.pendingAssistantId,
                  pendingReasoningId:
                    toState.pendingReasoningId ?? fromState.pendingReasoningId,
                },
              },
            };
          });
        },
        bindThreadType: (threadId, typeKey) => {
          const type = getAgentType(typeKey);
          set((state) => ({
            threadTypes: {
              ...state.threadTypes,
              [threadId]: type.key,
            },
          }));
        },
        setAgentPermissionMode: (mode) => set({ agentPermissionMode: mode }),
        setAgentCodexModel: (model) => set({ agentCodexModel: model }),
        setAgentCodexReasoningEffort: (effort) =>
          set({ agentCodexReasoningEffort: effort }),

        loadThreadList: async () => {
          try {
            const threads = await listHistoryThreads("flowix");            set((state) => threadListUpdate(state, "flowix", threads));
          } catch (err) {
            console.error("Failed to load thread list:", err);
          }
        },

        loadThread: async (threadId) => {
          try {
            // Layer 4: 用分页 API 取最近 HISTORY_PAGE_SIZE 条, 而非全量.
            // 1MB / 500 条 thread 的 IPC payload 从 ~1MB 降到 ~100KB.
            const page = await getInitialThreadHistory(
              "flowix",
              threadId,
              HISTORY_PAGE_SIZE,
            );
            const threadInfo = await findHistoryThreadInfo(
              "flowix",
              threadId,
              getThreadListForType(get(), "flowix"),
            );
            // Drop empty assistant messages that older sessions may have
            // persisted — they render as blank cards and add no value.
            const messages = filterRenderableHistoryMessages(page.messages);
            set((state) => {
              const existing =
                state.threadStates[threadId] ?? emptyThreadState();
              // 以 `message.id` 去重 merge ── 若该 thread 当前正在跑
              // (isLoading=true), listener 已经在写 threadStates, 这里
              // 不能整体替换 (会把 listener 写的 in-flight chunk 覆盖
              // 掉); 只补齐 SQLite 里有但 store 里没有的"历史行"。
              const merged = mergeHistoricalMessages(
                existing.messages,
                messages,
                "flowix",
              );
              return {
                ...activeThreadUpdate(state, "flowix", threadId),
                threadTypes: {
                  ...state.threadTypes,
                  [threadId]: state.threadTypes[threadId] ?? "flowix",
                },
                threadStates: {
                  ...state.threadStates,
                  [threadId]: {
                    ...existing,
                    messages: merged,
                    oldestSequence: page.oldestSequence,
                    hasMoreHistory: page.hasMore,
                  },
                },
                ...titleUpdate(
                  state,
                  "flowix",
                  threadInfo?.title ??
                    translate(getLanguage(), "agent.chat.unnamedConversation"),
                ),
              };
            });
          } catch (err) {
            console.error("Failed to load thread:", err);
          }
        },


        loadCodexThreadList: async () => {
          try {
            const threads = await listHistoryThreads("codex");            set((state) => threadListUpdate(state, "codex", threads));
          } catch (err) {
            console.error("Failed to load Codex thread list:", err);
          }
        },

        loadCodexThread: async (threadId) => {
          try {
            const page = await getInitialThreadHistory(
              "codex",
              threadId,
              HISTORY_PAGE_SIZE,
            );
            const threadInfo = await findHistoryThreadInfo(
              "codex",
              threadId,
              getThreadListForType(get(), "codex"),
            );
            const messages = filterRenderableHistoryMessages(page.messages);
            set((state) => {
              const existing =
                state.threadStates[threadId] ?? emptyThreadState();
              const mergedMessages =
                messages.length > 0
                  ? mergeHistoricalMessages(
                      existing.messages,
                      messages,
                      "codex",
                    )
                  : existing.messages;
              return {
                ...activeThreadUpdate(state, "codex", threadId),
                threadTypes: {
                  ...state.threadTypes,
                  [threadId]: state.threadTypes[threadId] ?? "codex",
                },
                threadStates: {
                  ...state.threadStates,
                  [threadId]: {
                    ...existing,
                    messages: mergedMessages,
                    oldestSequence: page.oldestSequence,
                    hasMoreHistory: page.hasMore,
                    pendingAssistantId: null,
                    pendingReasoningId: null,
                  },
                },
                ...titleUpdate(
                  state,
                  "codex",
                  threadInfo?.title ??
                    translate(getLanguage(), "agent.codexSession.title"),
                ),
              };
            });
          } catch (err) {
            console.error("Failed to load Codex thread:", err);
          }
        },

        loadClaudeThreadList: async () => {
          try {
            const threads = await listHistoryThreads("claude");            set((state) => threadListUpdate(state, "claude", threads));
          } catch (err) {
            console.error("Failed to load Claude Code thread list:", err);
          }
        },

        loadClaudeThread: async (threadId) => {
          try {
            const page = await getInitialThreadHistory(
              "claude",
              threadId,
              HISTORY_PAGE_SIZE,
            );
            const threadInfo = await findHistoryThreadInfo(
              "claude",
              threadId,
              getThreadListForType(get(), "claude"),
            );
            const messages = filterRenderableHistoryMessages(page.messages);
            set((state) => {
              const existing =
                state.threadStates[threadId] ?? emptyThreadState();
              const mergedMessages = mergeHistoricalMessages(
                existing.messages,
                messages,
                "claude",
              );
              return {
                ...activeThreadUpdate(state, "claude", threadId),
                threadTypes: {
                  ...state.threadTypes,
                  [threadId]: "claude",
                },
                threadStates: {
                  ...state.threadStates,
                  [threadId]: {
                    ...existing,
                    messages: mergedMessages,
                    pendingAssistantId: null,
                    pendingReasoningId: null,
                  },
                },
                ...titleUpdate(
                  state,
                  "claude",
                  threadInfo?.title ??
                    translate(getLanguage(), "agent.claudeSession.title"),
                ),
              };
            });
          } catch (err) {
            console.error("Failed to load Claude Code thread:", err);
          }
        },

        loadHermesThreadList: async () => {
          try {
            const threads = await listHistoryThreads("hermes");            set((state) => threadListUpdate(state, "hermes", threads));
          } catch (err) {
            console.error("Failed to load Hermes thread list:", err);
          }
        },

        loadHermesThread: async (threadId) => {
          try {
            const page = await getInitialThreadHistory(
              "hermes",
              threadId,
              HISTORY_PAGE_SIZE,
            );
            const threadInfo = await findHistoryThreadInfo(
              "hermes",
              threadId,
              getThreadListForType(get(), "hermes"),
            );
            const messages = filterRenderableHistoryMessages(page.messages);
            set((state) => {
              const existing =
                state.threadStates[threadId] ?? emptyThreadState();
              const mergedMessages =
                messages.length > 0
                  ? mergeHistoricalMessages(
                      existing.messages,
                      messages,
                      "hermes",
                    )
                  : existing.messages;
              return {
                ...activeThreadUpdate(state, "hermes", threadId),
                threadTypes: {
                  ...state.threadTypes,
                  [threadId]: state.threadTypes[threadId] ?? "hermes",
                },
                threadStates: {
                  ...state.threadStates,
                  [threadId]: {
                    ...existing,
                    messages: mergedMessages,
                    oldestSequence: page.oldestSequence,
                    hasMoreHistory: page.hasMore,
                    pendingAssistantId: null,
                    pendingReasoningId: null,
                  },
                },
                ...titleUpdate(
                  state,
                  "hermes",
                  threadInfo?.title ?? "Hermes session",
                ),
              };
            });
          } catch (err) {
            console.error("Failed to load Hermes thread:", err);
          }
        },

        loadAgentThread: async (typeKey, threadId) => {
          const type = getAgentType(typeKey);
          switch (type.key) {
            case "flowix":
              return get().loadThread(threadId);
            case "codex":
              return get().loadCodexThread(threadId);
            case "claude":
              return get().loadClaudeThread(threadId);
            case "hermes":
              return get().loadHermesThread(threadId);
            default:
              return get().loadThread(threadId);
          }
        },

        loadLocalAgentThreadList: async (typeKey) => {
          const type = getAgentType(typeKey);
          if (
            type.key === "flowix" ||
            type.key === "codex" ||
            type.key === "claude" ||
            type.key === "hermes"
          )
            return;
          try {
            const threads = await listHistoryThreads(type.key);            set((state) => threadListUpdate(state, type.key, threads));
          } catch (err) {
            console.error(`Failed to load ${type.name} thread list:`, err);
          }
        },

        loadThreadCache: async (threadId) => {
          try {
            const page = await getInitialThreadHistory(
              "flowix",
              threadId,
              HISTORY_PAGE_SIZE,
            );
            const messages = filterRenderableHistoryMessages(
              page.messages,
            );
            set((state) => {
              const existing =
                state.threadStates[threadId] ?? emptyThreadState();
              const merged = mergeHistoricalMessages(
                existing.messages,
                messages,
                "flowix",
              );

              return {
                threadStates: {
                  ...state.threadStates,
                  [threadId]: {
                    ...existing,
                    messages: merged,
                    oldestSequence: page.oldestSequence,
                    hasMoreHistory: page.hasMore,
                  },
                },
              };
            });
          } catch (err) {
            console.error("Failed to load thread cache:", err);
          }
        },

        loadMoreHistory: async (typeKey, threadId) => {
          const type = getAgentType(typeKey);
          const existing = get().threadStates[threadId];
          if (
            !existing ||
            existing.loadingMore ||
            !existing.hasMoreHistory ||
            existing.oldestSequence === null
          ) {
            return;
          }

          set((state) => {
            const current = state.threadStates[threadId];
            if (!current || current.loadingMore) return state;
            return {
              threadStates: {
                ...state.threadStates,
                [threadId]: {
                  ...current,
                  loadingMore: true,
                },
              },
            };
          });

          try {
            const page = await getHistoryPage(
              type.key,
              threadId,
              existing.oldestSequence,
              HISTORY_PAGE_SIZE,
            );
            const messages = filterRenderableHistoryMessages(page.messages);
            set((state) => {
              const current = state.threadStates[threadId] ?? emptyThreadState();
              const merged = prependHistoricalMessages(
                current.messages,
                messages,
                type.key,
              );
              return {
                threadStates: {
                  ...state.threadStates,
                  [threadId]: {
                    ...current,
                    messages: merged,
                    oldestSequence: page.oldestSequence ?? current.oldestSequence,
                    hasMoreHistory: page.hasMore,
                    loadingMore: false,
                  },
                },
              };
            });
          } catch (err) {
            console.error("Failed to load more thread history:", err);
            set((state) => {
              const current = state.threadStates[threadId];
              if (!current) return state;
              return {
                threadStates: {
                  ...state.threadStates,
                  [threadId]: {
                    ...current,
                    loadingMore: false,
                  },
                },
              };
            });
          }
        },





        deleteThread: async (threadId) => {
          try {
            await agentClient.deleteThread(threadId);
            useAgentConversationStore
              .getState()
              .removeInstancesForThread(threadId);
            set((state) => {
              // 保留 threadStates[threadId] 这个 entry (不删整条, 避免 listener
              // 在 in-flight 流上写入时拿不到 state ─ 视觉抖动), 但清空
              // messages / oldestSequence / hasMoreHistory / loadingMore,
              // 释放大字段 (tool_data 单条 24KB, 几百条消息的累积内存)。
              // runs 也清掉 ─ 这个 thread 已被 SQLite 删了, 历史 run 不再可读。
              // activeRunId / pendingXxxId 清零, 防止 stopStream 后 flush 缓冲
              // 误把文字写到刚删的 thread。
              // 真源 SQLite 已经删了, 重启后也不会再有该 thread 的 entry。
              //
              // `existing` 必然存在 (deleteThread 由 UI 在有 entry 的 thread 上触发,
              // 后端只删存在的 thread), 因此不需要 "无 entry" 兜底分支 ──
              // 那种状态理论可触发但实测不可达, 写成兜底反而模糊语义。
              const existing = state.threadStates[threadId];
              const clearedEntry = {
                ...existing,
                messages: [],
                oldestSequence: null,
                hasMoreHistory: false,
                loadingMore: false,
                runs: {},
                activeRunId: null,
                pendingAssistantId: null,
                pendingReasoningId: null,
                isLoading: false,
                lastRun: undefined,
              };
              const threadStates = {
                ...state.threadStates,
                [threadId]: clearedEntry,
              };
              // `threadTypes[threadId]` 必然存在: thread 进 threadStates 一定要先经过
              // 之一, 这些入口都同时把 threadTypes[threadId] 写进去。 因此下面
              // `deletedType` 直接读 threadTypes, 不再做 prefix-fallback ──
              // 旧版本那条 fallback (chat-store.ts:1423-1429) 还漏写了 codex
              // / claude 两个 prefix, 实际上是个 latent bug + dead code 一体。
              const deletedType = state.threadTypes[threadId];
              const nextThreadList = getThreadListForType(
                state,
                deletedType,
              ).filter((t) => t.threadId !== threadId);
              // 修复 #7: 之前没清 `state.threadTypes[threadId]`, 留下孤儿条目
              // ── 后续 `get().threadTypes[threadId] ?? "flowix"` 仍会拿到
              // 旧 type, 误判 dispatch 路径。 同样清掉 `externalSessionResolutions`
              // 中指向该 thread 的反向映射 (pending → session), 否则 `findByThreadId`
              // 会误命中已删的 thread id。
              const { [threadId]: _removedType, ...nextThreadTypes } =
                state.threadTypes;
              const nextExternalSessionResolutions = Object.fromEntries(
                Object.entries(state.externalSessionResolutions).filter(
                  ([_, resolved]) => resolved !== threadId,
                ),
              );
              return {
                ...threadListUpdate(state, deletedType, nextThreadList),
                threadStates,
                threadTypes: nextThreadTypes,
                externalSessionResolutions: nextExternalSessionResolutions,
                ...(getActiveThreadIdForType(state, deletedType) === threadId
                  ? {
                      ...activeThreadUpdate(state, deletedType, undefined),
                      ...titleUpdate(state, deletedType, undefined),
                    }
                  : {}),
              };
            });
          } catch (err) {
            console.error("Failed to delete thread:", err);
          }
        },

        renameThread: async (threadId, title, typeKey) => {
          const nextTitle = normalizeThreadTitle(title);
          if (!threadId || !nextTitle) return;
          const type = getAgentType(
            typeKey ?? get().threadTypes[threadId] ?? get().activeAgentTypeKey,
          );

          set((state) => {
            const currentList = getThreadListForType(state, type.key);
            return {
              ...titleUpdate(state, type.key, nextTitle),
              ...threadListUpdate(
                state,
                type.key,
                currentList.map((item) =>
                  item.threadId === threadId
                    ? { ...item, title: nextTitle }
                    : item,
                ),
              ),
              threadTypes: {
                ...state.threadTypes,
                [threadId]: type.key,
              },
            };
          });

          if (!canPersistThreadTitle(type.key)) return;

          try {
            await agentClient.updateThreadTitle(threadId, nextTitle, type.key);
            if (type.key === "flowix") {
              await get().loadThreadList();
            } else {
              await get().loadLocalAgentThreadList(type.key);
            }
          } catch (err) {
            console.error("Failed to update thread title:", err);
          }
        },

        renameAgentConversation: async ({ instanceId, threadId, title, typeKey }) => {
          const nextTitle = normalizeThreadTitle(title);
          if (!nextTitle) return;
          const instanceStore = useAgentConversationStore.getState();
          const instance =
            instanceStore.getInstance(instanceId) ??
            (threadId ? instanceStore.findByThreadId(threadId) : null);

          if (instance) {
            instanceStore.renameInstance(instance.instanceId, nextTitle);
          }

          const targetThreadId = threadId ?? instance?.threadId ?? null;
          if (targetThreadId) {
            await get().renameThread(
              targetThreadId,
              nextTitle,
              typeKey ?? instance?.agentType,
            );
          }
        },

        sendMessageToThread: async (threadId, content, typeKey, options) => {
          const trimmed = content.trim();
          if (!threadId || !trimmed) return;
          const type = getAgentType(
            typeKey ?? get().threadTypes[threadId] ?? get().activeAgentTypeKey,
          );
          get().bindThreadType(threadId, type.key);

          const isFirstMessage =
            options?.isFirstMessage ?? getRenderableMessageCount(threadId) === 0;
          // Agent Role 文档 (首条消息才追加): caller 已经在 await 路径里
          // 拉好 memo body 后通过 options.agentRoleBody 传入。 这里只
          // 负责拼接到 user 消息末尾 ── body 为空 / 没拉到时传 null,
          // appendFirstMessageContext 静默跳过, 不污染 user 消息。
          const { userPayload, llmContent, userMessage } = prepareUserMessage({
            content: trimmed,
            isFirstMessage,
            agentType: type.key,
            currentNoteContent: options?.currentNoteContent,
            agentRoleMemoId: options?.agentRoleMemoId,
            agentRoleName: options?.agentRoleName,
            agentRoleBody: options?.agentRoleBody ?? null,
          });
          const runId = createRunId(threadId);

          set((state) => {
            const st = state.threadStates[threadId] ?? emptyThreadState();
            const startedAt = Date.now();
            const eventBase: AgentEvent = {
              kind: "stream_start",
              agentType: type.key,
              threadId,
              runId,
              timestamp: startedAt,
            };
            const nextThreadState = applyOptimisticUserRun(
              st,
              eventBase,
              userMessage,
            );
            const nextThreadTypes = {
              ...state.threadTypes,
              [threadId]: type.key,
            };
            return {
              threadTypes: nextThreadTypes,
              ...threadRunUpdate(
                { ...state, threadTypes: nextThreadTypes },
                threadId,
                nextThreadState,
              ),
            };
          });
          syncThreadRenderableMessages(
            type.key,
            threadId,
            get().threadStates[threadId]?.messages ?? [],
          );
          if (options?.instanceId) {
            useAgentConversationStore.getState().updateThread(options.instanceId, {
              threadId,
              agentType: type.key,
            });
            useAgentConversationStore.getState().markRunStarted(options.instanceId, {
              runId,
              startedAt: Date.now(),
            });
          }

          try {
            await dispatchChatStream({
              threadId,
              content: trimmed,
              llmContent,
              runId,
              userPayload,
              agentType: type.key,
              permissionMode: get().agentPermissionMode,
              codexModel: get().agentCodexModel,
              codexReasoningEffort: get().agentCodexReasoningEffort,
              agentRoleMemoId: options?.agentRoleMemoId,
              agentRoleName: options?.agentRoleName,
            });
          } catch (err) {
            console.error("Failed to dispatch thread card chat_stream:", err);
            const errorMessage = createSendErrorMessage(
              err,
              translate(getLanguage(), "agent.chat.sendFailed"),
            );
            set((state) => {
              const st = state.threadStates[threadId] ?? emptyThreadState();
              const nextThreadState = {
                ...st,
                isLoading: false,
                activeRunId: null,
                pendingAssistantId: null,
                pendingReasoningId: null,
                messages: [...st.messages, errorMessage],
              };
              syncThreadRenderableMessages(
                type.key,
                threadId,
                nextThreadState.messages,
              );
              return {
                ...threadRunUpdate(
                  state,
                  threadId,
                  releaseThreadRuntimeMessages(nextThreadState),
                ),
              };
            });
          }
        },


        stopStream: async () => {
          const type = getAgentType(get().activeAgentTypeKey);
          const activeId = getActiveThreadIdForType(get(), type.key);
          if (!activeId) return;
          await get().stopThreadRun(activeId);
        },

        stopThreadRun: async (threadId, runId) => {
          if (!threadId) return;
          // Layer 2: 停流前先 flush 流式缓冲 ── 否则缓冲里残留的 token
          // 会在下一帧 rAF 被 apply 到刚停的 thread, 形成"已停但又冒一段
          // 文字出来"的撕裂. 同步 flush 后再发 stopChatStream IPC, 后端
          // emit StreamEnd 收敛 isLoading.
          streamingBuffer.flushSync();
          let targetRunId: string | undefined;
          set((state) => {
            const st = state.threadStates[threadId];
            if (!st) return state;
            targetRunId = runId ?? st.activeRunId ?? undefined;
            if (!targetRunId || !st.runs[targetRunId]) return state;
            const type = getAgentType(
              state.threadTypes[threadId] ?? state.activeAgentTypeKey,
            );
            const nextThreadState = applyRunStopped(
              st,
              targetRunId,
              Date.now(),
            );
            recordAgentStopRequested(threadId, targetRunId, type.key);
            return {
              ...threadRunUpdate(state, threadId, nextThreadState),
            };
          });
          // 修复 #9: 之前 `targetRunId` 早 return 后仍发 IPC, 后端走
          // thread-wide stop 兜底 ── 是浪费, 且本地 store 的 applyRunStopped
          // 在 set() 早 return 时没跑, 用户看不到"已停"的视觉反馈。
          // targetRunId 未解析时仍发 thread-wide stop 兜底。Codex/Claude 等
          // 外部 runtime 可能已经从 pending id 迁移到真实 session id, 本地
          // activeRunId 缺失不代表后端没有对应 child process。
          try {
            const type = getAgentType(
              get().threadTypes[threadId] ?? get().activeAgentTypeKey,
            );
            await agentClient.stopChatStream(threadId, type.key, targetRunId);
          } catch (err) {
            console.error("Failed to stop stream:", err);
          }
          // 不手动 set isLoading=false ── 等后端 `flush_cancel` 走完后
          // emit `StreamEnd` chunk, dispatchAgentChunk 收敛。 这样跨
          // 后台 / 前台 thread 行为统一, 不会出现"后端还在 flush 但 UI
          // 已经停了"的撕裂。
        },

        dispatchAgentEvent: (event) => {
          const tid = event.threadId;
          const currentThreadState =
            get().threadStates[tid] ?? emptyThreadState();
          recordAgentLifecycleEvent(event, {
            activeRunId: currentThreadState.activeRunId,
            isLoading: currentThreadState.isLoading,
          });

          // Layer 2: text / reasoning 走 rAF 节流; 其它 chunk 进入前先同步
          // flush 缓冲, 保证后端发出的顺序 (text → tool_call → text →
          // tool_result → text) 在 UI 上呈现的顺序与时序一致.
          //
          // 节流粒度: rAF (~16ms = 60fps). 一帧内多次 text chunk 合并成
          // 一次 setState, 把"每个 token 触发整 messages 数组 spread +
          // 所有子组件 re-render" 收敛到"每帧最多一次". 文本最终内容
          // 完全等价 ── 缓冲只是把 N 段 token 拼成一段, applyTextChunk
          // 的语义不变.
          switch (event.kind) {
            case "text_delta": {
              // 跳过纯空白 chunk ── 与旧 chat-store.ts:322 同形.
              if (!event.text || !event.text.trim()) return;
              const current = get().threadStates[tid] ?? emptyThreadState();
              if (!isThreadRunActive(current)) {
                set((state) => {
                  const nextThreadState = ensureRunActive(
                    state.threadStates[tid] ?? emptyThreadState(),
                    event,
                  );
                  return {
                    ...threadRunUpdate(state, tid, nextThreadState),
                  };
                });
              }
              streamingBuffer.appendText(tid, event.text);
              return;
            }
            case "reasoning_delta": {
              const current = get().threadStates[tid] ?? emptyThreadState();
              if (!isThreadRunActive(current)) {
                set((state) => {
                  const nextThreadState = ensureRunActive(
                    state.threadStates[tid] ?? emptyThreadState(),
                    event,
                  );
                  return {
                    ...threadRunUpdate(state, tid, nextThreadState),
                  };
                });
              }
              streamingBuffer.appendReasoning(tid, event.text);
              return;
            }
            case "final_message":
            case "tool_call":
            case "tool_result":
            case "error":
            case "stream_end":
            case "session_resolved":
              // 这些 chunk 频率低且必须立刻可见, 不走节流;
              // 但必须先 flush 缓冲, 否则文本顺序错乱 ──
              // 例: 一段 assistant 文本被 tool_call 切走时,
              // 缓冲里残留的文字应该先落到 pending assistant,
              // 再让 tool_call 走 close 逻辑.
              streamingBuffer.flushSync();
              break;
            // stream_start 无需 flush ── 流刚开始时缓冲必空.
            case "stream_start":
            case "usage":
              // stream_start / usage 无需 flush, 不影响消息缓冲
              break;
          }

          if (event.kind !== "usage") {
            syncConversationInstanceForEvent(
              event,
              get().threadStates[tid] ?? emptyThreadState(),
            );
          }

          set((state) => {
            const st = ensureRunActive(
              state.threadStates[tid] ?? emptyThreadState(),
              event,
            );
            switch (event.kind) {
              case "session_resolved": {
                if (!event.sessionId || event.sessionId === tid) return state;
                const resolved = applyExternalSessionResolved(
                  state,
                  tid,
                  event.sessionId,
                  event.agentType,
                  (existing, incoming) =>
                    mergeHistoricalMessages(
                      existing,
                      incoming,
                      event.agentType,
                    ),
                  emptyThreadState,
                );
                return {
                  ...activeThreadUpdate(
                    state,
                    event.agentType,
                    event.sessionId,
                  ),
                  // session_resolved 跨 runtime 入口 ── 显式设 activeAgentTypeKey
                  // (修复 #12: activeThreadUpdate 不再带这个副作用)。
                  activeAgentTypeKey: event.agentType,
                  threadTypes: resolved.threadTypes,
                  externalSessionResolutions:
                    resolved.externalSessionResolutions,
                  threadStates: resolved.threadStates,
                };
              }
              case "stream_start": {
                // 通用 metadata 协议 ── model / reasoningEffort 从 event 透传,
                // 写入 runs[runId].model / runs[runId].reasoningEffort,
                // 供 hover card / 状态栏读取。runId 可能与 st.activeRunId 不同
                // (chunk 自带 run_id 优先),upsertRun 会按 event.runId 落盘。
                const nextThreadState = applyRunStarted(st, event, {
                  model: event.model,
                  modelId: event.model,
                  lastRunAt: event.timestamp,
                  reasoningEffort: event.reasoningEffort,
                });
                const nextThreadTypes = {
                  ...state.threadTypes,
                  [tid]: event.agentType,
                };
                return {
                  threadTypes: nextThreadTypes,
                  ...threadRunUpdate(
                    { ...state, threadTypes: nextThreadTypes },
                    tid,
                    nextThreadState,
                  ),
                };
              }
              case "stream_end": {
                const nextThreadState = applyRunEnded(st, event);
                const instanceStore = useAgentConversationStore.getState();
                instanceStore.syncRenderableMessages(
                  event.agentType,
                  tid,
                  nextThreadState.messages,
                );
                const eventInstance =
                  instanceStore.findByRunId(event.runId) ??
                  instanceStore.findByThreadId(event.threadId);
                const usagePatch = conversationUsagePatchFromState(
                  nextThreadState,
                  event.runId,
                );
                if (eventInstance && usagePatch) {
                  instanceStore.updateRun(eventInstance.instanceId, usagePatch);
                }
                const runtimeThreadState = nextThreadState.isLoading
                  ? nextThreadState
                  : releaseThreadRuntimeMessages(nextThreadState);
                return {
                  ...threadRunUpdate(state, tid, runtimeThreadState),
                };
              }
              case "usage": {
                // 通用 metadata 协议 ── 累加 token 到 runs[runId].tokenUsage。
                const nextThreadState = applyRunUsage(st, event);
                return {
                  ...threadRunUpdate(state, tid, nextThreadState),
                };
              }
              case "final_message": {
                const next = applyTextChunk(st, event.text);
                const nextThreadState = {
                  ...applyRunToolState(st, event, null),
                  messages: next.messages,
                  pendingAssistantId: next.pendingAssistantId,
                  pendingReasoningId: null,
                };
                syncThreadRenderableMessages(
                  event.agentType,
                  tid,
                  nextThreadState.messages,
                );
                return {
                  ...threadRunUpdate(state, tid, nextThreadState),
                };
              }
              case "tool_call": {
                const next = applyToolCallChunk(
                  st,
                  event.toolCallId,
                  event.name,
                  event.input,
                  event.agentType,
                  event.display,
                );
                const nextThreadState = {
                  ...applyRunToolState(st, event, event.name),
                  messages: next.messages,
                  pendingAssistantId: null, // tool_call 之后到 tool_result 之前的 assistant 行不连续, 重置
                };
                syncThreadRenderableMessages(
                  event.agentType,
                  tid,
                  nextThreadState.messages,
                );
                return {
                  ...threadRunUpdate(state, tid, nextThreadState),
                };
              }
              case "tool_result": {
                const next = applyToolResultChunk(
                  st,
                  event.toolCallId,
                  event.name,
                  event.result,
                );
                const nextThreadState = {
                  ...applyRunToolState(st, event, null),
                  messages: next.messages,
                };
                syncThreadRenderableMessages(
                  event.agentType,
                  tid,
                  nextThreadState.messages,
                );
                return {
                  ...threadRunUpdate(state, tid, nextThreadState),
                };
              }
              case "error": {
                const next = applyErrorChunk(st, event.message);
                const nextThreadState = {
                  ...applyRunFailed(st, event, event.message),
                  messages: next.messages,
                };
                useAgentConversationStore
                  .getState()
                  .syncRenderableMessages(
                    event.agentType,
                    tid,
                    nextThreadState.messages,
                  );
                const runtimeThreadState = nextThreadState.isLoading
                  ? nextThreadState
                  : releaseThreadRuntimeMessages(nextThreadState);
                return {
                  ...threadRunUpdate(state, tid, runtimeThreadState),
                };
              }
              default:
                return state;
            }
          });
        },

        dispatchAgentChunk: (chunk) => {
          const event = mapAgentChunkToEvent(chunk, get());
          recordAgentChunkMapped(chunk, event);
          get().dispatchAgentEvent(event);
        },

        reconcileRunningRunsFromSnapshot: (running) => {
          const now = Date.now();
          const state = get();
          const instanceStore = useAgentConversationStore.getState();
          for (const [threadId, info] of Object.entries(running)) {
            const type = getAgentType(
              info.agentType ?? state.threadTypes[threadId] ?? state.activeAgentTypeKey,
            );
            const runId =
              info.runId ??
              state.threadStates[threadId]?.activeRunId ??
              createRunId(threadId);
            const instance = ensureConversationInstanceForThread(
              threadId,
              type.key,
              getConversationTitleForThread(state, type.key, threadId),
              info.runId,
            );
            instanceStore.markRunStarted(instance.instanceId, {
              runId,
              startedAt: info.startedAt || now,
              currentTool: info.currentTool ?? null,
            });
          }
          instanceStore.markRunningMissingFromSnapshotEnded(running, now);
          set((state) =>
            reconcileThreadStatesFromRunningSnapshot(state, running, now),
          );
        },

        reconcileRunningRuns: async () => {
          const running = await agentClient.runningThreads();
          get().reconcileRunningRunsFromSnapshot(running);
        },
      };
    },
    {
      name: STORAGE_KEYS.CHAT,
      // 不 persist `threadStates` ── 真源是 SQLite, 缓存持久化反而
      // 引入双源漂移。 仅 persist 新字段 `activeThreadIds` /
      // `currentThreadTitles` / `threadTypes` ── 旧 `activeThreadId` /
      // `currentThreadTitle` 等 legacy 字段已冻结, 不再写入
      // (迁移逻辑放在 `merge` 里处理一次性兼容)。
      partialize: (state) => ({
        activeThreadIds: state.activeThreadIds,
        activeAgentTypeKey: state.activeAgentTypeKey,
        threadTypes: state.threadTypes,
        currentThreadTitles: state.currentThreadTitles,
        agentPermissionMode: state.agentPermissionMode,
        agentCodexModel: state.agentCodexModel,
        agentCodexReasoningEffort: state.agentCodexReasoningEffort,
        // 外部 runtime (Codex / Claude / Gemini / Hermes / OpenClaw) 的
        // pending → session 映射 ── 不持久化的话, 进程重启后到达的 chunk
        // 会因为 `resolveExternalChunkThreadId` 找不到 mapping 而走 fallback
        // 落到 `chunk.thread_id`, 如果 CLI 后续用的是 resolved session_id
        // (而非 pending local id), chunk 就会被错路由。
        externalSessionResolutions: state.externalSessionResolutions,
      }),
      merge: (persisted, current) => {
        const persistedState = persisted as Partial<ChatStore> | undefined;
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
        // 避免让 ChatStore 持有"只能被 merge 读到"的孤儿字段 ── 见下文
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

        const activeThreadIds: AgentTypeMap<string | undefined> = {
          ...(persistedState?.activeThreadIds ?? {}),
          flowix:
            persistedState?.activeThreadIds?.flowix ?? legacyFlowixThreadId,
          codex:
            persistedState?.activeThreadIds?.codex ?? legacyCodexThreadId,
          claude:
            persistedState?.activeThreadIds?.claude ?? legacyClaudeThreadId,
        };
        const currentThreadTitles: AgentTypeMap<string | undefined> = {
          ...(persistedState?.currentThreadTitles ?? {}),
          flowix:
            persistedState?.currentThreadTitles?.flowix ?? legacyFlowixTitle,
          codex:
            persistedState?.currentThreadTitles?.codex ?? legacyCodexTitle,
          claude:
            persistedState?.currentThreadTitles?.claude ?? legacyClaudeTitle,
        };
        const threadLists: AgentTypeMap<ThreadListItem[]> = {
          ...(persistedState?.threadLists ?? {}),
          flowix: persistedState?.threadLists?.flowix ?? legacyFlowixList ?? [],
          codex: persistedState?.threadLists?.codex ?? legacyCodexList ?? [],
          claude:
            persistedState?.threadLists?.claude ?? legacyClaudeList ?? [],
        };
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
      },
    },
    ),
  ),
);

/**
 * 未发送草稿单条上限 ── 16 KB 字符 (≈ 16K 字符, 远大于任何合理 prompt,
/**
 * 草稿 map 软上限 ── localStorage 单 key ~5MB, 但实战希望更紧。 200 条
 * 路径远大于普通用户的活跃文档数; 超过按插入顺序淘汰最早条目 (Object
 * key 顺序在现代引擎中即插入顺序)。 淘汰期间会 console.warn 一次, 给
 * 排查"为什么切回来发现没草稿"留线索。
 */

// ───────────────────────── Layer 2: 流式 chunk rAF 节流 ─────────────────────
//
// 后端 `agent.rs:1128-1148` 是每个 LLM token 一次 emit, 典型 100-300
// chunk/s. 直接每个 chunk 调 zustand `set` 会让 messages 数组引用每帧
// 重建多次, 配合 Layer 1 的 React.memo 虽然能跳过历史消息子树,
// 但 store 自身的订阅 + selector 比较仍会被频繁触发. rAF 节流把它压到
// 60fps 上限, 主线程消耗骤减.
//
// 缓冲设计: 每个 thread_id 一个 string buffer (按 thread 分桶, 不同 thread
// 后台并跑互不干扰). flush 时把每个 thread 的累积文本一次性 apply ──
// applyTextChunk 内部 `m.content + text` 与多次 append 等价, 不影响最终内容.
//
// 顺序保证: tool_call/result/error/stream_end 进入 dispatchAgentChunk 时
// **同步** 先 flush 缓冲, 保证 "text → tool_call" 的顺序在 UI 上不错乱.

const streamingBuffer = createStreamingBuffer((textSnapshot, reasoningSnapshot) => {
  const syncedThreads: Array<{
    threadId: string;
    agentType: AgentTypeKey;
    messages: ChatMessage[];
  }> = [];
  useChatStore.setState((state) => {
    const threadStates: ThreadsMap = { ...state.threadStates };
    // reasoning 先 apply ── 与旧 store 时序一致 (reasoning chunk 先于
    // text 出现; text chunk 落地时会 close reasoning 行). 但 rAF 内
    // 两者可能同帧到达, 用 reasoning-first 顺序保证 close 语义正确.
    for (const [tid, text] of reasoningSnapshot) {
      const st = threadStates[tid];
      // thread 已被清掉 (切换 / 删除) ── 直接丢弃缓冲, 与"chunk 到达时
      // thread 已无对应 state"行为一致.
      if (!st) continue;
      const next = applyReasoningChunk(st, text);
      threadStates[tid] = {
        ...st,
        messages: next.messages,
        pendingReasoningId: next.pendingReasoningId,
      };
      syncedThreads.push({
        threadId: tid,
        agentType: getAgentType(state.threadTypes[tid] ?? state.activeAgentTypeKey)
          .key,
        messages: next.messages,
      });
    }
    for (const [tid, text] of textSnapshot) {
      const st = threadStates[tid];
      if (!st) continue;
      const next = applyTextChunk(st, text);
      threadStates[tid] = {
        ...st,
        messages: next.messages,
        pendingAssistantId: next.pendingAssistantId,
        pendingReasoningId: null, // text 落地后 reasoning 行 closed
      };
      syncedThreads.push({
        threadId: tid,
        agentType: getAgentType(state.threadTypes[tid] ?? state.activeAgentTypeKey)
          .key,
        messages: next.messages,
      });
    }
    return { threadStates };
  });
  for (const { agentType, threadId, messages } of syncedThreads) {
    syncThreadRenderableMessages(agentType, threadId, messages);
  }
});

function shouldEnsureRunActive(event: AgentEvent): boolean {
  return (
    event.kind === "text_delta" ||
    event.kind === "final_message" ||
    event.kind === "reasoning_delta" ||
    event.kind === "tool_call" ||
    event.kind === "tool_result"
  );
}

function isThreadRunActive(st: ThreadState): boolean {
  return (
    st.isLoading &&
    !!st.activeRunId &&
    st.runs[st.activeRunId]?.status === "running"
  );
}

function ensureRunActive(st: ThreadState, event: AgentEvent): ThreadState {
  if (!shouldEnsureRunActive(event)) return st;
  if (isThreadRunActive(st)) return st;
  return applyRunStarted(st, {
    kind: "stream_start",
    agentType: event.agentType,
    threadId: event.threadId,
    runId: event.runId,
    timestamp: event.timestamp,
  });
}

// ============================================================
// 顶层 listener 注册 ── App.tsx 一次性挂载。
// ============================================================
//
// 这段 IIFE 模块加载时跑, 把 `dispatchAgentChunk` 桥接到 listenToAgentChunks:
// - 两窗口 (主窗口 / 偏好窗口) 都 import 这个模块, 但 listenToAgentChunks
//   内部用 `streamUnlisten` 短路, 第二个调用直接 return ── 不会重复挂载。
// - `useAgentEvents` 在 App.tsx 顶层显式挂一次, 卸载时 unlisten。
// - `dispatchAgentChunk` 通过 zustand store 派发, 跨组件共享状态。
//
// 这里保留一段 `installAgentChunkBridge` 暴露, 给 `useAgentEvents` 调用;
// 内部直接 import store 派发, 避免 `client.ts` 反向依赖 store (会形成
// 循环引用: store → client → store)。

let bridgeInstalled = false;
export function installAgentChunkBridge(): void {
  if (bridgeInstalled) return;
  bridgeInstalled = true;
  void listenToAgentChunks((chunk) => {
    useChatStore.getState().dispatchAgentChunk(chunk);
  });
}
