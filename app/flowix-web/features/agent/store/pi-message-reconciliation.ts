import type { ChatMessage } from "@/types";
import { messageRenderKey } from "@features/agent/message/render-identity";

export class PiHistorySnapshotChangedError extends Error {
  constructor() {
    super("Pi history branch changed; refresh history before loading older pages");
    this.name = "PiHistorySnapshotChangedError";
  }
}

/** Coverage is supplied by the history adapter, never inferred from timestamps. */
export type PiTimelineSource =
  | { kind: "live-projection" }
  | { kind: "snapshot"; coverage: "full-branch" | "latest-page" | "page";
      /** Immutable projection version captured BEFORE starting the RPC read. */
      requestProjection?: readonly ChatMessage[] };

export function piRowIdentity(message: Pick<ChatMessage, "id" | "role" | "messageId" | "piBlockIndex">): string {
  const block = message.piBlockIndex !== undefined &&
    (message.role === "assistant" || message.role === "reasoning")
    ? `:block:${message.piBlockIndex}` : "";
  return `${message.role}\u0000${message.messageId ?? message.id}${block}`;
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
      ? { ...existing, ...row, renderKey: existing.renderKey ?? (row.renderKey ? existing.id : undefined) }
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
