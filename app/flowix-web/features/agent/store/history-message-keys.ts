import type { ChatMessage } from "@/types";
import { stripSystemBlock } from "@features/agent/message";

// Message keys used to compare a live projection against a history snapshot.
// Split out of `thread-history.ts` to keep that module under the千行 gate.

// Cheap content fingerprint used as a Map key for dedup. Two independent
// FNV-1a 32-bit hashes combined give an effectively 64-bit collision space
// while walking each string only once with constant per-character work.
// Replaces JSON.stringify(content) which, on multi-MB assistant responses,
// allocated several MB of UTF-16 strings per message per streaming flush.
// Collisions remain theoretically possible but vanishingly unlikely for chat
// history; the dedup logic treats a collision as "duplicate, skip" which is
// benign.
export function contentFingerprint(content: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  const prime1 = 0x01000193;
  const prime2 = 0x85ebca6b;
  for (let i = 0; i < content.length; i += 1) {
    const c = content.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, prime1);
    h2 = Math.imul(h2 ^ c, prime2);
  }
  return `${h1 >>> 0}:${h2 >>> 0}`;
}

export function userMessageVisibleKey(message: ChatMessage): string | null {
  if (message.role !== "user") return null;
  return `user:visible:${contentFingerprint(stripSystemBlock(message.content || ""))}`;
}

export function messageContentStableKey(message: ChatMessage): string | null {
  if (message.role === "user") return userMessageVisibleKey(message);
  if (
    message.role === "assistant" ||
    message.role === "reasoning" ||
    message.role === "end"
  ) {
    const content = (message.content || "").replace(/\r\n/g, "\n").trim();
    if (!content) return null;
    return `${message.role}:${contentFingerprint(content)}`;
  }
  if (message.role === "tool" && message.toolCallId) {
    return `tool:${message.toolCallId}:${contentFingerprint(message.content || "")}`;
  }
  return null;
}

export function toolCallIdentityKey(toolCallId: string): string {
  const marker = ":tool-call:";
  const markerIndex = toolCallId.lastIndexOf(marker);
  return markerIndex >= 0 ? toolCallId.slice(markerIndex + marker.length) : toolCallId;
}
