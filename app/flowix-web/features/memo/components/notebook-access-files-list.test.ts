import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentAccessStore } from "@features/agent/store/agent-access-store";
import { NotebookAccessFilesList } from "@features/memo/components/notebook-access-files-list";
import type { Notebook } from "@features/memo/store/memo-store";
import type { AgentAccessConfig, AgentAccessEntry } from "@/lib/types/agent-access";

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock(import("@/lib/i18n"), async (importOriginal) => { const actual = await importOriginal(); return { ...actual, useI18n: () => ({ language: "en-US", t: (key: string, params?: Record<string, string | number>) => {
  const labels: Record<string, string> = { "memo.navigation.files": "Files", "memo.navigation.addFolder": "Add", "agent.access.pathMissing": "Folder missing", "agent.access.contextDelete": "Delete", "agent.access.folderDeleted": 'Folder "{{name}}" removed', "agent.access.addFolderHint": "Add", "agent.access.saveFailed": "Failed to save", "agent.access.alreadyTracked": "Already tracked", "agent.access.folderExists": "Already added" };
  return (labels[key] ?? key).replace("{{name}}", String(params?.name ?? ""));
} }) }; });
vi.mock("@shared/ui/tooltip", () => ({ Tooltip: ({ children }: { children: ReactNode }) => createElement("span", null, children) }));
vi.mock("@shared/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => createElement(React.Fragment, null, children),
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  ContextMenuContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  ContextMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => createElement("button", { type: "button", onClick, "data-testid": `menu-item:${String(children)}` }, children),
}));
const React = require("react");
const setDefaultFilesMock = vi.fn(async () => true);

function makeFolderEntry(path: string): AgentAccessEntry { return { id: `fld_${path}`, kind: "folder", path, name: path.split(/[\\/]/).pop() ?? path, enabled: true, workspace: false, missing: false, addedAt: 0, updatedAt: 0 }; }
function makeNotebook(overrides: Partial<Notebook> = {}): Notebook { return { id: "nb_1", name: "Notebook", icon: null, path: "/notes/notebook", createdAt: 0, updatedAt: 0, isDefault: false, ...overrides }; }
interface MountHandle { root: Root; host: HTMLDivElement }
function mount(notebook: Notebook | undefined, folders: string[]): MountHandle {
  const entries = folders.map(makeFolderEntry);
  useAgentAccessStore.setState((state) => ({ ...state, config: { version: 1, entries, defaults: {} }, notebookConfigs: notebook ? { [notebook.id]: { version: 1, revision: 1, addDirs: folders.map((path, i) => ({ id: `dir_${i}`, path, label: path, enabled: true })) } } : {}, setDefaultFiles: setDefaultFilesMock as unknown as typeof state.setDefaultFiles }));
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); void act(() => root.render(createElement(NotebookAccessFilesList, { notebook }))); return { root, host };
}
function menuItems(host: HTMLElement): NodeListOf<HTMLElement> { return host.querySelectorAll('[data-testid="menu-item:Delete"]'); }

describe("NotebookAccessFilesList — notebook-local add-dir list", () => {
  let active: MountHandle | null = null;
  beforeEach(() => { useAgentAccessStore.setState({ config: { version: 1, entries: [], defaults: {} } as AgentAccessConfig, notebookConfigs: {}, isLoading: false }); setDefaultFilesMock.mockClear(); setDefaultFilesMock.mockResolvedValue(true); toastMock.success.mockClear(); toastMock.error.mockClear(); });
  afterEach(() => { if (active) { void act(() => active!.root.unmount()); active.host.remove(); active = null; } });
  it("renders add-dir rows without workspace controls or badges", () => { active = mount(makeNotebook(), ["/folder-a", "/folder-b"]); expect(active.host.textContent).toContain("folder-a"); expect(active.host.querySelectorAll(".agent-thread-card__access-workspace-star").length).toBe(0); expect(active.host.querySelectorAll('[data-testid="menu-item:Set as workspace"]').length).toBe(0); expect(menuItems(active.host).length).toBe(2); });
  it("deleting an add-dir updates the notebook-local folders", async () => { const notebook = makeNotebook(); active = mount(notebook, ["/folder-a", "/folder-b"]); await act(async () => { (menuItems(active!.host)[0] as HTMLElement).click(); await Promise.resolve(); }); expect(setDefaultFilesMock).toHaveBeenCalledWith(notebook.id, expect.objectContaining({ folders: ["/folder-b"] })); expect(toastMock.success).toHaveBeenCalled(); });
  it("does not render rows without a selected notebook", () => { active = mount(undefined, ["/folder-a"]); expect(menuItems(active.host).length).toBe(0); });
});
