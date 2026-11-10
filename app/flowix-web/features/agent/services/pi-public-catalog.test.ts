import { beforeEach, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  getInfo: vi.fn(async () => ({ cloudEnvironment: "staging" })),
  listProviders: vi.fn(async () => [] as unknown[]),
  listModels: vi.fn(async () => [] as string[]),
}));

vi.mock("@platform/tauri/client", () => ({
  product: { getInfo: backend.getInfo },
  piModels: { list: backend.listProviders },
  agent: { listSupportedModels: backend.listModels },
}));

import { loadAgentModelCatalog } from "@features/agent/services/agent-catalog-service";
import {
  readPiPublicCatalogCache,
  withCachedGuestCloudModels,
  withPublicCloudModels,
  writePiPublicCatalogCache,
} from "@features/agent/services/pi-public-catalog";
import { useAgentDataStore } from "@features/agent/store/agent-data-store";

const localItem = {
  id: "deepseek-v4-pro",
  label: "DeepSeek V4 Pro",
  source: "custom" as const,
  providerId: "deepseek",
  providerName: "DeepSeek",
};

const publicModels = [
  { id: "flowix/deepseek-flash", title: "DeepSeek V4.1 Flash", creditMultiplier: 0.1 },
  { id: "flowix/deepseek-v4-pro", title: "DeepSeek V4.1 Pro" },
];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useAgentDataStore.setState(useAgentDataStore.getInitialState(), true);
  backend.getInfo.mockResolvedValue({ cloudEnvironment: "staging" });
  backend.listProviders.mockResolvedValue([
    { id: "deepseek", displayName: "DeepSeek", source: "custom", models: [{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }] },
  ]);
  backend.listModels.mockResolvedValue(["deepseek::deepseek-v4-pro"]);
});

it("puts the guest catalog first and tags it with the preview provider", () => {
  const merged = withPublicCloudModels({ items: [localItem] }, publicModels);

  expect(merged.items.map((item) => [item.providerId, item.id])).toEqual([
    ["__flowix-cloud-preview", "flowix/deepseek-flash"],
    ["__flowix-cloud-preview", "flowix/deepseek-v4-pro"],
    ["deepseek", "deepseek-v4-pro"],
  ]);
  expect(merged.items[0].creditMultiplier).toBe(0.1);
});

it("ranks guest Cloud models by descending sortOrder, keeping unranked order", () => {
  const ranked = [
    { id: "flowix/low", title: "Low", sortOrder: 0 },
    { id: "flowix/high", title: "High", sortOrder: 30 },
    { id: "flowix/medium", title: "Medium", sortOrder: 10 },
    { id: "flowix/default", title: "Default" },
  ];

  const merged = withPublicCloudModels({ items: [localItem] }, ranked);

  expect(merged.items.map((item) => item.id)).toEqual([
    "flowix/high",
    "flowix/medium",
    "flowix/low",
    "flowix/default",
    "deepseek-v4-pro",
  ]);
  expect(merged.items[0].sortOrder).toBe(30);
});

it("ranks installed Cloud models by sortOrder when a session exists", async () => {
  useAgentDataStore.getState().setPiCloudAccount("user-1", 9);
  backend.listProviders.mockResolvedValue([
    {
      id: "flowix-cloud-member",
      displayName: "Flowix Cloud",
      source: "flowix-cloud",
      models: [
        { id: "flowix/model-a", name: "A", sortOrder: 0 },
        { id: "flowix/model-b", name: "B", sortOrder: 20 },
        { id: "flowix/model-c", name: "C", sortOrder: 10 },
      ],
    },
  ]);
  backend.listModels.mockResolvedValue([
    "flowix-cloud-member::flowix/model-a",
    "flowix-cloud-member::flowix/model-b",
    "flowix-cloud-member::flowix/model-c",
  ]);

  const catalog = await loadAgentModelCatalog("pi", { force: true });

  expect(catalog.items.map((item) => item.id)).toEqual([
    "flowix/model-b",
    "flowix/model-c",
    "flowix/model-a",
  ]);
});

it("replaces an installed Cloud entry rather than listing it twice", () => {
  const installed = { ...localItem, id: "deepseek-v4-pro", source: "flowix-cloud" as const, providerId: "flowix-cloud-member" };
  const merged = withPublicCloudModels({ items: [installed, localItem] }, publicModels);

  expect(merged.items.filter((item) => item.id === "deepseek-v4-pro")).toHaveLength(1);
});

it("round-trips the cache per Cloud environment", () => {
  writePiPublicCatalogCache("staging", publicModels);

  expect(readPiPublicCatalogCache("staging")?.models).toHaveLength(2);
  expect(readPiPublicCatalogCache("prod")).toBeNull();
});

it("leaves a catalog untouched when no guest catalog was ever cached", async () => {
  await expect(withCachedGuestCloudModels({ items: [localItem] }))
    .resolves.toEqual({ items: [localItem] });
});

it("keeps the Cloud section when a plain refresh rebuilds the Pi catalog signed out", async () => {
  // A refresh triggered outside the Cloud service used to persist the local
  // providers only, so the section vanished and a Cloud pick had nothing to hit.
  writePiPublicCatalogCache("staging", publicModels);
  useAgentDataStore.getState().setPiCloudAccount(null);

  const catalog = await loadAgentModelCatalog("pi", { force: true });

  expect(catalog.items.map((item) => item.id)).toEqual([
    "flowix/deepseek-flash",
    "flowix/deepseek-v4-pro",
    "deepseek-v4-pro",
  ]);
});

it("does not add the guest section once an account session exists", async () => {
  writePiPublicCatalogCache("staging", publicModels);
  useAgentDataStore.getState().setPiCloudAccount("user-1", 9);

  const catalog = await loadAgentModelCatalog("pi", { force: true });

  expect(catalog.items.map((item) => item.id)).toEqual(["deepseek-v4-pro"]);
});
