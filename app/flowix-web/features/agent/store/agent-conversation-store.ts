import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { ChatMessage } from "@/types";
import type {
  AgentTypeKey,
  FilesConfig,
  RuntimeConfig,
  RuntimeConfigPatch,
} from "@/types/agent";
import type {
  AgentConversationInstance as BackendAgentConversationInstance,
} from "@platform/tauri/client";
import { stripSystemBlock } from "@features/agent/message";
import { agentClient } from "@features/agent/store/agent-client";
import type { LiveMessageState } from "@features/agent/store/chunk-result";
import { buildInitialInstanceRuntimeConfig } from "@features/agent/store/initial-runtime-config";
import type { ThreadsMap } from "@features/agent/store/thread-runtime-state";
import {
  filterRenderableHistoryMessages,
  getHistoryPage,
  getInitialThreadHistory,
  HISTORY_PAGE_SIZE,
  mergeLiveMessagesIntoRenderableMessages,
  mergeHistoricalMessages,
  prependHistoricalMessages,
} from "@features/agent/store/thread-history";

export type AgentConversationSource = {
  kind: "thread-card";
  documentPath?: string | null;
  memoId?: string | null;
};

export interface AgentConversationRole {
  memoId?: string | null;
  name?: string | null;
}

export interface AgentConversationInstance {
  instanceId: string;
  agentType: AgentTypeKey;
  title: string;
  threadId: string | null;
  runtimeConfig?: RuntimeConfig | null;
  source: AgentConversationSource;
  role?: AgentConversationRole | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentConversationMessageState extends LiveMessageState {
  oldestSequence: number | null;
  hasMoreHistory: boolean;
  loadingInitial: boolean;
  loadingMore: boolean;
}

export interface CreateAgentConversationInstanceInput {
  agentType: AgentTypeKey;
  title: string;
  threadId?: string | null;
  runtimeConfig?: RuntimeConfig | null;
  source: AgentConversationSource;
  role?: AgentConversationRole;
}

export interface AgentConversationStore {
  instances: Record<string, AgentConversationInstance>;
  messageStates: Record<string, AgentConversationMessageState>;
  hydrateFromBackend: () => Promise<void>;
  createInstance: (
    input: CreateAgentConversationInstanceInput,
  ) => AgentConversationInstance;
  upsertInstance: (
    instanceId: string,
    patch: Partial<Omit<AgentConversationInstance, "instanceId" | "createdAt">>,
  ) => AgentConversationInstance;
  setRuntimeConfig: (instanceId: string, patch: RuntimeConfigPatch) => void;
  lockInstanceFileSeed: (instanceId: string) => AgentConversationInstance | null;
  getInstance: (instanceId: string | null | undefined) => AgentConversationInstance | null;
  updateThread: (
    instanceId: string,
    patch: {
      threadId?: string | null;
      agentType?: AgentTypeKey;
    },
  ) => void;
  renameInstance: (instanceId: string, title: string) => void;
  removeInstance: (instanceId: string) => void;
  removeInstancesForThread: (threadId: string) => void;
  resolveSessionByThreadId: (
    localThreadId: string,
    sessionId: string,
    agentType: AgentTypeKey,
  ) => string | null;
  findByThreadId: (threadId: string) => AgentConversationInstance | null;
  getMessageState: (
    threadId: string | null | undefined,
  ) => AgentConversationMessageState | null;
  mergeMessages: (
    agentType: AgentTypeKey,
    threadId: string,
    messages: ChatMessage[],
  ) => void;
  syncRenderableMessages: (
    agentType: AgentTypeKey,
    threadId: string,
    messages: ChatMessage[],
  ) => void;
  syncLiveMessageState: (
    agentType: AgentTypeKey,
    threadId: string,
    liveState: LiveMessageState,
  ) => void;
  resetMessageStates: (threadIds: string[]) => void;
  loadMessages: (agentType: AgentTypeKey, threadId: string) => Promise<void>;
  loadMoreMessages: (agentType: AgentTypeKey, threadId: string) => Promise<void>;
}

let instanceSeq = 0;

function createInstanceId(now = Date.now()): string {
  instanceSeq += 1;
  return `agent-inst-${now}-${instanceSeq}`;
}

function touch<T extends AgentConversationInstance>(instance: T): T {
  return { ...instance, updatedAt: Date.now() };
}

function matchesThread(instance: AgentConversationInstance, threadId: string): boolean {
  return instance.threadId === threadId;
}

function emptyMessageState(): AgentConversationMessageState {
  return {
    messages: [],
    pendingAssistantId: null,
    pendingReasoningId: null,
    oldestSequence: null,
    hasMoreHistory: false,
    loadingInitial: false,
    loadingMore: false,
  };
}

function parseRuntimeConfigSnapshot(
  value: BackendAgentConversationInstance["runtimeConfig"] | RuntimeConfig | null | undefined,
): RuntimeConfig | null {
  if (!value) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as RuntimeConfig;
  } catch {
    return null;
  }
}

function serializeRuntimeConfigSnapshot(
  value: RuntimeConfig | null | undefined,
): string | null {
  if (!value || Object.keys(value).length === 0) return null;
  return JSON.stringify(value);
}

function mergeRuntimeConfig(
  current: RuntimeConfig | null | undefined,
  patch: RuntimeConfigPatch,
): RuntimeConfig {
  const merged: RuntimeConfig = { ...(current ?? {}) };
  for (const key of Object.keys(patch) as (keyof RuntimeConfig)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

function normalizeBackendInstance(
  instance: AgentConversationInstance | BackendAgentConversationInstance,
): AgentConversationInstance {
  return {
    ...instance,
    runtimeConfig: parseRuntimeConfigSnapshot(instance.runtimeConfig),
    role: instance.role ?? undefined,
  };
}

function toBackendInstance(
  instance: AgentConversationInstance,
): BackendAgentConversationInstance {
  return {
    ...instance,
    runtimeConfig: serializeRuntimeConfigSnapshot(instance.runtimeConfig),
  };
}

function normalizeConversationTitle(title: string | null | undefined): string {
  return stripSystemBlock(title ?? "").replace(/\s+/g, " ").trim();
}

const instanceWriteQueues = new Map<string, Promise<void>>();

/**
 * hydrate 鍚庢壂涓€閬? 缁?runtime_config 鏄┖ / 涓嶅叏鐨?instance 鍐欎竴浠? * 褰撳墠 global store 鐨勫揩鐓? 鍚屼竴 instance 鍚庣画 sendMessageToThread
 * 鎷垮埌 `conversation.instance.runtimeConfig` 鏃? cwd 宸茬粡鏈夊€? 涓嶅啀
 * 渚濊禆 buildAgentRuntimeConfig 鐨勫厹搴曢摼.
 *
 * 娉ㄦ剰: 浠呭湪 files 涓虹┖ OR files.workspace 涓虹┖鏃?backfill. 鑻ョ敤鎴? * 宸茬粡鍦?settings popover 閲屾墜鍔ㄦ敼杩?runtime_config (cwd/files 涓? * 鏄┖), 涓嶅姩瀹? 閬垮厤瑕嗙洊鐢ㄦ埛閰嶇疆.
 */
function backfillMissingRuntimeConfig(
  backendInstances: BackendAgentConversationInstance[],
): void {
  const initialByType = new Map<
    AgentConversationInstance["agentType"],
    ReturnType<typeof buildInitialInstanceRuntimeConfig>
  >();
  const tryBackfill = (agentType: AgentConversationInstance["agentType"]) => {
    let initial = initialByType.get(agentType);
    if (!initial) {
      initial = buildInitialInstanceRuntimeConfig(agentType);
      initialByType.set(agentType, initial);
    }
    return initial;
  };
  for (const backend of backendInstances) {
    const parsed = parseRuntimeConfigSnapshot(backend.runtimeConfig);
    const filesEmpty =
      !parsed?.files ||
      (!parsed.files.workspace &&
        (!parsed.files.folders || parsed.files.folders.length === 0) &&
        (!parsed.files.notebooks || parsed.files.notebooks.length === 0));
    const cwdMissing = !parsed?.cwd;
    if (!filesEmpty && !cwdMissing) continue;
    const seed = tryBackfill(backend.agentType);
    // 鑷冲皯瑕佹妸 cwd 鍐欏埌椤跺眰, 杩欐牱 resetRuntimeConfig(null) + 鍚庣画 set 鍙互鏁戝洖.
    useAgentConversationStore.getState().setRuntimeConfig(
      backend.instanceId,
      seed,
    );
  }
}

function enqueueInstanceWrite(
  instanceId: string,
  task: () => Promise<void>,
  label: string,
): void {
  const previous = instanceWriteQueues.get(instanceId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(task)
    .catch((err) => {
      console.error(`[AgentConversation] Failed to ${label}:`, err);
    })
    .finally(() => {
      if (instanceWriteQueues.get(instanceId) === next) {
        instanceWriteQueues.delete(instanceId);
      }
    });
  instanceWriteQueues.set(instanceId, next);
}

function persistInstance(instance: AgentConversationInstance): void {
  enqueueInstanceWrite(
    instance.instanceId,
    () => agentClient.upsertConversationInstance(toBackendInstance(instance)).then(() => undefined),
    "persist instance",
  );
}

function deletePersistedInstance(instanceId: string): void {
  enqueueInstanceWrite(
    instanceId,
    () => agentClient.deleteConversationInstance(instanceId).then(() => undefined),
    "delete instance",
  );
}

function deletePersistedInstancesForThread(threadId: string): void {
  void agentClient.deleteConversationInstancesForThread(threadId).catch((err) => {
    console.error("[AgentConversation] Failed to delete thread instances:", err);
  });
}

export const useAgentConversationStore = create<AgentConversationStore>()(
  subscribeWithSelector(
    (set, get) => ({
      instances: {},
      messageStates: {},

      hydrateFromBackend: async () => {
        try {
          const instances = await agentClient.listConversationInstances();
          set((state) => {
            const next = { ...state.instances };
            for (const instance of instances) {
              const normalized = normalizeBackendInstance(instance);
              const existing = next[normalized.instanceId];
              if (!existing || normalized.updatedAt >= existing.updatedAt) {
                next[normalized.instanceId] = normalized;
              }
            }
            return { instances: next };
          });
          // Backfill 鑰?instance 鐨?runtime_config 鈹€鈹€ 涔嬪墠 createInstance
          // 娌″～, DB 閲岃繖浜涜 runtime_config = NULL, 閲嶅惎鍚?chat-stream.ts
          // 鐨?buildAgentRuntimeConfig 鍏滃簳閾惧彲鑳藉叏鏂?(selectedNotebook /
          // agent-access 鍚姩 race 绐楀彛). 鐢ㄥ綋鍓?global store 鐨勭湡鍊煎悓姝?          // 鍥炲～涓€娆? 鐒跺悗钀?SQLite, 涔嬪悗 cwd 涓嶅啀渚濊禆 store hydrate 鏃跺簭.
          backfillMissingRuntimeConfig(instances);
        } catch (err) {
          console.error("[AgentConversation] Failed to hydrate instances:", err);
        }
      },

      createInstance: (input) => {
        const now = Date.now();
        const instance: AgentConversationInstance = {
          instanceId: createInstanceId(now),
          agentType: input.agentType,
          title: normalizeConversationTitle(input.title),
          threadId: input.threadId ?? null,
          runtimeConfig: input.runtimeConfig ?? null,
          source: input.source,
          role: input.role,
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({
          instances: {
            ...state.instances,
            [instance.instanceId]: instance,
          },
        }));
        persistInstance(instance);
        return instance;
      },

      upsertInstance: (instanceId, patch) => {
        const now = Date.now();
        let nextInstance!: AgentConversationInstance;
        set((state) => {
          const existing = state.instances[instanceId];
          nextInstance = {
            instanceId,
            agentType: patch.agentType ?? existing?.agentType ?? "flowix",
            title:
              patch.title !== undefined
                ? normalizeConversationTitle(patch.title)
                : existing?.title ?? "",
            threadId: patch.threadId ?? existing?.threadId ?? null,
            runtimeConfig:
              patch.runtimeConfig !== undefined
                ? patch.runtimeConfig
                : existing?.runtimeConfig ?? null,
            source: patch.source ?? existing?.source ?? { kind: "thread-card" },
            role: patch.role ?? existing?.role,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          };
          return {
            instances: {
              ...state.instances,
              [instanceId]: nextInstance!,
            },
          };
        });
        persistInstance(nextInstance!);
        return nextInstance!;
      },

      setRuntimeConfig: (instanceId, patch) => {
        let nextInstance: AgentConversationInstance | null = null;
        set((state) => {
          const existing = state.instances[instanceId];
          if (!existing) return state;
          const mergedConfig = mergeRuntimeConfig(
            existing.runtimeConfig,
            patch,
          );
          // _frozen 鏄唴閮ㄥ喕缁撴爣璁? 涓嶈兘琚閮?patch 璇垹 鈹€鈹€ 浠呭湪 lockInstanceFileSeed
          // 鏄惧紡璋冪敤鏃惰 true, 鍏跺畠璺緞淇濇寔 sticky.
          if (existing.runtimeConfig?.files?._frozen) {
            mergedConfig.files = {
              ...(mergedConfig.files ?? { folders: [], notebooks: [] }),
              _frozen: true,
            };
          }
          nextInstance = touch({
            ...existing,
            runtimeConfig: mergedConfig,
          });
          return {
            instances: {
              ...state.instances,
              [instanceId]: nextInstance!,
            },
          };
        });
        if (nextInstance) persistInstance(nextInstance);
      },

      lockInstanceFileSeed: (instanceId) => {
        let nextInstance: AgentConversationInstance | null = null;
        set((state) => {
          const existing = state.instances[instanceId];
          if (!existing) return state;
          const files = existing.runtimeConfig?.files;
          if (!files) return state;
          // 宸茬粡鍐荤粨杩囧氨涓嶈鏃犳剰涔夐噸鍐?鈹€鈹€ 鍚屼竴 thread 鍦?retry 璺緞涓嬪彲鑳?          // 绗簩娆¤繘 sendMessageToThread, 杩欓噷idempotent.
          if (files._frozen) return state;
          nextInstance = touch({
            ...existing,
            runtimeConfig: {
              ...existing.runtimeConfig,
              files: {
                ...files,
                _frozen: true,
              },
            },
          });
          return {
            instances: {
              ...state.instances,
              [instanceId]: nextInstance!,
            },
          };
        });
        if (nextInstance) persistInstance(nextInstance);
        return nextInstance;
      },

      getInstance: (instanceId) =>
        instanceId ? get().instances[instanceId] ?? null : null,

      updateThread: (instanceId, patch) => {
        let nextInstance: AgentConversationInstance | null = null;
        set((state) => {
          const existing = state.instances[instanceId];
          if (!existing) return state;
          nextInstance = touch({
            ...existing,
            agentType: patch.agentType ?? existing.agentType,
            threadId:
              patch.threadId !== undefined ? patch.threadId : existing.threadId,
          });
          return {
            instances: {
              ...state.instances,
              [instanceId]: nextInstance!,
            },
          };
        });
        if (nextInstance) persistInstance(nextInstance);
      },

      renameInstance: (instanceId, title) => {
        const nextTitle = normalizeConversationTitle(title);
        if (!nextTitle) return;
        let nextInstance: AgentConversationInstance | null = null;
        set((state) => {
          const existing = state.instances[instanceId];
          if (!existing || existing.title === nextTitle) return state;
          nextInstance = touch({ ...existing, title: nextTitle });
          return {
            instances: {
              ...state.instances,
              [instanceId]: nextInstance!,
            },
          };
        });
        if (nextInstance) persistInstance(nextInstance);
      },

      removeInstance: (instanceId) => {
        set((state) => {
          if (!state.instances[instanceId]) return state;
          const { [instanceId]: _removed, ...instances } = state.instances;
          return { instances };
        });
        deletePersistedInstance(instanceId);
      },

      removeInstancesForThread: (threadId) => {
        const removedIds: string[] = [];
        set((state) => {
          const instances = Object.fromEntries(
            Object.entries(state.instances).filter(([instanceId, instance]) => {
              const remove = matchesThread(instance, threadId);
              if (remove) removedIds.push(instanceId);
              return !remove;
            }),
          );
          if (
            Object.keys(instances).length === Object.keys(state.instances).length &&
            !state.messageStates[threadId]
          ) {
            return state;
          }
          const { [threadId]: _removedMessages, ...messageStates } =
            state.messageStates;
          return { instances, messageStates };
        });
        for (const instanceId of removedIds) {
          deletePersistedInstance(instanceId);
        }
        deletePersistedInstancesForThread(threadId);
      },

      resolveSessionByThreadId: (localThreadId, sessionId, agentType) => {
        const instance = get().findByThreadId(localThreadId);
        if (instance) {
          get().updateThread(instance.instanceId, {
            agentType,
            threadId: sessionId,
          });
        }
        set((state) => {
          const localMessages = state.messageStates[localThreadId];
          if (!localMessages) return state;
          const existing = state.messageStates[sessionId] ?? emptyMessageState();
          const { [localThreadId]: _removed, ...rest } = state.messageStates;
          return {
            messageStates: {
              ...rest,
              [sessionId]: {
                ...existing,
                messages: mergeHistoricalMessages(
                  existing.messages,
                  localMessages.messages,
                  agentType,
                ),
                pendingAssistantId:
                  existing.pendingAssistantId ?? localMessages.pendingAssistantId,
                pendingReasoningId:
                  existing.pendingReasoningId ?? localMessages.pendingReasoningId,
                oldestSequence: existing.oldestSequence ?? localMessages.oldestSequence,
                hasMoreHistory:
                  existing.hasMoreHistory || localMessages.hasMoreHistory,
                loadingInitial:
                  existing.loadingInitial || localMessages.loadingInitial,
                loadingMore: existing.loadingMore || localMessages.loadingMore,
              },
            },
          };
        });
        return instance?.instanceId ?? null;
      },

      findByThreadId: (threadId) =>
        Object.values(get().instances).find((instance) =>
          matchesThread(instance, threadId),
        ) ?? null,

      getMessageState: (threadId) =>
        threadId ? get().messageStates[threadId] ?? null : null,

      mergeMessages: (agentType, threadId, messages) => {
        const renderable = filterRenderableHistoryMessages(messages);
        if (renderable.length === 0) return;
        set((state) => {
          const current = state.messageStates[threadId] ?? emptyMessageState();
          const merged = mergeHistoricalMessages(
            current.messages,
            renderable,
            agentType,
          );
          if (merged === current.messages) return state;
          return {
            messageStates: {
              ...state.messageStates,
              [threadId]: {
                ...current,
                messages: merged,
              },
            },
          };
        });
      },

      syncRenderableMessages: (agentType, threadId, messages) => {
        const renderable = filterRenderableHistoryMessages(messages);
        if (renderable.length === 0) return;
        set((state) => {
          const current = state.messageStates[threadId] ?? emptyMessageState();
          const merged = mergeLiveMessagesIntoRenderableMessages(
            current.messages,
            renderable,
            agentType,
          );
          if (merged === current.messages) return state;
          return {
            messageStates: {
              ...state.messageStates,
              [threadId]: {
                ...current,
                messages: merged,
              },
            },
          };
        });
      },

      syncLiveMessageState: (agentType, threadId, liveState) => {
        const renderable = filterRenderableHistoryMessages(liveState.messages);
        set((state) => {
          const current = state.messageStates[threadId] ?? emptyMessageState();
          const merged =
            renderable.length > 0
              ? mergeLiveMessagesIntoRenderableMessages(
                  current.messages,
                  renderable,
                  agentType,
                )
              : current.messages;
          if (
            merged === current.messages &&
            current.pendingAssistantId === liveState.pendingAssistantId &&
            current.pendingReasoningId === liveState.pendingReasoningId
          ) {
            return state;
          }
          return {
            messageStates: {
              ...state.messageStates,
              [threadId]: {
                ...current,
                messages: merged,
                pendingAssistantId: liveState.pendingAssistantId,
                pendingReasoningId: liveState.pendingReasoningId,
              },
            },
          };
        });
      },

      resetMessageStates: (threadIds) => {
        const uniqueThreadIds = Array.from(new Set(threadIds.filter(Boolean)));
        if (uniqueThreadIds.length === 0) return;
        set((state) => {
          const messageStates = { ...state.messageStates };
          for (const threadId of uniqueThreadIds) {
            messageStates[threadId] = emptyMessageState();
          }
          return { messageStates };
        });
      },

      loadMessages: async (agentType, threadId) => {
        set((state) => {
          const current = state.messageStates[threadId] ?? emptyMessageState();
          if (current.loadingInitial) return state;
          return {
            messageStates: {
              ...state.messageStates,
              [threadId]: {
                ...current,
                loadingInitial: true,
              },
            },
          };
        });

        try {
          const page = await getInitialThreadHistory(
            agentType,
            threadId,
            HISTORY_PAGE_SIZE,
          );
          const messages = filterRenderableHistoryMessages(page.messages);
          set((state) => {
            const current = state.messageStates[threadId] ?? emptyMessageState();
            const merged = mergeHistoricalMessages(
              current.messages,
              messages,
              agentType,
            );
            return {
              messageStates: {
                ...state.messageStates,
                [threadId]: {
                  ...current,
                  messages: merged,
                  oldestSequence: page.oldestSequence,
                  hasMoreHistory: page.hasMore,
                  loadingInitial: false,
                },
              },
            };
          });
        } catch (err) {
          console.error("[AgentConversation] Failed to load messages:", err);
          set((state) => {
            const current = state.messageStates[threadId];
            if (!current) return state;
            return {
              messageStates: {
                ...state.messageStates,
                [threadId]: {
                  ...current,
                  loadingInitial: false,
                },
              },
            };
          });
        }
      },

      loadMoreMessages: async (agentType, threadId) => {
        const current = get().messageStates[threadId];
        if (
          !current ||
          current.loadingMore ||
          !current.hasMoreHistory ||
          current.oldestSequence === null
        ) {
          return;
        }

        set((state) => {
          const next = state.messageStates[threadId];
          if (!next || next.loadingMore) return state;
          return {
            messageStates: {
              ...state.messageStates,
              [threadId]: {
                ...next,
                loadingMore: true,
              },
            },
          };
        });

        try {
          const page = await getHistoryPage(
            agentType,
            threadId,
            current.oldestSequence,
            HISTORY_PAGE_SIZE,
          );
          const messages = filterRenderableHistoryMessages(page.messages);
          set((state) => {
            const next = state.messageStates[threadId] ?? emptyMessageState();
            const merged = prependHistoricalMessages(
              next.messages,
              messages,
              agentType,
            );
            return {
              messageStates: {
                ...state.messageStates,
                [threadId]: {
                  ...next,
                  messages: merged,
                  oldestSequence: page.oldestSequence ?? next.oldestSequence,
                  hasMoreHistory: page.hasMore,
                  loadingMore: false,
                },
              },
            };
          });
        } catch (err) {
          console.error("[AgentConversation] Failed to load more messages:", err);
          set((state) => {
            const next = state.messageStates[threadId];
            if (!next) return state;
            return {
              messageStates: {
                ...state.messageStates,
                [threadId]: {
                  ...next,
                  loadingMore: false,
                },
              },
            };
          });
        }
      },
    }),
  ),
);

export function selectAgentConversationRunStatus(
  instance: AgentConversationInstance | null | undefined,
  threadStates: ThreadsMap,
): "running" | "completed" | "failed" | "cancelled" | null {
  const threadId = instance?.threadId;
  if (!threadId) return null;
  const state = threadStates[threadId];
  if (!state) return null;
  const activeRun = state.activeRunId ? state.runs[state.activeRunId] : undefined;
  return activeRun?.status ?? state.lastRun?.status ?? null;
}

export function selectIsAgentConversationRunning(
  instance: AgentConversationInstance | null | undefined,
  threadStates: ThreadsMap,
): boolean {
  return selectAgentConversationRunStatus(instance, threadStates) === "running";
}

export function selectRunningAgentConversationInstances(
  state: Pick<AgentConversationStore, "instances">,
  threadStates: ThreadsMap,
): AgentConversationInstance[] {
  return Object.values(state.instances)
    .filter((instance) => selectIsAgentConversationRunning(instance, threadStates))
    .sort((a, b) => {
      const aRun = a.threadId ? threadStates[a.threadId]?.activeRunId : null;
      const bRun = b.threadId ? threadStates[b.threadId]?.activeRunId : null;
      const aStartedAt = a.threadId && aRun ? threadStates[a.threadId]?.runs[aRun]?.startedAt ?? 0 : 0;
      const bStartedAt = b.threadId && bRun ? threadStates[b.threadId]?.runs[bRun]?.startedAt ?? 0 : 0;
      return aStartedAt - bStartedAt;
    });
}

export function selectRunningAgentConversationThreadIds(
  state: Pick<AgentConversationStore, "instances">,
  threadStates: ThreadsMap,
): string[] {
  const threadIds = new Set<string>();
  for (const instance of selectRunningAgentConversationInstances(state, threadStates)) {
    if (instance.threadId) threadIds.add(instance.threadId);
  }
  return Array.from(threadIds);
}

/**
 * "涓婃璁捐繃鐨勫亸濂? 蹇収 鈹€鈹€ 鏂板缓 instance 鏃?`buildInitialInstanceRuntimeConfig`
 * 鍚屾璇诲畠浣滀负 workspace 绉嶅瓙鐨勬潵婧?
 *   - 鎵炬渶杩戜竴涓?`runtimeConfig.files._frozen === true` 鐨?instance (鎸?updatedAt 鍊掑簭)
 *   - 鍙寫鍑?files.workspace / .folders / .notebooks 杩欎笁涓瓧娈? 涓嶆幒鏉? *     model / access / reasoning 绛夊叾瀹冨瓧娈? *   - 鎵句笉鍒板喕缁?instance 鏃惰繑鍥?null, 涓婃父 cascade 閫€鍒?selectedNotebook +
 *     agent-access-store firstEnabledFolder 鍏滃簳
 *
 * 鎰忓浘: 鐢ㄦ埛鍦?instance A 涓婅皟鏁翠富绌洪棿/folder 鍒楄〃鍚? 杩樻病鍙戞秷鎭箣鍓嶈繖浜涘€? * 涓嶈兘钀藉埌鍏ㄥ眬 `useAgentAccessStore`, 浣嗕笅涓€鏉?instance B 搴斿綋鑳芥劅鐭ュ埌 --
 * 鍚﹀垯 B 閲嶆柊璧?buildInitialInstanceRuntimeConfig 灏卞彧鑳界敤 cascade 鍏滃簳
 * (寰堝彲鑳芥嬁鍒?selectedNotebook 杩欑"鍏ㄥ眬"鍊?, 涓?A 鐢ㄦ埛鐨勬湰鎰忎笉涓€鑷淬€? */
export function selectLatestFrozenFileSeed(
  state: Pick<AgentConversationStore, "instances">,
): FilesConfig | null {
  let best: AgentConversationInstance | null = null;
  for (const id of Object.keys(state.instances)) {
    const instance = state.instances[id];
    if (!instance) continue;
    if (!instance.runtimeConfig?.files?._frozen) continue;
    if (best === null || instance.updatedAt > best.updatedAt) {
      best = instance;
    }
  }
  if (!best) return null;
  const files = best.runtimeConfig?.files;
  if (!files) return null;
  // 鍓ュ嚭 cwd 鍐崇瓥蹇呴渶鐨勪笁涓瓧娈? _frozen 鏍囪鏈韩涓嶅啀浼犻€?鈹€鈹€ 鎺ユ敹绔柊寤?  // instance 鏃朵笉搴旇鏄?frozen 鐘舵€? 蹇呴』鐢遍鏉?send 鏃跺啀娆?lock銆?
  return {
    workspace: files.workspace,
    folders: files.folders,
    notebooks: files.notebooks,
  };
}




