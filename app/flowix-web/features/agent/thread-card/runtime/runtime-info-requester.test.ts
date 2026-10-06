import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeInfoRequester } from "./runtime-info-requester";

const mocks = vi.hoisted(() => ({
  getCodexSessionId: vi.fn(),
  getCodexRuntimeInfo: vi.fn(),
  getDeepSeekHarnessSessionId: vi.fn(),
  getPiSessionId: vi.fn(),
  getOpenCodeSessionId: vi.fn(),
  sessionUsage: vi.fn(),
}));

vi.mock("@platform/tauri/client", () => ({
  agent: {
    getCodexSessionId: mocks.getCodexSessionId,
    getCodexRuntimeInfo: mocks.getCodexRuntimeInfo,
    getDeepSeekHarnessSessionId: mocks.getDeepSeekHarnessSessionId,
    getPiSessionId: mocks.getPiSessionId,
    getOpenCodeSessionId: mocks.getOpenCodeSessionId,
  },
  deepseekHarness: { sessionUsage: mocks.sessionUsage },
}));

describe("createRuntimeInfoRequester", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns undefined for agent types without a runtime provider", () => {
    expect(createRuntimeInfoRequester("claude", () => "thread-1")).toBeUndefined();
  });

  it("loads the persisted Pi session id after the conversation is restored", async () => {
    mocks.getPiSessionId.mockResolvedValue("pi-session-1");
    const request = createRuntimeInfoRequester("pi", () => "thread-1");

    await expect(request?.()).resolves.toEqual({
      sessionId: "pi-session-1",
      usage: {},
    });
    expect(mocks.getPiSessionId).toHaveBeenCalledWith("thread-1");
  });

  it("does not expose the Flowix thread id as a Pi session id", async () => {
    mocks.getPiSessionId.mockResolvedValue("native-pi-session");
    const request = createRuntimeInfoRequester(
      "pi",
      () => "thread-1",
      () => "thread-1",
    );

    await expect(request?.()).resolves.toMatchObject({ sessionId: "native-pi-session" });
    expect(mocks.getPiSessionId).toHaveBeenCalledWith("thread-1");
  });

  it("resolves null without invoking when the thread id is missing for thread-scoped runtimes", async () => {
    for (const typeKey of ["deepseek-harness", "opencode"] as const) {
      const request = createRuntimeInfoRequester(typeKey, () => null);
      await expect(request?.()).resolves.toBeNull();
    }
    expect(mocks.sessionUsage).not.toHaveBeenCalled();
    expect(mocks.getOpenCodeSessionId).not.toHaveBeenCalled();
    expect(mocks.getCodexSessionId).not.toHaveBeenCalled();
  });

  it("loads Codex account and rate limits before a thread session exists", async () => {
    const info = { account: { planType: "plus" }, rateLimits: {}, usage: null };
    mocks.getCodexRuntimeInfo.mockResolvedValue(info);
    const request = createRuntimeInfoRequester("codex", () => null);

    await expect(request?.()).resolves.toEqual({
      sessionId: undefined,
      usage: {},
      codex: info,
    });
    expect(mocks.getCodexSessionId).not.toHaveBeenCalled();
    expect(mocks.getCodexRuntimeInfo).toHaveBeenCalledWith(null);
  });

  it("reads the thread id at call time instead of creation time", async () => {
    let threadId: string | null = null;
    const request = createRuntimeInfoRequester("deepseek-harness", () => threadId);
    await expect(request?.()).resolves.toBeNull();
    threadId = "thread-2";
    mocks.sessionUsage.mockResolvedValue({
      model: "deepseek-chat",
      usage: { input_tokens: 12 },
    });
    mocks.getDeepSeekHarnessSessionId.mockResolvedValue("dsh-session-2");
    await expect(request?.()).resolves.toEqual({
      sessionId: "dsh-session-2",
      model: "deepseek-chat",
      usage: { input_tokens: 12 },
    });
    expect(mocks.sessionUsage).toHaveBeenCalledWith("thread-2");
    expect(mocks.getDeepSeekHarnessSessionId).toHaveBeenCalledWith("thread-2");
  });

  it("maps codex session id and runtime info into the card payload", async () => {
    const info = { account: { planType: "plus" }, usage: { input_tokens: 1 } };
    mocks.getCodexRuntimeInfo.mockResolvedValue(info);
    const request = createRuntimeInfoRequester(
      "codex",
      () => "thread-1",
      () => "sess-1",
    );
    await expect(request?.()).resolves.toEqual({
      sessionId: "sess-1",
      usage: { input_tokens: 1 },
      codex: info,
    });
    expect(mocks.getCodexSessionId).not.toHaveBeenCalled();
    expect(mocks.getCodexRuntimeInfo).toHaveBeenCalledWith("sess-1");
  });

  it("resolves a provider session when the shared session field is not hydrated yet", async () => {
    mocks.getCodexSessionId.mockResolvedValue("resolved-session-1");
    const info = { account: { planType: "plus" }, usage: null };
    mocks.getCodexRuntimeInfo.mockResolvedValue(info);
    const request = createRuntimeInfoRequester("codex", () => "local-thread-1");

    await expect(request?.()).resolves.toEqual({
      sessionId: "resolved-session-1",
      usage: {},
      codex: info,
    });
    expect(mocks.getCodexSessionId).toHaveBeenCalledWith("local-thread-1");
    expect(mocks.getCodexRuntimeInfo).toHaveBeenCalledWith("resolved-session-1");
  });
});
