import type { AgentChunk } from '@/types/agent';
import type { AgentTypeKey } from '@/types/agent';
import type { AgentConversationRegistry, AgentSessionMeta } from '@features/agent/store/session-state';

type ProductThreadState = {
  sessionMeta: Pick<AgentSessionMeta, 'activeThreadIds' | 'threadLists' | 'externalSessionResolutions'>;
  conversationRegistry?: AgentConversationRegistry;
  threadProjections?: Record<string, unknown>;
};

export function isKnownProductThreadId(
  threadId: string,
  state: ProductThreadState,
): boolean {
  const meta = state.sessionMeta;
  return Object.prototype.hasOwnProperty.call(meta.externalSessionResolutions, threadId)
    || Object.prototype.hasOwnProperty.call(state.threadProjections ?? {}, threadId)
    || Object.values(meta.activeThreadIds ?? {}).includes(threadId)
    || Object.values(meta.threadLists ?? {}).some((list) => list?.some((item) => item.threadId === threadId) ?? false)
    || Object.values(state.conversationRegistry?.instances ?? {}).some((instance) => instance.threadId === threadId);
}

/** Resolve either a product thread id or provider session id to the product id. */
export function resolveProductThreadId(
  threadId: string,
  resolutions: Record<string, string>,
  runtime?: AgentTypeKey,
  threadTypes?: Record<string, AgentTypeKey>,
  isKnownProductThread?: (threadId: string) => boolean,
): string {
  if (isKnownProductThread?.(threadId) || Object.prototype.hasOwnProperty.call(resolutions, threadId) || !runtime || !threadTypes) return threadId;
  const matches = Object.entries(resolutions).filter(
    ([productThreadId, externalSessionId]) =>
      externalSessionId === threadId && threadTypes[productThreadId] === runtime,
  );
  return matches.length === 1 ? matches[0][0] : threadId;
}

/** Resolve a known native alias at a store boundary; reject ambiguous aliases. */
export function resolveStoreThreadId(
  threadId: string,
  resolutions: Record<string, string>,
  runtime: AgentTypeKey,
  threadTypes: Record<string, AgentTypeKey>,
  isKnownProductThread?: (threadId: string) => boolean,
): string | null {
  if (isKnownProductThread?.(threadId)) return threadId;
  const productThreadId = resolveProductThreadId(threadId, resolutions, runtime, threadTypes, isKnownProductThread);
  if (productThreadId !== threadId || Object.prototype.hasOwnProperty.call(resolutions, threadId)) {
    return productThreadId;
  }
  return Object.values(resolutions).includes(threadId) ? null : threadId;
}

export function resolveExternalChunkThreadId(
  chunk: AgentChunk,
  resolutions: Record<string, string>,
  threadTypes?: Record<string, AgentTypeKey>,
  isKnownProductThread?: (threadId: string) => boolean,
): string {
  return resolveProductThreadId(
    chunk.thread_id,
    resolutions,
    chunk.agent_type,
    threadTypes,
    isKnownProductThread,
  );
}
