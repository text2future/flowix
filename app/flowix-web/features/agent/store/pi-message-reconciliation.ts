import type { ChatMessage } from "@/types";
import { messageRenderKey } from "@features/agent/message/render-identity";

/** Coverage is supplied by the history adapter, never inferred from timestamps. */
export type PiTimelineSource =
  | { kind: "live-projection" }
  | { kind: "snapshot"; coverage: "full-branch" | "latest-page" | "page";
      /** Immutable projection version captured BEFORE starting the RPC read. */
      requestProjection?: readonly ChatMessage[] };

export function piRowIdentity(
  message: Pick<ChatMessage, "id" | "role" | "messageId" | "piBlockIndex"> & {
    toolCallId?: string;
  },
): string {
  // A tool row's native identity is its call id. Pi's live row names itself
  // `tool-<callId>` because `tool_execution_start` carries no native message
  // id (the completed assistant snapshot only supplies the parent entry), while
  // the persisted row uses the call id directly. Keying on `messageId` alone
  // therefore produced two identities for one call, and the live row survived
  // completion reconciliation as a duplicate tool row.
  const base = message.role === "tool" && message.toolCallId
    ? message.toolCallId
    : message.messageId ?? message.id;
  const block = message.piBlockIndex !== undefined &&
    (message.role === "assistant" || message.role === "reasoning")
    ? `:block:${message.piBlockIndex}` : "";
  return `${message.role}\u0000${base}${block}`;
}

/**
 * Live projections own their entire covered suffix, including its order and
 * draft upgrades. Snapshots own committed content and the indicated branch
 * range. Native identity reconciles persisted rows; render identity reconciles
 * a draft with its committed row. Neither contract uses content or timestamps.
 */
export function reconcilePiTimeline(
  current: ChatMessage[], incoming: ChatMessage[], source: PiTimelineSource,
): ChatMessage[] {
  const incomingIds = new Set(incoming.map(piRowIdentity));
  const incomingRenderKeys = new Set(incoming.map(messageRenderKey));
  const matches = (row: ChatMessage) => incomingIds.has(piRowIdentity(row)) ||
    incomingRenderKeys.has(messageRenderKey(row));
  const overlap = current.findIndex(matches);

  if (source.kind === "live-projection") {
    if (incoming.length === 0) return current;
    const prefix = overlap < 0 ? current : current.slice(0, overlap);
    const result = [...prefix, ...incoming];
    return reuseArray(current, result);
  }

  const baselineByRenderKey = source.requestProjection
    ? new Map(source.requestProjection.map((row) => [messageRenderKey(row), row])) : undefined;
  const advancedSinceRead = (row: ChatMessage) => baselineByRenderKey !== undefined &&
    baselineByRenderKey.get(messageRenderKey(row)) !== row;
  const currentById = new Map(current.map((row) => [piRowIdentity(row), row]));
  const currentByRenderKey = new Map(current.map((row) => [messageRenderKey(row), row]));
  const prefix = source.coverage !== "full-branch" && overlap > 0
    ? current.slice(0, overlap) : [];
  const seen = new Set(prefix.map(piRowIdentity));
  const seenRenderKeys = new Set(prefix.map(messageRenderKey));
  const committed = incoming.map((row) => {
    const existing = currentById.get(piRowIdentity(row)) ?? currentByRenderKey.get(messageRenderKey(row));
    if (existing && advancedSinceRead(existing)) {
      seen.add(piRowIdentity(existing));
      seenRenderKeys.add(messageRenderKey(existing));
      return existing;
    }
    const reconciled = existing && existing !== row
      ? {
          ...existing,
          ...row,
          renderKey: existing.renderKey ?? (row.renderKey ? existing.id : undefined),
          // The live user row holds Flowix's visible prompt; Pi history can
          // contain extra runtime context that should stay out of the composer timeline.
          ...(row.role === "user" ? {
            content: existing.content,
            attachments: existing.attachments ?? row.attachments,
          } : {}),
        }
      : row;
    seen.add(piRowIdentity(reconciled));
    seenRenderKeys.add(messageRenderKey(reconciled));
    return reconciled;
  });
  const tail = current.filter((row) => {
    if (seen.has(piRowIdentity(row)) || seenRenderKeys.has(messageRenderKey(row))) return false;
    // A page may have rows on either side outside its coverage. A latest page
    // covers the tail, so committed rows absent there belong to an old branch.
    if (source.coverage !== "page" && row.messageId !== null && !advancedSinceRead(row)) return false;
    seen.add(piRowIdentity(row));
    seenRenderKeys.add(messageRenderKey(row));
    return true;
  });
  return reuseArray(current, [...prefix, ...committed, ...tail]);
}

function reuseArray(current: ChatMessage[], next: ChatMessage[]): ChatMessage[] {
  return current.length === next.length && next.every((row, index) => row === current[index])
    ? current : next;
}
