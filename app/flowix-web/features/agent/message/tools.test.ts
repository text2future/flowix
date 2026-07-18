import { describe, expect, it } from "vitest";

import {
  getToolIconPath,
  getToolLabel,
  getToolMeta,
} from "@features/agent/message/tools";
import { TOOL_ICON_PATHS } from "@features/agent/message/tool-icon-paths";

describe("agent tool metadata", () => {
  it("maps web search names to localized labels and globe icon", () => {
    expect(getToolLabel("web_search", "zh-CN")).toBe("网络搜索");
    expect(getToolLabel("web_search", "en-US")).toBe("Web Search");
    expect(getToolMeta("web_search_call")?.name).toBe("web_search");
    expect(getToolMeta("search_query")?.name).toBe("web_search");
    expect(getToolMeta("network_search")?.name).toBe("web_search");
    expect(getToolMeta("web search")?.name).toBe("web_search");
    expect(
      getToolMeta({ agentType: "codex", toolName: "web_search_call" })?.name,
    ).toBe("web_search");
    expect(
      getToolLabel({ agentType: "codex", toolName: "web_search" }, "en-US"),
    ).toBe("Web Search");
    expect(
      getToolIconPath({ agentType: "codex", toolName: "web_search" }),
    ).toBe(TOOL_ICON_PATHS.globe);
    expect(getToolIconPath("web_search")).toBe(TOOL_ICON_PATHS.globe);
  });
});

describe("update_plan tool metadata", () => {
  it("resolves canonical name to Plan label and checkSquare icon", () => {
    expect(getToolMeta("update_plan")?.name).toBe("update_plan");
    expect(getToolLabel("update_plan", "zh-CN")).toBe("计划");
    expect(getToolLabel("update_plan", "en-US")).toBe("Plan");
    expect(getToolIconPath("update_plan")).toBe(TOOL_ICON_PATHS.checks);
    expect(
      getToolIconPath({ agentType: "codex", toolName: "update_plan" }),
    ).toBe(TOOL_ICON_PATHS.checks);
  });
});

describe("Codex tool-family metadata", () => {
  it.each([
    ["mcp_tool_call", "MCP"],
    ["file_change", "编辑"],
    ["tool_search", "检索"],
  ] as const)("uses the concise Chinese label for %s", (toolName, label) => {
    expect(
      getToolLabel({ agentType: "codex", toolName }, "zh-CN"),
    ).toBe(label);
  });

  it.each([
    ["mcp_tool_call", "MCP Tool", TOOL_ICON_PATHS.plug],
    ["file_change", "Edited", TOOL_ICON_PATHS.fileCode],
    ["image_generation", "Image Generation", TOOL_ICON_PATHS.image],
    ["image_generation_call", "Image Generation", TOOL_ICON_PATHS.image],
    ["dynamic_tool_call", "Dynamic Tool", TOOL_ICON_PATHS.wrench],
    [
      "collab_agent_tool_call",
      "Collaboration Agent",
      TOOL_ICON_PATHS.usersThree,
    ],
    ["tool_search", "Explored", TOOL_ICON_PATHS.magnifyPlus],
    ["tool_search_call", "Explored", TOOL_ICON_PATHS.magnifyPlus],
    ["tool_search_output", "Explored", TOOL_ICON_PATHS.magnifyPlus],
  ] as const)("maps %s to its dedicated icon", (toolName, label, iconPath) => {
    const lookup = { agentType: "codex" as const, toolName };
    expect(getToolLabel(lookup, "en-US")).toBe(label);
    expect(getToolIconPath(lookup)).toBe(iconPath);
  });

  it("keeps Codex-only names scoped to the Codex runtime", () => {
    expect(getToolMeta("mcp_tool_call")).toBeUndefined();
    expect(getToolMeta({ agentType: "codex", toolName: "mcp_tool_call" })?.name)
      .toBe("mcp_tool_call");
  });
});

describe("Codex function-tool metadata", () => {
  it("uses 查看图片 as the Chinese view_image label", () => {
    expect(
      getToolLabel({ agentType: "codex", toolName: "view_image" }, "zh-CN"),
    ).toBe("查看图片");
  });

  it("uses 补丁 as the Chinese apply_patch label", () => {
    expect(getToolLabel("apply_patch", "zh-CN")).toBe("补丁");
    expect(
      getToolLabel({ agentType: "codex", toolName: "apply_patch" }, "zh-CN"),
    ).toBe("编辑");
  });

  it("uses 运行 as the Chinese command-tool label", () => {
    expect(
      getToolLabel({ agentType: "codex", toolName: "exec" }, "zh-CN"),
    ).toBe("运行");
    expect(
      getToolLabel({ agentType: "codex", toolName: "exec_command" }, "zh-CN"),
    ).toBe("运行");
  });

  it.each([
    ["list_mcp_resources", "Explored", TOOL_ICON_PATHS.plug],
    [
      "list_mcp_resource_templates",
      "Explored",
      TOOL_ICON_PATHS.plug,
    ],
    ["read_mcp_resource", "Explored", TOOL_ICON_PATHS.plug],
    ["get_goal", "Get Goal", TOOL_ICON_PATHS.checks],
    ["create_goal", "Create Goal", TOOL_ICON_PATHS.checks],
    ["update_goal", "Update Goal", TOOL_ICON_PATHS.checks],
    ["view_image", "View Image", TOOL_ICON_PATHS.image],
    ["exec", "Ran", TOOL_ICON_PATHS.terminal],
    ["wait", "Ran", TOOL_ICON_PATHS.terminal],
    ["write_stdin", "Ran", TOOL_ICON_PATHS.terminal],
    ["exec_command", "Ran", TOOL_ICON_PATHS.terminal],
    ["apply_patch", "Edited", TOOL_ICON_PATHS.filePlus],
  ] as const)("maps %s from function_call.name", (toolName, label, iconPath) => {
    const lookup = { agentType: "codex" as const, toolName };
    expect(getToolLabel(lookup, "en-US")).toBe(label);
    expect(getToolIconPath(lookup)).toBe(iconPath);
  });

  it("keeps Codex-specific function names scoped", () => {
    expect(getToolMeta("get_goal")).toBeUndefined();
    expect(getToolMeta({ agentType: "codex", toolName: "get_goal" })?.name)
      .toBe("get_goal");
  });
});
