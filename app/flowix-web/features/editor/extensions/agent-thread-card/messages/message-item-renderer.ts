import type { AppLanguage } from "@features/i18n";
import type { ThreadState } from "@features/agent/store/chat-store";
import {
  createAgentMessageViewModel,
  shouldRenderAgentMessage,
} from "@features/agent/message";
import { parseAgentCommandInput } from "@features/agent/tool-display";
import {
  fillWithAgentThreadCardMarkdownHtml,
  renderAgentThreadCardMarkdownToHtml,
} from "@features/editor/extensions/agent-thread-card/agent-thread-card-markdown";
import {
  createAgentThreadCardCommandList,
  createAgentThreadCardMessageFallback,
} from "@features/editor/extensions/agent-thread-card/agent-thread-card-command-renderer";
import {
  applyMessageDisplayBudget,
  truncateToolMessageForDisplay,
  type MessageDisplayBudgetRole,
} from "@features/agent/message/display-limits";
import {
  createChevronIcon,
  createToolIcon,
} from "@features/editor/extensions/agent-thread-card/agent-thread-card-icons";

type AgentMessage = ThreadState["messages"][number];

export interface AgentThreadCardMessageElementResult {
  element: HTMLElement;
  shouldRemember: boolean;
}

export interface AgentThreadCardMessageDisplayContext {
  language: AppLanguage;
  getDisplayExpanded: (message: AgentMessage) => boolean;
  setDisplayExpanded: (messageId: string, expanded: boolean) => void;
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

export function renderAgentThreadCardBudgetedMarkdown(options: {
  message: AgentMessage;
  role: MessageDisplayBudgetRole;
  visibleContent: string;
  content: HTMLElement;
  toggleParent: HTMLElement;
  context: AgentThreadCardMessageDisplayContext;
}): void {
  const { message, role, visibleContent, content, toggleParent, context } =
    options;
  const expanded = context.getDisplayExpanded(message);
  const display = applyMessageDisplayBudget(role, visibleContent, expanded);

  fillWithAgentThreadCardMarkdownHtml(
    content,
    renderAgentThreadCardMarkdownToHtml(display.text),
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
  } catch (err) {
    console.error("Failed to prepare AgentThreadCard message:", err, message);
    return {
      element: createAgentThreadCardMessageFallback(message, language),
      shouldRemember: true,
    };
  }

  try {
    if (message.role === "tool") {
      const icon = createToolIcon(message.toolName, message.toolAgentType);
      const name = document.createElement("span");
      name.className = "agent-thread-card__message-tool-name";
      name.textContent = messageView.toolLabel;
      const command = parseAgentCommandInput(message.toolInput);
      if (command && message.toolDisplay?.kind === "command") {
        item.classList.add("agent-thread-card__message--tool-command");
        const head = document.createElement("div");
        head.className = "agent-thread-card__message-tool-head";
        head.append(icon, name);
        const body = document.createElement("div");
        body.className = "agent-thread-card__message-tool-body";
        body.append(createAgentThreadCardCommandList(command));
        item.append(head, body);
      } else {
        item.append(icon, name);
        const summaryText = truncateToolMessageForDisplay(
          messageView.toolSummary,
        );
        if (
          message.toolAgentType === "codex" &&
          message.toolName === "mcp_tool_call"
        ) {
          const separatorIndex = summaryText.indexOf(" · ");
          const concreteName = document.createElement("span");
          concreteName.className =
            "agent-thread-card__message-tool-concrete-name";
          concreteName.textContent = separatorIndex >= 0
            ? summaryText.slice(0, separatorIndex)
            : summaryText;
          item.append(concreteName);

          if (separatorIndex >= 0) {
            const summary = document.createElement("span");
            summary.className = "agent-thread-card__message-tool-summary";
            summary.textContent = summaryText.slice(separatorIndex + 3);
            item.append(summary);
          }
        } else {
          const summary = document.createElement("span");
          summary.className = "agent-thread-card__message-tool-summary";
          summary.textContent = summaryText;
          item.append(summary);
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
      item.append(content);
      renderAgentThreadCardBudgetedMarkdown({
        message,
        role: "user",
        visibleContent: messageView.visibleContent,
        content,
        toggleParent: item,
        context: displayContext,
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
      renderAgentThreadCardBudgetedMarkdown({
        message,
        role: "reasoning",
        visibleContent: messageView.visibleContent,
        content,
        toggleParent: body,
        context: displayContext,
      });

      const apply = (collapsed: boolean): void => {
        item.classList.toggle(
          "agent-thread-card__message--reasoning-collapsed",
          collapsed,
        );
      };
      apply(getReasoningCollapsed(message));
      header.addEventListener("click", (event) => {
        event.stopPropagation();
        const next = !item.classList.contains(
          "agent-thread-card__message--reasoning-collapsed",
        );
        setReasoningCollapsed(message.id, next);
        apply(next);
      });
      header.addEventListener("mousedown", (event) => {
        event.stopPropagation();
      });

      item.append(header, body);
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
      });
    }

    return { element: item, shouldRemember: true };
  } catch (err) {
    console.error("Failed to render AgentThreadCard message:", err, message);
    return {
      element: createAgentThreadCardMessageFallback(message, language),
      shouldRemember: true,
    };
  }
}
