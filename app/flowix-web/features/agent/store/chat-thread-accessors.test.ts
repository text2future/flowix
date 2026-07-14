import { describe, expect, it } from "vitest";
import {
  activeThreadUpdate,
  getActiveThreadIdForType,
  getCurrentTitleForType,
  getThreadListForType,
  threadListUpdate,
  titleUpdate,
} from "@features/agent/store/chat-thread-accessors";
import type { ChatStoreShape } from "@features/agent/store/chat-thread-accessors";

const emptyState: ChatStoreShape = {
  activeThreadIds: {},
  currentThreadTitles: {},
  threadLists: {},
};

describe("chat-thread-accessors helpers", () => {
  it("activeThreadUpdate patches one key without mutating input", () => {
    const next = activeThreadUpdate(emptyState, "codex", "thread-1");
    expect(next.activeThreadIds?.codex).toBe("thread-1");
    expect(emptyState.activeThreadIds.codex).toBeUndefined();
  });

  it("activeThreadUpdate supports clearing to undefined", () => {
    const withActive: ChatStoreShape = {
      activeThreadIds: { codex: "thread-1" },
      currentThreadTitles: {},
      threadLists: {},
    };
    const next = activeThreadUpdate(withActive, "codex", undefined);
    expect(next.activeThreadIds?.codex).toBeUndefined();
  });

  it("threadListUpdate replaces only one agent's list", () => {
    const next = threadListUpdate(emptyState, "flowix", [
      { threadId: "t1", title: "T1", createdAt: 1, updatedAt: 1 },
    ]);
    expect(next.threadLists?.flowix).toEqual([
      { threadId: "t1", title: "T1", createdAt: 1, updatedAt: 1 },
    ]);
    expect(next.threadLists?.codex).toBeUndefined();
  });

  it("threadListUpdate preserves unrelated entries", () => {
    const withFlowix: ChatStoreShape = {
      ...emptyState,
      threadLists: { flowix: [{ threadId: "t1", title: "T1", createdAt: 1, updatedAt: 1 }] },
    };
    const next = threadListUpdate(withFlowix, "codex", []);
    expect(next.threadLists?.flowix).toHaveLength(1);
    expect(next.threadLists?.codex).toEqual([]);
  });

  it("titleUpdate sets / clears one agent's in-memory title", () => {
    const next = titleUpdate(emptyState, "claude", "draft title");
    expect(next.currentThreadTitles?.claude).toBe("draft title");
    const cleared = titleUpdate(
      { ...emptyState, currentThreadTitles: { claude: "draft title" } },
      "claude",
      undefined,
    );
    expect(cleared.currentThreadTitles?.claude).toBeUndefined();
  });

  it("getters return undefined / [] for unknown keys without throwing", () => {
    expect(getActiveThreadIdForType(emptyState, "codex")).toBeUndefined();
    expect(getThreadListForType(emptyState, "flowix")).toEqual([]);
    expect(getCurrentTitleForType(emptyState, "claude")).toBeUndefined();
  });
});