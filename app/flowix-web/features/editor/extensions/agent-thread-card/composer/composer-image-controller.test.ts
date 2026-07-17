import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cacheImage: vi.fn(),
  deleteCachedImage: vi.fn(),
  readCachedImage: vi.fn(),
}));

vi.mock("@platform/tauri/client", () => ({
  agent: {
    cacheImage: mocks.cacheImage,
    deleteCachedImage: mocks.deleteCachedImage,
    readCachedImage: mocks.readCachedImage,
  },
}));

import { ComposerImageController } from "./composer-image-controller";

describe("ComposerImageController", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it("caches a pasted image, renders a card, and deletes it on request", async () => {
    mocks.cacheImage.mockResolvedValue({
      path: "/tmp/cached.png",
      mimeType: "image/png",
      name: "cached.png",
    });
    mocks.deleteCachedImage.mockResolvedValue(true);
    const input = document.createElement("textarea");
    const container = document.createElement("div");
    const composer = document.createElement("div");
    composer.append(container, input);
    document.body.append(composer);
    const onChange = vi.fn();
    const controller = new ComposerImageController({
      input,
      container,
      initialImages: [],
      onChange,
      onStateChange: vi.fn(),
      onError: vi.fn(),
      onLimitExceeded: vi.fn(),
    });
    const file = new File([new Uint8Array([1, 2, 3])], "paste.png", {
      type: "image/png",
    });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
      },
    });
    input.dispatchEvent(paste);

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(mocks.cacheImage).toHaveBeenCalled();
    expect(container.querySelector("img")).not.toBeNull();
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ path: "/tmp/cached.png" }),
    ]);

    (container.querySelector("button") as HTMLButtonElement).click();
    expect(container.querySelector("img")).toBeNull();
    expect(mocks.deleteCachedImage).toHaveBeenCalledWith("/tmp/cached.png");
    controller.dispose();
  });

  it("loads persisted image previews through the guarded cache reader", async () => {
    mocks.readCachedImage.mockResolvedValue("data:image/png;base64,AQID");
    const input = document.createElement("textarea");
    const container = document.createElement("div");
    const composer = document.createElement("div");
    composer.append(container, input);
    document.body.append(composer);
    const controller = new ComposerImageController({
      input,
      container,
      initialImages: [{
        path: "/tmp/persisted.png",
        mimeType: "image/png",
        name: "persisted.png",
      }],
      onChange: vi.fn(),
      onStateChange: vi.fn(),
      onError: vi.fn(),
      onLimitExceeded: vi.fn(),
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.readCachedImage).toHaveBeenCalledWith("/tmp/persisted.png");
    expect(container.querySelector("img")?.src).toContain(
      "data:image/png;base64,AQID",
    );
    controller.dispose();
  });

  it("removes persisted metadata when the cached file is missing", async () => {
    mocks.readCachedImage.mockResolvedValue(null);
    const input = document.createElement("textarea");
    const container = document.createElement("div");
    const composer = document.createElement("div");
    composer.append(container, input);
    const onChange = vi.fn();
    const controller = new ComposerImageController({
      input,
      container,
      initialImages: [{
        path: "/tmp/missing.png",
        mimeType: "image/png",
        name: "missing.png",
      }],
      onChange,
      onStateChange: vi.fn(),
      onError: vi.fn(),
      onLimitExceeded: vi.fn(),
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(controller.hasImages).toBe(false);
    expect(onChange).toHaveBeenCalledWith([]);
    expect(mocks.deleteCachedImage).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("accepts at most five images and rejects files larger than 5 MB", async () => {
    mocks.cacheImage.mockImplementation(async (_content: string, _type: string) => ({
      path: `/tmp/${mocks.cacheImage.mock.calls.length}.png`,
      mimeType: "image/png",
      name: "cached.png",
    }));
    const input = document.createElement("textarea");
    const container = document.createElement("div");
    const composer = document.createElement("div");
    composer.append(container, input);
    const onError = vi.fn();
    const onLimitExceeded = vi.fn();
    const controller = new ComposerImageController({
      input,
      container,
      initialImages: [],
      onChange: vi.fn(),
      onStateChange: vi.fn(),
      onError,
      onLimitExceeded,
    });
    const smallFiles = Array.from({ length: 6 }, (_, index) =>
      new File([new Uint8Array([index])], `${index}.png`, { type: "image/png" }),
    );
    const oversized = new File(
      [new Uint8Array(5 * 1024 * 1024 + 1)],
      "large.png",
      { type: "image/png" },
    );
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        items: [...smallFiles, oversized].map((file) => ({
          kind: "file",
          type: "image/png",
          getAsFile: () => file,
        })),
      },
    });
    input.dispatchEvent(paste);

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(mocks.cacheImage).toHaveBeenCalledTimes(5);
    expect(onLimitExceeded).toHaveBeenCalledWith("size");
    expect(onLimitExceeded).toHaveBeenCalledWith("count");
    expect(onError).not.toHaveBeenCalled();
    controller.dispose();
  });
});
