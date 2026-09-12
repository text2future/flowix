import type { AgentEvent } from "@/types/agent";
import { completedRunUserMessageId } from "@features/agent/events/message-identity";
import {
  applyErrorChunk,
  applyReasoningChunk,
  applyTextChunk,
  applyUserMessageChunk,
} from "@features/agent/store/message-chunks";
import {
  applyToolCallChunk,
  applyToolResultChunk,
} from "@features/agent/store/tool-chunks";
import {
  applyRunEnded,
  applyRunFailed,
  applyRunStarted,
  applyRunToolState,
  applyRunUsage,
} from "@features/agent/store/run-lifecycle";
import { closeLoadingToolRows } from "@features/agent/store/thread-runtime-state";
import { insertAgentMessageBySourceOrder } from "@features/agent/store/message-order";
import {
  emptyProjection,
  projectionToLive,
  projectionToRuns,
  runsToProjectionRuns,
  type ThreadProjection,
} from "@features/agent/store/session-reducer/types";

/**
 * 单一 reducer 入口: (projection, event) → projection.
 *
 * 纯函数, 无副作用, 不读外部 store. 这是双写修复的核心 ── dispatch
 * 时调一次, 一次 setState 落到 AgentSessionStore, 不再调 conv-store 与
 * chat-store 各一次.
 *
 * 实现策略:
 * - 复用现有 chunk-reducer / run-lifecycle reducer (已经是纯函数).
 * - 投影 → LiveMessageState 与 ProjectionRuns 仅作为 adapter, 让旧 reducer
 *   无需重写.
 * - 各 case 处理 event.kind → 调用合适 reducer → 合并回 ThreadProjection.
 */
export function reduceProjection(
  projection: ThreadProjection,
  event: AgentEvent,
): ThreadProjection {
  switch (event.kind) {
    case "user_message":
      return applyUserMessageToProjection(projection, event);
    case "text_delta":
      return applyTextDeltaToProjection(projection, event);
    case "reasoning_delta":
      return applyReasoningDeltaToProjection(projection, event);
    case "context_compaction":
      return applyContextCompactionToProjection(projection, event);
    case "final_message":
      return applyFinalMessageToProjection(projection, event);
    case "tool_call":
      return applyToolCallToProjection(projection, event);
    case "tool_result":
      return applyToolResultToProjection(projection, event);
    case "dsh_command":
      return applyDshCommandToProjection(projection, event);
    case "codex_command":
      return applyCodexCommandToProjection(projection, event);
    case "stream_start":
      return applyStreamStartToProjection(projection, event);
    case "stream_end":
      return applyStreamEndToProjection(projection, event);
    case "error":
      return applyErrorToProjection(projection, event);
    case "usage":
      return applyUsageToProjection(projection, event);
    case "session_resolved":
      // session_resolved 不属于本投影的语义 ── 由外部协调 (applyExternalSessionResolved)
      // 跨 thread 合并两 projection. reducer 这层不做, 直接返回.
      return projection;
    default:
      return projection;
  }
}

// --------------------------------------------------------------------
// 各 case 实现
// --------------------------------------------------------------------

function applyUserMessageToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "user_message" },
): ThreadProjection {
  // `/plan <prompt>` is represented by the DSH command row. DSH also emits
  // the prompt it puts into the steer inbox as a provider user-message event,
  // but that event is an internal model input rather than a second human
  // message. History projection already applies the same rule; do it here as
  // well so the live view matches history before the turn finishes.
  if (isLiveDshPlanPrompt(p, event.text)) return p;

  const live = projectionToLive(p);
  const next = applyUserMessageChunk(live, event.text, {
    id: event.id,
    messageType: event.messageType,
    phase: "completed",
    contentMode: "snapshot",
    sourceTimestamp: event.sourceTimestamp,
    sourceSequence: event.sourceSequence,
    sourceSubsequence: event.sourceSubsequence,
    codexTurnId: event.codexTurnId,
    // Only provider-backed user items (Codex) carry the turn id; those are
    // exactly the events allowed to adopt the optimistic row in place.
    optimisticId: event.codexTurnId
      ? completedRunUserMessageId(event.agentType, event.runId)
      : undefined,
  });
  return {
    ...p,
    messages: next.messages,
    pending: {
      assistantId: next.pendingAssistantId,
      reasoningId: next.pendingReasoningId,
    },
  };
}

function isLiveDshPlanPrompt(p: ThreadProjection, text: string): boolean {
  const prompt = text.split("\n<## CONTEXT PROMPT ##>", 1)[0].trim();
  if (!prompt) return false;

  const command = [...p.messages]
    .reverse()
    .find(
      (message) =>
        message.role === "user" &&
        message.messageType === "dsh-command" &&
        message.isLoading,
    );
  if (!command) return false;

  const match = /^\/plan(?:\s+)([\s\S]+)$/iu.exec(command.content.trim());
  return match?.[1].trim() === prompt;
}

function applyTextDeltaToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "text_delta" },
): ThreadProjection {
  const live = projectionToLive(p);
  const next = applyTextChunk(live, event.text, {
    id: event.messageId,
    phase: event.messagePhase,
    contentMode: event.contentMode,
    sourceTimestamp: event.sourceTimestamp,
    sourceSequence: event.sourceSequence,
    sourceSubsequence: event.sourceSubsequence,
    codexTurnId: event.codexTurnId,
  });
  // text 落地后 reasoning 行 closed (applyTextChunk 已把 reasoning isCompleted=true).
  // run-level state: 当前 tool 名清空 (新文本流开始).
  const runsNext = applyRunToolState(projectionToRuns(p), event, null);
  return {
    ...p,
    messages: next.messages,
    pending: {
      assistantId: next.pendingAssistantId,
      reasoningId: next.pendingReasoningId,
    },
    runs: runsToProjectionRuns(runsNext),
  };
}

function applyReasoningDeltaToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "reasoning_delta" },
): ThreadProjection {
  const live = projectionToLive(p);
  const next = applyReasoningChunk(live, event.text, {
    id: event.messageId,
    phase: event.messagePhase,
    contentMode: event.contentMode,
    sourceTimestamp: event.sourceTimestamp,
    sourceSequence: event.sourceSequence,
    sourceSubsequence: event.sourceSubsequence,
    codexTurnId: event.codexTurnId,
  });
  return {
    ...p,
    messages: next.messages,
    pending: {
      assistantId: next.pendingAssistantId,
      reasoningId: next.pendingReasoningId,
    },
  };
}

function applyContextCompactionToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "context_compaction" },
): ThreadProjection {
  const message = {
    id: event.id,
    role: "system" as const,
    content: "",
    messageType: "context-compaction" as const,
    timestamp: new Date(event.sourceTimestamp ?? event.timestamp).toISOString(),
    sourceTimestamp: event.sourceTimestamp,
    sourceSequence: event.sourceSequence,
    sourceSubsequence: event.sourceSubsequence,
    codexTurnId: event.codexTurnId,
  };
  if (p.messages.some((item) => item.id === message.id)) return p;
  return {
    ...p,
    messages: insertAgentMessageBySourceOrder(p.messages, message),
  };
}

function applyFinalMessageToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "final_message" },
): ThreadProjection {
  // final_message 形态与 text_delta 一致, 仅 contentMode="snapshot" 且 phase="completed".
  const live = projectionToLive(p);
  const next = applyTextChunk(live, event.text, {
    id: event.messageId,
    phase: event.messagePhase,
    contentMode: event.contentMode,
    sourceTimestamp: event.sourceTimestamp,
    sourceSequence: event.sourceSequence,
    sourceSubsequence: event.sourceSubsequence,
    codexTurnId: event.codexTurnId,
  });
  const runsNext = applyRunToolState(projectionToRuns(p), event, null);
  return {
    ...p,
    messages: next.messages,
    pending: {
      assistantId: next.pendingAssistantId,
      reasoningId: next.pendingReasoningId,
    },
    runs: runsToProjectionRuns(runsNext),
  };
}

function applyToolCallToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "tool_call" },
): ThreadProjection {
  const live = projectionToLive(p);
  const next = applyToolCallChunk(
    live,
    event.toolCallId,
    event.name,
    event.input,
    event.agentType,
    {
      id: event.messageId,
      phase: event.messagePhase,
      sourceTimestamp: event.sourceTimestamp,
      sourceSequence: event.sourceSequence,
      sourceSubsequence: event.sourceSubsequence,
    },
  );
  // tool_call 是流中断点 ── 清 pendingAssistantId, 记录当前 tool 名到 run.
  const runsNext = applyRunToolState(projectionToRuns(p), event, event.name);
  const messages = event.reasoningBoundary && p.pending.reasoningId
    ? next.messages.map((message) =>
        message.id === p.pending.reasoningId
          ? { ...message, isCompleted: true }
          : message,
      )
    : next.messages;
  return {
    ...p,
    messages,
    pending: {
      assistantId: next.pendingAssistantId,
      reasoningId: event.reasoningBoundary ? null : p.pending.reasoningId,
    },
    runs: runsToProjectionRuns(runsNext),
  };
}

function applyToolResultToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "tool_result" },
): ThreadProjection {
  const live = projectionToLive(p);
  const next = applyToolResultChunk(
    live,
    event.toolCallId,
    event.name,
    event.result,
    event.agentType,
    {
      id: event.messageId,
      phase: event.messagePhase,
      sourceTimestamp: event.sourceTimestamp,
      sourceSequence: event.sourceSequence,
      sourceSubsequence: event.sourceSubsequence,
    },
  );
  // tool_result 关闭 tool_call: currentTool 清空 (result 抵达后流回归 assistant 文本).
  const runsNext = applyRunToolState(projectionToRuns(p), event, null);
  return {
    ...p,
    messages: next.messages,
    runs: runsToProjectionRuns(runsNext),
  };
}

function applyDshCommandToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "dsh_command" },
): ThreadProjection {
  const messageId = `dsh-command:live:${event.id}`;
  const command = `/${event.name}${event.args}`;
  const existingIndex = p.messages.findIndex((message) => message.id === messageId);
  const message = {
    id: messageId,
    role: "user" as const,
    messageType: "dsh-command" as const,
    // Keep the live row identical to the authoritative history projection.
    // command/done text is rendered separately by the history reload (and a
    // compact checkpoint owns its completion text), never inside the user
    // command bubble.
    content: command,
    timestamp: new Date(event.timestamp).toISOString(),
    sourceTimestamp: event.sourceTimestamp,
    sourceSequence: event.sourceSequence,
    isLoading: event.status === "pending",
    isCompleted: event.status !== "pending",
    errorDetails: event.status === "error"
      ? { category: "unknown", retryable: false, upstreamMessage: event.result || command }
      : undefined,
  };
  const messages = [...p.messages];
  if (existingIndex >= 0) messages[existingIndex] = message;
  else messages.push(message);
  return {
    ...p,
    messages,
    runs: {
      ...p.runs,
      dshCommand: {
        id: event.id,
        name: event.name,
        args: event.args,
        runId: event.runId,
        status: event.status,
        startedAt:
          p.runs.dshCommand?.id === event.id
            ? p.runs.dshCommand.startedAt
            : event.timestamp,
        ...(event.status === "pending"
          ? {}
          : { endedAt: event.timestamp }),
        ...(event.result !== undefined ? { result: event.result } : {}),
      },
    },
  };
}

function applyCodexCommandToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "codex_command" },
): ThreadProjection {
  const messageId = `codex-command:live:${event.id}`;
  const existingIndex = p.messages.findIndex((message) => message.id === messageId);
  const message = {
    id: messageId,
    role: "user" as const,
    messageType: "codex-command" as const,
    content: event.command,
    timestamp: new Date(event.timestamp).toISOString(),
    codexTurnId: event.codexTurnId,
    isLoading: event.status === "pending",
    isCompleted: event.status !== "pending",
    errorDetails: event.status === "error"
      ? {
          category: "unknown",
          retryable: false,
          upstreamMessage: event.result || event.command,
        }
      : undefined,
  };
  const messages = [...p.messages];
  if (existingIndex >= 0) messages[existingIndex] = message;
  else messages.push(message);
  return {
    ...p,
    messages,
    runs: {
      ...p.runs,
      codexCommand: {
        id: event.id,
        command: event.command,
        runId: event.runId,
        status: event.status,
        startedAt:
          p.runs.codexCommand?.id === event.id
            ? p.runs.codexCommand.startedAt
            : event.timestamp,
        ...(event.status === "pending"
          ? {}
          : { endedAt: event.timestamp }),
        ...(event.result !== undefined ? { result: event.result } : {}),
      },
    },
  };
}

function applyStreamStartToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "stream_start" },
): ThreadProjection {
  const runsNext = applyRunStarted(projectionToRuns(p), event, {
    model: event.model,
    modelId: event.model,
    lastRunAt: event.timestamp,
    reasoning_effort: event.reasoning_effort,
  });
  return {
    ...p,
    runs: runsToProjectionRuns(runsNext),
  };
}

function applyStreamEndToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "stream_end" },
): ThreadProjection {
  const runsNext = applyRunEnded(projectionToRuns(p), event);
  // run 结束时把仍 loading 的 tool 行收尾为 isLoading=false (避免中断 tool 永久转圈);
  // 若还有 pending reasoning, 同步把它收尾为 isCompleted=true. 这两条收尾独立但都
  // 仅在 run 真正结束 (!runsNext.isLoading) 时触发, 避免误关并发 run 的消息.
  const terminalMessages = !runsNext.isLoading
    ? closeLoadingToolRows(
        p.pending.reasoningId
          ? p.messages.map((m) =>
              m.id === p.pending.reasoningId && m.role === "reasoning"
                ? { ...m, isCompleted: true }
                : m,
            )
          : p.messages,
      )
    : p.messages;
  const messagesWithDuration =
    !runsNext.isLoading &&
    event.durationMs !== undefined &&
    Number.isFinite(event.durationMs) &&
    event.durationMs >= 0
      ? (() => {
          let latestUserIndex = -1;
          for (let index = terminalMessages.length - 1; index >= 0; index -= 1) {
            if (terminalMessages[index].role === "user") {
              latestUserIndex = index;
              break;
            }
          }
          for (let index = terminalMessages.length - 1; index >= 0; index -= 1) {
            if (index <= latestUserIndex) break;
            if (terminalMessages[index].role !== "assistant") continue;
            return terminalMessages.map((message, messageIndex) =>
              messageIndex === index
                ? { ...message, turnDurationMs: event.durationMs }
                : message,
            );
          }
          return terminalMessages;
        })()
      : terminalMessages;
  return {
    ...p,
    messages: messagesWithDuration,
    pending: {
      assistantId: runsNext.isLoading ? p.pending.assistantId : null,
      reasoningId: runsNext.isLoading ? p.pending.reasoningId : null,
    },
    runs: runsToProjectionRuns(runsNext),
  };
}

function applyErrorToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "error" },
): ThreadProjection {
  const live = projectionToLive(p);
  const next = applyErrorChunk(live, event.message, {
    id: event.messageId,
    notice:
      event.agentType === "deepseek-harness"
        ? "deepseek-harness-reconnect-failed"
        : undefined,
    errorDetails: event.errorDetails,
  });
  const runsNext = applyRunFailed(projectionToRuns(p), event, event.message);
  // pending ids 跟随 run 失败 (applyRunFailed 已清, 但保险起见再次覆盖).
  return {
    ...p,
    messages: next.messages,
    pending: {
      assistantId: runsNext.pendingAssistantId,
      reasoningId: runsNext.pendingReasoningId,
    },
    runs: runsToProjectionRuns(runsNext),
  };
}

function applyUsageToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "usage" },
): ThreadProjection {
  const runsNext = applyRunUsage(projectionToRuns(p), event);
  return {
    ...p,
    runs: runsToProjectionRuns(runsNext),
  };
}

// --------------------------------------------------------------------
// helpers ── 重新导出以便外部测试
// --------------------------------------------------------------------

export { emptyProjection };
