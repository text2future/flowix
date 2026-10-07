import type { ChatMessage } from "@/types";
import type { AgentTypeKey } from "@/types/agent";
import type { AgentConversationMessageState } from "@features/agent/store/agent-conversation-types";
import type { LiveMessageState } from "@features/agent/store/chunk-result";
import type { ProjectionSlice } from "@features/agent/store/projection-slice";
import { emptyProjection } from "@features/agent/store/session-reducer";
import { getAgentHistoryAdapter } from "@features/agent/store/agent-history-adapters";
import { PiHistorySnapshotChangedError } from "@features/agent/store/pi-message-reconciliation";
import {
  filterRenderableHistoryMessages,
  getHistoryPage,
  getInitialThreadHistory,
  HISTORY_PAGE_SIZE,
  replaceHistoricalMessages,
  areMessagesEquivalent,
  historyCoversLiveTurn,
  reconcilePiHistory,
  mergeHistoricalMessages,
  mergeMessagesForThreadRender,
  mergeLiveMessagesIntoRenderableMessages,
  prependHistoricalMessages,
  trySwapLastLiveMessage,
} from "@features/agent/store/thread-history";
// history-sync is loaded lazily to keep its reconcile engine out of the desktop
// startup graph (`check-web-bundle.mjs` STARTUP_GZIP_BUDGET=850_000). All three
// symbols are only used inside `loadMessages` / `reconcileCompletedRun`, both
// of which are already async, so a dynamic import adds no perceptible latency.
type HistorySyncModule = typeof import("@features/agent/store/history-sync");
let historySyncModulePromise: Promise<HistorySyncModule> | null = null;
function loadHistorySync(): Promise<HistorySyncModule> {
  if (!historySyncModulePromise) {
    historySyncModulePromise = import("@features/agent/store/history-sync");
  }
  return historySyncModulePromise;
}

type SessionSet = (
  updater: (state: HistoryContext) => Partial<HistoryContext> | HistoryContext,
) => void;
type HistoryContext = ThreadHistorySlice & ProjectionSlice;
type SessionGet = () => HistoryContext;

const codexReconciles = new Map<string, Promise<void>>();
// Codex history is normally available immediately after turn completion. Keep
// one delayed retry for app-server persistence lag, but avoid four snapshots
// and four render/reconcile cycles for every completed turn.
const CODEX_RECONCILE_DELAYS = [0, 1500];

function wait(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export interface ThreadHistorySlice {
  getMessageState(
    threadId: string | null | undefined,
  ): AgentConversationMessageState | null;
  mergeMessages(
    agentType: AgentTypeKey,
    threadId: string,
    messages: ChatMessage[],
  ): void;
  syncRenderableMessages(
    agentType: AgentTypeKey,
    threadId: string,
    messages: ChatMessage[],
  ): void;
  syncLiveMessageState(
    agentType: AgentTypeKey,
    threadId: string,
    liveState: LiveMessageState,
  ): void;
  resetMessageStates(threadIds: string[]): void;
  loadMessages(agentType: AgentTypeKey, threadId: string): Promise<void>;
  /** Reload the complete provider snapshot and treat it as authoritative. */
  reloadMessagesFromHistory(
    agentType: AgentTypeKey,
    threadId: string,
    options?: { preserveExistingMessages?: boolean },
  ): Promise<ChatMessage[]>;
  reconcileCompletedRun(
    agentType: AgentTypeKey,
    threadId: string,
    runId: string,
  ): Promise<void>;
  loadMoreMessages(agentType: AgentTypeKey, threadId: string): Promise<void>;
}

export function createThreadHistorySlice(
  set: SessionSet,
  get: SessionGet,
): ThreadHistorySlice {
  // Orders concurrent Pi history reads locally; these are request versions,
  // never message IDs and never persisted. Native revisions remain opaque.
  const piHistoryReadVersions = new Map<string, number>();
  const beginHistoryRead = (agentType: AgentTypeKey, threadId: string) => {
    if (agentType !== "pi") return 0;
    const version = (piHistoryReadVersions.get(threadId) ?? 0) + 1;
    piHistoryReadVersions.set(threadId, version);
    return version;
  };
  const isHistoryReadCurrent = (agentType: AgentTypeKey, threadId: string, version: number) =>
    agentType !== "pi" || piHistoryReadVersions.get(threadId) === version;
  const isRequestCurrent = (threadId: string, epoch: number) =>
    !get().threadTombstones[threadId] &&
    (get().threadEpochs[threadId] ?? 0) === epoch;

  return {
    getMessageState: (threadId) => {
      if (!threadId) return null;
      const projection = get().threadProjections[threadId];
      if (!projection) return null;
      return {
        messages: projection.messages,
        pendingAssistantId: projection.pending.assistantId,
        pendingReasoningId: projection.pending.reasoningId,
        oldestSequence: projection.pagination.oldestSequence,
        snapshotSequence: projection.pagination.snapshotSequence,
        hasMoreHistory: projection.pagination.hasMoreHistory,
        loadingInitial: projection.pagination.loadingInitial,
        loadingMore: projection.pagination.loadingMore,
      };
    },
    mergeMessages: (agentType, threadId, messages) => {
      const renderable = filterRenderableHistoryMessages(messages);
      if (renderable.length === 0) return;
      set((state) => {
        if (state.threadTombstones[threadId]) return state;
        const current = state.threadProjections[threadId] ?? emptyProjection();
        const merged = mergeHistoricalMessages(
          current.messages,
          renderable,
          agentType,
        );
        if (merged === current.messages) return state;
        return {
          threadProjections: {
            ...state.threadProjections,
            [threadId]: { ...current, messages: merged },
          },
        };
      });
    },
    syncRenderableMessages: (agentType, threadId, messages) => {
      const renderable = filterRenderableHistoryMessages(messages);
      if (renderable.length === 0) return;
      set((state) => {
        if (state.threadTombstones[threadId]) return state;
        const current = state.threadProjections[threadId] ?? emptyProjection();
        const merged = mergeLiveMessagesIntoRenderableMessages(
          current.messages,
          renderable,
          agentType,
        );
        if (merged === current.messages) return state;
        return {
          threadProjections: {
            ...state.threadProjections,
            [threadId]: { ...current, messages: merged },
          },
        };
      });
    },
    syncLiveMessageState: (agentType, threadId, liveState) => {
      const renderable = filterRenderableHistoryMessages(liveState.messages);
      set((state) => {
        if (state.threadTombstones[threadId]) return state;
        const current = state.threadProjections[threadId] ?? emptyProjection();
        const swapped = trySwapLastLiveMessage(current.messages, renderable);
        const merged =
          swapped ??
          (renderable.length > 0
            ? mergeLiveMessagesIntoRenderableMessages(
                current.messages,
                renderable,
                agentType,
              )
            : current.messages);
        if (
          merged === current.messages &&
          current.pending.assistantId === liveState.pendingAssistantId &&
          current.pending.reasoningId === liveState.pendingReasoningId
        ) {
          return state;
        }
        return {
          threadProjections: {
            ...state.threadProjections,
            [threadId]: {
              ...current,
              messages: merged,
              pending: {
                assistantId: liveState.pendingAssistantId,
                reasoningId: liveState.pendingReasoningId,
              },
            },
          },
        };
      });
    },
    resetMessageStates: (threadIds) => get().resetThreadProjections(threadIds),
    loadMessages: async (agentType, threadId) => {
      if (get().threadProjections[threadId]?.pagination.loadingInitial) return;
      if (get().threadTombstones[threadId]) return;
      const requestEpoch = get().threadEpochs[threadId] ?? 0;
      const historyReadVersion = beginHistoryRead(agentType, threadId);
      const requestProjection = get().threadProjections[threadId]?.messages ?? [];
      const isInitialLoad =
        (get().threadProjections[threadId]?.messages.length ?? 0) === 0;
      // Refresh/reconciliation is stale-while-revalidate: an already rendered
      // conversation must not enter loading or invalidate its projection just
      // because a silent snapshot request started.
      if (isInitialLoad) {
        get().setThreadProjection(threadId, (projection) => ({
          ...projection,
          pagination: {
            ...projection.pagination,
            initialStatus: "loading",
            initialError: null,
            loadingInitial: true,
          },
        }));
      }
      try {
        const page = await getInitialThreadHistory(
          agentType,
          threadId,
          HISTORY_PAGE_SIZE,
        );
        if (!isRequestCurrent(threadId, requestEpoch) || !isHistoryReadCurrent(agentType, threadId, historyReadVersion)) return;
        const messages = filterRenderableHistoryMessages(page.messages);
        const cached = agentType === "codex" ? get().codexLiveTurns[threadId] : undefined;
        const lastRun = get().threadProjections[threadId]?.runs.lastRun;
        const completedRunId =
          cached?.status === "completed"
            ? cached.runId
            : !cached && lastRun?.status === "completed"
              ? lastRun.runId
              : undefined;
        const { isOlderHistorySnapshot, historyRevision, reconcileHistorySnapshot } =
          await loadHistorySync();
        get().setThreadProjection(threadId, (projection) => {
          if (!isRequestCurrent(threadId, requestEpoch) || !isHistoryReadCurrent(agentType, threadId, historyReadVersion)) return projection;
          if (
            agentType !== "pi" && isOlderHistorySnapshot(
              projection.pagination.snapshotSequence,
              page.snapshotSequence,
            )
          ) {
            return projection;
          }
          const reconciled =
            cached?.status === "running"
              ? agentType === "pi"
                ? reconcilePiHistory(messages, cached.messages, page.hasMore, requestProjection)
                : mergeMessagesForThreadRender({
                  history: messages,
                  live: cached.messages,
                  agentType,
                })
              : reconcileHistorySnapshot({
                  agentType,
                  current: projection.messages,
                  snapshot: {
                    messages,
                    revision: historyRevision(page.snapshotSequence),
                    oldestCursor: page.oldestSequence,
                    hasMore: page.hasMore,
                    piRevision: page.piRevision,
                    piBeforeEntryId: page.piBeforeEntryId,
                  },
                  requestProjection,
                  reason: completedRunId ? "run_completed" : "open",
                  runId: completedRunId,
                  turnId: cached?.turnId,
                }).messages;
          const pagination = {
            initialStatus: "ready",
            initialError: null,
            oldestSequence: page.oldestSequence,
            snapshotSequence: page.snapshotSequence ?? null,
            piRevision: page.piRevision,
            piBeforeEntryId: page.piBeforeEntryId,
            hasMoreHistory: page.hasMore,
            loadingInitial: false,
            loadingMore: false,
          } as const;
          const messagesUnchanged = reconciled === projection.messages;
          const paginationUnchanged =
            projection.pagination.initialStatus === pagination.initialStatus &&
            projection.pagination.oldestSequence === pagination.oldestSequence &&
            (projection.pagination.snapshotSequence ?? null) ===
              pagination.snapshotSequence &&
            JSON.stringify(projection.pagination.piRevision) === JSON.stringify(pagination.piRevision) &&
            projection.pagination.piBeforeEntryId === pagination.piBeforeEntryId &&
            projection.pagination.hasMoreHistory === pagination.hasMoreHistory &&
            projection.pagination.loadingInitial === pagination.loadingInitial &&
            projection.pagination.loadingMore === pagination.loadingMore;
          return messagesUnchanged && paginationUnchanged
            ? projection
            : { ...projection, messages: reconciled, pagination };
        });
        if (
          agentType === "codex" &&
          cached?.status === "completed" &&
          historyCoversLiveTurn(messages, cached.messages)
        ) {
          get().clearCodexLiveTurn(threadId, cached.runId);
        }
      } catch (error) {
        console.error("[AgentSession] Failed to load messages:", error);
        if (!isRequestCurrent(threadId, requestEpoch) || !isHistoryReadCurrent(agentType, threadId, historyReadVersion)) return;
        if (isInitialLoad) {
          get().setThreadProjection(threadId, (projection) => ({
            ...projection,
            pagination: {
              ...projection.pagination,
              initialStatus: "error",
              initialError: error instanceof Error ? error.message : String(error),
              loadingInitial: false,
            },
          }));
        }
      }
    },
    reloadMessagesFromHistory: async (agentType, threadId, options) => {
      if (!threadId || get().threadTombstones[threadId]) return [];

      // Invalidate an initial/page request that may have started before a DSH
      // command committed its surface replacement. The command refresh must
      // win over that stale response instead of merging the pre-compact rows
      // back into the projection afterwards.
      const requestProjection = get().threadProjections[threadId]?.messages ?? [];
      get().invalidateThread(threadId);
      const requestEpoch = get().threadEpochs[threadId] ?? 0;
      const historyReadVersion = beginHistoryRead(agentType, threadId);
      const history = await getAgentHistoryAdapter(agentType).getFullHistory(threadId);
      if (!isRequestCurrent(threadId, requestEpoch) || !isHistoryReadCurrent(agentType, threadId, historyReadVersion)) return [];

      const current = get().threadProjections[threadId] ?? emptyProjection();
      const messages = replaceHistoricalMessages(history, agentType);
      const existingMessages = options?.preserveExistingMessages
        ? current.messages.filter(
            (message) =>
              !(
                message.messageType === "dsh-command" &&
                message.id.startsWith("dsh-command:live:")
              ),
          )
        : current.messages;
      const nextMessages = agentType === "pi"
        ? reconcilePiHistory(messages, existingMessages, false, requestProjection)
        : options?.preserveExistingMessages
          ? mergeHistoricalMessages(existingMessages, messages, agentType)
        : areMessagesEquivalent(current.messages, messages)
          ? current.messages
          : messages;
      get().setThreadProjection(threadId, (projection) => {
        if (!isRequestCurrent(threadId, requestEpoch) || !isHistoryReadCurrent(agentType, threadId, historyReadVersion)) return projection;
        return {
          ...projection,
          messages: nextMessages,
          pagination: {
            ...projection.pagination,
            initialStatus: "ready",
            initialError: null,
            oldestSequence: null,
            snapshotSequence: null,
            piRevision: undefined,
            piBeforeEntryId: undefined,
            hasMoreHistory: false,
            loadingInitial: false,
            loadingMore: false,
          },
        };
      });
      return nextMessages;
    },
    reconcileCompletedRun: async (agentType, threadId, runId) => {
      if (get().threadTombstones[threadId]) return;
      if (agentType === "codex") {
        const existing = codexReconciles.get(threadId);
        if (existing) return existing;
      }
      const requestEpoch = get().threadEpochs[threadId] ?? 0;
      const historyReadVersion = beginHistoryRead(agentType, threadId);
      const reconcile = (async () => {
        try {
          const {
            isOlderHistorySnapshot,
            historyRevision,
            reconcileHistorySnapshot,
          } = await loadHistorySync();
          let page: Awaited<ReturnType<typeof getInitialThreadHistory>> | null = null;
          let historicalMessages: ChatMessage[] = [];
          let cachedTurnId: string | undefined;
          let requestProjection: readonly ChatMessage[] = [];
          for (const delay of agentType === "codex" ? CODEX_RECONCILE_DELAYS : [0]) {
            await wait(delay);
            requestProjection = get().threadProjections[threadId]?.messages ?? [];
            page = await getInitialThreadHistory(agentType, threadId, HISTORY_PAGE_SIZE);
            historicalMessages = filterRenderableHistoryMessages(page.messages);
            const cached = get().codexLiveTurns[threadId];
            cachedTurnId = cached?.runId === runId ? cached?.turnId : undefined;
            if (
              agentType !== "codex" ||
              !cached ||
              cached.runId !== runId ||
              !cached.messages.some((message) => message.role === "user") ||
              historyCoversLiveTurn(historicalMessages, cached.messages)
            ) break;
          }
          if (!page) return;
        if (!isRequestCurrent(threadId, requestEpoch) || !isHistoryReadCurrent(agentType, threadId, historyReadVersion)) return;
        get().setThreadProjection(threadId, (projection) => {
          if (!isRequestCurrent(threadId, requestEpoch) || !isHistoryReadCurrent(agentType, threadId, historyReadVersion)) return projection;
          if (
            agentType !== "pi" && isOlderHistorySnapshot(
              projection.pagination.snapshotSequence,
              page.snapshotSequence,
            )
          ) {
            return projection;
          }
          const messages = reconcileHistorySnapshot({
            agentType,
            current: projection.messages,
            snapshot: {
              messages: historicalMessages,
              revision: historyRevision(page.snapshotSequence),
              oldestCursor: page.oldestSequence,
              hasMore: page.hasMore,
              piRevision: page.piRevision,
              piBeforeEntryId: page.piBeforeEntryId,
            },
            requestProjection,
            reason: "run_completed",
            runId,
            turnId: cachedTurnId,
          }).messages;
          const nextPagination = {
            initialStatus: "ready" as const,
            oldestSequence: page.oldestSequence,
            snapshotSequence: page.snapshotSequence ?? null,
            piRevision: page.piRevision,
            piBeforeEntryId: page.piBeforeEntryId,
            hasMoreHistory: page.hasMore,
            loadingInitial: false,
            loadingMore: false,
          };
          const messagesUnchanged = areMessagesEquivalent(
            projection.messages,
            messages,
          );
          const paginationUnchanged =
            projection.pagination.initialStatus === nextPagination.initialStatus &&
            projection.pagination.oldestSequence === nextPagination.oldestSequence &&
            JSON.stringify(projection.pagination.piRevision) === JSON.stringify(nextPagination.piRevision) &&
            projection.pagination.piBeforeEntryId === nextPagination.piBeforeEntryId &&
            projection.pagination.hasMoreHistory === nextPagination.hasMoreHistory &&
            projection.pagination.loadingInitial === nextPagination.loadingInitial &&
            projection.pagination.loadingMore === nextPagination.loadingMore;
          if (messagesUnchanged && paginationUnchanged) return projection;
          return {
            ...projection,
            // History adapters allocate fresh objects. Preserve the existing
            // array when the persisted view is already identical, avoiding a
            // needless NodeView/conversation render after every run.
            messages: messagesUnchanged
              ? projection.messages
              : messages,
            pagination: nextPagination,
          };
        });
        if (agentType === "codex") {
          const cached = get().codexLiveTurns[threadId];
          if (cached && cached.runId === runId) {
            if (historyCoversLiveTurn(historicalMessages, cached.messages)) {
              get().clearCodexLiveTurn(threadId, runId);
            }
          }
        }
        } catch (error) {
          console.error("[AgentSession] Failed to reconcile completed run:", error);
        }
      })();
      if (agentType === "codex") {
        codexReconciles.set(threadId, reconcile);
        try {
          await reconcile;
        } finally {
          if (codexReconciles.get(threadId) === reconcile) codexReconciles.delete(threadId);
        }
      } else {
        await reconcile;
      }
    },
    loadMoreMessages: async (agentType, threadId) => {
      const current = get().threadProjections[threadId];
      if (
        !current ||
        current.pagination.loadingMore ||
        !current.pagination.hasMoreHistory ||
        current.pagination.oldestSequence === null ||
        get().threadTombstones[threadId]
      ) {
        return;
      }
      const requestEpoch = get().threadEpochs[threadId] ?? 0;
      get().setThreadProjection(threadId, (projection) => ({
        ...projection,
        pagination: { ...projection.pagination, loadingMore: true },
      }));
      try {
        const page = await getHistoryPage(
          agentType,
          threadId,
          current.pagination.oldestSequence,
          HISTORY_PAGE_SIZE,
          current.pagination.snapshotSequence,
          current.pagination.piRevision,
          current.pagination.piBeforeEntryId,
        );
        if (!isRequestCurrent(threadId, requestEpoch)) return;
        const messages = filterRenderableHistoryMessages(page.messages);
        get().setThreadProjection(threadId, (projection) => {
          const currentSnapshot = projection.pagination.snapshotSequence;
          const nativeSnapshotChanged = agentType === "pi" &&
            JSON.stringify(projection.pagination.piRevision) !== JSON.stringify(page.piRevision);
          if (
            nativeSnapshotChanged || (
              currentSnapshot != null && page.snapshotSequence != null &&
              currentSnapshot !== page.snapshotSequence)
          ) {
            return {
              ...projection,
              pagination: { ...projection.pagination, loadingMore: false },
            };
          }
          return {
            ...projection,
            messages: prependHistoricalMessages(
              projection.messages,
              messages,
              agentType,
            ),
            pagination: {
              oldestSequence:
                page.oldestSequence ?? projection.pagination.oldestSequence,
              snapshotSequence:
                page.snapshotSequence ?? currentSnapshot ?? null,
              piRevision: page.piRevision,
              piBeforeEntryId: page.piBeforeEntryId,
              hasMoreHistory: page.hasMore,
              loadingInitial: false,
              loadingMore: false,
            },
          };
        });
      } catch (error) {
        if (!isRequestCurrent(threadId, requestEpoch)) return;
        get().setThreadProjection(threadId, (projection) => ({
          ...projection,
          pagination: { ...projection.pagination, loadingMore: false },
        }));
        const stalePiSnapshot = agentType === "pi" && error instanceof PiHistorySnapshotChangedError;
        if (stalePiSnapshot) {
          await get().loadMessages(agentType, threadId);
          return;
        }
        console.error("[AgentSession] Failed to load more messages:", error);
      }
    },
  };
}
