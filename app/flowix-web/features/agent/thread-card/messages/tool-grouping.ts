import type { ChatMessage } from "@/types";

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
): AgentRenderItem {
  const id = `tool-group:${tools[0].id}`;
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
  let toolRun: ChatMessage[] = [];
  let lastToolIndex = -1;

  // A tool result can arrive before the next assistant delta. Keep the group
  // in its progress state throughout that gap, but only for the active run.
  // Walking backwards also makes an empty assistant placeholder count as no
  // content while respecting the next user message as a turn boundary.
  const hasAssistantContentAfter = new Array<boolean>(messages.length).fill(false);
  let seenAssistantContent = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    hasAssistantContentAfter[index] = seenAssistantContent;
    if (messages[index].role === "user") {
      seenAssistantContent = false;
    } else if (hasAssistantContent(messages[index])) {
      seenAssistantContent = true;
    }
  }

  const flushTools = () => {
    if (toolRun.length > 0) {
      items.push(
        createToolGroup(
          toolRun,
          isLoading && !hasAssistantContentAfter[lastToolIndex],
        ),
      );
    }
    toolRun = [];
    lastToolIndex = -1;
  };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "tool") {
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
