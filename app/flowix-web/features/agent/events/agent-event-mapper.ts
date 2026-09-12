import type {
  AgentChunk,
  AgentChunkError,
  AgentErrorDetails,
  AgentEvent,
  AgentMessageType,
  AgentTypeKey,
} from "@/types/agent";
import {
  normalizeAgentTypeKey,
  supportsTextStreaming,
} from "@/lib/agent-types";
import {
  resolveExternalChunkAgentType,
  resolveExternalChunkThreadId,
} from "@features/agent/store/external-session";
import { canonicalAgentMessageId } from "@features/agent/events/message-identity";

interface AgentEventMapperThreadState {
  activeRunId: string | null;
  lastRunId?: string;
}

export interface AgentEventMapperState {
  threadTypes: Record<string, AgentTypeKey>;
  threadStates: Record<string, AgentEventMapperThreadState | undefined>;
  externalSessionResolutions: Record<string, string>;
}

export function createRunId(threadId: string): string {
  return `run-${threadId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveChunkRunId(
  chunk: AgentChunk,
  threadId: string,
  st: AgentEventMapperThreadState | undefined,
): string {
  return (
    chunk.run_id ??
    st?.activeRunId ??
    (chunk.kind === "usage" ? st?.lastRunId : undefined) ??
    createRunId(threadId)
  );
}

const CLAUDE_ENVELOPE_TEXT_MESSAGE_ID =
  /^assistant-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-block-\d+$/i;

function resolveTextMessageId(
  agentType: AgentTypeKey,
  messageId: string | undefined,
  contentMode: "delta" | "snapshot" | undefined,
): string | undefined {
  // Older Claude stream adapters used the stream envelope UUID, which changes
  // on every delta. Dropping only that known-bad delta id lets pendingAssistantId
  // join contiguous text while tool calls still form an explicit boundary.
  if (
    agentType === "claude" &&
    contentMode === "delta" &&
    messageId &&
    CLAUDE_ENVELOPE_TEXT_MESSAGE_ID.test(messageId)
  ) {
    return undefined;
  }
  return messageId;
}

export function mapAgentChunkToEvent(
  chunk: AgentChunk,
  state: AgentEventMapperState,
  now: () => number = Date.now,
): AgentEvent {
  const messageMetadata = chunk as AgentChunk & {
    message_id?: string;
    message_type?: AgentMessageType;
    message_phase?: "started" | "updated" | "completed";
    content_mode?: "delta" | "snapshot";
    source_timestamp?: number;
    source_sequence?: number;
    source_subsequence?: number;
    reasoning_boundary?: boolean;
    codex_turn_id?: string;
  };
  const sourceThreadId = chunk.thread_id;
  const threadId = resolveExternalChunkThreadId(
    chunk,
    state.externalSessionResolutions,
  );
  const st = state.threadStates[threadId];
  const base = {
    agentType: normalizeAgentTypeKey(
      resolveExternalChunkAgentType(
        chunk,
        sourceThreadId,
        threadId,
        state.threadTypes,
      ),
    ),
    threadId,
    runId: resolveChunkRunId(chunk, threadId, st),
    timestamp: now(),
    messageId: messageMetadata.message_id,
    messagePhase: messageMetadata.message_phase,
    contentMode: messageMetadata.content_mode,
    sourceTimestamp: messageMetadata.source_timestamp,
    sourceSequence: messageMetadata.source_sequence,
    sourceSubsequence: messageMetadata.source_subsequence,
    codexTurnId: messageMetadata.codex_turn_id,
    reasoningBoundary: messageMetadata.reasoning_boundary,
  };

  switch (chunk.kind) {
    case "user_message":
      return {
        ...base,
        kind: "user_message",
        id:
          canonicalAgentMessageId(
            base.agentType,
            base.runId,
            "user",
            chunk.id,
          ) ?? chunk.id,
        text: chunk.text,
        messageType: messageMetadata.message_type,
        messageId:
          canonicalAgentMessageId(
            base.agentType,
            base.runId,
            "user",
            chunk.id,
          ) ?? chunk.id,
        sourceTimestamp: chunk.timestamp,
        sourceSequence: 0,
        sourceSubsequence: 0,
      };
    case "text": {
      const messageId = canonicalAgentMessageId(
        base.agentType,
        base.runId,
        "assistant",
        resolveTextMessageId(base.agentType, base.messageId, base.contentMode),
      );
      return supportsTextStreaming(base.agentType)
        ? { ...base, kind: "text_delta", text: chunk.text, messageId }
        : { ...base, kind: "final_message", text: chunk.text, messageId };
    }
    case "reasoning":
      return {
        ...base,
        kind: "reasoning_delta",
        text: chunk.text,
        messageId: canonicalAgentMessageId(
          base.agentType,
          base.runId,
          "reasoning",
          base.agentType === "claude" &&
            !base.messageId?.startsWith("msg:")
            ? `reasoning-${base.runId}`
            : base.messageId,
        ),
      };
    case "context_compaction":
      return {
        ...base,
        kind: "context_compaction",
        id: canonicalAgentMessageId(
          base.agentType,
          base.runId,
          "system",
          chunk.id,
        ) ?? chunk.id,
      };
    case "tool_call":
      return {
        ...base,
        kind: "tool_call",
        messageId: canonicalAgentMessageId(
          base.agentType,
          base.runId,
          "tool",
          base.messageId,
        ),
        toolCallId:
          canonicalAgentMessageId(
            base.agentType,
            base.runId,
            "tool-call",
            chunk.id,
          ) ??
          chunk.id,
        name: chunk.name,
        input: chunk.input,
      };
    case "tool_result":
      return {
        ...base,
        kind: "tool_result",
        messageId: canonicalAgentMessageId(
          base.agentType,
          base.runId,
          "tool",
          base.messageId,
        ),
        toolCallId:
          canonicalAgentMessageId(
            base.agentType,
            base.runId,
            "tool-call",
            chunk.id,
          ) ??
          chunk.id,
        name: chunk.name,
        result: chunk.result,
      };
    case "dsh_command":
      return {
        ...base,
        kind: "dsh_command",
        id: chunk.id,
        name: chunk.name,
        args: chunk.args,
        status: chunk.status,
        result: chunk.result,
        messageId: chunk.id,
        sourceSequence: chunk.source_sequence,
      };
    case "codex_command":
      return {
        ...base,
        kind: "codex_command",
        id: chunk.id,
        command: chunk.command,
        status: chunk.status,
        result: chunk.result,
        messageId: chunk.id,
        sourceTimestamp: chunk.timestamp,
        sourceSequence: chunk.source_sequence,
      };
    case "error":
      return {
        ...base,
        kind: "error",
        message: chunk.message,
        // Errors are run-scoped. A provider may report the same failure once
        // on stdout and once again when its process exits; using a stable
        // canonical id lets the reducer collapse those two notifications.
        messageId: canonicalAgentMessageId(
          base.agentType,
          base.runId,
          "error",
          base.messageId ?? "error",
        ),
        errorDetails: mapAgentErrorDetails(chunk.error_details),
      };
    case "stream_start":
      return {
        ...base,
        kind: "stream_start",
        // 通用 metadata 协议 ── 透传 model / reasoning_effort 到 event,
        // 后续由 applyRunStarted 写入 runs[runId].model。
        model: chunk.model,
        reasoning_effort: chunk.reasoning_effort,
      };
    case "stream_end":
      return {
        ...base,
        kind: "stream_end",
        reason: chunk.reason,
        durationMs: chunk.duration_ms,
      };
    case "session_resolved":
      return { ...base, kind: "session_resolved", sessionId: chunk.session_id };
    case "usage":
      // 通用 metadata 协议 ── 透传 token 用量到 event,后续由 reducer 累加。
      // 嵌套 usage / status_info 对象直接透传,reducer 做字段级累加。
      return {
        ...base,
        kind: "usage",
        modelId: chunk.model_id ?? null,
        lastRunAt: chunk.last_run_at ?? null,
        usage: chunk.usage ?? null,
        statusInfo: chunk.status_info ?? null,
      };
  }
}

function mapAgentErrorDetails(
  details: AgentChunkError["error_details"],
): AgentErrorDetails | undefined {
  if (!details) return undefined;
  return {
    category: details.category,
    statusCode: details.status_code,
    requestId: details.request_id,
    retryAfter: details.retry_after,
    exitCode: details.exit_code,
    upstreamMessage: details.upstream_message,
    source: details.source,
    retryable: details.retryable,
  };
}
