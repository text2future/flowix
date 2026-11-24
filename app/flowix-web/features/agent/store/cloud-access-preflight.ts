/**
 * Cloud access gate for a send that has not reached the model yet.
 *
 * A signed-out account cannot use Cloud models. Check that locally before
 * creating a transcript row; credit balance is checked by Cloud on the request.
 */
import type { AgentEvent, AgentTypeKey, RuntimeConfig } from "@/types/agent";
import { resolveAgentPreferenceRuntimeConfig } from "@features/agent/store/agent-user-preferences";
import {
  resolveCloudAccessKind,
  signedOutAccessFor,
  type CloudAccessKind,
} from "@features/agent/config/cloud-access";
import { useAgentCloudAccessStore } from "@features/agent/store/agent-cloud-access-store";
import { useAgentDataStore } from "@features/agent/store/agent-data-store";

/** Check locally for a missing Cloud login; the server checks credit balance. */
export function resolveCloudAccessForSend(
  threadId: string,
  typeKey: AgentTypeKey,
  runtimeConfig?: RuntimeConfig,
): CloudAccessKind | null {
  if (typeKey !== "pi") return null;
  const data = useAgentDataStore.getState();
  const providerId = resolveAgentPreferenceRuntimeConfig(typeKey, runtimeConfig).model?.providerId;
  const signedOut = signedOutAccessFor(providerId, !!data.piCloudAccountId);
  useAgentCloudAccessStore.getState().clearAccess(threadId);
  return signedOut;
}

/**
 * Close the run a blocked send already opened. `reason: null` means a normal
 * end: nothing failed from the user's side, the card is the turn's reply.
 */
export function createCloudAccessRunEnd(
  threadId: string,
  typeKey: AgentTypeKey,
  runId: string,
): AgentEvent & { kind: "stream_end" } {
  return {
    kind: "stream_end",
    agentType: typeKey,
    threadId,
    runId,
    timestamp: Date.now(),
    reason: null,
  };
}

/**
 * Turn a Cloud-model turn failure into its access-card reply.
 *
 * Cloud answers an empty balance or an expired session with a run failure. The
 * raw row would show the upstream English sentence, which is not an answer the
 * user can act on — the card is. When the failure is one of the two card
 * states, the store entry is written and the returned run end replaces the
 * error event; anything else returns `null` and keeps the ordinary failure
 * path.
 */
export function cloudAccessReplyForError(
  threadId: string,
  error: AgentEvent & { kind: "error" },
  providerId?: string | null,
): AgentEvent & { kind: "stream_end" } | null {
  if (error.agentType !== "pi") return null;
  const data = useAgentDataStore.getState();
  const kind = resolveCloudAccessKind({
    providerId: providerId ?? data.agents.pi.user.model?.providerId,
    authenticated: !!data.piCloudAccountId,
    category: error.errorDetails?.category,
    message: error.errorDetails?.upstreamMessage ?? error.message,
  });
  if (!kind) return null;
  useAgentCloudAccessStore.getState().setAccess(threadId, kind);
  return createCloudAccessRunEnd(threadId, error.agentType, error.runId);
}
