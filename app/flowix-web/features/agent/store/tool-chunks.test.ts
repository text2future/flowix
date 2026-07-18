import { describe, expect, it } from "vitest";

import {
  applyToolCallChunk,
  applyToolResultChunk,
} from "@features/agent/store/tool-chunks";
import type { LiveMessageState } from "@features/agent/store/chunk-result";

function emptyState(): LiveMessageState {
  return {
    messages: [],
    pendingAssistantId: null,
    pendingReasoningId: null,
  };
}

describe("tool chunk idempotency", () => {
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
});
