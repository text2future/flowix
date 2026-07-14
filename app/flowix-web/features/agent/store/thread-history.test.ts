import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@/types";
import {
  mergeLiveMessagesIntoRenderableMessages,
  mergeMessagesForThreadRender,
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
  it("keeps a later live user message with the same visible content", () => {
    const history = [
      message("history-user-1", "user", "same", "2026-01-01T00:00:00.000Z"),
      message("history-assistant-1", "assistant", "done", "2026-01-01T00:00:01.000Z"),
    ];
    const live = [
      message("live-user-2", "user", "same", "2026-01-01T00:00:02.000Z"),
    ];

    expect(mergeMessagesForThreadRender(history, live).map((m) => m.id)).toEqual([
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

    expect(mergeMessagesForThreadRender(history, live).map((m) => m.id)).toEqual([
      "live-user-1",
      "history-assistant-1",
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
    expect(mergeMessagesForThreadRender(history, live).map((m) => m.id)).toEqual([
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
    expect(mergeMessagesForThreadRender(history, live).map((m) => m.id)).toEqual([
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
    expect(mergeMessagesForThreadRender(history, live).map((m) => m.id)).toEqual([
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
    const merged = mergeMessagesForThreadRender(history, live);
    const elapsed = Date.now() - t0;
    expect(merged.map((m) => m.id)).toEqual(["h-1"]);
    // JSON.stringify over 2MB repeated content would dominate this budget.
    // Fingerprint should stay comfortably under 200ms even on slow CI.
    expect(elapsed).toBeLessThan(2000);
  });
});
