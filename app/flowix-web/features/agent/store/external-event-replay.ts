import type { AgentChunk, AgentTypeKey } from "@/types/agent";
import type { AgentExternalEvent } from "@platform/tauri/client";
import { agentClient } from "@features/agent/store/agent-client";

const REPLAY_PAGE_SIZE = 1000;
const MAX_COMPLETE_EXTERNAL_EVENTS = 10_000;
const AGENT_CHUNK_KINDS = new Set<AgentChunk["kind"]>([
  "user_message",
  "stream_start",
  "text",
  "reasoning",
  "context_compaction",
  "tool_call",
  "tool_result",
  "error",
  "usage",
  "stream_end",
  "session_resolved",
  "codex_command",
]);
function parseReplayChunk(normalizedJson: string): AgentChunk | null {
  try {
    const value = JSON.parse(normalizedJson) as AgentChunk;
    if (!value || typeof value !== "object") return null;
    if (!AGENT_CHUNK_KINDS.has(value.kind)) return null;
    return value;
  } catch (err) {
    console.warn("[AgentExternalReplay] skipped malformed event payload:", err);
    return null;
  }
}

function isTruncatedHistoryEvent(event: AgentExternalEvent): boolean {
  try {
    const value = JSON.parse(event.normalizedJson) as { kind?: string };
    return value.kind === "history_truncated";
  } catch {
    return false;
  }
}

function replayEventKind(event: AgentExternalEvent): string | null {
  try {
    const value = JSON.parse(event.normalizedJson) as { kind?: unknown };
    return typeof value.kind === "string" ? value.kind : null;
  } catch {
    return null;
  }
}

export interface ExternalReplayPorts {
  canCommit(): boolean;
  resetThreads(threadIds: string[], typeKey: AgentTypeKey): void;
  dispatchChunk(chunk: AgentChunk): void;
  flush(): void;
}

export type ReplayResult =
  | { status: "replayed"; eventCount: number }
  | {
      status: "fallback";
      reason: "empty" | "truncated" | "legacy" | "read_failed";
    }
  | { status: "stale" };

export async function replayExternalEventsForThread(
  typeKey: AgentTypeKey,
  threadId: string,
  ports: ExternalReplayPorts,
): Promise<ReplayResult> {
  let afterId: number | null = null;
  const persistedEvents: AgentExternalEvent[] = [];

  for (;;) {
    let events: AgentExternalEvent[];
    try {
      events = await agentClient.externalEvents(
        threadId,
        afterId,
        REPLAY_PAGE_SIZE,
      );
    } catch (err) {
      console.warn(
        "[AgentExternalReplay] database replay failed; using external history:",
        err,
      );
      return { status: "fallback", reason: "read_failed" };
    }
    if (events.length === 0) break;
    persistedEvents.push(...events);

    afterId = events[events.length - 1]?.id ?? afterId;
    if (events.length < REPLAY_PAGE_SIZE) break;
  }

  if (persistedEvents.length === 0) {
    return { status: "fallback", reason: "empty" };
  }
  if (
    persistedEvents.length >= MAX_COMPLETE_EXTERNAL_EVENTS ||
    persistedEvents.some(isTruncatedHistoryEvent)
  ) {
    return { status: "fallback", reason: "truncated" };
  }
  if (
    // user_message became the first normalized event in the complete-history
    // protocol. Older databases started at stream_start and therefore lack
    // user turns; treat those as incomplete and use transcript/main history.
    replayEventKind(persistedEvents[0]) !== "user_message"
  ) {
    return { status: "fallback", reason: "legacy" };
  }

  if (!ports.canCommit()) return { status: "stale" };

  const resetThreadIds = Array.from(
    new Set([threadId, ...persistedEvents.map((event) => event.threadId)].filter(Boolean)),
  );
  ports.resetThreads(resetThreadIds, typeKey);

  for (const event of persistedEvents) {
    const chunk = parseReplayChunk(event.normalizedJson);
    if (!chunk) continue;
    ports.dispatchChunk(chunk);
  }
  ports.flush();
  return { status: "replayed", eventCount: persistedEvents.length };
}
