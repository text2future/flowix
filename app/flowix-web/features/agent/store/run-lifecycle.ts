import type { AgentEvent, AgentRunState, StatusInfo, UsageInfo } from '@/types/agent';
import type { LastRunSnapshot } from '@/types/agent';

/**
 * Reason string the backend attaches to `StreamEnd` when `stop_chat` ends a
 * run (see `external_runtime::shared::USER_STOPPED_REASON`). Must map to
 * `cancelled` ── a user-initiated stop is never `failed` or `completed`.
 * Kept in sync with the Rust literal by name + value.
 */
export const USER_STOPPED_REASON = 'user_stopped';

export interface RunLifecycleThreadState {
  isLoading: boolean;
  activeRunId: string | null;
  runs: Record<string, AgentRunState>;
  pendingAssistantId: string | null;
  pendingReasoningId: string | null;
  /**
   * 通用 metadata 协议 ── 最新一次 run 的展示快照。
   * `runs[activeRunId]` 正常完成时会被清理(避免长会话内存堆积),
   * 但 `lastRun` 保留供 BadgeHoverCard / 状态栏等"展示"层读取。
   * Provider-agnostic:对 Codex / Claude / Gemini / Flowix / Hermes / OpenClaw
   * 全部适用。
   */
  lastRun?: LastRunSnapshot;
}

function upsertRun(
  st: RunLifecycleThreadState,
  event: AgentEvent,
  status: AgentRunState['status'],
  extra: Partial<AgentRunState> = {}
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

/**
 * 通用 metadata 协议 ── 从 runs[runId] 合成 LastRunSnapshot。
 * 由 applyRunStarted / applyRunUsage / applyRunEnded 内部调用,
 * 避免在多处重复写"取字段 → 拼对象"逻辑。
 */
function snapshotFromRun(
  run: AgentRunState,
  _event: AgentEvent,
  status: AgentRunState['status'],
  reason: string | null | undefined
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
  extra: Partial<AgentRunState> = {}
): T {
  const nextRuns = upsertRun(st, event, 'running', extra);
  const run = nextRuns[event.runId];
  const lastRun = snapshotFromRun(run, event, 'running', null);
  return {
    ...st,
    isLoading: true,
    activeRunId: event.runId,
    runs: nextRuns,
    // 通用 metadata 协议 ── 新 run 启动时初始化 lastRun
    // (model/startedAt 即时可用,usage 由后续 Usage chunk 累加,
    //  endedAt 由 stream_end 写入)。
    lastRun: {
      ...lastRun,
      usage: lastRun.usage ?? st.lastRun?.usage,
    },
  };
}

export function applyRunToolState<T extends RunLifecycleThreadState>(
  st: T,
  event: AgentEvent,
  currentTool: string | null
): T {
  return {
    ...st,
    runs: upsertRun(st, event, 'running', { currentTool }),
  };
}

export function applyRunFailed<T extends RunLifecycleThreadState>(
  st: T,
  event: AgentEvent,
  reason: string
): T {
  const nextRuns = upsertRun(st, event, 'failed', {
    endedAt: event.timestamp,
    reason,
  });
  const run = nextRuns[event.runId];
  // 与 applyRunEnded 同形的 `isActiveRunEnd` 守门 ── 仅当失败的正是当前
  // active run 时清 isLoading / activeRunId。 stale background run 失败
  // 不影响主 run 的"运行中"视觉, 由后续 stream_end chunk 兜底收敛。
  const isActiveRunFailure = st.activeRunId === event.runId;
  return {
    ...st,
    runs: nextRuns,
    // 通用 metadata 协议 ── 失败时立刻落 lastRun 快照(可早于 stream_end),
    // 后续 stream_end 仍可覆盖 endedAt / status。
    lastRun: snapshotFromRun(run, event, 'failed', reason),
    // 关闭 streaming 游标 ── 与 applyErrorChunk 的清 pendingAssistantId /
    // pendingReasoningId 同语义, 这里再多清 isLoading / activeRunId(active run 时)。
    // 否则在 error chunk 到 stream_end chunk 的窗口期 UI 仍显示"running",
    // 且迟到的 text/reasoning chunk 会 append 到已"失败"的 assistant 行。
    isLoading: isActiveRunFailure ? false : st.isLoading,
    activeRunId: isActiveRunFailure ? null : st.activeRunId,
    pendingAssistantId: null,
    pendingReasoningId: null,
  };
}

export function applyRunStopped<T extends RunLifecycleThreadState>(
  st: T,
  runId: string,
  endedAt: number
): T {
  const existing = st.runs[runId];
  if (!existing) return st;
  const nextRuns = {
    ...st.runs,
    [runId]: {
      ...existing,
      status: 'cancelled' as const,
      reason: existing.reason ?? 'cancelled',
      endedAt,
      currentTool: null,
    },
  };
  return {
    ...st,
    isLoading: false,
    runs: nextRuns,
    // 通用 metadata 协议 ── 取消时同步 lastRun,BadgeHoverCard 立刻可见。
    lastRun: {
      ...nextRuns[runId],
      status: 'cancelled',
    },
    pendingAssistantId: null,
    pendingReasoningId: null,
  };
}

/**
 * Accumulate Usage chunk onto the run's nested `usage` object.
 *
 * Token counts (`input_tokens` / `cached_input_tokens` / `output_tokens` /
 * `reasoning_output_tokens` / `total_tokens`) are summed across chunks.
 * `model_context_window` is overwritten per chunk (latest value wins, not
 * accumulated). `statusInfo` is also overwritten (latest snapshot).
 *
 * If `runId` is not in `runs`, the chunk is dropped — stream chunks must
 * follow a `StreamStart` to create the run.
 */
export function applyRunUsage<T extends RunLifecycleThreadState>(
  st: T,
  event: AgentEvent & { kind: 'usage' },
): T {
  const existing = st.runs[event.runId];
  if (!existing) return st;
  const evUsage: UsageInfo = event.usage ?? {};
  const prevUsage: UsageInfo = existing.usage ?? {};
  const nextUsage: UsageInfo = {
    input_tokens: (prevUsage.input_tokens ?? 0) + (evUsage.input_tokens ?? 0),
    cached_input_tokens: (prevUsage.cached_input_tokens ?? 0) + (evUsage.cached_input_tokens ?? 0),
    output_tokens: (prevUsage.output_tokens ?? 0) + (evUsage.output_tokens ?? 0),
    reasoning_output_tokens: (prevUsage.reasoning_output_tokens ?? 0) + (evUsage.reasoning_output_tokens ?? 0),
    total_tokens: (prevUsage.total_tokens ?? 0) + (evUsage.total_tokens ?? 0),
    // model_context_window is overwrite, not accumulated
    model_context_window: evUsage.model_context_window ?? prevUsage.model_context_window,
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
  // 通用 metadata 协议 ── 同步 lastRun.usage;只有 lastRun.runId === current
  // 才覆盖(避免 Usage chunk 来自某次旧 run 时污染新的 lastRun)。
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
  event: AgentEvent & { kind: 'stream_end'; reason: string | null }
): T {
  // External CLIs can resolve a local thread id to a real session id while a
  // run is in flight. Treat an unmatched stream_end as the current active run's
  // end only when the event does not point at a known sibling run.
  const effectiveRunId =
    st.activeRunId && !st.runs[event.runId] ? st.activeRunId : event.runId;
  const effectiveEvent =
    effectiveRunId === event.runId ? event : { ...event, runId: effectiveRunId };
  const existingStatus = st.runs[effectiveRunId]?.status;
  const isActiveRunEnd = !st.activeRunId || st.activeRunId === effectiveRunId;
  const shouldKeepRun = existingStatus === 'cancelled' || !!event.reason;
  // status 与 `agent-conversation-store.markRunEnded` 同形:
  //   cancelled → cancelled
  //   event.reason 非空 → failed (LLM 错误 / 超 cycle / token budget)
  //   其余 → completed (正常完成)
  // 之前用 `existingStatus === 'cancelled' ? 'cancelled' : 'failed'` 把
  // 成功 run 也写成 `'failed'`,导致 `lastRun.status` 与 `instance.run.status`
  // 在成功路径上发散。BadgeHoverCard / 状态栏读 lastRun 时永远看到 'failed'。
  const isUserStop = event.reason === USER_STOPPED_REASON;
  const status: AgentRunState['status'] =
    existingStatus === 'cancelled' || isUserStop
      ? 'cancelled'
      : event.reason
        ? 'failed'
        : 'completed';
  // 通用 metadata 协议 ── 准备最终 lastRun 快照。
  // - 优先用 runs[runId](保留 usage / model 等累加结果)
  // - 找不到时用上一轮 lastRun 兜底(stream_end 早于 run 创建等边角场景)
  //   此时 status 由上方三元决定,正常是 'completed',仅 cancelled/failed
  //   时才反映为对应值。
  const lastRunFromMap = shouldKeepRun ? st.runs[effectiveRunId] : undefined;
  const baseRun: AgentRunState = lastRunFromMap ?? {
    runId: effectiveRunId,
    agentType: event.agentType,
    threadId: event.threadId,
    startedAt: st.lastRun?.startedAt ?? event.timestamp,
    status,
    model: st.lastRun?.model,
    modelId: st.lastRun?.modelId,
    lastRunAt: st.lastRun?.lastRunAt ?? event.timestamp,
    usage: st.lastRun?.usage,
    statusInfo: st.lastRun?.statusInfo,
  };
  const finalRun: AgentRunState = {
    ...baseRun,
    status,
    endedAt: event.timestamp,
    reason: event.reason,
  };
  const idleRuns = Object.fromEntries(
    // 设计意图: `runs` map 只承担"正在进行"的 run 元数据, 展示层 (BadgeHoverCard
    // / 状态栏) 走 `lastRun`。 任何 terminated run (completed / failed /
    // cancelled) 都从 map 里清掉, 避免长会话累积。 多 run 并发场景下, 其它
    // status='running' 的 run 必须保留 ── 它们各自还有自己的生命周期, 由
    // 后续各自的 stream_end chunk 兜底收敛。
    Object.entries(st.runs).filter(([runId, run]) => {
      if (runId === effectiveRunId) return false;
      return run.status === 'running';
    })
  ) as Record<string, AgentRunState>;

  return {
    ...st,
    isLoading: isActiveRunEnd ? false : st.isLoading,
    activeRunId: isActiveRunEnd ? null : st.activeRunId,
    runs: shouldKeepRun
      ? upsertRun(st, effectiveEvent, status, {
        endedAt: event.timestamp,
        reason: event.reason,
      })
      : idleRuns,
    // 通用 metadata 协议 ── stream_end 时无条件写 lastRun。
    // 关键修复:即便 runs[event.runId] 被从 map 中清理(idleRuns 路径),
    // 展示层仍可从 lastRun 读到 model / usage / startedAt / endedAt。
    lastRun: snapshotFromRun(finalRun, event, status, event.reason),
    pendingAssistantId: null,
    pendingReasoningId: null,
  };
}
