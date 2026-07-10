import type { AgentRunState, AgentTypeKey } from '@/types/agent';
import type { ThreadState } from '@features/agent/store/chat-store';
import { getAgentType } from '@/lib/agent-types';

export interface AgentThreadCardRunStatusView {
  activeRun: AgentRunState | undefined;
  latestRun: AgentRunState | undefined;
  supportsStreaming: boolean;
  isIdle: boolean;
  status: AgentRunState['status'] | 'completed';
  statusClass: AgentRunState['status'] | 'completed' | 'idle';
  shouldShowStatus: boolean;
}

export function selectAgentThreadCardRunStatus(input: {
  state: ThreadState | undefined;
  isCreating: boolean;
  isLoading: boolean;
  typeKey: AgentTypeKey;
}): AgentThreadCardRunStatusView {
  const activeRun = input.state?.activeRunId
    ? input.state.runs[input.state.activeRunId]
    : undefined;
  const latestRun = activeRun ?? Object.values(input.state?.runs ?? {})
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  const supportsStreaming = getAgentType(activeRun?.agentType ?? input.typeKey)
    .capabilities.supportsTextStreaming;
  const isIdle = !input.isCreating && !activeRun && !input.isLoading && !latestRun;
  const status = input.isCreating
    ? 'running'
    : activeRun?.status ?? (input.isLoading ? 'running' : latestRun?.status ?? 'completed');

  return {
    activeRun,
    latestRun,
    supportsStreaming,
    isIdle,
    status,
    statusClass: isIdle ? 'idle' : status,
    shouldShowStatus: !isIdle,
  };
}

export function selectAgentThreadCardSendButtonState(input: {
  isLoading: boolean;
  inputValue: string;
}): { wantStop: boolean; disabled: boolean } {
  const hasInput = !!input.inputValue.trim();
  return {
    wantStop: input.isLoading,
    disabled: !input.isLoading && !hasInput,
  };
}
