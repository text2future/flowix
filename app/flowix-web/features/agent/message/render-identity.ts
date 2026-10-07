import type { ChatMessage } from "@/types";

export function messageRenderKey(message: ChatMessage): string {
  return `${message.role}:${message.renderKey ?? message.id}`;
}
