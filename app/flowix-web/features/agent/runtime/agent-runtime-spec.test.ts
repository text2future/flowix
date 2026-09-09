import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentRuntimeConfig,
  getAgentAccessOptions,
  getAgentRuntimeSpec,
  normalizeCodexPermissionMode,
  normalizeDshPermissionMode,
  supportsAgentEmptySettings,
  supportsAgentRuntimeSetting,
} from "@features/agent/runtime/agent-runtime-spec";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@features/memo/components/notebook-icon", () => ({
  getNotebookIconMarkup: () => null,
}));

describe("workspace capabilities", () => {
  it("locks the Codex workspace after the conversation starts", () => {
    const codex = getAgentRuntimeSpec("codex").workspace;
    expect(codex.selectBeforeFirstRun).toBe(false);
    expect(codex.switchWhileRunning).toBe(false);
    expect(codex.switchBetweenRuns).toBe(false);
    expect(codex.switchRequiresRuntimeRestart).toBe(false);
    expect(codex.preservesConversationSession).toBe(true);
    expect(getAgentRuntimeSpec("deepseek-harness").workspace.switchBetweenRuns).toBe(false);
    for (const type of ["claude", "opencode"] as const) {
      expect(getAgentRuntimeSpec(type).workspace.switchBetweenRuns).toBe(false);
    }
  });
});

describe("buildAgentRuntimeConfig — 「资料列表 + 当前笔记本」派生", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("完全没输入时返回 cwd=undefined / workspacePaths=[] (dispatch 据此判断是否拦截)", () => {
    const result = buildAgentRuntimeConfig({
      typeKey: "claude",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "low",
    });
    expect(result.claude?.cwd).toBeUndefined();
    expect(result.claude?.workspacePaths).toEqual([]);
  });

  it("资料目录始终是 add-dir, cwd 固定为当前笔记本", () => {
    const result = buildAgentRuntimeConfig({
      typeKey: "deepseek-harness",
      notebookPath: "D:\\当前笔记本",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "low",
      defaultFiles: {
        workspace: "D:\\资料主空间",
        folders: ["D:\\资料主空间", "D:\\第二份资料"],
        notebooks: [],
      },
    });
    expect(result.deepseekHarness?.cwd).toBe("D:\\当前笔记本");
    expect(result.deepseekHarness?.workspacePaths).toEqual([
      "D:\\资料主空间",
      "D:\\第二份资料",
    ]);
  });

  it("没有显式主空间时 cwd 仍固定为笔记本", () => {
    const result = buildAgentRuntimeConfig({
      typeKey: "deepseek-harness",
      notebookPath: "D:\\当前笔记本",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "low",
      defaultFiles: {
        workspace: undefined,
        folders: ["D:\\第一份", "D:\\第二份"],
        notebooks: [],
      },
    });
    expect(result.deepseekHarness?.cwd).toBe("D:\\当前笔记本");
    expect(result.deepseekHarness?.workspacePaths).toEqual(["D:\\第一份", "D:\\第二份"]);
  });

  it("资料列表为空 (没添加资料), cwd 退到当前笔记本路径", () => {
    const result = buildAgentRuntimeConfig({
      typeKey: "deepseek-harness",
      notebookPath: "D:\\当前笔记本",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "low",
      defaultFiles: { folders: [], notebooks: [], workspace: undefined },
    });
    expect(result.deepseekHarness?.cwd).toBe("D:\\当前笔记本");
    expect(result.deepseekHarness?.workspacePaths).toEqual([]);
  });

  it("未传 defaultFiles 时, 仅当前笔记本作为 cwd", () => {
    const result = buildAgentRuntimeConfig({
      typeKey: "claude",
      notebookPath: "D:\\当前笔记本",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "low",
    });
    expect(result.claude?.cwd).toBe("D:\\当前笔记本");
    expect(result.claude?.workspacePaths).toEqual([]);
  });

  it("workspaceSnapshot preserves legacy cwd but treats notebook as new primary", () => {
    const result = buildAgentRuntimeConfig({
      typeKey: "codex",
      notebookPath: "/notes/changed",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "low",
      defaultFiles: {
        workspace: "/projects/changed",
        folders: ["/projects/changed"],
        notebooks: [],
      },
      workspaceSnapshot: {
        version: 1,
        cwd: "/projects/original",
        workspacePaths: ["/projects/original", "/notes/original"],
        notebookId: "nb-original",
        notebookPath: "/notes/original",
        capturedAt: 1,
      },
    });

    // The snapshot was resolved from the notebook's file settings immediately
    // before its first run. Live notebook/default changes must not replace it.
    expect(result.codex?.cwd).toBe("/projects/original");
    expect(result.codex?.workspacePaths).toEqual(["/notes/original"]);
  });

  it("instance 里的 model / permission / reasoningEffort 覆盖 chat-store 全局值", () => {
    const result = buildAgentRuntimeConfig({
      typeKey: "codex",
      notebookPath: "/tmp/project",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "medium",
      instanceRuntimeConfig: {
        model: { key: "gpt-5.5" },
        access: { sandbox: "yolo" },
        reasoningEffort: "high",
      },
    });
    expect(result.codex?.model).toBe("gpt-5.5");
    expect(result.codex?.permissionMode).toBe("danger-full-access");
    expect(result.codex?.reasoningEffort).toBe("high");
  });

  it("DeepSeek Harness exposes model before mode and permission and sends the card overrides", () => {
    const result = buildAgentRuntimeConfig({
      typeKey: "deepseek-harness",
      notebookPath: "/tmp/notebook",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "medium",
      instanceRuntimeConfig: {
        model: { key: "deepseek-v4-pro", providerId: "provider-b" },
        deepseekHarness: { mode: "code" },
      },
    });

    expect(result.deepseekHarness?.mode).toBe("code");
    expect(result.deepseekHarness?.model).toBe("deepseek-v4-pro");
    expect(result.deepseekHarness?.providerId).toBe("provider-b");
    expect(getAgentRuntimeSpec("deepseek-harness").emptySettings).toEqual([
      "model",
      "mode",
      "permission",
    ]);
  });

  it("DeepSeek Harness inherit 时不序列化模型, 选定后透传卡片模型", () => {
    const inherited = buildAgentRuntimeConfig({
      typeKey: "deepseek-harness",
      notebookPath: "/tmp/project",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "medium",
    });
    expect(inherited.deepseekHarness?.model).toBe("inherit");

    const selected = buildAgentRuntimeConfig({
      typeKey: "deepseek-harness",
      notebookPath: "/tmp/project",
      permissionMode: "workspace-write",
      codexModel: "deepseek-v4-pro",
      codexReasoningEffort: "medium",
    });
    expect(selected.deepseekHarness?.model).toBe("deepseek-v4-pro");
  });

  it("DeepSeek Harness supports empty-card runtime settings for files (空状态设置区仍可用)", () => {
    expect(supportsAgentEmptySettings("deepseek-harness")).toBe(true);
    expect(supportsAgentEmptySettings("codex")).toBe(true);
    expect(supportsAgentEmptySettings("claude")).toBe(true);
    expect(supportsAgentEmptySettings("deepseek-harness")).toBe(true);
    expect(supportsAgentRuntimeSetting("deepseek-harness", "model")).toBe(true);
    expect(supportsAgentRuntimeSetting("deepseek-harness", "mode")).toBe(true);
    expect(supportsAgentRuntimeSetting("deepseek-harness", "permission")).toBe(true);
  });

  it("omits yolo from Codex App Server access options", () => {
    expect(getAgentAccessOptions("codex").map((option) => option.id)).toEqual([
      "danger-full-access",
      "workspace-write",
      "read-only",
    ]);
    expect(getAgentAccessOptions("claude").map((option) => option.id)).not.toContain(
      "yolo",
    );
  });

  it("migrates legacy Codex yolo selection to full access", () => {
    const result = buildAgentRuntimeConfig({
      typeKey: "codex",
      notebookPath: "/tmp/project",
      permissionMode: "yolo",
      codexModel: "inherit",
      codexReasoningEffort: "medium",
    });

    expect(normalizeCodexPermissionMode("yolo")).toBe("danger-full-access");
    expect(result.codex?.permissionMode).toBe("danger-full-access");
  });

  it("migrates legacy Claude yolo selection to full access", () => {
    const result = buildAgentRuntimeConfig({
      typeKey: "claude",
      notebookPath: "/tmp/project",
      permissionMode: "yolo",
      codexModel: "inherit",
      codexReasoningEffort: "medium",
    });

    expect(result.claude?.permissionMode).toBe("danger-full-access");
  });

  it("DeepSeek Harness 默认回落 danger-full-access, 与所有 agent 统一", () => {
    expect(normalizeDshPermissionMode(undefined)).toBe("danger-full-access");
    expect(normalizeDshPermissionMode("inherit")).toBe("danger-full-access");
    expect(normalizeDshPermissionMode("yolo")).toBe("danger-full-access");
    expect(normalizeDshPermissionMode("unknown" as never)).toBe(
      "danger-full-access",
    );
    expect(normalizeDshPermissionMode("read-only")).toBe("read-only");
    expect(normalizeDshPermissionMode("workspace-write")).toBe(
      "workspace-write",
    );
    expect(normalizeDshPermissionMode("danger-full-access")).toBe(
      "danger-full-access",
    );
  });

  it("DeepSeek Harness 卡片显式选择的权限仍生效", () => {
    const explicit = buildAgentRuntimeConfig({
      typeKey: "deepseek-harness",
      notebookPath: "/tmp/project",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "medium",
      instanceRuntimeConfig: {
        access: { sandbox: "read-only" },
      },
    });
    expect(explicit.deepseekHarness?.permissionMode).toBe("read-only");
  });

  it("DeepSeek Harness 权限选项不含 yolo, 默认完全访问", () => {
    expect(getAgentAccessOptions("deepseek-harness").map((o) => o.id)).toEqual([
      "danger-full-access",
      "workspace-write",
      "read-only",
    ]);
  });
});
