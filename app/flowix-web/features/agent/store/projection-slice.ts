import type { AgentEvent } from "@/types/agent";
import type {
  AgentConversationRegistry,
  AgentSessionMeta,
} from "@features/agent/store/session-state";
import {
  emptyProjection,
  reduceProjection,
  type ThreadProjection,
} from "@features/agent/store/session-reducer";
import {
  liveTurnMessages,
  type CodexLiveTurnCache,
} from "@features/agent/store/codex-live-turn-cache";
import {
  EMPTY_CONVERSATION_RUN_SIGNATURE,
  getConversationRunSignature,
  splitConversationRunSignature,
} from "@features/agent/store/conversation-run-signature";

type SessionSet = (
  updater: (state: ProjectionContext) => Partial<ProjectionContext> | ProjectionContext,
) => void;

type ProjectionContext = ProjectionSlice & {
  sessionMeta: AgentSessionMeta;
  conversationRegistry: AgentConversationRegistry;
};

/** Apply projection removal and its derived run indexes in one store commit. */
export function removeProjectionPatch(
  state: ProjectionContext,
  threadId: string,
): Partial<ProjectionContext> {
  const { [threadId]: _removed, ...threadProjections } = state.threadProjections;
  const { [threadId]: _removedLive, ...codexLiveTurns } = state.codexLiveTurns;
  const { [threadId]: _removedSignature, ...threadRunSignatures } = state.threadRunSignatures;
  const { [threadId]: _removedCompleted, ...latestCompletedRunIds } = state.latestCompletedRunIds;
  const { [threadId]: _removedRead, ...readThroughRunIds } = state.readThroughRunIds;
  const hadRunIndex = threadId in state.threadRunSignatures ||
    threadId in state.latestCompletedRunIds || threadId in state.readThroughRunIds;
  return {
    threadProjections,
    codexLiveTurns,
    threadRunSignatures,
    latestCompletedRunIds,
    readThroughRunIds,
    runStateVersion: hadRunIndex ? state.runStateVersion + 1 : state.runStateVersion,
  };
}
export interface ProjectionSlice {
  threadProjections: Record<string, ThreadProjection>;
  /** Incrementally maintained lifecycle projection used by conversation rows. */
  threadRunSignatures: Record<string, string>;
  /** Latest terminal run observed for each thread. */
  latestCompletedRunIds: Record<string, string>;
  /** Latest terminal run acknowledged by a reading surface. */
  readThroughRunIds: Record<string, string>;
  /** Changes only when lifecycle fields change, not for message chunks. */
  runStateVersion: number;
  threadEpochs: Record<string, number>;
  threadTombstones: Record<string, true>;
  /** Blocks new local commands while archive/delete is in progress. */
  threadMutationGuards: Record<string, true>;
  setThreadMutationGuard(threadId: string, guarded: boolean): void;
  appendTransientCommandResult(threadId: string, content: string): void;
  codexLiveTurns: Record<string, CodexLiveTurnCache>;
  clearCodexLiveTurn(threadId: string, runId?: string): void;
  dispatch(event: AgentEvent): void;
  updateThreadHistory(
    threadId: string,
    updater: (projection: Readonly<ThreadProjection>) => Pick<ThreadProjection, "messages" | "pagination">,
  ): void;
  updateThreadRuns(
    threadId: string,
    updater: (projection: Readonly<ThreadProjection>) => ThreadProjection["runs"],
  ): void;
  clearThreadPending(threadId: string): void;
  removeThreadProjection(threadId: string): void;
  resetThreadProjections(threadIds: string[]): void;
  activateThread(threadId: string): void;
  invalidateThread(threadId: string, deleted?: boolean): void;
  applySessionResolved(
    event: AgentEvent & { kind: "session_resolved" },
  ): void;
  markThreadRead(threadId: string, runId?: string | null): void;
}

export function createProjectionSlice(
  set: SessionSet,
): ProjectionSlice {
  const runStatePatch = (
    state: ProjectionContext,
    threadId: string,
    nextProjection: ThreadProjection,
  ): Partial<ProjectionContext> => {
    const previousSignature = state.threadRunSignatures[threadId]
      ?? getConversationRunSignature(state.threadProjections[threadId]);
    const nextSignature = getConversationRunSignature(nextProjection);
    const previousStatus = splitConversationRunSignature(previousSignature).status;
    const nextStatus = splitConversationRunSignature(nextSignature).status;
    const runEnded = previousStatus === "running"
      && nextStatus !== "running"
      && nextStatus !== null;
    const nextRunId = splitConversationRunSignature(nextSignature).runId;
    if (previousSignature === nextSignature && !runEnded) return {};

    const threadRunSignatures = { ...state.threadRunSignatures };
    if (nextSignature === EMPTY_CONVERSATION_RUN_SIGNATURE) {
      delete threadRunSignatures[threadId];
    } else {
      threadRunSignatures[threadId] = nextSignature;
    }
    return {
      threadRunSignatures,
      runStateVersion: state.runStateVersion + 1,
      ...(runEnded && nextRunId
        ? { latestCompletedRunIds: { ...state.latestCompletedRunIds, [threadId]: nextRunId } }
        : {}),
    };
  };

  return {
    threadProjections: {},
    threadRunSignatures: {},
    latestCompletedRunIds: {},
    readThroughRunIds: {},
    runStateVersion: 0,
    threadEpochs: {},
    threadTombstones: {},
    threadMutationGuards: {},
    setThreadMutationGuard: (threadId, guarded) => {
      if (!threadId) return;
      set((state) => {
        if (Boolean(state.threadMutationGuards[threadId]) === guarded) return state;
        const threadMutationGuards = { ...state.threadMutationGuards };
        if (guarded) threadMutationGuards[threadId] = true;
        else delete threadMutationGuards[threadId];
        return { threadMutationGuards };
      });
    },
    appendTransientCommandResult: (threadId, content) => {
      const now = Date.now();
      set((state) => {
        if (state.threadTombstones[threadId] || state.threadMutationGuards[threadId]) return state;
        const projection = state.threadProjections[threadId] ?? emptyProjection();
        return {
          threadProjections: {
            ...state.threadProjections,
            [threadId]: {
              ...projection,
              messages: [...projection.messages, {
                id: `dsh-command-result-${now}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
                role: "system" as const,
                content,
                timestamp: new Date(now).toISOString(),
              }],
            },
          },
        };
      });
    },
    codexLiveTurns: {},
    markThreadRead: (threadId, runId) => {
      if (!threadId) return;
      set((state) => {
        const targetRunId = runId ?? state.latestCompletedRunIds[threadId];
        // A delayed surface may acknowledge an older run after a newer run
        // has completed. Never let that stale acknowledgement move the
        // cursor backwards or clear the newer unread result.
        if (
          !targetRunId ||
          targetRunId !== state.latestCompletedRunIds[threadId] ||
          state.readThroughRunIds[threadId] === targetRunId
        ) return state;
        return {
          readThroughRunIds: {
            ...state.readThroughRunIds,
            [threadId]: targetRunId,
          },
        };
      });
    },
    clearCodexLiveTurn: (threadId, runId) => {
      set((state) => {
        const current = state.codexLiveTurns[threadId];
        if (!current || (runId && current.runId !== runId)) return state;
        const { [threadId]: _removed, ...codexLiveTurns } = state.codexLiveTurns;
        return { codexLiveTurns };
      });
    },
    dispatch: (event) => {
      set((state) => {
        if (state.threadTombstones[event.threadId]) return state;
        const current =
          state.threadProjections[event.threadId] ?? emptyProjection();
        const next = reduceProjection(current, event);
        if (next === current) return state;
        const codexLiveTurns = { ...state.codexLiveTurns };
        if (event.agentType === "codex" && event.runId) {
          if (event.kind === "stream_end" || event.kind === "error") {
            const cached = codexLiveTurns[event.threadId];
            if (cached?.runId === event.runId) {
              codexLiveTurns[event.threadId] = { ...cached, status: "completed", updatedAt: Date.now() };
            }
          } else {
            // Tool events do not repeat the turn id; keep the last one seen
            // so the cache can anchor the run slice after the user row has
            // adopted its provider id.
            const previous = codexLiveTurns[event.threadId];
            const turnId = event.codexTurnId ?? previous?.turnId;
            codexLiveTurns[event.threadId] = {
              runId: event.runId,
              turnId: turnId ?? previous?.turnId,
              messages: liveTurnMessages(next.messages, event.runId, turnId),
              status: "running",
              updatedAt: Date.now(),
            };
          }
        }
        return {
          threadProjections: {
            ...state.threadProjections,
            [event.threadId]: next,
          },
          codexLiveTurns,
          ...runStatePatch(state, event.threadId, next),
        };
      });
    },
    updateThreadHistory: (threadId, updater) => {
      set((state) => {
        if (state.threadTombstones[threadId]) return state;
        const current = state.threadProjections[threadId] ?? emptyProjection();
        const nextHistory = updater(current);
        if (nextHistory.messages === current.messages && nextHistory.pagination === current.pagination) return state;
        return { threadProjections: { ...state.threadProjections, [threadId]: {
          ...current, messages: nextHistory.messages, pagination: nextHistory.pagination,
        } } };
      });
    },
    updateThreadRuns: (threadId, updater) => {
      set((state) => {
        if (state.threadTombstones[threadId]) return state;
        const current = state.threadProjections[threadId] ?? emptyProjection();
        const runs = updater(current);
        if (runs === current.runs) return state;
        const next = { ...current, runs };
        return { threadProjections: { ...state.threadProjections, [threadId]: next },
          ...runStatePatch(state, threadId, next) };
      });
    },
    clearThreadPending: (threadId) => {
      set((state) => {
        if (state.threadTombstones[threadId]) return state;
        const current = state.threadProjections[threadId] ?? emptyProjection();
        if (!current.pending.assistantId && !current.pending.reasoningId) return state;
        return { threadProjections: { ...state.threadProjections, [threadId]: {
          ...current, pending: { assistantId: null, reasoningId: null },
        } } };
      });
    },
    removeThreadProjection: (threadId) => {
      set((state) => {
        if (!(threadId in state.threadProjections)) return state;
        return removeProjectionPatch(state, threadId);
      });
    },
    resetThreadProjections: (threadIds) => {
      set((state) => {
        const threadProjections = { ...state.threadProjections };
        const latestCompletedRunIds = { ...state.latestCompletedRunIds };
        const readThroughRunIds = { ...state.readThroughRunIds };
        for (const threadId of threadIds) {
          if (!state.threadTombstones[threadId]) {
            const cached = state.codexLiveTurns[threadId];
            threadProjections[threadId] = {
              ...emptyProjection(),
              ...(cached ? { messages: cached.messages } : {}),
            };
            delete latestCompletedRunIds[threadId];
            delete readThroughRunIds[threadId];
          }
        }
        let threadRunSignatures = state.threadRunSignatures;
        let runStateVersion = state.runStateVersion;
        for (const threadId of threadIds) {
          if (state.threadTombstones[threadId]) continue;
          const patch = runStatePatch(
            { ...state, threadRunSignatures, runStateVersion },
            threadId,
            threadProjections[threadId],
          );
          if (patch.threadRunSignatures) threadRunSignatures = patch.threadRunSignatures;
          if (patch.runStateVersion !== undefined) runStateVersion = patch.runStateVersion;
        }
        return { threadProjections, threadRunSignatures, runStateVersion,
          latestCompletedRunIds, readThroughRunIds };
      });
    },
    activateThread: (threadId) => {
      if (!threadId) return;
      set((state) => {
        if (!state.threadTombstones[threadId]) return state;
        const { [threadId]: _removed, ...threadTombstones } =
          state.threadTombstones;
        return {
          threadTombstones,
          threadEpochs: {
            ...state.threadEpochs,
            [threadId]: (state.threadEpochs[threadId] ?? 0) + 1,
          },
        };
      });
    },
    invalidateThread: (threadId, deleted = false) => {
      if (!threadId) return;
      set((state) => ({
        threadEpochs: {
          ...state.threadEpochs,
          [threadId]: (state.threadEpochs[threadId] ?? 0) + 1,
        },
        ...(deleted
          ? {
              threadTombstones: {
                ...state.threadTombstones,
                [threadId]: true as const,
              },
            }
          : {}),
        ...(deleted
          ? (() => {
              const { [threadId]: _removed, ...codexLiveTurns } = state.codexLiveTurns;
              return { codexLiveTurns };
            })()
          : {}),
      }));
    },
    applySessionResolved: (event) => {
      const threadId = event.threadId;
      const providerSessionId = event.sessionId;
      if (!providerSessionId) return;
      set((state) => {
        const instances = state.conversationRegistry.instances;
        const changedInstances = Object.entries(instances).filter(([, instance]) =>
          instance.threadId === threadId && instance.providerSessionId !== providerSessionId,
        );
        const conversationRegistry = changedInstances.length > 0 ? {
          instances: {
            ...instances,
            ...Object.fromEntries(changedInstances.map(([id, instance]) =>
              [id, { ...instance, providerSessionId }],
            )),
          },
        } : state.conversationRegistry;
        return {
          conversationRegistry,
          sessionMeta: {
            ...state.sessionMeta,
            threadTypes: {
              ...state.sessionMeta.threadTypes,
              [threadId]: event.agentType,
            },
            externalSessionResolutions: {
              ...state.sessionMeta.externalSessionResolutions,
              [threadId]: providerSessionId,
            },
            activeThreadIds: {
              ...state.sessionMeta.activeThreadIds,
              [event.agentType]: threadId,
            },
            activeAgentTypeKey: event.agentType,
          },
        };
      });
    },
  };
}
