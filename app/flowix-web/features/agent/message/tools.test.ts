import { describe, expect, it } from "vitest";

import {
  getToolIconPath,
  getToolLabel,
  getToolMeta,
  TOOL_ICON_PATHS,
} from "@features/agent/message/tools";

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
