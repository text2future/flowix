import { describe, expect, it } from "vitest";
import { resolvePrimaryWorkspace } from "@features/agent/runtime/primary-workspace";
import type { AgentAccessEntry } from "@/lib/types/agent-access";

function makeEntry(
  overrides: Partial<AgentAccessEntry> & { path: string },
): AgentAccessEntry {
  return {
    id: overrides.id ?? "entry",
    kind: overrides.kind ?? "folder",
    path: overrides.path,
    name: overrides.name ?? overrides.path,
    enabled: overrides.enabled ?? true,
    workspace: overrides.workspace ?? false,
    missing: overrides.missing ?? false,
    addedAt: 1,
    updatedAt: 1,
  };
}

describe("resolvePrimaryWorkspace", () => {
  it("1. instance.workspace 永远优先, 不看全局", () => {
    expect(
      resolvePrimaryWorkspace({
        instanceFiles: {
          workspace: "D:\\thread-workspace",
          folders: ["D:\\thread-folder"],
          notebooks: [],
        },
        globalEntries: [
          makeEntry({ path: "D:\\global-workspace", workspace: true }),
        ],
      }),
    ).toEqual({ kind: "instance.workspace", path: "D:\\thread-workspace" });
  });

  it("2. instance.workspace 空时, 退到 instance.folders[0]", () => {
    expect(
      resolvePrimaryWorkspace({
        instanceFiles: {
          workspace: undefined,
          folders: ["D:\\first-folder", "D:\\second-folder"],
          notebooks: [],
        },
        globalEntries: [
          makeEntry({ path: "D:\\global-workspace", workspace: true }),
        ],
      }),
    ).toEqual({ kind: "instance.folders[0]", path: "D:\\first-folder" });
  });

  it("3. instance 都没勾, 退到 instance.notebooks[0]", () => {
    expect(
      resolvePrimaryWorkspace({
        instanceFiles: {
          workspace: undefined,
          folders: [],
          notebooks: ["D:\\first-notebook"],
        },
        globalEntries: [
          makeEntry({ path: "D:\\global-workspace", workspace: true }),
        ],
      }),
    ).toEqual({
      kind: "instance.notebooks[0]",
      path: "D:\\first-notebook",
    });
  });

  it("4. instance 全空, 走全局 entry.workspace=true (firstWorkspace)", () => {
    expect(
      resolvePrimaryWorkspace({
        instanceFiles: { folders: [], notebooks: [], workspace: undefined },
        globalEntries: [
          makeEntry({ path: "D:\\enabled", enabled: true, workspace: false }),
          makeEntry({ path: "D:\\workspace", workspace: true }),
        ],
      }),
    ).toEqual({
      kind: "global.firstWorkspace",
      path: "D:\\workspace",
    });
  });

  it("5. 没有 workspace=true 但有 enabled, 走 global.firstEnabled", () => {
    expect(
      resolvePrimaryWorkspace({
        globalEntries: [
          makeEntry({ path: "D:\\enabled-1", workspace: false, enabled: true }),
          makeEntry({ path: "D:\\enabled-2", workspace: false, enabled: true }),
        ],
      }),
    ).toEqual({
      kind: "global.firstEnabled",
      path: "D:\\enabled-1",
    });
  });

  it("已冻结的空 instance 保持历史快照, 不继承后续全局 workspace", () => {
    expect(
      resolvePrimaryWorkspace({
        instanceFiles: {
          folders: [],
          notebooks: [],
          workspace: undefined,
          _frozen: true,
        },
        cwd: "D:\\current-notebook",
        globalEntries: [
          makeEntry({ path: "D:\\later-workspace", workspace: true }),
        ],
      }),
    ).toEqual({ kind: "cwd", path: "D:\\current-notebook" });
  });

  it("6. 全局空, 走 cwd (selectedNotebook / systemReminderDirectory)", () => {
    expect(
      resolvePrimaryWorkspace({ cwd: "D:\\current-notebook" }),
    ).toEqual({ kind: "cwd", path: "D:\\current-notebook" });
  });

  it("7. 全空时返回 empty", () => {
    expect(resolvePrimaryWorkspace({})).toEqual({ kind: "empty" });
  });

  it("missing=true 的 entry 不被选中", () => {
    expect(
      resolvePrimaryWorkspace({
        globalEntries: [
          makeEntry({
            path: "D:\\missing",
            missing: true,
            workspace: true,
            enabled: true,
          }),
          makeEntry({
            path: "D:\\real",
            workspace: false,
            enabled: true,
            missing: false,
          }),
        ],
      }),
    ).toEqual({ kind: "global.firstEnabled", path: "D:\\real" });
  });

  it("尾部斜杠被 normalize", () => {
    expect(
      resolvePrimaryWorkspace({
        instanceFiles: {
          workspace: "D:\\with-slash\\",
          folders: [],
          notebooks: [],
        },
      }),
    ).toEqual({ kind: "instance.workspace", path: "D:\\with-slash" });
  });
});
