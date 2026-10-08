import { messageRenderKey } from "@features/agent/message/render-identity";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Check, Copy, GitBranch, Image as ImageIcon } from "lucide-react";
import { translate, type AppLanguage } from "@/lib/i18n";
import { createLogger } from "@/lib/logger";
import { agent } from "@platform/tauri/client";
import type { ThreadState } from "@features/agent/store/thread-runtime-state";
import {
  createAgentMessageViewModel,
  shouldRenderAgentMessage,
} from "@features/agent/message";
import {
  attachAgentThreadCardMathCopyHandlers,
  highlightAgentThreadCardCodeBlocks,
  prepareAgentThreadCardCodeBlockLabels,
  prepareAgentThreadCardMath,
  renderAgentThreadCardMarkdownToHtml,
} from "@features/agent/thread-card/agent-thread-card-markdown";
import { createAgentThreadCardMessageFallback } from "@features/agent/thread-card/agent-thread-card-command-renderer";
import {
  applyMessageDisplayBudget,
  type MessageDisplayBudgetRole,
} from "@features/agent/message/display-limits";
import { createChevronIcon } from "@features/agent/thread-card/agent-thread-card-icons";
import { registerMessageDisposer } from "@features/agent/thread-card/messages/message-lifecycle";
import { attachAgentMessageImagePreview } from "@features/agent/thread-card/messages/image-preview";
import { createAgentThreadCardToolMessageParts } from "@features/agent/thread-card/messages/message-tool-renderer";

type AgentMessage = ThreadState["messages"][number];
export { disposeAgentThreadCardMessageTree } from "@features/agent/thread-card/messages/message-lifecycle";

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

function createUserMessageAttachments(
  message: AgentMessage,
  language: AppLanguage,
): HTMLDivElement | null {
  const attachments = message.attachments?.filter(
    (attachment) => attachment.path && attachment.name,
  );
  if (!attachments?.length) return null;

  const container = document.createElement("div");
  container.className = "agent-thread-card__message-attachments";
  container.setAttribute(
    "aria-label",
    language === "zh-CN" ? "消息附件" : "Message attachments",
  );

  attachments.forEach((attachment, index) => {
    const card = document.createElement("div");
    card.className = "agent-thread-card__message-attachment";
    const attachmentLabel = language === "zh-CN"
      ? `图片附件 ${index + 1}`
      : `Image attachment ${index + 1}`;
    card.title = `${attachment.name}\n${attachment.mimeType}\n${attachment.path}`;
    card.setAttribute("aria-label", `${attachmentLabel}\n${card.title}`);

    const icon = document.createElement("span");
    icon.className = "agent-thread-card__message-attachment-icon";
    icon.append(createLucideIcon(ImageIcon));
    card.append(icon);
    container.append(card);

    if (
      attachment.type === "input_image" ||
      attachment.mimeType.toLowerCase().startsWith("image/")
    ) {
      void agent.readCachedImage(attachment.path).then((previewUrl) => {
        if (!previewUrl) return;
        const preview = document.createElement("img");
        preview.className = "agent-thread-card__message-attachment-preview";
        preview.src = previewUrl;
        preview.alt = attachment.name;
        preview.draggable = false;
        card.replaceChildren(preview);
      }).catch(() => {
        // Keep the image icon when the cached file is no longer available.
      });
    }
  });

  return container;
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
  let disposeForkConfirmation = () => undefined;
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
      if (!actions.isConnected) {
        closeConfirmation();
        return;
      }
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
    disposeForkConfirmation = () => {
      closeConfirmation();
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
  registerMessageDisposer(actions, () => {
    if (copyResetTimer !== undefined) {
      window.clearTimeout(copyResetTimer);
      copyResetTimer = undefined;
    }
    if (typeof disposeForkConfirmation === "function") {
      disposeForkConfirmation();
    }
  });
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
  prepareAgentThreadCardCodeBlockLabels(fragment);
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

  const disposeImagePreview = attachAgentMessageImagePreview(content, context.language);
  if (disposeImagePreview) registerMessageDisposer(content, disposeImagePreview);

  const forceFinalize = !options.isStreaming || !!message.isCompleted;
  renderIncrementalMarkdownDom(
    content,
    display.text,
    forceFinalize,
    translate(context.language, "editor.threadCard.copyLatex"),
  );
  if (forceFinalize) {
    void highlightAgentThreadCardCodeBlocks(content);
  }

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
    context.setDisplayExpanded(messageRenderKey(message), !expanded);
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
      item.append(...createAgentThreadCardToolMessageParts({
        message,
        messageView,
        context: {
          language,
          getDisplayExpanded,
          setDisplayExpanded,
        },
      }));
    } else if (message.role === "end") {
      const content = document.createElement("div");
      content.className = "agent-thread-card__message-content";
      content.textContent = messageView.visibleContent;
      item.append(content);
    } else if (message.role === "user") {
      const bubble = document.createElement("div");
      bubble.className = "agent-thread-card__message-user-bubble";
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
        bubble.append(badge);
      } else if (message.messageType === "codex-command") {
        const badge = document.createElement("span");
        badge.className = "agent-thread-card__message-codex-badge";
        badge.textContent = "Codex";
        bubble.append(badge);
      }
      bubble.append(content);
      item.append(bubble);
      renderAgentThreadCardBudgetedMarkdown({
        message,
        role: "user",
        visibleContent: messageView.visibleContent,
        content,
        toggleParent: bubble,
        context: displayContext,
        isStreaming: options.isStreaming,
      });
      const attachments = createUserMessageAttachments(message, language);
      if (attachments) item.append(attachments);
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
        setReasoningCollapsed(messageRenderKey(message), next);
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
