import { useMemo } from 'react';

import type {
  AgentConversationInstance,
} from '@features/agent/store/agent-conversation-types';
import {
  useAgentSessionStore,
} from '@features/agent/store/agent-session-store';
import type { ThreadProjection } from '@features/agent/store/session-reducer';
import {
  getConversationRunSignature,
  splitConversationRunSignature,
} from '@features/agent/store/conversation-run-signature';

export type ConversationRunIndex = Readonly<Record<string, string>>;

export interface ConversationRunSummary {
  status: 'running' | 'completed' | 'failed' | 'cancelled' | null;
  runId: string | null;
  startedAt: number;
  currentTool: string | null;
}

const EMPTY_RUN_SUMMARY: ConversationRunSummary = {
  status: null,
  runId: null,
  startedAt: 0,
  currentTool: null,
};

function uniqueThreadIds(instances: Record<string, AgentConversationInstance>): string[] {
  const ids = new Set<string>();
  for (const instance of Object.values(instances)) {
    if (instance.threadId) ids.add(instance.threadId);
  }
  return [...ids].sort();
}

export function buildConversationRunIndex(
  projections: Record<string, ThreadProjection>,
  threadIds: readonly string[],
): ConversationRunIndex {
  const index: Record<string, string> = {};
  for (const threadId of threadIds) {
    index[threadId] = getConversationRunSignature(projections[threadId]);
  }
  return index;
}

export function getConversationRunSummaryFromSignature(signature: string): ConversationRunSummary {
  return splitConversationRunSignature(signature);
}

/**
 * Subscribe only to run-lifecycle fields for the supplied conversations.
 * Text/reasoning/tool deltas may replace `threadProjections`, but the shallow
 * map remains referentially stable while status/run id/start time are unchanged.
 */
export function useConversationRunIndex(
  instances: Record<string, AgentConversationInstance>,
): ConversationRunIndex {
  const threadIds = useMemo(() => uniqueThreadIds(instances), [instances]);
  const runStateVersion = useAgentSessionStore((state) => state.runStateVersion);
  return useMemo(() => {
    const state = useAgentSessionStore.getState();
    const index: Record<string, string> = {};
    for (const threadId of threadIds) {
      index[threadId] = state.threadRunSignatures[threadId]
        ?? getConversationRunSignature(state.threadProjections[threadId]);
    }
    return index;
  }, [threadIds, runStateVersion]);
}

export function getConversationRunSummary(
  index: ConversationRunIndex,
  threadId: string | null | undefined,
): ConversationRunSummary {
  if (!threadId) return EMPTY_RUN_SUMMARY;
  const signature = index[threadId];
  return signature
    ? getConversationRunSummaryFromSignature(signature)
    : EMPTY_RUN_SUMMARY;
}

export function isAgentConversationRunning(
  instance: AgentConversationInstance | null | undefined,
  index: ConversationRunIndex,
): boolean {
  return getConversationRunSummary(index, instance?.threadId).status === 'running';
}

export function selectRunningAgentConversations(
  state: { instances: Record<string, AgentConversationInstance> },
  index: ConversationRunIndex,
): AgentConversationInstance[] {
  return Object.values(state.instances)
    .filter((instance) => isAgentConversationRunning(instance, index))
    .sort((a, b) => (
      getConversationRunSummary(index, a.threadId).startedAt
      - getConversationRunSummary(index, b.threadId).startedAt
    ));
}
