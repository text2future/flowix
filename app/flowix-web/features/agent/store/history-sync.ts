import type { ChatMessage } from "@/types";
import type { AgentTypeKey } from "@/types/agent";
import type { HistoryCoverage } from "@features/agent/store/agent-history-adapters";
import { completedRunUserMessageId } from "@features/agent/events/message-identity";
import {
  areMessagesEquivalent,
  reconcilePiHistory,
  mergeHistoricalMessages,
  replaceCompletedRunWithHistory,
} from "@features/agent/store/thread-history";

/** Provider-neutral history contract consumed by every conversation surface. */
export interface HistorySnapshot {
  messages: ChatMessage[];
  coverage?: HistoryCoverage;
  /** Stable provider/journal revision for the current pagination traversal. */
  revision: string | null;
  oldestCursor: number | null;
  hasMore: boolean;
}

export type HistorySyncReason = "open" | "run_completed" | "recovery";

export interface ReconcileHistoryInput {
  agentType: AgentTypeKey;
  current: ChatMessage[];
  snapshot: HistorySnapshot;
  reason: HistorySyncReason;
  runId?: string | null;
  /** Codex turn owning the run; anchors the user row when ids already match. */
  turnId?: string | null;
  /** In-memory immutable projection version before the history request. */
  requestProjection?: readonly ChatMessage[];
}

export interface ReconcileHistoryResult {
  messages: ChatMessage[];
  /** False means callers must preserve the whole projection reference. */
  renderChanged: boolean;
}

function lastUserMessage(messages: readonly ChatMessage[]): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return messages[index];
  }
  return undefined;
}

function isLatestUnchangedTurn(input: ReconcileHistoryInput): boolean {
  const { current, snapshot, requestProjection, runId, turnId, agentType } = input;
  if (!runId || !turnId) return false;
  if (requestProjection &&
    (current.length !== requestProjection.length ||
      current.some((message, index) => message !== requestProjection[index]))) return false;
  const isTargetUser = (message: ChatMessage) => message.role === "user" &&
    (message.codexTurnId === turnId || message.id === completedRunUserMessageId(agentType, runId));
  const latestCurrentUser = lastUserMessage(current);
  const latestHistoryUser = lastUserMessage(snapshot.messages);
  return !!latestCurrentUser && !!latestHistoryUser &&
    isTargetUser(latestCurrentUser) && isTargetUser(latestHistoryUser);
}

/**
 * One reconciliation engine for open/completion/recovery.
 *
 * It never exposes a clearing/loading frame. Message helpers reuse render-
 * equivalent row and array references, so a semantically identical provider
 * snapshot produces no store write and therefore no visible refresh.
 */
export function reconcileHistorySnapshot(
  input: ReconcileHistoryInput,
): ReconcileHistoryResult {
  const { agentType, current, snapshot, reason, runId, turnId } = input;
  const messages = agentType === "pi"
    ? reconcilePiHistory(snapshot.messages, current, snapshot.hasMore, input.requestProjection)
    : reason === "run_completed" && runId &&
      snapshot.coverage?.kind === "complete-turns" &&
       !!turnId && snapshot.coverage.turnIds.includes(turnId) &&
       isLatestUnchangedTurn(input)
      ? replaceCompletedRunWithHistory(
          current,
          snapshot.messages,
          runId,
          agentType,
          turnId ?? undefined,
        )
      : mergeHistoricalMessages(current, snapshot.messages, agentType);

  const renderChanged =
    messages !== current && !areMessagesEquivalent(current, messages);
  return {
    // Make the no-op contract explicit even if an adapter/helper allocated an
    // equivalent array: callers can use reference equality as the store-write
    // guard without duplicating comparison logic.
    messages: renderChanged ? messages : current,
    renderChanged,
  };
}

export function historyRevision(
  snapshotSequence: number | null | undefined,
): string | null {
  return snapshotSequence == null ? null : `sequence:${snapshotSequence}`;
}

/** Sequence-backed revisions are monotonic for provider and journal snapshots. */
export function isOlderHistorySnapshot(
  current: number | null | undefined,
  incoming: number | null | undefined,
): boolean {
  return current != null && incoming != null && incoming < current;
}
