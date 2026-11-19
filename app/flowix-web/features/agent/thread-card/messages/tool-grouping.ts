import type { ChatMessage } from "@/types";
import {
  extractGeneratedImageSources,
  type GeneratedImageSource,
} from "@features/agent/thread-card/messages/generated-image-results";

export type AgentToolGroupStatus = "completed" | "running" | "failed";

export type AgentRenderItem =
  | {
      kind: "message";
      message: ChatMessage;
    }
  | {
      kind: "tool-group";
      id: string;
      /** Tools whose result is available and can be expanded as details. */
      completedTools: ChatMessage[];
      /** Tools still executing; rendered as the group's trailing progress rows. */
      runningTools: ChatMessage[];
      totalCount: number;
      status: AgentToolGroupStatus;
    }
  | {
      kind: "generated-images";
      id: string;
      images: GeneratedImageSource[];
    };

export function isFailedToolMessage(message: ChatMessage): boolean {
  if (message.role !== "tool") return false;
  if (message.isLoading) return false;
  if (!message.content && !message.toolData) return true;
  return /^\s*\[error\]/i.test(message.content || message.toolData || "");
}

function getToolGroupStatus(
  tools: ChatMessage[],
  waitingForAssistantContent: boolean,
): AgentToolGroupStatus {
  if (tools.some((tool) => tool.isLoading)) return "running";
  if (waitingForAssistantContent) return "running";
  if (tools.some(isFailedToolMessage)) return "failed";
  return "completed";
}

function createToolGroup(
  tools: ChatMessage[],
  waitingForAssistantContent: boolean,
): Extract<AgentRenderItem, { kind: "tool-group" }> {
  const id = `tool-group:${tools[0].renderKey ?? tools[0].id}`;
  const completedTools = tools.filter((tool) => !tool.isLoading);
  const runningTools = tools.filter((tool) => tool.isLoading);
  return {
    kind: "tool-group",
    // The first tool id is stable across live updates and history hydration.
    id,
    completedTools,
    runningTools,
    totalCount: tools.length,
    status: getToolGroupStatus(tools, waitingForAssistantContent),
  };
}

function hasAssistantContent(message: ChatMessage): boolean {
  return (
    message.role === "assistant" &&
    Boolean(
      (message.content || "").trim() || (message.llmContent || "").trim(),
    )
  );
}

function isCodemodeChildTool(message: ChatMessage, parentIds: Set<string>): boolean {
  const callId = message.toolCallId ?? message.id;
  for (let index = callId.indexOf("/"); index >= 0; index = callId.indexOf("/", index + 1)) {
    if (parentIds.has(callId.slice(0, index))) return true;
  }
  return false;
}

/**
 * Converts the raw message sequence into render units. A non-tool row always
 * flushes the current run, including rows that the message renderer later
 * decides not to display. This preserves the protocol's definition of
 * "consecutive" and prevents hidden assistant rows from joining two groups.
 */
export function groupAgentMessages(
  messages: ChatMessage[],
  /** Whether the current thread turn is still producing output. */
  isLoading = false,
): AgentRenderItem[] {
  const items: AgentRenderItem[] = [];
  const codemodeParentIds = new Set(messages
    .filter((message) => message.role === "tool" && message.toolName?.toLowerCase() === "codemode")
    .map((message) => message.toolCallId ?? message.id));
  let toolRun: ChatMessage[] = [];
  let lastToolIndex = -1;

  // A tool result can arrive before the next assistant delta. Keep the group
  // in its progress state throughout that gap, but only while the run is still
  // the thread tail: assistant content after the run proves it already
  // answered, and a user row starts a new turn segment. Either one closes the
  // group — a steering message appended between tool rows splits the group but
  // must finish the half in front of it. An empty assistant placeholder is not
  // content, so it keeps the group running.
  const isTrailingRunAfter = new Array<boolean>(messages.length).fill(false);
  let runClosed = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    isTrailingRunAfter[index] = !runClosed;
    const message = messages[index];
    if (message.role === "user" || hasAssistantContent(message)) {
      runClosed = true;
    }
  }

  const flushTools = () => {
    if (toolRun.length > 0) {
      const group = createToolGroup(
        toolRun,
        isLoading && isTrailingRunAfter[lastToolIndex],
      );
      items.push(group);
      const images = toolRun.flatMap((tool) =>
        tool.toolAgentType === "codex" &&
          ["image_generation", "image_generation_call"].includes(
            tool.toolName?.toLowerCase() ?? "",
          )
          ? extractGeneratedImageSources(tool)
          : [],
      );
      if (images.length > 0) {
        items.push({
          kind: "generated-images",
          id: `${group.id}:generated-images`,
          images,
        });
      }
    }
    toolRun = [];
    lastToolIndex = -1;
  };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "tool") {
      if (isCodemodeChildTool(message, codemodeParentIds)) continue;
      toolRun.push(message);
      lastToolIndex = index;
      continue;
    }
    flushTools();
    items.push({ kind: "message", message });
  }
  flushTools();
  return items;
}

export function areAgentRenderItemsEqual(
  left: AgentRenderItem,
  right: AgentRenderItem,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "message" && right.kind === "message") {
    return left.message === right.message;
  }
  if (left.kind === "generated-images" && right.kind === "generated-images") {
    return left.id === right.id &&
      left.images.length === right.images.length &&
      left.images.every((image, index) =>
        image.kind === right.images[index]?.kind &&
        image.value === right.images[index]?.value,
      );
  }
  if (left.kind !== "tool-group" || right.kind !== "tool-group") return false;
  if (
    left.id !== right.id ||
    left.status !== right.status ||
    left.totalCount !== right.totalCount ||
    left.completedTools.length !== right.completedTools.length ||
    left.runningTools.length !== right.runningTools.length
  ) {
    return false;
  }
  return (
    left.completedTools.every(
      (tool, index) => tool === right.completedTools[index],
    ) &&
    left.runningTools.every(
      (tool, index) => tool === right.runningTools[index],
    )
  );
}
