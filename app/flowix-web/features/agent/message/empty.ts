import type { ChatMessage } from "@/types";

/**
 * Assistant messages with empty or whitespace-only content render as blank
 * cards and add no value. The streaming handler skips empty chunks at the
 * source, but persisted/loaded threads can still surface empty messages —
 * this is the shared predicate used to filter them out at every boundary.
 */
export function isEmptyAssistantMessage(message: ChatMessage): boolean {
  return (
    message.role === "assistant" && (!message.content || !message.content.trim())
  );
}
