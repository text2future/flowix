import type { AgentSessionStore } from '@features/agent/store/agent-session-store';
import { createAgentChunkBridge } from '@features/agent/store/agent-chunk-bridge';
import { resolveIncomingChunkThreadId } from '@features/agent/store/agent-chunk-routing';
import { hasThreadInterest } from '@features/agent/store/thread-interest';

interface AgentSessionStoreAccess {
  getState(): AgentSessionStore;
}

export function installAgentSessionRuntimeBridges(store: AgentSessionStoreAccess) {
  return createAgentChunkBridge((chunk) => {
    const canonicalThreadId = resolveIncomingChunkThreadId(chunk, store.getState());
    const runId = chunk.run_id?.trim();
    if (!canonicalThreadId || !runId) return;
    store.getState().dispatchAgentChunk(chunk);
    if (chunk.kind !== 'stream_end') return;

    const state = store.getState();
    const projection = state.threadProjections[canonicalThreadId];
    const hasResidentRun = !!projection && (
      projection.runs.activeRunId === runId
      || projection.runs.lastRun?.runId === runId
    );
    const ownsThread = hasThreadInterest(canonicalThreadId)
      || hasResidentRun
      || Object.values(state.sessionMeta.activeThreadIds).some(
        (threadId) => threadId === canonicalThreadId
          || (threadId
            ? state.sessionMeta.externalSessionResolutions[threadId] === canonicalThreadId
            : false),
      );
    if (!ownsThread) return;

    const agentType = state.sessionMeta.threadTypes[canonicalThreadId]
      ?? state.sessionMeta.threadTypes[chunk.thread_id]
      ?? state.sessionMeta.activeAgentTypeKey;
    if (agentType === 'opencode') return;
    globalThis.setTimeout(() => {
      const latest = store.getState();
      if (latest.threadTombstones[canonicalThreadId]) return;
      // `reconcileCompletedRun` releases the deferred Pi history read itself;
      // skipping it here would leave the turn's rows unloaded after a reload.
      void latest.reconcileCompletedRun(agentType, canonicalThreadId, runId);
    }, 300);
  });
}
