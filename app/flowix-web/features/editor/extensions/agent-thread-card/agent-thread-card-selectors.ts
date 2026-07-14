import type { AgentRunState, AgentTypeKey } from '@/types/agent';
import type { ThreadState } from '@features/agent/store/chat-store';
import type { AgentConversationRun } from '@features/agent/store/agent-conversation-store';
import { getAgentType } from '@/lib/agent-types';

export interface AgentThreadCardRunStatusView {
  activeRun: AgentRunState | undefined;
  latestRun: AgentRunState | AgentConversationRun | undefined;
  supportsStreaming: boolean;
  isIdle: boolean;
  status: AgentRunState['status'] | AgentConversationRun['status'] | 'completed';
  statusClass: AgentRunState['status'] | AgentConversationRun['status'] | 'completed' | 'idle';
  shouldShowStatus: boolean;
}

export interface AgentThreadCardRuntimeView extends AgentThreadCardRunStatusView {
  isRunning: boolean;
  isBusy: boolean;
  showLoadingIndicator: boolean;
  sendButtonWantsStop: boolean;
}

export function selectAgentThreadCardRunStatus(input: {
  state: ThreadState | undefined;
  conversationRun?: AgentConversationRun;
  isCreating: boolean;
  isLoading: boolean;
  typeKey: AgentTypeKey;
}): AgentThreadCardRunStatusView {
  const activeRun = input.state?.activeRunId
    ? input.state.runs[input.state.activeRunId]
    : undefined;
  const latestThreadRun = activeRun ?? Object.values(input.state?.runs ?? {})
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  const latestRun = input.conversationRun ?? latestThreadRun;
  const supportsStreaming = getAgentType(activeRun?.agentType ?? input.typeKey)
    .capabilities.supportsTextStreaming;
  const isIdle = !input.isCreating && !activeRun && !input.isLoading && !latestRun;
  const status = input.isCreating
    ? 'running'
    : input.conversationRun?.status ??
      activeRun?.status ??
      (input.isLoading ? 'running' : latestThreadRun?.status ?? 'completed');

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

export function selectAgentThreadCardRuntimeView(input: {
  state: ThreadState | undefined;
  conversationRun?: AgentConversationRun;
  isCreating: boolean;
  isLoading: boolean;
  typeKey: AgentTypeKey;
}): AgentThreadCardRuntimeView {
  const statusView = selectAgentThreadCardRunStatus(input);
  const isRunning = statusView.status === 'running';
  const isBusy = input.isCreating || isRunning;
  return {
    ...statusView,
    isRunning,
    isBusy,
    showLoadingIndicator: isRunning,
    sendButtonWantsStop: isRunning,
  };
}

export function selectAgentThreadCardSendButtonState(input: {
  wantStop: boolean;
  inputValue: string;
}): { wantStop: boolean; disabled: boolean } {
  const hasInput = !!input.inputValue.trim();
  return {
    wantStop: input.wantStop,
    disabled: !input.wantStop && !hasInput,
  };
}
