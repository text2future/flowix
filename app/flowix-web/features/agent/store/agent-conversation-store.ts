import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { ChatMessage } from "@/types";
import type {
  AgentTypeKey,
  RuntimeConfig,
  RuntimeConfigPatch,
  StatusInfo,
  UsageInfo,
} from "@/types/agent";
import type {
  AgentConversationInstance as BackendAgentConversationInstance,
} from "@platform/tauri/client";
import { stripSystemBlock } from "@features/agent/message";
import { agentClient } from "@features/agent/store/agent-client";
import { buildInitialInstanceRuntimeConfig } from "@features/agent/store/initial-runtime-config";
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

export interface AgentConversationRun {
  runId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  endedAt?: number | null;
  currentTool?: string | null;
  model?: string | null;
  modelId?: string | null;
  reasoningEffort?: string | null;
  lastRunAt?: number | null;
  reason?: string | null;
  /** Nested token usage — see [`UsageInfo`] in `@/types/agent`. */
  usage?: UsageInfo | null;
  /** Provider-specific status snapshot — see [`StatusInfo`] in `@/types/agent`. */
  statusInfo?: StatusInfo | null;
}

export interface AgentConversationInstance {
  instanceId: string;
  agentType: AgentTypeKey;
  title: string;
  threadId: string | null;
  runtimeConfig?: RuntimeConfig | null;
  source: AgentConversationSource;
  role?: AgentConversationRole | null;
  run?: AgentConversationRun | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentConversationMessageState {
  messages: ChatMessage[];
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
  getInstance: (instanceId: string | null | undefined) => AgentConversationInstance | null;
  updateThread: (
    instanceId: string,
    patch: {
      threadId?: string | null;
      agentType?: AgentTypeKey;
    },
  ) => void;
  renameInstance: (instanceId: string, title: string) => void;
  markRunStarted: (
    instanceId: string,
    run: Omit<AgentConversationRun, "status">,
  ) => void;
  markRunEnded: (
    instanceId: string,
    status: Exclude<AgentConversationRun["status"], "running">,
    endedAt: number,
    reason?: string | null,
  ) => void;
  updateRun: (
    instanceId: string,
    patch: Partial<Omit<AgentConversationRun, "runId" | "startedAt">>,
  ) => void;
  removeInstance: (instanceId: string) => void;
  removeInstancesForThread: (threadId: string) => void;
  markRunningMissingFromSnapshotEnded: (
    running: Record<
      string,
      { runId?: string | null; agentType?: AgentTypeKey | null }
    >,
    endedAt: number,
  ) => void;
  resolveSessionByThreadId: (
    localThreadId: string,
    sessionId: string,
    agentType: AgentTypeKey,
  ) => string | null;
  findByThreadId: (threadId: string) => AgentConversationInstance | null;
  findByRunId: (runId: string) => AgentConversationInstance | null;
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
    run: instance.run ?? undefined,
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
const RUN_PERSIST_DEBOUNCE_MS = 2000;

/**
 * hydrate 后扫一遍, 给 runtime_config 是空 / 不全的 instance 写一份
 * 当前 global store 的快照. 同一 instance 后续 sendMessageToThread
 * 拿到 `conversation.instance.runtimeConfig` 时, cwd 已经有值, 不再
 * 依赖 buildAgentRuntimeConfig 的兜底链.
 *
 * 注意: 仅在 files 为空 OR files.workspace 为空时 backfill. 若用户
 * 已经在 settings popover 里手动改过 runtime_config (cwd/files 不
 * 是空), 不动它, 避免覆盖用户配置.
 */
function backfillMissingRuntimeConfig(
  backendInstances: BackendAgentConversationInstance[],
): void {
  let initial: ReturnType<typeof buildInitialInstanceRuntimeConfig> | null =
    null;
  const tryBackfill = () => {
    if (!initial) {
      initial = buildInitialInstanceRuntimeConfig();
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
    const seed = tryBackfill();
    // 至少要把 cwd 写到顶层, 这样 resetRuntimeConfig(null) + 后续 set 可以救回.
    useAgentConversationStore.getState().setRuntimeConfig(
      backend.instanceId,
      seed,
    );
  }
}

type PendingRunWrite = {
  timer: ReturnType<typeof setTimeout>;
  run: AgentConversationRun;
};

const pendingRunWrites = new Map<string, PendingRunWrite>();

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

function persistRun(instanceId: string, run: AgentConversationRun): void {
  enqueueInstanceWrite(
    instanceId,
    () => agentClient.upsertConversationRunState(instanceId, run),
    "persist run state",
  );
}

function schedulePersistRun(instanceId: string, run: AgentConversationRun): void {
  const existing = pendingRunWrites.get(instanceId);
  if (existing) {
    clearTimeout(existing.timer);
  }

  const timer = setTimeout(() => {
    const pending = pendingRunWrites.get(instanceId);
    if (!pending || pending.timer !== timer) return;
    pendingRunWrites.delete(instanceId);
    persistRun(instanceId, pending.run);
  }, RUN_PERSIST_DEBOUNCE_MS);

  pendingRunWrites.set(instanceId, { timer, run });
}

function flushPersistRun(instanceId: string): void {
  const pending = pendingRunWrites.get(instanceId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRunWrites.delete(instanceId);
  persistRun(instanceId, pending.run);
}

function cancelPersistRun(instanceId: string): void {
  const pending = pendingRunWrites.get(instanceId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRunWrites.delete(instanceId);
}

function shouldPersistRunImmediately(
  patch: Partial<Omit<AgentConversationRun, "runId" | "startedAt">>,
): boolean {
  return (
    patch.status !== undefined ||
    patch.endedAt !== undefined ||
    patch.reason !== undefined
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
          // Backfill 老 instance 的 runtime_config ── 之前 createInstance
          // 没填, DB 里这些行 runtime_config = NULL, 重启后 chat-stream.ts
          // 的 buildAgentRuntimeConfig 兜底链可能全断 (selectedNotebook /
          // agent-access 启动 race 窗口). 用当前 global store 的真值同步
          // 回填一次, 然后落 SQLite, 之后 cwd 不再依赖 store hydrate 时序.
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
            run: patch.run ?? existing?.run,
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
          nextInstance = touch({
            ...existing,
            runtimeConfig: mergeRuntimeConfig(existing.runtimeConfig, patch),
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

      markRunStarted: (instanceId, run) => {
        flushPersistRun(instanceId);
        let nextRun: AgentConversationRun | null = null;
        let nextInstance: AgentConversationInstance | null = null;
        set((state) => {
          const existing = state.instances[instanceId];
          if (!existing) return state;
          nextRun = {
            usage: existing.run?.usage,
            statusInfo: existing.run?.statusInfo,
            ...run,
            status: "running",
          };
          nextInstance = touch({
            ...existing,
            run: nextRun,
          });
          return {
            instances: {
              ...state.instances,
              [instanceId]: nextInstance!,
            },
          };
        });
        if (nextInstance) persistInstance(nextInstance);
        if (nextRun) persistRun(instanceId, nextRun);
      },

      markRunEnded: (instanceId, status, endedAt, reason) => {
        flushPersistRun(instanceId);
        let nextRun: AgentConversationRun | null = null;
        let nextInstance: AgentConversationInstance | null = null;
        set((state) => {
          const existing = state.instances[instanceId];
          if (!existing?.run) return state;
          nextRun = {
            ...existing.run,
            status,
            endedAt,
            reason,
          };
          nextInstance = touch({
            ...existing,
            run: nextRun,
          });
          return {
            instances: {
              ...state.instances,
              [instanceId]: nextInstance!,
            },
          };
        });
        if (nextInstance) persistInstance(nextInstance);
        if (nextRun) persistRun(instanceId, nextRun);
      },

      updateRun: (instanceId, patch) => {
        let nextRun: AgentConversationRun | null = null;
        let nextInstance: AgentConversationInstance | null = null;
        set((state) => {
          const existing = state.instances[instanceId];
          if (!existing?.run) return state;
          nextRun = {
            ...existing.run,
            ...patch,
          };
          nextInstance = touch({
            ...existing,
            run: nextRun,
          });
          return {
            instances: {
              ...state.instances,
              [instanceId]: nextInstance!,
            },
          };
        });
        if (nextInstance) persistInstance(nextInstance);
        if (nextRun) {
          if (shouldPersistRunImmediately(patch)) {
            flushPersistRun(instanceId);
            persistRun(instanceId, nextRun);
          } else {
            schedulePersistRun(instanceId, nextRun);
          }
        }
      },

      removeInstance: (instanceId) => {
        cancelPersistRun(instanceId);
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
          cancelPersistRun(instanceId);
          deletePersistedInstance(instanceId);
        }
        deletePersistedInstancesForThread(threadId);
      },

      markRunningMissingFromSnapshotEnded: (running, endedAt) => {
        const runningRunIds = new Set(
          Object.values(running)
            .map((run) => run.runId)
            .filter((runId): runId is string => Boolean(runId)),
        );
        const runningThreadIds = new Set(Object.keys(running));
        const endedInstances: AgentConversationInstance[] = [];
        set((state) => {
          let changed = false;
          const instances = Object.fromEntries(
            Object.entries(state.instances).map(([instanceId, instance]) => {
              if (instance.run?.status !== "running") {
                return [instanceId, instance];
              }
              const stillRunning =
                runningRunIds.has(instance.run.runId) ||
                (instance.threadId ? runningThreadIds.has(instance.threadId) : false);
              if (stillRunning) return [instanceId, instance];
              changed = true;
              const nextInstance = touch({
                ...instance,
                run: {
                  ...instance.run,
                  status: "failed",
                  endedAt,
                  reason: "missing_from_snapshot",
                },
              });
              endedInstances.push(nextInstance);
              return [
                instanceId,
                nextInstance,
              ];
            }),
          );
          return changed ? { instances } : state;
        });
        for (const instance of endedInstances) {
          persistInstance(instance);
          if (instance.run) persistRun(instance.instanceId, instance.run);
        }
      },

      resolveSessionByThreadId: (localThreadId, sessionId, agentType) => {
        const instance = get().findByThreadId(localThreadId);
        if (!instance) return null;
        get().updateThread(instance.instanceId, {
          agentType,
          threadId: sessionId,
        });
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
        return instance.instanceId;
      },

      findByThreadId: (threadId) =>
        Object.values(get().instances).find((instance) =>
          matchesThread(instance, threadId),
        ) ?? null,

      findByRunId: (runId) =>
        Object.values(get().instances).find(
          (instance) => instance.run?.runId === runId,
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

export function selectRunningAgentConversationInstances(
  state: Pick<AgentConversationStore, "instances">,
): AgentConversationInstance[] {
  return Object.values(state.instances)
    .filter(selectIsAgentConversationRunning)
    .sort((a, b) => (a.run?.startedAt ?? 0) - (b.run?.startedAt ?? 0));
}

export function selectAgentConversationRunStatus(
  instance: AgentConversationInstance | null | undefined,
): AgentConversationRun["status"] | null {
  return instance?.run?.status ?? null;
}

export function selectIsAgentConversationRunning(
  instance: AgentConversationInstance | null | undefined,
): boolean {
  return selectAgentConversationRunStatus(instance) === "running";
}

export function selectRunningAgentConversationThreadIds(
  state: Pick<AgentConversationStore, "instances">,
): string[] {
  const threadIds = new Set<string>();
  for (const instance of selectRunningAgentConversationInstances(state)) {
    if (instance.threadId) threadIds.add(instance.threadId);
  }
  return Array.from(threadIds);
}
