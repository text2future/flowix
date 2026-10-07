import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/types";
import type { ThreadHistoryPage } from "./agent-history-adapters";
import type { ProjectionSlice } from "./projection-slice";
import { emptyProjection } from "./session-reducer";
import { createThreadHistorySlice, type ThreadHistorySlice } from "./thread-history-slice";
import { PiHistorySnapshotChangedError } from "./pi-message-reconciliation";

const adapter = vi.hoisted(() => ({ getInitialHistory: vi.fn(), getFullHistory: vi.fn(), getPage: vi.fn() }));
vi.mock("./agent-history-adapters", () => ({ getAgentHistoryAdapter: () => adapter }));

function row(id: string): ChatMessage {
  return { id, messageId: id, renderKey: id, role: "assistant", content: id, timestamp: "2026-01-01T00:00:00Z" };
}
function page(messages: ChatMessage[], leafId: string): ThreadHistoryPage {
  return { messages, hasMore: false, oldestSequence: 0, snapshotSequence: messages.length,
    piRevision: { sessionId: "native-session", appendCursor: leafId, leafId } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function store(messages: ChatMessage[]) {
  type Context = ProjectionSlice & ThreadHistorySlice;
  let state: Context;
  const set: Parameters<typeof createThreadHistorySlice>[0] = (updater) => { state = { ...state, ...updater(state) }; };
  state = {
    ...createThreadHistorySlice(set, () => state),
    threadProjections: { thread: { ...emptyProjection(), messages } },
    threadEpochs: {}, threadTombstones: {}, codexLiveTurns: {},
    threadRunSignatures: {}, latestCompletedRunIds: {}, readThroughRunIds: {}, runStateVersion: 0,
    clearCodexLiveTurn: vi.fn(), dispatch: vi.fn(), removeThreadProjection: vi.fn(),
    resetThreadProjections: vi.fn(), activateThread: vi.fn(), invalidateThread: vi.fn(),
    applySessionResolved: vi.fn(), markThreadRead: vi.fn(),
    setThreadProjection: (id, updater) => {
      state = { ...state, threadProjections: { ...state.threadProjections, [id]: updater(state.threadProjections[id] ?? emptyProjection()) } };
    },
  };
  return () => state;
}

describe("Pi history request fences", () => {
  beforeEach(() => { adapter.getInitialHistory.mockReset(); adapter.getFullHistory.mockReset(); adapter.getPage.mockReset(); });

  it("loads older Pi turns with the backend native cursor and revision", async () => {
    const get = store([row("u2"), row("a2")]);
    const revision = { sessionId: "native-session", appendCursor: "a2", leafId: "a2" };
    get().setThreadProjection("thread", (projection) => ({ ...projection, pagination: {
      ...projection.pagination, oldestSequence: 3, snapshotSequence: 5, piRevision: revision,
      piBeforeEntryId: "u2", hasMoreHistory: true,
    } }));
    adapter.getPage.mockResolvedValueOnce({ messages: [row("u1"), row("a1")], oldestSequence: 0, snapshotSequence: 5,
      piRevision: revision, piBeforeEntryId: "u1", hasMore: false });
    await get().loadMoreMessages("pi", "thread");
    expect(adapter.getPage).toHaveBeenCalledWith("thread", 3, 10, 5, revision, "u2");
    expect(get().threadProjections.thread.messages.map((item) => item.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(get().threadProjections.thread.pagination.piBeforeEntryId).toBe("u1");
    expect(get().threadProjections.thread.pagination.hasMoreHistory).toBe(false);
  });

  it("refreshes onto Pi's current native snapshot when a pinned page expires", async () => {
    const user = row("user");
    const get = store([user, row("old-leaf")]);
    const oldRevision = { sessionId: "native-session", appendCursor: "old-leaf", leafId: "old-leaf" };
    get().setThreadProjection("thread", (projection) => ({ ...projection, pagination: {
      ...projection.pagination, oldestSequence: 1, snapshotSequence: 2, piRevision: oldRevision,
      piBeforeEntryId: "user", hasMoreHistory: true,
    } }));
    adapter.getPage.mockRejectedValueOnce(new PiHistorySnapshotChangedError());
    adapter.getInitialHistory.mockResolvedValueOnce({
      messages: [user, row("new-leaf")], oldestSequence: 0, snapshotSequence: 2, hasMore: false,
      piRevision: { sessionId: "native-session", appendCursor: "new-leaf", leafId: "new-leaf" },
    });
    await get().loadMoreMessages("pi", "thread");
    expect(adapter.getInitialHistory).toHaveBeenCalledWith("thread", 10);
    expect(get().threadProjections.thread.messages.map((item) => item.id)).toEqual(["user", "new-leaf"]);
    expect(get().threadProjections.thread.pagination.piRevision?.leafId).toBe("new-leaf");
  });

  it("also protects newly committed messages during a full Pi reload", async () => {
    const old = row("old");
    const get = store([old]);
    const pending = deferred<ChatMessage[]>();
    adapter.getFullHistory.mockReturnValueOnce(pending.promise);
    const loading = get().reloadMessagesFromHistory("pi", "thread");
    get().syncRenderableMessages("pi", "thread", [old, row("fresh")]);
    pending.resolve([old]);
    await loading;
    expect(get().threadProjections.thread.messages.map((item) => item.id)).toEqual(["old", "fresh"]);
  });

  it("preserves a native message committed while the history request is pending", async () => {
    const old = row("old");
    const get = store([old]);
    const pending = deferred<ThreadHistoryPage>();
    adapter.getInitialHistory.mockReturnValueOnce(pending.promise);
    const loading = get().loadMessages("pi", "thread");
    const fresh = row("fresh");
    get().syncRenderableMessages("pi", "thread", [old, fresh]);
    pending.resolve(page([old], "old"));
    await loading;
    expect(get().threadProjections.thread.messages.map((item) => item.id)).toEqual(["old", "fresh"]);
  });

  it("rejects an older request response even when both native branches have equal row counts", async () => {
    const user = row("user");
    const get = store([user]);
    const first = deferred<ThreadHistoryPage>();
    const second = deferred<ThreadHistoryPage>();
    adapter.getInitialHistory.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const olderRequest = get().loadMessages("pi", "thread");
    const newerRequest = get().loadMessages("pi", "thread");
    second.resolve(page([user, row("branch-b")], "branch-b"));
    await newerRequest;
    first.resolve(page([user, row("branch-a")], "branch-a"));
    await olderRequest;
    expect(get().threadProjections.thread.messages.map((item) => item.id)).toEqual(["user", "branch-b"]);
    expect(get().threadProjections.thread.pagination.piRevision?.leafId).toBe("branch-b");
  });
});
