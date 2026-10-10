import type { ChatMessage } from "@/types";
import type { AgentRunState, LastRunSnapshot, AgentRunStatus } from "@/types/agent";

export interface DshCommandRuntimeState {
  id: string;
  name: string;
  args: string;
  runId?: string;
  status: "pending" | "success" | "error" | "cancelled";
  startedAt: number;
  endedAt?: number;
  result?: string;
}

export interface CodexCommandRuntimeState {
  id: string;
  command: string;
  runId?: string;
  status: "pending" | "success" | "error" | "cancelled";
  startedAt: number;
  endedAt?: number;
  result?: string;
}

/**
 * Single per-thread projection derived from the backend AgentEvent stream.
 *
 * 这是 `useAgentSessionStore.threadProjections[threadId]` 持有的形态, 也是
 * `reduceProjection(projection, event) → projection` 唯一接受的 input/output.
 *
 * 派生关系:
 * - 旧 `ChatStore.threadStates[tid]` 的 metadata 字段 (isLoading / activeRunId /
 *   runs / lastRun / oldestSequence / hasMoreHistory / loadingMore) → `runs` 与
 *   `pagination`.
 * - 旧 `ConversationStore.messageStates[tid]` 的 messages / pending ids →
 *   `messages` 与 `pending`.
 * - 旧 `ChatStore.threadStates[tid].messages / pendingAssistantId /
 *   pendingReasoningId` 已被合并到这里, 是单一真源.
 */
export interface ThreadProjection {
  /** 渲染给用户的消息数组 (assistant / reasoning / tool / user). */
  messages: ChatMessage[];
  /** 流式游标 ── 下一条 text/reasoning chunk 应该 append 到哪条消息, 或 null = 开新. */
  pending: {
    assistantId: string | null;
    reasoningId: string | null;
  };
  /** 历史分页 cursor 与并发锁. */
  pagination: {
    /** Initial history request lifecycle; new projections start at `idle`. */
    initialStatus?: "idle" | "loading" | "ready" | "error";
    /** Last initial history failure, shown with the retry affordance. */
    initialError?: string | null;
    oldestSequence: number | null;
    nextCursor?: string;
    /** Provider/journal revision that owns oldestSequence and all loaded pages. */
    snapshotSequence?: number | null;
    hasMoreHistory: boolean;
    loadingInitial: boolean;
    loadingMore: boolean;
  };
  /** run 生命周期元数据. 与 messages 同生命周期, 但语义独立. */
  runs: {
    isLoading: boolean;
    activeRunId: string | null;
    runs: Record<string, AgentRunState>;
    lastRun?: LastRunSnapshot;
    /** DSH command lifecycle. Commands are not model runs, but are still
     * thread-scoped work that must drive the same busy UI. */
    dshCommand?: DshCommandRuntimeState | null;
    /** Codex-native slash command lifecycle. */
    codexCommand?: CodexCommandRuntimeState | null;
  };
}

/** The message partition consumed by pure chunk reducers. */
export type MessageProjection = Pick<ThreadProjection, "messages" | "pending">;

export const EMPTY_PENDING = Object.freeze({
  assistantId: null,
  reasoningId: null,
}) as Readonly<ThreadProjection["pending"]>;

export function emptyProjection(): ThreadProjection {
  return {
    messages: [],
    pending: { assistantId: null, reasoningId: null },
    pagination: {
      initialStatus: "idle",
      oldestSequence: null,
      snapshotSequence: null,
      hasMoreHistory: false,
      loadingInitial: false,
      loadingMore: false,
    },
    runs: {
      isLoading: false,
      activeRunId: null,
      runs: {},
      dshCommand: null,
      codexCommand: null,
    },
  };
}


// --------------------------------------------------------------------
// Run lifecycle helpers (ThreadProjection 适配版)
// --------------------------------------------------------------------

function isTerminalRunStatus(
  status: AgentRunStatus | undefined,
): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

/**
 * 判断 run 是否已终结 ── lastRun 快照匹配 + status 是终态. dispatcher 在派
 * 发 data chunk 时用作 late-chunk guard: 已结束 run 后续 chunk 丢弃, 防止
 * ensureRunActive 复活 run 与 pendingAssistantId=null 碎片化.
 */
export function isProjectionRunEnded(
  p: ThreadProjection,
  runId: string | undefined,
): boolean {
  if (!runId || !p.runs.lastRun) return false;
  return (
    p.runs.lastRun.runId === runId && isTerminalRunStatus(p.runs.lastRun.status)
  );
}

/**
 * 判断 projection 是否处于正在跑的状态 ── isLoading=true + activeRunId 已设
 * + runs[activeRunId].status === "running".
 */
export function isProjectionRunActive(p: ThreadProjection): boolean {
  return (
    p.runs.isLoading &&
    !!p.runs.activeRunId &&
    p.runs.runs[p.runs.activeRunId]?.status === "running"
  );
}
