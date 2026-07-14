import { describe, expect, it, vi } from "vitest";
import type { AgentEventMapperState } from "./agent-event-mapper";
import { mapAgentChunkToEvent } from "./agent-event-mapper";

function state(
  partial: Partial<AgentEventMapperState> = {},
): AgentEventMapperState {
  return {
    threadTypes: {},
    threadStates: {},
    externalSessionResolutions: {},
    ...partial,
  };
}

describe("agent event mapper", () => {
  it("maps Flowix text chunks to streaming deltas", () => {
    const event = mapAgentChunkToEvent(
      {
        kind: "text",
        thread_id: "flowix-thread",
        text: "hello",
        agent_type: "flowix",
        run_id: "run-1",
      },
      state(),
      () => 123,
    );

    expect(event).toMatchObject({
      kind: "text_delta",
      threadId: "flowix-thread",
      runId: "run-1",
      timestamp: 123,
      text: "hello",
    });
  });

  it("maps Codex text chunks to final messages", () => {
    const event = mapAgentChunkToEvent(
      {
        kind: "text",
        thread_id: "codex-thread",
        text: "complete answer",
        agent_type: "codex",
        run_id: "run-1",
      },
      state(),
      () => 123,
    );

    expect(event).toMatchObject({
      kind: "final_message",
      threadId: "codex-thread",
      agentType: "codex",
      text: "complete answer",
    });
  });

  it("keeps session_resolved routed to the local thread id", () => {
    const event = mapAgentChunkToEvent(
      {
        kind: "session_resolved",
        thread_id: "codex-local-inst-1",
        session_id: "codex-real-session",
        agent_type: "codex",
        run_id: "run-1",
      },
      state({
        externalSessionResolutions: {
          "codex-local-inst-1": "codex-real-session",
        },
      }),
      () => 123,
    );

    expect(event).toMatchObject({
      kind: "session_resolved",
      threadId: "codex-local-inst-1",
      sessionId: "codex-real-session",
    });
  });

  it("routes later chunks to the resolved external session id", () => {
    const event = mapAgentChunkToEvent(
      {
        kind: "stream_end",
        thread_id: "codex-local-inst-1",
        reason: null,
        agent_type: "codex",
        run_id: "run-1",
      },
      state({
        externalSessionResolutions: {
          "codex-local-inst-1": "codex-real-session",
        },
      }),
      () => 123,
    );

    expect(event).toMatchObject({
      kind: "stream_end",
      threadId: "codex-real-session",
      runId: "run-1",
    });
  });

  it("reuses the active run id when chunks omit run_id", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const event = mapAgentChunkToEvent(
      {
        kind: "reasoning",
        thread_id: "thread-1",
        text: "thinking",
        agent_type: "flowix",
      },
      state({
        threadStates: {
          "thread-1": { activeRunId: "active-run" },
        },
      }),
      () => 123,
    );

    expect(event.runId).toBe("active-run");
    vi.restoreAllMocks();
  });

  it("adds a stable tool display summary without requiring UI schema knowledge", () => {
    const event = mapAgentChunkToEvent(
      {
        kind: "tool_call",
        thread_id: "codex-thread",
        id: "tool-1",
        name: "web_search",
        input: { query: "OpenAI latest model" },
        agent_type: "codex",
        run_id: "run-1",
      },
      state(),
      () => 123,
    );

    expect(event).toMatchObject({
      kind: "tool_call",
      name: "web_search",
      input: { query: "OpenAI latest model" },
      display: {
        summary: "OpenAI latest model",
        title: "OpenAI latest model",
        kind: "search",
      },
    });
  });
});
