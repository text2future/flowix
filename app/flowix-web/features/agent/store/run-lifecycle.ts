import type {
  AgentEvent,
  AgentRunState,
  LastRunSnapshot,
  StatusInfo,
  UsageInfo,
} from "@/types/agent";

export const USER_STOPPED_REASON = "user_stopped";

export interface RunLifecycleThreadState {
  isLoading: boolean;
  activeRunId: string | null;
  runs: Record<string, AgentRunState>;
  pendingAssistantId: string | null;
  pendingReasoningId: string | null;
  lastRun?: LastRunSnapshot;
}

function upsertRun(
  st: RunLifecycleThreadState,
  event: AgentEvent,
  status: AgentRunState["status"],
  extra: Partial<AgentRunState> = {},
): Record<string, AgentRunState> {
  const existing = st.runs[event.runId];
  return {
    ...st.runs,
    [event.runId]: {
      ...existing,
      runId: event.runId,
      agentType: event.agentType,
      threadId: event.threadId,
      startedAt: existing?.startedAt ?? event.timestamp,
      status,
      ...extra,
    },
  };
}

function keepRunningRuns(
  runs: Record<string, AgentRunState>,
  removeRunId?: string,
): Record<string, AgentRunState> {
  return Object.fromEntries(
    Object.entries(runs).filter(([runId, run]) => {
      if (runId === removeRunId) return false;
      return run.status === "running";
    }),
  ) as Record<string, AgentRunState>;
}

function snapshotFromRun(
  run: AgentRunState,
  status: AgentRunState["status"],
  reason: string | null | undefined,
): LastRunSnapshot {
  return {
    runId: run.runId,
    agentType: run.agentType,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    model: run.model,
    modelId: run.modelId,
    lastRunAt: run.lastRunAt,
    usage: run.usage,
    statusInfo: run.statusInfo,
    status,
    reason,
  };
}

export function applyRunStarted<T extends RunLifecycleThreadState>(
  st: T,
  event: AgentEvent,
  extra: Partial<AgentRunState> = {},
): T {
  const nextRuns = upsertRun(st, event, "running", extra);
  return {
    ...st,
    isLoading: true,
    activeRunId: event.runId,
    runs: nextRuns,
  };
}

export function applyRunToolState<T extends RunLifecycleThreadState>(
  st: T,
  event: AgentEvent,
  currentTool: string | null,
): T {
  return {
    ...st,
    runs: upsertRun(st, event, "running", { currentTool }),
  };
}

export function applyRunFailed<T extends RunLifecycleThreadState>(
  st: T,
  event: AgentEvent,
  reason: string,
): T {
  const nextRuns = upsertRun(st, event, "failed", {
    endedAt: event.timestamp,
    reason,
  });
  const run = nextRuns[event.runId];
  const isActiveRunFailure = st.activeRunId === event.runId;
  return {
    ...st,
    runs: keepRunningRuns(nextRuns, event.runId),
    lastRun: snapshotFromRun(run, "failed", reason),
    isLoading: isActiveRunFailure ? false : st.isLoading,
    activeRunId: isActiveRunFailure ? null : st.activeRunId,
    pendingAssistantId: null,
    pendingReasoningId: null,
  };
}

export function applyRunStopped<T extends RunLifecycleThreadState>(
  st: T,
  runId: string,
  endedAt: number,
): T {
  const existing = st.runs[runId];
  if (!existing) return st;
  const cancelledRun: AgentRunState = {
    ...existing,
    status: "cancelled",
    reason: existing.reason ?? "cancelled",
    endedAt,
    currentTool: null,
  };
  return {
    ...st,
    isLoading: st.activeRunId === runId ? false : st.isLoading,
    activeRunId: st.activeRunId === runId ? null : st.activeRunId,
    runs: keepRunningRuns(st.runs, runId),
    lastRun: cancelledRun,
    pendingAssistantId: null,
    pendingReasoningId: null,
  };
}

export function applyRunUsage<T extends RunLifecycleThreadState>(
  st: T,
  event: AgentEvent & { kind: "usage" },
): T {
  const existing = st.runs[event.runId];
  if (!existing) return st;
  const evUsage: UsageInfo = event.usage ?? {};
  const prevUsage: UsageInfo = existing.usage ?? {};
  const nextUsage: UsageInfo = {
    input_tokens: (prevUsage.input_tokens ?? 0) + (evUsage.input_tokens ?? 0),
    cached_input_tokens:
      (prevUsage.cached_input_tokens ?? 0) + (evUsage.cached_input_tokens ?? 0),
    output_tokens: (prevUsage.output_tokens ?? 0) + (evUsage.output_tokens ?? 0),
    reasoning_output_tokens:
      (prevUsage.reasoning_output_tokens ?? 0) +
      (evUsage.reasoning_output_tokens ?? 0),
    total_tokens: (prevUsage.total_tokens ?? 0) + (evUsage.total_tokens ?? 0),
    model_context_window:
      evUsage.model_context_window ?? prevUsage.model_context_window,
  };
  const nextStatusInfo: StatusInfo | undefined =
    event.statusInfo ?? existing.statusInfo;
  const updatedRun: AgentRunState = {
    ...existing,
    usage: nextUsage,
    statusInfo: nextStatusInfo,
    modelId: event.modelId ?? existing.modelId,
    lastRunAt: event.lastRunAt ?? existing.lastRunAt ?? event.timestamp,
  };
  const shouldUpdateLastRun = st.lastRun?.runId === event.runId;
  return {
    ...st,
    runs: {
      ...st.runs,
      [event.runId]: updatedRun,
    },
    lastRun: shouldUpdateLastRun
      ? {
          ...st.lastRun,
          usage: nextUsage,
          statusInfo: nextStatusInfo,
          modelId: event.modelId ?? st.lastRun?.modelId,
          lastRunAt: event.lastRunAt ?? st.lastRun?.lastRunAt ?? event.timestamp,
        }
      : st.lastRun,
  };
}

export function applyRunEnded<T extends RunLifecycleThreadState>(
  st: T,
  event: AgentEvent & { kind: "stream_end"; reason: string | null },
): T {
  const eventMatchesLastRun = st.lastRun?.runId === event.runId;
  const effectiveRunId =
    st.activeRunId && !st.runs[event.runId] && !eventMatchesLastRun
      ? st.activeRunId
      : event.runId;
  const matchingLastRun =
    st.lastRun?.runId === effectiveRunId ? st.lastRun : undefined;
  const existingStatus = st.runs[effectiveRunId]?.status ?? matchingLastRun?.status;
  const isActiveRunEnd = !st.activeRunId || st.activeRunId === effectiveRunId;
  const isUserStop = event.reason === USER_STOPPED_REASON;
  const status: AgentRunState["status"] =
    existingStatus === "cancelled" || isUserStop
      ? "cancelled"
      : event.reason
        ? "failed"
        : "completed";
  const baseRun: AgentRunState = st.runs[effectiveRunId] ?? {
    runId: effectiveRunId,
    agentType: event.agentType,
    threadId: event.threadId,
    startedAt: matchingLastRun?.startedAt ?? event.timestamp,
    status,
    model: matchingLastRun?.model,
    modelId: matchingLastRun?.modelId,
    lastRunAt: matchingLastRun?.lastRunAt ?? event.timestamp,
    usage: matchingLastRun?.usage,
    statusInfo: matchingLastRun?.statusInfo,
  };
  const finalRun: AgentRunState = {
    ...baseRun,
    status,
    endedAt: event.timestamp,
    reason: event.reason,
  };
  return {
    ...st,
    isLoading: isActiveRunEnd ? false : st.isLoading,
    activeRunId: isActiveRunEnd ? null : st.activeRunId,
    runs: keepRunningRuns(st.runs, effectiveRunId),
    lastRun: snapshotFromRun(finalRun, status, event.reason),
    pendingAssistantId: null,
    pendingReasoningId: null,
  };
}
