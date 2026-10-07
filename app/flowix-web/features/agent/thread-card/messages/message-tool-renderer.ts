import { messageRenderKey } from "@features/agent/message/render-identity";
import { translate, type AppLanguage } from "@/lib/i18n";
import {
  agentMessageValueToText,
  createAgentMessageViewModel,
} from "@features/agent/message";
import {
  normalizeToolInput,
  parseAgentCommandInput,
} from "@features/agent/tool-display";
import {
  createAgentThreadCardCommandList,
  createAgentThreadCardCommandPreview,
} from "@features/agent/thread-card/agent-thread-card-command-renderer";
import { createChevronIcon, createToolIcon } from "@features/agent/thread-card/agent-thread-card-icons";
import type { AgentMessage } from "@features/agent/thread-card/messages/message-render-context";
import { registerMessageDisposer } from "@features/agent/thread-card/messages/message-lifecycle";

interface ToolMessageRenderContext {
  language: AppLanguage;
  getDisplayExpanded: (message: AgentMessage) => boolean;
  setDisplayExpanded: (messageId: string, expanded: boolean) => void;
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

function getToolFileHref(message: AgentMessage): string | undefined {
  const display = message.toolDisplay;
  if (
    (display?.kind !== "file" && display?.kind !== "patch") ||
    !display.targetPath
  ) {
    return undefined;
  }
  return display.targetPath;
}

function createExpandableToolContent(options: {
  message: AgentMessage;
  text?: string;
  linkHref?: string;
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
    linkHref,
    language,
    getDisplayExpanded,
    setDisplayExpanded,
  } = options;
  const content = document.createElement("div");
  content.className = "agent-thread-card__message-tool-content";

  const row = document.createElement("div");
  row.className = "agent-thread-card__message-tool-row";
  content.append(row);

  const summary = text === undefined
    ? null
    : document.createElement(linkHref ? "a" : "span");
  if (summary) {
    summary.className = "agent-thread-card__message-tool-summary";
    if (linkHref && summary instanceof HTMLAnchorElement) {
      summary.classList.add("agent-thread-card__message-tool-summary--link");
      summary.setAttribute("href", linkHref);
    }
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
  let pendingVisibilityFrame: number | null = null;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "agent-thread-card__message-tool-toggle";
  toggle.append(createChevronIcon("down"));

  const syncToggleVisibility = () => {
    if (!content.isConnected) return;
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
    setDisplayExpanded(messageRenderKey(message), nextExpanded);
    applyExpandedState(nextExpanded);
  });
  toggle.addEventListener("mousedown", (event) => event.stopPropagation());
  if (isExpanded) row.append(toggle);
  applyExpandedState(isExpanded);
  pendingVisibilityFrame = requestAnimationFrame(() => {
    pendingVisibilityFrame = null;
    syncToggleVisibility();
  });
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => {
      if (!content.isConnected) {
        observer.disconnect();
        return;
      }
      syncToggleVisibility();
    });
    observer.observe(content);
    registerMessageDisposer(content, () => {
      observer.disconnect();
      if (pendingVisibilityFrame !== null) {
        cancelAnimationFrame(pendingVisibilityFrame);
        pendingVisibilityFrame = null;
      }
    });
  } else {
    registerMessageDisposer(content, () => {
      if (pendingVisibilityFrame !== null) {
        cancelAnimationFrame(pendingVisibilityFrame);
        pendingVisibilityFrame = null;
      }
    });
  }
  return content;
}

export function createAgentThreadCardToolMessageParts(options: {
  message: AgentMessage;
  messageView: ReturnType<typeof createAgentMessageViewModel>;
  context: ToolMessageRenderContext;
}): HTMLElement[] {
  const { message, messageView, context } = options;
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
      language: context.language,
      getDisplayExpanded: context.getDisplayExpanded,
      setDisplayExpanded: context.setDisplayExpanded,
      measureTarget: preview,
      alwaysShowToggle: true,
      leadingContent: preview,
      expandedContent: details,
      includeInput: false,
    });
    return [iconWrap, name, content];
  }

  const mcpToolName = getMcpToolName(message);
  const toolText = mcpToolName
    ? getMcpToolSummary(messageView.toolSummary, mcpToolName)
    : messageView.toolSummary;
  const content = createExpandableToolContent({
    message,
    text: toolText,
    linkHref: getToolFileHref(message),
    language: context.language,
    getDisplayExpanded: context.getDisplayExpanded,
    setDisplayExpanded: context.setDisplayExpanded,
  });
  if (!mcpToolName) return [iconWrap, name, content];

  const concreteName = document.createElement("span");
  concreteName.className = "agent-thread-card__message-tool-concrete-name";
  concreteName.textContent = mcpToolName;
  return [iconWrap, name, concreteName, content];
}
