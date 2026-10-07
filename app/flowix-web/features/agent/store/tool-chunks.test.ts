import { mergeLiveMessagesIntoRenderableMessages } from "@features/agent/store/thread-history";
import { describe, expect, it } from "vitest";

import {
  applyToolCallChunk,
  applyToolResultChunk,
} from "@features/agent/store/tool-chunks";
import {
  applyReasoningChunk,
  applyTextChunk,
  applyUserMessageChunk,
} from "@features/agent/store/message-chunks";
import type { LiveMessageState } from "@features/agent/store/chunk-result";

function emptyState(): LiveMessageState {
  return {
    messages: [],
    pendingAssistantId: null,
    pendingReasoningId: null,
  };
}

describe("tool chunk idempotency", () => {
  it("synchronizes Pi block commits to the displayed timeline without stale drafts or order", () => {
    const scope = { adoptPendingId: true, draftScope: "run" };
    let projection = emptyState();
    let displayed = projection.messages;
    const sync = (next: LiveMessageState) => {
      projection = next;
      displayed = mergeLiveMessagesIntoRenderableMessages(displayed, projection.messages, "pi");
    };
    sync(applyTextChunk(projection, "before", { ...scope, blockIndex: 0 }));
    sync(applyTextChunk(projection, "after", { ...scope, blockIndex: 2 }));
    const keys = displayed.map((row) => row.renderKey);
    sync(applyTextChunk(projection, "before", {
      ...scope, blockIndex: 0, id: "entry:block:0", nativeMessageId: "entry", contentMode: "snapshot", phase: "completed",
    }));
    sync(applyToolCallChunk(projection, "call", "read", {}, "pi", {
      id: "call", parentMessageId: "entry", sourceSubsequence: 1,
    }));
    sync(applyTextChunk(projection, "after", {
      ...scope, blockIndex: 2, id: "entry:block:2", nativeMessageId: "entry", contentMode: "snapshot", phase: "completed",
    }));
    expect(displayed.map((row) => row.id)).toEqual(["entry:block:0", "call", "entry:block:2"]);
    expect(displayed[0].renderKey).toBe(keys[0]);
    expect(displayed[2].renderKey).toBe(keys[1]);
    expect(displayed.some((row) => row.messageId === null)).toBe(false);
  });

  it("keeps separate Pi text blocks around a tool throughout commit and replay", () => {
    const scope = { adoptPendingId: true, draftScope: "run" };
    const a = applyTextChunk(emptyState(), "before", { ...scope, blockIndex: 0 });
    const aKey = a.messages[0].renderKey;
    const b = applyTextChunk(a, "after", { ...scope, blockIndex: 2 });
    const bKey = b.messages[1].renderKey;
    const commitA = applyTextChunk(b, "before", {
      ...scope, blockIndex: 0, id: "entry:block:0", nativeMessageId: "entry", phase: "completed", contentMode: "snapshot",
    });
    const call = applyToolCallChunk(commitA, "call", "read", {}, "pi", {
      id: "call", parentMessageId: "entry", sourceSubsequence: 1,
    });
    const commitB = applyTextChunk(call, "after", {
      ...scope, blockIndex: 2, id: "entry:block:2", nativeMessageId: "entry", phase: "completed", contentMode: "snapshot",
    });
    expect(commitB.messages.map((row) => row.id)).toEqual(["entry:block:0", "call", "entry:block:2"]);
    expect(commitB.messages[0]).toMatchObject({ messageId: "entry", renderKey: aKey });
    expect(commitB.messages[2]).toMatchObject({ messageId: "entry", renderKey: bKey });
    const replay = applyTextChunk(commitB, "after", {
      ...scope, blockIndex: 2, id: "entry:block:2", nativeMessageId: "entry", phase: "completed", contentMode: "snapshot",
    });
    expect(replay.messages).toBe(commitB.messages);
  });

  it("keeps Pi tool calls after streamed assistant text despite earlier native timestamps", () => {
    const draft = applyTextChunk(emptyState(), "Let me check", { adoptPendingId: true, draftScope: "run" });
    const committed = applyTextChunk(draft, "Let me check", {
      id: "entry", adoptPendingId: true, draftScope: "run", contentMode: "snapshot", phase: "completed",
      sourceTimestamp: 1, sourceSequence: 10, sourceSubsequence: 0,
    });
    const tool = applyToolCallChunk(committed, "call", "read", {}, "pi", {
      id: "call", parentMessageId: "entry", sourceTimestamp: 1, sourceSequence: 10, sourceSubsequence: 1,
    });
    expect(tool.messages.map((row) => row.role)).toEqual(["assistant", "tool"]);
  });

  it("reconciles a persisted user message with the optimistic row by id", () => {
    const optimistic: LiveMessageState = {
      ...emptyState(),
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "question",
          timestamp: new Date(456).toISOString(),
        },
      ],
    };

    const reconciled = applyUserMessageChunk(optimistic, "question", {
      id: "user-1",
      sourceTimestamp: 456,
      sourceSequence: 0,
      sourceSubsequence: 0,
    });

    expect(reconciled.messages).toHaveLength(1);
    expect(reconciled.messages[0]).toMatchObject({
      id: "user-1",
      role: "user",
      content: "question",
      sourceTimestamp: 456,
      sourceSequence: 0,
    });
  });

  it("appends a new user turn despite stale provider ordering metadata", () => {
    const state: LiveMessageState = {
      ...emptyState(),
      messages: [
        {
          id: "old-assistant",
          role: "assistant",
          content: "previous answer",
          timestamp: new Date(2_000).toISOString(),
          sourceTimestamp: 2_000,
          sourceSequence: 20,
        },
      ],
    };

    const result = applyUserMessageChunk(state, "next question", {
      id: "new-user",
      sourceTimestamp: 1_000,
      sourceSequence: 0,
      sourceSubsequence: 0,
    });

    expect(result.messages.map((message) => message.id)).toEqual([
      "old-assistant",
      "new-user",
    ]);
  });

  it("upserts repeated tool calls before applying the result", () => {
    const first = applyToolCallChunk(
      emptyState(),
      "future-1",
      "future_connector",
      { query: "first" },
      "codex",
    );
    const replayed = applyToolCallChunk(
      first,
      "future-1",
      "future_connector",
      { query: "complete" },
      "codex",
    );
    const completed = applyToolResultChunk(
      replayed,
      "future-1",
      "future_connector",
      { status: "completed" },
    );

    expect(completed.messages).toHaveLength(1);
    expect(completed.messages[0]).toMatchObject({
      role: "tool",
      toolCallId: "future-1",
      toolName: "future_connector",
      toolInput: { query: "complete" },
      isLoading: false,
    });
  });

  it("keeps sibling Pi tool calls distinct under their parent entry", () => {
    const first = applyToolCallChunk(
      emptyState(),
      "call-1",
      "read",
      { path: "a" },
      "pi",
      { id: "call-1", parentMessageId: "assistant-entry" },
    );
    const second = applyToolCallChunk(
      first,
      "call-2",
      "bash",
      { command: "pwd" },
      "pi",
      { id: "call-2", parentMessageId: "assistant-entry" },
    );

    expect(second.messages.map(({ id, toolCallId, parentMessageId }) => ({
      id,
      toolCallId,
      parentMessageId,
    }))).toEqual([
      { id: "call-1", toolCallId: "call-1", parentMessageId: "assistant-entry" },
      { id: "call-2", toolCallId: "call-2", parentMessageId: "assistant-entry" },
    ]);
  });

  it("does not reopen an already completed tool row", () => {
    const started = applyToolCallChunk(
      emptyState(),
      "future-2",
      "future_connector",
      {},
      "codex",
    );
    const completed = applyToolResultChunk(
      started,
      "future-2",
      "future_connector",
      { status: "completed" },
    );
    const replayed = applyToolCallChunk(
      completed,
      "future-2",
      "future_connector",
      {},
      "codex",
    );

    expect(replayed.messages).toHaveLength(1);
    expect(replayed.messages[0].isLoading).toBe(false);
  });

  it("creates a visible fallback row when the tool call event was lost", () => {
    const completed = applyToolResultChunk(
      emptyState(),
      "future-result-only",
      "future_connector",
      { content: "fallback output" },
      "codex",
    );

    expect(completed.messages).toHaveLength(1);
    expect(completed.messages[0]).toMatchObject({
      role: "tool",
      toolCallId: "future-result-only",
      toolName: "future_connector",
      toolAgentType: "codex",
      content: "fallback output",
      isLoading: false,
    });
  });

  it("starts a new assistant row after a result-only tool event", () => {
    const beforeTool = applyTextChunk(emptyState(), "before", {
      id: "assistant-before-tool",
      phase: "updated",
      contentMode: "delta",
    });
    const toolResult = applyToolResultChunk(
      beforeTool,
      "future-result-only",
      "future_connector",
      { content: "tool output" },
      "codex",
    );
    const afterTool = applyTextChunk(toolResult, "after", {
      contentMode: "delta",
    });

    expect(afterTool.messages.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(afterTool.messages.map((message) => message.content)).toEqual([
      "before",
      "tool output",
      "after",
    ]);
  });

  it("inserts a reconciled tool before a later assistant by source time", () => {
    const assistant = applyTextChunk(emptyState(), "final answer", {
      id: "assistant-item-2",
      phase: "completed",
      contentMode: "snapshot",
      sourceTimestamp: 2_000,
      sourceSequence: 20,
    });
    const tool = applyToolCallChunk(
      assistant,
      "call-1",
      "exec_command",
      { cmd: "pwd" },
      "codex",
      {
        id: "tool-call-1",
        phase: "started",
        sourceTimestamp: 1_000,
        sourceSequence: 10,
      },
    );

    expect(tool.messages.map((message) => message.id)).toEqual([
      "tool-call-1",
      "assistant-item-2",
    ]);
  });

  it("keeps the started tool name when a result has a generic name", () => {
    const started = applyToolCallChunk(
      emptyState(),
      "plan-1",
      "todo_write",
      {
        todos: [
          { content: "检查项目", status: "pending" },
          { content: "修复展示", status: "pending" },
        ],
      },
      "deepseek-harness",
    );
    const completed = applyToolResultChunk(
      started,
      "plan-1",
      "tool",
      { content: "ok" },
      "deepseek-harness",
    );

    expect(completed.messages[0]).toMatchObject({
      toolName: "todo_write",
      toolDisplay: { summary: "0/2", kind: "todo" },
      isLoading: false,
    });
  });

  it("keeps the streaming presentation when the result completes the tool", () => {
    const started = applyToolCallChunk(
      emptyState(),
      "exec-1",
      "exec_command",
      { command: "pwd", cwd: "/tmp" },
      "codex",
    );
    const startedDisplay = started.messages[0].toolDisplay;
    const completed = applyToolResultChunk(
      started,
      "exec-1",
      "command_execution",
      { exit_code: 0, output: "/tmp" },
      "codex",
    );

    expect(completed.messages[0]).toMatchObject({
      toolName: "exec_command",
      toolDisplay: startedDisplay,
      content: expect.stringContaining("/tmp"),
      isLoading: false,
    });
  });

  it("replaces repeated assistant snapshots with the same Codex message id", () => {
    const updated = applyTextChunk(
      applyTextChunk(emptyState(), "draft", {
        id: "assistant-item-3",
        phase: "updated",
        contentMode: "snapshot",
        sourceTimestamp: 1_000,
        sourceSequence: 10,
      }),
      "complete",
      {
        id: "assistant-item-3",
        phase: "completed",
        contentMode: "snapshot",
        sourceTimestamp: 1_100,
        sourceSequence: 11,
      },
    );

    expect(updated.messages).toHaveLength(1);
    expect(updated.messages[0]).toMatchObject({
      id: "assistant-item-3",
      content: "complete",
    });
    expect(updated.pendingAssistantId).toBeNull();
  });

  it("upserts reasoning snapshots by Codex message id and keeps the first order anchor", () => {
    const updated = applyReasoningChunk(
      applyReasoningChunk(emptyState(), "thinking", {
        id: "reasoning-item-1",
        phase: "updated",
        contentMode: "snapshot",
        sourceTimestamp: 1_000,
        sourceSequence: 4,
      }),
      "done thinking",
      {
        id: "reasoning-item-1",
        phase: "completed",
        contentMode: "snapshot",
        sourceTimestamp: 2_000,
        sourceSequence: 8,
      },
    );

    expect(updated.messages).toHaveLength(1);
    expect(updated.messages[0]).toMatchObject({
      id: "reasoning-item-1",
      content: "done thinking",
      sourceTimestamp: 1_000,
      sourceSequence: 4,
      isCompleted: true,
    });
    expect(updated.pendingReasoningId).toBeNull();
  });

  it("reopens and appends one run-scoped Claude reasoning row after a tool cycle", () => {
    const first = applyReasoningChunk(emptyState(), "first thought", {
      id: "reasoning-run-1",
      phase: "updated",
      contentMode: "delta",
      sourceTimestamp: 1_000,
      sourceSequence: 1,
    });
    const closed = applyTextChunk(first, "tool preface", {
      id: "assistant-message-1",
      phase: "completed",
      contentMode: "snapshot",
      sourceTimestamp: 1_100,
      sourceSequence: 2,
    });
    const continued = applyReasoningChunk(closed, "; second thought", {
      id: "reasoning-run-1",
      phase: "updated",
      contentMode: "delta",
      sourceTimestamp: 1_200,
      sourceSequence: 3,
    });

    expect(
      continued.messages.filter((message) => message.role === "reasoning"),
    ).toMatchObject([
      {
        id: "reasoning-run-1",
        content: "first thought; second thought",
        sourceTimestamp: 1_000,
        sourceSequence: 1,
        isCompleted: false,
      },
    ]);
    expect(continued.pendingReasoningId).toBe("reasoning-run-1");
  });
});
