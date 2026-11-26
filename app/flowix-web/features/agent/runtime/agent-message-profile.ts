import type { AgentTypeKey } from "@/types/agent";
import { normalizeAgentId } from "@/lib/agent-types";

/**
 * Message-semantics descriptor for one agent runtime.
 *
 * Why this exists: the live projection (`store/session-reducer`) and the
 * history projection (`runtime/pi-history`, `store/thread-history`) are two
 * independent implementations that must produce *the same rendered rows*.
 * Every time one of them guessed "what does this runtime look like?" on its
 * own, the two answers drifted — duplicated tool rows, JSON envelopes in the
 * live view, failure states that only appeared after the turn settled.
 *
 * So the runtime-specific facts live here, once, and both projections read
 * them. Facts that are genuinely about a *feature* (model pickers, slash
 * commands, settings panes) do NOT belong here — only things that decide how
 * an event stream becomes messages.
 *
 * Adding a runtime: default to `DEFAULT_MESSAGE_PROFILE` and only opt into a
 * flag when the runtime's own protocol proves it. Never add a flag because a
 * single screen needs a branch.
 */
export interface AgentMessageProfile {
  /**
   * The provider assigns a stable id per message and reuses it across live
   * deltas, the turn snapshot and history. When false, the frontend mints
   * run-scoped ids and cannot match live rows to history rows by id.
   */
  nativeMessageIds: boolean;
  /**
   * One native message may hold several addressable blocks (text, tool call,
   * more text). Rows are then addressed by `parentMessageId + blockIndex`
   * instead of message id alone, and must be re-sorted inside that message.
   */
  indexedBlocks: boolean;
  /**
   * Tool rows belong to the assistant message's block sequence rather than to
   * a global arrival order.
   */
  inlineToolRows: boolean;
  /**
   * The optimistic user bubble can be replaced in place by the provider's own
   * user row, instead of being appended a second time.
   */
  adoptsOptimisticUserRow: boolean;
  /**
   * `"run"`: draft assistant rows are scoped per run, so a new run starts a
   * new bubble. `"none"`: a draft continues whatever row is pending.
   */
  draftScope: "run" | "none";
  /**
   * How completed-run history is reconciled against the live projection.
   * - `pi-timeline`: branch-ordered Pi session entries (identity by block)
   * - `codex-items`: provider item order inside each turn is authoritative
   * - `sequence`: merge by run-local source sequence
   */
  historyMerge: "pi-timeline" | "codex-items" | "sequence";
  /**
   * The provider may omit an item id in its completed snapshot; the frontend
   * mints a deterministic fallback so live and history still agree.
   */
  mintsFallbackItemIds: boolean;
  /**
   * A completed item is immutable: a late/replayed delta for it must be
   * dropped instead of appended (which would render the answer twice).
   */
  dropsDeltasAfterCompletion: boolean;
  /**
   * How a tool row mints its own row id before the provider supplies one.
   * - `codex-turn-item`: turn-scoped provider item id
   * - `tool-call`: `tool-<callId>`
   */
  toolRowIdScheme: "codex-turn-item" | "tool-call";
  /**
   * The runtime reports the prompt it injects internally (e.g. a slash
   * command's expanded prompt) as a provider user message on top of the
   * command row. That echo is model input, not a second human message.
   */
  echoesInjectedPrompts: boolean;
}

const DEFAULT_MESSAGE_PROFILE: AgentMessageProfile = {
  nativeMessageIds: false,
  indexedBlocks: false,
  inlineToolRows: false,
  adoptsOptimisticUserRow: false,
  draftScope: "none",
  historyMerge: "sequence",
  mintsFallbackItemIds: false,
  dropsDeltasAfterCompletion: false,
  toolRowIdScheme: "tool-call",
  echoesInjectedPrompts: false,
};

const CODEX_MESSAGE_PROFILE: AgentMessageProfile = {
  ...DEFAULT_MESSAGE_PROFILE,
  nativeMessageIds: true,
  adoptsOptimisticUserRow: true,
  historyMerge: "codex-items",
  mintsFallbackItemIds: true,
  dropsDeltasAfterCompletion: true,
  toolRowIdScheme: "codex-turn-item",
  echoesInjectedPrompts: false,
};

const PI_MESSAGE_PROFILE: AgentMessageProfile = {
  nativeMessageIds: true,
  indexedBlocks: true,
  inlineToolRows: true,
  adoptsOptimisticUserRow: true,
  draftScope: "run",
  historyMerge: "pi-timeline",
  mintsFallbackItemIds: false,
  dropsDeltasAfterCompletion: false,
  toolRowIdScheme: "tool-call",
  echoesInjectedPrompts: false,
};

const DSH_MESSAGE_PROFILE: AgentMessageProfile = {
  ...DEFAULT_MESSAGE_PROFILE,
  // DSH emits the `/plan <prompt>` expansion as a provider user message in
  // addition to the command row that already shows it.
  echoesInjectedPrompts: true,
};

const AGENT_MESSAGE_PROFILES: Record<string, AgentMessageProfile> = {
  codex: CODEX_MESSAGE_PROFILE,
  pi: PI_MESSAGE_PROFILE,
  dsh: DSH_MESSAGE_PROFILE,
};

export function getAgentMessageProfile(
  typeKey: AgentTypeKey | null | undefined,
): AgentMessageProfile {
  if (!typeKey) return DEFAULT_MESSAGE_PROFILE;
  return AGENT_MESSAGE_PROFILES[normalizeAgentId(typeKey) ?? ""] ??
    DEFAULT_MESSAGE_PROFILE;
}

/**
 * Row id for one block inside a native message. Only indexed-block runtimes
 * get a block-scoped id; everyone else keeps the provider id verbatim.
 */
export function messageBlockId(
  profile: AgentMessageProfile,
  messageId: string | undefined,
  blockIndex: number | undefined,
): string | undefined {
  if (!profile.indexedBlocks || !messageId || blockIndex === undefined) {
    return messageId;
  }
  return `${messageId}:block:${blockIndex}`;
}

/** Row-level block index, or `undefined` when the runtime has no blocks. */
export function messageBlockIndex(
  profile: AgentMessageProfile,
  sourceSubsequence: number | undefined,
): number | undefined {
  return profile.indexedBlocks ? sourceSubsequence : undefined;
}

/** Run scope for draft rows, or `undefined` when drafts are not run-scoped. */
export function messageDraftScope(
  profile: AgentMessageProfile,
  runId: string,
): string | undefined {
  return profile.draftScope === "run" ? runId : undefined;
}

/** Provider-native message id, or `undefined` when it is not stable. */
export function messageNativeId(
  profile: AgentMessageProfile,
  messageId: string | undefined,
): string | undefined {
  return profile.nativeMessageIds ? messageId : undefined;
}
