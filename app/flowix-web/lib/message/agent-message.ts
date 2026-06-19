import type { ChatMessage } from "../../types";
import { extractFileName, formatToolName } from "./format";
import { stripSystemBlock } from "./system";
import { isEmptyAssistantMessage } from "./empty";

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
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function getAgentToolInputSummary(input?: Record<string, unknown>): string {
  if (!input) return "";

  const pathLike = input.path ?? input.pattern ?? input.command ?? input.cwd;
  if (typeof pathLike === "string" && pathLike.length > 0) {
    return extractFileName(pathLike);
  }

  const first = Object.entries(input)[0];
  return first
    ? `${first[0]}: ${agentMessageValueToText(first[1]).split("\n")[0]}`
    : "";
}

export function getAgentReasoningLabel(message: ChatMessage): string {
  return message.isCompleted ? "思考完成" : "思考中";
}

export function getAgentMessageEndTimeText(message: ChatMessage): string {
  if (!message.timestamp) {
    return new Date().toLocaleTimeString();
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(message.timestamp));
}

export function getAgentMessageVisibleContent(message: ChatMessage): string {
  if (message.role === "user") {
    return stripSystemBlock(message.content || "");
  }

  if (message.role === "end") {
    return message.content || getAgentMessageEndTimeText(message);
  }

  return message.content || "";
}

export function shouldRenderAgentMessage(message: ChatMessage): boolean {
  return !isEmptyAssistantMessage(message);
}

export function createAgentMessageViewModel(message: ChatMessage): AgentMessageViewModel {
  return {
    message,
    role: message.role,
    visibleContent: getAgentMessageVisibleContent(message),
    shouldRender: shouldRenderAgentMessage(message),
    reasoningLabel: getAgentReasoningLabel(message),
    toolLabel: formatToolName(message.toolName),
    toolSummary: getAgentToolInputSummary(message.toolInput),
    endTimeText: getAgentMessageEndTimeText(message),
  };
}
