import type { AgentTypeKey } from '@/types/agent';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
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
  // Phase 4 (2026-08-02): session-store.sessionMeta.activeThreadIds 是真源.
  useAgentSessionStore.getState().setSessionMeta((meta) => ({
    ...meta,
    activeThreadIds: {
      ...meta.activeThreadIds,
      [typeKey]: localThreadId,
    },
    activeAgentTypeKey: typeKey,
  }));
  return localThreadId;
}

export function getResolvedExternalSessionId(runtimeThreadId: string | null): string | undefined {
  if (!runtimeThreadId) return undefined;
  // Phase 4 (2026-08-02): 真源是 session-store.sessionMeta.externalSessionResolutions.
  return useAgentSessionStore.getState().sessionMeta.externalSessionResolutions[runtimeThreadId];
}

export function applyResolvedExternalSession(
  handleId: string,
  runtimeThreadId: string,
  sessionId: string,
  typeKey: AgentTypeKey
): boolean {
  if (!sessionId) return false;
  useAgentSessionStore.getState().bindProviderSessionId(runtimeThreadId, sessionId, typeKey);
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
  // Phase 4 (2026-08-02): 真源是 session-store.threadProjections.
  const projection = useAgentSessionStore.getState().threadProjections[runtimeThreadId];
  const runId = projection?.runs.activeRunId ?? undefined;
  await useAgentSessionStore.getState().stopThreadRun(runtimeThreadId, runId);
}
