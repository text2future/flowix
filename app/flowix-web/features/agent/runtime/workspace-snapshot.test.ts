import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@/types/agent";

const state = vi.hoisted(() => ({
  instance: {
    instanceId: "instance-1",
    runtimeConfig: { notebookId: "nb-1" } as RuntimeConfig,
  },
  notebooks: [{ id: "nb-1", path: "/notes/one" }],
  selectedNotebook: { id: "nb-1", path: "/notes/one" },
  accessConfig: {
    entries: [
      {
        id: "folder-1",
        kind: "folder",
        path: "/projects/one",
        name: "one",
        enabled: true,
        missing: false,
      },
    ],
    defaults: {
      files: {
        "nb-1": {
          workspace: "/projects/one",
          folders: ["/projects/one"],
          notebooks: [],
        },
      },
    },
  },
  setRuntimeConfig: vi.fn((_: string, patch: Partial<RuntimeConfig>) => {
    state.instance.runtimeConfig = { ...state.instance.runtimeConfig, ...patch };
  }),
}));

vi.mock("@features/agent/store/agent-session-test-facade", () => ({
  useAgentConversationStore: {
    getState: () => ({
      getInstance: () => state.instance,
      setRuntimeConfig: state.setRuntimeConfig,
    }),
  },
}));

// Phase 7 (2026-08-03): workspace-snapshot 改读 useAgentSessionStore 真源.
// 测试同步 mock session-store 的 getInstance / setRuntimeConfig.
vi.mock("@features/agent/store/agent-session-store", () => ({
  useAgentSessionStore: {
    getState: () => ({
      getInstance: () => state.instance,
      setRuntimeConfig: state.setRuntimeConfig,
    }),
  },
}));

vi.mock("@features/memo/store/memo-store", () => ({
  useMemoStore: {
    getState: () => ({
      notebooks: state.notebooks,
      selectedNotebook: state.selectedNotebook,
    }),
  },
}));

vi.mock("@features/agent/store/agent-access-store", () => ({
  useAgentAccessStore: { getState: () => ({ config: state.accessConfig }) },
}));

describe("conversation workspace snapshot", () => {
  beforeEach(() => {
    state.instance.runtimeConfig = { notebookId: "nb-1" };
    state.notebooks = [{ id: "nb-1", path: "/notes/one" }];
    state.selectedNotebook = { id: "nb-1", path: "/notes/one" };
    state.accessConfig.defaults.files["nb-1"] = {
      workspace: "/projects/one",
      folders: ["/projects/one"],
      notebooks: [],
    };
    vi.clearAllMocks();
  });

  it("captures cwd, add-dir paths, and notebook path on the first run", async () => {
    const { ensureConversationWorkspaceSnapshot } = await import(
      "@features/agent/runtime/workspace-snapshot"
    );

    const config = ensureConversationWorkspaceSnapshot("instance-1");

    expect(config.workspaceSnapshot).toMatchObject({
      version: 1,
      cwd: "/notes/one",
      workspacePaths: ["/projects/one"],
      notebookId: "nb-1",
      notebookPath: "/notes/one",
    });
    expect(state.setRuntimeConfig).toHaveBeenCalledTimes(1);
  });

  it("reuses the first snapshot after notebook defaults and paths change", async () => {
    const { ensureConversationWorkspaceSnapshot } = await import(
      "@features/agent/runtime/workspace-snapshot"
    );
    const first = ensureConversationWorkspaceSnapshot("instance-1");
    state.notebooks[0]!.path = "/notes/changed";
    state.accessConfig.defaults.files["nb-1"] = {
      workspace: "/projects/changed",
      folders: ["/projects/changed"],
      notebooks: [],
    };

    const second = ensureConversationWorkspaceSnapshot("instance-1");

    expect(second.workspaceSnapshot).toEqual(first.workspaceSnapshot);
    expect(state.setRuntimeConfig).toHaveBeenCalledTimes(1);
  });

  it("migrates legacy files once instead of reading current notebook defaults", async () => {
    const { ensureConversationWorkspaceSnapshot } = await import(
      "@features/agent/runtime/workspace-snapshot"
    );
    state.instance.runtimeConfig = {
      notebookId: "nb-1",
      files: {
        folders: ["/legacy/project"],
        notebooks: ["/legacy/notebook"],
      },
    };

    const config = ensureConversationWorkspaceSnapshot("instance-1");

    expect(config.workspaceSnapshot).toMatchObject({
      cwd: "/legacy/project",
      workspacePaths: ["/legacy/project", "/legacy/notebook"],
      notebookPath: "/legacy/notebook",
    });
  });

  it("infers notebook identity for historical instances without notebookId", async () => {
    const { ensureConversationWorkspaceSnapshot } = await import(
      "@features/agent/runtime/workspace-snapshot"
    );
    state.instance.runtimeConfig = {};

    const config = ensureConversationWorkspaceSnapshot("instance-1");

    expect(config.workspaceSnapshot).toMatchObject({
      cwd: "/notes/one",
      notebookId: "nb-1",
      notebookPath: "/notes/one",
      workspacePaths: ["/projects/one"],
    });
    expect(config.notebookId).toBe("nb-1");
    expect(state.instance.runtimeConfig.notebookId).toBe("nb-1");
  });

  it("rejects malformed persisted path arrays instead of throwing", async () => {
    const { normalizeWorkspaceSnapshot } = await import(
      "@features/agent/runtime/workspace-snapshot"
    );

    expect(
      normalizeWorkspaceSnapshot({
        version: 1,
        cwd: "/project",
        workspacePaths: ["/project", 42],
        capturedAt: 1,
      }),
    ).toBeNull();
  });
});
