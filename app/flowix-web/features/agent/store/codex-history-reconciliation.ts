import type { ChatMessage } from "@/types";
import type { HistoryCoverage } from "./agent-history-adapters";
import {
  hydrateHistoricalMessages,
  preserveLiveUserMessagePresentation,
  reuseRenderEquivalentMessageReferences,
} from "./thread-history";

interface TurnRows { id: string; messages: ChatMessage[] }

export interface CodexHistoryWindow {
  start: number | null;
  end: number | null;
}

/** Missing tool metadata inherits its owning turn, never a timestamp order. */
function turns(messages: readonly ChatMessage[], runId?: string | null, turnId?: string | null): TurnRows[] {
  const result: TurnRows[] = [];
  const byId = new Map<string, TurnRows>();
  let owner: string | undefined;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "user") {
      owner = message.codexTurnId ?? (message.id === `user-${runId}` ? turnId ?? undefined : undefined);
      if (!owner) {
        // A provider item can arrive before the optimistic user adopts its id.
        for (let next = index + 1; next < messages.length && messages[next].role !== "user"; next += 1) {
          if (messages[next].codexTurnId) { owner = messages[next].codexTurnId; break; }
        }
      }
    }
    owner = message.codexTurnId ?? owner;
    const id = owner ?? `unbound:${message.id}`;
    let group = byId.get(id);
    if (!group) { group = { id, messages: [] }; byId.set(id, group); result.push(group); }
    group.messages.push(message);
  }
  return result;
}

function applicationRow(row: ChatMessage): boolean {
  return row.role === "system" || row.role === "end" || row.messageType === "codex-command";
}

/** Terminal status alone is insufficient: every already completed item must
 * also be materialized. Draft compatibility is confined to its owning turn. */
export function codexHistoryCoversTurn(history: ChatMessage[], live: ChatMessage[]): boolean {
  const byId = new Map(history.map((row) => [row.id, row]));
  const toolKey = (id: string) => {
    const index = id.lastIndexOf(":tool-call:");
    return index < 0 ? id : id.slice(index + ":tool-call:".length);
  };
  const tools = new Map(history.filter((row) => row.toolCallId).map((row) => [toolKey(row.toolCallId!), row]));
  const byContent = new Map<ChatMessage["role"], Map<string, ChatMessage[]>>();
  const fallbackRoles = new Set(live.filter((row) => !row.messageId && !byId.has(row.id)).map((row) => row.role));
  const consumed = new Set<ChatMessage>();
  for (const row of history) {
    if (!fallbackRoles.has(row.role)) continue;
    const roleContents = byContent.get(row.role) ?? new Map<string, ChatMessage[]>();
    const contents = roleContents.get(row.content) ?? [];
    contents.push(row); roleContents.set(row.content, contents); byContent.set(row.role, roleContents);
  }
  const take = (rows?: ChatMessage[]) => {
    while (rows?.length) {
      const row = rows.pop()!;
      if (!consumed.has(row)) return row;
    }
    return undefined;
  };
  for (const row of live) {
    if (applicationRow(row)) continue;
    let item = byId.get(row.id) ?? (row.toolCallId ? tools.get(toolKey(row.toolCallId)) : undefined);
    if (item && consumed.has(item)) item = undefined;
    if (!item && !row.messageId) {
      item = take(byContent.get(row.role)?.get(row.content));
    }
    if (!item || item.role !== row.role) return false;
    if (row.role === "assistant" || row.role === "reasoning") {
      if (row.isCompleted !== true || item.isCompleted !== true || item.content !== row.content) return false;
    }
    if (row.role === "tool") {
      // App-server history reports tool terminal state as isCompleted. It
      // does not set isLoading, so a missing isLoading flag is no proof that
      // the provider materialized the tool result.
      if (item.isCompleted !== true ||
          (row.isLoading === false && row.content.trim() && !item.content.trim())) return false;
    }
    consumed.add(item);
  }
  return true;
}

/** Place unmatched live entries before their next known anchor, not after the
 * entire transcript. Both native turn order and live arrival order survive. */
function retainMissing<T>(history: T[], live: T[], identity: (item: T) => string): T[] {
  const seen = new Set(history.map(identity));
  const buckets = new Map<string | null, T[]>();
  let anchor: string | null = null;
  for (let index = live.length - 1; index >= 0; index -= 1) {
    const key = identity(live[index]);
    if (seen.has(key)) { anchor = key; continue; }
    const bucket = buckets.get(anchor) ?? [];
    bucket.push(live[index]); buckets.set(anchor, bucket);
  }
  const result: T[] = [];
  for (const item of history) {
    result.push(...(buckets.get(identity(item)) ?? []).reverse(), item);
  }
  result.push(...(buckets.get(null) ?? []).reverse());
  return result;
}

export function reconcileCodexHistory(
  current: ChatMessage[], historical: ChatMessage[], coverage?: HistoryCoverage,
  requestProjection?: readonly ChatMessage[], runId?: string | null, turnId?: string | null,
  currentWindow?: CodexHistoryWindow, historyWindow?: CodexHistoryWindow,
): ChatMessage[] {
  const liveTurns = turns(current, runId, turnId);
  const requested = requestProjection ? new Map(turns(requestProjection, runId, turnId).map((turn) => [turn.id, turn.messages])) : undefined;
  const complete = new Set(coverage?.kind === "complete-turns" ? coverage.turnIds : []);
  const liveByTurn = new Map(liveTurns.map((turn) => [turn.id, turn]));
  const historyTurns = turns(hydrateHistoricalMessages(historical, "codex"));
  const reconciled = historyTurns.map((turn): TurnRows => {
    const live = liveByTurn.get(turn.id)?.messages ?? [];
    const before = requested?.get(turn.id) ?? [];
    const unchanged = !requested || live.length === before.length && live.every((row, index) => row === before[index]);
    if (complete.has(turn.id) && unchanged && codexHistoryCoversTurn(turn.messages, live)) {
      const ids = new Set(turn.messages.map((row) => row.id));
      const liveByIdentity = new Map(live.map((row) => [row.id, row]));
      for (const row of live) {
        if (row.messageId) liveByIdentity.set(`${row.role}\u0000${row.messageId}`, row);
      }
      const materialized = turn.messages.map((row) => {
        const counterpart = liveByIdentity.get(row.id) ??
          (row.messageId ? liveByIdentity.get(`${row.role}\u0000${row.messageId}`) : undefined);
        return preserveLiveUserMessagePresentation(row, counterpart);
      });
      return { id: turn.id, messages: retainMissing(materialized, live, (row) => row.id)
        .filter((row) => ids.has(row.id) || applicationRow(row)) };
    }
    // A same-turn update during the read must win, even if the turn count
    // revision is unchanged. Other turns can still converge independently.
    const byId = new Map(live.map((row) => [row.id, row]));
    const byMessageId = new Map(live.filter((row) => row.messageId)
      .map((row) => [`${row.role}\u0000${row.messageId}`, row]));
    const rows = turn.messages.map((row) => {
      const counterpart = byId.get(row.id) ??
        (row.messageId ? byMessageId.get(`${row.role}\u0000${row.messageId}`) : undefined);
      return row.role === "user"
        ? preserveLiveUserMessagePresentation(row, counterpart)
        : counterpart ?? row;
    });
    return { id: turn.id, messages: retainMissing(rows, live, (row) => row.id) };
  });
  // The incoming read is a latest-page snapshot. Previously loaded turns
  // before the first overlap remain before the whole incoming page.
  const historyIds = new Set(reconciled.map((turn) => turn.id));
  const overlap = liveTurns.findIndex((turn) => historyIds.has(turn.id));
  const currentEndsBeforeHistory = currentWindow?.end != null && historyWindow?.start != null &&
    currentWindow.end <= historyWindow.start;
  const historyEndsBeforeCurrent = historyWindow?.end != null && currentWindow?.start != null &&
    historyWindow.end <= currentWindow.start;
  const windowsOverlap = !historyEndsBeforeCurrent && !currentEndsBeforeHistory;
  const disjointCurrentIsOlder = overlap < 0 && (
    currentEndsBeforeHistory || (windowsOverlap && currentWindow?.start != null && historyWindow?.start != null &&
      currentWindow.start <= historyWindow.start)
  );
  const prefix = overlap >= 0
    ? liveTurns.slice(0, overlap)
    : disjointCurrentIsOlder
      ? liveTurns
      : [];
  const tail = overlap >= 0
    ? liveTurns.slice(overlap)
    : disjointCurrentIsOlder
      ? []
      : liveTurns;
  return reuseRenderEquivalentMessageReferences(current,
    [...prefix, ...retainMissing(reconciled, tail, (turn) => turn.id)].flatMap((turn) => turn.messages));
}

/** Release only the cache belonging to a materialized terminal turn. */
export function codexHistoryConfirmsLiveTurn(
  history: ChatMessage[], live: ChatMessage[], turnId: string | undefined, coverage?: HistoryCoverage,
): boolean {
  if (!turnId || coverage?.kind !== "complete-turns" || !coverage.turnIds.includes(turnId)) return false;
  const persisted = turns(history).find((turn) => turn.id === turnId)?.messages;
  return !!persisted && live.length > 0 && codexHistoryCoversTurn(persisted, live);
}
