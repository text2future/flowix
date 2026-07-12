import type { AgentChunk, AgentEvent, AgentTypeKey } from "@/types/agent";
import {
  normalizeAgentTypeKey,
  supportsTextStreaming,
} from "@/lib/agent-types";
import {
  resolveExternalChunkAgentType,
  resolveExternalChunkThreadId,
} from "@features/agent/store/external-session";
import { createAgentToolDisplay } from "@features/agent/tool-display";

interface AgentEventMapperThreadState {
  activeRunId: string | null;
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
  return chunk.run_id ?? st?.activeRunId ?? createRunId(threadId);
}

export function mapAgentChunkToEvent(
  chunk: AgentChunk,
  state: AgentEventMapperState,
  now: () => number = Date.now,
): AgentEvent {
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
  };

  switch (chunk.kind) {
    case "text":
      return supportsTextStreaming(base.agentType)
        ? { ...base, kind: "text_delta", text: chunk.text }
        : { ...base, kind: "final_message", text: chunk.text };
    case "reasoning":
      return { ...base, kind: "reasoning_delta", text: chunk.text };
    case "tool_call":
      return {
        ...base,
        kind: "tool_call",
        toolCallId: chunk.id,
        name: chunk.name,
        input: chunk.input,
        display: createAgentToolDisplay({
          agentType: base.agentType,
          toolName: chunk.name,
          input: chunk.input,
        }),
      };
    case "tool_result":
      return {
        ...base,
        kind: "tool_result",
        toolCallId: chunk.id,
        name: chunk.name,
        result: chunk.result,
      };
    case "error":
      return { ...base, kind: "error", message: chunk.message };
    case "stream_start":
      return {
        ...base,
        kind: "stream_start",
        // 通用 metadata 协议 ── 透传 model / reasoning_effort 到 event,
        // 后续由 applyRunStarted 写入 runs[runId].model。
        model: chunk.model,
        reasoningEffort: chunk.reasoning_effort,
      };
    case "stream_end":
      return { ...base, kind: "stream_end", reason: chunk.reason };
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
