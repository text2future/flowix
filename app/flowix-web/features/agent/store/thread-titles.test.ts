import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTypeKey } from "@/types/agent";

vi.mock("@features/preferences/store/user-settings-store", () => ({
  useUserSettingsStore: {
    getState: () => ({ settings: { language: "en-US" } }),
  },
}));

import {
  canPersistThreadTitle,
  defaultExternalThreadTitle,
  defaultThreadTitle,
  getConversationTitleForThread,
  isExternalAgentType,
  normalizeThreadTitle,
} from "@features/agent/store/thread-titles";

describe("thread-titles helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("isExternalAgentType returns true for non-flowix", () => {
    expect(isExternalAgentType("flowix")).toBe(false);
    expect(isExternalAgentType("codex")).toBe(true);
    expect(isExternalAgentType("claude")).toBe(true);
    expect(isExternalAgentType("gemini")).toBe(true);
    expect(isExternalAgentType("hermes")).toBe(true);
    expect(isExternalAgentType("openclaw")).toBe(true);
  });

  it("persists every agent title in the product database", () => {
    expect(canPersistThreadTitle("flowix")).toBe(true);
    expect(canPersistThreadTitle("codex")).toBe(true);
    expect(canPersistThreadTitle("claude")).toBe(true);
    expect(canPersistThreadTitle("hermes")).toBe(true);
    expect(canPersistThreadTitle("gemini")).toBe(true);
    expect(canPersistThreadTitle("openclaw")).toBe(true);
  });

  it("defaultExternalThreadTitle returns type-specific translated text", () => {
    expect(defaultExternalThreadTitle("codex")).toBe("Codex session");
    // 注意: Claude agent name 是 "Claude Code" 不是 "Claude", 因此 i18n 词条返回
    // "Claude Code session".
    expect(defaultExternalThreadTitle("claude")).toBe("Claude Code session");
    // Hermes 在 defaultThreadTitle 路径里有特别分支 ("Hermes session" 不经过 i18n),
    // defaultExternalThreadTitle 给 Hermes 走到通用分支, 按 agent.name 拼接 "session"。
    expect(defaultExternalThreadTitle("hermes")).toBe("Hermes session");
    // 通用 external 用 agent.name 字段拼接 "session"。
    expect(defaultExternalThreadTitle("gemini")).toBe("Gemini CLI session");
  });

  it("defaultThreadTitle falls back per agent family", () => {
    expect(defaultThreadTitle("flowix")).toBe("Untitled conversation");
    expect(defaultThreadTitle("hermes")).toBe("Hermes session");
    expect(defaultThreadTitle("codex")).toBe("Codex session");
    expect(defaultThreadTitle("claude")).toBe("Claude Code session");
  });

  it("normalizeThreadTitle collapses whitespace and strips context marker", () => {
    expect(normalizeThreadTitle("  hello   world  ")).toBe("hello world");
    expect(normalizeThreadTitle(null)).toBe("");
    expect(normalizeThreadTitle(undefined)).toBe("");
    // stripSystemBlock 只切 <## CONTEXT PROMPT ##> ── 任意大小写。
    expect(
      normalizeThreadTitle("nice title\n<## CONTEXT PROMPT ##>\nignore this"),
    ).toBe("nice title");
    // 字符级变化也识别: 小写 p 也能切。
    expect(
      normalizeThreadTitle("head <## context prompt ##> tail"),
    ).toBe("head");
  });

  it("getConversationTitleForThread uses fallback chain", () => {
    const state = {
      threadLists: {
        codex: [{ threadId: "t1", title: "Codex specific title", createdAt: 1, updatedAt: 1 }],
      } as Partial<Record<AgentTypeKey, { threadId: string; title: string; createdAt: number; updatedAt: number }[]>>,
      activeThreadIds: {
        codex: "t1",
      } as Partial<Record<AgentTypeKey, string | undefined>>,
      currentThreadTitles: {
        codex: "Active title",
      } as Partial<Record<AgentTypeKey, string | undefined>>,
    };

    expect(
      getConversationTitleForThread(state, "codex", "t1"),
    ).toBe("Codex specific title");

    // 当 thread 不在 list 时 (active):
    const state2 = {
      threadLists: {} as Partial<Record<AgentTypeKey, { threadId: string; title: string; createdAt: number; updatedAt: number }[]>>,
      activeThreadIds: { codex: "t1" } as Partial<Record<AgentTypeKey, string | undefined>>,
      currentThreadTitles: { codex: "Active" } as Partial<Record<AgentTypeKey, string | undefined>>,
    };
    expect(getConversationTitleForThread(state2, "codex", "t1")).toBe("Active");

    // 完全没记录: external → type default, flowix → i18n "新对话" 词条 ("Untitled conversation" 在 en-US)。
    const state3 = {
      threadLists: {} as Partial<Record<AgentTypeKey, { threadId: string; title: string; createdAt: number; updatedAt: number }[]>>,
      activeThreadIds: {} as Partial<Record<AgentTypeKey, string | undefined>>,
      currentThreadTitles: {} as Partial<Record<AgentTypeKey, string | undefined>>,
    };
    expect(getConversationTitleForThread(state3, "codex", "t-missing")).toBe(
      "Codex session",
    );
    expect(getConversationTitleForThread(state3, "flowix", "t-missing")).toBe(
      "New conversation",
    );
  });
});
