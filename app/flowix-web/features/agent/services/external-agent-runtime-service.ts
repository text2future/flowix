import type { AgentTypeKey } from '@/types/agent';
import { useChatStore } from '@features/agent/store/chat-store';
import { getExternalAgentRuntimeAdapter } from './external-agent-runtime-adapters';

const localThreadIdsByHandle = new Map<string, string>();
const resolvingSessionIds = new Set<string>();
let handleSeq = 0;

export function createExternalAgentRuntimeHandle(): string {
  handleSeq += 1;
  return `external-agent-card-${Date.now()}-${handleSeq}`;
}

export function isLocalExternalThreadId(threadId: string, typeKey: AgentTypeKey): boolean {
  return getExternalAgentRuntimeAdapter(typeKey)?.isLocalThreadId(threadId) ?? false;
}

export function getExternalAgentRuntimeThreadId(
  handleId: string,
  persistedThreadId: string | null
): string | null {
  return persistedThreadId ?? localThreadIdsByHandle.get(handleId) ?? null;
}

export function beginExternalAgentThreadCardRun(
  handleId: string,
  typeKey: AgentTypeKey,
  persistedThreadId: string | null,
  instanceId: string,
): string {
  if (persistedThreadId) return persistedThreadId;
  const existing = localThreadIdsByHandle.get(handleId);
  if (existing) return existing;
  const adapter = getExternalAgentRuntimeAdapter(typeKey);
  const localThreadId = adapter?.createLocalThreadId(instanceId) ??
    `${typeKey}-local-${instanceId}`;
  localThreadIdsByHandle.set(handleId, localThreadId);
  useChatStore.getState().setActiveAgentThread(typeKey, localThreadId);
  return localThreadId;
}

export function getResolvedExternalSessionId(runtimeThreadId: string | null): string | undefined {
  if (!runtimeThreadId) return undefined;
  return useChatStore.getState().externalSessionResolutions[runtimeThreadId];
}

export function applyResolvedExternalSession(
  handleId: string,
  runtimeThreadId: string,
  sessionId: string,
  typeKey: AgentTypeKey
): boolean {
  if (!sessionId || sessionId === runtimeThreadId) return false;
  useChatStore.getState().migrateThreadState(runtimeThreadId, sessionId, typeKey);
  if (localThreadIdsByHandle.get(handleId) === runtimeThreadId) {
    localThreadIdsByHandle.delete(handleId);
  }
  return true;
}

export async function resolveExternalSessionId(
  runtimeThreadId: string,
  typeKey: AgentTypeKey
): Promise<string | null> {
  const adapter = getExternalAgentRuntimeAdapter(typeKey);
  if (!adapter?.isLocalThreadId(runtimeThreadId)) return runtimeThreadId;
  if (resolvingSessionIds.has(runtimeThreadId)) return null;
  resolvingSessionIds.add(runtimeThreadId);
  try {
    const sessionId = await adapter.resolveSessionId(runtimeThreadId);
    return sessionId ?? null;
  } finally {
    resolvingSessionIds.delete(runtimeThreadId);
  }
}

export async function stopExternalAgentThreadCardRun(
  handleId: string,
  persistedThreadId: string | null
): Promise<void> {
  const runtimeThreadId = getExternalAgentRuntimeThreadId(handleId, persistedThreadId);
  if (!runtimeThreadId) return;
  const runId = useChatStore.getState().threadStates[runtimeThreadId]?.activeRunId ?? undefined;
  await useChatStore.getState().stopThreadRun(runtimeThreadId, runId);
}
