import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@/types/agent";
import {
  emptyProjection,
  reduceProjection,
} from "@features/agent/store/session-reducer";

function event<K extends AgentEvent["kind"]>(
  kind: K,
  payload: Omit<Extract<AgentEvent, { kind: K }>, "kind">,
): AgentEvent {
  return { kind, ...payload } as AgentEvent;
}

const userMessage = (text: string, id: string): AgentEvent =>
  event("user_message", {
    agentType: "deepseek-harness",
    threadId: "t1",
    runId: "r1",
    timestamp: 1000,
    text,
    id,
    sourceTimestamp: 1000,
    sourceSequence: 1,
    sourceSubsequence: 0,
  });

const textDelta = (text: string, messageId?: string): AgentEvent =>
  event("text_delta", {
    agentType: "deepseek-harness",
    threadId: "t1",
    runId: "r1",
    timestamp: 2000,
    text,
    messageId: messageId ?? "assistant-r1",
    messagePhase: "updated",
    contentMode: "delta",
    sourceTimestamp: 2000,
    sourceSequence: 2,
    sourceSubsequence: 0,
  });

const reasoningDelta = (text: string): AgentEvent =>
  event("reasoning_delta", {
    agentType: "deepseek-harness",
    threadId: "t1",
    runId: "r1",
    timestamp: 3000,
    text,
    messageId: "reasoning-r1-block-0",
    messagePhase: "updated",
    contentMode: "delta",
    sourceTimestamp: 3000,
    sourceSequence: 3,
    sourceSubsequence: 0,
  });

const streamStart = (runId: string): AgentEvent =>
  event("stream_start", {
    agentType: "deepseek-harness",
    threadId: "t1",
    runId,
    timestamp: 0,
    model: "gpt-test",
  });

const streamEnd = (
  runId: string,
  reason: string | null = null,
  durationMs?: number,
): AgentEvent =>
  event("stream_end", {
    agentType: "deepseek-harness",
    threadId: "t1",
    runId,
    timestamp: 9000,
    reason,
    durationMs,
  });

const errorEvent = (message: string): AgentEvent =>
  event("error", {
    agentType: "deepseek-harness",
    threadId: "t1",
    runId: "r1",
    timestamp: 9500,
    message,
  });

const toolCall = (
  id: string,
  name: string,
  reasoningBoundary = false,
): AgentEvent =>
  event("tool_call", {
    agentType: "deepseek-harness",
    threadId: "t1",
    runId: "r1",
    timestamp: 4000,
    toolCallId: id,
    name,
    input: { command: "ls" },
    messageId: `tool-${id}`,
    messagePhase: "started",
    sourceTimestamp: 4000,
    sourceSequence: 4,
    sourceSubsequence: 0,
    reasoningBoundary,
  });

const toolResult = (id: string, name: string): AgentEvent =>
  event("tool_result", {
    agentType: "deepseek-harness",
    threadId: "t1",
    runId: "r1",
    timestamp: 5000,
    toolCallId: id,
    name,
    result: { content: "ok" },
    messageId: `tool-${id}`,
    messagePhase: "completed",
    sourceTimestamp: 5000,
    sourceSequence: 5,
    sourceSubsequence: 0,
  });

describe("reduceProjection / emptyProjection", () => {
  it("emptyProjection returns a clean baseline", () => {
    expect(emptyProjection()).toMatchObject({
      messages: [],
      pending: { assistantId: null, reasoningId: null },
      pagination: {
        oldestSequence: null,
        hasMoreHistory: false,
        loadingInitial: false,
        loadingMore: false,
      },
      runs: {
        isLoading: false,
        activeRunId: null,
        runs: {},
      },
    });
  });

  it("reducer is pure (input not mutated)", () => {
    const p0 = emptyProjection();
    const p1 = reduceProjection(p0, userMessage("hi", "u1"));
    expect(p0.messages).toHaveLength(0);
    expect(p1.messages).toHaveLength(1);
    expect(p1).not.toBe(p0);
  });
});

describe("reduceProjection / text streaming lifecycle", () => {
  it("stream_start → text_delta → text_delta appends content", () => {
    let p = emptyProjection();
    p = reduceProjection(p, streamStart("r1"));
    expect(p.runs.isLoading).toBe(true);
    expect(p.runs.activeRunId).toBe("r1");
    expect(p.runs.runs["r1"]?.status).toBe("running");

    p = reduceProjection(p, textDelta("Hello "));
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]).toMatchObject({ role: "assistant", content: "Hello " });
    expect(p.pending.assistantId).toBe("assistant-r1");

    p = reduceProjection(p, textDelta("world"));
    expect(p.messages[0].content).toBe("Hello world");
    expect(p.messages).toHaveLength(1);
  });

  it("a new user turn starts a new assistant message even without a prior stream_end", () => {
    let p = emptyProjection();
    p = reduceProjection(p, streamStart("r1"));
    p = reduceProjection(p, textDelta("first", "assistant-r1"));
    p = reduceProjection(
      p,
      event("user_message", {
        agentType: "deepseek-harness",
        threadId: "t1",
        runId: "r2",
        timestamp: 2500,
        text: "second question",
        id: "msg:deepseek-harness:r2:user:user-r2",
      }),
    );
    p = reduceProjection(
      p,
      event("text_delta", {
        agentType: "deepseek-harness",
        threadId: "t1",
        runId: "r2",
        timestamp: 2600,
        text: "second",
        messageId: "msg:deepseek-harness:r2:assistant:stream",
        messagePhase: "updated",
        contentMode: "delta",
      }),
    );

    expect(p.messages.map((message) => [message.role, message.content])).toEqual([
      ["assistant", "first"],
      ["user", "second question"],
      ["assistant", "second"],
    ]);
  });

  it("reasoning_delta before text_delta closes reasoning when text lands", () => {
    let p = emptyProjection();
    p = reduceProjection(p, streamStart("r1"));
    p = reduceProjection(p, reasoningDelta("think... "));
    expect(p.messages[0]).toMatchObject({ role: "reasoning", isCompleted: false });
    expect(p.pending.reasoningId).toBe("reasoning-r1-block-0");

    p = reduceProjection(p, textDelta("answer"));
    // applyTextChunk 关闭上一条 reasoning 行 (isCompleted=true) 然后追加 assistant.
    const reasoning = p.messages.find((m) => m.role === "reasoning");
    const assistant = p.messages.find((m) => m.role === "assistant");
    expect(reasoning).toMatchObject({ isCompleted: true });
    expect(assistant).toMatchObject({ content: "answer" });
    expect(p.pending.reasoningId).toBeNull();
    expect(p.pending.assistantId).toBe("assistant-r1");
  });

  it("closes an explicit reasoning segment at a declared tool boundary", () => {
    let p = emptyProjection();
    p = reduceProjection(p, streamStart("r1"));
    p = reduceProjection(p, reasoningDelta("before tool"));
    p = reduceProjection(p, toolCall("call-1", "read", true));

    expect(p.messages.find((message) => message.role === "reasoning")).toMatchObject({
      content: "before tool",
      isCompleted: true,
    });
    expect(p.pending.reasoningId).toBeNull();

    p = reduceProjection(
      p,
      event("reasoning_delta", {
        agentType: "deepseek-harness",
        threadId: "t1",
        runId: "r1",
        timestamp: 6000,
        text: "after tool",
        messageId: "reasoning-r1-block-1",
        messagePhase: "updated",
        contentMode: "delta",
        sourceTimestamp: 6000,
        sourceSequence: 6,
        sourceSubsequence: 0,
      }),
    );

    expect(p.messages.filter((message) => message.role === "reasoning")).toHaveLength(2);
    expect(p.messages[p.messages.length - 1]).toMatchObject({
      role: "reasoning",
      content: "after tool",
      isCompleted: false,
    });
  });

  it("stream_end completes the reasoning row and clears pending", () => {
    let p = emptyProjection();
    p = reduceProjection(p, streamStart("r1"));
    p = reduceProjection(p, reasoningDelta("only thinking"));
    p = reduceProjection(p, streamEnd("r1"));

    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]).toMatchObject({
      role: "reasoning",
      content: "only thinking",
      isCompleted: true,
    });
    expect(p.runs.isLoading).toBe(false);
    expect(p.runs.activeRunId).toBeNull();
    expect(p.runs.lastRun?.status).toBe("completed");
    expect(p.pending.assistantId).toBeNull();
    expect(p.pending.reasoningId).toBeNull();
  });

  it("attaches a provider turn duration to the final assistant row", () => {
    let p = emptyProjection();
    p = reduceProjection(p, streamStart("r1"));
    p = reduceProjection(p, textDelta("answer"));
    p = reduceProjection(p, streamEnd("r1", null, 69078));

    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]).toMatchObject({
      role: "assistant",
      content: "answer",
      turnDurationMs: 69078,
    });
  });

  it("error chunk closes pending and inserts error assistant row", () => {
    let p = emptyProjection();
    p = reduceProjection(p, streamStart("r1"));
    p = reduceProjection(p, reasoningDelta("thinking"));
    p = reduceProjection(p, errorEvent("boom"));

    const reasoning = p.messages.find((m) => m.role === "reasoning");
    expect(reasoning?.isCompleted).toBe(true);
    const assistant = p.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("boom");
    expect(p.runs.lastRun?.status).toBe("failed");
    expect(p.runs.isLoading).toBe(false);
  });

  it("collapses duplicate stdout/process-exit errors for one run", () => {
    let p = emptyProjection();
    const base = {
      agentType: "claude" as const,
      threadId: "t1",
      runId: "r1",
      timestamp: 9500,
      messageId: "msg:claude:r1:error:error",
    };
    p = reduceProjection(p, {
      kind: "error",
      ...base,
      message: "provider rate limit reached",
      errorDetails: {
        category: "rate_limited",
        statusCode: 429,
        retryable: true,
      },
    });
    p = reduceProjection(p, {
      kind: "error",
      ...base,
      timestamp: 9600,
      message: "Claude Code CLI exited with status exit status: 1",
    });

    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]).toMatchObject({
      content: "provider rate limit reached",
      errorDetails: { statusCode: 429 },
    });
  });

  it("marks DeepSeek Harness errors as reconnect failures and preserves the reason", () => {
    let p = emptyProjection();
    p = reduceProjection(
      p,
      event("error", {
        agentType: "deepseek-harness",
        threadId: "t1",
        runId: "r1",
        timestamp: 9500,
        messageId: "msg:deepseek-harness:r1:error:error",
        message: "Request timed out.",
      }),
    );

    expect(p.messages[p.messages.length - 1]).toMatchObject({
      id: "msg:deepseek-harness:r1:error:error",
      content: "Request timed out.",
      notice: "deepseek-harness-reconnect-failed",
    });
  });
});

describe("reduceProjection / tool call cycle", () => {
  it("keeps harness assistant segments separate while the run is still streaming", () => {
    const harnessText = (text: string, messageId: string) =>
      event("text_delta", {
        agentType: "deepseek-harness",
        threadId: "t1",
        runId: "r1",
        timestamp: 2000,
        text,
        messageId,
        messagePhase: "updated",
        contentMode: "delta",
      });
    const harnessToolCall = event("tool_call", {
      agentType: "deepseek-harness",
      threadId: "t1",
      runId: "r1",
      timestamp: 3000,
      toolCallId: "msg:deepseek-harness:r1:tool-call:c1",
      name: "read",
      input: { file_path: "README.md" },
      messageId: "msg:deepseek-harness:r1:tool:c1",
    });
    const harnessToolResult = event("tool_result", {
      agentType: "deepseek-harness",
      threadId: "t1",
      runId: "r1",
      timestamp: 4000,
      toolCallId: "msg:deepseek-harness:r1:tool-call:c1",
      name: "read",
      result: "ok",
      messageId: "msg:deepseek-harness:r1:tool:c1",
    });
    let p = emptyProjection();
    p = reduceProjection(p, streamStart("r1"));
    p = reduceProjection(
      p,
      harnessText(
        "before tool",
        "msg:deepseek-harness:r1:assistant:assistant-stream-0",
      ),
    );
    p = reduceProjection(p, harnessToolCall);
    p = reduceProjection(p, harnessToolResult);
    p = reduceProjection(
      p,
      harnessText(
        "after tool",
        "msg:deepseek-harness:r1:assistant:assistant-stream-1",
      ),
    );

    expect(
      p.messages.map((message) => [message.role, message.content]),
    ).toEqual([
      ["assistant", "before tool"],
      ["tool", '"ok"'],
      ["assistant", "after tool"],
    ]);
    expect(p.pending.assistantId).toBe(
      "msg:deepseek-harness:r1:assistant:assistant-stream-1",
    );
  });

  it("tool_call then tool_result completes the tool row without losing prior assistant", () => {
    let p = emptyProjection();
    p = reduceProjection(p, streamStart("r1"));
    p = reduceProjection(p, textDelta("calling tool"));
    p = reduceProjection(p, toolCall("c1", "Bash"));
    expect(p.messages.some((m) => m.role === "tool" && m.toolCallId === "c1")).toBe(true);
    expect(p.runs.runs["r1"]?.currentTool).toBe("Bash");
    expect(p.pending.assistantId).toBeNull();

    p = reduceProjection(p, toolResult("c1", "Bash"));
    const toolRow = p.messages.find((m) => m.role === "tool" && m.toolCallId === "c1");
    expect(toolRow?.isLoading).toBe(false);
    expect(p.runs.runs["r1"]?.currentTool).toBeNull();
  });

  it("renders a context compaction as an ordered system message", () => {
    let p = emptyProjection();
    p = reduceProjection(
      p,
      event("context_compaction", {
        agentType: "codex",
        threadId: "t1",
        runId: "r1",
        timestamp: 2500,
        id: "compaction-1",
        sourceTimestamp: 2500,
        sourceSequence: 3,
        codexTurnId: "turn-1",
      }),
    );

    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]).toMatchObject({
      id: "compaction-1",
      role: "system",
      messageType: "context-compaction",
      codexTurnId: "turn-1",
    });

    const same = reduceProjection(
      p,
      event("context_compaction", {
        agentType: "codex",
        threadId: "t1",
        runId: "r1",
        timestamp: 2500,
        id: "compaction-1",
        sourceTimestamp: 2500,
        sourceSequence: 3,
        codexTurnId: "turn-1",
      }),
    );
    expect(same).toBe(p);
  });

  it("stream_end closes any still-loading tool rows", () => {
    let p = emptyProjection();
    p = reduceProjection(p, streamStart("r1"));
    p = reduceProjection(p, toolCall("c1", "Bash"));
    expect(
      p.messages.find((m) => m.role === "tool" && m.toolCallId === "c1")?.isLoading,
    ).toBe(true);

    p = reduceProjection(p, streamEnd("r1"));
    expect(
      p.messages.find((m) => m.role === "tool" && m.toolCallId === "c1")?.isLoading,
    ).toBe(false);
  });
});

describe("reduceProjection / DSH command operations", () => {
  it("upserts pending and completed command state by command id", () => {
    let p = emptyProjection();
    p = reduceProjection(
      p,
      event("dsh_command", {
        agentType: "deepseek-harness",
        threadId: "t1",
        runId: "command-run-1",
        timestamp: 1000,
        id: "command-1",
        name: "compact",
        args: "",
        status: "pending",
      }),
    );
    expect(p.messages).toMatchObject([
      expect.objectContaining({
        id: "dsh-command:live:command-1",
        content: "/compact",
        isLoading: true,
        isCompleted: false,
      }),
    ]);
    expect(p.runs.dshCommand).toMatchObject({
      id: "command-1",
      status: "pending",
    });

    p = reduceProjection(
      p,
      event("dsh_command", {
        agentType: "deepseek-harness",
        threadId: "t1",
        runId: "command-run-1",
        timestamp: 2000,
        id: "command-1",
        name: "compact",
        args: "",
        status: "success",
        result: "Compacted",
      }),
    );
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]).toMatchObject({
      content: "/compact",
      isLoading: false,
      isCompleted: true,
    });
    expect(p.runs.dshCommand).toMatchObject({
      id: "command-1",
      status: "success",
      endedAt: 2000,
    });
  });

  it("does not show the internal /plan steer prompt as a second live user message", () => {
    let p = emptyProjection();
    p = reduceProjection(
      p,
      event("dsh_command", {
        agentType: "deepseek-harness",
        threadId: "t1",
        runId: "command-run-1",
        timestamp: 1000,
        id: "command-1",
        name: "plan",
        args: " 调研项目介绍",
        status: "pending",
      }),
    );

    p = reduceProjection(
      p,
      userMessage("调研项目介绍\n<## CONTEXT PROMPT ##>internal context", "steer-1"),
    );

    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]).toMatchObject({
      id: "dsh-command:live:command-1",
      content: "/plan 调研项目介绍",
    });
  });

});

describe("reduceProjection / session_resolved is a no-op", () => {
  it("does not change projection state (handled by applyExternalSessionResolved cross-thread)", () => {
    let p = emptyProjection();
    p = reduceProjection(p, streamStart("r1"));
    p = reduceProjection(p, textDelta("hello"));
    const before = p;
    const after = reduceProjection(
      p,
      event("session_resolved", {
        agentType: "deepseek-harness",
        threadId: "t1",
        runId: "test-run",
        timestamp: 9999,
        sessionId: "session-xyz",
      }),
    );
    expect(after).toBe(before);
  });
});

describe("reduceProjection / Codex command operations", () => {
  const commandEvent = (
    status: "pending" | "success" | "error" | "cancelled",
    result?: string,
    codexTurnId?: string,
  ): AgentEvent =>
    event("codex_command", {
      agentType: "codex",
      threadId: "t1",
      runId: "codex-command-run-1",
      timestamp: status === "pending" ? 1000 : 2000,
      id: "codex-command-1",
      command: "/goal set ship it",
      status,
      result,
      codexTurnId,
    });

  it("renders the command row and keeps it pending until terminal status", () => {
    let p = reduceProjection(emptyProjection(), commandEvent("pending"));

    expect(p.messages).toMatchObject([
      {
        id: "codex-command:live:codex-command-1",
        role: "user",
        messageType: "codex-command",
        content: "/goal set ship it",
        isLoading: true,
        isCompleted: false,
      },
    ]);
    expect(p.runs.codexCommand).toMatchObject({
      id: "codex-command-1",
      command: "/goal set ship it",
      status: "pending",
    });
    expect(p.runs.isLoading).toBe(false);

    p = reduceProjection(p, commandEvent("success", "ship it (active)"));
    expect(p.messages[0]).toMatchObject({
      isLoading: false,
      isCompleted: true,
    });
    expect(p.runs.codexCommand).toMatchObject({
      status: "success",
      result: "ship it (active)",
      endedAt: 2000,
    });
  });

  it("associates the terminal command row with its provider goal turn", () => {
    let p = reduceProjection(emptyProjection(), commandEvent("pending"));
    p = reduceProjection(
      p,
      commandEvent("success", "ship it (active)", "turn-goal-1"),
    );

    expect(p.messages[0]).toMatchObject({
      id: "codex-command:live:codex-command-1",
      codexTurnId: "turn-goal-1",
      isCompleted: true,
    });
  });

  it.each(["error", "cancelled"] as const)(
    "renders a terminal Codex command status: %s",
    (status) => {
      let p = reduceProjection(emptyProjection(), commandEvent("pending"));
      p = reduceProjection(p, commandEvent(status, "Command interrupted"));

      expect(p.messages[0]).toMatchObject({
        messageType: "codex-command",
        isLoading: false,
        isCompleted: true,
      });
      expect(p.runs.codexCommand?.status).toBe(status);
    },
  );
});

describe("reduceProjection / usage accumulates into runs", () => {
  it("usage event updates runs[runId].usage", () => {
    let p = emptyProjection();
    p = reduceProjection(p, streamStart("r1"));
    p = reduceProjection(
      p,
      event("usage", {
        agentType: "deepseek-harness",
        threadId: "t1",
        runId: "r1",
        timestamp: 8000,
        usage: { input_tokens: 10, output_tokens: 20 },
        modelId: "gpt-test",
        lastRunAt: 8000,
      }),
    );
    expect(p.runs.runs["r1"]?.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 0,
    });
  });
});
