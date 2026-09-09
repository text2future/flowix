import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/types";
import type { MessageDisplayBudgetRole } from "@features/agent/message/display-limits";
import {
  createAgentThreadCardMessageElement,
  renderAgentThreadCardBudgetedMarkdown,
  type AgentThreadCardMessageDisplayContext,
} from "@features/agent/thread-card/messages/message-item-renderer";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

function makeDisplayContext(): AgentThreadCardMessageDisplayContext {
  // 用例不测展开/折叠, expanded 恒 false 即可。
  return {
    language: "zh-CN",
    getDisplayExpanded: () => false,
    setDisplayExpanded: () => undefined,
  };
}

type TextRole = "assistant" | "reasoning" | "user";

interface RenderSetup {
  content: HTMLDivElement;
  toggleParent: HTMLDivElement;
  message: ChatMessage;
}

function setup(role: TextRole, content: string, isCompleted = false): RenderSetup {
  const contentEl = document.createElement("div");
  const toggleParent = document.createElement("div");
  toggleParent.append(contentEl);
  const message: ChatMessage = {
    id: "m1",
    role,
    content,
    timestamp: new Date().toISOString(),
    isCompleted,
  };
  return { content: contentEl, toggleParent, message };
}

function render(
  s: RenderSetup,
  role: MessageDisplayBudgetRole,
  visibleContent: string,
  options: { isCompleted?: boolean; isStreaming?: boolean } = {},
): void {
  renderAgentThreadCardBudgetedMarkdown({
    message: {
      ...s.message,
      content: visibleContent,
      isCompleted: options.isCompleted,
    },
    role,
    visibleContent,
    content: s.content,
    toggleParent: s.toggleParent,
    context: makeDisplayContext(),
    isStreaming: options.isStreaming,
  });
}

describe("renderAgentThreadCardBudgetedMarkdown incremental DOM injection", () => {
  it("persists finalized block DOM nodes across streaming patches", () => {
    const s = setup("assistant", "para 1\n\n");
    render(s, "assistant", "para 1\n\n", { isStreaming: true });
    const firstP = s.content.querySelector("p");
    expect(firstP?.textContent).toBe("para 1");

    // 追加 para 2, 前缀稳定: 已 finalize 的 <p>para 1</p> 节点引用不变
    render(s, "assistant", "para 1\n\npara 2", { isStreaming: true });
    expect(s.content.querySelector("p")).toBe(firstP);
    expect(s.content.textContent).toContain("para 2");
  });

  it("resets and rebuilds when the finalized prefix changes", () => {
    const s = setup("assistant", "para 1\n\n");
    render(s, "assistant", "para 1\n\n", { isStreaming: true });
    expect(s.content.textContent).toContain("para 1");

    // 前缀变化 (编辑/回退): "para 2\n\n" 不以 "para 1\n\n" 开头 -> 清空重建
    render(s, "assistant", "para 2\n\n", { isStreaming: true });
    expect(s.content.textContent).toContain("para 2");
    expect(s.content.textContent).not.toContain("para 1");
  });

  it("keeps finalized KaTeX nodes mounted across streaming patches", async () => {
    const s = setup("assistant", "\\[x^2\\]\n\n");
    render(s, "assistant", "\\[x^2\\]\n\n", { isStreaming: true });
    await vi.waitFor(() => {
      const math = s.content.querySelector<HTMLElement>(
        ".agent-thread-card__math",
      );
      expect(math?.dataset.katexRendered).toBe("true");
    });
    const mathNode = s.content.querySelector<HTMLElement>(
      ".agent-thread-card__math",
    );

    // 追加文本: finalized math 节点持久 (引用不变, 仍已渲染, 不重跑 katex.render)
    render(s, "assistant", "\\[x^2\\]\n\nmore text", { isStreaming: true });
    expect(s.content.querySelector(".agent-thread-card__math")).toBe(mathNode);
    expect(mathNode?.dataset.katexRendered).toBe("true");
    expect(s.content.textContent).toContain("more text");
  });

  it("canonicalizes a loose list into a single list on completion", () => {
    const s = setup("reasoning", "- item 1\n\n", false);
    // 流式中: "- item 1\n\n" finalize 为单项 tight list
    render(s, "reasoning", "- item 1\n\n", { isStreaming: true });
    expect(s.content.querySelectorAll("ul")).toHaveLength(1);

    // 追加 "- item 2" (仍流式): 块切分把两项拆成两个 tight list
    render(s, "reasoning", "- item 1\n\n- item 2", { isStreaming: true });
    expect(s.content.querySelectorAll("ul")).toHaveLength(2);

    // 完成 (isCompleted=true -> forceFinalize): 全量 re-parse 修正为一个 loose list
    render(s, "reasoning", "- item 1\n\n- item 2", { isCompleted: true });
    const uls = s.content.querySelectorAll("ul");
    expect(uls).toHaveLength(1);
    expect(uls[0].querySelectorAll("li")).toHaveLength(2);
    // loose list 条目被 <p> 包裹 (tight list 不会)
    expect(uls[0].querySelector("li p")).not.toBeNull();
  });

  it("canonicalizes an assistant message on run completion (isStreaming=false)", () => {
    const s = setup("assistant", "- item 1\n\n", false);
    // 流式中: 拆成两个 tight list
    render(s, "assistant", "- item 1\n\n- item 2", { isStreaming: true });
    expect(s.content.querySelectorAll("ul")).toHaveLength(2);

    // run 结束 -> controller 传 isStreaming=false -> 全量 re-parse 修正
    // (assistant 无 isCompleted, 靠 isStreaming 下降沿触发)
    render(s, "assistant", "- item 1\n\n- item 2", { isStreaming: false });
    const uls = s.content.querySelectorAll("ul");
    expect(uls).toHaveLength(1);
    expect(uls[0].querySelectorAll("li")).toHaveLength(2);
    expect(uls[0].querySelector("li p")).not.toBeNull();
  });

  it("does not re-parse on repeated completion with unchanged text", () => {
    const s = setup("reasoning", "final answer\n\n", false);
    render(s, "reasoning", "final answer\n\n", { isCompleted: true });
    const pAfterFirst = s.content.querySelector("p");
    expect(pAfterFirst?.textContent).toBe("final answer");

    // 同一 text 再次完成: 不应重建 (节点引用不变)
    render(s, "reasoning", "final answer\n\n", { isCompleted: true });
    expect(s.content.querySelector("p")).toBe(pAfterFirst);
  });
});

describe("agent user and assistant Markdown rendering", () => {
  function renderMessage(role: "user" | "assistant"): HTMLElement {
    const result = createAgentThreadCardMessageElement({
      message: {
        id: `${role}-code-block`,
        role,
        content: "说明\n\n```ts\nconst answer = 42;\n```",
        timestamp: new Date().toISOString(),
      },
      language: "zh-CN",
      getReasoningCollapsed: () => true,
      setReasoningCollapsed: () => undefined,
      getDisplayExpanded: () => false,
      setDisplayExpanded: () => undefined,
    });
    if (!result) throw new Error(`Expected ${role} message to render`);
    return result.element;
  }

  it("renders a user fenced code block with the same Markdown path as assistant", () => {
    const userPre = renderMessage("user").querySelector("pre");
    const assistantPre = renderMessage("assistant").querySelector("pre");

    expect(userPre).not.toBeNull();
    expect(assistantPre).not.toBeNull();
    expect(userPre?.outerHTML).toBe(assistantPre?.outerHTML);
    expect(userPre?.classList.contains("agent-thread-card__message-code-block")).toBe(
      true,
    );
  });

  it("keeps message code blocks out of the parent editor pre rule", () => {
    const host = document.createElement("div");
    host.className = "markdown-editor";
    const editor = document.createElement("div");
    editor.className = "tiptap";
    const message = renderMessage("user");
    const documentPre = document.createElement("pre");
    editor.append(message, documentPre);
    host.append(editor);
    document.body.append(host);

    const editorPreSelector =
      ".markdown-editor .tiptap:not(.agent-thread-card__composer-editor) " +
      "pre:where(:not(.agent-thread-card__message, .agent-thread-card__message *)):not(.agent-thread-card__message-code-block)";

    expect(message.querySelector("pre")?.matches(editorPreSelector)).toBe(false);
    expect(documentPre.matches(editorPreSelector)).toBe(true);
  });

  it("keeps a first Agent card out of the editor first-block spacing rule", () => {
    const host = document.createElement("div");
    host.className = "markdown-editor";
    const editor = document.createElement("div");
    editor.className = "ProseMirror";
    const card = document.createElement("section");
    card.className = "agent-thread-card";
    const paragraph = document.createElement("p");
    editor.append(card, paragraph);
    host.append(editor);
    document.body.append(host);

    const firstBlockSelector =
      ".markdown-editor .ProseMirror:not(.agent-thread-card__composer-editor) " +
      "> *:not(.agent-thread-card, .frontmatter-property-node):first-of-type";

    expect(card.matches(firstBlockSelector)).toBe(false);
    expect(paragraph.matches(firstBlockSelector)).toBe(true);
  });
});

describe("context compaction message rendering", () => {
  it("renders plain italic text without an icon or card wrapper", () => {
    const result = createAgentThreadCardMessageElement({
      message: {
        id: "compaction-1",
        role: "system",
        messageType: "context-compaction",
        content: "",
        timestamp: new Date().toISOString(),
      },
      language: "zh-CN",
      getReasoningCollapsed: () => true,
      setReasoningCollapsed: () => undefined,
      getDisplayExpanded: () => false,
      setDisplayExpanded: () => undefined,
    });

    expect(result?.element.classList.contains(
      "agent-thread-card__message--context-compaction",
    )).toBe(true);
    const content = result?.element.querySelector(
      ".agent-thread-card__message-context-compaction",
    );
    expect(content?.textContent).toBe("上下文已自动压缩");
    expect(content?.querySelector("svg")).toBeNull();
    expect(content?.classList.contains("agent-thread-card__message-content")).toBe(false);
  });

  it("renders the DSH completion result without exposing the compacted summary", () => {
    const result = createAgentThreadCardMessageElement({
      message: {
        id: "dsh-checkpoint-1",
        role: "system",
        messageType: "context-compaction",
        content: "Compacted 36 history items (~11479 tokens).",
        timestamp: new Date().toISOString(),
      },
      language: "zh-CN",
      getReasoningCollapsed: () => true,
      setReasoningCollapsed: () => undefined,
      getDisplayExpanded: () => false,
      setDisplayExpanded: () => undefined,
    });

    expect(result?.element.textContent).toBe(
      "上下文已自动压缩 / Compacted 36 history items (~11479 tokens).",
    );
    expect(result?.element.textContent).not.toContain("Current Work");
  });
});

describe("DSH command input rendering", () => {
  it("uses the same user-command class and DSH badge for compact, goal, and plan", () => {
    const commands = [
      { name: "compact", content: "/compact", isLoading: true },
      { name: "goal", content: "/goal ship it", isLoading: false },
      { name: "plan", content: "/plan inspect it", isLoading: false },
    ];

    const elements = commands.map(({ name, content, isLoading }) => {
      const result = createAgentThreadCardMessageElement({
        message: {
          id: `dsh-${name}`,
          role: "user",
          messageType: "dsh-command",
          content,
          timestamp: new Date().toISOString(),
          isLoading,
        },
        language: "zh-CN",
        getReasoningCollapsed: () => true,
        setReasoningCollapsed: () => undefined,
        getDisplayExpanded: () => false,
        setDisplayExpanded: () => undefined,
      });
      if (!result) throw new Error(`Expected ${name} command to render`);
      return result.element;
    });

    expect(elements.map((element) => element.className)).toEqual([
      "agent-thread-card__message agent-thread-card__message--user agent-thread-card__message--dsh-command agent-thread-card__message--dsh-command-loading",
      "agent-thread-card__message agent-thread-card__message--user agent-thread-card__message--dsh-command",
      "agent-thread-card__message agent-thread-card__message--user agent-thread-card__message--dsh-command",
    ]);
    expect(elements.map((element) => element.querySelector(
      ".agent-thread-card__message-dsh-badge",
    )?.textContent)).toEqual(["DSH", "DSH", "DSH"]);
    expect(elements.map((element) => element.textContent?.includes("/"))).toEqual([
      true,
      true,
      true,
    ]);
  });
});

describe("DSH goal control message rendering", () => {
  it("renders the compact system row instead of a user bubble", () => {
    const result = createAgentThreadCardMessageElement({
      message: {
        id: "goal-round-1",
        role: "system",
        messageType: "goal-round",
        content: "目标执行中：在吗（第 1/256 轮）",
        timestamp: new Date().toISOString(),
      },
      language: "zh-CN",
      getReasoningCollapsed: () => true,
      setReasoningCollapsed: () => undefined,
      getDisplayExpanded: () => false,
      setDisplayExpanded: () => undefined,
    });

    expect(result?.element.classList.contains(
      "agent-thread-card__message--user",
    )).toBe(false);
    expect(result?.element.classList.contains(
      "agent-thread-card__message--goal-round",
    )).toBe(true);
    expect(result?.element.querySelector(
      ".agent-thread-card__message-goal-control",
    )?.textContent).toBe("目标执行中：在吗（第 1/256 轮）");
  });
});

describe("unified tool message rendering", () => {
  it("keeps a structured command preview and expands to the complete command list", async () => {
    let expanded = false;
    const setDisplayExpanded = vi.fn((_messageId: string, value: boolean) => {
      expanded = value;
    });
    const result = createAgentThreadCardMessageElement({
      message: {
        id: "tool-1",
        role: "tool",
        content: "",
        timestamp: new Date().toISOString(),
        toolName: "shell",
        toolInput: { command: "npm run build && npm test" },
      },
      language: "zh-CN",
      getReasoningCollapsed: () => true,
      setReasoningCollapsed: () => undefined,
      getDisplayExpanded: () => expanded,
      setDisplayExpanded,
    });

    const element = result?.element;
    if (element) document.body.append(element);
    expect(element?.classList.contains("agent-thread-card__message--tool"))
      .toBe(true);
    const preview = element?.querySelector<HTMLSpanElement>(
      ".agent-thread-card__command-preview",
    );
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toBe("npm run build && npm test");
    expect(preview?.title).toBe(preview?.textContent);
    expect(element?.querySelector(
      ".agent-thread-card__command-list--details",
    )).not.toBeNull();
    const iconWrap = element?.querySelector<HTMLSpanElement>(
      ".agent-thread-card__message-tool-icon-wrap",
    );
    expect(element?.firstElementChild).toBe(iconWrap);
    expect(iconWrap?.tagName).toBe("SPAN");
    expect(iconWrap?.firstElementChild?.tagName).toBe("svg");
    expect(iconWrap?.firstElementChild?.classList.contains(
      "agent-thread-card__message-tool-icon",
    )).toBe(true);
    const content = element?.querySelector<HTMLDivElement>(
      ".agent-thread-card__message-tool-content",
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const toggle = element?.querySelector<HTMLButtonElement>(
      ".agent-thread-card__message-tool-toggle",
    );

    expect(element?.querySelectorAll(
      ".agent-thread-card__command-list--details .agent-thread-card__command-line",
    )).toHaveLength(2);
    expect(content?.classList.contains(
      "agent-thread-card__message-tool-content--expanded",
    )).toBe(false);
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");

    toggle?.click();
    expect(setDisplayExpanded).toHaveBeenCalledWith("tool-1", true);
    expect(content?.classList.contains(
      "agent-thread-card__message-tool-content--expanded",
    )).toBe(true);
    expect(element?.querySelector(
      ".agent-thread-card__command-list--details",
    )).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");

    toggle?.click();
    expect(setDisplayExpanded).toHaveBeenLastCalledWith("tool-1", false);
    expect(content?.classList.contains(
      "agent-thread-card__message-tool-content--expanded",
    )).toBe(false);
  });

  it("keeps short non-command tools as a compact row without a toggle", () => {
    const result = createAgentThreadCardMessageElement({
      message: {
        id: "tool-2",
        role: "tool",
        content: "",
        timestamp: new Date().toISOString(),
        toolName: "read",
        toolInput: { path: "/tmp/example.txt" },
      },
      language: "zh-CN",
      getReasoningCollapsed: () => true,
      setReasoningCollapsed: () => undefined,
      getDisplayExpanded: () => false,
      setDisplayExpanded: () => undefined,
    });

    expect(result?.element.querySelector(
      ".agent-thread-card__message-tool-summary",
    )?.textContent).toBe("example.txt");
    expect(result?.element.querySelector(
      ".agent-thread-card__message-tool-toggle",
    )).toBeNull();
  });

  it("uses the same expansion control for overflowing non-command tools", async () => {
    const fullSummary = `first line\nsecond line\n${"x".repeat(1200)}`;
    const result = createAgentThreadCardMessageElement({
      message: {
        id: "tool-3",
        role: "tool",
        content: "",
        timestamp: new Date().toISOString(),
        toolName: "read",
        toolDisplay: { kind: "file", summary: fullSummary },
      },
      language: "zh-CN",
      getReasoningCollapsed: () => true,
      setReasoningCollapsed: () => undefined,
      getDisplayExpanded: () => false,
      setDisplayExpanded: () => undefined,
    });
    if (result?.element) document.body.append(result.element);

    const summary = result?.element.querySelector<HTMLElement>(
      ".agent-thread-card__message-tool-summary",
    );
    expect(summary?.textContent).toBe(fullSummary);
    if (summary) {
      Object.defineProperty(summary, "clientWidth", { value: 100 });
      Object.defineProperty(summary, "scrollWidth", { value: 180 });
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(result?.element.querySelector(
      ".agent-thread-card__message-tool-toggle",
    )).not.toBeNull();
    result?.element.querySelector<HTMLButtonElement>(
      ".agent-thread-card__message-tool-toggle",
    )?.click();
    expect(result?.element.querySelector(
      ".agent-thread-card__message-tool-summary",
    )?.textContent).toBe(fullSummary);
  });

  it("does not show a toggle when a short non-command summary fits on one line", async () => {
    const result = createAgentThreadCardMessageElement({
      message: {
        id: "tool-4",
        role: "tool",
        content: "",
        timestamp: new Date().toISOString(),
        toolName: "read",
        toolDisplay: { kind: "file", summary: "example.txt" },
      },
      language: "zh-CN",
      getReasoningCollapsed: () => true,
      setReasoningCollapsed: () => undefined,
      getDisplayExpanded: () => false,
      setDisplayExpanded: () => undefined,
    });
    if (result?.element) document.body.append(result.element);
    const summary = result?.element.querySelector<HTMLElement>(
      ".agent-thread-card__message-tool-summary",
    );
    if (summary) {
      Object.defineProperty(summary, "clientWidth", { value: 100 });
      Object.defineProperty(summary, "scrollWidth", { value: 30 });
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(result?.element.querySelector(
      ".agent-thread-card__message-tool-toggle",
    )).toBeNull();
  });
});
