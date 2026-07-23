import type { ChatMessage } from "@/types";
import type {
  AgentEvent,
  AgentRunState,
  AgentRunStatus,
} from "@/types/agent";
import type { LastRunSnapshot } from "@/types/agent";

/**
 * 每个 thread 独立的运行态 ── 不再绑在"当前 active thread"上, 让 A
 * 对话在后台跑 / B 对话在前面写 / 重入 A 看到全部最新消息都能成立。
 *
 * 真源仍是 SQLite (`threadStates` 是实时增量缓存, 不进 zustand persist),
 * 切走时不需要做任何清理; 重入 thread 时调 `loadThread(tid)` 重新从
 * 磁盘 seed 一次, 再叠加 `stream_start/end` 之间的实时 chunk。
 *
 * `pendingAssistantId` / `pendingReasoningId` 是 dispatchAgentChunk
 * 内部的临时游标 ── 给 applyTextChunk / applyReasoningChunk 知道
 * 下一个 text/reasoning chunk 应该 append 到哪一行。流结束 / tool_call
 * 时归零。 业务 UI 不读这两个字段。
 */
export interface ThreadState {
  messages: ChatMessage[];
  isLoading: boolean;
  activeRunId: string | null;
  runs: Record<string, AgentRunState>;
  pendingAssistantId: string | null;
  pendingReasoningId: string | null;
  /**
   * 通用 metadata 协议 ── 最新一次 run 的展示快照。
   * runs[runId] 在正常完成时被清理,但 lastRun 仍保留 model / usage /
   * startedAt / endedAt 等关键 metadata,供 BadgeHoverCard 等"展示"层
   * 在 run 结束后仍可读。Provider-agnostic:对 Codex / Claude / Gemini /
   * Flowix / Hermes / OpenClaw 全部适用。
   */
  lastRun?: LastRunSnapshot;
  /** Layer 4: 当前 in-memory messages 中最早一条的 sequence (作下一页 cursor).
   *  null = 尚未通过分页加载 (兼容旧 loadThread 全量路径) 或 thread 为空. */
  oldestSequence: number | null;
  /** Layer 4: 是否还有更早的历史可加载. false → 顶部不再 prefetch. */
  hasMoreHistory: boolean;
  /** Layer 4: 防止并发触发顶部加载 ── true 时 loadMoreHistory 直接 early return. */
  loadingMore: boolean;
}

export type ThreadsMap = Record<string, ThreadState>;

export function emptyThreadState(): ThreadState {
  return {
    messages: [],
    isLoading: false,
    activeRunId: null,
    runs: {},
    pendingAssistantId: null,
    pendingReasoningId: null,
    oldestSequence: null,
    hasMoreHistory: false,
    loadingMore: false,
  };
}

/**
 * 把更新后的 thread state 写回到 `threadStates[threadId]` 的 immutable
 * patch。 用于 zustand setState 里保持 "只覆盖一个 entry" 的浅 spread 风格。
 */
export function threadRunUpdate(
  threadStates: ThreadsMap,
  threadId: string,
  threadState: ThreadState,
): ThreadsMap {
  return {
    ...threadStates,
    [threadId]: threadState,
  };
}

/**
 * 流结束后 / 错误后释放 thread runtime messages 的临时游标 ── 把
 * pendingAssistantId / pendingReasoningId / messages 全部清空, 真实消
 * 息已在 conversation store.messageStates 里。 让 threadStates 只保留
 * runtime + runs metadata, 避免长会话累积 tool_data 24KB x 几百条的
 * 内存负担。
 */
export function releaseThreadRuntimeMessages(st: ThreadState): ThreadState {
  if (
    st.messages.length === 0 &&
    st.pendingAssistantId === null &&
    st.pendingReasoningId === null
  ) {
    return st;
  }
  return {
    ...st,
    messages: [],
    pendingAssistantId: null,
    pendingReasoningId: null,
  };
}

/**
 * 把仍处于 loading 的 tool 行收尾为 isLoading=false ── run 结束时调用,
 * 避免"被中断 / result 未到达"的 tool_call 永久转圈(history 路径靠
 * close_orphan_claude_tool_calls 在 reload 时做同样收尾,这里补齐 live 路径)。
 * 仅在 run 真正结束(thread 不再 loading)时调用,避免误关并发 run 的工具行。
 */
export function closeLoadingToolRows(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) =>
    message.role === "tool" && message.isLoading
      ? { ...message, isLoading: false }
      : message,
  );
}

/**
 * 判断 thread 是否处于 "正在跑" 的状态 ── 用来决定是否要 ensureRunActive
 * (补丁式补一个 stream_start)。 三条都要满足: isLoading=true,
 * activeRunId 已设, runs[activeRunId].status === 'running'。
 */
export function isThreadRunActive(st: ThreadState): boolean {
  return (
    st.isLoading &&
    !!st.activeRunId &&
    st.runs[st.activeRunId]?.status === "running"
  );
}

/**
 * run status 是否为终结态 (不再 running)。用于判断 late chunk 是否属于一个
 * 已结束的 run ── 已结束 run 的后续 data chunk 应被丢弃, 不复活 run。
 */
export function isTerminalRunStatus(
  status: AgentRunStatus | undefined,
): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

/**
 * 判断 event 是否属于一个已终结的 run ── 以 lastRun 快照为准 (applyRunStopped
 * / applyRunEnded 都会写入 lastRun)。runId 缺失或 lastRun 不匹配时返回 false,
 * 保守地走原 ensureRunActive 路径, 不误杀。
 */
export function isRunEnded(
  st: ThreadState,
  runId: string | undefined,
): boolean {
  if (!runId || !st.lastRun) return false;
  return st.lastRun.runId === runId && isTerminalRunStatus(st.lastRun.status);
}

/**
 * 哪些 event 表明 thread 已经处于 "应当 active" 但 threadStates 还没记录
 * stream_start 的状态 ── 这种情况下 ensureRunActive 会补丁式合成一个
 * stream_start event, 然后调 applyRunStarted 补上 runs[runId] / isLoading。
 * 注意: stream_start / usage 自身不需要补丁 (它们就是 lifecycle 元数据)。
 */
function shouldEnsureRunActive(event: AgentEvent): boolean {
  return (
    event.kind === "text_delta" ||
    event.kind === "final_message" ||
    event.kind === "reasoning_delta" ||
    event.kind === "tool_call" ||
    event.kind === "tool_result"
  );
}

/**
 * 补丁式补上 missed stream_start ── 用于后端丢失 stream_start event 但已
 * 开始发 text / reasoning / tool chunk 的恢复场景。 不会覆盖已经存在的
 * active run, 但会让 runs[runId] status 落为 'running', 让 UI 显示正确的
 * "运行中" 视觉。
 */
export function ensureRunActive(
  st: ThreadState,
  event: AgentEvent,
): ThreadState {
  if (!shouldEnsureRunActive(event)) return st;
  // 该 run 已终结 (用户 stop / 自然完成 / 失败) 时不补丁复活 ── 后端 codex
  // turn.completed 后提前 emit StreamEnd, abort 时 kill 残留的 in-flight chunk
  // 到达时 run 已 cancelled/completed。复活会把已结束的 run 翻回 running, 导致
  // UI 卡在 loading。late chunk 由 dispatcher 顶部 guard 统一丢弃。
  if (isRunEnded(st, event.runId)) return st;
  if (isThreadRunActive(st)) return st;
  return applyRunStartedImpl(st, {
    kind: "stream_start",
    agentType: event.agentType,
    threadId: event.threadId,
    runId: event.runId,
    timestamp: event.timestamp,
  });
}

/**
 * 内部 helper: 走和 run-lifecycle 同样的 upsertRun + lastRun 协议, 但不导
 * 入 run-lifecycle.ts 以避免循环依赖 (run-lifecycle.ts 也会需要 ThreadState
 * 的 shape)。 复制一份最小实现 ── 只覆盖 ensureRunActive 这条补丁路径
 * 需要的字段, 不参与完整 reducer 链。
 */
function applyRunStartedImpl(
  st: ThreadState,
  event: AgentEvent & { kind: "stream_start" },
): ThreadState {
  const existing = st.runs[event.runId];
  const run: AgentRunState = {
    ...existing,
    runId: event.runId,
    agentType: event.agentType,
    threadId: event.threadId,
    startedAt: existing?.startedAt ?? event.timestamp,
    status: "running",
  };
  return {
    ...st,
    isLoading: true,
    activeRunId: event.runId,
    runs: { ...st.runs, [event.runId]: run },
  };
}
