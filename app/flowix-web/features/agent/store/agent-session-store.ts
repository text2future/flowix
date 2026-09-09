/**
 * `useAgentSessionStore` ── agent session 的单一真源.
 *
 * 三 sub-projection: sessionMeta (localStorage) / conversationRegistry
 * (backend SQLite) / threadProjections (in-memory, 派生自 events).
 *
 * 本文件只负责 Zustand 组合、持久化边界和 runtime 编排。各状态域由 slice
 * 实现，但只在这里执行一次 create/persist，因此消息所有权仍保持单一。
 *
 * 完整方案: `/Users/rop/Desktop/Notes/开发任务管理/Agent 消息双写重构方案.md`
 */

import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  subscribeWithSelector,
} from "zustand/middleware";
import type {
  AgentChunk,
  AgentEvent,
  AgentTypeKey,
  RunInfo,
  RuntimeConfig,
} from "@/types/agent";
import { agentClient } from "@features/agent/store/agent-client";
import { DEFAULT_AGENT_TYPE_KEY } from "@/lib/agent-types";
import type { AgentConversationInstance } from "@features/agent/store/agent-conversation-types";
import { type ThreadProjection } from "@features/agent/store/session-reducer";
import { STORAGE_KEYS } from "@/lib/constants";
import {
  getAgentType,
  normalizeAgentTypeKey,
} from "@/lib/agent-types";
import { createStreamEventDispatcher } from "@features/agent/store/stream-event-dispatcher";
import {
  createRunId,
  mapAgentChunkToEvent,
} from "@features/agent/events/agent-event-mapper";
import { completedRunUserMessageId } from "@features/agent/events/message-identity";
import {
  resolveExternalChunkThreadId,
  resolveProductThreadId,
} from "@features/agent/store/external-session";
import { eventMapperStateForChunk } from "@features/agent/store/agent-chunk-routing";
import {
  recordAgentChunkMapped,
  recordAgentStopRequested,
} from "@features/agent/diagnostics/agent-run-trace";
import { createAgentChunkBridge } from "@features/agent/store/agent-chunk-bridge";
import { hasThreadInterest } from "@features/agent/store/thread-interest";
import {
  defaultExternalThreadTitle,
  getConversationTitleForThread,
  getLanguage,
  normalizeThreadTitle,
} from "@features/agent/store/thread-titles";
import { createSendErrorMessage, prepareUserMessage } from "@features/agent/store/user-message";
import { dispatchChatStream } from "@features/agent/store/chat-stream";
import { translate } from "@/lib/i18n";
import { createLogger } from "@/lib/logger";
import { applyRunStopped } from "@features/agent/store/run-lifecycle";
import { buildInitialInstanceRuntimeConfig } from "@features/agent/store/initial-runtime-config";
import { createAgentSessionStateStorage } from "@features/agent/store/window-session-storage";
import { installGlobalAgentSettingsSync } from "@features/agent/store/global-agent-settings-sync";
import { DEFAULT_AGENT_SESSION_META } from "@features/agent/store/session-state";
import { rehydrateSessionMeta } from "@features/agent/store/session-persistence";
import {
  createSessionMetaSlice,
  type SessionMetaSlice,
} from "@features/agent/store/session-meta-slice";
import {
  createProjectionSlice,
  type ProjectionSlice,
} from "@features/agent/store/projection-slice";
import {
  createConversationSlice,
  type ConversationSlice,
} from "@features/agent/store/conversation-slice";
import {
  createThreadHistorySlice,
  type ThreadHistorySlice,
} from "@features/agent/store/thread-history-slice";
import {
  createThreadLifecycleSlice,
  type ThreadLifecycleSlice,
} from "@features/agent/store/thread-lifecycle-slice";

export {
  DEFAULT_AGENT_SESSION_META,
  type AgentConversationRegistry,
  type AgentSessionMeta,
} from "@features/agent/store/session-state";
import {
  projectionToRuns,
  runsToProjectionRuns,
} from "@features/agent/store/session-reducer";

const RUNNING_RUN_OPTIMISTIC_GRACE_MS = 3000;
const RUN_MISSING_FROM_SNAPSHOT_REASON = "missing_from_snapshot";
const logger = createLogger("agent-session-store");

// --------------------------------------------------------------------
// Types
// --------------------------------------------------------------------

export interface AgentSessionStore
  extends SessionMetaSlice,
    ProjectionSlice,
    ConversationSlice,
    ThreadHistorySlice,
    ThreadLifecycleSlice {
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
      agentRoleBody?: string | null;
      runId?: string;
    },
  ) => Promise<void>;
  pendingSteeringMessages: Record<string, PendingSteeringMessage[]>;
  enqueueSteeringMessage: (message: PendingSteeringMessage) => void;
  removeSteeringMessage: (threadId: string, messageId: string) => void;
  removeSteeringMessageByClientId: (threadId: string, clientUserMessageId: string) => void;
  clearPendingSteeringMessages: (threadId: string) => void;
  stopStream: () => Promise<void>;
  stopThreadRun: (threadId: string, runId?: string) => Promise<void>;
  dispatchAgentEvent: (event: AgentEvent) => void;
  flushAgentEventBuffer: () => void;
  dispatchAgentChunk: (chunk: AgentChunk) => void;
  reconcileRunningRunsFromSnapshot: (running: Record<string, RunInfo>) => void;
  reconcileRunningRuns: () => Promise<Record<string, RunInfo>>;
}

export interface PendingSteeringMessage {
  id: string;
  threadId: string;
  content: string;
  imagePaths?: string[];
  options?: Parameters<AgentSessionStore["sendMessageToThread"]>[3];
  queuedAt: number;
  clientUserMessageId?: string;
}

type SessionGet = () => AgentSessionStore;

function ensureConversationInstanceForSession(
  get: SessionGet,
  threadId: string,
  type: AgentTypeKey,
  title: string,
  options?: { defaultTitle?: string },
): AgentConversationInstance {
  const session = get();
  const existing = session.findByThreadId(threadId);
  if (existing) {
    const shouldUpdateTitle =
      title &&
      (!options?.defaultTitle || title !== options.defaultTitle);
    return session.upsertInstance(existing.instanceId, {
      agentType: type,
      ...(shouldUpdateTitle ? { title } : {}),
      threadId,
    });
  }
  return session.createInstance({
    agentType: type,
    title,
    threadId,
    source: { kind: "thread-card" },
    runtimeConfig: buildInitialInstanceRuntimeConfig(type),
  });
}

// --------------------------------------------------------------------
// Store
// --------------------------------------------------------------------

export const useAgentSessionStore = create<AgentSessionStore>()(
  subscribeWithSelector(
    persist(
    (set, get) => {
      const streamDispatcher = createStreamEventDispatcher({
        getProjection: (threadId) => get().threadProjections[threadId],
        getThreadAgentType: (threadId) =>
          get().sessionMeta.threadTypes[threadId] ??
          get().sessionMeta.activeAgentTypeKey,
        resolveThreadId: (threadId) =>
          resolveProductThreadId(
            threadId,
            get().sessionMeta.externalSessionResolutions,
          ),
        canDispatch: (threadId) => !get().threadTombstones[threadId],
        dispatch: (event) => get().dispatch(event),
        applySessionResolved: (event) => get().applySessionResolved(event),
      });
      const clearPendingSteeringForLifecycleEvent = (event: AgentEvent): void => {
        if (event.kind !== "error" && event.kind !== "stream_end") return;
        const state = get();
        const canonicalThreadId = resolveProductThreadId(
          event.threadId,
          state.sessionMeta.externalSessionResolutions,
        );
        const projection = state.threadProjections[canonicalThreadId];
        const activeRunId = projection?.runs.activeRunId;
        // Ignore a delayed lifecycle event from an older run. The reducer
        // uses the same active-run ownership rule for known run ids.
        if (activeRunId && event.runId && activeRunId !== event.runId) return;
        state.clearPendingSteeringMessages(event.threadId);
        if (canonicalThreadId !== event.threadId) {
          state.clearPendingSteeringMessages(canonicalThreadId);
        }
      };
      return ({
        ...createSessionMetaSlice(set, get),
        ...createConversationSlice(set, get),
        ...createProjectionSlice(set),
        ...createThreadHistorySlice(set, get),
        ...createThreadLifecycleSlice(set, get),
        pendingSteeringMessages: {},
        enqueueSteeringMessage: (message) => {
          set((state) => ({
            pendingSteeringMessages: {
              ...state.pendingSteeringMessages,
              [message.threadId]: [
                ...(state.pendingSteeringMessages[message.threadId] ?? []),
                message,
              ],
            },
          }));
        },
        removeSteeringMessage: (threadId, messageId) => {
          set((state) => {
            const current = state.pendingSteeringMessages[threadId] ?? [];
            const next = current.filter((message) => message.id !== messageId);
            if (next.length === current.length) return state;
            const pendingSteeringMessages = { ...state.pendingSteeringMessages };
            if (next.length) pendingSteeringMessages[threadId] = next;
            else delete pendingSteeringMessages[threadId];
            return { pendingSteeringMessages };
          });
        },
        removeSteeringMessageByClientId: (threadId, clientUserMessageId) => {
          const current = get().pendingSteeringMessages[threadId] ?? [];
          const match = current.find((message) => message.clientUserMessageId === clientUserMessageId);
          if (match) get().removeSteeringMessage(threadId, match.id);
        },
        clearPendingSteeringMessages: (threadId) => {
          set((state) => {
            if (!state.pendingSteeringMessages[threadId]) return state;
            const pendingSteeringMessages = { ...state.pendingSteeringMessages };
            delete pendingSteeringMessages[threadId];
            return { pendingSteeringMessages };
          });
        },

        sendMessageToThread: async (threadId, content, typeKey, options) => {
          const trimmed = content.trim();
          if (!threadId || (!trimmed && !options?.imagePaths?.length)) return;
          const state = get();
          const type = getAgentType(
            typeKey ??
              state.sessionMeta.threadTypes[threadId] ??
              state.sessionMeta.activeAgentTypeKey,
          );
          state.bindThreadType(threadId, type.key);
          const isFirstMessage =
            options?.isFirstMessage ??
            (state.threadProjections[threadId]?.messages.length ?? 0) === 0;
          const conversationTitle = normalizeThreadTitle(options?.conversationTitle);
          if (isFirstMessage && conversationTitle) {
            const titleThreadId = resolveProductThreadId(
              threadId,
              state.sessionMeta.externalSessionResolutions,
            );
            state.setSessionMeta((meta) => ({
              ...meta,
              // Thread cards and the conversation detail have their own
              // instance-backed titles. An instance-backed send must never
              // overwrite the runtime fallback title for another thread
              // (otherwise card B can make card A display B's title during
              // fallback/recovery). The main conversation has no instanceId
              // and keeps the existing current-title behavior.
              ...(!options?.instanceId
                ? {
                    currentThreadTitles: {
                      ...meta.currentThreadTitles,
                      [titleThreadId]: conversationTitle,
                    },
                  }
                : {}),
              threadLists: {
                ...meta.threadLists,
                [type.key]: (meta.threadLists[type.key] ?? []).map((item) =>
                  item.threadId === threadId
                    ? { ...item, title: conversationTitle }
                    : item,
                ),
              },
            }));
          }
          const { userPayload, llmContent, userMessage } = prepareUserMessage({
            content: trimmed,
            isFirstMessage,
            agentType: type.key,
            currentNoteContent: options?.currentNoteContent,
            agentRoleMemoId: options?.agentRoleMemoId,
            agentRoleName: options?.agentRoleName,
            agentRoleBody: options?.agentRoleBody ?? null,
            systemReminderDirectory:
              options?.runtimeConfig?.workspaceSnapshot?.notebookPath,
          });
          if (
            (type.key === "codex" || type.key === "deepseek-harness") &&
            get().threadProjections[threadId]?.runs.isLoading
          ) {
            const clientUserMessageId = `flowix-${createRunId(threadId)}`;
            const pendingId = `pending-${clientUserMessageId}`;
            get().enqueueSteeringMessage({
              id: pendingId,
              threadId,
              content: trimmed,
              imagePaths: options?.imagePaths,
              options,
              queuedAt: Date.now(),
              clientUserMessageId,
            });
            try {
              await agentClient.steerChat(threadId, {
                content: trimmed,
                llmContent,
                imagePaths: options?.imagePaths,
                agentType: type.key,
                runtimeConfig: options?.runtimeConfig ?? undefined,
              }, clientUserMessageId);
            } catch (err) {
              get().removeSteeringMessage(threadId, pendingId);
              logger.error("Failed to steer Codex turn", { error: String(err) });
              get().dispatch({
                kind: "error",
                agentType: type.key,
                threadId,
                runId: get().threadProjections[threadId]?.runs.activeRunId ?? createRunId(threadId),
                timestamp: Date.now(),
                message: String(err),
              });
            }
            return;
          }
          const runId = options?.runId ?? createRunId(threadId);
          userMessage.id = completedRunUserMessageId(type.key, runId);
          const startedAt = Date.now();
          state.dispatch({
            kind: "stream_start",
            agentType: type.key,
            threadId,
            runId,
            timestamp: startedAt,
          });
          state.dispatch({
            kind: "user_message",
            agentType: type.key,
            threadId,
            runId,
            timestamp: startedAt,
            text: userMessage.content,
            id: userMessage.id,
          });
          if (options?.instanceId) {
            state.updateThread(options.instanceId, { threadId, agentType: type.key });
          }
          const settings = get().sessionMeta.settings;
          try {
            await dispatchChatStream({
              threadId,
              content: trimmed,
              llmContent,
              runId,
              userPayload,
              agentType: type.key,
              permissionMode: settings.agentPermissionMode,
              codexModel: settings.agentCodexModel,
              codexReasoningEffort: settings.agentCodexReasoningEffort,
              agentRoleMemoId: options?.agentRoleMemoId,
              agentRoleName: options?.agentRoleName,
              runtimeConfig: options?.runtimeConfig ?? undefined,
              imagePaths: options?.imagePaths,
              conversationTitle:
                isFirstMessage && conversationTitle ? conversationTitle : undefined,
            });
          } catch (err) {
            logger.error("Failed to dispatch thread card chat_stream", { error: String(err) });
            const errorMessage = createSendErrorMessage(
              err,
              translate(getLanguage(), "agent.chat.sendFailed"),
            );
            get().dispatchAgentEvent({
              kind: "error",
              agentType: type.key,
              threadId,
              runId,
              timestamp: Date.now(),
              message: errorMessage.content,
            });
          }
        },
        stopStream: async () => {
          const meta = get().sessionMeta;
          const type = getAgentType(meta.activeAgentTypeKey);
          const activeId = meta.activeThreadIds[type.key];
          if (activeId) await get().stopThreadRun(activeId);
        },
        stopThreadRun: async (threadId, runId) => {
          if (!threadId) return;
          streamDispatcher.flushBuffer();
          // Steering messages belong to the active turn. Once that turn is
          // explicitly stopped, none of its queued messages can be delivered
          // safely, so remove them immediately instead of waiting for a
          // provider user_message acknowledgement that will never arrive.
          const activeRunIdBeforeStop = get().threadProjections[threadId]?.runs.activeRunId;
          if (!runId || !activeRunIdBeforeStop || runId === activeRunIdBeforeStop) {
            get().clearPendingSteeringMessages(threadId);
          }
          let targetRunId: string | undefined;
          get().setThreadProjection(threadId, (projection) => {
            const candidate = runId ?? projection.runs.activeRunId ?? undefined;
            if (!candidate || !projection.runs.runs[candidate]) return projection;
            targetRunId = candidate;
            const run = projection.runs.runs[candidate];
            recordAgentStopRequested(threadId, candidate, run.agentType);
            const runs = applyRunStopped(projectionToRuns(projection), candidate, Date.now());
            return {
              ...projection,
              runs: runsToProjectionRuns(runs),
              pending: { assistantId: null, reasoningId: null },
            };
          });
          try {
            const meta = get().sessionMeta;
            const type = getAgentType(
              meta.threadTypes[threadId] ?? meta.activeAgentTypeKey,
            );
            await agentClient.stopChatStream(threadId, type.key, targetRunId);
          } catch (err) {
            logger.error("Failed to stop stream", { error: String(err) });
          }
        },
        dispatchAgentEvent: (event) => {
          clearPendingSteeringForLifecycleEvent(event);
          streamDispatcher.dispatch(event);
        },
        flushAgentEventBuffer: () => streamDispatcher.flushBuffer(),
        dispatchAgentChunk: (chunk) => {
          const state = get();
          const event = mapAgentChunkToEvent(
            chunk,
            eventMapperStateForChunk(chunk, state),
          );
          recordAgentChunkMapped(chunk, event);
          clearPendingSteeringForLifecycleEvent(event);
          streamDispatcher.dispatch(event);
        },
        reconcileRunningRunsFromSnapshot: (running) => {
          const now = Date.now();
          const snapshotThreadIds = new Set<string>();
          for (const [reportedThreadId, info] of Object.entries(running)) {
            const localThreadId = info.pendingThreadId || reportedThreadId;
            const productThreadId = resolveProductThreadId(
              localThreadId,
              get().sessionMeta.externalSessionResolutions,
            );
            snapshotThreadIds.add(productThreadId);
            const current = get();
            const agentType = normalizeAgentTypeKey(
              info.agentType ??
                current.sessionMeta.threadTypes[productThreadId] ??
                current.sessionMeta.threadTypes[localThreadId] ??
                current.sessionMeta.activeAgentTypeKey,
            );
            if (info.sessionId && info.sessionId !== productThreadId) {
              current.resolveSessionByThreadId(
                productThreadId,
                info.sessionId,
                agentType,
              );
            }
            get().setSessionMeta((meta) => ({
              ...meta,
              threadTypes: {
                ...meta.threadTypes,
                [productThreadId]: agentType,
                ...(info.sessionId ? { [info.sessionId]: agentType } : {}),
              },
              externalSessionResolutions:
                info.sessionId && info.sessionId !== productThreadId
                  ? {
                      ...meta.externalSessionResolutions,
                      [productThreadId]: info.sessionId,
                    }
                  : meta.externalSessionResolutions,
            }));
            const titleMeta = get().sessionMeta;
            ensureConversationInstanceForSession(
              get,
              productThreadId,
              agentType,
              normalizeThreadTitle(
                getConversationTitleForThread(
                  titleMeta,
                  agentType,
                  productThreadId,
                ),
              ),
              { defaultTitle: defaultExternalThreadTitle(agentType) },
            );
            const startedAt = info.startedAt || now;
            get().setThreadProjection(productThreadId, (projection) => {
              const runId =
                info.runId ??
                projection.runs.activeRunId ??
                `${productThreadId}-${now}`;
              const existing = projection.runs.runs[runId];
              return {
                ...projection,
                runs: {
                  isLoading: true,
                  activeRunId: runId,
                  runs: {
                    ...projection.runs.runs,
                    [runId]: {
                      ...existing,
                      runId,
                      agentType,
                      threadId: productThreadId,
                      startedAt: existing?.startedAt ?? startedAt,
                      status: "running",
                      currentTool: info.currentTool ?? existing?.currentTool ?? null,
                      model: existing?.model,
                      modelId: existing?.modelId,
                    },
                  },
                  lastRun: projection.runs.lastRun,
                },
              };
            });
          }
          for (const [threadId, projection] of Object.entries(
            get().threadProjections,
          )) {
            if (snapshotThreadIds.has(threadId) || !projection.runs.isLoading) continue;
            const activeRunId = projection.runs.activeRunId;
            const activeRun = activeRunId
              ? projection.runs.runs[activeRunId]
              : undefined;
            if (
              activeRun?.startedAt &&
              activeRun.startedAt + RUNNING_RUN_OPTIMISTIC_GRACE_MS > now
            ) {
              continue;
            }
            get().dispatchAgentEvent({
              kind: "stream_end",
              agentType: activeRun?.agentType ?? DEFAULT_AGENT_TYPE_KEY,
              threadId,
              runId: activeRunId ?? `missing-${threadId}`,
              timestamp: now,
              reason: RUN_MISSING_FROM_SNAPSHOT_REASON,
            });
          }
          get().setSessionMeta((meta) => ({
            ...meta,
            lastRunningRunsReconciledAt: now,
          }));
        },
        reconcileRunningRuns: async () => {
          const running = await agentClient.runningThreads();
          get().reconcileRunningRunsFromSnapshot(running);
          return running;
        },
      });
    },
    {
      name: STORAGE_KEYS.AGENT_SESSION,
      storage: createJSONStorage(() => createAgentSessionStateStorage()),
      partialize: (state) => ({
        sessionMeta: {
          ...state.sessionMeta,
          // runtime-fetched / runtime-only fields are not persisted.
          threadLists: DEFAULT_AGENT_SESSION_META.threadLists,
          lastRunningRunsReconciledAt:
            DEFAULT_AGENT_SESSION_META.lastRunningRunsReconciledAt,
        },
      }),
      merge: (persisted, current) => ({
        ...current,
        sessionMeta: rehydrateSessionMeta(persisted),
      }),
    },
    ),
  ),
);
// Selectors

export const selectThreadProjection = (
  state: AgentSessionStore,
  threadId: string,
): ThreadProjection | undefined => state.threadProjections[threadId];

export const selectSessionMeta = (state: AgentSessionStore) => state.sessionMeta;

export const selectConversationRegistry = (state: AgentSessionStore) =>
  state.conversationRegistry;
installGlobalAgentSettingsSync((updater) =>
  useAgentSessionStore.getState().setSessionMeta(updater),
);

export const acquireAgentChunkBridge = createAgentChunkBridge((chunk) => {
  const stateBeforeDispatch = useAgentSessionStore.getState();
  useAgentSessionStore.getState().dispatchAgentChunk(chunk);
  if (chunk.kind === "user_message") {
    const enrichedChunk = chunk as AgentChunk & {
      client_user_message_id?: string;
      message_id?: string;
    };
    const clientId = enrichedChunk.client_user_message_id ?? enrichedChunk.message_id;
    if (clientId) stateBeforeDispatch.removeSteeringMessageByClientId(chunk.thread_id, clientId);
  }
  if (chunk.kind !== "stream_end") return;

  const state = useAgentSessionStore.getState();
  const canonicalThreadId = resolveExternalChunkThreadId(
    chunk,
    state.sessionMeta.externalSessionResolutions,
  );
  const projection = state.threadProjections[canonicalThreadId];
  const runId =
    chunk.run_id ?? projection?.runs.lastRun?.runId;
  const hasResidentRun = !!projection && (
    !chunk.run_id ||
    projection.runs.activeRunId === chunk.run_id ||
    projection.runs.lastRun?.runId === chunk.run_id
  );
  const ownsThread =
    hasThreadInterest(canonicalThreadId) ||
    // A conversation can be switched away from while its run is still
    // streaming. The card then releases its interest, but the canonical
    // projection remains resident and still needs the completion snapshot
    // reconciliation; otherwise reopening the card can show the last
    // persisted (older) turn while the provider is catching up.
    hasResidentRun ||
    Object.values(state.sessionMeta.activeThreadIds).some(
      (threadId) =>
        threadId === canonicalThreadId ||
        (threadId
          ? state.sessionMeta.externalSessionResolutions[threadId] ===
            canonicalThreadId
          : false),
    );
  if (!ownsThread) return;

  const agentType =
    state.sessionMeta.threadTypes[canonicalThreadId] ??
    state.sessionMeta.threadTypes[chunk.thread_id] ??
    state.sessionMeta.activeAgentTypeKey;
  if (runId) {
    if (agentType === "opencode") return;
    // Let the stream-end render settle first. The persisted history can lag
    // the event by a short window, and reconciliation is a consistency check,
    // not part of the interactive completion path.
    globalThis.setTimeout(() => {
      const latest = useAgentSessionStore.getState();
      if (latest.threadTombstones[canonicalThreadId]) return;
      void latest.reconcileCompletedRun(agentType, canonicalThreadId, runId);
    }, 300);
  } else {
    void state.loadMessages(agentType, canonicalThreadId);
  }
});
