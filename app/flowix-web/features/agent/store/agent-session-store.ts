import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  subscribeWithSelector,
} from "zustand/middleware";
import type {
  AgentMessageAttachment,
  AgentChunk,
  AgentEvent,
  AgentRunState,
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
import { isKnownProductThreadId, resolveProductThreadId, resolveStoreThreadId } from "@features/agent/store/external-session";
import { resolveIncomingChunkThreadId } from "@features/agent/store/agent-chunk-routing";
import {
  recordAgentChunkMapped,
  recordAgentStopRequested,
} from "@features/agent/diagnostics/agent-run-trace";
import {
  defaultExternalThreadTitle,
  getConversationTitleForThread,
  getLanguage,
  normalizeThreadTitle,
} from "@features/agent/store/thread-titles";
import {
  createAgentMessageAttachments,
  createSendErrorMessage,
  prepareUserMessage,
} from "@features/agent/store/user-message";
import { dispatchChatStream } from "@features/agent/store/chat-stream";
import { translate } from "@/lib/i18n";
import { createLogger } from "@/lib/logger";
import { buildInitialInstanceRuntimeConfig } from "@features/agent/store/initial-runtime-config";
import { createAgentSessionStateStorage } from "@features/agent/store/window-session-storage";
import { withRunPhase } from "@features/agent/store/thread-run-phase";
import { installAgentSessionRuntimeBridges } from "@features/agent/store/agent-session-runtime-bridges";
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

const RUNNING_RUN_OPTIMISTIC_GRACE_MS = 3000;
const RUN_MISSING_FROM_SNAPSHOT_REASON = "missing_from_snapshot";
const logger = createLogger("agent-session-store");
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
      isFirstMessage?: boolean;
      runtimeConfig?: RuntimeConfig | null;
      imagePaths?: string[];
      attachments?: AgentMessageAttachment[];
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
  reconcileRunningRunsFromSnapshot: (
    running: Record<string, RunInfo>,
    requestProjections?: Readonly<Record<string, ThreadProjection>>,
  ) => void;
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

function resolveCommandThreadId(state: AgentSessionStore, threadId: string, runtime: AgentTypeKey): string | null {
  return resolveStoreThreadId(threadId, state.sessionMeta.externalSessionResolutions, runtime,
    state.sessionMeta.threadTypes, (id) => isKnownProductThreadId(id, state));
}

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


export const useAgentSessionStore = create<AgentSessionStore>()(
  subscribeWithSelector(
    persist(
    (set, get) => {
      const streamDispatcher = createStreamEventDispatcher({
        getProjection: (threadId) => get().threadProjections[threadId],
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
          event.agentType,
          state.sessionMeta.threadTypes,
          (id) => isKnownProductThreadId(id, state),
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
        ...createThreadHistorySlice(get),
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
          const type = getAgentType(typeKey ?? state.sessionMeta.threadTypes[threadId] ?? state.sessionMeta.activeAgentTypeKey);
          const productThreadId = resolveCommandThreadId(state, threadId, type.key);
          if (!productThreadId) return;
          if (productThreadId !== threadId) return get().sendMessageToThread(productThreadId, content, type.key, options);
          if (state.threadTombstones[threadId] || state.threadMutationGuards[threadId]) return;
          state.bindThreadType(threadId, type.key);
          const isFirstMessage = options?.isFirstMessage ?? (state.threadProjections[threadId]?.messages.length ?? 0) === 0;
          const conversationTitle = normalizeThreadTitle(options?.conversationTitle);
          if (isFirstMessage && conversationTitle) {
            state.setSessionMeta((meta) => ({
              ...meta,
              // Instance-backed sends must not replace another thread's fallback title.
              ...(!options?.instanceId
                ? {
                    currentThreadTitles: {
                      ...meta.currentThreadTitles,
                      [threadId]: conversationTitle,
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
            systemReminderDirectory:
              options?.runtimeConfig?.workspaceSnapshot?.notebookPath,
            attachments:
              options?.attachments ?? createAgentMessageAttachments(options?.imagePaths),
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
          userMessage.renderKey = userMessage.id;
          if (type.key === "pi") userMessage.messageId = null;
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
            attachments: userMessage.attachments,
          });
          if (options?.instanceId) {
            state.updateThread(options.instanceId, { threadId, agentType: type.key });
          }
          const settings = get().sessionMeta.settings;
          try {
            await dispatchChatStream({
              threadId,
              instanceId: options?.instanceId,
              content: trimmed,
              llmContent,
              runId,
              userPayload,
              agentType: type.key,
              permissionMode: settings.agentPermissionMode,
              codexModel: settings.agentCodexModel,
              codexReasoningEffort: settings.agentCodexReasoningEffort,
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
          const meta = get().sessionMeta;
          const runtime = meta.threadTypes[threadId] ?? meta.activeAgentTypeKey;
          const productThreadId = resolveCommandThreadId(get(), threadId, runtime);
          if (!productThreadId) return;
          if (productThreadId !== threadId) return get().stopThreadRun(productThreadId, runId);
          streamDispatcher.flushBuffer();
          const projectionBeforeStop = get().threadProjections[threadId];
          const activeRunIdBeforeStop = projectionBeforeStop?.runs.activeRunId;
          if (activeRunIdBeforeStop &&
            projectionBeforeStop?.runs.runs[activeRunIdBeforeStop]?.phase === "stopping") return;
          const pendingCodexCommandRunId =
            projectionBeforeStop?.runs.codexCommand?.status === "pending"
              ? projectionBeforeStop.runs.codexCommand.runId
              : undefined;
          if (runId && runId !== activeRunIdBeforeStop && runId !== pendingCodexCommandRunId) return;
          let targetRunId: string | undefined;
          let previousPhase: AgentRunState["phase"];
          get().updateThreadRuns(threadId, (projection) => {
            const candidate = runId ?? projection.runs.activeRunId ?? undefined;
            if (!candidate || !projection.runs.runs[candidate]) return projection.runs;
            targetRunId = candidate;
            const run = projection.runs.runs[candidate];
            previousPhase = run.phase;
            recordAgentStopRequested(threadId, candidate, run.agentType);
            return withRunPhase(projection, candidate, "stopping").runs;
          });
          let accepted = false;
          try {
            const meta = get().sessionMeta;
            const type = getAgentType(
              meta.threadTypes[threadId] ?? meta.activeAgentTypeKey,
            );
            let stopRunId = targetRunId ??
              (type.key === "codex" ? pendingCodexCommandRunId : undefined);
            if (!stopRunId) {
              const running = await agentClient.runningThreads();
              const candidate = Object.entries(running).find(([reportedThreadId, info]) =>
                (reportedThreadId === threadId || info.pendingThreadId === threadId) &&
                (!info.agentType || info.agentType === type.key));
              stopRunId = candidate?.[1].runId;
              if (!stopRunId) return;
            }
            accepted = await agentClient.stopChatStream(threadId, type.key, stopRunId);
            if (accepted && (!runId || !activeRunIdBeforeStop || runId === activeRunIdBeforeStop)) {
              get().clearPendingSteeringMessages(threadId);
            }
          } catch (err) {
            logger.error("Failed to stop stream", { error: String(err) });
          } finally {
            if (!accepted && targetRunId) {
              try {
                const running = await agentClient.runningThreads();
                const reported = Object.entries(running).find(([reportedThreadId, info]) =>
                  info.runId === targetRunId &&
                  (reportedThreadId === threadId || info.pendingThreadId === threadId));
                if (reported && reported[1].phase !== "stopping") {
                  get().updateThreadRuns(threadId, (projection) =>
                    withRunPhase(projection, targetRunId!, reported[1].phase ?? previousPhase, "stopping").runs);
                }
              } catch (error) {
                logger.warn("Could not confirm run state after stop request", { error: String(error) });
              }
            }
          }
        },
        dispatchAgentEvent: (event) => {
          clearPendingSteeringForLifecycleEvent(event);
          streamDispatcher.dispatch(event);
        },
        flushAgentEventBuffer: () => streamDispatcher.flushBuffer(),
        dispatchAgentChunk: (chunk) => {
          const state = get();
          if (!chunk.run_id?.trim()) {
            logger.warn("Ignoring agent chunk without run ID", { threadId: chunk.thread_id, kind: chunk.kind });
            return;
          }
          const threadId = resolveIncomingChunkThreadId(chunk, state);
          if (!threadId) {
            logger.warn("Ignoring agent chunk without a unique product thread", { threadId: chunk.thread_id, kind: chunk.kind });
            return;
          }
          const productChunk = threadId === chunk.thread_id ? chunk : { ...chunk, thread_id: threadId };
          const event = mapAgentChunkToEvent(
            productChunk,
            { threadTypes: state.sessionMeta.threadTypes },
          );
          recordAgentChunkMapped(chunk, event);
          clearPendingSteeringForLifecycleEvent(event);
          streamDispatcher.dispatch(event);
        },
        reconcileRunningRunsFromSnapshot: (running, requestProjections) => {
          const now = Date.now();
          const snapshotThreadIds = new Set<string>();
          for (const [reportedThreadId, info] of Object.entries(running)) {
            const sourceThreadId = info.pendingThreadId || reportedThreadId;
            const productThreadId = resolveProductThreadId(
              sourceThreadId,
              get().sessionMeta.externalSessionResolutions,
              info.agentType ? normalizeAgentTypeKey(info.agentType) : undefined,
              get().sessionMeta.threadTypes,
              (id) => isKnownProductThreadId(id, get()),
            );
            snapshotThreadIds.add(productThreadId);
            if (requestProjections && requestProjections[productThreadId] !== get().threadProjections[productThreadId]) continue;
            const current = get();
            const agentType = normalizeAgentTypeKey(
              info.agentType ??
                current.sessionMeta.threadTypes[productThreadId] ??
                current.sessionMeta.threadTypes[sourceThreadId] ??
                current.sessionMeta.activeAgentTypeKey,
            );
            if (info.sessionId && info.sessionId !== productThreadId) {
              current.bindProviderSessionId(
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
            get().updateThreadRuns(productThreadId, (projection) => {
              const runId =
                info.runId ??
                projection.runs.activeRunId ??
                `${productThreadId}-${now}`;
              const existing = projection.runs.runs[runId];
              return {
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
                      phase: info.phase ?? existing?.phase ?? "running",
                      currentTool: info.currentTool ?? existing?.currentTool ?? null,
                      model: existing?.model,
                      modelId: existing?.modelId,
                    },
                  },
                  lastRun: projection.runs.lastRun,
                  dshCommand: projection.runs.dshCommand,
                  codexCommand: projection.runs.codexCommand,
              };
            });
          }
          for (const [threadId, projection] of Object.entries(
            get().threadProjections,
          )) {
            if (snapshotThreadIds.has(threadId) || !projection.runs.isLoading) continue;
            if (requestProjections && requestProjections[threadId] !== projection) continue;
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
          const requestProjections = get().threadProjections;
          const running = await agentClient.runningThreads();
          get().reconcileRunningRunsFromSnapshot(running, requestProjections);
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
export const acquireAgentChunkBridge = installAgentSessionRuntimeBridges(useAgentSessionStore);
