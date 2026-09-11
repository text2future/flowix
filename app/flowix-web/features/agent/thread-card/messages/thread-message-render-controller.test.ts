import { describe, expect, it, vi } from "vitest";
import type { AgentTypeKey } from "@/types/agent";
import { ThreadMessageRenderController } from "@features/agent/thread-card/messages/thread-message-render-controller";
import { MessageViewportController } from "@features/agent/thread-card/messages/message-viewport-controller";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

function createController(
  typeKey: AgentTypeKey,
  existing?: { body: HTMLElement; loadingIndicator: HTMLDivElement },
) {
  const body = existing?.body ?? document.createElement("div");
  const loadingIndicator = existing?.loadingIndicator ?? document.createElement("div");
  loadingIndicator.className = "agent-thread-card__loading";
  /*
   * 4 个 cell 的内联 --cell-step 对应 DOM 顺序 0..3。若不写,
   * var(--cell-step, 0) 回退到 0 → 4 个 cell 同步运行, 关键帧起始 0%
   * 即底色,视觉上"停在底色无动画"; text 的扫光是 background-position 位
   * 移,任何位置都是非底色,所以看起来正常。
   */
  loadingIndicator.innerHTML =
    '<span class="agent-thread-card__loading-cells" aria-hidden="true">' +
    '<span class="agent-thread-card__loading-cell" style="--cell-step:0"></span>' +
    '<span class="agent-thread-card__loading-cell" style="--cell-step:1"></span>' +
    '<span class="agent-thread-card__loading-cell" style="--cell-step:2"></span>' +
    '<span class="agent-thread-card__loading-cell" style="--cell-step:3"></span>' +
    '</span>' +
    '<span class="agent-thread-card__loading-text"></span>';
  if (loadingIndicator.parentNode !== body) body.append(loadingIndicator);

  const messageViewport = new MessageViewportController({
    body,
    bottomFollowThresholdPx: 64,
    topHistoryLoadThresholdPx: 64,
    scrollDeltaEpsilonPx: 2,
    isCollapsed: () => false,
    isFullscreen: () => false,
    getRuntimeThreadId: () => null,
    getConversationMessageState: () => null,
    loadMoreMessages: vi.fn(),
  });

  const createExternalAgentEmptySettings = vi.fn(() => {
    const el = document.createElement("div");
    el.className =
      "agent-thread-card__empty agent-thread-card__empty--codex-settings";
    el.append(document.createElement("button"));
    return el;
  });

  const controller = new ThreadMessageRenderController({
    body,
    loadingIndicator,
    messageViewport,
    getLanguage: () => "zh-CN",
    getTypeKey: () => typeKey,
    t: (key) => key,
    createThreadCacheSkeleton: () => {
      const skeleton = document.createElement("div");
      skeleton.className = "agent-thread-card__skeleton";
      return skeleton;
    },
    createExternalAgentEmptySettings,
  });

  return {
    body,
    loadingIndicator,
    controller,
    createExternalAgentEmptySettings,
  };
}

describe("ThreadMessageRenderController empty settings", () => {
  it("builds a large history across animation frames while keeping the skeleton visible", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    try {
      const { body, controller } = createController("claude");
      const messages = Array.from({ length: 31 }, (_, index) => ({
        id: `end-${index}`,
        role: "end" as const,
        content: `message ${index}`,
        timestamp: new Date().toISOString(),
      }));

      controller.render({
        messages,
        isLoading: false,
        shouldRenderMessages: true,
        isThreadCachePresentationHidden: false,
        isThreadCacheLoading: false,
      });

      expect(body.querySelector(".agent-thread-card__skeleton")).not.toBeNull();
      expect(body.querySelector(".agent-thread-card__messages")).toBeNull();

      while (frames.length > 0) frames.shift()?.(0);

      expect(body.querySelector(".agent-thread-card__skeleton")).toBeNull();
      expect(body.querySelectorAll(".agent-thread-card__message")).toHaveLength(31);
      controller.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not show the skeleton when a completed long history is updated", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    try {
      const { body, controller } = createController("codex");
      const initialMessages = Array.from({ length: 31 }, (_, index) => ({
        id: `end-${index}`,
        role: "end" as const,
        content: `message ${index}`,
        timestamp: new Date().toISOString(),
      }));

      controller.render({
        messages: initialMessages,
        isLoading: false,
        shouldRenderMessages: true,
        isThreadCachePresentationHidden: false,
        isThreadCacheLoading: false,
      });
      while (frames.length > 0) frames.shift()?.(0);

      const updatedMessages = initialMessages.map((message, index) =>
        index === initialMessages.length - 1
          ? { ...message, content: "hello" }
          : { ...message },
      );
      controller.render({
        messages: updatedMessages,
        isLoading: false,
        shouldRenderMessages: true,
        isThreadCachePresentationHidden: false,
        isThreadCacheLoading: false,
      });

      expect(body.querySelector(".agent-thread-card__skeleton")).toBeNull();
      expect(body.querySelector(".agent-thread-card__messages")).not.toBeNull();
      expect(body.textContent).toContain("hello");
      controller.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("defers completed reasoning Markdown until the collapsed row is expanded", () => {
    const { body, controller } = createController("claude");

    controller.render({
      messages: [{
        id: "large-reasoning",
        role: "reasoning",
        content: "# Expensive reasoning\n\nBody",
        isCompleted: true,
        timestamp: new Date().toISOString(),
      }],
      isLoading: false,
      shouldRenderMessages: true,
      isThreadCachePresentationHidden: false,
      isThreadCacheLoading: false,
    });

    const item = body.querySelector<HTMLElement>(
      ".agent-thread-card__message--reasoning",
    );
    const content = item?.querySelector<HTMLElement>(
      ".agent-thread-card__message-content",
    );
    expect(item?.classList.contains(
      "agent-thread-card__message--reasoning-collapsed",
    )).toBe(true);
    expect(content?.childNodes).toHaveLength(0);

    item?.querySelector<HTMLButtonElement>(
      ".agent-thread-card__message-reasoning-header",
    )?.click();

    expect(content?.textContent).toContain("Expensive reasoning");
  });

  it("shows the shared skeleton while dedicated history loads without cached messages", () => {
    const { body, controller, createExternalAgentEmptySettings } =
      createController("codex");

    controller.render({
      messages: [],
      isLoading: false,
      shouldRenderMessages: true,
      isInitialHistoryLoading: true,
      isThreadCachePresentationHidden: false,
      isThreadCacheLoading: false,
    });

    expect(body.querySelector(".agent-thread-card__skeleton")).not.toBeNull();
    expect(createExternalAgentEmptySettings).not.toHaveBeenCalled();
  });

  it("keeps cached messages visible during an initial history refresh", () => {
    const { body, controller } = createController("codex");

    controller.render({
      messages: [{
        id: "cached-user",
        role: "user",
        content: "cached message",
        timestamp: new Date().toISOString(),
      }],
      isLoading: false,
      shouldRenderMessages: true,
      isInitialHistoryLoading: true,
      isThreadCachePresentationHidden: false,
      isThreadCacheLoading: false,
    });

    expect(body.querySelector(".agent-thread-card__skeleton")).toBeNull();
    expect(body.textContent).toContain("cached message");
  });

  it("DeepSeek Harness empty card renders runtime settings", () => {
    const { body, controller, createExternalAgentEmptySettings } =
      createController("deepseek-harness");

    controller.render({
      messages: [],
      isLoading: false,
      shouldRenderMessages: true,
      isThreadCachePresentationHidden: false,
      isThreadCacheLoading: false,
    });

    expect(createExternalAgentEmptySettings).toHaveBeenCalledTimes(1);
    expect(
      body.querySelector(".agent-thread-card__empty--codex-settings"),
    ).not.toBeNull();
  });

  it("codex empty card renders runtime settings", () => {
    const { body, controller, createExternalAgentEmptySettings } =
      createController("codex");

    controller.render({
      messages: [],
      isLoading: false,
      shouldRenderMessages: true,
      isThreadCachePresentationHidden: false,
      isThreadCacheLoading: false,
    });

    expect(createExternalAgentEmptySettings).toHaveBeenCalledTimes(1);
    expect(
      body.querySelector(".agent-thread-card__empty--codex-settings"),
    ).not.toBeNull();
  });

  it("replaces the existing empty settings card on repeated empty renders", () => {
    const { body, controller } = createController("codex");
    const input = {
      messages: [],
      isLoading: false,
      shouldRenderMessages: true,
      isThreadCachePresentationHidden: false,
      isThreadCacheLoading: false,
    };

    controller.render(input);
    controller.render(input);

    expect(
      body.querySelectorAll(".agent-thread-card__empty--codex-settings"),
    ).toHaveLength(1);
  });

  it("removes an empty settings card left by a previous controller instance", () => {
    const first = createController("codex");
    const input = {
      messages: [],
      isLoading: false,
      shouldRenderMessages: true,
      isThreadCachePresentationHidden: false,
      isThreadCacheLoading: false,
    };

    first.controller.render(input);
    first.controller.dispose();

    const second = createController("codex", first);
    second.controller.render(input);

    expect(
      first.body.querySelectorAll(".agent-thread-card__empty--codex-settings"),
    ).toHaveLength(1);
    second.controller.dispose();
  });

  it("removes the empty settings card when the first message renders", () => {
    const { body, controller } = createController("codex");

    controller.render({
      messages: [],
      isLoading: false,
      shouldRenderMessages: true,
      isThreadCachePresentationHidden: false,
      isThreadCacheLoading: false,
    });
    controller.render({
      messages: [
        {
          id: "u1",
          role: "user",
          content: "hello",
          timestamp: new Date().toISOString(),
        },
      ],
      isLoading: false,
      shouldRenderMessages: true,
      isThreadCachePresentationHidden: false,
      isThreadCacheLoading: false,
    });

    expect(
      body.querySelector(".agent-thread-card__empty--codex-settings"),
    ).toBeNull();
    expect(body.querySelector(".agent-thread-card__messages")).not.toBeNull();
  });

  it("does not render runtime settings while thread cache is loading", () => {
    const { body, controller, createExternalAgentEmptySettings } =
      createController("deepseek-harness");

    controller.render({
      messages: [],
      isLoading: false,
      shouldRenderMessages: true,
      isThreadCachePresentationHidden: false,
      isThreadCacheLoading: true,
    });

    expect(createExternalAgentEmptySettings).not.toHaveBeenCalled();
    expect(body.textContent).toContain("editor.threadCard.loadingThreadCache");
  });
});

describe("ThreadMessageRenderController run-end re-parse", () => {
  it("preserves historical actions across append and restores the current actions on run end", () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    try {
      const { body, controller } = createController("deepseek-harness");
      const history = [
        {
          id: "u1",
          role: "user" as const,
          content: "first",
          timestamp: new Date().toISOString(),
          isCompleted: true,
        },
        {
          id: "a1",
          role: "assistant" as const,
          content: "answer 1",
          timestamp: new Date().toISOString(),
          isCompleted: true,
        },
      ];
      const currentUser = {
        id: "u2",
        role: "user" as const,
        content: "second",
        timestamp: new Date().toISOString(),
        isCompleted: true,
      };
      const currentAssistant = {
        id: "a2",
        role: "assistant" as const,
        content: "answer 2",
        timestamp: new Date().toISOString(),
        isCompleted: false,
      };

      controller.render({
        messages: history,
        isLoading: false,
        shouldRenderMessages: true,
        isThreadCachePresentationHidden: false,
        isThreadCacheLoading: false,
      });
      controller.render({
        messages: [...history, currentUser, currentAssistant],
        isLoading: true,
        shouldRenderMessages: true,
        isThreadCachePresentationHidden: false,
        isThreadCacheLoading: false,
      });

      const list = body.querySelector<HTMLElement>(".agent-thread-card__messages");
      expect(body.querySelectorAll(".agent-thread-card__message-actions")).toHaveLength(1);
      expect(list?.children[1].querySelector(".agent-thread-card__message-actions")).not.toBeNull();
      expect(list?.children[3].querySelector(".agent-thread-card__message-actions")).toBeNull();

      controller.render({
        messages: [
          ...history,
          currentUser,
          { ...currentAssistant, isCompleted: true },
        ],
        isLoading: false,
        shouldRenderMessages: true,
        isThreadCachePresentationHidden: false,
        isThreadCacheLoading: false,
      });

      expect(body.querySelectorAll(".agent-thread-card__message-actions")).toHaveLength(2);
      expect(list?.children[3].querySelector(".agent-thread-card__message-actions")).not.toBeNull();
      controller.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("re-parses the last assistant message on run end to canonicalize loose lists", () => {
    // rAF 同步执行, 让流式态 renderNow 立即落地 (更新 wasLoading)
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    try {
      const { body, controller } = createController("deepseek-harness");
      const streaming = {
        id: "a1",
        role: "assistant" as const,
        content: "- item 1\n\n- item 2",
        timestamp: new Date().toISOString(),
      };

      // 流式中(isLoading=true): 末条 isStreaming=true -> 增量切分, 拆成两个 ul
      controller.render({
        messages: [streaming],
        isLoading: true,
        shouldRenderMessages: true,
        isThreadCachePresentationHidden: false,
        isThreadCacheLoading: false,
      });
      expect(body.querySelectorAll("ul")).toHaveLength(2);

      // run 结束(isLoading 下降沿): loadingJustEnded 触发 patch-last forceFinalize
      controller.render({
        messages: [streaming],
        isLoading: false,
        shouldRenderMessages: true,
        isThreadCachePresentationHidden: false,
        isThreadCacheLoading: false,
      });
      const uls = body.querySelectorAll("ul");
      expect(uls).toHaveLength(1);
      expect(uls[0].querySelectorAll("li")).toHaveLength(2);
      // loose list 条目被 <p> 包裹 (tight list 不会)
      expect(uls[0].querySelector("li p")).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("ThreadMessageRenderController tool group regions", () => {
  it("keeps completed tools in the details region and running tools in the trailing region", () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return undefined as unknown as number;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    try {
      const { body, controller } = createController("codex");
      const tool = (id: string, isLoading = false) => ({
        id,
        role: "tool" as const,
        content: isLoading ? "" : "done",
        timestamp: "2026-09-03T00:00:00.000Z",
        toolName: "read",
        toolInput: { path: `${id}.md` },
        isLoading,
      });
      const t1 = tool("t1");
      const t2 = tool("t2", true);

      controller.render({
        messages: [t1, t2],
        isLoading: true,
        shouldRenderMessages: true,
        isThreadCachePresentationHidden: false,
        isThreadCacheLoading: false,
      });
      expect(body.querySelectorAll(
        ".agent-thread-card__tool-group-completed-tools > .agent-thread-card__message",
      )).toHaveLength(0);
      expect(body.querySelectorAll(
        ".agent-thread-card__tool-group-running-tools > .agent-thread-card__message",
      )).toHaveLength(1);
      expect(body.querySelector(".agent-thread-card__tool-group-running-tool")?.textContent)
        .toContain("t2.md");

      body.querySelector<HTMLButtonElement>(
        ".agent-thread-card__tool-group-header",
      )?.click();
      expect(body.querySelectorAll(
        ".agent-thread-card__tool-group-completed-tools > .agent-thread-card__message",
      )).toHaveLength(1);
      expect(body.querySelectorAll(
        ".agent-thread-card__tool-group-running-tools > .agent-thread-card__message",
      )).toHaveLength(1);
      expect(
        (body.querySelector(".agent-thread-card__tool-group-completed-tools")?.compareDocumentPosition(
          body.querySelector(".agent-thread-card__tool-group-running-tools") as Node,
        ) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      const t3 = tool("t3", true);
      controller.render({
        messages: [t1, t2, t3],
        isLoading: true,
        shouldRenderMessages: true,
        isThreadCachePresentationHidden: false,
        isThreadCacheLoading: false,
      });
      expect(body.querySelectorAll(
        ".agent-thread-card__tool-group-running-tools > .agent-thread-card__message",
      )).toHaveLength(2);
      expect(body.querySelector(".agent-thread-card__tool-group-running-tools")?.textContent)
        .toContain("t3.md");

      controller.render({
        messages: [t1, t2, { ...t3, content: "still running" }],
        isLoading: true,
        shouldRenderMessages: true,
        isThreadCachePresentationHidden: false,
        isThreadCacheLoading: false,
      });
      expect(body.querySelectorAll(
        ".agent-thread-card__tool-group-running-tools > .agent-thread-card__message",
      )).toHaveLength(2);
      expect(body.querySelector(".agent-thread-card__tool-group-running-tools")?.textContent)
        .toContain("t3.md");

      controller.render({
        messages: [t1, { ...t2, content: "done", isLoading: false }, { ...t3, content: "done", isLoading: false }, {
          id: "assistant-1",
          role: "assistant",
          content: "next step",
          timestamp: "2026-09-03T00:00:00.000Z",
        }],
        isLoading: true,
        shouldRenderMessages: true,
        isThreadCachePresentationHidden: false,
        isThreadCacheLoading: false,
      });
      expect(body.querySelectorAll(
        ".agent-thread-card__tool-group-running-tools > .agent-thread-card__message",
      )).toHaveLength(0);
      controller.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("moves a tool from the running region into completed details", () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return undefined as unknown as number;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    try {
      const { body, controller } = createController("codex");
      const tool = (id: string, isLoading: boolean) => ({
        id,
        role: "tool" as const,
        content: isLoading ? "" : "done",
        timestamp: "2026-09-03T00:00:00.000Z",
        toolName: "read",
        toolInput: { path: `${id}.md` },
        isLoading,
      });
      const running = tool("running", true);

      controller.render({
        messages: [tool("done", false), running],
        isLoading: true,
        shouldRenderMessages: true,
        isThreadCachePresentationHidden: false,
        isThreadCacheLoading: false,
      });

      expect(body.querySelectorAll(
        ".agent-thread-card__tool-group-running-tools > .agent-thread-card__message",
      )).toHaveLength(1);

      controller.render({
        messages: [tool("done", false), tool("running", false)],
        isLoading: false,
        shouldRenderMessages: true,
        isThreadCachePresentationHidden: false,
        isThreadCacheLoading: false,
      });

      expect(body.querySelectorAll(
        ".agent-thread-card__tool-group-running-tools > .agent-thread-card__message",
      )).toHaveLength(0);
      body.querySelector<HTMLButtonElement>(
        ".agent-thread-card__tool-group-header",
      )?.click();
      expect(body.querySelectorAll(
        ".agent-thread-card__tool-group-completed-tools > .agent-thread-card__message",
      )).toHaveLength(2);
      controller.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the Agent running indicator visible for at least one second", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return undefined as unknown as number;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    try {
      const { body, controller } = createController("codex");
      const input = {
        messages: [],
        shouldRenderMessages: true,
        isThreadCachePresentationHidden: false,
        isThreadCacheLoading: false,
      };

      controller.render({ ...input, isLoading: true });
      const cells = body.querySelector<HTMLElement>(".agent-thread-card__loading-cells");
      const text = body.querySelector<HTMLElement>(".agent-thread-card__loading-text");
      expect(cells?.hidden).toBe(false);
      expect(text?.hidden).toBe(false);

      controller.render({ ...input, isLoading: false });
      vi.advanceTimersByTime(999);
      expect(cells?.hidden).toBe(false);
      expect(text?.hidden).toBe(false);
      vi.advanceTimersByTime(1);
      expect(cells?.hidden).toBe(true);
      expect(text?.hidden).toBe(true);
      controller.dispose();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("does not expose completed historical tools when a running thread is restored", () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return undefined as unknown as number;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    try {
      const { body, controller } = createController("codex");
      const tool = (id: string) => ({
        id,
        role: "tool" as const,
        content: "done",
        timestamp: "2026-09-03T00:00:00.000Z",
        toolName: "read",
        toolInput: { path: `${id}.md` },
        isLoading: false,
      });

      controller.render({
        messages: [tool("t1"), tool("t2")],
        isLoading: true,
        shouldRenderMessages: true,
        isThreadCachePresentationHidden: false,
        isThreadCacheLoading: false,
      });

      expect(body.querySelectorAll(".agent-thread-card__tool-group-running-tools > .agent-thread-card__message"))
        .toHaveLength(0);
      controller.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
