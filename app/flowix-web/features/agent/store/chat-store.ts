import { create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";
import type { ThreadListItem } from "@/types";
import type {
  AgentChunk,
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentEvent,
  AgentPermissionMode,
  AgentTypeKey,
  RunInfo,
  RuntimeConfig,
} from "@/types/agent";
import type { LiveMessageState } from "@features/agent/store/chunk-result";
import { STORAGE_KEYS } from "@/lib/constants";
import { translate } from "@features/i18n";
import { applyExternalSessionResolved } from "@features/agent/store/external-session";
import { agentClient, listenToAgentChunks } from "@features/agent/store/agent-client";
import {
  applyOptimisticUserRun,
  createSendErrorMessage,
  prepareUserMessage,
} from "@features/agent/store/user-message";
import { dispatchChatStream } from "@features/agent/store/chat-stream";
import { createLoadThreadActions } from "@features/agent/store/load-thread-actions";
import {
  createRunId,
  mapAgentChunkToEvent,
} from "@features/agent/events/agent-event-mapper";
import {
  recordAgentChunkMapped,
  recordAgentStopRequested,
} from "@features/agent/diagnostics/agent-run-trace";
import {
  applyRunStarted,
  applyRunStopped,
} from "@features/agent/store/run-lifecycle";
import {
  useAgentConversationStore,
} from "@features/agent/store/agent-conversation-store";
import {
  emptyThreadState,
  releaseThreadRuntimeMessages,
  threadRunUpdate,
  type ThreadsMap,
} from "@features/agent/store/thread-runtime-state";
import {
  ensureConversationInstanceForThread,
} from "@features/agent/store/conversation-run-sync";
import {
  createStreamEventDispatcher,
  type StreamEventDispatcher,
} from "@features/agent/store/stream-event-dispatcher";
import {
  reconcileThreadStatesFromRunningSnapshot,
} from "@features/agent/store/snapshot-reconcile";

import {
  canPersistThreadTitle,
  defaultExternalThreadTitle,
  getConversationTitleForThread,
  getLanguage,
  normalizeThreadTitle,
} from "@features/agent/store/thread-titles";
import {
  activeThreadUpdate,
  getActiveThreadIdForType,
  getThreadListForType,
  threadListUpdate,
  titleUpdate,
  type AgentTypeMap,
} from "@features/agent/store/chat-thread-accessors";
import {
  createChatPersister,
  type ChatPersistShape,
} from "@features/agent/store/chat-store-migration";

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
// 注: normalizeAgentTypeKey / DEFAULT_AGENT_TYPE_KEY / isAgentTypeSelectable
// 在此文件中仍直接使用 (reconcile 路径 / activeAgentTypeKey 默认值 /
//   setActiveAgentTypeKey 守门)。

export { threadRunUpdate } from "@features/agent/store/thread-runtime-state";
export type { ThreadState, ThreadsMap } from "@features/agent/store/thread-runtime-state";
export { emptyThreadState } from "@features/agent/store/thread-runtime-state";

function syncThreadLiveMessageState(
  agentType: AgentTypeKey,
  threadId: string,
  liveState: LiveMessageState,
): void {
  useAgentConversationStore
    .getState()
    .syncLiveMessageState(agentType, threadId, liveState);
}

/**
 * chat-store 只持有运行时 ChatStore 形状。localStorage 持久化
 * (partialize / merge 配对) 在 chat-store-migration.ts。
 */

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
      runtimeConfig?: RuntimeConfig | null;
      imagePaths?: string[];
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
   * 全局 `agent-chunk` 派发器 ── 由 `useAgentEvents` 在 app.tsx 顶层
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
  reconcileRunningRuns: () => Promise<Record<string, RunInfo>>;
}

export const useChatStore = create<ChatStore>()(
  subscribeWithSelector(
    persist(
    (set, get) => {
      const loadActions = createLoadThreadActions(
        (updater) => set(updater),
        () => get() as ChatStore,
      );

      // 流式事件派发器 ── 阶段 6 抽离到这里, 把 rAF 缓冲 + reducer 调度 +
      // conversation 投影三件事合并成一个对象, chat-store action 只保留
      // 薄入口。 闭包捕获 set/get, 不反向 import 自身, 避免循环引用。
      const streamDispatcher: StreamEventDispatcher = createStreamEventDispatcher({
        getChatSlice: () => {
          const s = get();
          return {
            threadStates: s.threadStates,
            threadTypes: s.threadTypes,
            activeAgentTypeKey: s.activeAgentTypeKey,
            externalSessionResolutions: s.externalSessionResolutions,
            activeThreadIds: s.activeThreadIds,
          };
        },
        applyPatch: (patch) => set(patch as Partial<ChatStore>),
      });

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
          useAgentConversationStore
            .getState()
            .resolveSessionByThreadId(fromThreadId, toThreadId, type.key);
          // 与 session_resolved chunk / backend snapshot 共用同一个 runtime
          // 迁移入口 ── session_resolved 走 dispatcher.applyEventToChatSlice,
          // snapshot 走 snapshot-reconcile.reconcileThreadStatesFromRunningSnapshot,
          // 这里也调 external-session.ts 的 applyExternalSessionResolved 保证
          // threadTypes / externalSessionResolutions / 兼容映射只在一处实现。
          set((state) => {
            const resolved = applyExternalSessionResolved(
              state,
              fromThreadId,
              toThreadId,
              type.key,
            );
            return {
              ...resolved,
              ...activeThreadUpdate(state, type.key, toThreadId),
              // 跨 runtime resolve (e.g. Codex local id → session_id) ──
              // 同步 activeAgentTypeKey 让 sendMessageToThread 路由到正确 runtime。
              activeAgentTypeKey: type.key,
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

        loadThreadList: loadActions.loadThreadList,
        loadThread: loadActions.loadThread,

        loadCodexThreadList: loadActions.loadCodexThreadList,
        loadCodexThread: loadActions.loadCodexThread,

        loadClaudeThreadList: loadActions.loadClaudeThreadList,
        loadClaudeThread: loadActions.loadClaudeThread,

        loadHermesThreadList: loadActions.loadHermesThreadList,
        loadHermesThread: loadActions.loadHermesThread,

        loadAgentThread: loadActions.loadAgentThread,

        loadLocalAgentThreadList: loadActions.loadLocalAgentThreadList,

        loadThreadCache: async (threadId) => {
          try {
            await useAgentConversationStore
              .getState()
              .loadMessages("flowix", threadId);
            set((state) => {
              const existing =
                state.threadStates[threadId] ?? emptyThreadState();
              return {
                threadStates: {
                  ...state.threadStates,
                  [threadId]: existing,
                },
              };
            });
          } catch (err) {
            console.error("Failed to load thread cache:", err);
          }
        },

        loadMoreHistory: async (typeKey, threadId) => {
          const type = getAgentType(typeKey);
          await useAgentConversationStore
            .getState()
            .loadMoreMessages(type.key, threadId);
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
          if (!threadId || (!trimmed && !options?.imagePaths?.length)) return;
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
              threadStates: threadRunUpdate(
                state.threadStates,
                threadId,
                nextThreadState,
              ),
            };
          });
          const optimisticThreadState = get().threadStates[threadId];
          if (optimisticThreadState) {
            syncThreadLiveMessageState(
              type.key,
              threadId,
              optimisticThreadState,
            );
          }
          if (options?.instanceId) {
            useAgentConversationStore.getState().updateThread(options.instanceId, {
              threadId,
              agentType: type.key,
            });
            // 首次 send: 把 instance.files 烧录成只读真值 ── 见
            // agent-conversation-store.lockInstanceFileSeed 的注释。
            // 之后再调 setRuntimeConfig / buildInitialInstanceRuntimeConfig 都
            // 不再影响 instance.files, 上次设的偏好成为下次新建 instance 的种子
            // (selectLatestFrozenFileSeed) 锁定在这里。
            // isFirstMessage 的判断与 `getRenderableMessageCount === 0` 同源
            // (chat-store.ts:543), 这里用它 (而不是 rely 双源) 避免 race。
            if (isFirstMessage) {
              useAgentConversationStore
                .getState()
                .lockInstanceFileSeed(options.instanceId);
            }
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
              runtimeConfig: options?.runtimeConfig ?? undefined,
              imagePaths: options?.imagePaths,
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
              syncThreadLiveMessageState(type.key, threadId, nextThreadState);
              return {
                threadStates: threadRunUpdate(
                  state.threadStates,
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
          streamDispatcher.flushBuffer();
          let targetRunId: string | undefined;
          let stoppedAt: number | null = null;
          set((state) => {
            const st = state.threadStates[threadId];
            if (!st) return state;
            targetRunId = runId ?? st.activeRunId ?? undefined;
            if (!targetRunId || !st.runs[targetRunId]) return state;
            stoppedAt = Date.now();
            const type = getAgentType(
              state.threadTypes[threadId] ?? state.activeAgentTypeKey,
            );
            const nextThreadState = applyRunStopped(
              st,
              targetRunId,
              stoppedAt,
            );
            recordAgentStopRequested(threadId, targetRunId, type.key);
            return {
              threadStates: threadRunUpdate(
                state.threadStates,
                threadId,
                nextThreadState,
              ),
            };
          });
          if (targetRunId && stoppedAt !== null) {
            const instanceStore = useAgentConversationStore.getState();
            const instance =
              instanceStore.findByRunId(targetRunId) ??
              instanceStore.findByThreadId(threadId);
            if (instance) {
              instanceStore.markRunEnded(
                instance.instanceId,
                "cancelled",
                stoppedAt,
                "cancelled",
              );
            }
          }
          // 修复 #9: 之前 `targetRunId` 早 return 后仍发 IPC, 后端走
          // thread-wide stop 兜底 ── 是浪费, 且本地 store 的 applyRunStopped
          // 在 set() 早 return 时没跑, 用户看不到"已停"的视觉反馈。
          // targetRunId 未解析时仍发 thread-wide stop 兜底。Codex/Claude 等
          // 外部 runtime 可能已经从 local id 迁移到真实 session id, 本地
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
          streamDispatcher.dispatch(event);
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
            const localThreadId = info.pendingThreadId || threadId;
            const canonicalThreadId = info.sessionId || threadId;
            const type = getAgentType(
              info.agentType ??
                state.threadTypes[canonicalThreadId] ??
                state.threadTypes[localThreadId] ??
                state.activeAgentTypeKey,
            );
            if (info.sessionId && localThreadId !== canonicalThreadId) {
              instanceStore.resolveSessionByThreadId(
                localThreadId,
                canonicalThreadId,
                type.key,
              );
            }
            const runId =
              info.runId ??
              state.threadStates[canonicalThreadId]?.activeRunId ??
              state.threadStates[localThreadId]?.activeRunId ??
              createRunId(canonicalThreadId);
            const instance = ensureConversationInstanceForThread(
              canonicalThreadId,
              type.key,
              normalizeThreadTitle(
                getConversationTitleForThread(
                  state,
                  type.key,
                  canonicalThreadId,
                ),
              ),
              info.runId,
              {
                // 保留 instance 已有 title ── 当 caller 传入的 title 就是
                // 当前 instance 的 default title 时 (典型场景: 之前快照
                // 把空 thread 升级成默认 "Codex 会话" 后, 又再次收到同
                // thread 的 snapshot), 不覆盖 instance.title。
                defaultTitle: defaultExternalThreadTitle(type.key),
              },
            );
            instanceStore.markRunStarted(instance.instanceId, {
              runId,
              startedAt: info.startedAt || now,
              currentTool: info.currentTool ?? null,
            });
          }
          instanceStore.markRunningMissingFromSnapshotEnded(running, now);
          set((state) =>
            reconcileThreadStatesFromRunningSnapshot(
              state,
              running,
              now,
              (st, info, runId) => {
                const startedAt = info.startedAt || now;
                const canonicalThreadId =
                  info.sessionId || info.pendingThreadId || runId;
                const agentType = normalizeAgentTypeKey(
                  info.agentType ?? state.threadTypes[canonicalThreadId],
                ) as AgentTypeKey;
                return applyRunStarted(
                  st,
                  {
                    kind: "stream_start",
                    agentType,
                    threadId: canonicalThreadId,
                    runId,
                    timestamp: startedAt,
                  },
                  {
                    startedAt,
                    currentTool: info.currentTool ?? null,
                  },
                );
              },
            ),
          );
        },

        reconcileRunningRuns: async () => {
          const running = await agentClient.runningThreads();
          get().reconcileRunningRunsFromSnapshot(running);
          return running;
        },
      };
    },
    {
      name: STORAGE_KEYS.CHAT,
      // 持久化配置 ── schema 详见 chat-store-migration.ts。 这里只透传
      // 一对 partialize / merge, 不再关心字段白名单 / legacy 字段折算。
      ...(() => {
        const persister = createChatPersister();
        return {
          partialize: (state: ChatStore) =>
            persister.partialize(state as unknown as ChatPersistShape),
          merge: (persisted: unknown, current: ChatStore): ChatStore =>
            persister.merge(
              persisted,
              current as unknown as ChatPersistShape,
            ) as unknown as ChatStore,
        };
      })(),
    },
    ),
  ),
);

// ============================================================
// Window-level listener registration.
// ============================================================
//
// Each content-capable Webview (main / tab-host) owns an independent module
// realm and Zustand store. AgentWindowEffects acquires this once in each
// realm; reference counting keeps StrictMode/HMR mounts balanced while the
// underlying event bus still owns only one native Tauri listener.
//
// The shared event bus retries transient Tauri listen failures while this
// logical subscription remains active. Dispatch stays here to avoid a reverse
// dependency from client.ts to the store.

let bridgeReferences = 0;
let bridgeUnlisten: (() => void) | null = null;
let bridgeReady = false;
const bridgeReadyHandlers = new Set<() => void>();

function notifyAgentChunkBridgeReady(): void {
  bridgeReady = true;
  for (const handler of [...bridgeReadyHandlers]) handler();
}

/** Acquire this Webview's single agent-chunk projection bridge. */
export function acquireAgentChunkBridge(onReady?: () => void): () => void {
  bridgeReferences += 1;
  if (onReady) bridgeReadyHandlers.add(onReady);

  if (!bridgeUnlisten) {
    bridgeUnlisten = listenToAgentChunks(
      (chunk) => useChatStore.getState().dispatchAgentChunk(chunk),
      { onListenerReady: notifyAgentChunkBridgeReady },
    );
  } else if (bridgeReady && onReady) {
    queueMicrotask(() => {
      if (bridgeReadyHandlers.has(onReady)) onReady();
    });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (onReady) bridgeReadyHandlers.delete(onReady);
    bridgeReferences = Math.max(0, bridgeReferences - 1);
    if (bridgeReferences > 0) return;

    bridgeUnlisten?.();
    bridgeUnlisten = null;
    bridgeReady = false;
    bridgeReadyHandlers.clear();
  };
}
