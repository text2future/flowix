import { describe, expect, it } from "vitest";

import {
  applyReasoningChunk,
  applyTextChunk,
  applyUserMessageChunk,
} from "@features/agent/store/message-chunks";
import { applyToolCallChunk } from "@features/agent/store/tool-chunks";
import type { MessageProjection } from "@features/agent/store/session-reducer/types";

function emptyState(): MessageProjection {
  return {
    messages: [],
    pending: { assistantId: null, reasoningId: null },
  };
}

describe("assistant message chunks", () => {
  it("keeps a run-scoped render key while adopting native Pi message identity", () => {
    const draft = applyTextChunk(emptyState(), "answer", {
      draftScope: "run-pi-1", adoptPendingId: true, contentMode: "delta",
    });
    const key = draft.messages[0].renderKey;
    expect(key).toMatch(/^draft:run-pi-1:assistant:/);
    expect(draft.messages[0].messageId).toBeNull();
    const completed = applyTextChunk(draft, "answer", {
      id: "native-entry-1", adoptPendingId: true, phase: "completed", contentMode: "snapshot",
    });
    expect(completed.messages[0]).toMatchObject({
      id: "native-entry-1", messageId: "native-entry-1", renderKey: key, isCompleted: true,
    });
    const duplicate = applyTextChunk(completed, "answer", {
      id: "native-entry-1", adoptPendingId: true, phase: "completed", contentMode: "snapshot",
    });
    expect(duplicate.messages).toBe(completed.messages);
    const nextDraft = applyTextChunk(completed, "answer", {
      draftScope: "run-pi-1", adoptPendingId: true, contentMode: "delta",
    });
    expect(nextDraft.messages).toHaveLength(2);
    expect(nextDraft.messages[1].renderKey).not.toBe(key);
    expect(nextDraft.messages[1].messageId).toBeNull();
  });

  it("preserves the Codex turn id when the first chunk has a message id", () => {
    const result = applyTextChunk(emptyState(), "answer", {
      id: "assistant-item-1",
      phase: "completed",
      contentMode: "snapshot",
      codexTurnId: "turn-1",
    });

    expect(result.messages[0]).toMatchObject({
      id: "assistant-item-1",
      role: "assistant",
      codexTurnId: "turn-1",
    });
  });

  it("keeps every reference intact when a completed snapshot repeats streamed content", () => {
    const streamed = applyTextChunk(emptyState(), "final", {
      id: "assistant-item-1",
      codexTurnId: "turn-1",
    });
    const duplicate = applyTextChunk(streamed, "final", {
      id: "assistant-item-1",
      phase: "completed",
      contentMode: "snapshot",
      codexTurnId: "turn-1",
    });

    expect(duplicate.messages).toBe(streamed.messages);
    expect(duplicate.pending.assistantId).toBeNull();
  });

  it("applies commentary classification when the completed snapshot arrives", () => {
    const streamed = applyTextChunk(emptyState(), "progress", {
      id: "assistant-item-1",
      codexTurnId: "turn-1",
    });
    const completed = applyTextChunk(streamed, "progress", {
      id: "assistant-item-1",
      phase: "completed",
      contentMode: "snapshot",
      codexTurnId: "turn-1",
      messageType: "agent-commentary",
    });

    expect(completed.messages[0].messageType).toBe("agent-commentary");
    expect(completed.pending.assistantId).toBeNull();
  });

  it("adopts the Codex provider id when the streamed delta had no item id", () => {
    const streamed = applyTextChunk(emptyState(), "answer", {
      phase: "updated",
      contentMode: "delta",
      codexTurnId: "turn-1",
    });
    const completed = applyTextChunk(streamed, "answer", {
      id: "assistant-item-1",
      phase: "completed",
      contentMode: "snapshot",
      codexTurnId: "turn-1",
    });

    expect(completed.messages).toHaveLength(1);
    expect(completed.messages[0]).toMatchObject({
      id: "assistant-item-1",
      content: "answer",
      codexTurnId: "turn-1",
    });
    expect(completed.pending.assistantId).toBeNull();
  });

  it("adopts the Pi session entry id when the streamed delta had no id", () => {
    const streamed = applyTextChunk(emptyState(), "answer", {
      phase: "updated",
      contentMode: "delta",
    });
    const completed = applyTextChunk(streamed, "answer", {
      id: "67575cb5",
      phase: "completed",
      contentMode: "snapshot",
    });

    expect(completed.messages).toHaveLength(1);
    expect(completed.messages[0]).toMatchObject({
      id: "67575cb5",
      content: "answer",
    });
    expect(completed.pending.assistantId).toBeNull();
  });

  it("keeps Pi block-end snapshots pending until the message-end entry id arrives", () => {
    const blockEnded = applyTextChunk(emptyState(), "answer", {
      phase: "updated",
      contentMode: "snapshot",
    });
    expect(blockEnded.pending.assistantId).not.toBeNull();

    const messageEnded = applyTextChunk(blockEnded, "answer", {
      id: "pi-entry-1",
      phase: "completed",
      contentMode: "snapshot",
    });

    expect(messageEnded.messages).toHaveLength(1);
    expect(messageEnded.messages[0]).toMatchObject({
      id: "pi-entry-1",
      content: "answer",
    });
    expect(messageEnded.pending.assistantId).toBeNull();
  });

  it("lets the Pi message lifecycle reconcile an authoritative changed snapshot", () => {
    const draft = applyTextChunk(emptyState(), "partial answer", {
      phase: "updated",
      contentMode: "snapshot",
    });
    const committed = applyTextChunk(draft, "final answer", {
      id: "pi-entry-final",
      phase: "completed",
      contentMode: "snapshot",
      adoptPendingId: true,
    });

    expect(committed.messages).toHaveLength(1);
    expect(committed.messages[0]).toMatchObject({
      id: "pi-entry-final",
      content: "final answer",
    });
  });

  it("keeps pre-tool Pi text under the native assistant entry id", () => {
    const draft = applyTextChunk(emptyState(), "I will inspect the file.", {
      contentMode: "delta",
    });
    const completed = applyTextChunk(draft, "I will inspect the file.", {
      id: "pi-assistant-entry",
      phase: "completed",
      contentMode: "snapshot",
      adoptPendingId: true,
    });
    const withTool = applyToolCallChunk(
      completed,
      "pi-tool-call",
      "read",
      { path: "README.md" },
      "pi",
      {
        id: "pi-tool-call",
        parentMessageId: "pi-assistant-entry",
        sourceSequence: 3,
        sourceSubsequence: 1,
      },
    );

    expect(withTool.messages).toHaveLength(2);
    expect(withTool.messages[0]).toMatchObject({
      id: "pi-assistant-entry",
      role: "assistant",
      content: "I will inspect the file.",
    });
    expect(withTool.messages[1]).toMatchObject({
      id: "pi-tool-call",
      role: "tool",
      toolCallId: "pi-tool-call",
      parentMessageId: "pi-assistant-entry",
    });
  });

  it("does not collapse distinct Codex item ids with identical text", () => {
    const first = applyTextChunk(emptyState(), "answer", {
      id: "assistant-item-1",
      phase: "completed",
      contentMode: "snapshot",
      codexTurnId: "turn-1",
    });
    const second = applyTextChunk(first, "answer", {
      id: "assistant-item-2",
      phase: "completed",
      contentMode: "snapshot",
      codexTurnId: "turn-1",
    });

    expect(second.messages).toHaveLength(2);
    expect(second.messages.map((message) => message.id)).toEqual([
      "assistant-item-1",
      "assistant-item-2",
    ]);
  });

  it("does not let a mismatched Codex snapshot overwrite the pending row", () => {
    const streamed = applyTextChunk(emptyState(), "first answer", {
      phase: "updated",
      contentMode: "delta",
      codexTurnId: "turn-1",
    });
    const completed = applyTextChunk(streamed, "second answer", {
      id: "assistant-item-2",
      phase: "completed",
      contentMode: "snapshot",
      codexTurnId: "turn-1",
    });

    expect(completed.messages).toHaveLength(2);
    expect(completed.messages.map((message) => message.content)).toEqual([
      "first answer",
      "second answer",
    ]);
  });

  it("keeps every reference intact when a completed reasoning snapshot repeats itself", () => {
    const streamed = applyReasoningChunk(emptyState(), "plan", {
      id: "reasoning-item-1",
      phase: "completed",
      codexTurnId: "turn-1",
    });
    const duplicate = applyReasoningChunk(streamed, "plan", {
      id: "reasoning-item-1",
      phase: "completed",
      contentMode: "snapshot",
      codexTurnId: "turn-1",
    });

    expect(duplicate.messages).toBe(streamed.messages);
    expect(duplicate.pending.reasoningId).toBeNull();
  });

  it("adopts closed Pi thinking after text starts without duplicating the draft", () => {
    const metadata = { adoptPendingId: true, draftScope: "run" };
    const thinking = applyReasoningChunk(emptyState(), "plan", metadata);
    const key = thinking.messages[0].renderKey;
    const text = applyTextChunk(thinking, "answer", metadata);
    expect(text.pending.reasoningId).toBeNull();
    const committed = applyReasoningChunk(text, "final plan", {
      ...metadata, id: "entry", contentMode: "snapshot", phase: "completed",
    });
    expect(committed.messages).toHaveLength(2);
    expect(committed.messages[0]).toMatchObject({ messageId: "entry", renderKey: key, content: "final plan" });
    const duplicate = applyReasoningChunk(committed, "final plan", {
      ...metadata, id: "entry", contentMode: "snapshot", phase: "completed",
    });
    expect(duplicate.messages).toBe(committed.messages);
  });

  it("adopts a Pi reasoning draft after thinking_end completes only its block", () => {
    const blockEnded = applyReasoningChunk(emptyState(), "plan", {
      phase: "updated",
      contentMode: "snapshot",
    });
    expect(blockEnded.pending.reasoningId).not.toBeNull();
    expect(blockEnded.messages[0].isCompleted).toBe(false);

    const messageEnded = applyReasoningChunk(blockEnded, "plan", {
      id: "pi-entry-2",
      phase: "completed",
      contentMode: "snapshot",
    });

    expect(messageEnded.messages).toHaveLength(1);
    expect(messageEnded.messages[0]).toMatchObject({
      id: "pi-entry-2",
      role: "reasoning",
      isCompleted: true,
    });
    expect(messageEnded.pending.reasoningId).toBeNull();
  });

  it("reconciles a changed Pi reasoning snapshot using message lifecycle", () => {
    const draft = applyReasoningChunk(emptyState(), "partial plan", {
      phase: "updated",
      contentMode: "snapshot",
    });
    const committed = applyReasoningChunk(draft, "final plan", {
      id: "pi-entry-thinking",
      phase: "completed",
      contentMode: "snapshot",
      adoptPendingId: true,
    });

    expect(committed.messages).toHaveLength(1);
    expect(committed.messages[0]).toMatchObject({
      id: "pi-entry-thinking",
      role: "reasoning",
      content: "final plan",
      isCompleted: true,
    });
  });
});

describe("user message chunks", () => {
  it("adopts the Pi session entry id on the optimistic user row", () => {
    const optimisticId = "user-run-1";
    const optimistic = applyUserMessageChunk(emptyState(), "second prompt", {
      id: optimisticId,
      phase: "completed",
    });
    const providerBacked = applyUserMessageChunk(optimistic, "second prompt", {
      id: "a58b853d",
      phase: "completed",
      optimisticId,
    });

    expect(providerBacked.messages).toHaveLength(1);
    expect(providerBacked.messages[0]).toMatchObject({
      id: "a58b853d",
      role: "user",
      content: "second prompt",
    });
  });

  const optimisticRow = {
    id: "user-run-1",
    role: "user" as const,
    content: "ask",
    timestamp: "2026-01-01T00:00:01.000Z",
  };

  it("adopts the provider item id in place instead of appending a second row", () => {
    const state: MessageProjection = {
      messages: [optimisticRow],
      pending: { assistantId: null, reasoningId: null },
    };
    const result = applyUserMessageChunk(state, "ask", {
      id: "item-u1",
      phase: "completed",
      contentMode: "snapshot",
      codexTurnId: "turn-1",
      optimisticId: "user-run-1",
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      id: "item-u1",
      role: "user",
      codexTurnId: "turn-1",
      content: "ask",
    });
  });

  it("appends when no optimistic row exists for the run", () => {
    const result = applyUserMessageChunk(emptyState(), "ask", {
      id: "item-u1",
      phase: "completed",
      contentMode: "snapshot",
      codexTurnId: "turn-1",
      optimisticId: "user-run-1",
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe("item-u1");
  });

  it("adopts by the newest matching optimistic row when run ids race", () => {
    const state: MessageProjection = {
      messages: [
        { ...optimisticRow, id: "user-run-older", content: "same" },
        { ...optimisticRow, id: "user-run-current", content: "ask" },
      ],
      pending: { assistantId: null, reasoningId: null },
    };
    const result = applyUserMessageChunk(state, "ask", {
      id: "item-u-current",
      codexTurnId: "turn-current",
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toMatchObject({
      id: "item-u-current",
      content: "ask",
      codexTurnId: "turn-current",
    });
  });

  it("keeps provider attachments when adopting a matching optimistic row", () => {
    const attachments = [{
      type: "input_image" as const,
      path: "/tmp/provider.png",
      name: "provider.png",
      mimeType: "image/png",
      detail: "high" as const,
    }];
    const result = applyUserMessageChunk(
      {
        messages: [{ ...optimisticRow, content: "ask" }],
        pending: { assistantId: null, reasoningId: null },
      },
      "ask",
      {
        id: "item-u1",
        codexTurnId: "turn-1",
        attachments,
      },
    );

    expect(result.messages[0].attachments).toEqual(attachments);
  });

  it("never adopts without the provider turn id", () => {
    const state: MessageProjection = {
      messages: [optimisticRow],
      pending: { assistantId: null, reasoningId: null },
    };
    const result = applyUserMessageChunk(state, "ask again", {
      id: "user-run-1",
      phase: "completed",
      contentMode: "snapshot",
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      id: "user-run-1",
      content: "ask again",
    });
  });

  it("keeps DSH goal notices out of the human user bubble", () => {
    const state: MessageProjection = {
      messages: [optimisticRow],
      pending: { assistantId: null, reasoningId: null },
    };
    const result = applyUserMessageChunk(state, "目标执行中：在吗（第 1/256 轮）", {
      id: "goal-round-1",
      messageType: "goal-round",
      codexTurnId: "turn-1",
      optimisticId: "user-run-1",
      phase: "completed",
      contentMode: "snapshot",
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toBe(optimisticRow);
    expect(result.messages[1]).toMatchObject({
      id: "goal-round-1",
      role: "system",
      messageType: "goal-round",
      content: "目标执行中：在吗（第 1/256 轮）",
    });
  });
});
