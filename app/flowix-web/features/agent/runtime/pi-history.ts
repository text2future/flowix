import type { ChatMessage } from "@/types";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    const block = record(part);
    if (block?.type === "text" && typeof block.text === "string") return block.text;
    if (block?.type === "image") return "[Image attachment]";
    return "";
  }).filter(Boolean).join("\n");
}

function timestamp(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : new Date(0).toISOString();
}

function toolResultText(message: JsonRecord): string {
  const text = contentText(message.content);
  return message.isError === true ? `[error] ${text || "Tool failed"}` : text;
}

function bashExecutionText(message: JsonRecord): string {
  const output = typeof message.output === "string" ? message.output : "";
  const exitCode = typeof message.exitCode === "number" ? message.exitCode : null;
  const cancelled = message.cancelled === true;
  const failed = exitCode !== null && exitCode !== 0;
  const lines = [
    failed || cancelled
      ? `[error] ${output || "Command failed"}`
      : output || "(no output)",
  ];
  if (cancelled) lines.push("(command cancelled)");
  else if (failed) lines.push(`Command exited with code ${exitCode}`);
  if (message.truncated === true) {
    const fullOutputPath = typeof message.fullOutputPath === "string"
      ? ` Full output: ${message.fullOutputPath}`
      : "";
    lines.push(`[Output truncated.${fullOutputPath}]`);
  }
  return lines.filter(Boolean).join("\n\n");
}

/** Convert Pi's native AgentMessage union into Flowix's display message rows. */
export function parsePiHistoryMessages(
  threadId: string,
  values: unknown,
): ChatMessage[] {
  if (!Array.isArray(values)) return [];
  const native = values.map(record).filter((value): value is JsonRecord => value !== null);
  const resultsByCallId = new Map<string, JsonRecord>();
  for (const message of native) {
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      resultsByCallId.set(message.toolCallId, message);
    }
  }

  const messages: ChatMessage[] = [];
  const append = (
    nativeIndex: number,
    blockIndex: number,
    message: Omit<ChatMessage, "sourceSequence">,
  ) => {
    messages.push({
      ...message,
      sourceSequence: messages.length,
      sourceTimestamp: Date.parse(message.timestamp),
      id: message.id || `pi:${threadId}:${nativeIndex}:${blockIndex}`,
    });
  };

  native.forEach((message, nativeIndex) => {
    const role = message.role;
    const time = timestamp(message.timestamp);
    if (role === "system" || role === "toolResult") return;

    if (role === "user") {
      const content = contentText(message.content) || "[Image attachment]";
      append(nativeIndex, 0, { id: "", role: "user", content, timestamp: time });
      return;
    }

    if (role === "assistant") {
      const blocks = Array.isArray(message.content) ? message.content : [];
      if (typeof message.content === "string" && message.content) {
        append(nativeIndex, 0, {
          id: "", role: "assistant", content: message.content, timestamp: time,
          isCompleted: message.stopReason !== "pending",
        });
      }
      blocks.forEach((part, blockIndex) => {
        const block = record(part);
        if (!block) return;
        if (block.type === "text" && typeof block.text === "string" && block.text) {
          append(nativeIndex, blockIndex, {
            id: "", role: "assistant", content: block.text, timestamp: time,
            isCompleted: message.stopReason !== "pending",
          });
        } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
          append(nativeIndex, blockIndex, {
            id: "", role: "reasoning", content: block.thinking, timestamp: time,
            isCompleted: true,
          });
        } else if (block.type === "toolCall" && typeof block.id === "string") {
          const result = resultsByCallId.get(block.id);
          const output = result ? toolResultText(result) : "";
          append(nativeIndex, blockIndex, {
            id: "", role: "tool", content: output, timestamp: time,
            toolCallId: block.id,
            toolName: typeof block.name === "string" ? block.name : "tool",
            toolAgentType: "pi",
            toolInput: record(block.arguments) ?? {},
            toolData: output,
            isLoading: false,
            isCompleted: true,
          });
        }
      });
      if (message.stopReason === "error" && typeof message.errorMessage === "string") {
        append(nativeIndex, blocks.length, {
          id: "", role: "assistant", content: message.errorMessage, timestamp: time,
          isCompleted: true,
        });
      }
      return;
    }

    if (role === "bashExecution") {
      const command = typeof message.command === "string" ? message.command : "";
      const output = bashExecutionText(message);
      append(nativeIndex, 0, {
        id: "", role: "tool", content: output, timestamp: time,
        toolCallId: `pi-bash:${nativeIndex}`,
        toolName: "bash",
        toolAgentType: "pi",
        toolInput: { command },
        toolData: output,
        isLoading: false,
        isCompleted: true,
      });
      return;
    }

    if (role === "custom" && message.display === true) {
      append(nativeIndex, 0, {
        id: "", role: "assistant", messageType: "agent-commentary",
        content: contentText(message.content), timestamp: time,
      });
      return;
    }

    if (role === "branchSummary" || role === "compactionSummary") {
      const summary = typeof message.summary === "string" ? message.summary : "";
      if (summary) {
        append(nativeIndex, 0, {
          id: "", role: "assistant", messageType: "context-compaction",
          content: summary, timestamp: time,
        });
      }
    }
  });

  return messages;
}

/** Pi RPC returns the whole transcript; Flowix pages it in complete turns. */
export function pagePiHistory(
  messages: ChatMessage[],
  beforeSequence: number | null,
  limit: number,
  snapshotSequence: number | null = null,
) {
  const snapshot = snapshotSequence ?? messages.length;
  const stable = messages.filter((message) =>
    (message.sourceSequence ?? -1) < snapshot,
  );
  let upper = stable.length;
  if (beforeSequence !== null) {
    const cursorIndex = stable.findIndex(
      (message) => message.sourceSequence === beforeSequence,
    );
    upper = cursorIndex >= 0 ? cursorIndex : stable.findIndex(
      (message) => (message.sourceSequence ?? -1) >= beforeSequence,
    );
    if (upper < 0) upper = stable.length;
  }
  const starts = [0];
  for (let index = 1; index < upper; index += 1) {
    if (stable[index].role === "user") starts.push(index);
  }
  const firstTurn = Math.max(0, starts.length - Math.max(1, limit));
  const start = starts[firstTurn] ?? 0;
  const page = stable.slice(start, upper);
  return {
    messages: page,
    oldestSequence: page[0]?.sourceSequence ?? null,
    hasMore: start > 0,
    snapshotSequence: snapshot,
  };
}
