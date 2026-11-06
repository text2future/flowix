/**
 * Cloud access gate for a send that has not reached the model yet.
 *
 * Two states stop a turn before the request leaves the app:
 *
 * - A signed-out account owns no Cloud credential, so Pi has no provider to run
 *   the request; it would fail as an unknown provider instead of asking for a
 *   sign-in.
 * - An empty credit balance is refused by Cloud with an English body that Pi
 *   treats as a transient provider failure, so the user waits through the agent
 *   retries only to be told "credit balance must be greater than zero".
 *
 * The send still travels the normal message pipeline — `sendMessageToThread`
 * pushes the prompt as a real user row before this check runs — so the
 * transcript keeps what the user wrote. Only the turn itself ends early, and the
 * access card stored here stands in for its reply.
 */
import type { AgentEvent, AgentTypeKey } from "@/types/agent";
import { cloud } from "@platform/tauri/client";
import {
  isCloudModelProvider,
  resolveCloudAccessKind,
  signedOutAccessFor,
  type CloudAccessKind,
} from "@features/agent/config/cloud-access";
import { useAgentCloudAccessStore } from "@features/agent/store/agent-cloud-access-store";
import { useAgentDataStore } from "@features/agent/store/agent-data-store";

/**
 * How long a send waits for the balance read. The account API is one small GET,
 * but an offline machine must not turn every message into a stall: past this
 * budget the send proceeds and the model request reports the real failure.
 */
const BALANCE_READ_TIMEOUT_MS = 1200;

function withTimeout<T>(promise: Promise<T>): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), BALANCE_READ_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Current AI credit balance in microcredits, or `null` when it cannot be read.
 *
 * A failed or slow read must never block a send: the model request is the
 * authoritative check, and the failure it returns is classified into the same
 * card.
 */
async function readCreditBalance(): Promise<number | null> {
  try {
    const result = await withTimeout(cloud.getAiCreditBalance());
    const balance = result?.balanceMicrocredits;
    return typeof balance === 'number' && Number.isFinite(balance) ? balance : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether the just-pushed prompt can run.
 *
 * Returns the blocking access kind when the turn must stop, and clears any
 * notice left by an earlier attempt otherwise: a new send is a new answer.
 *
 * The balance is read per send rather than cached, so buying credits takes
 * effect on the very next message instead of waiting for a cache to expire.
 */
export async function resolveCloudAccessForSend(
  threadId: string,
  typeKey: AgentTypeKey,
): Promise<CloudAccessKind | null> {
  if (typeKey !== "pi") return null;
  const data = useAgentDataStore.getState();
  const providerId = data.agents.pi.user.model?.providerId;
  const access = useAgentCloudAccessStore.getState();
  const signedOut = signedOutAccessFor(providerId, !!data.piCloudAccountId);
  if (signedOut) {
    access.setAccess(threadId, signedOut);
    return signedOut;
  }
  if (!isCloudModelProvider(providerId)) {
    access.clearAccess(threadId);
    return null;
  }
  const balance = await readCreditBalance();
  if (balance !== null && balance <= 0) {
    access.setAccess(threadId, "no_credits");
    return "no_credits";
  }
  access.clearAccess(threadId);
  return null;
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
): AgentEvent & { kind: "stream_end" } | null {
  if (error.agentType !== "pi") return null;
  const data = useAgentDataStore.getState();
  const kind = resolveCloudAccessKind({
    providerId: data.agents.pi.user.model?.providerId,
    authenticated: !!data.piCloudAccountId,
    category: error.errorDetails?.category,
    message: error.errorDetails?.upstreamMessage ?? error.message,
  });
  if (!kind) return null;
  useAgentCloudAccessStore.getState().setAccess(threadId, kind);
  return createCloudAccessRunEnd(threadId, error.agentType, error.runId);
}
