import type { AgentTypeKey } from '@/types/agent';
import { getAgentType } from '@/lib/agent-types';
import { useAgentConversationStore } from '@features/agent/store/agent-conversation-store';
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
      return { resolvedSessionId: sessionId, loadedThreadId: null };
    }

    if (sessionId) {
      await useAgentConversationStore.getState().loadMessages(typeKey, sessionId);
      return { resolvedSessionId: null, loadedThreadId: sessionId };
    }

    return { resolvedSessionId: null, loadedThreadId: null };
  }

  await useAgentConversationStore.getState().loadMessages(typeKey, threadId);
  return { resolvedSessionId: null, loadedThreadId: threadId };
}
