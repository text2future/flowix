import type { AgentTypeKey } from '@/types/agent';
import type { ChatMessage } from '@/types';
import { getAgentType } from '@/lib/agent-types';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import {
  isLocalExternalThreadId,
  resolveExternalSessionId,
} from '@features/agent/services/external-agent-runtime-service';

export interface LoadAgentThreadCardCacheInput {
  threadId: string;
  typeKey: AgentTypeKey;
}

export interface LoadAgentThreadCardCacheResult {
  resolvedSessionId: string | null;
  loadedThreadId: string | null;
  messages: ChatMessage[];
}

const inFlightThreadLoads = new Map<string, Promise<ChatMessage[]>>();

function loadThreadMessages(
  typeKey: AgentTypeKey,
  threadId: string
): Promise<ChatMessage[]> {
  const key = `${typeKey}:${threadId}`;
  const existing = inFlightThreadLoads.get(key);
  if (existing) return existing;

  const load = (async () => {
    // Runtime history is read through the session store.
    await useAgentSessionStore.getState().loadMessages(typeKey, threadId);
    return (
      useAgentSessionStore.getState().threadProjections[threadId]?.messages ?? []
    );
  })().finally(() => {
    if (inFlightThreadLoads.get(key) === load) {
      inFlightThreadLoads.delete(key);
    }
  });
  inFlightThreadLoads.set(key, load);
  return load;
}

export async function loadAgentThreadCardCache(
  input: LoadAgentThreadCardCacheInput
): Promise<LoadAgentThreadCardCacheResult> {
  const { threadId, typeKey } = input;
  const type = getAgentType(typeKey);

  if (type.capabilities.externalSessionBacked) {
    const isLocalThreadId = isLocalExternalThreadId(threadId, typeKey);
    const sessionId = isLocalThreadId
      ? await resolveExternalSessionId(threadId, typeKey)
      : threadId;

    if (isLocalThreadId && sessionId && sessionId !== threadId) {
      const messages = await loadThreadMessages(typeKey, sessionId);
      if (messages.length > 0) {
        const store = useAgentSessionStore.getState();
        const source = store.threadProjections[sessionId];
        store.bindThreadType(threadId, typeKey);
        store.applyHistoryPage(threadId, typeKey, { messages, coverage: "partial" });
        if (source) {
          store.updateThreadHistory(threadId, (projection) => ({
            messages: projection.messages,
            pagination: source.pagination,
          }));
          store.removeThreadProjection(sessionId);
        }
      }
      return {
        resolvedSessionId: sessionId,
        loadedThreadId: sessionId,
        messages: useAgentSessionStore.getState().threadProjections[threadId]?.messages ?? messages,
      };
    }

    if (sessionId) {
      const messages = await loadThreadMessages(typeKey, sessionId);
      return { resolvedSessionId: null, loadedThreadId: sessionId, messages };
    }

    return { resolvedSessionId: null, loadedThreadId: null, messages: [] };
  }

  const messages = await loadThreadMessages(typeKey, threadId);
  return { resolvedSessionId: null, loadedThreadId: threadId, messages };
}
