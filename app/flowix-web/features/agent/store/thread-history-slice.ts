import type { ChatMessage } from "@/types";
import type { AgentTypeKey } from "@/types/agent";
import type { AgentConversationMessageState } from "@features/agent/store/agent-conversation-types";
import type { ConversationSlice } from "@features/agent/store/conversation-slice";
import type { ProjectionSlice } from "@features/agent/store/projection-slice";
import type { AgentSessionMeta } from "@features/agent/store/session-state";
import { emptyProjection } from "@features/agent/store/session-reducer";
import { getAgentHistoryAdapter, HistoryChangedError } from "@features/agent/store/agent-history-adapters";
import type { ThreadHistoryPage } from "@features/agent/store/agent-history-adapters";
import { createLogger } from "@/lib/logger";
import { isKnownProductThreadId, resolveStoreThreadId } from "@features/agent/store/external-session";
import { readHistoryWithTimeout } from "@features/agent/services/history-read-timeout";
import { isMissingAgentSessionError } from "@features/agent/services/history-error";
import { paginationAfterSnapshot, samePagination } from "./history-pagination";
import { createHistoryRequestCoordinator } from "@features/agent/store/history-request-coordinator";
import { restoreInlineImagePresentations } from "@features/agent/store/inline-image-presentation";
import {
  filterRenderableHistoryMessages,
  getHistoryPage,
  HISTORY_PAGE_SIZE,
  areMessagesEquivalent,
  mergeHistoricalMessages,
  prependHistoricalMessages,
} from "@features/agent/store/thread-history";
// history-sync is loaded lazily to keep its reconcile engine out of the desktop
// startup graph (`check-web-bundle.mjs` STARTUP_GZIP_BUDGET=850_000). All three
// symbols are only used inside `loadMessages` / `reconcileCompletedRun`, both
// of which are already async, so a dynamic import adds no perceptible latency.
type HistorySyncModule = typeof import("@features/agent/store/history-sync");
let historySyncModulePromise: Promise<HistorySyncModule> | null = null;
const logger = createLogger("agent-thread-history");
function loadHistorySync(): Promise<HistorySyncModule> {
  if (!historySyncModulePromise) {
    historySyncModulePromise = import("@features/agent/store/history-sync");
  }
  return historySyncModulePromise;
}

type HistoryContext = ThreadHistorySlice & ProjectionSlice &
  Partial<Pick<ConversationSlice, "recoverThreadCardAfterMissingSession">> &
  { sessionMeta: AgentSessionMeta };
type SessionGet = () => HistoryContext;

// Codex history is normally available immediately after turn completion. Keep
// one delayed retry for app-server persistence lag, but avoid four snapshots
// and four render/reconcile cycles for every completed turn.
const CODEX_RECONCILE_DELAYS = [0, 1500];

function wait(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function renderableHistoryMessages(
  threadId: string,
  agentType: AgentTypeKey,
  messages: ChatMessage[],
): ChatMessage[] {
  return restoreInlineImagePresentations(
    threadId,
    agentType,
    filterRenderableHistoryMessages(messages),
  );
}

export type HistoryLoadResult = "ready" | "error" | "stale";

export interface ThreadHistorySlice {
  getMessageState(
    threadId: string | null | undefined,
  ): AgentConversationMessageState | null;
  applyHistoryPage(
    threadId: string,
    agentType: AgentTypeKey,
    page: Pick<ThreadHistoryPage, "messages"> & { coverage: "partial" },
  ): void;
  resetMessageStates(threadIds: string[]): void;
  loadMessages(agentType: AgentTypeKey, threadId: string): Promise<HistoryLoadResult>;
  /** Reload complete provider history while preserving newer live messages. */
  reloadMessagesFromHistory(
    agentType: AgentTypeKey,
    threadId: string,
  ): Promise<ChatMessage[]>;
  reconcileCompletedRun(
    agentType: AgentTypeKey,
    threadId: string,
    runId: string,
  ): Promise<void>;
  loadMoreMessages(agentType: AgentTypeKey, threadId: string): Promise<void>;
}

export function createThreadHistorySlice(
  get: SessionGet,
): ThreadHistorySlice {
  const requests = createHistoryRequestCoordinator({
    binding: (threadId) => ({
      providerSessionId: get().sessionMeta.externalSessionResolutions[threadId],
      agentType: get().sessionMeta.threadTypes[threadId],
    }),
    epoch: (threadId) => get().threadEpochs[threadId] ?? 0,
    isDeleted: (threadId) => !!get().threadTombstones[threadId],
  });
  const productThreadIdFor = (threadId: string, agentType: AgentTypeKey) => {
    const meta = get().sessionMeta;
    return resolveStoreThreadId(
      threadId, meta.externalSessionResolutions, agentType, meta.threadTypes,
      (id) => isKnownProductThreadId(id, get()),
    );
  };

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
    applyHistoryPage: (threadId, agentType, page) => {
      const productThreadId = productThreadIdFor(threadId, agentType);
      if (!productThreadId) return;
      if (productThreadId !== threadId) return get().applyHistoryPage(productThreadId, agentType, page);
      const renderable = renderableHistoryMessages(threadId, agentType, page.messages);
      if (renderable.length === 0) return;
      get().updateThreadHistory(threadId, (current) => {
        const boundRuntime = get().sessionMeta.threadTypes[threadId];
        if (boundRuntime && boundRuntime !== agentType) return current;
        const merged = mergeHistoricalMessages(
          current.messages,
          renderable,
          agentType,
        );
        return merged === current.messages ? current : { ...current, messages: merged };
      });
    },
    resetMessageStates: (threadIds) => get().resetThreadProjections(threadIds),
    loadMessages: async (agentType, threadId) => {
      const productThreadId = productThreadIdFor(threadId, agentType);
      if (!productThreadId) return "stale";
      if (productThreadId !== threadId) return get().loadMessages(agentType, productThreadId);
      if (get().threadTombstones[threadId]) return "stale";
      const binding = requests.binding(threadId);
      if (get().threadProjections[threadId]?.pagination.loadingInitial &&
        requests.hasInitial(threadId, agentType, binding)) return "stale";
      const historyReadVersion = requests.begin(threadId);
      const requestProjection = get().threadProjections[threadId]?.messages ?? [];
      let applied = false;
      const isInitialLoad =
        (get().threadProjections[threadId]?.messages.length ?? 0) === 0 &&
        get().threadProjections[threadId]?.pagination.initialStatus !== "ready";
      // Refresh/reconciliation is stale-while-revalidate: an already rendered
      // conversation must not enter loading or invalidate its projection just
      // because a silent snapshot request started.
      if (isInitialLoad) {
        requests.startInitial(historyReadVersion, agentType, binding);
        get().updateThreadHistory(threadId, (projection) => ({
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
        const page = await readHistoryWithTimeout(() => getHistoryPage(agentType, threadId, HISTORY_PAGE_SIZE));
        if (!requests.isCurrent(historyReadVersion)) {
          return "stale";
        }
        const messages = renderableHistoryMessages(threadId, agentType, page.messages);
        const cached = agentType === "codex" ? get().codexLiveTurns[threadId] : undefined;
        const lastRun = get().threadProjections[threadId]?.runs.lastRun;
        const completedRunId =
          cached?.status === "completed"
            ? cached.runId
            : !cached && lastRun?.status === "completed"
              ? lastRun.runId
              : undefined;
        const { isOlderHistorySnapshot, historyRevision, reconcileHistorySnapshot, codexHistoryConfirmsLiveTurn } =
          await loadHistorySync();
        get().updateThreadHistory(threadId, (projection) => {
          if (!requests.isCurrent(historyReadVersion)) return projection;
          if (
            agentType !== "pi" && isOlderHistorySnapshot(
              projection.pagination.snapshotSequence,
              page.snapshotSequence,
            )
          ) {
            return projection;
          }
          const reconciled = reconcileHistorySnapshot({
            agentType, current: projection.messages,
            snapshot: { messages, coverage: page.coverage,
              revision: historyRevision(page.snapshotSequence), oldestCursor: page.oldestSequence, hasMore: page.hasMore },
            currentWindow: agentType === "codex" && projection.pagination.snapshotSequence != null
              ? {
                  start: projection.pagination.oldestSequence ?? (projection.pagination.hasMoreHistory ? null : 0),
                  end: projection.pagination.snapshotSequence,
                }
              : undefined,
            requestProjection, reason: completedRunId ? "run_completed" : "open",
            runId: cached?.runId ?? completedRunId, turnId: cached?.turnId,
          }).messages;
          const pagination = paginationAfterSnapshot(agentType, threadId, projection, page, reconciled);
          applied = true;
          const messagesUnchanged = reconciled === projection.messages;
          const paginationUnchanged = samePagination(projection.pagination, pagination);
          return messagesUnchanged && paginationUnchanged
            ? projection
            : { ...projection, messages: reconciled, pagination };
        });
        if (
          agentType === "codex" &&
          cached?.status === "completed" &&
          codexHistoryConfirmsLiveTurn(messages, cached.messages, cached.turnId, page.coverage)
        ) {
          get().clearCodexLiveTurn(threadId, cached.runId);
        }
        return applied && requests.isCurrent(historyReadVersion) ? "ready" : "stale";
      } catch (error) {
        logger.error("Failed to load messages", { error: String(error) });
        if (!requests.isCurrent(historyReadVersion)) {
          return "stale";
        }
        if (isMissingAgentSessionError(error)) {
          try {
            const recovered = await get().recoverThreadCardAfterMissingSession?.(threadId);
            if (recovered) return "ready";
          } catch (recoveryError) {
            logger.error("Failed to reset missing Thread Card session", {
              threadId,
              error: String(recoveryError),
            });
          }
        }
        if (isInitialLoad) {
          get().updateThreadHistory(threadId, (projection) => ({
            ...projection,
            pagination: {
              ...projection.pagination,
              initialStatus: "error",
              initialError: error instanceof Error ? error.message : String(error),
              loadingInitial: false,
            },
          }));
        }
        return "error";
      } finally {
        if (isInitialLoad && requests.finishInitial(historyReadVersion) && !get().threadTombstones[threadId]) {
          get().updateThreadHistory(threadId, (projection) => projection.pagination.loadingInitial
            ? { ...projection, pagination: { ...projection.pagination, loadingInitial: false, initialStatus: "idle" } }
            : projection);
        }
      }
    },
    reloadMessagesFromHistory: async (agentType, threadId) => {
      const productThreadId = productThreadIdFor(threadId, agentType);
      if (!productThreadId) return [];
      if (productThreadId !== threadId) return get().reloadMessagesFromHistory(agentType, productThreadId);
      if (!threadId || get().threadTombstones[threadId]) return [];

      // Invalidate an initial/page request that may have started before a DSH
      // command committed its surface replacement. The command refresh must
      // win over that stale response instead of merging the pre-compact rows
      // back into the projection afterwards.
      const requestProjection = get().threadProjections[threadId]?.messages ?? [];
      get().invalidateThread(threadId);
      const historyReadVersion = requests.begin(threadId);
      const history = await readHistoryWithTimeout(() => getAgentHistoryAdapter(agentType).getFullHistory(threadId));
      const { reconcileHistorySnapshot } = await loadHistorySync();
      if (!requests.isCurrent(historyReadVersion)) return [];

      const current = get().threadProjections[threadId] ?? emptyProjection();
      const messages = renderableHistoryMessages(threadId, agentType, history);
      const existingMessages = current.messages.filter(
            (message) =>
              !(
                message.messageType === "dsh-command" &&
                message.id.startsWith("dsh-command:live:")
              ),
          );
      const nextMessages = reconcileHistorySnapshot({
        agentType,
        current: existingMessages,
        snapshot: {
          messages,
          revision: null,
          oldestCursor: null,
          hasMore: false,
        },
        requestProjection,
        reason: "recovery",
      }).messages;
      get().updateThreadHistory(threadId, (projection) => {
        if (!requests.isCurrent(historyReadVersion)) return projection;
        const visibleMessages = areMessagesEquivalent(projection.messages, nextMessages)
          ? projection.messages : nextMessages;
        return {
          ...projection,
          messages: visibleMessages,
          pagination: {
            ...projection.pagination,
            initialStatus: "ready",
            initialError: null,
            oldestSequence: null,
            snapshotSequence: null,
            nextCursor: undefined,
            hasMoreHistory: false,
            loadingInitial: false,
            loadingMore: false,
          },
        };
      });
      return nextMessages;
    },
    reconcileCompletedRun: async (agentType, threadId, runId) => {
      const productThreadId = productThreadIdFor(threadId, agentType);
      if (!productThreadId) return;
      if (productThreadId !== threadId) return get().reconcileCompletedRun(agentType, productThreadId, runId);
      if (get().threadTombstones[threadId]) return;
      const reconcile = async () => {
        if (get().threadTombstones[threadId]) return;
        const historyReadVersion = requests.begin(threadId);
        try {
          const {
            isOlderHistorySnapshot,
            historyRevision,
            reconcileHistorySnapshot,
            codexHistoryConfirmsLiveTurn,
          } = await loadHistorySync();
          let page: Awaited<ReturnType<typeof getHistoryPage>> | null = null;
          let historicalMessages: ChatMessage[] = [];
          let cachedTurnId: string | undefined;
          let requestProjection: readonly ChatMessage[] = [];
          for (const delay of agentType === "codex" ? CODEX_RECONCILE_DELAYS : [0]) {
            await wait(delay);
            requestProjection = get().threadProjections[threadId]?.messages ?? [];
            page = await readHistoryWithTimeout(() => getHistoryPage(agentType, threadId, HISTORY_PAGE_SIZE));
            historicalMessages = renderableHistoryMessages(threadId, agentType, page.messages);
            const cached = get().codexLiveTurns[threadId];
            cachedTurnId = cached?.runId === runId ? cached?.turnId : undefined;
            if (
              agentType !== "codex" ||
              !cached ||
              cached.runId !== runId ||
              !cached.messages.some((message) => message.role === "user") ||
              codexHistoryConfirmsLiveTurn(historicalMessages, cached.messages, cached.turnId, page.coverage)
            ) break;
          }
          if (!page) return;
        if (!requests.isCurrent(historyReadVersion)) {
          return;
        }
        get().updateThreadHistory(threadId, (projection) => {
          if (!requests.isCurrent(historyReadVersion)) return projection;
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
              coverage: page.coverage,
              revision: historyRevision(page.snapshotSequence),
              oldestCursor: page.oldestSequence,
              hasMore: page.hasMore,
            },
            currentWindow: agentType === "codex" && projection.pagination.snapshotSequence != null
              ? {
                  start: projection.pagination.oldestSequence ?? (projection.pagination.hasMoreHistory ? null : 0),
                  end: projection.pagination.snapshotSequence,
                }
              : undefined,
            requestProjection,
            reason: "run_completed",
            runId,
            turnId: cachedTurnId,
          }).messages;
          const nextPagination = paginationAfterSnapshot(agentType, threadId, projection, page, messages);
          const messagesUnchanged = areMessagesEquivalent(projection.messages, messages);
          const paginationUnchanged = samePagination(projection.pagination, nextPagination);
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
            if (codexHistoryConfirmsLiveTurn(historicalMessages, cached.messages, cached.turnId, page.coverage)) {
              get().clearCodexLiveTurn(threadId, runId);
            }
          }
        }
        } catch (error) {
          logger.error("Failed to reconcile completed run", { error: String(error) });
        }
      };
      if (agentType === "codex") {
        await requests.reconcileCodex(threadId, runId, reconcile);
      } else {
        await reconcile();
      }
    },
    loadMoreMessages: async (agentType, threadId) => {
      const productThreadId = productThreadIdFor(threadId, agentType);
      if (!productThreadId) return;
      if (productThreadId !== threadId) return get().loadMoreMessages(agentType, productThreadId);
      const current = get().threadProjections[threadId];
      if (
        !current ||
        current.pagination.loadingMore ||
        !current.pagination.hasMoreHistory ||
        !current.pagination.nextCursor ||
        get().threadTombstones[threadId]
      ) {
        return;
      }
      const historyReadVersion = requests.begin(threadId, "more");
      get().updateThreadHistory(threadId, (projection) => ({
        ...projection,
        pagination: { ...projection.pagination, loadingMore: true },
      }));
      try {
        const page = await readHistoryWithTimeout(() => getHistoryPage(
          agentType, threadId, HISTORY_PAGE_SIZE, current.pagination.nextCursor,
        ));
        if (!requests.isCurrent(historyReadVersion)) {
          return;
        }
        const messages = renderableHistoryMessages(threadId, agentType, page.messages);
        const latest = get().threadProjections[threadId];
        if (latest?.pagination.nextCursor !== current.pagination.nextCursor) return;
        if (latest.pagination.snapshotSequence != null && page.snapshotSequence != null &&
          latest.pagination.snapshotSequence !== page.snapshotSequence) throw new HistoryChangedError();
        get().updateThreadHistory(threadId, (projection) => {
          if (!requests.isCurrent(historyReadVersion) ||
            projection.pagination.nextCursor !== current.pagination.nextCursor) return projection;
          const currentSnapshot = projection.pagination.snapshotSequence;
          return {
            ...projection,
            messages: prependHistoricalMessages(
              projection.messages,
              messages,
              agentType,
            ),
            pagination: {
              ...projection.pagination,
              oldestSequence: page.oldestSequence,
              snapshotSequence:
                page.snapshotSequence ?? currentSnapshot ?? null,
              nextCursor: page.nextCursor,
              hasMoreHistory: page.hasMore,
              loadingInitial: false,
              loadingMore: false,
            },
          };
        });
      } catch (error) {
        if (!requests.isCurrent(historyReadVersion) ||
          get().threadProjections[threadId]?.pagination.nextCursor !== current.pagination.nextCursor) {
          return;
        }
        if (error instanceof HistoryChangedError) {
          await get().loadMessages(agentType, threadId);
          return;
        }
        logger.error("Failed to load more messages", { error: String(error) });
      } finally {
        // Loading belongs to this page request, even when a snapshot read wins.
        if (requests.isLatest(historyReadVersion) && !get().threadTombstones[threadId]) {
          get().updateThreadHistory(threadId, (projection) => projection.pagination.loadingMore
            ? { ...projection, pagination: { ...projection.pagination, loadingMore: false } }
            : projection);
        }
      }
    },
  };
}
