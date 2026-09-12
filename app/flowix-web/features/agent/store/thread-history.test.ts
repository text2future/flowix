import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@/types";
import {
  areMessagesEquivalent,
  filterRenderableHistoryMessages,
  historyCoversLiveTurn,
  mergeHistoricalMessages,
  mergeLiveMessagesIntoRenderableMessages,
  mergeMessagesForThreadRender,
  replaceCompletedRunWithHistory,
} from "@features/agent/store/thread-history";

function message(
  id: string,
  role: ChatMessage["role"],
  content: string,
  timestamp: string,
): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp,
  };
}

describe("mergeMessagesForThreadRender", () => {
  it("does not accept a terminal snapshot that still misses a live Codex row", () => {
    const user = message("user-live", "user", "ask", "2026-01-01T00:00:00Z");
    const assistant = message("assistant-live", "assistant", "done", "2026-01-01T00:00:01Z");
    expect(
      historyCoversLiveTurn(
        [message("user-provider", "user", "ask", "2026-01-01T00:00:00Z")],
        [user, assistant],
      ),
    ).toBe(false);
    expect(
      historyCoversLiveTurn(
        [
          message("user-provider", "user", "ask", "2026-01-01T00:00:00Z"),
          message("assistant-provider", "assistant", "done", "2026-01-01T00:00:01Z"),
        ],
        [user, assistant],
      ),
    ).toBe(true);
  });

  it("removes the system context from historical user messages", () => {
    expect(filterRenderableHistoryMessages([
      message(
        "u1",
        "user",
        "question\n<## CONTEXT PROMPT ##>\nhidden context",
        "2026-01-01T00:00:00.000Z",
      ),
    ])).toEqual([
      message("u1", "user", "question", "2026-01-01T00:00:00.000Z"),
    ]);
  });

  it("removes the Flowix workspace context from historical user messages", () => {
    expect(filterRenderableHistoryMessages([
      message(
        "u2",
        "user",
        "你好\n\n[Flowix workspace context]\ninternal workspace details",
        "2026-01-01T00:00:00.000Z",
      ),
    ])).toEqual([
      message("u2", "user", "你好", "2026-01-01T00:00:00.000Z"),
    ]);
  });

  it("keeps a later live user message with the same visible content", () => {
    const history = [
      message("history-user-1", "user", "same", "2026-01-01T00:00:00.000Z"),
      message("history-assistant-1", "assistant", "done", "2026-01-01T00:00:01.000Z"),
    ];
    const live = [
      message("live-user-2", "user", "same", "2026-01-01T00:00:02.000Z"),
    ];

    expect(mergeMessagesForThreadRender({ history, live }).map((m) => m.id)).toEqual([
      "history-user-1",
      "history-assistant-1",
      "live-user-2",
    ]);
  });

  it("orders a live user before a later historical assistant reply", () => {
    const history = [
      message("history-assistant-1", "assistant", "reply", "2026-01-01T00:00:02.000Z"),
    ];
    const live = [
      message("live-user-1", "user", "ask", "2026-01-01T00:00:01.000Z"),
    ];

    expect(mergeMessagesForThreadRender({ history, live }).map((m) => m.id)).toEqual([
      "live-user-1",
      "history-assistant-1",
    ]);
  });

  it("never reorders Codex history by live arrival timestamps", () => {
    const history = [
      message("history-user", "user", "run tool", "2026-08-29T10:00:00.000Z"),
      message("history-commentary", "assistant", "Checking.", "2026-08-29T10:00:00.000Z"),
      {
        ...message("history-tool", "tool", "/workspace", "2026-08-29T10:00:00.000Z"),
        toolCallId: "exec-1",
        toolName: "command_execution",
      },
      message("history-final", "assistant", "Done.", "2026-08-29T10:00:00.000Z"),
    ];
    const live = [
      message("live-user", "user", "run tool", "2026-08-29T10:00:01.000Z"),
      {
        ...message("live-tool", "tool", "/workspace", "2026-08-29T09:59:59.000Z"),
        toolCallId: "msg:codex:run-1:tool-call:exec-1",
        toolName: "command_execution",
      },
    ];

    expect(
      mergeMessagesForThreadRender({ history, live, agentType: "codex" }).map(
        (item) => item.id,
      ),
    ).toEqual([
      "history-user",
      "history-commentary",
      "history-tool",
      "history-final",
    ]);
  });

  it("keeps the cached Codex live turn after loaded history", () => {
    const history = [
      message("history-user", "user", "first question", "2026-08-29T10:00:00.000Z"),
      message("history-answer", "assistant", "first answer", "2026-08-29T10:00:01.000Z"),
    ];
    const cachedLiveTurn = [
      message("live-user", "user", "second question", "2026-08-29T09:00:00.000Z"),
      message("live-answer", "assistant", "working", "2026-08-29T09:00:01.000Z"),
    ];

    expect(
      mergeMessagesForThreadRender({
        history,
        live: cachedLiveTurn,
        agentType: "codex",
      }).map(
        (item) => item.id,
      ),
    ).toEqual([
      "history-user",
      "history-answer",
      "live-user",
      "live-answer",
    ]);
  });
});

describe("mergeLiveMessagesIntoRenderableMessages", () => {
  it("updates an existing live message by id inside the render list", () => {
    const existing = [
      message("assistant-live", "assistant", "Hel", "2026-01-01T00:00:01.000Z"),
    ];
    const live = [
      message("assistant-live", "assistant", "Hello", "2026-01-01T00:00:01.000Z"),
    ];

    expect(
      mergeLiveMessagesIntoRenderableMessages(existing, live)[0],
    ).toMatchObject({
      id: "assistant-live",
      content: "Hello",
    });
  });
});

describe("mergeHistoricalMessages", () => {
  it("keeps Codex turn item order when optimistic rows have later timestamps", () => {
    const historical = [
      message("codex-user", "user", "run tool", "2026-08-29T10:00:00.000Z"),
      message("codex-commentary", "assistant", "Checking.", "2026-08-29T10:00:00.000Z"),
      {
        ...message("codex-tool", "tool", "/workspace", "2026-08-29T10:00:00.000Z"),
        toolCallId: "exec-1",
        toolName: "pwd",
      },
      message("codex-final", "assistant", "Done.", "2026-08-29T10:00:00.000Z"),
    ];
    const existing = [
      message("local-user", "user", "run tool", "2026-08-29T10:00:01.000Z"),
      {
        ...message("live-tool", "tool", "/workspace", "2026-08-29T10:00:02.000Z"),
        toolCallId: "msg:codex:run-1:tool-call:exec-1",
        toolName: "pwd",
      },
    ];

    expect(
      mergeHistoricalMessages(existing, historical, "codex").map((item) => item.id),
    ).toEqual(["codex-user", "codex-commentary", "codex-tool", "codex-final"]);
  });

  it("reconciles the live compact command with its reconstructed history row", () => {
    const existing = [
      {
        ...message(
          "codex-command:live:command-1",
          "user",
          "/compact",
          "2026-08-29T10:00:01.000Z",
        ),
        messageType: "codex-command" as const,
        isCompleted: true,
      },
    ];
    const historical = [
      {
        ...message(
          "codex-command-history-compaction-1",
          "user",
          "/compact",
          "2026-08-29T10:00:00.000Z",
        ),
        messageType: "codex-command" as const,
        isCompleted: true,
      },
      {
        ...message(
          "compaction-1",
          "system",
          "",
          "2026-08-29T10:00:00.000Z",
        ),
        messageType: "context-compaction" as const,
      },
    ];

    expect(
      mergeHistoricalMessages(existing, historical, "codex").map((item) => item.id),
    ).toEqual(["codex-command-history-compaction-1", "compaction-1"]);
  });
});

describe("replaceCompletedRunWithHistory", () => {
  it("treats separately allocated but identical history messages as equivalent", () => {
    const existing = [
      message("m1", "assistant", "done", "2026-01-01T00:00:01.000Z"),
    ];
    const history = [
      message("m1", "assistant", "done", "2026-01-01T00:00:01.000Z"),
    ];

    expect(areMessagesEquivalent(existing, history)).toBe(true);
  });

  it("replaces a partial live run while preserving older loaded messages", () => {
    const existing = [
      message("older-user", "user", "old", "2026-01-01T00:00:00.000Z"),
      message("user-run-1", "user", "ask", "2026-01-01T00:00:01.000Z"),
      message("assistant-live", "assistant", "part", "2026-01-01T00:00:02.000Z"),
    ];
    const history = [
      message("user-run-1", "user", "ask", "2026-01-01T00:00:01.000Z"),
      message("assistant-final", "assistant", "complete", "2026-01-01T00:00:03.000Z"),
    ];

    expect(
      replaceCompletedRunWithHistory(existing, history, "run-1").map((m) => m.id),
    ).toEqual(["older-user", "user-run-1", "assistant-final"]);
  });

  it("keeps live references when Codex history only changes persistence metadata", () => {
    const user = message(
      "msg:codex:run-1:user:user-run-1",
      "user",
      "ask",
      "2026-01-01T00:00:01.000Z",
    );
    const assistant = message(
      "msg:codex:run-1:assistant:item-1",
      "assistant",
      "complete",
      "2026-01-01T00:00:02.000Z",
    );
    const existing = [user, assistant];
    const history = [
      message(user.id, "user", "ask", "2026-01-01T00:00:10.000Z"),
      message(assistant.id, "assistant", "complete", "2026-01-01T00:00:11.000Z"),
    ];

    const reconciled = replaceCompletedRunWithHistory(
      existing,
      history,
      "run-1",
      "codex",
    );

    expect(reconciled).toBe(existing);
    expect(reconciled[0]).toBe(user);
    expect(reconciled[1]).toBe(assistant);
  });

  it("keeps the live Codex content when history has the same item id with different content", () => {
    const user = {
      ...message("item-user-1", "user", "ask", "2026-01-01T00:00:01.000Z"),
      codexTurnId: "turn-1",
    };
    const assistant = message(
      "item-assistant-1",
      "assistant",
      "streamed final answer",
      "2026-01-01T00:00:02.000Z",
    );
    const existing = [user, assistant];
    const history = [
      { ...user },
      message(
        assistant.id,
        "assistant",
        "stale persisted snapshot",
        "2026-01-01T00:00:03.000Z",
      ),
    ];

    const reconciled = replaceCompletedRunWithHistory(
      existing,
      history,
      "run-1",
      "codex",
      "turn-1",
    );

    expect(reconciled).toBe(existing);
    expect(reconciled[1]).toBe(assistant);
    expect(reconciled[1].content).toBe("streamed final answer");
  });

  it("keeps a live tool in place when the completion snapshot is missing it", () => {
    const existing = [
      message("older-user", "user", "old", "2026-01-01T00:00:00.000Z"),
      message("user-run-1", "user", "ask", "2026-01-01T00:00:01.000Z"),
      {
        ...message("live-tool", "tool", "tool output", "2026-01-01T00:00:02.000Z"),
        toolCallId: "call-1",
        toolName: "command_execution",
      },
      message("assistant-live", "assistant", "part", "2026-01-01T00:00:03.000Z"),
    ];
    const history = [
      message("item-u1", "user", "ask", "2026-01-01T00:00:01.000Z"),
      message("assistant-final", "assistant", "complete", "2026-01-01T00:00:03.000Z"),
    ];

    expect(
      replaceCompletedRunWithHistory(existing, history, "run-1", "codex").map(
        (m) => m.id,
      ),
    ).toEqual([
      "older-user",
      "item-u1",
      "live-tool",
      "assistant-final",
    ]);
  });

  it("keeps the final live assistant when the Codex completion snapshot is partial", () => {
    const existing = [
      message("user-run-4", "user", "ask", "2026-01-01T00:00:01.000Z"),
      message("assistant-live-4", "assistant", "the complete final answer", "2026-01-01T00:00:03.000Z"),
    ];
    const history = [
      message("item-u4", "user", "ask", "2026-01-01T00:00:01.000Z"),
    ];

    expect(
      replaceCompletedRunWithHistory(existing, history, "run-4", "codex").map(
        (m) => m.id,
      ),
    ).toEqual([
      "item-u4",
      "assistant-live-4",
    ]);
  });

  it("keeps a live tool when the run anchors by Codex turn id after adoption", () => {
    // After the provider userMessage item adopts the optimistic row, the
    // run boundary is the turn-scoped user row: ids already match history
    // and the turn id anchors the replacement directly.
    const existing = [
      {
        ...message("item-1", "user", "ask", "2026-01-01T00:00:01.000Z"),
        codexTurnId: "turn-2",
      },
      {
        ...message("live-tool-2", "tool", "tool output", "2026-01-01T00:00:02.000Z"),
        toolCallId: "call-2",
        toolName: "command_execution",
      },
      message("assistant-live-2", "assistant", "part", "2026-01-01T00:00:03.000Z"),
    ];
    const history = [
      {
        ...message("item-1", "user", "ask", "2026-01-01T00:00:01.000Z"),
        codexTurnId: "turn-2",
      },
      message("item-2", "assistant", "complete", "2026-01-01T00:00:03.000Z"),
    ];

    expect(
      replaceCompletedRunWithHistory(
        existing,
        history,
        "run-2",
        "codex",
        "turn-2",
      ).map((m) => m.id),
    ).toEqual([
      "item-1",
      "live-tool-2",
      "item-2",
    ]);
  });

  it("anchors a repeated DSH prompt to the latest history user row", () => {
    const existing = [
      message("old-user", "user", "same prompt", "2026-01-01T00:00:00.000Z"),
      message("old-assistant", "assistant", "old answer", "2026-01-01T00:00:01.000Z"),
      message("msg:deepseek-harness:run-2:user:user-run-2", "user", "same prompt", "2026-01-01T00:00:02.000Z"),
      message("live-assistant", "assistant", "current answer", "2026-01-01T00:00:03.000Z"),
    ];
    const history = [
      message("provider-user-1", "user", "same prompt", "2026-01-01T00:00:00.000Z"),
      message("provider-assistant-1", "assistant", "old answer", "2026-01-01T00:00:01.000Z"),
      message("provider-user-2", "user", "same prompt", "2026-01-01T00:00:02.000Z"),
      message("provider-assistant-2", "assistant", "current answer", "2026-01-01T00:00:03.000Z"),
    ];

    expect(
      replaceCompletedRunWithHistory(
        existing,
        history,
        "run-2",
        "deepseek-harness",
      ).map((item) => item.content),
    ).toEqual(["same prompt", "old answer", "same prompt", "current answer"]);
  });

  it("preserves live OpenCode tool display metadata during reconciliation", () => {
    const liveTool = {
      ...message(
        "msg:opencode:run-3:tool:call-3",
        "tool",
        "output",
        "2026-01-01T00:00:02.000Z",
      ),
      toolCallId: "msg:opencode:run-3:tool-call:call-3",
      toolName: "bash",
      toolInput: { command: "pwd", cwd: "/tmp" },
      toolAgentType: "opencode" as const,
      toolDisplay: { summary: "pwd", title: "pwd", kind: "command" as const },
    };
    const existing = [
      message(
        "msg:opencode:run-3:user:user-run-3",
        "user",
        "ask",
        "2026-01-01T00:00:01.000Z",
      ),
      liveTool,
      message("live-assistant-3", "assistant", "part", "2026-01-01T00:00:03.000Z"),
    ];
    const history = [
      message(
        "msg:opencode:run-3:user:user-run-3",
        "user",
        "ask",
        "2026-01-01T00:00:01.000Z",
      ),
      {
        ...message(
          "msg:opencode:run-3:tool:call-3",
          "tool",
          "output",
          "2026-01-01T00:00:02.000Z",
        ),
        toolCallId: "msg:opencode:run-3:tool-call:call-3",
        toolName: "bash",
      },
      message("final-assistant-3", "assistant", "complete", "2026-01-01T00:00:03.000Z"),
    ];

    const reconciled = replaceCompletedRunWithHistory(
      existing,
      history,
      "run-3",
      "opencode",
    );
    const tool = reconciled.find((item) => item.role === "tool");
    expect(tool).toMatchObject({
      toolInput: { command: "pwd", cwd: "/tmp" },
      toolDisplay: { kind: "command", summary: "pwd" },
      toolAgentType: "opencode",
    });
  });
});

describe("message dedup keys (content fingerprint)", () => {
  // Exercise the dedup contract through the public merge API: same content
  // must suppress; different content (even by a single trailing char) must not.
  // These guard the JSON.stringify → contentFingerprint replacement.

  it("suppresses a history assistant reply duplicated by a live one with identical content", () => {
    const history = [
      message("h-1", "assistant", "answer", "2026-01-01T00:00:00.000Z"),
    ];
    const live = [
      message("l-1", "assistant", "answer", "2026-01-01T00:00:00.000Z"),
    ];
    expect(mergeMessagesForThreadRender({ history, live }).map((m) => m.id)).toEqual([
      "h-1",
    ]);
  });

  it("keeps both messages when content differs by one trailing char", () => {
    const history = [
      message("h-1", "assistant", "answer", "2026-01-01T00:00:00.000Z"),
    ];
    const live = [
      message("l-1", "assistant", "answer!", "2026-01-01T00:00:00.000Z"),
    ];
    expect(mergeMessagesForThreadRender({ history, live }).map((m) => m.id)).toEqual([
      "h-1",
      "l-1",
    ]);
  });

  it("keeps both messages when role differs but content matches", () => {
    const history = [
      message("h-1", "assistant", "x", "2026-01-01T00:00:00.000Z"),
    ];
    const live = [
      message("l-1", "reasoning", "x", "2026-01-01T00:00:00.000Z"),
    ];
    expect(mergeMessagesForThreadRender({ history, live }).map((m) => m.id)).toEqual([
      "h-1",
      "l-1",
    ]);
  });

  it("dedupes multi-MB content without timing out (smoke test for fingerprint)", () => {
    const big = "x".repeat(2_000_000);
    const history = [
      message("h-1", "assistant", big, "2026-01-01T00:00:00.000Z"),
    ];
    const live = [
      message("l-1", "assistant", big, "2026-01-01T00:00:00.000Z"),
    ];
    const t0 = Date.now();
    const merged = mergeMessagesForThreadRender({ history, live });
    const elapsed = Date.now() - t0;
    expect(merged.map((m) => m.id)).toEqual(["h-1"]);
    // JSON.stringify over 2MB repeated content would dominate this budget.
    // Fingerprint should stay comfortably under 200ms even on slow CI.
    expect(elapsed).toBeLessThan(2000);
  });
});
