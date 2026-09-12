import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Check, Copy, GitBranch } from "lucide-react";
import { translate, type AppLanguage } from "@/lib/i18n";
import { createLogger } from "@/lib/logger";
import type { ThreadState } from "@features/agent/store/thread-runtime-state";
import {
  agentMessageValueToText,
  createAgentMessageViewModel,
  shouldRenderAgentMessage,
} from "@features/agent/message";
import {
  normalizeToolInput,
  parseAgentCommandInput,
} from "@features/agent/tool-display";
import {
  attachAgentThreadCardMathCopyHandlers,
  prepareAgentThreadCardMath,
  renderAgentThreadCardMarkdownToHtml,
} from "@features/agent/thread-card/agent-thread-card-markdown";
import {
  createAgentThreadCardCommandPreview,
  createAgentThreadCardCommandList,
  createAgentThreadCardMessageFallback,
} from "@features/agent/thread-card/agent-thread-card-command-renderer";
import {
  applyMessageDisplayBudget,
  type MessageDisplayBudgetRole,
} from "@features/agent/message/display-limits";
import {
  createChevronIcon,
  createToolIcon,
} from "@features/agent/thread-card/agent-thread-card-icons";

type AgentMessage = ThreadState["messages"][number];

export interface AgentThreadCardMessageElementResult {
  element: HTMLElement;
  shouldRemember: boolean;
}

export interface AgentThreadCardMessageDisplayContext {
  language: AppLanguage;
  getDisplayExpanded: (message: AgentMessage) => boolean;
  setDisplayExpanded: (messageId: string, expanded: boolean) => void;
  onForkMessage?: (message: AgentMessage) => void | Promise<void>;
}

function createLucideIcon(icon: typeof Copy): SVGSVGElement {
  const template = document.createElement("template");
  template.innerHTML = renderToStaticMarkup(
    createElement(icon, { size: 14, strokeWidth: 2, "aria-hidden": true }),
  );
  return template.content.firstElementChild as SVGSVGElement;
}

function getMessageDateTimeText(message: AgentMessage, language: AppLanguage): string {
  const date = new Date(message.timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(language === "zh-CN" ? "zh-CN" : "en-US", {
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function getMessageDurationText(
  message: AgentMessage,
  language: AppLanguage,
): string | undefined {
  const durationMs = message.turnDurationMs;
  if (
    durationMs === undefined ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return undefined;
  }
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (language === "zh-CN") {
    return minutes === 0 ? `${seconds}秒` : `${minutes}分${seconds}秒`;
  }
  return `Duration ${minutes}m${seconds}s`;
}

export function attachMessageActions(
  item: HTMLDivElement,
  message: AgentMessage,
  messageView: ReturnType<typeof createAgentMessageViewModel>,
  language: AppLanguage,
  canFork: boolean,
  onFork?: (message: AgentMessage) => void | Promise<void>,
): void {
  if (message.role !== "assistant") return;

  const actions = document.createElement("div");
  actions.className = "agent-thread-card__message-actions";

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "agent-thread-card__message-action";
  copyButton.title = language === "zh-CN" ? "复制消息" : "Copy message";
  copyButton.setAttribute("aria-label", copyButton.title);
  copyButton.append(createLucideIcon(Copy));
  let copyResetTimer: number | undefined;
  copyButton.addEventListener("mousedown", (event) => event.stopPropagation());
  copyButton.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(messageView.visibleContent);
      copyButton.replaceChildren(createLucideIcon(Check));
      copyButton.dataset.state = "copied";
      if (copyResetTimer !== undefined) window.clearTimeout(copyResetTimer);
      copyResetTimer = window.setTimeout(() => {
        copyButton.replaceChildren(createLucideIcon(Copy));
        copyButton.dataset.state = "";
        copyResetTimer = undefined;
      }, 1000);
    } catch {
      // Clipboard permission failures should not show a false success state.
    }
  });
  actions.append(copyButton);

  // Fork is available for providers that expose a stable message boundary.
  // Copy and time are intentionally available to every agent's final
  // assistant message.
  if (
    canFork &&
    (message.codexTurnId || message.sourceSequence !== undefined)
  ) {
    const forkButton = document.createElement("button");
    forkButton.type = "button";
    forkButton.className = "agent-thread-card__message-action";
    forkButton.title = language === "zh-CN" ? "从此处分叉会话" : "Fork session";
    forkButton.setAttribute("aria-label", forkButton.title);
    forkButton.append(createLucideIcon(GitBranch));
    let activeConfirmation: HTMLSpanElement | null = null;
    function handleOutsidePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (activeConfirmation && !(target instanceof Node && actions.contains(target))) {
        closeConfirmation();
      }
    }
    const closeConfirmation = () => {
      activeConfirmation?.remove();
      activeConfirmation = null;
      document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    };
    forkButton.addEventListener("mousedown", (event) => event.stopPropagation());
    forkButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (activeConfirmation) {
        closeConfirmation();
        return;
      }

      const confirmation = document.createElement("span");
      confirmation.className = "agent-thread-card__message-fork-confirm";
      confirmation.setAttribute("role", "group");
      confirmation.setAttribute(
        "aria-label",
        language === "zh-CN" ? "确认分叉会话" : "Confirm fork",
      );

      const confirmButton = document.createElement("button");
      confirmButton.type = "button";
      confirmButton.className = "agent-thread-card__message-fork-confirm-button";
      confirmButton.textContent = language === "zh-CN" ? "确认" : "Confirm";
      confirmButton.addEventListener("mousedown", (confirmEvent) =>
        confirmEvent.stopPropagation());
      confirmButton.addEventListener("click", (confirmEvent) => {
        confirmEvent.stopPropagation();
        // Keep the popover mounted while the native IPC request is pending.
        // Fork can take a moment to start/recover the DSH host, and removing
        // the only visible state made a successful click look like a no-op.
        confirmButton.disabled = true;
        cancelButton.disabled = true;
        confirmButton.textContent = language === "zh-CN" ? "分叉中…" : "Forking…";
        let result: void | Promise<void>;
        try {
          result = onFork?.(message);
        } catch (error) {
          closeConfirmation();
          throw error;
        }
        if (result && typeof result.then === "function") {
          void result.then(closeConfirmation, closeConfirmation);
        } else {
          closeConfirmation();
        }
      });

      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "agent-thread-card__message-fork-cancel-button";
      cancelButton.textContent = language === "zh-CN" ? "取消" : "Cancel";
      cancelButton.addEventListener("mousedown", (cancelEvent) =>
        cancelEvent.stopPropagation());
      cancelButton.addEventListener("click", (cancelEvent) => {
        cancelEvent.stopPropagation();
        closeConfirmation();
      });

      confirmation.append(confirmButton, cancelButton);
      activeConfirmation = confirmation;
      actions.insertBefore(confirmation, time);
      document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    });
    actions.append(forkButton);
  }

  const time = document.createElement("span");
  time.className = "agent-thread-card__message-time";
  time.textContent = getMessageDateTimeText(message, language);
  actions.append(time);
  const durationText = getMessageDurationText(message, language);
  if (durationText) {
    const duration = document.createElement("span");
    duration.className = "agent-thread-card__message-duration";
    duration.textContent = durationText;
    actions.append(duration);
  }
  item.append(actions);
}

function getDisplayToggleLabel(
  language: AppLanguage,
  expanded: boolean,
): string {
  if (language === "zh-CN") return expanded ? "收起全文" : "展开全文";
  return expanded ? "Collapse" : "Show full message";
}

function directChildDisplayToggle(parent: HTMLElement): HTMLButtonElement | null {
  for (const child of Array.from(parent.children)) {
    if (child.classList.contains("agent-thread-card__message-display-toggle")) {
      return child as HTMLButtonElement;
    }
  }
  return null;
}

function findNestedToolString(
  input: unknown,
  keys: readonly string[],
  depth = 3,
): string | undefined {
  if (!input || depth < 0 || typeof input !== "object") return undefined;
  if (Array.isArray(input)) {
    for (const value of input) {
      const nested = findNestedToolString(value, keys, depth - 1);
      if (nested) return nested;
    }
    return undefined;
  }

  const record = input as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key].trim()) {
      return record[key].trim();
    }
  }
  for (const value of Object.values(record)) {
    const nested = findNestedToolString(value, keys, depth - 1);
    if (nested) return nested;
  }
  return undefined;
}

function getMcpToolName(message: AgentMessage): string | undefined {
  if (message.toolName?.toLowerCase() !== "mcp_tool_call") return undefined;
  return findNestedToolString(normalizeToolInput(message.toolInput), [
    "tool",
    "tool_name",
    "name",
  ]);
}

function getMcpToolSummary(summary: string, toolName: string): string {
  const prefix = `${toolName} · `;
  return summary.startsWith(prefix) ? summary.slice(prefix.length) : summary;
}

function createExpandableToolContent(options: {
  message: AgentMessage;
  text?: string;
  language: AppLanguage;
  getDisplayExpanded: (message: AgentMessage) => boolean;
  setDisplayExpanded: (messageId: string, expanded: boolean) => void;
  /** Optional DOM node whose overflow determines whether the toggle is shown. */
  measureTarget?: HTMLElement;
  /** Used for structured command content with a separate compact preview. */
  alwaysShowToggle?: boolean;
  /** Compact content rendered in the first row before the toggle. */
  leadingContent?: HTMLElement;
  /** Additional expanded content rendered below the first row. */
  expandedContent?: HTMLElement;
  /** Whether to render the generic tool input block. */
  includeInput?: boolean;
}): HTMLDivElement {
  const {
    message,
    text,
    language,
    getDisplayExpanded,
    setDisplayExpanded,
  } = options;
  const content = document.createElement("div");
  content.className = "agent-thread-card__message-tool-content";

  const row = document.createElement("div");
  row.className = "agent-thread-card__message-tool-row";
  content.append(row);

  const summary = text === undefined ? null : document.createElement("span");
  if (summary) {
    summary.className = "agent-thread-card__message-tool-summary";
    summary.textContent = text ?? "";
    summary.title = text ?? "";
    row.append(summary);
  } else if (options.leadingContent) {
    row.append(options.leadingContent);
  }

  if (options.expandedContent) content.append(options.expandedContent);
  if (options.includeInput !== false) {
    const fullInput = document.createElement("pre");
    fullInput.className = "agent-thread-card__message-tool-input";
    const inputText = agentMessageValueToText(message.toolInput);
    fullInput.textContent = inputText || translate(language, "agent.tools.noInput");
    content.append(fullInput);
  }

  let isExpanded = getDisplayExpanded(message);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "agent-thread-card__message-tool-toggle";
  toggle.append(createChevronIcon("down"));

  const syncToggleVisibility = () => {
    if (!content.isConnected) return;
    // Measure the collapsed text with the button removed. Otherwise the
    // button consumes width and can keep itself visible even when the full
    // single-line text would fit without it.
    if (!isExpanded && toggle.isConnected) toggle.remove();
    const target = options.measureTarget ?? summary;
    const shouldShow = Boolean(
      isExpanded || options.alwaysShowToggle ||
      (target && target.scrollWidth > target.clientWidth + 1),
    );
    if (shouldShow && !toggle.isConnected) row.append(toggle);
    else if (!shouldShow && toggle.isConnected) toggle.remove();
  };

  const applyExpandedState = (expanded: boolean) => {
    isExpanded = expanded;
    content.classList.toggle(
      "agent-thread-card__message-tool-content--expanded",
      expanded,
    );
    toggle.setAttribute("aria-expanded", String(expanded));
    const label = translate(
      language,
      expanded ? "agent.tool.collapse" : "agent.tool.expand",
    );
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
    syncToggleVisibility();
  };

  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    const nextExpanded = !isExpanded;
    setDisplayExpanded(message.id, nextExpanded);
    applyExpandedState(nextExpanded);
  });
  toggle.addEventListener("mousedown", (event) => event.stopPropagation());
  if (isExpanded) row.append(toggle);
  applyExpandedState(isExpanded);
  requestAnimationFrame(syncToggleVisibility);
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => {
      if (!content.isConnected) {
        observer.disconnect();
        return;
      }
      syncToggleVisibility();
    });
    observer.observe(content);
  }
  return content;
}

/**
 * 块级增量 DOM 注入状态 ── 已定型块维护成持久 DOM 节点(只 append), 未完成
 * tail 每帧只重建它自己, 用不可见 Comment 锚点(`tailMarker`)分隔。把每帧
 * innerHTML 解析+克隆从 O(全文 HTML) 降到 O(tail HTML); finalized 区的 KaTeX
 * 节点持久, `data-katex-rendered` 守卫生效, 每条公式只渲染一次。
 *
 * Comment 锚点不占元素子位置, content 的元素结构(finalized + tail 元素都是
 * 直接子)与全量渲染完全一致, :first-child / :last-child 与任何后代/直接子
 * 选择器都不受影响。
 *
 * 状态生命周期跟 content 元素绑定(WeakMap): patch-last 复用 content 时缓存
 * 延续; content 被 replaceChildren 重建或消息切换时自然失效。前缀校验
 * (text.startsWith(finalizedText))兜底文本回退(编辑 / compact 重建 / 展开
 * 切换改裁剪)导致的前缀变化, 回退时清空重建。
 */
interface BlockIncrementalState {
  finalizedText: string;
  tailMarker: Comment;
}

const blockIncrementalState = new WeakMap<HTMLElement, BlockIncrementalState>();
const logger = createLogger("agent-thread-card-message");

/**
 * 找出 text 中"最后一个完整块结尾"的位置, 之后的是正在写入的未完成块(tail)。
 * 块边界 = 代码围栏之外的空行; 围栏(``` / ~~~)内的空行不算边界, 保证未闭合
 * 代码块整体留在 tail 直到闭合。数学块($$ / \[)由 marked 扩展在 parse 时处理,
 * 未闭合数学块留在 tail, 闭合后随其后空行 finalize, 视觉可接受。
 *
 * 返回值是 finalized 部分的长度(含结尾空行), text.slice(return) 即 tail。
 */
function findFinalizableBlockBoundary(text: string): number {
  let inCodeFence = false;
  let fenceChar: string | null = null;
  let lastBoundary = 0;
  let pos = 0;
  const lines = text.split("\n");
  for (const line of lines) {
    if (inCodeFence) {
      if (fenceChar !== null && line.trim().startsWith(fenceChar.repeat(3))) {
        inCodeFence = false;
        fenceChar = null;
      }
    } else {
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fenceMatch) {
        inCodeFence = true;
        fenceChar = fenceMatch[1][0];
      }
    }
    pos += line.length + 1;
    if (!inCodeFence && line.trim() === "") {
      lastBoundary = pos;
    }
  }
  return lastBoundary;
}

function parseHtmlFragment(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

/**
 * 把一段 markdown 文本 parse 成节点并注入 content 的指定位置, 同时对新节点
 * 做 math 处理(aria 标签 + KaTeX)。`insertBefore === null` 时 append 到末尾
 * (tail 区, marker 之后); 否则插到该节点之前(finalized 区, marker 之前)。
 */
function injectMarkdownBlock(
  content: HTMLElement,
  insertBefore: Node | null,
  text: string,
  mathCopyLabel: string,
): void {
  const html = renderAgentThreadCardMarkdownToHtml(text);
  if (!html) return;
  const fragment = parseHtmlFragment(html);
  prepareAgentThreadCardMath(fragment, mathCopyLabel);
  content.insertBefore(fragment, insertBefore);
}

function clearTailAfterMarker(marker: Comment): void {
  const parent = marker.parentNode;
  if (!parent) return;
  let node = marker.nextSibling;
  while (node) {
    const next = node.nextSibling;
    parent.removeChild(node);
    node = next;
  }
}

/**
 * 增量注入消息 DOM。流式中(`forceFinalize=false`)只 marked.parse 最后一个
 * 未完成块, 已定型块作为持久 DOM 节点 append, 每帧只重建 tail。完成态
 * (`forceFinalize=true`, 由 message.isCompleted 或上层完成信号触发)做一次
 * 全量 re-parse, 修正流式期间 `findFinalizableBlockBoundary` 在 loose list /
 * 多段 blockquote 内部空行处错误切分导致的结构偏差 ── 完成是一次性的, 全量
 * 重建可接受。已 finalize 过同一 text 时只清 tail, 不重复重建。
 */
function renderIncrementalMarkdownDom(
  content: HTMLElement,
  text: string,
  forceFinalize: boolean,
  mathCopyLabel: string,
): void {
  let state = blockIncrementalState.get(content);
  if (!state) {
    const marker = document.createComment("tail");
    content.replaceChildren(marker);
    attachAgentThreadCardMathCopyHandlers(content);
    state = { finalizedText: "", tailMarker: marker };
    blockIncrementalState.set(content, state);
  }

  // 文本回退/前缀变化(编辑、compact 重建、展开切换改裁剪): 清空重建
  if (
    text.length < state.finalizedText.length ||
    !text.startsWith(state.finalizedText)
  ) {
    state.finalizedText = "";
    content.replaceChildren(state.tailMarker);
  }

  if (forceFinalize) {
    // 完成态: 全量 re-parse 修正块切分错误。同一 text 已 finalize 过则跳过重建。
    if (state.finalizedText !== text) {
      state.finalizedText = "";
      content.replaceChildren(state.tailMarker);
      if (text) {
        injectMarkdownBlock(content, state.tailMarker, text, mathCopyLabel);
        state.finalizedText = text;
      }
    }
    clearTailAfterMarker(state.tailMarker);
    return;
  }

  const remaining = text.slice(state.finalizedText.length);

  // 新定型块(最后一个块边界之前) -> 持久 append 到 marker 之前
  const boundary = findFinalizableBlockBoundary(remaining);
  if (boundary > 0) {
    const newlyFinalized = remaining.slice(0, boundary);
    injectMarkdownBlock(content, state.tailMarker, newlyFinalized, mathCopyLabel);
    state.finalizedText += newlyFinalized;
  }

  // tail = 未完成块, 每帧重建 marker 之后的部分(小, 只有最后一个块)
  clearTailAfterMarker(state.tailMarker);
  const tail = text.slice(state.finalizedText.length);
  if (tail) {
    injectMarkdownBlock(content, null, tail, mathCopyLabel);
  }
}

export function renderAgentThreadCardBudgetedMarkdown(options: {
  message: AgentMessage;
  role: MessageDisplayBudgetRole;
  visibleContent: string;
  content: HTMLElement;
  toggleParent: HTMLElement;
  context: AgentThreadCardMessageDisplayContext;
  /**
   * 消息是否仍在流式增长。true 时走块级增量(只 parse tail); false(默认)或消息
   * isCompleted 时做全量 re-parse, 修正流式期间 findFinalizableBlockBoundary
   * 在 loose list / 多段 blockquote 内部空行处错误切分导致的结构偏差。assistant
   * 无 isCompleted 字段, 由上层 controller 在 run 结束(isLoading 下降沿)传
   * isStreaming=false 触发终态修正。
   */
  isStreaming?: boolean;
}): void {
  const { message, role, visibleContent, content, toggleParent, context } =
    options;
  const expanded = context.getDisplayExpanded(message);
  const display = applyMessageDisplayBudget(role, visibleContent, expanded);

  const forceFinalize = !options.isStreaming || !!message.isCompleted;
  renderIncrementalMarkdownDom(
    content,
    display.text,
    forceFinalize,
    translate(context.language, "editor.threadCard.copyLatex"),
  );

  let toggle = directChildDisplayToggle(toggleParent);
  if (!display.isOverBudget) {
    toggle?.remove();
    return;
  }

  if (!toggle) {
    toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "agent-thread-card__message-display-toggle";
    toggleParent.append(toggle);
  }
  toggle.textContent = getDisplayToggleLabel(context.language, expanded);
  toggle.onclick = (event) => {
    event.stopPropagation();
    context.setDisplayExpanded(message.id, !expanded);
    renderAgentThreadCardBudgetedMarkdown(options);
  };
  toggle.onmousedown = (event) => {
    event.stopPropagation();
  };
}

export function createAgentThreadCardMessageElement(options: {
  message: AgentMessage;
  language: AppLanguage;
  getReasoningCollapsed: (message: AgentMessage) => boolean;
  setReasoningCollapsed: (messageId: string, collapsed: boolean) => void;
  getDisplayExpanded: (message: AgentMessage) => boolean;
  setDisplayExpanded: (messageId: string, expanded: boolean) => void;
  /** 消息是否仍在流式增长; 见 [renderAgentThreadCardBudgetedMarkdown]。 */
  isStreaming?: boolean;
  showActions?: boolean;
  canFork?: boolean;
  onForkMessage?: (message: AgentMessage) => void | Promise<void>;
}): AgentThreadCardMessageElementResult | null {
  const {
    message,
    language,
    getReasoningCollapsed,
    setReasoningCollapsed,
    getDisplayExpanded,
    setDisplayExpanded,
  } = options;
  const displayContext: AgentThreadCardMessageDisplayContext = {
    language,
    getDisplayExpanded,
    setDisplayExpanded,
    onForkMessage: options.canFork ? options.onForkMessage : undefined,
  };

  if (!shouldRenderAgentMessage(message)) {
    return null;
  }

  let messageView: ReturnType<typeof createAgentMessageViewModel>;
  let item: HTMLDivElement;
  try {
    messageView = createAgentMessageViewModel(message, language);
    item = document.createElement("div");
    item.className = `agent-thread-card__message agent-thread-card__message--${message.role}`;
    if (message.messageType === "context-compaction") {
      item.classList.add("agent-thread-card__message--context-compaction");
    }
    if (
      message.messageType === "goal-round" ||
      message.messageType === "goal-complete" ||
      message.messageType === "goal-blocked"
    ) {
      item.classList.add(
        "agent-thread-card__message--goal-control",
        `agent-thread-card__message--${message.messageType}`,
      );
    }
    if (
      message.messageType === "dsh-command" ||
      message.messageType === "dsh-command-result" ||
      message.messageType === "dsh-command-prompt"
    ) {
      item.classList.add(
        "agent-thread-card__message--dsh-command",
        `agent-thread-card__message--${message.messageType}`,
      );
      if (message.isLoading) {
        item.classList.add("agent-thread-card__message--dsh-command-loading");
      }
    }
    if (message.messageType === "codex-command") {
      item.classList.add(
        "agent-thread-card__message--codex-command",
      );
      if (message.isLoading) {
        item.classList.add("agent-thread-card__message--codex-command-loading");
      }
    }
  } catch (err) {
    logger.error("Failed to prepare message", {
      error: err,
      messageId: message.id,
      role: message.role,
    });
    return {
      element: createAgentThreadCardMessageFallback(message, language),
      shouldRemember: true,
    };
  }

  try {
    if (message.role === "tool") {
      const icon = createToolIcon(message.toolName, message.toolAgentType);
      const iconWrap = document.createElement("span");
      iconWrap.className = "agent-thread-card__message-tool-icon-wrap";
      iconWrap.append(icon);
      const name = document.createElement("span");
      name.className = "agent-thread-card__message-tool-name";
      name.textContent = messageView.toolLabel;
      const command = parseAgentCommandInput(message.toolInput);
      if (command) {
        const preview = createAgentThreadCardCommandPreview(command);
        const details = createAgentThreadCardCommandList(command, false, {
          maxItems: Number.POSITIVE_INFINITY,
          maxInlineArgs: Number.POSITIVE_INFINITY,
          truncateArgs: false,
        });
        details.classList.add("agent-thread-card__command-list--details");
        const content = createExpandableToolContent({
          message,
          language,
          getDisplayExpanded,
          setDisplayExpanded,
          measureTarget: preview,
          alwaysShowToggle: true,
          leadingContent: preview,
          expandedContent: details,
          includeInput: false,
        });
        item.append(iconWrap, name, content);
      } else {
        const mcpToolName = getMcpToolName(message);
        const toolText = mcpToolName
          ? getMcpToolSummary(messageView.toolSummary, mcpToolName)
          : messageView.toolSummary;
        const content = createExpandableToolContent({
          message,
          text: toolText,
          language,
          getDisplayExpanded,
          setDisplayExpanded,
        });
        if (mcpToolName) {
          const concreteName = document.createElement("span");
          concreteName.className =
            "agent-thread-card__message-tool-concrete-name";
          concreteName.textContent = mcpToolName;
          item.append(iconWrap, name, concreteName, content);
        } else {
          item.append(iconWrap, name, content);
        }
      }
    } else if (message.role === "end") {
      const content = document.createElement("div");
      content.className = "agent-thread-card__message-content";
      content.textContent = messageView.visibleContent;
      item.append(content);
    } else if (message.role === "user") {
      const content = document.createElement("div");
      content.className =
        "agent-thread-card__message-content agent-thread-card__message-content--user-preview";
      if (
        message.messageType === "dsh-command" ||
        message.messageType === "dsh-command-prompt"
      ) {
        const badge = document.createElement("span");
        badge.className = "agent-thread-card__message-dsh-badge";
        badge.textContent = message.messageType === "dsh-command-prompt" ? "DSH /plan" : "DSH";
        item.append(badge);
      } else if (message.messageType === "codex-command") {
        const badge = document.createElement("span");
        badge.className = "agent-thread-card__message-codex-badge";
        badge.textContent = "Codex";
        item.append(badge);
      }
      item.append(content);
      renderAgentThreadCardBudgetedMarkdown({
        message,
        role: "user",
        visibleContent: messageView.visibleContent,
        content,
        toggleParent: item,
        context: displayContext,
        isStreaming: options.isStreaming,
      });
    } else if (message.role === "reasoning") {
      const header = document.createElement("button");
      header.type = "button";
      header.className = "agent-thread-card__message-reasoning-header";
      header.append(createChevronIcon("right"));
      const label = document.createElement("span");
      label.textContent = messageView.reasoningLabel;
      header.append(label);

      const body = document.createElement("div");
      body.className = "agent-thread-card__message-reasoning-body";
      const content = document.createElement("div");
      content.className = "agent-thread-card__message-content";
      body.append(content);
      const renderReasoningContent = () => {
        renderAgentThreadCardBudgetedMarkdown({
          message,
          role: "reasoning",
          visibleContent: messageView.visibleContent,
          content,
          toggleParent: body,
          context: displayContext,
          isStreaming: options.isStreaming,
        });
      };

      const apply = (collapsed: boolean): void => {
        item.classList.toggle(
          "agent-thread-card__message--reasoning-collapsed",
          collapsed,
        );
      };
      const initiallyCollapsed = getReasoningCollapsed(message);
      apply(initiallyCollapsed);
      // Completed historical reasoning is collapsed by default. Avoid parsing
      // potentially hundreds of thousands of Markdown characters that are not
      // visible; hydrate the body only when the user expands it.
      if (!initiallyCollapsed) renderReasoningContent();
      header.addEventListener("click", (event) => {
        event.stopPropagation();
        const next = !item.classList.contains(
          "agent-thread-card__message--reasoning-collapsed",
        );
        setReasoningCollapsed(message.id, next);
        apply(next);
        if (!next && content.childNodes.length === 0) {
          renderReasoningContent();
        }
      });
      header.addEventListener("mousedown", (event) => {
        event.stopPropagation();
      });

      item.append(header, body);
    } else if (message.role === "system") {
      const content = document.createElement("div");
      content.className = "agent-thread-card__message-content";
      if (message.messageType === "context-compaction") {
        content.className = "agent-thread-card__message-context-compaction";
        const compactedResult = message.content.trim().replace(/^DSH\s+/u, "");
        content.textContent = compactedResult
          ? `${translate(language, "agent.contextCompaction")} / ${compactedResult}`
          : translate(language, "agent.contextCompaction");
      } else if (
        message.messageType === "goal-round" ||
        message.messageType === "goal-complete" ||
        message.messageType === "goal-blocked"
      ) {
        content.className = "agent-thread-card__message-goal-control";
        content.textContent = messageView.visibleContent;
      } else if (message.messageType === "dsh-command-result") {
        content.className = "agent-thread-card__message-dsh-result";
        const badge = document.createElement("span");
        badge.className = "agent-thread-card__message-dsh-badge";
        badge.textContent = "DSH";
        content.append(badge, document.createTextNode(messageView.visibleContent));
      } else {
        content.textContent = messageView.visibleContent;
      }
      item.append(content);
    } else {
      const content = document.createElement("div");
      content.className = "agent-thread-card__message-content";
      item.append(content);
      renderAgentThreadCardBudgetedMarkdown({
        message,
        role: "assistant",
        visibleContent: messageView.visibleContent,
        content,
        toggleParent: item,
        context: displayContext,
        isStreaming: options.isStreaming,
      });
    }

    if (options.showActions) {
      attachMessageActions(
        item,
        message,
        messageView,
        language,
        options.canFork === true,
        displayContext.onForkMessage,
      );
    }

    return { element: item, shouldRemember: true };
  } catch (err) {
    logger.error("Failed to render message", {
      error: err,
      messageId: message.id,
      role: message.role,
    });
    return {
      element: createAgentThreadCardMessageFallback(message, language),
      shouldRemember: true,
    };
  }
}
