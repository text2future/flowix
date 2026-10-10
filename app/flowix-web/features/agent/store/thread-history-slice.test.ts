import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/types";
import { attachHistoryCursor, HistoryChangedError, type ThreadHistoryPage } from "./agent-history-adapters";
import type { ProjectionSlice } from "./projection-slice";
import { emptyProjection } from "./session-reducer";
import { createThreadHistorySlice, type ThreadHistorySlice } from "./thread-history-slice";
import { DEFAULT_AGENT_SESSION_META } from "./session-state";

const adapter = vi.hoisted(() => ({ getInitialHistory: vi.fn(), getFullHistory: vi.fn(), getPage: vi.fn() }));
vi.mock("./agent-history-adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-history-adapters")>()),
  getAgentHistoryAdapter: () => adapter,
}));

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
  type Context = ProjectionSlice & ThreadHistorySlice & {
    sessionMeta: typeof DEFAULT_AGENT_SESSION_META;
  };
  let state: Context;
  state = {
    ...createThreadHistorySlice(() => state),
    sessionMeta: { ...DEFAULT_AGENT_SESSION_META, threadTypes: { thread: "claude" }, externalSessionResolutions: { thread: "native-a" } },
    threadProjections: { thread: { ...emptyProjection(), messages } },
    threadEpochs: {}, threadTombstones: {}, threadMutationGuards: {}, codexLiveTurns: {},
    threadRunSignatures: {}, latestCompletedRunIds: {}, readThroughRunIds: {}, runStateVersion: 0,
    clearCodexLiveTurn: vi.fn(), dispatch: vi.fn(), removeThreadProjection: vi.fn(),
    resetThreadProjections: vi.fn(), activateThread: vi.fn(), invalidateThread: vi.fn(),
    setThreadMutationGuard: vi.fn(),
    updateThreadHistory: (id, updater) => {
      const current = state.threadProjections[id] ?? emptyProjection();
      const history = updater(current);
      state = { ...state, threadProjections: { ...state.threadProjections,
        [id]: { ...current, messages: history.messages, pagination: history.pagination } } };
    },
    updateThreadRuns: vi.fn(), clearThreadPending: vi.fn(),
    appendTransientCommandResult: vi.fn(),
    applySessionResolved: vi.fn(), markThreadRead: vi.fn(),
  };
  return () => state;
}

describe("Pi history request fences", () => {
  beforeEach(() => { adapter.getInitialHistory.mockReset(); adapter.getFullHistory.mockReset(); adapter.getPage.mockReset(); });

  it("loads older Pi turns with the backend native cursor and revision", async () => {
    const get = store([row("u2"), row("a2")]);
    const revision = { sessionId: "native-session", appendCursor: "a2", leafId: "a2" };
    get().updateThreadHistory("thread", (projection) => ({ ...projection, pagination: {
      ...projection.pagination, oldestSequence: 3, snapshotSequence: 5,
      nextCursor: attachHistoryCursor("pi", "thread", { messages: [row("u2")], oldestSequence: 3,
        snapshotSequence: 5, piRevision: revision, piBeforeEntryId: "u2", hasMore: true }).nextCursor,
      hasMoreHistory: true,
    } }));
    adapter.getPage.mockResolvedValueOnce({ messages: [row("u1"), row("a1")], oldestSequence: 0, snapshotSequence: 5,
      piRevision: revision, piBeforeEntryId: "u1", hasMore: false });
    await get().loadMoreMessages("pi", "thread");
    expect(adapter.getPage).toHaveBeenCalledWith("thread", 3, 10, 5, revision, "u2");
    expect(get().threadProjections.thread.messages.map((item) => item.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(get().threadProjections.thread.pagination.nextCursor).toBeUndefined();
    expect(get().threadProjections.thread.pagination.hasMoreHistory).toBe(false);
  });

  it("refreshes onto Pi's current native snapshot when a pinned page expires", async () => {
    const user = row("user");
    const get = store([user, row("old-leaf")]);
    const oldRevision = { sessionId: "native-session", appendCursor: "old-leaf", leafId: "old-leaf" };
    get().updateThreadHistory("thread", (projection) => ({ ...projection, pagination: {
      ...projection.pagination, oldestSequence: 1, snapshotSequence: 2,
      nextCursor: attachHistoryCursor("pi", "thread", { messages: [user], oldestSequence: 1,
        snapshotSequence: 2, piRevision: oldRevision, piBeforeEntryId: "user", hasMore: true }).nextCursor,
      hasMoreHistory: true,
    } }));
    adapter.getPage.mockRejectedValueOnce(new HistoryChangedError());
    adapter.getInitialHistory.mockResolvedValueOnce({
      messages: [user, row("new-leaf")], oldestSequence: 0, snapshotSequence: 2, hasMore: false,
      piRevision: { sessionId: "native-session", appendCursor: "new-leaf", leafId: "new-leaf" },
    });
    await get().loadMoreMessages("pi", "thread");
    expect(adapter.getInitialHistory).toHaveBeenCalledWith("thread", 10);
    expect(get().threadProjections.thread.messages.map((item) => item.id)).toEqual(["user", "new-leaf"]);
    expect(get().threadProjections.thread.pagination.nextCursor).toBeUndefined();
  });

  it("also protects newly committed messages during a full Pi reload", async () => {
    const old = row("old");
    const get = store([old]);
    const pending = deferred<ChatMessage[]>();
    adapter.getFullHistory.mockReturnValueOnce(pending.promise);
    const loading = get().reloadMessagesFromHistory("pi", "thread");
    get().updateThreadHistory("thread", (projection) => ({ ...projection, messages: [old, row("fresh")] }));
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
    get().updateThreadHistory("thread", (projection) => ({ ...projection, messages: [old, fresh] }));
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
    expect(get().threadProjections.thread.pagination.nextCursor).toBeUndefined();
  });
});

describe("history binding request fences", () => {
  beforeEach(() => { adapter.getInitialHistory.mockReset(); adapter.getFullHistory.mockReset(); adapter.getPage.mockReset(); });

  it("discards an initial history response from a replaced native session", async () => {
    const get = store([row("visible")]);
    const pending = deferred<ThreadHistoryPage>();
    adapter.getInitialHistory.mockReturnValueOnce(pending.promise);
    const loading = get().loadMessages("claude", "thread");
    get().sessionMeta.externalSessionResolutions.thread = "native-b";
    pending.resolve(page([row("stale")], "stale"));
    await loading;
    expect(get().threadProjections.thread.messages.map((item) => item.id)).toEqual(["visible"]);
  });

  it("allows a fresh request after the native session changes while the first request is pending", async () => {
    const get = store([]);
    const stale = deferred<ThreadHistoryPage>();
    adapter.getInitialHistory.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(page([row("fresh")], "fresh"));
    const oldLoad = get().loadMessages("claude", "thread");
    get().sessionMeta.externalSessionResolutions.thread = "native-b";
    await get().loadMessages("claude", "thread");
    stale.resolve(page([row("stale")], "stale"));
    await oldLoad;
    expect(get().threadProjections.thread.messages.map((item) => item.id)).toEqual(["fresh"]);
    expect(get().threadProjections.thread.pagination.loadingInitial).toBe(false);
  });

  it("coalesces duplicate initial reads for the same binding", async () => {
    const get = store([]);
    const pending = deferred<ThreadHistoryPage>();
    adapter.getInitialHistory.mockReturnValueOnce(pending.promise);
    const first = get().loadMessages("claude", "thread");
    await get().loadMessages("claude", "thread");
    expect(adapter.getInitialHistory).toHaveBeenCalledTimes(1);
    pending.resolve(page([row("first")], "first"));
    await first;
  });

  it("clears the loading flag when a replaced binding has no follow-up request", async () => {
    const get = store([]);
    const pending = deferred<ThreadHistoryPage>();
    adapter.getInitialHistory.mockReturnValueOnce(pending.promise);
    const loading = get().loadMessages("claude", "thread");
    get().sessionMeta.externalSessionResolutions.thread = "native-b";
    pending.resolve(page([row("stale")], "stale"));
    await loading;
    expect(get().threadProjections.thread.pagination.loadingInitial).toBe(false);
    expect(get().threadProjections.thread.pagination.initialStatus).toBe("idle");
  });

  it("does not prepend a page from a previous native binding", async () => {
    const get = store([row("visible")]);
    get().updateThreadHistory("thread", (projection) => ({
      ...projection,
      pagination: { ...projection.pagination, oldestSequence: 3, hasMoreHistory: true },
    }));
    const pending = deferred<ThreadHistoryPage>();
    adapter.getPage.mockReturnValueOnce(pending.promise);
    const loading = get().loadMoreMessages("claude", "thread");
    get().sessionMeta.externalSessionResolutions.thread = "native-b";
    pending.resolve(page([row("stale")], "stale"));
    await loading;
    expect(get().threadProjections.thread.messages.map((item) => item.id)).toEqual(["visible"]);
    expect(get().threadProjections.thread.pagination.loadingMore).toBe(false);
  });

  it("merges a partial history page without dropping a live message", () => {
    const get = store([row("live")]);
    get().applyHistoryPage("thread", "claude", { messages: [row("older")], coverage: "partial" });
    expect(get().threadProjections.thread.messages.map((item) => item.id)).toEqual(["older", "live"]);
  });

  it("rejects a partial page from another runtime", () => {
    const get = store([row("visible")]);
    get().applyHistoryPage("thread", "codex", { messages: [row("foreign")], coverage: "partial" });
    expect(get().threadProjections.thread.messages.map((item) => item.id)).toEqual(["visible"]);
  });
});

describe("completed Codex run reconciliation", () => {
  beforeEach(() => { adapter.getInitialHistory.mockReset(); adapter.getFullHistory.mockReset(); adapter.getPage.mockReset(); });

  it("reads a later run after an earlier run's history request", async () => {
    const get = store([row("visible")]);
    get().sessionMeta.threadTypes.thread = "codex";
    const firstPage = deferred<ThreadHistoryPage>();
    adapter.getInitialHistory.mockReturnValueOnce(firstPage.promise)
      .mockResolvedValueOnce(page([row("second-run")], "second-run"));

    const first = get().reconcileCompletedRun("codex", "thread", "run-1");
    const second = get().reconcileCompletedRun("codex", "thread", "run-2");
    firstPage.resolve(page([row("first-run")], "first-run"));
    await Promise.all([first, second]);

    expect(adapter.getInitialHistory).toHaveBeenCalledTimes(2);
    expect(get().threadProjections.thread.messages.some((message) => message.id === "second-run")).toBe(true);
  });
});

describe("full history refresh", () => {
  beforeEach(() => { adapter.getFullHistory.mockReset(); });

  it("keeps a live update to the same message while DSH history is loading", async () => {
    const old = row("assistant");
    const get = store([old]);
    const pending = deferred<ChatMessage[]>();
    adapter.getFullHistory.mockReturnValueOnce(pending.promise);
    const loading = get().reloadMessagesFromHistory("deepseek-harness", "thread");
    const live = { ...old, content: "new live content" };
    get().updateThreadHistory("thread", (projection) => ({ ...projection, messages: [live] }));
    pending.resolve([old]);
    await loading;
    expect(get().threadProjections.thread.messages).toEqual([live]);
  });
});
