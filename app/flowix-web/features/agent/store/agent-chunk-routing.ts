import type { AgentChunk, AgentTypeKey } from "@/types/agent";
import { isKnownProductThreadId, resolveStoreThreadId } from "@features/agent/store/external-session";
import type { AgentConversationRegistry, AgentSessionMeta } from "@features/agent/store/session-state";

interface ChunkRoutingState {
  sessionMeta: Pick<AgentSessionMeta,
    "activeThreadIds" | "threadLists" | "threadTypes" | "externalSessionResolutions">;
  conversationRegistry?: AgentConversationRegistry;
  threadProjections: Record<string, unknown>;
}

/** Resolve native aliases once, before a chunk enters the message pipeline. */
export function resolveIncomingChunkThreadId(
  chunk: AgentChunk,
  state: ChunkRoutingState,
): string | null {
  const meta = state.sessionMeta;
  if (!chunk.agent_type &&
    Object.values(meta.externalSessionResolutions).includes(chunk.thread_id) &&
    !isKnownProductThreadId(chunk.thread_id, state)) return null;
  const runtime: AgentTypeKey | undefined = chunk.agent_type ?? meta.threadTypes[chunk.thread_id];
  if (!runtime) return null;
  return resolveStoreThreadId(
    chunk.thread_id,
    meta.externalSessionResolutions,
    runtime,
    meta.threadTypes,
    (id) => isKnownProductThreadId(id, state),
  );
}
