import type { ChatMessage } from "@/types";
import { getToolLabel } from "@features/agent/message/tools";
import { stripSystemBlock } from "@features/agent/message/system";
import { isEmptyAssistantMessage } from "@features/agent/message/empty";
import { translate, type AppLanguage } from "@features/i18n";
import { getAgentToolInputSummary as getFallbackAgentToolInputSummary } from "@features/agent/tool-display";

export interface AgentMessageViewModel {
  message: ChatMessage;
  role: ChatMessage["role"];
  visibleContent: string;
  shouldRender: boolean;
  reasoningLabel: string;
  toolLabel: string;
  toolSummary: string;
  endTimeText: string;
}

export function agentMessageValueToText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function getAgentToolInputSummary(
  input?: Record<string, unknown>,
): string {
  return getFallbackAgentToolInputSummary(input);
}

export function getAgentReasoningLabel(
  message: ChatMessage,
  language: AppLanguage = "zh-CN",
): string {
  return translate(
    language,
    message.isCompleted
      ? "agent.reasoning.completed"
      : "agent.reasoning.thinking",
  );
}

export function getAgentMessageEndTimeText(
  message: ChatMessage,
  language: AppLanguage = "zh-CN",
): string {
  if (!message.timestamp) {
    return new Date().toLocaleTimeString(
      language === "zh-CN" ? "zh-CN" : "en-US",
    );
  }

  return new Intl.DateTimeFormat(language === "zh-CN" ? "zh-CN" : "en-US", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(message.timestamp));
}

export function getAgentMessageVisibleContent(
  message: ChatMessage,
  language: AppLanguage = "zh-CN",
): string {
  if (message.role === "user") {
    return stripSystemBlock(message.content || "");
  }

  if (message.role === "end") {
    return message.content || getAgentMessageEndTimeText(message, language);
  }

  return message.content || "";
}

export function shouldRenderAgentMessage(message: ChatMessage): boolean {
  return !isEmptyAssistantMessage(message);
}

export function createAgentMessageViewModel(
  message: ChatMessage,
  language: AppLanguage = "zh-CN",
): AgentMessageViewModel {
  return {
    message,
    role: message.role,
    visibleContent: getAgentMessageVisibleContent(message, language),
    shouldRender: shouldRenderAgentMessage(message),
    reasoningLabel: getAgentReasoningLabel(message, language),
    toolLabel: getToolLabel(
      { agentType: message.toolAgentType, toolName: message.toolName },
      language,
    ),
    toolSummary:
      message.toolDisplay?.summary ||
      getAgentToolInputSummary(message.toolInput),
    endTimeText: getAgentMessageEndTimeText(message, language),
  };
}
