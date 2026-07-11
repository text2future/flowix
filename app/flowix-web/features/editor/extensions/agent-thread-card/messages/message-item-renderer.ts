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
  createChevronIcon,
  createToolIcon,
} from "@features/editor/extensions/agent-thread-card/agent-thread-card-icons";

type AgentMessage = ThreadState["messages"][number];

// User 消息正文最大展示字符数 ── 超过截断并在末尾加省略号。
//
// 临时为以下场景做防护: Claude Code CLI 在 user-event 里会把加载到的
// skill 文档全文注入到 `tool_result` 之前的 text block, 后端
// `claude_history::value_to_chat_messages` 当前会把这种 text 累积成一
// 条 `role: "user"` 的历史消息, 重新加载 thread 时就会被当作用户输入
// 长文本铺满整个 Agent Thread Card。 这里先做展示层限长, 后续在 history
// 解析层应该正经修。
const USER_MESSAGE_PREVIEW_MAX_CHARS = 1000;
const USER_MESSAGE_PREVIEW_ELLIPSIS = "…";

function truncateUserMessagePreview(text: string): string {
  // 用 Array.from 按 code point 切, 避免 surrogate pair / CJK 字符被
  // 截在中间, 也避免单纯 .length 把 emoji 算成 2 个单位。
  const chars = Array.from(text);
  if (chars.length <= USER_MESSAGE_PREVIEW_MAX_CHARS) return text;
  return (
    chars.slice(0, USER_MESSAGE_PREVIEW_MAX_CHARS).join("") +
    USER_MESSAGE_PREVIEW_ELLIPSIS
  );
}

export interface AgentThreadCardMessageElementResult {
  element: HTMLElement;
  shouldRemember: boolean;
}

export function createAgentThreadCardMessageElement(options: {
  message: AgentMessage;
  language: AppLanguage;
  getReasoningCollapsed: (message: AgentMessage) => boolean;
  setReasoningCollapsed: (messageId: string, collapsed: boolean) => void;
}): AgentThreadCardMessageElementResult | null {
  const { message, language, getReasoningCollapsed, setReasoningCollapsed } =
    options;

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
        const summary = document.createElement("span");
        summary.className = "agent-thread-card__message-tool-summary";
        summary.textContent = messageView.toolSummary;
        item.append(summary);
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
      fillWithAgentThreadCardMarkdownHtml(
        content,
        renderAgentThreadCardMarkdownToHtml(
          truncateUserMessagePreview(messageView.visibleContent),
        ),
      );
      item.append(content);
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
      fillWithAgentThreadCardMarkdownHtml(
        content,
        renderAgentThreadCardMarkdownToHtml(messageView.visibleContent),
      );
      body.append(content);

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
      fillWithAgentThreadCardMarkdownHtml(
        content,
        renderAgentThreadCardMarkdownToHtml(messageView.visibleContent),
      );
      item.append(content);
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
