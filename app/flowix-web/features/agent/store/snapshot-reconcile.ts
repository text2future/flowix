import type { AgentTypeKey, RunInfo } from "@/types/agent";
import { applyExternalSessionResolved } from "@features/agent/store/external-session";
import {
  emptyThreadState,
  type ThreadState,
  type ThreadsMap,
} from "@features/agent/store/thread-runtime-state";

export const RUNNING_RUN_OPTIMISTIC_GRACE_MS = 3000;
export const RUN_MISSING_FROM_SNAPSHOT_REASON = "missing_from_snapshot";

export function optimisticUntilFromStartedAt(startedAt: number): number {
  return startedAt + RUNNING_RUN_OPTIMISTIC_GRACE_MS;
}

export function isThreadRunActiveInState(st: ThreadState): boolean {
  return (
    st.isLoading &&
    !!st.activeRunId &&
    st.runs[st.activeRunId]?.status === "running"
  );
}

/**
 * 后端 running snapshot → chat-store.threadStates / threadTypes /
 * externalSessionResolutions 纯状态转换。 不直接修改 conversation store ──
 * instance / run 副作用由 caller 通过 conversation-run-sync 走。
 *
 * 行为:
 * - 补齐后端确认 active 的 run (applyRunStarted).
 * - 处理 local (pending) thread id → canonical session id 的兼容映射
 *   (applyExternalSessionResolved 在 caller 之前已经迁过 conversation messages).
 * - 收敛 grace window 之外、本地残留的 'running' run 为 'failed / missing_from_snapshot'.
 */
export function reconcileThreadStatesFromRunningSnapshot(
  state: {
    threadStates: ThreadsMap;
    threadTypes: Record<string, AgentTypeKey>;
    externalSessionResolutions: Record<string, string>;
  },
  running: Record<string, RunInfo>,
  now: number,
  applyRunStarted: (st: ThreadState, info: RunInfo, runId: string) => ThreadState,
): {
  threadStates: ThreadsMap;
  threadTypes: Record<string, AgentTypeKey>;
  externalSessionResolutions: Record<string, string>;
  lastRunningRunsReconciledAt: number;
} {
  let nextThreadStates: ThreadsMap = { ...state.threadStates };
  let nextThreadTypes: Record<string, AgentTypeKey> = { ...state.threadTypes };
  const nextExternalSessionResolutions = {
    ...state.externalSessionResolutions,
  };
  const backendRunIds = new Set<string>();

  for (const [threadId, info] of Object.entries(running)) {
    const localThreadId = info.pendingThreadId || threadId;
    const canonicalThreadId = info.sessionId || threadId;
    // 后端把 local thread id 解析成 canonical session id 时, 同步迁移
    // runtime state + externalSessionResolutions ── 与 dispatchAgentEvent
    // 的 session_resolved 分支、migrateThreadState action 共用同一个
    // external-session.ts 的 helper, 避免重复实现。
    if (info.sessionId && localThreadId !== canonicalThreadId) {
      const resolved = applyExternalSessionResolved(
        {
          threadStates: nextThreadStates,
          threadTypes: nextThreadTypes,
          externalSessionResolutions: nextExternalSessionResolutions,
        },
        localThreadId,
        canonicalThreadId,
        (info.agentType ?? "flowix") as AgentTypeKey,
      );
      nextThreadStates = resolved.threadStates;
      nextThreadTypes = resolved.threadTypes;
      Object.assign(nextExternalSessionResolutions, resolved.externalSessionResolutions);
    }
    const existing =
      nextThreadStates[canonicalThreadId] ??
      nextThreadStates[localThreadId] ??
      emptyThreadState();
    const runId =
      info.runId ?? existing.activeRunId ?? `${canonicalThreadId}-${now}`;
    nextThreadStates[canonicalThreadId] = applyRunStarted(
      existing,
      info,
      runId,
    );
    nextThreadTypes[canonicalThreadId] =
      info.agentType ?? nextThreadTypes[canonicalThreadId];
    nextThreadTypes[localThreadId] =
      info.agentType ?? nextThreadTypes[localThreadId];
    backendRunIds.add(runId);
  }

  for (const [threadId, threadState] of Object.entries(nextThreadStates)) {
    if (!isThreadRunActiveInState(threadState)) continue;
    const runId = threadState.activeRunId;
    if (!runId || backendRunIds.has(runId)) continue;
    const run = threadState.runs[runId];
    const optimisticUntil = run?.startedAt
      ? optimisticUntilFromStartedAt(run.startedAt)
      : 0;
    if (optimisticUntil > now) {
      continue;
    }
    const { [runId]: _removed, ...runs } = threadState.runs;
    const failedRun = run
      ? {
          ...run,
          status: "failed" as const,
          endedAt: now,
          reason: RUN_MISSING_FROM_SNAPSHOT_REASON,
          currentTool: null,
        }
      : undefined;
    nextThreadStates[threadId] = {
      ...threadState,
      isLoading: false,
      activeRunId: null,
      pendingAssistantId: null,
      pendingReasoningId: null,
      runs,
      lastRun: failedRun ?? threadState.lastRun,
    };
  }

  return {
    threadStates: nextThreadStates,
    threadTypes: nextThreadTypes,
    externalSessionResolutions: nextExternalSessionResolutions,
    lastRunningRunsReconciledAt: now,
  };
}