/**
 * Store-level helpers for resolving a send target and keeping the conversation
 * instance registry in step with an external provider session.
 *
 * Split out of `agent-session-store.ts` because the combination root has a hard
 * line budget; these are pure adapters over the store shape, no state of their
 * own.
 */
import type { AgentTypeKey } from "@/types/agent";
import type { AgentSessionStore } from "@features/agent/store/agent-session-store";
import type { AgentConversationInstance } from "@features/agent/store/agent-conversation-types";
import { buildInitialInstanceRuntimeConfig } from "@features/agent/store/initial-runtime-config";
import {
  isKnownProductThreadId,
  resolveStoreThreadId,
} from "@features/agent/store/external-session";

type SessionGet = () => AgentSessionStore;

export function resolveCommandThreadId(
  state: AgentSessionStore,
  threadId: string,
  runtime: AgentTypeKey,
): string | null {
  return resolveStoreThreadId(threadId, state.sessionMeta.externalSessionResolutions, runtime,
    state.sessionMeta.threadTypes, (id) => isKnownProductThreadId(id, state));
}

export function ensureConversationInstanceForSession(
  get: SessionGet,
  threadId: string,
  type: AgentTypeKey,
  title: string,
  options?: { defaultTitle?: string },
): AgentConversationInstance {
  const session = get();
  const existing = session.findByThreadId(threadId);
  if (existing) {
    const shouldUpdateTitle =
      title &&
      (!options?.defaultTitle || title !== options.defaultTitle);
    return session.upsertInstance(existing.instanceId, {
      agentType: type,
      ...(shouldUpdateTitle ? { title } : {}),
      threadId,
    });
  }
  return session.createInstance({
    agentType: type,
    title,
    threadId,
    source: { kind: "thread-card" },
    runtimeConfig: buildInitialInstanceRuntimeConfig(type),
  });
}
