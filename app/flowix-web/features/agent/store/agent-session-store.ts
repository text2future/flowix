import { CloudAccessBlockedError } from "@features/agent/config/cloud-access";
import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  subscribeWithSelector,
} from "zustand/middleware";
import { getAdjacentContent } from "@features/workspace/public/adjacent-content-api";
import type { AgentTypeKey } from "@/types/agent";
import { agentClient } from "@features/agent/store/agent-client";
import { DEFAULT_AGENT_TYPE_KEY } from "@/lib/agent-types";
import { STORAGE_KEYS } from "@/lib/constants";
import {
  getAgentType,
  normalizeAgentTypeKey,
} from "@/lib/agent-types";
import { useAgentCloudAccessStore } from "@features/agent/store/agent-cloud-access-store";
import { createStreamEventDispatcher } from "@features/agent/store/stream-event-dispatcher";
import {
  createRunId,
  mapAgentChunkToEvent,
} from "@features/agent/events/agent-event-mapper";
import { completedRunUserMessageId } from "@features/agent/events/message-identity";
import { isKnownProductThreadId, resolveProductThreadId } from "@features/agent/store/external-session";
import { createSteeringLifecycleHandler } from "@features/agent/store/session-steering-lifecycle";
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
import { saveInlineImagePresentation } from "@features/agent/store/inline-image-presentation";
import { dispatchChatStream } from "@features/agent/store/chat-stream";
import {
  cloudAccessReplyForError,
  resolveCloudAccessForSend,
} from "@features/agent/store/cloud-access-preflight";
import {
  ensureConversationInstanceForSession,
  resolveCommandThreadId,
} from "@features/agent/store/session-conversation-helpers";
import { translate } from "@/lib/i18n";
import { createLogger } from "@/lib/logger";
import { createAgentSessionStateStorage } from "@features/agent/store/window-session-storage";
import { withRunPhase } from "@features/agent/store/thread-run-phase";
import { USER_STOPPED_REASON } from "@features/agent/store/run-lifecycle";
import { installAgentSessionRuntimeBridges } from "@features/agent/store/agent-session-runtime-bridges";
import {
  createSessionMetaSlice,
} from "@features/agent/store/session-meta-slice";
import {
  createProjectionSlice,
} from "@features/agent/store/projection-slice";
import {
  createConversationSlice,
} from "@features/agent/store/conversation-slice";
import {
  createThreadHistorySlice,
} from "@features/agent/store/thread-history-slice";
import {
  createThreadLifecycleSlice,
} from "@features/agent/store/thread-lifecycle-slice";
import {
  createFollowUpQueueSlice,
  isProjectionWorking,
} from "@features/agent/store/follow-up-queue-slice";
import type { AgentSessionStore } from "@features/agent/store/agent-session-store-types";
import {
  mergeAgentSessionPersisted,
  migrateAgentSessionPersisted,
  partializeAgentSessionMeta,
} from "@features/agent/store/agent-session-persist";

export {
  DEFAULT_AGENT_SESSION_META,
  type AgentConversationRegistry,
  type AgentSessionMeta,
} from "@features/agent/store/session-state";

const RUNNING_RUN_OPTIMISTIC_GRACE_MS = 3000;
const RUN_MISSING_FROM_SNAPSHOT_REASON = "missing_from_snapshot";
/**
 * A second Stop while the first one is still in flight is harmless, but the
 * `stopping` phase must never become a permanent lockout. Pi keeps reporting
 * `stopping` for as long as its stop reason is set — including when the RPC
 * process never settles — so this only dedupes double clicks.
 */
const STOP_RETRY_DEDUPE_MS = 1500;
const lastStopRequestAt = new Map<string, number>();
const logger = createLogger("agent-session-store");

export type { PendingSteeringMessage } from "@features/agent/store/follow-up-queue-slice";
export type { AgentSessionStore } from "@features/agent/store/agent-session-store-types";


export const useAgentSessionStore = create<AgentSessionStore>()(
  subscribeWithSelector(
    persist(
    (set, get) => {
      const runProviders = new Map<string, string | null>();
      const streamDispatcher = createStreamEventDispatcher({
        getProjection: (threadId) => get().threadProjections[threadId],
        canDispatch: (threadId) => !get().threadTombstones[threadId],
        dispatch: (event) => get().dispatch(event),
        applySessionResolved: (event) => get().applySessionResolved(event),
      });
      const clearPendingSteeringForLifecycleEvent = createSteeringLifecycleHandler(get);
      return ({
        ...createSessionMetaSlice(set, get),
        ...createConversationSlice(set, get),
        ...createProjectionSlice(set),
        ...createThreadHistorySlice(get),
        ...createThreadLifecycleSlice(set, get),
        ...createFollowUpQueueSlice(set, get),

        sendMessageToThread: async (threadId, content, typeKey, options) => {
          const trimmed = content.trim();
          if (!threadId || (!trimmed && !options?.imagePaths?.length)) {
            if (options?.rejectOnFailure) throw new Error("Agent message is empty or has no thread");
            return;
          }
          const state = get();
          const type = getAgentType(typeKey ?? state.sessionMeta.threadTypes[threadId] ?? state.sessionMeta.activeAgentTypeKey);
          const productThreadId = resolveCommandThreadId(state, threadId, type.id);
          if (!productThreadId) {
            if (options?.rejectOnFailure) throw new Error("Agent thread was not found");
            return;
          }
          if (productThreadId !== threadId) return get().sendMessageToThread(productThreadId, content, type.id, options);
          if (state.threadTombstones[threadId] || state.threadMutationGuards[threadId]) {
            if (options?.rejectOnFailure) throw new Error("Agent thread is unavailable");
            return;
          }
          state.bindThreadType(threadId, type.id);
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
                [type.id]: (meta.threadLists[type.id] ?? []).map((item) =>
                  item.threadId === threadId
                    ? { ...item, title: conversationTitle }
                    : item,
                ),
              },
            }));
          }
          const { userPayload, llmContent, userMessage } = prepareUserMessage({
            content: trimmed,
            displayContent: options?.displayContent,
            isFirstMessage,
            agentType: type.id,
            currentNoteContent: options?.currentNoteContent,
            adjacentContent: getAdjacentContent(options?.instanceId),
            systemReminderDirectory:
              options?.runtimeConfig?.workspaceSnapshot?.notebookPath,
            attachments:
              options?.attachments ?? createAgentMessageAttachments(options?.imagePaths),
          });
          saveInlineImagePresentation(
            threadId,
            type.id,
            trimmed,
            userMessage.content,
            userMessage.attachments,
            Date.parse(userMessage.timestamp),
          );
          if (
            (type.id === "codex" || type.id === "dsh" || type.id === "pi") &&
            isProjectionWorking(get().threadProjections[threadId])
          ) {
            const clientUserMessageId = `flowix-${createRunId(threadId)}`;
            const pendingId = `pending-${clientUserMessageId}`;
            get().enqueueSteeringMessage({
              id: pendingId,
              threadId,
              content: trimmed,
              imagePaths: options?.imagePaths,
              runtimeConfig: options?.runtimeConfig,
              queuedAt: Date.now(),
              clientUserMessageId,
              llmContent,
              deliveryMode: type.id === 'pi' || type.id === 'codex' ? 'follow_up' : 'steer',
              deliveryStatus: "submitting",
            });
            try {
              const activeTurnMessage = {
                content: trimmed,
                ...(userMessage.content !== trimmed
                  ? { displayContent: userMessage.content }
                  : {}),
                llmContent,
                imagePaths: options?.imagePaths,
                agentType: type.id,
                runtimeConfig: options?.runtimeConfig ?? undefined,
              };
              if (type.id === "codex") {
                await get().queueCodexFollowUp(
                  threadId,
                  activeTurnMessage,
                  clientUserMessageId,
                  pendingId,
                );
              } else {
                await agentClient.steerChat(
                  threadId,
                  activeTurnMessage,
                  clientUserMessageId,
                  type.id === 'pi' ? 'follow_up' : 'steer',
                );
                get().updateSteeringMessage(threadId, pendingId, { deliveryStatus: "queued" });
              }
            } catch (err) {
              get().removeSteeringMessage(threadId, pendingId);
              logger.error("Failed to queue active-turn message", { error: String(err), agentType: type.id });
              get().dispatch({
                kind: "error",
                agentType: type.id,
                threadId,
                runId: get().threadProjections[threadId]?.runs.activeRunId ?? createRunId(threadId),
                timestamp: Date.now(),
                message: String(err),
              });
              if (options?.rejectOnFailure) throw err;
            }
            return;
          }
          const blockedAccess = resolveCloudAccessForSend(threadId, type.id, options?.runtimeConfig ?? undefined);
          if (blockedAccess) {
            if (options?.rejectOnFailure) throw new CloudAccessBlockedError(blockedAccess);
            return;
          }
          const runId = options?.runId ?? createRunId(threadId);
          userMessage.id = completedRunUserMessageId(type.id, runId);
          userMessage.renderKey = userMessage.id;
          if (type.id === "pi") userMessage.messageId = null;
          const startedAt = Date.now();
          state.dispatch({
            kind: "stream_start",
            agentType: type.id,
            threadId,
            runId,
            timestamp: startedAt,
          });
          state.dispatch({
            kind: "user_message",
            agentType: type.id,
            threadId,
            runId,
            timestamp: startedAt,
            text: userMessage.content,
            id: userMessage.id,
            attachments: userMessage.attachments,
          });
          if (options?.instanceId) {
            state.updateThread(options.instanceId, { threadId, agentType: type.id });
          }
          try {
            await dispatchChatStream({
              threadId,
              instanceId: options?.instanceId,
              content: trimmed,
              ...(userMessage.content !== trimmed
                ? { displayContent: userMessage.content }
                : {}),
              llmContent,
              runId,
              userPayload,
              onResolvedProvider: (providerId) => { runProviders.set(runId, providerId ?? null); },
              agentType: type.id,
              runtimeConfig: options?.runtimeConfig ?? undefined,
              imagePaths: options?.imagePaths,
              conversationTitle:
                isFirstMessage && conversationTitle ? conversationTitle : undefined,
            });
          } catch (err) {
            runProviders.delete(runId);
            logger.error("Failed to dispatch thread card chat_stream", { error: String(err) });
            const errorMessage = createSendErrorMessage(
              err,
              translate(getLanguage(), "agent.chat.sendFailed"),
            );
            get().dispatchAgentEvent({
              kind: "error",
              agentType: type.id,
              threadId,
              runId,
              timestamp: Date.now(),
              message: errorMessage.content,
            });
            if (options?.rejectOnFailure) throw err;
          }
        },
        /**
         * @deprecated Column-blind: it stops whatever thread the shared runtime
         * slot points at, which is the wrong thread when both columns show a
         * conversation of the same agent type. Surfaces stop their own thread
         * with `stopThreadRun(threadId)`; there are no remaining callers.
         */
        stopStream: async () => {
          const meta = get().sessionMeta;
          const type = getAgentType(meta.activeAgentTypeKey);
          const activeId = meta.activeThreadIds[type.id];
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
            projectionBeforeStop?.runs.runs[activeRunIdBeforeStop]?.phase === "stopping" &&
            Date.now() - (lastStopRequestAt.get(threadId) ?? 0) < STOP_RETRY_DEDUPE_MS) return;
          lastStopRequestAt.set(threadId, Date.now());
          const pendingCodexCommandRunId =
            projectionBeforeStop?.runs.codexCommand?.status === "pending"
              ? projectionBeforeStop.runs.codexCommand.runId
              : undefined;
          if (runId && runId !== activeRunIdBeforeStop && runId !== pendingCodexCommandRunId) return;
          let targetRunId: string | undefined;
          get().updateThreadRuns(threadId, (projection) => {
            const candidate = runId ?? projection.runs.activeRunId ?? undefined;
            if (!candidate || !projection.runs.runs[candidate]) return projection.runs;
            targetRunId = candidate;
            const run = projection.runs.runs[candidate];
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
              (type.id === "codex" ? pendingCodexCommandRunId : undefined);
            // Address the stop to the runtime that owns this run, not to the
            // thread's bound type. After a reload the binding can be missing or
            // stale, and a stop sent to the wrong runtime is a silent no-op:
            // that runtime has no such run, answers false, and the card keeps
            // showing "running" with a Stop button that never does anything.
            let stopRuntimeId: AgentTypeKey = targetRunId
              ? projectionBeforeStop?.runs.runs[targetRunId]?.agentType ?? type.id
              : type.id;
            if (!stopRunId) {
              const running = await agentClient.runningThreads();
              // Prefer the run of the thread's own runtime, but do not ignore a
              // run another runtime reports for this thread: the card shows one
              // conversation, so Stop must reach whatever is running in it.
              const candidates = Object.entries(running).filter(
                ([reportedThreadId, info]) =>
                  reportedThreadId === threadId || info.pendingThreadId === threadId,
              );
              const preferred = candidates.find(
                ([, info]) => !info.agentType || info.agentType === type.id,
              );
              const target = preferred ?? candidates[0];
              stopRunId = target?.[1].runId;
              if (target?.[1].agentType) {
                stopRuntimeId = normalizeAgentTypeKey(target[1].agentType);
              }
              if (!stopRunId) return;
            }
            accepted = await agentClient.stopChatStream(threadId, stopRuntimeId, stopRunId);
            if (accepted && stopRuntimeId !== "codex" && (!runId || !activeRunIdBeforeStop || runId === activeRunIdBeforeStop)) {
              get().clearPendingSteeringMessages(threadId);
            }
          } catch (err) {
            logger.error("Failed to stop stream", { error: String(err) });
          } finally {
            if (!accepted) {
              try {
                const running = await agentClient.runningThreads();
                const reported = targetRunId
                  ? Object.entries(running).find(([reportedThreadId, info]) =>
                      info.runId === targetRunId &&
                      (reportedThreadId === threadId || info.pendingThreadId === threadId))
                  : undefined;
                if (reported && targetRunId) {
                  const stopTargetRunId = targetRunId;
                  // Still aborting: keep the honest "stopping" phase. The
                  // composer keeps Stop clickable while stopping, so this is a
                  // status, not a lock — a rejected stop can always be retried.
                  if (reported[1].phase && reported[1].phase !== "stopping") {
                    get().updateThreadRuns(threadId, (projection) =>
                      withRunPhase(projection, stopTargetRunId, reported[1].phase!, "stopping").runs);
                  }
                } else if (targetRunId) {
                  // Nothing is running any more: the run ended while this view
                  // was disconnected (a WebView reload drops the terminal
                  // event), or the runtime never had it. Do not leave the
                  // conversation pinned to "running" — no later click can stop
                  // a run the runtime no longer owns.
                  const projection = get().threadProjections[threadId];
                  get().dispatchAgentEvent({
                    kind: "stream_end",
                    agentType:
                      projection?.runs.runs[targetRunId]?.agentType ??
                      projection?.runs.lastRun?.agentType ??
                      getAgentType(
                        get().sessionMeta.threadTypes[threadId] ??
                          get().sessionMeta.activeAgentTypeKey,
                      ).id,
                    threadId,
                    runId: targetRunId,
                    timestamp: Date.now(),
                    reason: USER_STOPPED_REASON,
                  });
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
          if (event.kind === "user_message") {
            const clientId = event.clientUserMessageId ??
              (productChunk.kind === "user_message" ? productChunk.message_id : undefined);
            if (clientId) get().removeSteeringMessageByClientId(threadId, clientId);
          }
          // Cloud answers an empty balance or an expired session with a run
          // failure; the card is the reply the user can act on, so the raw
          // upstream sentence never becomes a transcript row.
          if (event.kind === "error") {
            const reply = get().threadProjections[threadId]?.runs.activeRunId === event.runId
              ? cloudAccessReplyForError(threadId, event, runProviders.has(event.runId) ? runProviders.get(event.runId) ?? "" : undefined)
              : null;
            if (reply) {
              runProviders.delete(event.runId);
              if (useAgentCloudAccessStore.getState().entries[threadId] === "no_credits") {
                void import("@features/agent/thread-card/cloud-access/cloud-credits-dialog")
                  .then(({ openCloudCreditsDialog }) => openCloudCreditsDialog())
                  .catch((error) => logger.error("Failed to open credits dialog", { error: String(error) }));
              }
              clearPendingSteeringForLifecycleEvent(reply);
              streamDispatcher.dispatch(reply);
              return;
            }
          }
          if (event.kind === "error" || event.kind === "stream_end") runProviders.delete(event.runId);
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
      version: 2,
      storage: createJSONStorage(() => createAgentSessionStateStorage()),
      migrate: migrateAgentSessionPersisted,
      partialize: partializeAgentSessionMeta,
      merge: mergeAgentSessionPersisted,
    },
    ),
  ),
);
export const acquireAgentChunkBridge = installAgentSessionRuntimeBridges(useAgentSessionStore);
