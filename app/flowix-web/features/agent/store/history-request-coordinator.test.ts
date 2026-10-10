import { describe, expect, it, vi } from "vitest";
import { createHistoryRequestCoordinator } from "./history-request-coordinator";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Codex history reconciliation", () => {
  it("coalesces the same run and reads a later run after the first completes", async () => {
    const requests = createHistoryRequestCoordinator({
      binding: () => ({}), epoch: () => 0, isDeleted: () => false,
    });
    const first = deferred();
    const executed: string[] = [];
    const firstRead = vi.fn(async () => { executed.push("run-1"); await first.promise; });
    const secondRead = vi.fn(async () => { executed.push("run-2"); });

    const run1 = requests.reconcileCodex("thread", "run-1", firstRead);
    const duplicate = requests.reconcileCodex("thread", "run-1", firstRead);
    const run2 = requests.reconcileCodex("thread", "run-2", secondRead);
    expect(duplicate).toBe(run1);
    expect(requests.reconcileCodex("thread", "run-1", firstRead)).toBe(run1);
    expect(executed).toEqual(["run-1"]);

    first.resolve();
    await Promise.all([run1, run2]);
    expect(executed).toEqual(["run-1", "run-2"]);
    expect(firstRead).toHaveBeenCalledTimes(1);
    expect(secondRead).toHaveBeenCalledTimes(1);
  });

  it("invalidates a response when the provider binding or thread epoch changes", () => {
    let providerSessionId = "native-a";
    let epoch = 0;
    const requests = createHistoryRequestCoordinator({
      binding: () => ({ providerSessionId, agentType: "codex" }),
      epoch: () => epoch,
      isDeleted: () => false,
    });
    const first = requests.begin("thread");
    expect(requests.isCurrent(first)).toBe(true);
    providerSessionId = "native-b";
    expect(requests.isCurrent(first)).toBe(false);
    const second = requests.begin("thread");
    epoch += 1;
    expect(requests.isCurrent(second)).toBe(false);
  });
});
