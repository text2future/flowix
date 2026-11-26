import { describe, expect, it } from "vitest";
import { resolvePiModelDisplayName } from "./pi-model-display";
import type { AgentCatalogModel } from "@features/agent/store/agent-data-types";

function model(entry: Partial<AgentCatalogModel> & { id: string }): AgentCatalogModel {
  return { label: entry.id, ...entry };
}

describe("resolvePiModelDisplayName", () => {
  it("prefers the Cloud catalog title over the provider route", () => {
    expect(resolvePiModelDisplayName(
      "flowix-cloud-member/flowix-cn-2/deepseek-v4.1-flash-1017",
      [model({
        id: "flowix-cn-2/deepseek-v4.1-flash-1017",
        providerId: "flowix-cloud-member",
        source: "flowix-cloud",
        label: "DeepSeek V4.1 Flash",
      })],
    )).toBe("DeepSeek V4.1 Flash");
  });

  it("matches a guest catalog entry keyed by the route alone", () => {
    // Signed out, the picker's public catalog has no Cloud provider id to match.
    expect(resolvePiModelDisplayName(
      "flowix-cloud-member/flowix-cn-2/deepseek-v4.1-flash-1017",
      [model({
        id: "flowix-cn-2/deepseek-v4.1-flash-1017",
        providerId: "__flowix-cloud-preview",
        source: "flowix-cloud",
        label: "DeepSeek V4.1 Flash",
      })],
    )).toBe("DeepSeek V4.1 Flash");
  });

  it("matches a catalog entry that stores the bare model id", () => {
    expect(resolvePiModelDisplayName(
      "flowix-cloud-member/deepseek-v4.1-flash-1017",
      [model({
        id: "deepseek-v4.1-flash-1017",
        providerId: "flowix-cloud-member",
        source: "flowix-cloud",
        label: "DeepSeek V4.1 Flash",
      })],
    )).toBe("DeepSeek V4.1 Flash");
  });

  it("hides the provider and upstream route when the catalog has no entry", () => {
    expect(resolvePiModelDisplayName(
      "flowix-cloud-member/flowix-cn-2/deepseek-v4.1-flash-1017",
      [],
    )).toBe("deepseek-v4.1-flash-1017");
  });

  it("keeps a custom provider identity readable", () => {
    expect(resolvePiModelDisplayName("my-gateway/qwen3-max", [])).toBe("my-gateway/qwen3-max");
  });

  it("prefers the entry owned by the run's own provider", () => {
    expect(resolvePiModelDisplayName("custom-provider/shared-model", [
      model({ id: "shared-model", providerId: "flowix-cloud-member", source: "flowix-cloud", label: "Cloud Shared" }),
      model({ id: "shared-model", providerId: "custom-provider", source: "custom", label: "Custom Shared" }),
    ])).toBe("Custom Shared");
  });

  it("returns an empty string for a missing model", () => {
    expect(resolvePiModelDisplayName(undefined, [])).toBe("");
    expect(resolvePiModelDisplayName("   ", [])).toBe("");
  });
});
