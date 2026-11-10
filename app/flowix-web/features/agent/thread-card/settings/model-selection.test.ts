import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@platform/tauri/client", () => ({ piModels: {}, agentAccess: {}, agent: {} }));

import { FLOWIX_CLOUD_PREVIEW_PROVIDER_ID, type CloudAccessKind } from "@features/agent/config/cloud-access";
import { useAgentDataStore } from "@features/agent/store/agent-data-store";
import { selectAgentModel, type ModelSelectionHooks } from "./model-selection";
import type { AgentModelOption } from "./model-picker/model-picker-types";

const memberModel: AgentModelOption = {
  id: "deepseek-v4-pro",
  label: "DeepSeek V4 Pro",
  source: "flowix-cloud",
  providerId: "flowix-cloud-member",
  providerName: "Flowix Cloud",
};

const previewModel: AgentModelOption = {
  id: "flowix/deepseek-v4-pro",
  label: "DeepSeek V4.1 Pro",
  source: "flowix-cloud",
  providerId: FLOWIX_CLOUD_PREVIEW_PROVIDER_ID,
  providerName: "Flowix Cloud",
};

const localModel: AgentModelOption = {
  id: "deepseek-v4-pro",
  label: "DeepSeek V4 Pro",
  source: "custom",
  providerId: "deepseek",
  providerName: "DeepSeek",
};

function hooks(overrides: Partial<ModelSelectionHooks> = {}): ModelSelectionHooks {
  return {
    typeKey: "pi",
    apply: vi.fn(),
    closePopover: vi.fn(),
    onCloudAccessBlocked: vi.fn<(kind: CloudAccessKind) => void>(),
    ...overrides,
  };
}

beforeEach(() => {
  useAgentDataStore.setState(useAgentDataStore.getInitialState(), true);
  useAgentDataStore.getState().setPiCloudAccount(null);
  useAgentDataStore.getState().setModelCatalog("pi", { items: [localModel], updatedAt: 0 });
});

it("applies a logged-out preview Cloud model without showing the sign-in card yet", () => {
  const spy = hooks();

  selectAgentModel(spy, previewModel);

  expect(spy.onCloudAccessBlocked).not.toHaveBeenCalled();
  expect(spy.apply).toHaveBeenCalledWith(previewModel);
  expect(spy.closePopover).toHaveBeenCalledOnce();
});

it("asks for a sign-in instead of silently dropping a Cloud model the catalog lost", () => {
  // The session ended while the dropdown still held a member entry. Writing it
  // would bind a model the next run cannot resolve, and returning silently made
  // the send fall back to the local model — the reported "switch did nothing".
  const spy = hooks();

  selectAgentModel(spy, memberModel);

  expect(spy.apply).not.toHaveBeenCalled();
  expect(spy.onCloudAccessBlocked).toHaveBeenCalledWith("signed_out");
  expect(spy.closePopover).toHaveBeenCalledOnce();
});

it("applies a Cloud model the signed-in catalog still carries", () => {
  useAgentDataStore.getState().setPiCloudAccount("user-1", 5);
  useAgentDataStore.getState().setModelCatalog("pi", { items: [memberModel, localModel], updatedAt: 0 });
  const spy = hooks();

  selectAgentModel(spy, memberModel);

  expect(spy.apply).toHaveBeenCalledWith(memberModel);
  expect(spy.onCloudAccessBlocked).not.toHaveBeenCalled();
  expect(spy.closePopover).toHaveBeenCalledOnce();
});

it("stays quiet when a signed-in catalog drops an entry for another reason", () => {
  useAgentDataStore.getState().setPiCloudAccount("user-1", 5);
  const spy = hooks();

  selectAgentModel(spy, memberModel);

  expect(spy.apply).not.toHaveBeenCalled();
  expect(spy.onCloudAccessBlocked).not.toHaveBeenCalled();
  expect(spy.closePopover).toHaveBeenCalledOnce();
});

it("applies a local model without consulting the Cloud rules", () => {
  const spy = hooks();

  selectAgentModel(spy, localModel);

  expect(spy.apply).toHaveBeenCalledWith(localModel);
  expect(spy.onCloudAccessBlocked).not.toHaveBeenCalled();
});
