import { describe, expect, it } from "vitest";
import { parsePiHistoryMessages } from "@features/agent/runtime/pi-history";

describe("Pi history message identity", () => {
  it("preserves original Pi block indices when hidden thinking is omitted", () => {
    const rows = parsePiHistoryMessages("thread", [{ role: "assistant", _pi_session_message_id: "entry",
      content: [
        { type: "text", text: "before", _pi_content_index: 1 },
        { type: "toolCall", id: "call", name: "read", arguments: {}, _pi_content_index: 2 },
        { type: "text", text: "after", _pi_content_index: 3 },
      ],
    }]);
    expect(rows.map((row) => row.id)).toEqual(["entry:block:1", "call", "entry:block:3"]);
    expect(rows.map((row) => row.piBlockIndex)).toEqual([1, 2, 3]);
  });

  it("uses the Pi session entry id for user and assistant rows", () => {
    const messages = parsePiHistoryMessages("thread-1", [
      {
        role: "user",
        content: [{ type: "text", text: "second prompt" }],
        timestamp: 1791301625351,
        _pi_session_message_id: "a58b853d",
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        timestamp: 1791301626000,
        _pi_session_message_id: "67575cb5",
      },
    ]);

    expect(messages.map(({ messageId }) => messageId)).toEqual(["a58b853d", "67575cb5"]);
    expect(messages[1].id).toBe("67575cb5:block:0");
  });

  it("keeps each native tool call as its own row under its assistant entry", () => {
    const messages = parsePiHistoryMessages("thread-1", [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "inspect" },
          { type: "text", text: "I will check " },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } },
          { type: "toolCall", id: "call-2", name: "bash", arguments: { command: "pwd" } },
          { type: "text", text: "the files." },
        ],
        timestamp: 1791301626000,
        _pi_session_message_id: "assistant-entry",
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        content: [{ type: "text", text: "file content" }],
      },
      {
        role: "toolResult",
        toolCallId: "call-2",
        content: [{ type: "text", text: "working directory" }],
      },
    ]);

    expect(messages).toHaveLength(5);
    expect(messages.map(({ id, role }) => [id, role])).toEqual([
      ["assistant-entry:block:0", "reasoning"],
      ["assistant-entry:block:1", "assistant"],
      ["call-1", "tool"],
      ["call-2", "tool"],
      ["assistant-entry:block:4", "assistant"],
    ]);
    expect(messages[1].content).toBe("I will check ");
    expect(messages[4].content).toBe("the files.");
    expect(messages.filter((row) => row.role !== "tool").every((row) => row.messageId === "assistant-entry")).toBe(true);
    expect(messages[2]).toMatchObject({
      toolCallId: "call-1",
      parentMessageId: "assistant-entry",
      content: "file content",
    });
    expect(messages[3]).toMatchObject({
      toolCallId: "call-2",
      parentMessageId: "assistant-entry",
      content: "working directory",
    });
  });

  it("does not report a tool call as complete when Pi has no native tool result", () => {
    const rows = parsePiHistoryMessages("thread", [{
      role: "assistant",
      content: [{ type: "toolCall", id: "interrupted-call", name: "read", arguments: {} }],
      stopReason: "aborted",
      _pi_session_message_id: "assistant-entry",
    }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "tool", toolCallId: "interrupted-call", isCompleted: false });
  });

  it("uses the native entry id for bash history rows", () => {
    const messages = parsePiHistoryMessages("thread-1", [{
      role: "bashExecution",
      command: "pwd",
      output: "/work",
      exitCode: 0,
      timestamp: 1791301626000,
      _pi_session_message_id: "bash-entry",
      _pi_session_parent_id: "user-entry",
    }]);

    expect(messages[0]).toMatchObject({
      id: "bash-entry",
      toolCallId: "bash-entry",
      parentMessageId: "user-entry",
    });
  });

  it("keeps the native assistant id when Pi completes with an error", () => {
    const messages = parsePiHistoryMessages("thread-1", [{
      role: "assistant",
      content: [{ type: "text", text: "partial output" }],
      errorMessage: "provider failed",
      stopReason: "error",
      timestamp: 1791301626000,
      _pi_session_message_id: "error-entry",
    }]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "error-entry:block:0",
      messageId: "error-entry",
      role: "assistant",
      content: "partial output\n\nprovider failed",
      isCompleted: true,
    });
  });

  it("does not manufacture history ids when Pi did not provide one", () => {
    const messages = parsePiHistoryMessages("thread-1", [
      {
        role: "user",
        content: [{ type: "text", text: "prompt" }],
        timestamp: 1791301625351,
      },
    ]);

    expect(messages).toEqual([]);
  });
});
