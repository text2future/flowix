import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listenMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

describe("event-bus subscribe", () => {
  beforeEach(() => {
    vi.resetModules();
    listenMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clears a failed registration placeholder so a later subscribe retries", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unlisten = vi.fn();
    listenMock
      .mockRejectedValueOnce(new Error("Tauri unavailable"))
      .mockResolvedValueOnce(unlisten);

    const { subscribe } = await import("@platform/tauri/event-bus");
    const unsubscribeFirst = subscribe("memo-event", vi.fn());

    await vi.waitFor(() => expect(listenMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));

    const unsubscribeSecond = subscribe("memo-event", vi.fn());
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalledTimes(2));

    unsubscribeFirst();
    unsubscribeSecond();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });
});
