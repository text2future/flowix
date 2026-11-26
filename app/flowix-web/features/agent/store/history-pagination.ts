import type { AgentTypeKey } from "@/types/agent";
import type { ChatMessage } from "@/types";
import type { ThreadProjection } from "./session-reducer";
import { rebaseHistoryCursor, type ThreadHistoryPage } from "./agent-history-adapters";

/** A tail refresh must not rewind a retained, already paginated prefix. */
export function paginationAfterSnapshot(
  runtime: AgentTypeKey,
  threadId: string,
  current: Readonly<ThreadProjection>,
  page: ThreadHistoryPage,
  messages: ChatMessage[],
): ThreadProjection["pagination"] {
  const previous = current.pagination;
  const previousStart = previous.oldestSequence ??
    (previous.initialStatus === "ready" && !previous.hasMoreHistory ? 0 : null);
  const retainsOlderBoundary = page.hasMore &&
    (!previous.hasMoreHistory || !!previous.nextCursor) &&
    previousStart != null && page.oldestSequence != null &&
    previousStart < page.oldestSequence &&
    current.messages.length > 0 && messages[0] === current.messages[0];
  return {
    initialStatus: "ready",
    initialError: null,
    oldestSequence: retainsOlderBoundary ? previous.oldestSequence : page.oldestSequence,
    snapshotSequence: page.snapshotSequence ?? null,
    nextCursor: retainsOlderBoundary && previous.nextCursor
      ? rebaseHistoryCursor(runtime, threadId, previous.nextCursor, page)
      : retainsOlderBoundary ? undefined : page.nextCursor,
    hasMoreHistory: retainsOlderBoundary ? previous.hasMoreHistory : page.hasMore,
    loadingInitial: false,
    loadingMore: previous.loadingMore,
  };
}

export function samePagination(
  left: ThreadProjection["pagination"], right: ThreadProjection["pagination"],
): boolean {
  return left.initialStatus === right.initialStatus &&
    left.initialError === right.initialError &&
    left.deferredPiHistory === right.deferredPiHistory &&
    left.oldestSequence === right.oldestSequence &&
    left.snapshotSequence === right.snapshotSequence &&
    left.nextCursor === right.nextCursor &&
    left.hasMoreHistory === right.hasMoreHistory &&
    left.loadingInitial === right.loadingInitial && left.loadingMore === right.loadingMore;
}
