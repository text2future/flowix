// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudState } from "@platform/tauri/client";
import type { AgentTypeKey } from "@/types/agent";
import type { AgentModelCatalog } from "@features/agent/store/agent-data-store";

const {
  getCloudState,
  getAiCreditBalance,
  loadAgentModelCatalog,
  refreshAgentModelCatalog,
  refreshMembership,
  refreshPiModelProvider,
  refreshPiModelProviderAtStartup,
  piModelAvailability,
  openPreferences,
} = vi.hoisted(() => ({
  getCloudState: vi.fn(async (): Promise<CloudState> => ({
    revision: 1,
    authenticated: true,
    authStatus: "authenticated" as const,
    account: {
      user: { id: "user-1", email: "member@example.com", displayName: "Member" },
      protocolEpoch: 3 as const,
    },
    membership: {
      active: false,
      usedBytes: 0,
      quotaBytes: 0,
      availableBytes: 0,
      noteCount: 0,
      readOnly: false,
    },
  })),
  getAiCreditBalance: vi.fn(async () => ({ balanceMicrocredits: 0 })),
  loadAgentModelCatalog: vi.fn(async (
    _agentType: AgentTypeKey,
    _options: { force?: boolean } = {},
  ): Promise<AgentModelCatalog> => ({
    items: [],
    updatedAt: Date.now(),
  })),
  refreshAgentModelCatalog: vi.fn(async (_agentType: AgentTypeKey): Promise<AgentModelCatalog> => ({
    items: [],
    updatedAt: Date.now(),
  })),
  refreshPiModelProviderAtStartup: vi.fn(async () => true),
  refreshPiModelProvider: vi.fn(async () => false),
  piModelAvailability: vi.fn(async () => true),
  refreshMembership: vi.fn(async () => ({
    active: false,
    usedBytes: 0,
    quotaBytes: 0,
    availableBytes: 0,
    noteCount: 0,
    readOnly: false,
  })),
  openPreferences: vi.fn(async () => undefined),
}));

vi.mock("@platform/tauri/client", () => ({
  agent: {},
  cloud: {
    getState: getCloudState,
    getAiCreditBalance,
    refreshMembership,
    refreshPiModelProvider,
    refreshPiModelProviderAtStartup,
    piModelAvailability,
  },
  dshIntegration: { checkUpdate: vi.fn() },
  files: { listTableDocuments: vi.fn(async () => []) },
  notes: { list: vi.fn(async () => []) },
  system: { getFeaturedNoteFilter: vi.fn(), setFeaturedNoteFilter: vi.fn() },
  windows: { openPreferences },
}));

vi.mock("@platform/tauri/event-bus", () => ({
  subscribe: vi.fn(() => vi.fn()),
}));

vi.mock("@features/agent/services/agent-catalog-service", () => ({
  loadAgentModelCatalog,
  refreshAgentModelCatalog,
}));

vi.mock("@features/memo/store/note-store", () => ({
  useNoteStore: {
    getState: () => ({ selectedNotebook: null, notebooks: [] }),
  },
}));

vi.mock("@features/memo/public/note-navigation-api", () => ({
  openNoteByMemoId: vi.fn(),
}));

vi.mock("@features/workspace/use-cases/browser-column-navigation", () => ({
  openBrowserColumnFileBrowser: vi.fn(),
  openBrowserColumnNotebookNote: vi.fn(),
}));

import { useAgentDataStore } from "@features/agent/store/agent-data-store";
import { loadPiCloudModelCatalog, syncPiCloudModelCatalog } from "@features/agent/services/pi-cloud-model-service";
import { ExternalAgentSettingsController } from "./external-agent-settings-controller";

describe("Pi composer model dropdown Cloud session updates", () => {
  let controller: ExternalAgentSettingsController | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    useAgentDataStore.setState(useAgentDataStore.getInitialState(), true);
    document.body.replaceChildren();
    loadAgentModelCatalog.mockImplementation(async (agentType: AgentTypeKey) =>
      agentType === "pi" && useAgentDataStore.getState().piCloudAccountId
        ? {
            items: [
              {
                id: "member-model",
                label: "Member model",
                providerId: "flowix-cloud-member",
                providerName: "Flowix Cloud",
                creditMultiplier: 1.25,
              },
              {
                id: "local-model",
                label: "Local model",
                providerId: "custom-provider",
                providerName: "My provider",
              },
            ],
            defaultModel: "local-model",
            defaultProviderId: "custom-provider",
            updatedAt: Date.now(),
          }
        : useAgentDataStore.getState().agents[agentType].catalog.models,
    );
    refreshAgentModelCatalog.mockImplementation(async (agentType: AgentTypeKey) => {
      const catalog = await loadAgentModelCatalog(agentType, { force: true });
      useAgentDataStore.getState().setModelCatalog(agentType, catalog);
      return catalog;
    });
    getCloudState.mockResolvedValue({
      revision: 1,
      authenticated: true,
      authStatus: "authenticated",
      account: {
        user: { id: "user-1", email: "member@example.com", displayName: "Member" },
        protocolEpoch: 3,
      },
      membership: {
        active: false,
        usedBytes: 0,
        quotaBytes: 0,
        availableBytes: 0,
        noteCount: 0,
        readOnly: false,
      },
    });
    refreshPiModelProviderAtStartup.mockResolvedValue(true);
    getAiCreditBalance.mockResolvedValue({ balanceMicrocredits: 0 });
    refreshMembership.mockResolvedValue({
      active: false,
      usedBytes: 0,
      quotaBytes: 0,
      availableBytes: 0,
      noteCount: 0,
      readOnly: false,
    });
    const store = useAgentDataStore.getState();
    store.setPiCloudAccount(null);
    store.setModelCatalog("pi", { items: [], updatedAt: 0 });
  });

  afterEach(() => {
    controller?.dispose();
    controller = undefined;
    useAgentDataStore.getState().setPiCloudAccount(null);
    useAgentDataStore.getState().setModelCatalog("pi", { items: [], updatedAt: 0 });
    document.body.replaceChildren();
  });

  async function openPicker() {
    const store = useAgentDataStore.getState();
    const personalModel = {
      id: "local-model",
      label: "Local model",
      providerId: "custom-provider",
      providerName: "My provider",
    };
    store.setModelCatalog("pi", {
      items: [personalModel],
      defaultModel: "local-model",
      defaultProviderId: "custom-provider",
      updatedAt: Date.now(),
    });

    const popover = document.createElement("div");
    document.body.append(popover);
    const toast = vi.fn();
    controller = new ExternalAgentSettingsController({
      popover,
      getTypeKey: () => "pi",
      getInstanceId: () => undefined,
      getLanguage: () => "zh-CN",
      getEmptyStatePresentation: () => "inline-card",
      t: (key) => {
        const labels: Record<string, string> = {
          "preferences.pi.cloudTitle": "会员模型",
          "preferences.pi.byokTitle": "我的模型",
          "agent.pi.modelSection.mineEmpty": "没有自定义模型",
          "agent.model.title": "模型",
          "agent.model.noneFound": "没有模型",
          "agent.error.membershipRequired": "需要会员",
        };
        return labels[key] ?? key;
      },
      isDestroyed: () => false,
      toast,
    });
    const modelButton = controller.createComposerModelButton();
    expect(modelButton?.classList.contains("agent-composer__model")).toBe(true);
    document.body.append(modelButton!);
    modelButton?.click();

    await vi.waitFor(() => {
      expect(popover.querySelector(".agent-pi-model-picker__item")?.textContent)
        .toContain("Member model");
    });
    return { store, popover, toast };
  }

  it("reconciles a signed-in Cloud session from the composer dropdown and shows member models immediately", async () => {
    const { store, popover } = await openPicker();
    expect(getCloudState).toHaveBeenCalledOnce();
    expect(refreshPiModelProviderAtStartup).toHaveBeenCalledOnce();
    expect(refreshAgentModelCatalog).toHaveBeenCalledWith("pi");
    expect(getAiCreditBalance).not.toHaveBeenCalled();
    expect(popover.querySelector(".agent-pi-model-picker__category-label")?.textContent)
      .toBe("会员模型");
    const memberModelButton = popover.querySelector<HTMLButtonElement>(".agent-pi-model-picker__item");
    expect(memberModelButton?.textContent).toContain("Member model");
    expect(controller?.isOpen).toBe(true);

    // The Cloud session listener applies logout to the shared store; the open
    // Pi dropdown must drop the member directory immediately.
    store.setPiCloudAccount(null);
    await vi.waitFor(() => {
      expect(popover.querySelector(".agent-pi-model-picker__category-label")).toBeNull();
      expect(Array.from(popover.querySelectorAll(".agent-pi-model-picker__item"))
        .some((item) => item.textContent?.includes("Member model"))).toBe(false);
    });
  });
  it("selects a cloud model without active membership", async () => {
    getCloudState.mockResolvedValueOnce({
      revision: 1,
      authenticated: true,
      authStatus: "authenticated",
      account: {
        user: { id: "user-1", email: "member@example.com", displayName: "Member" },
        protocolEpoch: 3,
      },
      membership: {
        active: false,
        usedBytes: 0,
        quotaBytes: 0,
        availableBytes: 0,
        noteCount: 0,
        readOnly: false,
      },
    });
    const { popover } = await openPicker();
    popover.querySelector<HTMLButtonElement>(".agent-pi-model-picker__item")!.click();
    expect(refreshMembership).not.toHaveBeenCalled();
    expect(popover.hidden).toBe(true);
    expect(useAgentDataStore.getState().agents.pi.user.model).toEqual({
      id: "member-model", providerId: "flowix-cloud-member",
    });
  });

  it("does not select a stale member item after logout clears the local entitlement", async () => {
    const { store, popover } = await openPicker();
    const staleMemberButton = popover.querySelector<HTMLButtonElement>(".agent-pi-model-picker__item")!;
    const previousModel = useAgentDataStore.getState().agents.pi.user.model;
    store.setPiCloudAccount(null, 2);
    staleMemberButton.click();
    expect(refreshMembership).not.toHaveBeenCalled();
    expect(useAgentDataStore.getState().agents.pi.user.model).toEqual(previousModel);
  });

  it("ignores an opening snapshot that arrives after a newer login event", async () => {
    let finish!: (state: CloudState) => void;
    getCloudState.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const opening = loadPiCloudModelCatalog();
    await syncPiCloudModelCatalog({
      revision: 2, authenticated: true, authStatus: "authenticated",
      account: { user: { id: "user-1", email: "member@example.com", displayName: "Member" }, protocolEpoch: 3 },
    });
    finish({ revision: 1, authenticated: false, authStatus: "signed_out" });
    await opening;
    expect(useAgentDataStore.getState().piCloudAccountId).toBe("user-1");
    expect(useAgentDataStore.getState().agents.pi.catalog.models.items.some(item => item.id === "member-model"))
      .toBe(true);
  });

  it("shares one provider refresh across simultaneous picker opens", async () => {
    let finish!: (connected: boolean) => void;
    refreshPiModelProviderAtStartup.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = loadPiCloudModelCatalog();
    const second = loadPiCloudModelCatalog();
    await vi.waitFor(() => expect(refreshPiModelProviderAtStartup).toHaveBeenCalledOnce());
    finish(true);
    await Promise.all([first, second]);
    expect(refreshAgentModelCatalog).toHaveBeenCalledOnce();
  });

  it("records a failed catalog load and retries on a later open", async () => {
    refreshPiModelProviderAtStartup.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(loadPiCloudModelCatalog()).rejects.toThrow("network unavailable");
    expect(useAgentDataStore.getState().loadState.piCloudModels).toEqual({
      status: "error", error: "network unavailable",
    });
    await loadPiCloudModelCatalog();
    expect(refreshPiModelProviderAtStartup).toHaveBeenCalledTimes(2);
    expect(useAgentDataStore.getState().loadState.piCloudModels.status).toBe("ready");
  });

});
