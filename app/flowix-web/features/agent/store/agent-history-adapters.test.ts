import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PiHistoryPage, PiHistoryRevision } from "@/types/agent";

const client = vi.hoisted(() => ({
  getCodexThreadPage: vi.fn(),
  getPiSessionPage: vi.fn(),
  getClaudeThreadPage: vi.fn(),
  getOpenCodeThreadPage: vi.fn(),
}));
vi.mock("@features/agent/store/agent-client", () => ({ agentClient: client }));
import { getAgentHistoryAdapter, HistoryChangedError } from "./agent-history-adapters";

const revision: PiHistoryRevision = { sessionId: "native-session", appendCursor: "append-last", leafId: "leaf" };

describe("Codex history coverage", () => {
  beforeEach(() => client.getCodexThreadPage.mockReset());

  it("declares only terminal native turns complete", async () => {
    client.getCodexThreadPage.mockResolvedValueOnce({
      messages: [], oldestSequence: null, hasMore: false, completeTurnIds: ["turn-done"],
    });
    const page = await getAgentHistoryAdapter("codex").getInitialHistory("thread", 10);
    expect(page.coverage).toEqual({ kind: "complete-turns", turnIds: ["turn-done"] });
  });

  it("keeps pages without terminal proof partial", async () => {
    client.getCodexThreadPage.mockResolvedValueOnce({
      messages: [], oldestSequence: null, hasMore: false,
    });
    const page = await getAgentHistoryAdapter("codex").getInitialHistory("thread", 10);
    expect(page.coverage).toEqual({ kind: "partial" });
  });
});

function page(id: string, sequence: number, hasMore: boolean): PiHistoryPage {
  return { revision, messages: [{ role: "user", content: id, _pi_session_message_id: id, _pi_history_sequence: sequence }],
    beforeEntryId: id, oldestSequence: sequence, snapshotSequence: 20, hasMore };
}

describe("Pi backend history pages", () => {
  beforeEach(() => client.getPiSessionPage.mockReset());

  it("requests only the latest complete turns and preserves native page metadata", async () => {
    client.getPiSessionPage.mockResolvedValueOnce(page("u10", 10, true));
    const latest = await getAgentHistoryAdapter("pi").getInitialHistory("thread", 10);
    expect(client.getPiSessionPage).toHaveBeenCalledWith("thread", null, 10, undefined);
    expect(latest.piBeforeEntryId).toBe("u10");
    expect(latest.piRevision).toEqual(revision);
    expect(latest.messages[0].sourceSequence).toBe(10);
    expect(latest.messages[0].messageId).toBe("u10");
  });

  it("uses the backend native cursor and pinned revision for older turns", async () => {
    client.getPiSessionPage.mockResolvedValueOnce(page("u1", 0, false));
    const older = await getAgentHistoryAdapter("pi").getPage("thread", 10, 10, 20, revision, "u10");
    expect(client.getPiSessionPage).toHaveBeenCalledWith("thread", "u10", 10, revision);
    expect(older.messages[0].messageId).toBe("u1");
    expect(older.hasMore).toBe(false);
  });

  it("rejects numeric-only pagination instead of interpreting it on another branch", async () => {
    await expect(getAgentHistoryAdapter("pi").getPage("thread", 10, 10, 20)).rejects.toThrow("native cursor and revision");
    expect(client.getPiSessionPage).not.toHaveBeenCalled();
  });

  it("converts a stale native revision into a recoverable pagination error", async () => {
    client.getPiSessionPage.mockRejectedValueOnce("HistoryChanged:pi_branch");
    await expect(getAgentHistoryAdapter("pi").getPage("stale-thread", 10, 10, 20, revision, "u10"))
      .rejects.toBeInstanceOf(HistoryChangedError);
    client.getPiSessionPage.mockRejectedValueOnce(new Error("HistoryChanged:pi_branch"));
    await expect(getAgentHistoryAdapter("pi").getPage("stale-thread", 10, 10, 20, revision, "u10"))
      .rejects.toBeInstanceOf(HistoryChangedError);
  });

  it("loads an explicitly requested full history through pinned backend pages", async () => {
    client.getPiSessionPage.mockResolvedValueOnce(page("latest", 10, true)).mockResolvedValueOnce(page("older", 0, false));
    const messages = await getAgentHistoryAdapter("pi").getFullHistory("thread");
    expect(messages.map((row) => row.messageId)).toEqual(["older", "latest"]);
    expect(client.getPiSessionPage).toHaveBeenNthCalledWith(2, "thread", "latest", 100, revision);
  });

  it("rejects a repeating Pi cursor during a full read", async () => {
    client.getPiSessionPage.mockResolvedValue(page("same", 10, true));
    await expect(getAgentHistoryAdapter("pi").getFullHistory("thread")).rejects.toThrow(/cursor|progress/i);
    expect(client.getPiSessionPage.mock.calls).toHaveLength(2);
  });

  it("rejects a branch change during a full read", async () => {
    client.getPiSessionPage.mockResolvedValueOnce(page("latest", 10, true))
      .mockResolvedValueOnce({ ...page("older", 0, false), revision: { ...revision, leafId: "other-leaf" } });
    await expect(getAgentHistoryAdapter("pi").getFullHistory("thread"))
      .rejects.toBeInstanceOf(HistoryChangedError);
    expect(client.getPiSessionPage).toHaveBeenNthCalledWith(2, "thread", "latest", 100, revision);
  });
});

describe.each([
  ["claude", client.getClaudeThreadPage],
  ["opencode", client.getOpenCodeThreadPage],
] as const)("%s full history", (runtime, getPage) => {
  beforeEach(() => getPage.mockReset());

  it("reads every older page before returning a complete history", async () => {
    getPage.mockResolvedValueOnce({
      messages: [{ id: "new", role: "user", content: "new", timestamp: "2026-01-01T00:00:00Z" }],
      oldestSequence: 51, snapshotSequence: 100, hasMore: true,
    }).mockResolvedValueOnce({
      messages: [{ id: "old", role: "user", content: "old", timestamp: "2025-01-01T00:00:00Z" }],
      oldestSequence: 1, snapshotSequence: 100, hasMore: false,
    });
    const messages = await getAgentHistoryAdapter(runtime).getFullHistory("thread");
    expect(messages.map((message) => message.id)).toEqual(["old", "new"]);
    expect(getPage).toHaveBeenNthCalledWith(2, "thread", 51, 50, 100);
  });

  it("rejects a cursor loop instead of returning partial history", async () => {
    getPage.mockResolvedValue({ messages: [], oldestSequence: 51, snapshotSequence: 100, hasMore: true });
    await expect(getAgentHistoryAdapter(runtime).getFullHistory("thread")).rejects.toThrow(/cursor|progress/i);
  });

  it("rejects a non-advancing sequence cursor", async () => {
    getPage.mockResolvedValueOnce({ messages: [{ id: "new" }], oldestSequence: 51, snapshotSequence: 100, hasMore: true })
      .mockResolvedValueOnce({ messages: [{ id: "same" }], oldestSequence: 51, snapshotSequence: 100, hasMore: true });
    await expect(getAgentHistoryAdapter(runtime).getFullHistory("thread"))
      .rejects.toThrow(/did not move/);
  });
});
