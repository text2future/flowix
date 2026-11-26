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

describe("Pi tool-family metadata", () => {
  it("gives Pi's built-in find the file-search label instead of the shell fallback", () => {
    expect(getToolLabel({ agentType: "pi", toolName: "find" }, "zh-CN")).toBe("查找文件");
    expect(getToolLabel({ agentType: "pi", toolName: "find" }, "en-US")).toBe("Find Files");
    expect(getToolIconPath({ agentType: "pi", toolName: "find" }))
      .toBe(TOOL_ICON_PATHS.magnify);
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
    ["mcp_tool_call", "MCP Tool", TOOL_ICON_PATHS.eject],
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

describe("DeepSeek Harness tool metadata", () => {
  it.each([
    ["pwsh", "运行", TOOL_ICON_PATHS.terminal],
    ["subagent", "智能体", TOOL_ICON_PATHS.globe],
    ["subagent_fork", "智能体", TOOL_ICON_PATHS.globe],
    ["ralph", "智能体", TOOL_ICON_PATHS.globe],
    ["workflow", "智能体", TOOL_ICON_PATHS.globe],
    ["send_message", "发送消息", TOOL_ICON_PATHS.chatCircleText],
    ["interrupt_agent", "中断智能体", TOOL_ICON_PATHS.pause],
    ["list_agents", "智能体列表", TOOL_ICON_PATHS.usersThree],
    ["skill", "加载技能", TOOL_ICON_PATHS.fileText],
    ["get_goal", "查看目标", TOOL_ICON_PATHS.checks],
    ["exit_plan_mode", "提交计划", TOOL_ICON_PATHS.fileText],
    ["job_list", "后台任务列表", TOOL_ICON_PATHS.arrowsClockwise],
    ["job_output", "读取后台任务", TOOL_ICON_PATHS.arrowsClockwise],
    ["job_kill", "停止后台任务", TOOL_ICON_PATHS.pause],
    ["cordis_define", "Cordis 插件", TOOL_ICON_PATHS.plug],
    ["cordis_run", "Cordis 插件", TOOL_ICON_PATHS.plug],
    ["cordis_inspect_self", "Cordis 插件", TOOL_ICON_PATHS.plug],
    ["todo_write", "计划", TOOL_ICON_PATHS.checks],
  ] as const)("maps %s to label and icon via wildcard", (toolName, label, iconPath) => {
    const lookup = { agentType: "dsh" as const, toolName };
    expect(getToolLabel(lookup, "zh-CN")).toBe(label);
    expect(getToolIconPath(lookup)).toBe(iconPath);
  });

  it("keeps the codex-specific get_goal entry winning for codex", () => {
    expect(getToolMeta({ agentType: "codex", toolName: "get_goal" })?.name)
      .toBe("get_goal");
    expect(getToolMeta("get_goal")?.name).toBe("get_goal");
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
    ["list_mcp_resources", "Explored", TOOL_ICON_PATHS.eject],
    [
      "list_mcp_resource_templates",
      "Explored",
      TOOL_ICON_PATHS.eject,
    ],
    ["read_mcp_resource", "Explored", TOOL_ICON_PATHS.eject],
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
    // get_goal 起初是 Codex 专属, DeepSeek Harness goal 工具族上线后改为
    // 通配条目 ── 通配与 codex 专属记录的 label/icon 相同, 两条都命中。
    expect(getToolMeta("get_goal")?.labelKey).toBe("agent.tools.getGoal");
    expect(getToolMeta({ agentType: "codex", toolName: "get_goal" })?.name)
      .toBe("get_goal");
  });
});
