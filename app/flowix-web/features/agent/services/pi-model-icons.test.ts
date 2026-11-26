import { afterEach, expect, it, vi } from "vitest";
import { prefetchPiCloudModelIcons } from "./pi-model-icons";
import type { AgentModelCatalog } from "@features/agent/store/agent-data-store";

afterEach(() => vi.unstubAllGlobals());

it("prefetches unique HTTPS cloud icons and retries failures", () => {
  const images: Array<{ src: string; onerror: (() => void) | null; referrerPolicy: string }> = [];
  class FakeImage {
    src = "";
    referrerPolicy = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { images.push(this); }
  }
  vi.stubGlobal("Image", FakeImage);
  const catalog = { items: [
    { id: "one", label: "one", source: "flowix-cloud", iconUrl: "https://example.com/icon.svg" },
    { id: "two", label: "two", source: "flowix-cloud", iconUrl: "https://example.com/icon.svg" },
    { id: "custom", label: "custom", source: "custom", iconUrl: "https://example.com/custom.svg" },
    { id: "unsafe", label: "unsafe", source: "flowix-cloud", iconUrl: "http://example.com/unsafe.svg" },
  ], defaultModel: "" } as AgentModelCatalog;
  prefetchPiCloudModelIcons(catalog);
  prefetchPiCloudModelIcons(catalog);
  expect(images).toHaveLength(1);
  expect(images[0]?.src).toBe("https://example.com/icon.svg");
  expect(images[0]?.referrerPolicy).toBe("no-referrer");
  images[0]?.onerror?.();
  prefetchPiCloudModelIcons(catalog);
  expect(images).toHaveLength(2);
  images[1]?.onerror?.();
});
