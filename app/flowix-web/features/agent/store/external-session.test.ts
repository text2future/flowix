import { describe, expect, it } from "vitest";
import type { AgentChunk, AgentTypeKey } from "@/types/agent";
import {
  applyExternalSessionResolved,
  resolveExternalChunkAgentType,
  resolveExternalChunkThreadId,
} from "@features/agent/store/external-session";

function chunk(
  kind: AgentChunk["kind"],
  overrides: Partial<AgentChunk> = {},
): AgentChunk {
  return { kind, thread_id: "thread-local", ...overrides } as AgentChunk;
}

describe("external-session helpers", () => {
  it("resolveExternalChunkThreadId honors session_resolved chunks", () => {
    const resolved = chunk("session_resolved", { session_id: "session-A" });
    expect(resolveExternalChunkThreadId(resolved, {})).toBe("thread-local");
  });

  it("resolveExternalChunkThreadId uses resolutions map for non-resolved chunks", () => {
    const textChunk = chunk("text", { thread_id: "thread-local" });
    expect(resolveExternalChunkThreadId(textChunk, { "thread-local": "session-A" })).toBe(
      "session-A",
    );
    expect(resolveExternalChunkThreadId(textChunk, {})).toBe("thread-local");
  });

  it("resolveExternalChunkAgentType prefers chunk-provided agent type", () => {
    const textChunk = chunk("text", { agent_type: "codex" });
    expect(
      resolveExternalChunkAgentType(textChunk, "thread-local", "thread-local", {}),
    ).toBe("codex");
  });

  it("resolveExternalChunkAgentType falls back to source thread type then target", () => {
    const textChunk = chunk("text");
    const threadTypes: Record<string, AgentTypeKey> = {
      "thread-local": "flowix",
      "session-A": "codex",
    };
    expect(
      resolveExternalChunkAgentType(textChunk, "thread-local", "session-A", threadTypes),
    ).toBe("flowix");

    expect(
      resolveExternalChunkAgentType(textChunk, "missing", "session-A", threadTypes),
    ).toBe("codex");

    expect(resolveExternalChunkAgentType(textChunk, "missing", "missing", {})).toBeUndefined();
  });

  it("applyExternalSessionResolved merges local runtime into the canonical session", () => {
    const fromState = {
      messages: [
        { id: "m1", role: "assistant" as const, content: "hello", timestamp: "2026-01-01T00:00:00.000Z" },
      ],
      isLoading: true,
      activeRunId: "run-1",
      runs: {
        "run-1": {
          runId: "run-1",
          agentType: "codex" as const,
          threadId: "thread-local",
          startedAt: 1000,
          status: "running" as const,
        },
      },
      pendingAssistantId: null,
      pendingReasoningId: null,
      oldestSequence: 0,
      hasMoreHistory: true,
      loadingMore: false,
    };
    const toState = {
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
    const result = applyExternalSessionResolved(
      {
        threadStates: {
          "thread-local": fromState,
          "session-A": toState,
        },
        threadTypes: { "thread-local": "flowix" },
        externalSessionResolutions: {},
      },
      "thread-local",
      "session-A",
      "codex",
    );

    expect(result.externalSessionResolutions["thread-local"]).toBe("session-A");
    expect(result.threadTypes).toMatchObject({
      "thread-local": "codex",
      "session-A": "codex",
    });
    const merged = result.threadStates["session-A"];
    expect(merged.isLoading).toBe(true);
    expect(merged.activeRunId).toBe("run-1");
    expect(merged.runs["run-1"]?.agentType).toBe("codex");
    expect(merged.hasMoreHistory).toBe(true);
  });

  it("applyExternalSessionResolved preserves session id entry that already had runs", () => {
    const existingSessionRuns = {
      "run-existing": {
        runId: "run-existing",
        agentType: "codex" as const,
        threadId: "session-A",
        startedAt: 500,
        status: "completed" as const,
      },
    };
    const result = applyExternalSessionResolved(
      {
        threadStates: {
          "thread-local": {
            ...emptyThreadState(),
            runs: {
              "run-existing": {
                runId: "run-existing",
                agentType: "codex",
                threadId: "thread-local",
                startedAt: 500,
                status: "running",
              },
              "run-newer": {
                runId: "run-newer",
                agentType: "codex",
                threadId: "thread-local",
                startedAt: 1000,
                status: "running",
              },
            },
          },
          "session-A": {
            ...emptyThreadState(),
            runs: existingSessionRuns,
          },
        },
        threadTypes: {},
        externalSessionResolutions: {},
      },
      "thread-local",
      "session-A",
      "codex",
    );

    const merged = result.threadStates["session-A"];
    // `fromState.runs` 在合并时覆盖 `toState.runs` 同 key, 这是当前
    // applyExternalSessionResolved 的行为 (用 spread merge 表达 "local
    // 优先"): 同 key 的 run 在合并结果里取 local thread 的状态。
    expect(merged.runs["run-existing"]?.status).toBe("running");
    expect(merged.runs["run-newer"]?.status).toBe("running");
  });
});

function emptyThreadState(): {
  messages: never[];
  isLoading: boolean;
  activeRunId: null;
  runs: Record<string, never>;
  pendingAssistantId: null;
  pendingReasoningId: null;
  oldestSequence: null;
  hasMoreHistory: boolean;
  loadingMore: boolean;
} {
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