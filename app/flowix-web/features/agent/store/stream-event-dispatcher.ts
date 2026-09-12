import type { AgentEvent, AgentTypeKey } from "@/types/agent";
import { getAgentType } from "@/lib/agent-types";
import { recordAgentLifecycleEvent } from "@features/agent/diagnostics/agent-run-trace";
import {
  emptyProjection,
  isProjectionRunActive,
  isProjectionRunEnded,
} from "@features/agent/store/session-reducer";
import {
  createStreamingBuffer,
  type StreamingScheduler,
  type StreamingBufferSnapshot,
} from "@features/agent/store/streaming-buffer";

/**
 * Stream orchestration over an injected single-write port:
 * late-chunk guard, ensureRunActive, buffering and session resolution all end
 * in one canonical `threadProjections[tid]` dispatch path.
 *
 * 涉及模块边界 (2026-08-02):
 * - session-reducer: 纯 reducer (`reduceProjection(projection, event) → projection`).
 * - agent-session-store: composition root and state ownership.
 * - this module: buffering and event ordering without a Zustand dependency.
 */

export interface StreamEventDispatcher {
  /**
   * 派发一个 AgentEvent。 text / reasoning 走 rAF 缓冲, 其它事件同步 flush
   * 后再走 reducer。 session_resolved 还会清空 streamingBuffer 以避免悬空
   * 缓冲写错 thread id。
   */
  dispatch(event: AgentEvent): void;
  /** 同步 flush 当前 buffered text/reasoning chunk ── 给 stopThreadRun 用。 */
  flushBuffer(): void;
}

export interface StreamEventDispatcherPorts {
  getProjection(threadId: string): ReturnType<typeof emptyProjection> | undefined;
  getThreadAgentType(threadId: string): AgentTypeKey;
  resolveThreadId(threadId: string): string;
  canDispatch(threadId: string): boolean;
  dispatch(event: AgentEvent): void;
  applySessionResolved(event: AgentEvent & { kind: "session_resolved" }): void;
}

// --------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------

/**
 * 是否为承载消息内容的 data chunk ── 这些 chunk 若在一个已终结 run 之后到达
 * (late chunk), 会被 dispatch 顶部 guard 丢弃, 防止 ensureRunActive 复活 run
 * 与 pendingAssistantId=null 导致的新建消息碎片化。
 */
function isDataChunk(kind: AgentEvent["kind"]): boolean {
  return (
    kind === "text_delta" ||
    kind === "user_message" ||
    kind === "reasoning_delta" ||
    kind === "context_compaction" ||
    kind === "final_message" ||
    kind === "tool_call" ||
    kind === "tool_result"
  );
}

/**
 * 哪些 event 表明 thread 已经处于 "应当 active" 但 projection 还没记录
 * stream_start 的状态 ── 这种情况下 dispatcher 补丁式合成一个 stream_start
 * event, 通过注入的 dispatch port 应用, 然后 dispatch 原 event.
 */
function shouldEnsureRunActive(event: AgentEvent): boolean {
  return (
    event.kind === "text_delta" ||
    event.kind === "final_message" ||
    event.kind === "reasoning_delta" ||
    event.kind === "context_compaction" ||
    event.kind === "tool_call" ||
    event.kind === "tool_result"
  );
}

function synthesizeStreamStart(event: AgentEvent): AgentEvent & {
  kind: "stream_start";
} {
  return {
    kind: "stream_start",
    agentType: event.agentType,
    threadId: event.threadId,
    runId: event.runId ?? `${event.threadId}-synthetic`,
    timestamp: event.timestamp,
  };
}

// --------------------------------------------------------------------
// session_resolved ── 跨 thread 合并 projection + 更新 sessionMeta
// --------------------------------------------------------------------

// --------------------------------------------------------------------
// dispatcher factory
// --------------------------------------------------------------------

export function createStreamEventDispatcher(
  ports: StreamEventDispatcherPorts,
  scheduler?: StreamingScheduler,
): StreamEventDispatcher {
  const streamingBuffer = createStreamingBuffer(
    (
      textSnapshot: StreamingBufferSnapshot,
      reasoningSnapshot: StreamingBufferSnapshot,
    ) => {
      const now = Date.now();
      // reasoning 先 apply ── 与旧 store 时序一致 (reasoning chunk 先于
      // text 出现; text chunk 落地时会 close reasoning 行).
      for (const [tid, text] of reasoningSnapshot) {
        const canonicalThreadId = ports.resolveThreadId(tid);
        if (!ports.canDispatch(canonicalThreadId)) continue;
        const current = ports.getProjection(canonicalThreadId);
        if (!current || !current.runs.activeRunId) continue;
        const agentType = getAgentType(ports.getThreadAgentType(canonicalThreadId)).key;
        ports.dispatch({
          kind: "reasoning_delta",
          agentType,
          threadId: canonicalThreadId,
          runId: current.runs.activeRunId,
          timestamp: now,
          text,
          messagePhase: "updated",
          contentMode: "delta",
          sourceTimestamp: now,
        });
      }
      for (const [tid, text] of textSnapshot) {
        const canonicalThreadId = ports.resolveThreadId(tid);
        if (!ports.canDispatch(canonicalThreadId)) continue;
        const current = ports.getProjection(canonicalThreadId);
        if (!current || !current.runs.activeRunId) continue;
        const agentType = getAgentType(ports.getThreadAgentType(canonicalThreadId)).key;
        ports.dispatch({
          kind: "text_delta",
          agentType,
          threadId: canonicalThreadId,
          runId: current.runs.activeRunId,
          timestamp: now,
          text,
          messagePhase: "updated",
          contentMode: "delta",
          sourceTimestamp: now,
        });
      }
    },
    scheduler,
  );

  function dispatch(inputEvent: AgentEvent): void {
    let event = inputEvent;
    if (event.kind !== "session_resolved") {
      const canonicalThreadId = ports.resolveThreadId(event.threadId);
      if (canonicalThreadId !== event.threadId) {
        event = { ...event, threadId: canonicalThreadId } as AgentEvent;
      }
    }
    if (!ports.canDispatch(event.threadId)) return;
    const current = ports.getProjection(event.threadId) ?? emptyProjection();

    recordAgentLifecycleEvent(event, {
      activeRunId: current.runs.activeRunId,
      isLoading: current.runs.isLoading,
    });

    // Late chunk guard: data chunk 到达已终结 run 时丢弃.
    if (isDataChunk(event.kind) && isProjectionRunEnded(current, event.runId)) {
      return;
    }

    // session_resolved 是跨 thread 合并, 不进单 projection dispatch.
    if (event.kind === "session_resolved") {
      streamingBuffer.flushSync();
      ports.applySessionResolved(event);
      return;
    }

    // ensureRunActive: data chunk 但 projection 还不是 running 状态.
    if (shouldEnsureRunActive(event) && !isProjectionRunActive(current)) {
      ports.dispatch(synthesizeStreamStart(event));
    }

    // text / reasoning 走 rAF 缓冲.
    switch (event.kind) {
      case "text_delta": {
        if (!event.text || !event.text.trim()) return;
        if (
          event.messageId ||
          event.contentMode === "snapshot" ||
          // Legacy Claude envelope ids are intentionally removed by the
          // mapper. Apply their ordered deltas synchronously so source order
          // metadata survives database replay and tool boundaries.
          event.sourceSequence !== undefined
        ) {
          streamingBuffer.flushSync();
          ports.dispatch(event);
          return;
        }
        streamingBuffer.appendText(event.threadId, event.text);
        return;
      }
      case "reasoning_delta": {
        if (event.messageId || event.contentMode === "snapshot") {
          streamingBuffer.flushSync();
          ports.dispatch(event);
          return;
        }
        streamingBuffer.appendReasoning(event.threadId, event.text);
        return;
      }
      case "context_compaction":
        // Compaction is a timeline marker and must appear before any later
        // assistant output; flush buffered text before inserting it.
        streamingBuffer.flushSync();
        break;
      case "final_message":
      case "tool_call":
      case "tool_result":
      case "error":
      case "stream_end":
        // 这些 chunk 频率低且必须立刻可见, 不走节流; 但必须先 flush 缓冲.
        streamingBuffer.flushSync();
        break;
      case "stream_start":
      case "usage":
        // stream_start / usage 无需 flush.
        break;
      case "codex_command":
      case "user_message":
        streamingBuffer.flushSync();
        break;
    }

    ports.dispatch(event);
  }

  return {
    dispatch,
    flushBuffer: () => streamingBuffer.flushSync(),
  };
}
