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
    vi.useRealTimers();
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

  it("automatically retries a failed registration while subscribers remain", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const unlisten = vi.fn();
    listenMock
      .mockRejectedValueOnce(new Error("Webview still starting"))
      .mockRejectedValueOnce(new Error("Webview still starting"))
      .mockResolvedValueOnce(unlisten);

    const ready = vi.fn();
    const { subscribe } = await import("@platform/tauri/event-bus");
    const unsubscribe = subscribe("agent-chunk", vi.fn(), { onListenerReady: ready });
    await Promise.resolve();
    await Promise.resolve();
    expect(listenMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(listenMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1999);
    expect(listenMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(listenMock).toHaveBeenCalledTimes(3);
    expect(ready).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("disposes a stale async registration after unsubscribe and resubscribe", async () => {
    const staleUnlisten = vi.fn();
    const liveUnlisten = vi.fn();
    let resolveStale!: (unlisten: () => void) => void;
    listenMock
      .mockReturnValueOnce(new Promise<() => void>((resolve) => { resolveStale = resolve; }))
      .mockResolvedValueOnce(liveUnlisten);

    const { subscribe } = await import("@platform/tauri/event-bus");
    const unsubscribeStale = subscribe("agent-chunk", vi.fn());
    unsubscribeStale();

    const ready = vi.fn();
    const unsubscribeLive = subscribe("agent-chunk", vi.fn(), { onListenerReady: ready });
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));

    resolveStale(staleUnlisten);
    await vi.waitFor(() => expect(staleUnlisten).toHaveBeenCalledTimes(1));

    unsubscribeLive();
    expect(liveUnlisten).toHaveBeenCalledTimes(1);
  });
});
