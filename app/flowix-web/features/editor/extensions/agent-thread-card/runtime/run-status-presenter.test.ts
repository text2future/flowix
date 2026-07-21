import { describe, expect, it } from "vitest";
import type { ThreadState } from "@features/agent/store/chat-store";
import { computeAgentThreadCardBadgeData } from "./run-status-presenter";

function threadState(overrides: Partial<ThreadState> = {}): ThreadState {
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
    ...overrides,
  };
}

describe("run-status-presenter", () => {
  it("uses chat-store thread snapshots for badge metadata", () => {
    const badge = computeAgentThreadCardBadgeData({
      threadState: threadState({
        lastRun: {
          runId: "thread-run",
          agentType: "codex",
          status: "completed",
          startedAt: 100,
          endedAt: 200,
          model: "thread-model",
          usage: { total_tokens: 123 },
        },
      }),
      codexModel: "inherit",
      typeKey: "codex",
    });

    expect(badge).toMatchObject({
      model: "thread-model",
      lastRunAt: 200,
      totalTokens: 123,
    });
  });

  it("falls back to chat-store thread snapshots while conversation run is absent", () => {
    const badge = computeAgentThreadCardBadgeData({
      threadState: threadState({
        lastRun: {
          runId: "thread-run",
          agentType: "codex",
          status: "completed",
          startedAt: 100,
          endedAt: 200,
          model: "thread-model",
          usage: { total_tokens: 123 },
        },
      }),
      codexModel: "inherit",
      typeKey: "codex",
    });

    expect(badge).toMatchObject({
      model: "thread-model",
      lastRunAt: 200,
      totalTokens: 123,
    });
  });
});
