import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@/types/agent";
import {
  applyRunEnded,
  applyRunFailed,
  applyRunStarted,
  applyRunStopped,
  applyRunUsage,
  type RunLifecycleThreadState,
} from "./run-lifecycle";

function emptyState(): RunLifecycleThreadState {
  return {
    isLoading: false,
    activeRunId: null,
    runs: {},
    pendingAssistantId: null,
    pendingReasoningId: null,
  };
}

function startEvent(runId: string): Extract<AgentEvent, { kind: "stream_start" }> {
  return {
    kind: "stream_start",
    agentType: "codex",
    threadId: "thread-1",
    runId,
    timestamp: 100,
  };
}

function endEvent(
  runId: string,
  reason: string | null = null,
): Extract<AgentEvent, { kind: "stream_end" }> {
  return {
    kind: "stream_end",
    agentType: "codex",
    threadId: "thread-1",
    runId,
    timestamp: 200,
    reason,
  };
}

function errorEvent(runId: string, message = "failed"): Extract<AgentEvent, { kind: "error" }> {
  return {
    kind: "error",
    agentType: "codex",
    threadId: "thread-1",
    runId,
    timestamp: 300,
    message,
  };
}

describe("run lifecycle reducer", () => {
  it("starts a run and marks it active", () => {
    const next = applyRunStarted(emptyState(), startEvent("run-1"), {
      model: "gpt-5",
    });

    expect(next.isLoading).toBe(true);
    expect(next.activeRunId).toBe("run-1");
    expect(next.runs["run-1"]).toMatchObject({
      runId: "run-1",
      status: "running",
      agentType: "codex",
      model: "gpt-5",
    });
    expect(next.lastRun).toBeUndefined();
  });

  it("accumulates usage on the active run", () => {
    const running = applyRunStarted(emptyState(), startEvent("run-1"));
    const used = applyRunUsage(running, {
      kind: "usage",
      agentType: "codex",
      threadId: "thread-1",
      runId: "run-1",
      timestamp: 150,
      modelId: "gpt-5",
      lastRunAt: 150,
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      statusInfo: { codex_used_percent: 50 },
    });

    expect(used.runs["run-1"]?.usage?.total_tokens).toBe(7);
    expect(used.runs["run-1"]?.statusInfo?.codex_used_percent).toBe(50);
    expect(used.lastRun).toBeUndefined();
  });

  it("removes completed runs from runs and preserves lastRun", () => {
    const running = applyRunStarted(emptyState(), startEvent("run-1"), {
      model: "gpt-5",
    });
    const ended = applyRunEnded(running, endEvent("run-1"));

    expect(ended.isLoading).toBe(false);
    expect(ended.activeRunId).toBeNull();
    expect(ended.runs["run-1"]).toBeUndefined();
    expect(ended.lastRun).toMatchObject({
      runId: "run-1",
      status: "completed",
      endedAt: 200,
      reason: null,
      model: "gpt-5",
    });
  });

  it("removes failed runs from runs and preserves lastRun", () => {
    const running = applyRunStarted(
      {
        ...emptyState(),
        pendingAssistantId: "assistant-stale",
        pendingReasoningId: "reasoning-stale",
      },
      startEvent("run-1"),
    );
    const failed = applyRunFailed(running, errorEvent("run-1", "boom"), "boom");

    expect(failed.isLoading).toBe(false);
    expect(failed.activeRunId).toBeNull();
    expect(failed.pendingAssistantId).toBeNull();
    expect(failed.pendingReasoningId).toBeNull();
    expect(failed.runs["run-1"]).toBeUndefined();
    expect(failed.lastRun).toMatchObject({
      runId: "run-1",
      status: "failed",
      reason: "boom",
      endedAt: 300,
    });
  });

  it("removes cancelled runs from runs and keeps stream_end cancelled", () => {
    const running = applyRunStarted(emptyState(), startEvent("run-1"), {
      model: "claude-sonnet",
    });
    const stopped = applyRunStopped(running, "run-1", 150);
    const ended = applyRunEnded(stopped, endEvent("run-1"));

    expect(stopped.runs["run-1"]).toBeUndefined();
    expect(stopped.lastRun).toMatchObject({
      runId: "run-1",
      status: "cancelled",
      endedAt: 150,
    });
    expect(ended.runs["run-1"]).toBeUndefined();
    expect(ended.lastRun).toMatchObject({
      runId: "run-1",
      status: "cancelled",
      endedAt: 200,
      reason: null,
      model: "claude-sonnet",
    });
  });

  it("maps user_stopped stream_end to cancelled without a local stop", () => {
    const running = applyRunStarted(emptyState(), startEvent("run-1"));
    const ended = applyRunEnded(running, endEvent("run-1", "user_stopped"));

    expect(ended.runs["run-1"]).toBeUndefined();
    expect(ended.lastRun).toMatchObject({
      runId: "run-1",
      status: "cancelled",
      reason: "user_stopped",
    });
  });

  it("keeps concurrent running runs when a stale background run ends", () => {
    const first = applyRunStarted(emptyState(), startEvent("run-1"));
    const second = applyRunStarted(first, startEvent("run-2"));
    const afterStaleEnd = applyRunEnded(
      second,
      endEvent("run-1", "late failure"),
    );

    expect(afterStaleEnd.isLoading).toBe(true);
    expect(afterStaleEnd.activeRunId).toBe("run-2");
    expect(Object.keys(afterStaleEnd.runs)).toEqual(["run-2"]);
    expect(afterStaleEnd.runs["run-2"]?.status).toBe("running");
    expect(afterStaleEnd.lastRun).toMatchObject({
      runId: "run-1",
      status: "failed",
      reason: "late failure",
    });
  });

  it("does not end a newer active run when a stopped run end event arrives late", () => {
    const first = applyRunStarted(emptyState(), startEvent("run-1"));
    const stopped = applyRunStopped(first, "run-1", 150);
    const second = applyRunStarted(stopped, startEvent("run-2"));
    const afterLateEnd = applyRunEnded(second, endEvent("run-1"));

    expect(afterLateEnd.isLoading).toBe(true);
    expect(afterLateEnd.activeRunId).toBe("run-2");
    expect(afterLateEnd.runs["run-2"]?.status).toBe("running");
    expect(afterLateEnd.lastRun).toMatchObject({
      runId: "run-1",
      status: "cancelled",
      reason: null,
    });
  });

  it("ends the active run when an external stream_end has an unknown run id", () => {
    const running = applyRunStarted(emptyState(), startEvent("run-1"));
    const ended = applyRunEnded(running, endEvent("session-end-run"));

    expect(ended.isLoading).toBe(false);
    expect(ended.activeRunId).toBeNull();
    expect(ended.runs["run-1"]).toBeUndefined();
    expect(ended.lastRun).toMatchObject({
      runId: "run-1",
      status: "completed",
    });
  });
});
