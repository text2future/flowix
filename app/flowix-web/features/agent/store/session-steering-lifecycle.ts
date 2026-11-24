import { normalizeAgentTypeKey } from "@/lib/agent-types";
import type { AgentEvent } from "@/types/agent";
import type { AgentSessionStore } from "@features/agent/store/agent-session-store";
import { isKnownProductThreadId, resolveProductThreadId } from "@features/agent/store/external-session";

/**
 * Clears provider-queued steering once a run reaches a lifecycle terminal event.
 *
 * Lives outside the store module so the store body stays a composition root
 * instead of regrowing into a second implementation of session lifecycle rules.
 */
export function createSteeringLifecycleHandler(
  get: () => AgentSessionStore,
): (event: AgentEvent) => void {
  return (event: AgentEvent): void => {
    if (event.kind !== "error" && event.kind !== "stream_end") return;
    const state = get();
    const canonicalThreadId = resolveProductThreadId(
      event.threadId,
      state.sessionMeta.externalSessionResolutions,
      event.agentType,
      state.sessionMeta.threadTypes,
      (id) => isKnownProductThreadId(id, state),
    );
    const projection = state.threadProjections[canonicalThreadId];
    const activeRunId = projection?.runs.activeRunId;
    // Ignore a delayed lifecycle event from an older run. The reducer
    // uses the same active-run ownership rule for known run ids.
    if (activeRunId && event.runId && activeRunId !== event.runId) return;
    const eventType = normalizeAgentTypeKey(event.agentType ?? state.sessionMeta.threadTypes[canonicalThreadId]);
    if (eventType === "codex") {
      // Accepted manual steering is no longer in the provider queue.
      // End/error is a fallback when its correlated user event was lost;
      // ordinary follow-ups and operations still awaiting RPC stay intact.
      for (const message of state.pendingSteeringMessages[canonicalThreadId] ?? []) {
        if (message.deliveryStatus === "steering" || message.runtimeOwned) {
          state.removeSteeringMessage(canonicalThreadId, message.id);
        }
      }
      // Codex drains its persistent queue itself after a turn completes.
      // Starting it again from Flowix races the server and can target an
      // already-consumed queued submission id.
      return;
    }
    state.clearPendingSteeringMessages(event.threadId);
    if (canonicalThreadId !== event.threadId) {
      state.clearPendingSteeringMessages(canonicalThreadId);
    }
  };
}
