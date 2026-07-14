import { describe, expect, it } from "vitest";
import type { AgentTypeKey } from "@/types/agent";
import {
  mergeChatPersisted,
  partializeChat,
  type ChatPersistShape,
} from "@features/agent/store/chat-store-migration";

const emptyCurrent: ChatPersistShape = {
  threadStates: {},
  activeThreadIds: {},
  activeAgentTypeKey: "flowix",
  threadTypes: {},
  currentThreadTitles: {},
  agentPermissionMode: "danger-full-access",
  agentCodexModel: "inherit",
  agentCodexReasoningEffort: "medium",
  externalSessionResolutions: {},
  threadLists: {},
  lastRunningRunsReconciledAt: null,
};

describe("chat-store-migration / partializeChat", () => {
  it("白名单导出 ── 不含 threadStates / lastRunningRunsReconciledAt / runtime 缓存", () => {
    const state: ChatPersistShape = {
      ...emptyCurrent,
      threadStates: { "t1": {} as never },
      lastRunningRunsReconciledAt: 12345,
    };
    const out = partializeChat(state);
    expect("threadStates" in out).toBe(false);
    expect("lastRunningRunsReconciledAt" in out).toBe(false);
    // 持久化字段都在
    expect(out.activeThreadIds).toBe(state.activeThreadIds);
    expect(out.activeAgentTypeKey).toBe("flowix");
    expect(out.agentCodexModel).toBe("inherit");
    expect(out.externalSessionResolutions).toBe(state.externalSessionResolutions);
  });
});

describe("chat-store-migration / mergeChatPersisted", () => {
  it("没有 persisted 时返回 current", () => {
    const merged = mergeChatPersisted(undefined, emptyCurrent);
    expect(merged).toEqual(emptyCurrent);
  });

  it("保留 current.threadStates (真源 SQLite, 不从 localStorage 恢复)", () => {
    const persisted = {
      threadStates: { "t-from-localstorage": { isLoading: true } as never },
      externalSessionResolutions: { "local-1": "session-1" },
    };
    const merged = mergeChatPersisted(persisted, emptyCurrent);
    expect(merged.threadStates).toEqual(emptyCurrent.threadStates);
  });

  it("保留 current.lastRunningRunsReconciledAt", () => {
    const persisted = { lastRunningRunsReconciledAt: 99999 };
    const merged = mergeChatPersisted(persisted, {
      ...emptyCurrent,
      lastRunningRunsReconciledAt: 111,
    });
    expect(merged.lastRunningRunsReconciledAt).toBe(111);
  });

  it("normalize 失败的 activeAgentTypeKey 回退 DEFAULT_AGENT_TYPE_KEY (flowix)", () => {
    const garbageKey = "garbage" as unknown as AgentTypeKey;
    const merged = mergeChatPersisted({ activeAgentTypeKey: garbageKey }, {
      ...emptyCurrent,
      activeAgentTypeKey: garbageKey,
    });
    expect(merged.activeAgentTypeKey).toBe("flowix");
  });

  it("externalSessionResolutions 从 persisted 恢复", () => {
    const merged = mergeChatPersisted(
      { externalSessionResolutions: { "local-1": "session-1" } },
      { ...emptyCurrent, externalSessionResolutions: {} },
    );
    expect(merged.externalSessionResolutions).toEqual({
      "local-1": "session-1",
    });
  });
});