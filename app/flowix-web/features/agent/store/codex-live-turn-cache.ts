import type { ChatMessage } from "@/types";
import { completedRunUserMessageId } from "@features/agent/events/message-identity";

export interface CodexLiveTurnCache {
  runId: string;
  /** Codex turn id once any event of the run carried it; anchors the slice. */
  turnId?: string;
  messages: ChatMessage[];
  /** Running data is an overlay; completed data is waiting to be replaced by history. */
  status: "running" | "completed";
  updatedAt: number;
}

export function liveTurnMessages(
  messages: ChatMessage[],
  runId: string,
  turnId?: string,
): ChatMessage[] {
  const anchorId = completedRunUserMessageId("codex", runId);
  const anchor = messages.findIndex(
    (message) =>
      message.id === anchorId ||
      message.id === `user-${runId}` ||
      // Once the provider userMessage item adopts the optimistic row, the
      // run boundary is the turn-scoped user row, not the run-scoped id.
      (!!turnId && message.role === "user" && message.codexTurnId === turnId),
  );
  if (anchor >= 0) return messages.slice(anchor);
  // Native `/compact` and `/goal` operations have no provider userMessage
  // anchor. Keep their product-owned command row in the live overlay so a
  // history refresh cannot erase it while the RPC/turn is still completing.
  return messages.filter((message) => message.messageType === "codex-command");
}
