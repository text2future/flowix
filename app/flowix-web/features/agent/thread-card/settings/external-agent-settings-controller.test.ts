// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoItem } from "@/types/memo-item";

const { getMemos } = vi.hoisted(() => ({ getMemos: vi.fn() }));

vi.mock("@platform/tauri/client", () => ({
  agent: {},
  dshIntegration: { checkUpdate: vi.fn() },
  memos: { getMemos },
  windows: {},
}));

vi.mock("@platform/tauri/event-bus", () => ({
  subscribe: vi.fn(() => vi.fn()),
}));

vi.mock("@features/memo/store/memo-store", () => ({
  useMemoStore: {
    getState: () => ({ selectedNotebook: { id: "notebook-1" } }),
  },
}));

vi.mock("@features/memo/use-cases/open-by-target", () => ({
  openNoteByMemoId: vi.fn(),
}));

vi.mock("@features/workspace/use-cases/browser-column-navigation", () => ({
  openBrowserColumnFileBrowser: vi.fn(),
}));

import { ExternalAgentSettingsController } from "./external-agent-settings-controller";

function memo(id: string, properties: Record<string, unknown>): MemoItem {
  return {
    id,
    filename: `${id}.md`,
    preview: `${id} description`,
    thumbnail: null,
    tags: [],
    todos: [],
    agents: [],
    createdAt: 1,
    updatedAt: 1,
    favorited: false,
    icon: null,
    colors: [],
    properties,
  };
}

describe("ExternalAgentSettingsController featured notes", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    getMemos.mockReset();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the Agent icon and settings before asynchronously loaded note cards", async () => {
    getMemos
      .mockResolvedValueOnce({
        memos: [memo("hidden", {})],
        nextCursor: "page-2",
        hasMore: true,
      })
      .mockResolvedValueOnce({
        memos: [memo("skill", { type: "skill" })],
        nextCursor: null,
        hasMore: false,
      });

    const popover = document.createElement("div");
    const controller = new ExternalAgentSettingsController({
      popover,
      getTypeKey: () => "codex",
      getInstanceId: () => undefined,
      getLanguage: () => "zh-CN",
      t: (key) => key,
      isDestroyed: () => false,
    });

    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-notes")).not.toBeNull();
    });

    expect(getMemos).toHaveBeenNthCalledWith(1, expect.objectContaining({ cursor: undefined }));
    expect(getMemos).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: "page-2" }));

    const children = Array.from(empty.children);
    const iconIndex = children.findIndex((node) => node.classList.contains("agent-thread-card__empty-agent-icon"));
    const controlsIndex = children.findIndex((node) => node.classList.contains("agent-thread-card__empty-controls"));
    const notesIndex = children.findIndex((node) => node.classList.contains("agent-thread-card__featured-notes"));
    expect(iconIndex).toBeGreaterThanOrEqual(0);
    expect(controlsIndex).toBeGreaterThan(iconIndex);
    expect(notesIndex).toBeGreaterThan(controlsIndex);
    const notesPanel = empty.querySelector(".agent-thread-card__featured-notes");
    const panelChildren = Array.from(notesPanel?.children ?? []);
    expect(panelChildren.findIndex((node) => node.classList.contains("agent-thread-card__featured-notes-settings-footer")))
      .toBeGreaterThan(panelChildren.findIndex((node) => node.classList.contains("agent-thread-card__featured-notes-list")));

    controller.dispose();
  });

  it("persists a key/value filter and refreshes the visible cards", async () => {
    getMemos.mockResolvedValue({
      memos: [
        memo("skill", { type: "skill" }),
        memo("pinned", { pin: true }),
      ],
      nextCursor: null,
      hasMore: false,
    });

    const controller = new ExternalAgentSettingsController({
      popover: document.createElement("div"),
      getTypeKey: () => "codex",
      getInstanceId: () => undefined,
      getLanguage: () => "zh-CN",
      t: (key) => key,
      isDestroyed: () => false,
    });
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-note-title")?.textContent)
        .toBe("skill");
    });

    const settingsButton = empty.querySelector<HTMLButtonElement>(
      ".agent-thread-card__featured-notes-settings-button",
    );
    settingsButton?.click();
    const form = empty.querySelector<HTMLFormElement>(
      ".agent-thread-card__featured-notes-settings form",
    );
    const keyInput = form?.elements.namedItem("key") as HTMLInputElement;
    const operatorInput = form?.elements.namedItem("operator") as HTMLInputElement;
    const valueInput = form?.elements.namedItem("value") as HTMLInputElement;
    expect(keyInput.value).toBe("type");
    expect(operatorInput.value).toBe("equals");
    expect(form?.querySelector("select")).toBeNull();
    const operatorTrigger = form?.querySelector<HTMLButtonElement>(
      ".agent-thread-card__featured-notes-operator-trigger",
    );
    operatorTrigger?.click();
    expect(form?.querySelector<HTMLElement>(
      ".agent-thread-card__featured-notes-operator-menu",
    )?.hidden).toBe(false);
    expect(valueInput.value).toBe("skill");
    keyInput.value = "pin";
    valueInput.value = "true";
    form?.requestSubmit();

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-note-title")?.textContent)
        .toBe("pinned");
    });
    expect(JSON.parse(localStorage.getItem("flowix.agent.featured-note-filter") ?? "null"))
      .toEqual({ key: "pin", operator: "equals", value: "true" });

    controller.dispose();
  });
});
