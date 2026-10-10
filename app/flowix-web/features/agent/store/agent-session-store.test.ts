import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_SESSION_META,
  useAgentSessionStore,
} from "@features/agent/store/agent-session-store";
import { emptyProjection } from "@features/agent/store/session-reducer";
import { agentClient } from "@features/agent/store/agent-client";
import { STORAGE_KEYS } from "@/lib/constants";
import { DEFAULT_AGENT_TYPE_KEY } from "@/lib/agent-types";

const streamStart = (runId: string, threadId = "t1") => ({
  kind: "stream_start" as const,
  agentType: "deepseek-harness" as const,
  threadId,
  runId,
  timestamp: 0,
  model: "gpt-test",
});

const textDelta = (text: string, runId: string, threadId = "t1") => ({
  kind: "text_delta" as const,
  agentType: "deepseek-harness" as const,
  threadId,
  runId,
  timestamp: 1000,
  text,
  messageId: "assistant-r1",
  messagePhase: "updated" as const,
  contentMode: "delta" as const,
  sourceTimestamp: 1000,
  sourceSequence: 1,
  sourceSubsequence: 0,
});

const streamEnd = (runId: string, threadId = "t1") => ({
  kind: "stream_end" as const,
  agentType: "deepseek-harness" as const,
  threadId,
  runId,
  timestamp: 2000,
  reason: null,
});

describe("useAgentSessionStore", () => {
  beforeEach(() => {
    useAgentSessionStore.setState({
      sessionMeta: DEFAULT_AGENT_SESSION_META,
      conversationRegistry: { instances: {} },
      threadProjections: {},
      threadRunSignatures: {},
      latestCompletedRunIds: {},
      readThroughRunIds: {},
      runStateVersion: 0,
    });
  });

  it("starts with empty projections and default meta", () => {
    const s = useAgentSessionStore.getState();
    expect(s.threadProjections).toEqual({});
    expect(s.sessionMeta.activeAgentTypeKey).toBe(DEFAULT_AGENT_TYPE_KEY);
    expect(s.conversationRegistry.instances).toEqual({});
  });

  it("dispatch(stream_start) creates a thread projection lazily", () => {
    useAgentSessionStore.getState().dispatch(streamStart("r1"));
    const proj = useAgentSessionStore.getState().threadProjections["t1"];
    expect(proj).toBeDefined();
    expect(proj?.runs.isLoading).toBe(true);
    expect(proj?.runs.activeRunId).toBe("r1");
    expect(proj?.messages).toEqual([]);
  });

  it("dispatch chain (stream_start → text_delta → stream_end) updates only one projection atomically", () => {
    const { dispatch } = useAgentSessionStore.getState();
    dispatch(streamStart("r1"));
    const afterStart = useAgentSessionStore.getState().runStateVersion;
    dispatch(textDelta("hello", "r1"));
    // Text-only projection updates must not invalidate the conversation list.
    expect(useAgentSessionStore.getState().runStateVersion).toBe(afterStart);
    dispatch(streamEnd("r1"));

    const proj = useAgentSessionStore.getState().threadProjections["t1"];
    expect(proj?.runs.isLoading).toBe(false);
    expect(proj?.runs.lastRun?.status).toBe("completed");
    expect(proj?.messages).toHaveLength(1);
    expect(useAgentSessionStore.getState().runStateVersion).toBe(afterStart + 1);
    expect(useAgentSessionStore.getState().latestCompletedRunIds).toEqual({ t1: "r1" });
    useAgentSessionStore.getState().markThreadRead("t1");
    expect(useAgentSessionStore.getState().readThroughRunIds).toEqual({ t1: "r1" });
    dispatch(streamStart("r2"));
    dispatch(streamEnd("r2"));
    expect(useAgentSessionStore.getState().latestCompletedRunIds).toEqual({ t1: "r2" });
    useAgentSessionStore.getState().markThreadRead("t1", "r1");
    expect(useAgentSessionStore.getState().readThroughRunIds).toEqual({ t1: "r1" });
    useAgentSessionStore.getState().markThreadRead("t1", "r2");
    expect(useAgentSessionStore.getState().readThroughRunIds).toEqual({ t1: "r2" });
    expect(proj?.messages[0]).toMatchObject({
      role: "assistant",
      content: "hello",
    });
  });

  it("clears pending steering messages when the active run is stopped", async () => {
    const stop = vi.spyOn(agentClient, "stopChatStream").mockResolvedValue(true);
    const store = useAgentSessionStore.getState();
    const threadId = "steer-stop-thread";

    store.bindThreadType(threadId, "deepseek-harness");
    store.dispatch(streamStart("steer-stop-run", threadId));
    store.enqueueSteeringMessage({
      id: "pending-steer-stop",
      threadId,
      content: "continue after the current step",
      queuedAt: 1,
    });

    await store.stopThreadRun(threadId, "steer-stop-run");

    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]).toBeUndefined();
    stop.mockRestore();
  });

  it("clears pending steering messages when a run ends abnormally", () => {
    const store = useAgentSessionStore.getState();
    const threadId = "steer-error-thread";
    const runId = "steer-error-run";

    store.bindThreadType(threadId, "deepseek-harness");
    store.dispatch(streamStart(runId, threadId));
    store.enqueueSteeringMessage({
      id: "pending-steer-error",
      threadId,
      content: "this must not remain after a failed run",
      queuedAt: 1,
    });

    store.dispatchAgentChunk({
      kind: "stream_end",
      agent_type: "deepseek-harness",
      thread_id: threadId,
      run_id: runId,
      reason: "provider exited unexpectedly",
    });

    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]).toBeUndefined();
  });

  it("does not clear steering messages for a newer active run on a delayed old end", () => {
    const store = useAgentSessionStore.getState();
    const threadId = "steer-stale-end-thread";

    store.bindThreadType(threadId, "deepseek-harness");
    store.dispatch(streamStart("steer-old-run", threadId));
    store.dispatch(streamStart("steer-new-run", threadId));
    store.enqueueSteeringMessage({
      id: "pending-steer-new",
      threadId,
      content: "keep this for the new run",
      queuedAt: 1,
    });

    store.dispatchAgentEvent({
      kind: "stream_end",
      agentType: "deepseek-harness",
      threadId,
      runId: "steer-old-run",
      timestamp: 2,
      reason: null,
    });

    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]).toHaveLength(1);
  });

  it("keeps the completed Codex live turn available until history takes over", () => {
    const threadId = "codex-thread";
    const runId = "codex-run";
    const dispatch = useAgentSessionStore.getState().dispatch;
    const base = {
      agentType: "codex" as const,
      threadId,
      runId,
      timestamp: 0,
    };

    dispatch({ kind: "stream_start", ...base });
    dispatch({
      kind: "user_message",
      ...base,
      id: "item-user",
      text: "question",
      codexTurnId: "turn-1",
      messagePhase: "completed",
      contentMode: "snapshot",
    });
    dispatch({
      kind: "text_delta",
      ...base,
      timestamp: 1,
      messageId: "item-assistant",
      codexTurnId: "turn-1",
      text: "answer",
      messagePhase: "updated",
      contentMode: "delta",
    });
    dispatch({ kind: "stream_end", ...base, timestamp: 2, reason: null });

    const live = useAgentSessionStore.getState().codexLiveTurns[threadId];
    expect(live?.status).toBe("completed");
    expect(live?.messages.map((message) => message.id)).toEqual([
      "item-user",
      "item-assistant",
    ]);
  });

  it("dispatch is no-op for unknown event kinds (no projection churn)", () => {
    const before = useAgentSessionStore.getState();
    before.dispatch({
      kind: "session_resolved",
      agentType: "deepseek-harness",
      threadId: "t1",
      runId: "test-run",
      timestamp: 0,
      sessionId: "session-xyz",
    });
    const after = useAgentSessionStore.getState();
    expect(after.threadProjections).toBe(before.threadProjections);
  });

  it("setSessionMeta updates metadata without touching projections", () => {
    useAgentSessionStore.getState().dispatch(streamStart("r1"));
    const projBefore = useAgentSessionStore.getState().threadProjections["t1"];

    useAgentSessionStore.getState().setSessionMeta((meta) => ({
      ...meta,
      activeAgentTypeKey: "codex",
    }));

    const s = useAgentSessionStore.getState();
    expect(s.sessionMeta.activeAgentTypeKey).toBe("codex");
    // Projections ref unchanged (no churn).
    expect(s.threadProjections["t1"]).toBe(projBefore);
  });

  it("removeThreadProjection drops a thread entry", () => {
    useAgentSessionStore.getState().dispatch(streamStart("r1"));
    useAgentSessionStore.getState().dispatch(streamEnd("r1"));
    useAgentSessionStore.getState().markThreadRead("t1");
    expect(useAgentSessionStore.getState().threadProjections["t1"]).toBeDefined();
    useAgentSessionStore.getState().removeThreadProjection("t1");
    expect(useAgentSessionStore.getState().threadProjections["t1"]).toBeUndefined();
    expect(useAgentSessionStore.getState().threadRunSignatures["t1"]).toBeUndefined();
    expect(useAgentSessionStore.getState().latestCompletedRunIds["t1"]).toBeUndefined();
    expect(useAgentSessionStore.getState().readThroughRunIds["t1"]).toBeUndefined();
  });

  it("resetThreadProjections replaces specified entries with empty", () => {
    useAgentSessionStore.getState().dispatch(streamStart("r1", "t1"));
    useAgentSessionStore.getState().dispatch(streamStart("r2", "t2"));
    useAgentSessionStore.getState().dispatch(streamEnd("r1", "t1"));
    useAgentSessionStore.getState().markThreadRead("t1");
    useAgentSessionStore.getState().resetThreadProjections(["t1"]);
    const s = useAgentSessionStore.getState();
    expect(s.threadProjections["t1"]).toEqual(emptyProjection());
    expect(s.threadProjections["t2"]?.runs.isLoading).toBe(true);
    expect(s.latestCompletedRunIds["t1"]).toBeUndefined();
    expect(s.readThroughRunIds["t1"]).toBeUndefined();
  });

  it("keeps history and run writes within their projection partitions", () => {
    const store = useAgentSessionStore.getState();
    store.dispatch(streamStart("r1"));
    const before = useAgentSessionStore.getState().threadProjections.t1;
    store.updateThreadHistory("t1", (projection) => ({
      ...projection,
      messages: [{ id: "history", role: "assistant", content: "saved", timestamp: "2026-01-01T00:00:00Z" }],
      runs: emptyProjection().runs,
    }));
    const afterHistory = useAgentSessionStore.getState().threadProjections.t1;
    expect(afterHistory.runs).toBe(before.runs);
    store.updateThreadRuns("t1", () => emptyProjection().runs);
    expect(useAgentSessionStore.getState().threadProjections.t1.messages).toBe(afterHistory.messages);
  });
});

describe("useAgentSessionStore persist", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.resetModules();
  });

  it("starts with current defaults when only obsolete CHAT data exists", async () => {
    localStorage.setItem(STORAGE_KEYS.CHAT, JSON.stringify({ state: { activeAgentTypeKey: "claude" } }));
    const { useAgentSessionStore } = await import("@features/agent/store/agent-session-store");
    expect(useAgentSessionStore.getState().sessionMeta.activeAgentTypeKey).toBe(DEFAULT_AGENT_TYPE_KEY);
  });

  it("persists sessionMeta (incl. settings) and rehydrates from AGENT_SESSION", async () => {
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    useAgentSessionStore.getState().setSessionMeta((m) => ({
      ...m,
      activeAgentTypeKey: "codex",
      activeThreadIds: { ...m.activeThreadIds, codex: "thread-x" },
      settings: { ...m.settings, agentCodexReasoningEffort: "high" },
    }));

    const stored = JSON.parse(
      localStorage.getItem(STORAGE_KEYS.AGENT_SESSION)!,
    );
    expect(stored.state.sessionMeta.activeAgentTypeKey).toBeUndefined();
    expect(stored.state.sessionMeta.settings.agentCodexReasoningEffort).toBe(
      "high",
    );
    const windowStored = JSON.parse(
      sessionStorage.getItem(`${STORAGE_KEYS.AGENT_SESSION}:window:main`)!,
    );
    expect(windowStored.state.sessionMeta.activeAgentTypeKey).toBe("codex");

    vi.resetModules();
    const { useAgentSessionStore: rehydrated } = await import(
      "@features/agent/store/agent-session-store"
    );
    const meta = rehydrated.getState().sessionMeta;
    expect(meta.activeAgentTypeKey).toBe("codex");
    expect(meta.activeThreadIds.codex).toBe("thread-x");
    expect(meta.settings.agentCodexReasoningEffort).toBe("high");
  });

  it("ignores the obsolete CHAT key when AGENT_SESSION is present", async () => {
    localStorage.setItem(
      STORAGE_KEYS.CHAT,
      JSON.stringify({ state: { activeAgentTypeKey: "claude" } }),
    );
    localStorage.setItem(
      STORAGE_KEYS.AGENT_SESSION,
      JSON.stringify({
        state: {
          sessionMeta: {
            ...DEFAULT_AGENT_SESSION_META,
            activeAgentTypeKey: "codex",
          },
        },
        version: 0,
      }),
    );

    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    expect(
      useAgentSessionStore.getState().sessionMeta.activeAgentTypeKey,
    ).toBe("codex");
  });

  it("falls back to default activeAgentTypeKey when persisted value is unselectable", async () => {
    localStorage.setItem(
      STORAGE_KEYS.AGENT_SESSION,
      JSON.stringify({
        state: {
          sessionMeta: {
            ...DEFAULT_AGENT_SESSION_META,
            activeAgentTypeKey: "bogus-type",
          },
        },
        version: 0,
      }),
    );

    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    expect(
      useAgentSessionStore.getState().sessionMeta.activeAgentTypeKey,
    ).toBe(DEFAULT_AGENT_TYPE_KEY);
  });

  it("uses DEFAULT_SESSION_META when no persisted data exists", async () => {
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    expect(useAgentSessionStore.getState().sessionMeta).toEqual(
      DEFAULT_AGENT_SESSION_META,
    );
  });
});
