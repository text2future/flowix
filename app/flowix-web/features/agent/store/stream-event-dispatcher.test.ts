import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/types/agent";
import {
  createStreamEventDispatcher,
  type StreamEventDispatcherPorts,
} from "@features/agent/store/stream-event-dispatcher";
import {
  emptyProjection,
  reduceProjection,
  type ThreadProjection,
} from "@features/agent/store/session-reducer";

function createPorts() {
  const projections: Record<string, ThreadProjection> = {};
  const resolved: Record<string, string> = {};
  const tombstones = new Set<string>();
  const applySessionResolved = vi.fn(
    (event: AgentEvent & { kind: "session_resolved" }) => {
      resolved[event.threadId] = event.sessionId;
    },
  );
  const ports: StreamEventDispatcherPorts = {
    getProjection: (threadId) => projections[threadId],
    canDispatch: (threadId) => !tombstones.has(threadId),
    dispatch: (event) => {
      projections[event.threadId] = reduceProjection(
        projections[event.threadId] ?? emptyProjection(),
        event,
      );
    },
    applySessionResolved,
  };
  return { ports, projections, resolved, tombstones, applySessionResolved };
}

describe("createStreamEventDispatcher", () => {
  it("preserves whitespace-only text deltas", () => {
    const { ports, projections } = createPorts();
    const dispatcher = createStreamEventDispatcher(ports);
    dispatcher.dispatch({ kind: "stream_start", agentType: "codex", threadId: "thread-1", runId: "run-1", timestamp: 1 });
    for (const text of ["A", " ", "\n", "    ", "B"]) {
      dispatcher.dispatch({ kind: "text_delta", agentType: "codex", threadId: "thread-1", runId: "run-1", timestamp: 2, text, contentMode: "delta", messagePhase: "updated" });
    }
    dispatcher.flushBuffer();
    expect(projections["thread-1"].messages[0]?.content).toBe("A \n    B");
  });

  it("flushes the buffered delta before a newer run starts", () => {
    const { ports, projections } = createPorts();
    const dispatcher = createStreamEventDispatcher(ports);
    dispatcher.dispatch({ kind: "stream_start", agentType: "codex", threadId: "thread-1", runId: "run-1", timestamp: 1 });
    dispatcher.dispatch({ kind: "text_delta", agentType: "codex", threadId: "thread-1", runId: "run-1", timestamp: 2, text: "old", contentMode: "delta", messagePhase: "updated" });
    dispatcher.dispatch({ kind: "stream_start", agentType: "codex", threadId: "thread-1", runId: "run-2", timestamp: 3 });
    expect(projections["thread-1"].messages.some((message) => message.content === "old")).toBe(true);
    dispatcher.flushBuffer();
    expect(projections["thread-1"].runs.activeRunId).toBe("run-2");
    expect(projections["thread-1"].messages.filter((message) => message.content === "old")).toHaveLength(1);
  });

  it("ignores a delta without a run ID", () => {
    const { ports, projections } = createPorts();
    const dispatcher = createStreamEventDispatcher(ports);
    dispatcher.dispatch({ kind: "stream_start", agentType: "codex", threadId: "thread-1", runId: "run-1", timestamp: 1 });
    dispatcher.dispatch({ kind: "text_delta", agentType: "codex", threadId: "thread-1", runId: "", timestamp: 2, text: "legacy", contentMode: "delta", messagePhase: "updated" });
    dispatcher.flushBuffer();
    expect(projections["thread-1"].messages).toEqual([]);
  });

  it("buffers text through an injected scheduler without importing Zustand", () => {
    const { ports, projections } = createPorts();
    let scheduled: FrameRequestCallback | null = null;
    const dispatcher = createStreamEventDispatcher(ports, {
      request: (callback) => {
        scheduled = callback;
        return 1;
      },
      cancel: vi.fn(),
    });
    dispatcher.dispatch({
      kind: "stream_start",
      agentType: "codex",
      threadId: "thread-1",
      runId: "run-1",
      timestamp: 1,
    });
    dispatcher.dispatch({
      kind: "text_delta",
      agentType: "codex",
      threadId: "thread-1",
      runId: "run-1",
      timestamp: 2,
      text: "buffered answer",
      contentMode: "delta",
      messagePhase: "updated",
      sourceTimestamp: 2,
    });

    expect(projections["thread-1"].messages).toEqual([]);
    expect(scheduled).not.toBeNull();
    (scheduled as unknown as FrameRequestCallback)(3);

    expect(projections["thread-1"].messages[0]?.content).toBe(
      "buffered answer",
    );
  });

  it("joins a buffered Codex delta to its later provider completion snapshot", () => {
    const { ports, projections } = createPorts();
    const dispatcher = createStreamEventDispatcher(ports);

    dispatcher.dispatch({
      kind: "stream_start",
      agentType: "codex",
      threadId: "thread-1",
      runId: "run-1",
      timestamp: 1,
    });
    dispatcher.dispatch({
      kind: "text_delta",
      agentType: "codex",
      threadId: "thread-1",
      runId: "run-1",
      timestamp: 2,
      text: "answer",
      messagePhase: "updated",
      contentMode: "delta",
      codexTurnId: "turn-1",
    });
    dispatcher.dispatch({
      kind: "final_message",
      agentType: "codex",
      threadId: "thread-1",
      runId: "run-1",
      timestamp: 3,
      text: "answer",
      messageId: "assistant-item-1",
      messagePhase: "completed",
      contentMode: "snapshot",
      codexTurnId: "turn-1",
    });

    expect(projections["thread-1"].messages).toHaveLength(1);
    expect(projections["thread-1"].messages[0]).toMatchObject({
      id: "assistant-item-1",
      content: "answer",
    });
  });

  it("routes session resolution through the injected atomic action", () => {
    const { ports, applySessionResolved } = createPorts();
    const dispatcher = createStreamEventDispatcher(ports);
    const event: AgentEvent & { kind: "session_resolved" } = {
      kind: "session_resolved",
      agentType: "codex",
      threadId: "local-thread",
      sessionId: "session-thread",
      runId: "run-1",
      timestamp: 1,
    };

    dispatcher.dispatch(event);

    expect(applySessionResolved).toHaveBeenCalledOnce();
    expect(applySessionResolved).toHaveBeenCalledWith(event);
  });

  it("drops events for tombstoned threads", () => {
    const { ports, projections, tombstones } = createPorts();
    tombstones.add("deleted-thread");
    const dispatcher = createStreamEventDispatcher(ports);

    dispatcher.dispatch({
      kind: "stream_start",
      agentType: "codex",
      threadId: "deleted-thread",
      runId: "late-run",
      timestamp: 1,
    });

    expect(projections["deleted-thread"]).toBeUndefined();
  });
});
