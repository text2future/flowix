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
  _threadId: string,
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
  let nativeSequence: number | undefined;
  const append = (message: Omit<ChatMessage, "sourceSequence">) => {
    if (!message.id) return;
    messages.push({
      ...message,
      messageId: message.messageId ?? message.id,
      renderKey: message.renderKey ?? message.id,
      sourceSequence: nativeSequence ?? messages.length,
      sourceTimestamp: Date.parse(message.timestamp),
    });
  };

  native.forEach((message) => {
    nativeSequence = typeof message._pi_history_sequence === "number" ? message._pi_history_sequence : undefined;
    const messageId = typeof message._pi_session_message_id === "string"
      ? message._pi_session_message_id
      : "";
    const parentMessageId = typeof message._pi_session_parent_id === "string"
      ? message._pi_session_parent_id
      : undefined;
    const role = message.role;
    const time = timestamp(message.timestamp);
    if (role === "system" || role === "toolResult") return;

    if (role === "user") {
      const content = contentText(message.content) || "[Image attachment]";
      append({ id: messageId, role: "user", content, timestamp: time });
      return;
    }

    if (role === "assistant") {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const rows: Array<{
        order: number;
        type: "text" | "thinking" | "tool";
        content?: string;
        block?: JsonRecord;
      }> = [];
      let textRow: (typeof rows)[number] | undefined;
      if (typeof message.content === "string" && message.content) {
        textRow = { order: 0, type: "text", content: message.content };
        rows.push(textRow);
      }
      blocks.forEach((part, arrayIndex) => {
        const block = record(part);
        if (!block) return;
        const blockIndex = typeof block._pi_content_index === "number" ? block._pi_content_index : arrayIndex;
        if (block.type === "text" && typeof block.text === "string" && block.text) {
          textRow = { order: blockIndex, type: "text", content: block.text };
          rows.push(textRow);
        } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
          rows.push({ order: blockIndex, type: "thinking", content: block.thinking });
        } else if (block.type === "toolCall" && typeof block.id === "string") {
          rows.push({ order: blockIndex, type: "tool", block });
        }
      });
      if (typeof message.errorMessage === "string" && message.errorMessage) {
        if (textRow && rows[rows.length - 1] === textRow) textRow.content = `${textRow.content ?? ""}\n\n${message.errorMessage}`;
        else {
          textRow = { order: blocks.length, type: "text", content: message.errorMessage };
          rows.push(textRow);
        }
      }
      rows.sort((left, right) => left.order - right.order);
      for (const row of rows) {
        if (row.type === "text") {
          append({
            id: `${messageId}:block:${row.order}`,
            messageId,
            piBlockIndex: row.order,
            parentMessageId: messageId,
            role: "assistant",
            content: row.content ?? "",
            timestamp: time,
            isCompleted: message.stopReason !== "pending",
          });
        } else if (row.type === "thinking") {
          append({
            id: `${messageId}:block:${row.order}`,
            messageId,
            piBlockIndex: row.order,
            parentMessageId: messageId,
            role: "reasoning",
            content: row.content ?? "",
            timestamp: time,
            isCompleted: true,
          });
        } else if (row.block && typeof row.block.id === "string") {
          const callId = row.block.id;
          const result = resultsByCallId.get(callId);
          const output = result ? toolResultText(result) : "";
          append({
            id: callId,
            piBlockIndex: row.order,
            role: "tool",
            content: output,
            timestamp: time,
            toolCallId: callId,
            parentMessageId: messageId,
            toolName: typeof row.block.name === "string" ? row.block.name : "tool",
            toolAgentType: "pi",
            toolInput: record(row.block.arguments) ?? {},
            toolData: output,
            isLoading: result === undefined,
            isCompleted: result !== undefined,
          });
        }
      }
      return;
    }

    if (role === "bashExecution") {
      const command = typeof message.command === "string" ? message.command : "";
      const output = bashExecutionText(message);
      append({
        id: messageId, role: "tool", content: output, timestamp: time,
        toolCallId: messageId,
        parentMessageId,
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
      append({
        id: messageId, role: "assistant", messageType: "agent-commentary",
        content: contentText(message.content), timestamp: time,
      });
      return;
    }

    if (role === "branchSummary" || role === "compactionSummary") {
      const summary = typeof message.summary === "string" ? message.summary : "";
      if (summary) {
        append({
          id: messageId, role: "assistant", messageType: "context-compaction",
          content: summary, timestamp: time,
        });
      }
    }
  });

  return messages;
}
