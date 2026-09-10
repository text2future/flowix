import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types";
import {
  areAgentRenderItemsEqual,
  groupAgentMessages,
} from "@features/agent/thread-card/messages/tool-grouping";

function message(
  id: string,
  role: ChatMessage["role"],
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role,
    content: role === "tool" ? "result" : id,
    timestamp: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("groupAgentMessages", () => {
  it("groups only adjacent tools and keeps non-tool rows as boundaries", () => {
    const items = groupAgentMessages([
      message("a1", "assistant"),
      message("t1", "tool"),
      message("t2", "tool"),
      message("a2", "assistant"),
      message("t3", "tool"),
    ]);

    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "tool-group",
      "message",
      "tool-group",
    ]);
    const group = items[1];
    expect(group.kind).toBe("tool-group");
    if (group.kind === "tool-group") {
      expect(group.completedTools.map((tool) => tool.id)).toEqual(["t1", "t2"]);
      expect(group.runningTools).toEqual([]);
      expect(group.totalCount).toBe(2);
      expect(group.status).toBe("completed");
    }
  });

  it("keeps a singleton tool in a tool-group container", () => {
    const [item] = groupAgentMessages([message("t1", "tool")]);
    expect(item.kind).toBe("tool-group");
    if (item.kind === "tool-group") {
      expect(item.completedTools).toHaveLength(1);
      expect(item.runningTools).toHaveLength(0);
      expect(item.totalCount).toBe(1);
    }
  });

  it("separates running tools into the group's trailing render region", () => {
    const running = message("t2", "tool", { isLoading: true, content: "" });
    const [item] = groupAgentMessages([message("t1", "tool"), running]);

    expect(item.kind).toBe("tool-group");
    if (item.kind === "tool-group") {
      expect(item.status).toBe("running");
      expect(item.totalCount).toBe(2);
      expect(item.completedTools.map((tool) => tool.id)).toEqual(["t1"]);
      expect(item.runningTools).toEqual([running]);
    }
  });

  it("moves the final tool from running to completed after its result arrives", () => {
    const [item] = groupAgentMessages([
      message("t1", "tool"),
      message("t2", "tool", { content: "done", isLoading: false }),
    ]);
    expect(item.kind).toBe("tool-group");
    if (item.kind === "tool-group") {
      expect(item.status).toBe("completed");
      expect(item.completedTools.map((tool) => tool.id)).toEqual(["t1", "t2"]);
      expect(item.runningTools).toHaveLength(0);
    }
  });

  it("keeps a completed tool group running until the active turn has assistant content", () => {
    const [waiting] = groupAgentMessages(
      [message("t1", "tool", { isLoading: false })],
      true,
    );
    expect(waiting.kind === "tool-group" && waiting.status).toBe("running");

    const [answered] = groupAgentMessages(
      [
        message("t1", "tool", { isLoading: false }),
        message("a1", "assistant", { content: "result" }),
      ],
      true,
    );
    expect(answered.kind === "tool-group" && answered.status).toBe("completed");
  });

  it("does not infer a running group for a completed non-streaming turn", () => {
    const [item] = groupAgentMessages(
      [message("t1", "tool", { isLoading: false })],
      false,
    );
    expect(item.kind === "tool-group" && item.status).toBe("completed");
  });

  it("does not call an orphaned or failed tool completed", () => {
    const [orphaned] = groupAgentMessages([
      message("t1", "tool", { content: "ok" }),
      message("t2", "tool", { content: "", isLoading: false }),
    ]);
    const [failed] = groupAgentMessages([
      message("t1", "tool", { content: "ok" }),
      message("t2", "tool", { content: "[error] cancelled", isLoading: false }),
    ]);

    expect(orphaned.kind === "tool-group" && orphaned.status).toBe("failed");
    expect(failed.kind === "tool-group" && failed.status).toBe("failed");
  });

  it("compares groups by their message references and state", () => {
    const first = groupAgentMessages([message("t1", "tool"), message("t2", "tool")])[0];
    const same = groupAgentMessages([message("t1", "tool"), message("t2", "tool")])[0];
    expect(areAgentRenderItemsEqual(first, same)).toBe(false);
    expect(areAgentRenderItemsEqual(first, first)).toBe(true);
  });
});
