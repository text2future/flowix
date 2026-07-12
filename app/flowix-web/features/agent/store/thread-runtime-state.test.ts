import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@/types/agent";
import {
  emptyThreadState,
  ensureRunActive,
  isThreadRunActive,
  releaseThreadRuntimeMessages,
  threadRunUpdate,
} from "@features/agent/store/thread-runtime-state";

describe("thread-runtime-state helpers", () => {
  it("emptyThreadState returns a clean runtime", () => {
    const st = emptyThreadState();
    expect(st).toMatchObject({
      messages: [],
      isLoading: false,
      activeRunId: null,
      runs: {},
      pendingAssistantId: null,
      pendingReasoningId: null,
      oldestSequence: null,
      hasMoreHistory: false,
      loadingMore: false,
    });
  });

  it("threadRunUpdate returns an updated threadStates map", () => {
    const t1 = emptyThreadState();
    const next = threadRunUpdate({ t1 }, "thread-1", { ...t1, isLoading: true });
    expect(next["thread-1"].isLoading).toBe(true);
    // Original input is not mutated.
    expect(next["thread-1"]).not.toBe(t1);
  });

  it("releaseThreadRuntimeMessages clears messages and pending cursors but is a no-op for empty state", () => {
    const empty = emptyThreadState();
    expect(releaseThreadRuntimeMessages(empty)).toBe(empty);

    const filled: ReturnType<typeof emptyThreadState> = {
      ...empty,
      messages: [
        { id: "m1", role: "assistant", content: "hi", timestamp: "2026-01-01T00:00:00.000Z" },
      ],
      pendingAssistantId: "m1",
    };
    const released = releaseThreadRuntimeMessages(filled);
    expect(released.messages).toEqual([]);
    expect(released.pendingAssistantId).toBeNull();
    expect(released.pendingReasoningId).toBeNull();
  });

  it("isThreadRunActive reflects isLoading + activeRunId + running status", () => {
    const t = emptyThreadState();
    expect(isThreadRunActive(t)).toBe(false);

    const running = {
      ...t,
      isLoading: true,
      activeRunId: "run-1",
      runs: { "run-1": { runId: "run-1", agentType: "flowix", threadId: "t1", startedAt: 1, status: "running" as const } },
    };
    expect(isThreadRunActive(running)).toBe(true);

    const finished = {
      ...running,
      runs: { "run-1": { ...running.runs["run-1"], status: "completed" as const } },
    };
    expect(isThreadRunActive(finished)).toBe(false);
  });

  it("ensureRunActive patches missed stream_start on text / tool chunks", () => {
    const t = emptyThreadState();
    const event: AgentEvent = {
      kind: "text_delta",
      agentType: "flowix",
      threadId: "t1",
      runId: "run-1",
      text: "hello",
      timestamp: 1234,
    };

    const patched = ensureRunActive(t, event);
    expect(patched.isLoading).toBe(true);
    expect(patched.activeRunId).toBe("run-1");
    expect(patched.runs["run-1"]?.status).toBe("running");
  });

  it("ensureRunActive is a no-op when stream_start / usage events arrive", () => {
    const t = emptyThreadState();
    const streamStart: AgentEvent = {
      kind: "stream_start",
      agentType: "flowix",
      threadId: "t1",
      runId: "run-1",
      timestamp: 1234,
    };
    expect(ensureRunActive(t, streamStart)).toBe(t);

    const usage: AgentEvent = {
      kind: "usage",
      agentType: "flowix",
      threadId: "t1",
      runId: "run-1",
      timestamp: 1234,
      modelId: null,
      lastRunAt: null,
      usage: null,
      statusInfo: null,
    };
    expect(ensureRunActive(t, usage)).toBe(t);
  });

  it("ensureRunActive is a no-op when a run is already active", () => {
    const t = {
      ...emptyThreadState(),
      isLoading: true,
      activeRunId: "run-existing",
      runs: {
        "run-existing": {
          runId: "run-existing",
          agentType: "flowix",
          threadId: "t1",
          startedAt: 1000,
          status: "running" as const,
        },
      },
    };
    const event: AgentEvent = {
      kind: "tool_call",
      agentType: "flowix",
      threadId: "t1",
      runId: "run-newer",
      toolCallId: "tc-1",
      name: "Read",
      input: {},
      timestamp: 1500,
    };
    expect(ensureRunActive(t, event)).toBe(t);
  });
});