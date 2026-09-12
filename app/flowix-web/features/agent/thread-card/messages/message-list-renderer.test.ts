import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/types";
import {
  createRenderedAgentMessageList,
  isCurrentTurnMessage,
  isLastMessageInTurnAndAssistant,
  type AgentThreadCardMessageRenderContext,
} from "@features/agent/thread-card/messages/message-list-renderer";

function message(
  id: string,
  role: ChatMessage["role"],
  codexTurnId?: string,
  turnDurationMs?: number,
): ChatMessage {
  return {
    id,
    role,
    content: id,
    timestamp: "2026-08-29T00:00:00.000Z",
    isCompleted: true,
    codexTurnId,
    turnDurationMs,
  };
}

function context(isLoading = false): AgentThreadCardMessageRenderContext {
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

describe("Codex turn-end message actions", () => {
  it("shows copy and time only on the final assistant for agents without turn ids", () => {
    const messages = [
      message("assistant-1", "assistant"),
      message("tool-1", "tool"),
      message("assistant-2", "assistant"),
    ];

    expect(isLastMessageInTurnAndAssistant(messages, 0)).toBe(false);
    expect(isLastMessageInTurnAndAssistant(messages, 2)).toBe(true);

    const { list } = createRenderedAgentMessageList(messages, context());
    expect(list.querySelectorAll(".agent-thread-card__message-actions")).toHaveLength(1);
    expect(list.children[0].querySelector(".agent-thread-card__message-actions")).toBeNull();
    const actions = list.children[2].querySelector(".agent-thread-card__message-actions");
    expect(actions).not.toBeNull();
    expect(actions?.querySelectorAll(".agent-thread-card__message-action")).toHaveLength(1);
    expect(actions?.querySelector(".agent-thread-card__message-time")?.textContent).toContain("星期");
  });

  it("does not show actions when a tool is the final message of the turn", () => {
    const messages = [
      message("user-1", "user"),
      message("assistant-1", "assistant"),
      message("tool-1", "tool"),
    ];

    expect(isLastMessageInTurnAndAssistant(messages, 1)).toBe(false);

    const { list } = createRenderedAgentMessageList(messages, context());
    expect(list.querySelectorAll(".agent-thread-card__message-actions")).toHaveLength(0);
  });

  it("keeps actions only on the final assistant when non-assistant rows lack a turn id", () => {
    const messages = [
      message("assistant-1", "assistant", "turn-1"),
      message("reasoning-1", "reasoning"),
      message("assistant-2", "assistant", "turn-1"),
    ];

    expect(isLastMessageInTurnAndAssistant(messages, 0)).toBe(false);
    expect(isLastMessageInTurnAndAssistant(messages, 2)).toBe(true);

    const { list } = createRenderedAgentMessageList(messages, context());
    expect(list.querySelectorAll(".agent-thread-card__message-actions")).toHaveLength(1);
    expect(list.children[0].querySelector(".agent-thread-card__message-actions")).toBeNull();
    expect(list.children[2].querySelector(".agent-thread-card__message-actions")).not.toBeNull();
  });

  it("shows actions at the end of each distinct Codex turn", () => {
    const messages = [
      message("assistant-1", "assistant", "turn-1"),
      message("assistant-2", "assistant", "turn-2"),
    ];

    const { list } = createRenderedAgentMessageList(messages, context());
    expect(list.querySelectorAll(".agent-thread-card__message-actions")).toHaveLength(2);
  });

  it("shows the turn duration after the message date", () => {
    const { list } = createRenderedAgentMessageList(
      [message("assistant-1", "assistant", "turn-1", 69078)],
      context(),
    );
    const actions = list.querySelector(".agent-thread-card__message-actions");
    expect(actions?.textContent).toContain("1分9秒");
    expect(
      actions?.querySelector(".agent-thread-card__message-time")?.nextElementSibling
        ?.classList.contains("agent-thread-card__message-duration"),
    ).toBe(true);
  });

  it("omits zero minutes from a short Chinese duration", () => {
    const { list } = createRenderedAgentMessageList(
      [message("assistant-1", "assistant", "turn-1", 5000)],
      context(),
    );
    expect(list.querySelector(".agent-thread-card__message-actions")?.textContent)
      .toContain("5秒");
    expect(list.querySelector(".agent-thread-card__message-actions")?.textContent)
      .not.toContain("0分");
  });

  it("does not show actions while the turn is still streaming", () => {
    const messages = [message("assistant-1", "assistant", "turn-1")];
    const streamingContext = { ...context(), isLoading: true };

    const { list } = createRenderedAgentMessageList(messages, streamingContext);
    expect(list.querySelector(".agent-thread-card__message-actions")).toBeNull();
  });

  it("keeps historical actions while hiding only the current no-id agent turn", () => {
    const messages = [
      message("user-1", "user"),
      message("assistant-1", "assistant"),
      message("user-2", "user"),
      { ...message("assistant-2", "assistant"), isCompleted: false },
    ];
    const streamingContext = { ...context(), isLoading: true };

    expect(isCurrentTurnMessage(messages[1], messages)).toBe(false);
    expect(isCurrentTurnMessage(messages[3], messages)).toBe(true);
    expect(isLastMessageInTurnAndAssistant(messages, 1)).toBe(true);
    expect(isLastMessageInTurnAndAssistant(messages, 3)).toBe(false);

    const { list } = createRenderedAgentMessageList(messages, streamingContext);
    expect(
      list.querySelectorAll(".agent-thread-card__message-actions"),
    ).toHaveLength(1);
    expect(
      list.children[1].querySelector(".agent-thread-card__message-actions"),
    ).not.toBeNull();
    expect(
      list.children[3].querySelector(".agent-thread-card__message-actions"),
    ).toBeNull();
  });

  it("uses Codex turn ids while including id-less reasoning and tool rows in the current turn", () => {
    const messages = [
      message("user-1", "user", "turn-1"),
      message("assistant-1", "assistant", "turn-1"),
      message("user-2", "user", "turn-2"),
      message("reasoning-2", "reasoning"),
      message("tool-2", "tool"),
      message("assistant-2a", "assistant", "turn-2"),
      {
        ...message("assistant-2b", "assistant", "turn-2"),
        isCompleted: false,
      },
    ];
    const streamingContext = { ...context(), isLoading: true };

    expect(isCurrentTurnMessage(messages[1], messages)).toBe(false);
    expect(isCurrentTurnMessage(messages[3], messages)).toBe(true);
    expect(isCurrentTurnMessage(messages[5], messages)).toBe(true);
    expect(isCurrentTurnMessage(messages[6], messages)).toBe(true);
    expect(isLastMessageInTurnAndAssistant(messages, 5)).toBe(false);

    const { list } = createRenderedAgentMessageList(messages, streamingContext);
    expect(
      list.children[1].querySelector(".agent-thread-card__message-actions"),
    ).not.toBeNull();
    expect(
      list.children[5].querySelector(".agent-thread-card__message-actions"),
    ).toBeNull();
    expect(
      list.children[6].querySelector(".agent-thread-card__message-actions"),
    ).toBeNull();
  });

  it("shows a check for one second after copying succeeds", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { list } = createRenderedAgentMessageList(
      [message("assistant-1", "assistant", "turn-1")],
      context(),
    );
    const copyButton = list.querySelector<HTMLButtonElement>(
      ".agent-thread-card__message-action",
    );
    expect(copyButton).not.toBeNull();

    copyButton?.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("assistant-1");
    expect(copyButton?.dataset.state).toBe("copied");
    vi.advanceTimersByTime(999);
    expect(copyButton?.dataset.state).toBe("copied");
    vi.advanceTimersByTime(1);
    expect(copyButton?.dataset.state).toBe("");
    vi.useRealTimers();
  });

  it("requires inline fork confirmation and does not fork on cancel", () => {
    const onFork = vi.fn();
    const { list } = createRenderedAgentMessageList(
      [message("assistant-1", "assistant", "turn-1")],
      { ...context(), onForkMessage: onFork },
    );
    const buttons = list.querySelectorAll<HTMLButtonElement>(
      ".agent-thread-card__message-action",
    );
    const forkButton = buttons[1];
    forkButton.click();
    const confirmation = list.querySelector<HTMLElement>(
      ".agent-thread-card__message-fork-confirm",
    );
    expect(confirmation).not.toBeNull();
    expect(confirmation?.previousElementSibling).toBe(forkButton);
    forkButton.click();
    expect(list.querySelectorAll(".agent-thread-card__message-fork-confirm")).toHaveLength(0);
    expect(onFork).not.toHaveBeenCalled();

    forkButton.click();
    list.querySelector<HTMLButtonElement>(
      ".agent-thread-card__message-fork-cancel-button",
    )?.click();
    expect(onFork).not.toHaveBeenCalled();

    forkButton.click();
    list.querySelector<HTMLButtonElement>(
      ".agent-thread-card__message-fork-confirm-button",
    )?.click();
    expect(onFork).toHaveBeenCalledWith(expect.objectContaining({ id: "assistant-1" }));
  });

  it("keeps the fork confirmation available while crossing the message action area", () => {
    const onFork = vi.fn();
    const { list } = createRenderedAgentMessageList(
      [message("assistant-1", "assistant", "turn-1")],
      { ...context(), onForkMessage: onFork },
    );
    const item = list.firstElementChild as HTMLElement;
    const forkButton = list.querySelectorAll<HTMLButtonElement>(
      ".agent-thread-card__message-action",
    )[1];

    forkButton.click();
    expect(list.querySelector(".agent-thread-card__message-fork-confirm")).not.toBeNull();
    forkButton.click();
    expect(list.querySelector(".agent-thread-card__message-fork-confirm")).toBeNull();

    forkButton.click();
    expect(list.querySelector(".agent-thread-card__message-fork-confirm")).not.toBeNull();
    item.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));

    expect(list.querySelector(".agent-thread-card__message-fork-confirm")).not.toBeNull();
    expect(forkButton.style.visibility).toBe("");

    list.querySelector<HTMLButtonElement>(
      ".agent-thread-card__message-fork-confirm-button",
    )?.click();
    expect(onFork).toHaveBeenCalledWith(expect.objectContaining({ id: "assistant-1" }));
  });

  it("closes the fork confirmation when clicking outside the actions", () => {
    const { list } = createRenderedAgentMessageList(
      [message("assistant-1", "assistant", "turn-1")],
      context(),
    );
    const forkButton = list.querySelectorAll<HTMLButtonElement>(
      ".agent-thread-card__message-action",
    )[1];

    forkButton.click();
    expect(list.querySelector(".agent-thread-card__message-fork-confirm")).not.toBeNull();
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

    expect(list.querySelector(".agent-thread-card__message-fork-confirm")).toBeNull();
  });
});

describe("continuous tool group rendering", () => {
  function tool(
    id: string,
    overrides: Partial<ChatMessage> = {},
  ): ChatMessage {
    return {
      id,
      role: "tool",
      content: "done",
      timestamp: "2026-09-03T00:00:00.000Z",
      toolName: "read",
      toolInput: { path: `${id}.md`, extra: "preserved" },
      isLoading: false,
      ...overrides,
    };
  }

  it("renders adjacent tools as one top-level group with independently expandable inputs", () => {
    const { list } = createRenderedAgentMessageList(
      [tool("tool-1"), tool("tool-2"), tool("tool-3")],
      context(),
    );

    expect(list.children).toHaveLength(1);
    const group = list.firstElementChild as HTMLElement;
    expect(group.classList.contains("agent-thread-card__tool-group")).toBe(true);
    expect(group.querySelector(".agent-thread-card__tool-group-header")?.textContent)
      .toContain("已完成 3 个步骤");
    expect(group.querySelector(".agent-thread-card__tool-group-loading-icon"))
      .toBeNull();
    expect(group.querySelectorAll(".agent-thread-card__tool-group-completed-tools > .agent-thread-card__message"))
      .toHaveLength(0);
    group.querySelector<HTMLButtonElement>(
      ".agent-thread-card__tool-group-header",
    )?.click();
    expect(group.classList.contains("agent-thread-card__tool-group--expanded")).toBe(true);
    expect(group.querySelectorAll(".agent-thread-card__tool-group-completed-tools > .agent-thread-card__message"))
      .toHaveLength(3);

    const inputToggle = group.querySelector<HTMLButtonElement>(
      ".agent-thread-card__tool-group-completed-tools .agent-thread-card__message-tool-toggle",
    );
    inputToggle?.click();
    expect(group.textContent).toContain('"path": "tool-1.md"');
    expect(group.textContent).toContain('"extra": "preserved"');
  });

  it("uses the same group container for a singleton tool", () => {
    const { list } = createRenderedAgentMessageList([tool("tool-1")], context());

    expect(list.children).toHaveLength(1);
    expect(list.querySelector(".agent-thread-card__tool-group-header")?.textContent)
      .toContain("已完成 1 个步骤");
    expect(list.querySelectorAll(".agent-thread-card__tool-group-completed-tools > .agent-thread-card__message"))
      .toHaveLength(0);

    list.querySelector<HTMLButtonElement>(
      ".agent-thread-card__tool-group-header",
    )?.click();
    expect(list.querySelectorAll(".agent-thread-card__tool-group-completed-tools > .agent-thread-card__message"))
      .toHaveLength(1);
  });

  it("counts only completed tools in the group title, including zero", () => {
    const { list } = createRenderedAgentMessageList([
      tool("tool-1", { isLoading: true, content: "" }),
      tool("tool-2", { isLoading: false, content: "done" }),
    ], context());

    expect(list.textContent).toContain("已完成 1 个步骤");

    const { list: runningList } = createRenderedAgentMessageList([
      tool("running-only", { isLoading: true, content: "" }),
    ], context());
    expect(runningList.textContent).toContain("已完成 0 个步骤");
  });

  it("shows the running spinner in the title bar while waiting for assistant content", () => {
    const { list } = createRenderedAgentMessageList(
      [tool("tool-1", { isLoading: false })],
      context(true),
    );
    const group = list.firstElementChild as HTMLElement;
    const header = group.querySelector<HTMLElement>(
      ".agent-thread-card__tool-group-header",
    );

    expect(group.classList.contains("agent-thread-card__tool-group--running")).toBe(true);
    expect(
      header?.querySelector(
        ".agent-thread-card__tool-group-header-loading-icon",
      ),
    ).not.toBeNull();
    expect(
      group.querySelector(
        ".agent-thread-card__tool-group-running-tools",
      )?.children,
    ).toHaveLength(0);
  });

  it("stops the title spinner once assistant content follows the tool group", () => {
    const { list } = createRenderedAgentMessageList(
      [
        tool("tool-1", { isLoading: false }),
        {
          id: "assistant-1",
          role: "assistant",
          content: "done",
          timestamp: "2026-09-03T00:00:00.000Z",
        },
      ],
      context(true),
    );
    const group = list.firstElementChild as HTMLElement;

    expect(group.classList.contains("agent-thread-card__tool-group--completed")).toBe(true);
    expect(
      group.querySelector(
        ".agent-thread-card__tool-group-header-loading-icon",
      ),
    ).toBeNull();
  });

  it("shows duration from tool timestamps", () => {
    const { list } = createRenderedAgentMessageList([
      tool("tool-1", {
        timestamp: "2026-09-03T00:00:00.000Z",
        sourceTimestamp: Date.parse("2026-09-03T00:00:00.000Z"),
      }),
      tool("tool-2", {
        timestamp: "2026-09-03T00:01:02.000Z",
        sourceTimestamp: Date.parse("2026-09-03T00:01:02.000Z"),
      }),
    ], context());

    expect(list.textContent).toContain("已完成 2 个步骤 · 01:02");
  });

  it("uses raw tool call/result timestamps for the completed group", () => {
    const { list } = createRenderedAgentMessageList([
      tool("tool-1", {
        timestamp: "2026-09-06T10:00:02.000Z",
        toolCall: { type: "tool/call", time: "2026-09-06T10:00:00.000Z" },
        toolResult: { type: "tool/result", time: "2026-09-06T10:00:02.000Z" },
      }),
    ], context());

    expect(list.textContent).toContain("已完成 1 个步骤 · 00:02");
  });

  it("does not display 0s for a sub-second raw tool timeline", () => {
    const { list } = createRenderedAgentMessageList([
      tool("tool-1", {
        timestamp: "2026-09-06T10:00:00.034Z",
        toolCall: { type: "tool/call", time: "2026-09-06T10:00:00.000Z" },
        toolResult: { type: "tool/result", time: "2026-09-06T10:00:00.034Z" },
      }),
    ], context());

    expect(list.textContent).toContain("已完成 1 个步骤");
    expect(list.textContent).not.toContain("0s");
  });

  it("does not show Codex duration from provider item durationMs alone", () => {
    const { list } = createRenderedAgentMessageList([
      tool("tool-1", {
        toolAgentType: "codex",
        toolData: JSON.stringify({ durationMs: 1200 }),
      }),
      tool("tool-2", {
        toolAgentType: "codex",
        toolData: JSON.stringify({ durationMs: 2800 }),
      }),
    ], context());

    expect(list.textContent).toContain("已完成 2 个步骤");
    expect(list.textContent).not.toContain("·");
  });

  it("does not show duration for generated timestamps without a trusted signal", () => {
    const { list } = createRenderedAgentMessageList([
      tool("tool-1", { timestamp: "2026-09-03T00:00:00.000Z" }),
      tool("tool-2", { timestamp: "2026-09-03T00:01:02.000Z" }),
    ], context());

    expect(list.textContent).toContain("已完成 2 个步骤");
    expect(list.textContent).not.toContain("·");
  });

  it("does not show duration when a tool in the group lacks raw event timing", () => {
    const { list } = createRenderedAgentMessageList([
      tool("tool-1", {
        toolCall: { type: "tool/call", time: "2026-09-03T00:00:00.000Z" },
        toolResult: { type: "tool/result", time: "2026-09-03T00:00:01.000Z" },
      }),
      tool("tool-2"),
    ], context());

    expect(list.textContent).not.toContain("·");
  });

  it("renders completed tools before the dedicated running-tools region", () => {
    const running = tool("tool-2", { isLoading: true, content: "" });
    const { list } = createRenderedAgentMessageList(
      [tool("tool-1"), running],
      context(),
    );
    const group = list.firstElementChild as HTMLElement;

    expect(group.querySelector(".agent-thread-card__tool-group-header")?.textContent)
      .toContain("已完成 1 个步骤");
    expect(group.querySelector(".agent-thread-card__tool-group-loading-icon"))
      .toBeNull();
    expect(
      group.querySelector(
        ".agent-thread-card__tool-group-running-tools .agent-thread-card__tool-group-running-loading-icon",
      ),
    ).not.toBeNull();
    const runningTool = group.querySelector<HTMLElement>(
      ".agent-thread-card__tool-group-running-tool",
    );
    expect(
      Array.from(runningTool?.children ?? []).map((child) =>
        child.getAttribute("class"),
      ),
    ).toEqual([
      "agent-thread-card__message-tool-icon-wrap",
      "agent-thread-card__tool-group-running-loading-icon",
      "agent-thread-card__message-tool-name",
      "agent-thread-card__message-tool-content",
    ]);
    expect(group.querySelector(".agent-thread-card__tool-group-running-tool"))
      .not.toBeNull();
    expect(
      group.querySelector(
        ".agent-thread-card__tool-group-running-tool .agent-thread-card__message-tool-toggle",
      ),
    ).toBeNull();
    expect(
      group.querySelector(
        ".agent-thread-card__tool-group-running-tool",
      )?.getAttribute("aria-hidden"),
    ).toBeNull();
    expect(group.querySelectorAll(".agent-thread-card__tool-group-completed-tools > .agent-thread-card__message"))
      .toHaveLength(0);

    // Collapsed: the completed region is empty and the running region is the
    // final visible section.
    expect(group.lastElementChild).toBe(
      group.querySelector(".agent-thread-card__tool-group-running-tools"),
    );

    group.querySelector<HTMLButtonElement>(
      ".agent-thread-card__tool-group-header",
    )?.click();
    expect(
      group.querySelector(".agent-thread-card__tool-group-running-tools")?.children,
    ).toHaveLength(1);
    expect(group.querySelector(".agent-thread-card__tool-group-completed-tools")?.children)
      .toHaveLength(1);
    // Expanded: completed details come first and the running region remains at
    // the end as a single-line progress row.
    expect(group.lastElementChild).toBe(
      group.querySelector(".agent-thread-card__tool-group-running-tools"),
    );
    expect(
      (group.querySelector(".agent-thread-card__tool-group-completed-tools")?.compareDocumentPosition(
        group.querySelector(".agent-thread-card__tool-group-running-tools") as Node,
      ) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      group.querySelector(
        ".agent-thread-card__tool-group-completed-tools .agent-thread-card__message-tool-toggle",
      ),
    ).toBeNull();
  });
});
