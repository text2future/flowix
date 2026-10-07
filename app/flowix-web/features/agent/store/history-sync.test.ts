import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@/types";
import {
  isOlderHistorySnapshot,
  reconcileHistorySnapshot,
} from "@features/agent/store/history-sync";

function message(id: string, role: ChatMessage["role"], content: string): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp: "2026-08-29T00:00:00.000Z",
  };
}

describe("reconcileHistorySnapshot", () => {
  it("keeps a native Pi message completed after the history read began", () => {
    const user = { ...message("user", "user", "prompt"), messageId: "user" };
    const committed = { ...message("entry:block:0", "assistant", "new answer"), messageId: "entry", renderKey: "draft-key", piBlockIndex: 0 };
    const result = reconcileHistorySnapshot({ agentType: "pi", current: [user, committed], requestProjection: [user], reason: "recovery", snapshot: {
      messages: [user], revision: null, oldestCursor: null, hasMore: false,
    } });
    expect(result.messages.map((row) => row.id)).toEqual(["user", "entry:block:0"]);
    expect(result.messages[1]).toBe(committed);
  });

  it("does not roll back a Pi tool result that advanced during the RPC read", () => {
    const pending = { ...message("call", "tool", ""), messageId: "call", renderKey: "call", isLoading: true };
    const finished = { ...pending, content: "result", isLoading: false };
    const result = reconcileHistorySnapshot({ agentType: "pi", current: [finished], requestProjection: [pending], reason: "recovery", snapshot: {
      messages: [pending], revision: null, oldestCursor: null, hasMore: false,
    } });
    expect(result.messages[0]).toBe(finished);
  });

  it("protects a draft that adopted its native Pi ID during the request", () => {
    const draft = { ...message("draft:run:assistant:1", "assistant", "partial"), messageId: null, renderKey: "stable" };
    const committed = { ...draft, id: "native:block:0", messageId: "native", content: "complete", piBlockIndex: 0 };
    const result = reconcileHistorySnapshot({ agentType: "pi", current: [committed], requestProjection: [draft], reason: "recovery", snapshot: {
      messages: [], revision: null, oldestCursor: null, hasMore: false,
    } });
    expect(result.messages[0]).toBe(committed);
  });

  it("removes the old branch tail from a latest Pi page while keeping the loaded prefix", () => {
    const prefix = { ...message("older", "user", "earlier page"), messageId: "older" };
    const anchor = { ...message("user", "user", "prompt"), messageId: "user" };
    const old = { ...message("old", "assistant", "old branch"), messageId: "old" };
    const next = { ...message("new", "assistant", "new branch"), messageId: "new" };
    const draft = { ...message("draft", "assistant", "pending"), messageId: null };
    const result = reconcileHistorySnapshot({ agentType: "pi", current: [prefix, anchor, old, draft], reason: "recovery", snapshot: {
      messages: [anchor, next], revision: null, oldestCursor: 100, hasMore: true,
    } });
    expect(result.messages.map((row) => row.id)).toEqual(["older", "user", "new", "draft"]);
  });

  it("recovers a finished Pi tool while preserving its render key", () => {
    const current = [{ ...message("call", "tool", ""), messageId: "call", renderKey: "stable", isLoading: true }];
    const result = reconcileHistorySnapshot({ agentType: "pi", current, reason: "recovery", snapshot: {
      messages: [{ ...message("call", "tool", "finished"), messageId: "call", isLoading: false, isCompleted: true }],
      revision: null, oldestCursor: null, hasMore: false,
    } });
    expect(result.messages[0]).toMatchObject({ content: "finished", isLoading: false, isCompleted: true, renderKey: "stable" });
  });

  it("replaces an abandoned Pi branch but keeps an uncommitted draft", () => {
    const user = { ...message("user", "user", "prompt"), messageId: "user" };
    const old = { ...message("old", "assistant", "old branch"), messageId: "old" };
    const draft = { ...message("draft:run:assistant:1", "assistant", "pending"), messageId: null };
    const result = reconcileHistorySnapshot({ agentType: "pi", current: [user, old, draft], reason: "recovery", snapshot: {
      messages: [user, { ...message("new", "assistant", "new branch"), messageId: "new" }],
      revision: null, oldestCursor: null, hasMore: false,
    } });
    expect(result.messages.map((row) => row.id)).toEqual(["user", "new", draft.id]);
  });

  it("preserves a loaded prefix for a paged Pi snapshot", () => {
    const prefix = { ...message("prefix", "user", "older"), messageId: "prefix" };
    const tail = { ...message("tail", "assistant", "answer"), messageId: "tail" };
    const result = reconcileHistorySnapshot({ agentType: "pi", current: [prefix, tail], reason: "open", snapshot: {
      messages: [tail], revision: null, oldestCursor: 1, hasMore: true,
    } });
    expect(result.messages).toEqual([prefix, tail]);
  });

  it("rejects only an older comparable sequence revision", () => {
    expect(isOlderHistorySnapshot(12, 11)).toBe(true);
    expect(isOlderHistorySnapshot(12, 12)).toBe(false);
    expect(isOlderHistorySnapshot(12, 13)).toBe(false);
    expect(isOlderHistorySnapshot(12, null)).toBe(false);
  });

  it("preserves the complete message array when an open snapshot renders identically", () => {
    const current = [message("u1", "user", "hello"), message("a1", "assistant", "hi")];
    const result = reconcileHistorySnapshot({
      agentType: "codex",
      current,
      snapshot: {
        messages: current.map((item) => ({ ...item })),
        revision: "sequence:1",
        oldestCursor: null,
        hasMore: false,
      },
      reason: "open",
    });

    expect(result.renderChanged).toBe(false);
    expect(result.messages).toBe(current);
  });

  it("adds a genuinely missing persisted row without replacing unaffected rows", () => {
    const user = message("u1", "user", "hello");
    const current = [user];
    const result = reconcileHistorySnapshot({
      agentType: "codex",
      current,
      snapshot: {
        messages: [
          { ...user },
          message("a1", "assistant", "persisted answer"),
        ],
        revision: "sequence:1",
        oldestCursor: null,
        hasMore: false,
      },
      reason: "recovery",
    });

    expect(result.renderChanged).toBe(true);
    expect(result.messages[0]).toBe(user);
    expect(result.messages.map((item) => item.id)).toEqual(["u1", "a1"]);
  });
});
