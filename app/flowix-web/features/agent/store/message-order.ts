import type { ChatMessage } from "@/types";

function messageOrderTimestamp(message: ChatMessage): number {
  if (Number.isFinite(message.sourceTimestamp)) {
    return message.sourceTimestamp!;
  }
  const parsed = Date.parse(message.timestamp);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function compareAgentMessageOrder(
  left: ChatMessage,
  right: ChatMessage,
): number {
  const timestampDelta =
    messageOrderTimestamp(left) - messageOrderTimestamp(right);
  if (timestampDelta !== 0) return timestampDelta;

  if (left.sourceSequence !== undefined && right.sourceSequence !== undefined) {
    const sequenceDelta = left.sourceSequence - right.sourceSequence;
    if (sequenceDelta !== 0) return sequenceDelta;
  }

  if (
    left.sourceSubsequence !== undefined &&
    right.sourceSubsequence !== undefined
  ) {
    return left.sourceSubsequence - right.sourceSubsequence;
  }

  return 0;
}

export function insertAgentMessageBySourceOrder(
  messages: ChatMessage[],
  message: ChatMessage,
  preserveArrivalOrder = false,
): ChatMessage[] {
  if (preserveArrivalOrder) return [...messages, message];
  if (
    message.sourceTimestamp === undefined &&
    message.sourceSequence === undefined
  ) {
    return [...messages, message];
  }

  const insertAt = messages.findIndex(
    (existing) => compareAgentMessageOrder(message, existing) < 0,
  );
  if (insertAt < 0) return [...messages, message];
  return [...messages.slice(0, insertAt), message, ...messages.slice(insertAt)];
}

/** Sort only blocks belonging to one native Pi message. Other messages keep
 * their arrival/branch positions; no timestamps or run-local sequences mix. */
export function orderPiMessageBlocks(messages: ChatMessage[]): ChatMessage[] {
  const groups = new Map<string, number[]>();
  messages.forEach((row, index) => {
    if (!row.parentMessageId || row.piBlockIndex === undefined) return;
    const indices = groups.get(row.parentMessageId) ?? [];
    indices.push(index);
    groups.set(row.parentMessageId, indices);
  });
  let result = messages;
  for (const indices of groups.values()) {
    const ordered = indices.map((index) => messages[index])
      .sort((left, right) => left.piBlockIndex! - right.piBlockIndex!);
    indices.forEach((index, offset) => {
      if (messages[index] === ordered[offset]) return;
      if (result === messages) result = [...messages];
      result[index] = ordered[offset];
    });
  }
  return result;
}
