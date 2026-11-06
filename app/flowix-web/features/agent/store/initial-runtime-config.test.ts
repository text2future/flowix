import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentDataStore } from "./agent-data-store";
import { resolveAgentPreferenceRuntimeConfig } from "./agent-user-preferences";
import { buildInitialInstanceRuntimeConfig } from "./initial-runtime-config";

const memoState = vi.hoisted(() => ({ selectedNotebook: null as null | { id: string; path: string } }));
vi.mock("@features/memo/store/note-store", () => ({
  useNoteStore: { getState: () => memoState },
}));

beforeEach(() => {
  memoState.selectedNotebook = null;
  useAgentDataStore.setState(useAgentDataStore.getInitialState(), true);
});

describe("initial runtime from unified Agent preferences", () => {
  it("creates a minimal snapshot until preferences or a notebook are selected", () => {
    expect(buildInitialInstanceRuntimeConfig()).toEqual({ notebookId: undefined });
  });

  it("uses the selected notebook, model-specific reasoning and permission", () => {
    memoState.selectedNotebook = { id: "nb-1", path: "/notes/one" };
    const store = useAgentDataStore.getState();
    store.setUserPreference("codex", { model: { id: "gpt-6.1-sol" }, permission: "workspace-write" });
    store.rememberModelReasoning("codex", { id: "gpt-6.1-sol" }, "low");
    store.rememberModelReasoning("codex", { id: "other-model" }, "high");
    expect(buildInitialInstanceRuntimeConfig()).toEqual({
      notebookId: "nb-1", model: { key: "gpt-6.1-sol" }, access: { sandbox: "workspace-write" }, reasoningEffort: "low",
    });
  });

  it("isolates Agent preferences without copying the global Pi mode into conversations", () => {
    const store = useAgentDataStore.getState();
    store.setUserPreference("claudecode", { model: { id: "claude-model" } });
    store.setUserPreference("pi", { mode: "code" });
    expect(buildInitialInstanceRuntimeConfig("dsh").model).toBeUndefined();
    expect(buildInitialInstanceRuntimeConfig("pi").pi).toBeUndefined();
    expect(resolveAgentPreferenceRuntimeConfig("pi", { pi: { codeMode: false } }).pi).toBeUndefined();
    expect(useAgentDataStore.getState().agents.pi.user.mode).toBe("code");
  });

  it("preserves conversation overrides while applying the selected model's remembered effort", () => {
    const store = useAgentDataStore.getState();
    store.setUserPreference("codex", { model: { id: "global" }, permission: "read-only" });
    store.rememberModelReasoning("codex", { id: "conversation", providerId: "provider" }, "low");
    const runtime = resolveAgentPreferenceRuntimeConfig("codex", {
      model: { key: "conversation", providerId: "provider" }, access: { sandbox: "workspace-write" }, cwd: "/frozen",
    });
    expect(runtime).toMatchObject({ model: { key: "conversation", providerId: "provider" }, access: { sandbox: "workspace-write" }, reasoningEffort: "low", cwd: "/frozen" });
    expect(useAgentDataStore.getState().agents.codex.user.model?.id).toBe("global");
  });

  it("lets the shared Pi model outrank a stale conversation snapshot", () => {
    const store = useAgentDataStore.getState();
    store.setUserPreference("pi", { model: { id: "cloud-model", providerId: "flowix-cloud" } });
    // A conversation frozen on the previous pick must not win the next run: the
    // picker writes the shared preference, and the run reads it back.
    expect(resolveAgentPreferenceRuntimeConfig("pi", {
      model: { key: "byok-model", providerId: "byok" },
    }).model).toEqual({ key: "cloud-model", providerId: "flowix-cloud" });
    // Other Agents keep their per-conversation override.
    expect(resolveAgentPreferenceRuntimeConfig("claudecode", {
      model: { key: "conversation-model" },
    }).model).toEqual({ key: "conversation-model" });
  });

  it("does not read legacy runtime defaults outside migration", () => {
    expect(buildInitialInstanceRuntimeConfig().model).toBeUndefined();
  });
});
