import { beforeEach, describe, expect, it, vi } from "vitest";

const agentAccessMock = vi.hoisted(() => ({
  config: { version: 1, entries: [] as Array<Record<string, unknown>> },
  get: vi.fn(),
  set: vi.fn(),
  addFolderFromPicker: vi.fn(),
}));

vi.mock("@platform/tauri/client", () => ({
  agentAccess: {
    get: agentAccessMock.get,
    set: agentAccessMock.set,
    addFolderFromPicker: agentAccessMock.addFolderFromPicker,
  },
}));

describe("agent-access-store workspace selection", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    agentAccessMock.config = { version: 1, entries: [] };
    agentAccessMock.get.mockImplementation(async () => agentAccessMock.config);
    agentAccessMock.set.mockImplementation(async (config) => {
      agentAccessMock.config = config;
    });
    agentAccessMock.addFolderFromPicker.mockImplementation(async () => null);
    const { useAgentAccessStore } =
      await import("@features/agent/store/agent-access-store");
    useAgentAccessStore.setState({
      config: { version: 1, entries: [] },
      isLoading: false,
    });
  });

  it("marks the first enabled folder as workspace on initial load", async () => {
    const { useAgentAccessStore } =
      await import("@features/agent/store/agent-access-store");
    agentAccessMock.config = {
      version: 1,
      entries: [
        {
          id: "nb-1",
          kind: "notebook",
          path: "D:\\notes",
          name: "Notes",
          enabled: true,
          missing: false,
          addedAt: 1,
          updatedAt: 1,
        },
        {
          id: "folder-1",
          kind: "folder",
          path: "D:\\projects\\first",
          name: "First",
          enabled: true,
          workspace: false,
          missing: false,
          addedAt: 1,
          updatedAt: 1,
        },
        {
          id: "folder-2",
          kind: "folder",
          path: "D:\\projects\\second",
          name: "Second",
          enabled: true,
          workspace: false,
          missing: false,
          addedAt: 1,
          updatedAt: 1,
        },
      ],
    };

    await useAgentAccessStore.getState().loadInitial();

    const entries = useAgentAccessStore.getState().config.entries;
    expect(entries[0].workspace).toBe(false);
    expect(entries[1].workspace).toBe(true);
    expect(entries[2].workspace).toBe(false);
  });

  it("moves workspace back to the first folder when it is enabled", async () => {
    const { useAgentAccessStore } =
      await import("@features/agent/store/agent-access-store");
    useAgentAccessStore.setState({
      config: {
        version: 1,
        entries: [
          {
            id: "folder-1",
            kind: "folder",
            path: "D:\\projects\\first",
            name: "First",
            enabled: false,
            workspace: false,
            missing: false,
            addedAt: 1,
            updatedAt: 1,
          },
          {
            id: "folder-2",
            kind: "folder",
            path: "D:\\projects\\second",
            name: "Second",
            enabled: true,
            workspace: true,
            missing: false,
            addedAt: 1,
            updatedAt: 1,
          },
        ],
      },
      isLoading: false,
    });

    await useAgentAccessStore.getState().toggle("folder-1");

    const entries = useAgentAccessStore.getState().config.entries;
    expect(entries[0].enabled).toBe(true);
    expect(entries[0].workspace).toBe(true);
    expect(entries[1].workspace).toBe(false);
    expect(agentAccessMock.set).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: expect.arrayContaining([
          expect.objectContaining({ id: "folder-1", workspace: true }),
          expect.objectContaining({ id: "folder-2", workspace: false }),
        ]),
      }),
    );
  });
});
