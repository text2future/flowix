import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PiHistoryPage, PiHistoryRevision } from "@/types/agent";

const client = vi.hoisted(() => ({ getPiSessionPage: vi.fn() }));
vi.mock("@features/agent/store/agent-client", () => ({ agentClient: client }));
import { getAgentHistoryAdapter } from "./agent-history-adapters";
import { PiHistorySnapshotChangedError } from "./pi-message-reconciliation";

const revision: PiHistoryRevision = { sessionId: "native-session", appendCursor: "append-last", leafId: "leaf" };
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
    client.getPiSessionPage.mockRejectedValueOnce(new Error("Pi history branch changed; refresh history before loading older pages"));
    await expect(getAgentHistoryAdapter("pi").getPage("stale-thread", 10, 10, 20, revision, "u10"))
      .rejects.toBeInstanceOf(PiHistorySnapshotChangedError);
  });

  it("loads an explicitly requested full history through pinned backend pages", async () => {
    client.getPiSessionPage.mockResolvedValueOnce(page("latest", 10, true)).mockResolvedValueOnce(page("older", 0, false));
    const messages = await getAgentHistoryAdapter("pi").getFullHistory("thread");
    expect(messages.map((row) => row.messageId)).toEqual(["older", "latest"]);
    expect(client.getPiSessionPage).toHaveBeenNthCalledWith(2, "thread", "latest", 100, revision);
  });
});
