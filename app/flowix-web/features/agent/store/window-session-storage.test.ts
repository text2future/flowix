import { beforeEach, describe, expect, it } from "vitest";

import { STORAGE_KEYS } from "@/lib/constants";
import {
  agentWindowSessionStorageKey,
  createAgentSessionStateStorage,
} from "@features/agent/store/window-session-storage";

const value = (activeAgentTypeKey: "deepseek-harness" | "codex", permission: string) =>
  JSON.stringify({
    state: {
      sessionMeta: {
        activeAgentTypeKey,
        activeThreadIds: { [activeAgentTypeKey]: `${activeAgentTypeKey}-thread` },
        currentThreadTitles: {},
        threadTypes: {},
        externalSessionResolutions: {},
        settings: {
          agentPermissionMode: permission,
          agentCodexModel: "inherit",
          agentCodexReasoningEffort: "medium",
        },
      },
    },
    version: 0,
  });

describe("createAgentSessionStateStorage", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("keeps navigation in window sessionStorage", () => {
    const storage = createAgentSessionStateStorage("tab-host-abc/1");
    storage.setItem(STORAGE_KEYS.AGENT_SESSION, value("codex", "read-only"));

    const global = JSON.parse(localStorage.getItem(STORAGE_KEYS.AGENT_SESSION)!);
    const local = JSON.parse(
      sessionStorage.getItem(agentWindowSessionStorageKey("tab-host-abc/1"))!,
    );
    expect(global.state.sessionMeta.activeAgentTypeKey).toBeUndefined();
    expect(global.state.sessionMeta.settings.agentPermissionMode).toBe("read-only");
    expect(local.state.sessionMeta.activeAgentTypeKey).toBe("codex");
  });

  it("ignores obsolete global navigation while retaining global settings", async () => {
    localStorage.setItem(STORAGE_KEYS.AGENT_SESSION, value("codex", "read-only"));

    const raw = await createAgentSessionStateStorage("main").getItem(STORAGE_KEYS.AGENT_SESSION);
    const meta = JSON.parse(raw!).state.sessionMeta;
    expect(meta.activeAgentTypeKey).toBeUndefined();
    expect(meta.activeThreadIds).toBeUndefined();
    expect(meta.settings.agentPermissionMode).toBe("read-only");
  });

  it("does not let stale navigation writes roll back global settings", () => {
    localStorage.setItem(STORAGE_KEYS.AGENT_SESSION, value("deepseek-harness", "read-only"));
    const main = createAgentSessionStateStorage("main");
    const tab = createAgentSessionStateStorage("tab-host-1");
    main.getItem(STORAGE_KEYS.AGENT_SESSION);
    tab.getItem(STORAGE_KEYS.AGENT_SESSION);

    main.setItem(STORAGE_KEYS.AGENT_SESSION, value("deepseek-harness", "danger-full-access"));
    tab.setItem(STORAGE_KEYS.AGENT_SESSION, value("codex", "read-only"));

    const global = JSON.parse(localStorage.getItem(STORAGE_KEYS.AGENT_SESSION)!);
    expect(global.state.sessionMeta.settings.agentPermissionMode).toBe(
      "danger-full-access",
    );
  });
});

describe("agentWindowSessionStorageKey", () => {
  it("uses a stable encoded per-window key", () => {
    expect(agentWindowSessionStorageKey("tab-host-abc/1")).toBe(
      `${STORAGE_KEYS.AGENT_SESSION}:window:tab-host-abc%2F1`,
    );
  });
});
