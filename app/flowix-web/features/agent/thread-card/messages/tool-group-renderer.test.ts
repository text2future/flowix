import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/types";
import type { AgentThreadCardMessageRenderContext } from "@features/agent/thread-card/messages/message-render-context";
import {
  groupAgentMessages,
  type AgentRenderItem,
} from "@features/agent/thread-card/messages/tool-grouping";
import {
  createToolGroupElement,
  updateToolGroupElement,
} from "@features/agent/thread-card/messages/tool-group-renderer";

const BASE = Date.UTC(2026, 10, 17, 8, 0, 0);

function tool(
  id: string,
  options: { callAt: number; resultAt?: number },
): ChatMessage {
  return {
    id,
    role: "tool",
    content: options.resultAt === undefined ? "" : `${id} result`,
    toolName: "read",
    timestamp: new Date(options.callAt).toISOString(),
    sourceTimestamp: options.callAt,
    isLoading: options.resultAt === undefined,
    toolCall: { time: options.callAt },
    toolResult:
      options.resultAt === undefined ? undefined : { time: options.resultAt },
  };
}

function context(isLoading: boolean): AgentThreadCardMessageRenderContext {
  return {
    language: "zh-CN",
    isLoading,
    getReasoningCollapsed: () => false,
    setReasoningCollapsed: () => undefined,
    getDisplayExpanded: () => false,
    setDisplayExpanded: () => undefined,
    isStreaming: () => false,
  };
}

function firstGroup(messages: ChatMessage[], isLoading: boolean) {
  const [item] = groupAgentMessages(messages, isLoading);
  if (item?.kind !== "tool-group") throw new Error("expected a tool group");
  return item as Extract<AgentRenderItem, { kind: "tool-group" }>;
}

function labelOf(element: HTMLElement): string {
  return (
    element.querySelector(".agent-thread-card__tool-group-label")?.textContent ??
    ""
  );
}

describe("tool group header", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("stops the loading state and the duration clock when a user message closes the group", async () => {
    vi.setSystemTime(new Date(BASE + 10_000));
    // The run is still in progress: the trailing tool has no result yet, so
    // the single group renders as running and its duration keeps ticking.
    const running = [
      tool("t1", { callAt: BASE, resultAt: BASE + 4000 }),
      tool("t2", { callAt: BASE + 4000 }),
    ];
    const wrapper = createToolGroupElement({
      group: firstGroup(running, true),
      context: context(true),
    });
    document.body.append(wrapper);

    expect(
      wrapper.classList.contains("agent-thread-card__tool-group--running"),
    ).toBe(true);
    expect(
      wrapper.querySelector(
        ".agent-thread-card__tool-group-header-loading-icon",
      ),
    ).not.toBeNull();
    expect(labelOf(wrapper)).toContain("运行中");
    expect(labelOf(wrapper)).toContain("00:10");

    await vi.advanceTimersByTimeAsync(3000);
    expect(labelOf(wrapper)).toContain("00:13");

    // A steering message lands between the tool rows: the group splits, and
    // the half in front of the user message is finished even though the
    // thread is still producing.
    const split = [
      tool("t1", { callAt: BASE, resultAt: BASE + 4000 }),
      tool("t2", { callAt: BASE + 4000, resultAt: BASE + 9000 }),
      {
        id: "u2",
        role: "user" as const,
        content: "补充一句",
        timestamp: new Date(BASE + 9000).toISOString(),
      },
    ];
    const nextGroup = firstGroup(split, true);
    expect(nextGroup.status).toBe("completed");
    expect(
      updateToolGroupElement(wrapper, {
        group: nextGroup,
        context: context(true),
      }),
    ).toBe(true);

    expect(
      wrapper.classList.contains("agent-thread-card__tool-group--completed"),
    ).toBe(true);
    expect(
      wrapper.querySelector(
        ".agent-thread-card__tool-group-header-loading-icon",
      ),
    ).toBeNull();
    const settled = labelOf(wrapper);
    expect(settled).toContain("已完成 2 个步骤");
    expect(settled).toContain("00:09");

    // The row exits after its minimum visible dwell time; the clock must stay
    // at the final tool result instead of following the wall clock.
    await vi.advanceTimersByTimeAsync(3000);
    expect(
      wrapper.querySelector(".agent-thread-card__tool-group-running-tool"),
    ).toBeNull();
    expect(labelOf(wrapper)).toBe(settled);
  });
});
