import { describe, expect, it } from "vitest";
import type { AgentTypeKey, RunInfo } from "@/types/agent";
import {
  emptyThreadState,
  type ThreadState,
  type ThreadsMap,
} from "@features/agent/store/thread-runtime-state";
import {
  isThreadRunActiveInState,
  optimisticUntilFromStartedAt,
  reconcileThreadStatesFromRunningSnapshot,
  RUN_MISSING_FROM_SNAPSHOT_REASON,
} from "@features/agent/store/snapshot-reconcile";

function activeThread(threadId: string, runId: string, startedAt: number): ThreadState {
  return {
    ...emptyThreadState(),
    isLoading: true,
    activeRunId: runId,
    runs: {
      [runId]: {
        runId,
        agentType: "flowix",
        threadId,
        startedAt,
        status: "running",
      },
    },
  };
}

function runInfo(overrides: Partial<RunInfo> = {}): RunInfo {
  return {
    runId: "run-from-snapshot",
    agentType: "codex",
    startedAt: 2000,
    currentTool: null,
    ...overrides,
  };
}

describe("snapshot-reconcile helpers", () => {
  it("optimisticUntilFromStartedAt adds the 3s grace window", () => {
    expect(optimisticUntilFromStartedAt(1000)).toBe(4000);
  });

  it("isThreadRunActiveInState returns false for missing active run", () => {
    expect(isThreadRunActiveInState(emptyThreadState())).toBe(false);
    expect(isThreadRunActiveInState(activeThread("t1", "r1", 1))).toBe(true);
  });

  it("reconciles empty running snapshot and clears stale local running runs", () => {
    const threadId = "thread-stale";
    const threadStates: ThreadsMap = {
      [threadId]: activeThread(threadId, "run-stale", 1),
    };
    const now = 5000;
    const result = reconcileThreadStatesFromRunningSnapshot(
      {
        threadStates,
        threadTypes: { [threadId]: "flowix" },
        externalSessionResolutions: {},
      },
      {},
      now,
      () => {
        throw new Error("applyRunStarted should not be called for empty running");
      },
    );

    const cleared = result.threadStates[threadId];
    expect(cleared.isLoading).toBe(false);
    expect(cleared.activeRunId).toBeNull();
    expect(Object.values(cleared.runs)).toHaveLength(0);
    expect(cleared.lastRun).toMatchObject({
      runId: "run-stale",
      status: "failed",
      reason: RUN_MISSING_FROM_SNAPSHOT_REASON,
    });
  });

  it("keeps a stale run when it is still within the grace window", () => {
    const threadId = "thread-fresh";
    const startedAt = 1000;
    const threadStates: ThreadsMap = {
      [threadId]: activeThread(threadId, "run-fresh", startedAt),
    };
    const now = startedAt + 1000; // within 3s grace
    const result = reconcileThreadStatesFromRunningSnapshot(
      {
        threadStates,
        threadTypes: { [threadId]: "flowix" },
        externalSessionResolutions: {},
      },
      {},
      now,
      () => {
        throw new Error("not expected");
      },
    );

    const kept = result.threadStates[threadId];
    expect(kept.isLoading).toBe(true);
    expect(kept.activeRunId).toBe("run-fresh");
    expect(kept.runs["run-fresh"]?.status).toBe("running");
  });

  it("re-applies the snapshot entry as a fresh run for known backend run ids", () => {
    const threadId = "thread-known";
    const threadStates: ThreadsMap = {
      [threadId]: activeThread(threadId, "run-local", 1),
    };
    const now = 9000;
    const result = reconcileThreadStatesFromRunningSnapshot(
      {
        threadStates,
        threadTypes: { [threadId]: "flowix" },
        externalSessionResolutions: {},
      },
      {
        [threadId]: runInfo({
          runId: "run-from-snapshot",
          startedAt: 9000,
        }),
      },
      now,
      (st, info, runId) => ({
        ...st,
        isLoading: true,
        activeRunId: runId,
        runs: {
          ...st.runs,
          [runId]: {
            runId,
            agentType: info.agentType ?? "flowix",
            threadId,
            startedAt: info.startedAt,
            status: "running",
          },
        },
      }),
    );

    const reconciled = result.threadStates[threadId];
    expect(reconciled.isLoading).toBe(true);
    expect(reconciled.activeRunId).toBe("run-from-snapshot");
    expect(reconciled.runs["run-from-snapshot"]?.status).toBe("running");
    // 合并 applyRunStarted 之后, 已有的 local run 仍然存在 (run 集合
    // 是累加式而不是替换式)。 这与原 chat-store.ts 的行为一致。
    expect(reconciled.runs["run-local"]).toBeDefined();
  });

  it("migrates local thread id to canonical session id via applyExternalSessionResolved", () => {
    const localThreadId = "codex-local-1";
    const sessionId = "codex-session-1";
    const threadStates: ThreadsMap = {
      [localThreadId]: activeThread(localThreadId, "run-1", 5000),
    };
    const now = 5000;
    const result = reconcileThreadStatesFromRunningSnapshot(
      {
        threadStates,
        threadTypes: { [localThreadId]: "codex" },
        externalSessionResolutions: {},
      },
      {
        [sessionId]: runInfo({
          runId: "run-1",
          startedAt: 5000,
          pendingThreadId: localThreadId,
          sessionId,
        }),
      },
      now,
      (st, info, runId) => ({
        ...st,
        isLoading: true,
        activeRunId: runId,
        runs: {
          ...st.runs,
          [runId]: {
            runId,
            agentType: info.agentType ?? "codex",
            threadId: sessionId,
            startedAt: info.startedAt,
            status: "running",
          },
        },
      }),
    );

    expect(result.externalSessionResolutions[localThreadId]).toBe(sessionId);
    expect(result.threadTypes[sessionId]).toBe("codex");
    expect(result.threadStates[localThreadId]).toBeDefined();
    expect(result.threadStates[sessionId]).toMatchObject({
      isLoading: true,
      activeRunId: "run-1",
    });
  });
});