import type { AgentChunk } from '@/types/agent';
import type { AgentSessionStore } from '@features/agent/store/agent-session-store';
import { createAgentChunkBridge } from '@features/agent/store/agent-chunk-bridge';
import { installGlobalAgentSettingsSync } from '@features/agent/store/global-agent-settings-sync';
import { resolveExternalChunkThreadId } from '@features/agent/store/external-session';
import { hasThreadInterest } from '@features/agent/store/thread-interest';

interface AgentSessionStoreAccess {
  getState(): AgentSessionStore;
}

export function installAgentSessionRuntimeBridges(store: AgentSessionStoreAccess) {
  installGlobalAgentSettingsSync((updater) => store.getState().setSessionMeta(updater));

  return createAgentChunkBridge((chunk) => {
    const stateBeforeDispatch = store.getState();
    store.getState().dispatchAgentChunk(chunk);
    if (chunk.kind === 'user_message') {
      const enrichedChunk = chunk as AgentChunk & {
        client_user_message_id?: string;
        message_id?: string;
      };
      const clientId = enrichedChunk.client_user_message_id ?? enrichedChunk.message_id;
      if (clientId) stateBeforeDispatch.removeSteeringMessageByClientId(chunk.thread_id, clientId);
    }
    if (chunk.kind !== 'stream_end') return;

    const state = store.getState();
    const canonicalThreadId = resolveExternalChunkThreadId(
      chunk,
      state.sessionMeta.externalSessionResolutions,
    );
    const projection = state.threadProjections[canonicalThreadId];
    const runId = chunk.run_id ?? projection?.runs.lastRun?.runId;
    const hasResidentRun = !!projection && (
      !chunk.run_id
      || projection.runs.activeRunId === chunk.run_id
      || projection.runs.lastRun?.runId === chunk.run_id
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
    if (runId) {
      if (agentType === 'opencode') return;
      globalThis.setTimeout(() => {
        const latest = store.getState();
        if (latest.threadTombstones[canonicalThreadId]) return;
        void latest.reconcileCompletedRun(agentType, canonicalThreadId, runId);
      }, 300);
    } else {
      void state.loadMessages(agentType, canonicalThreadId);
    }
  });
}
