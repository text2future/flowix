import type { AgentRunState, AgentTypeKey } from '@/types/agent';
import type { ThreadState } from '@features/agent/store/thread-runtime-state';
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

export interface AgentThreadCardRuntimeView extends AgentThreadCardRunStatusView {
  isRunning: boolean;
  isModelRunning: boolean;
  isDshCommandRunning: boolean;
  isCodexCommandRunning: boolean;
  isCodexCommandStoppable: boolean;
  isBusy: boolean;
  showLoadingIndicator: boolean;
  sendButtonWantsStop: boolean;
}

/** Codex goal commands start work that can be interrupted from the composer. */
export function isCodexGoalCommand(command: string | undefined): boolean {
  return !!command && /^\/goal(?:\s|$)/iu.test(command.trim());
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
  const latestThreadRun = activeRun ?? Object.values(input.state?.runs ?? {})
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  const latestRun = latestThreadRun;
  const isDshCommandRunning = input.state?.dshCommand?.status === 'pending';
  const isCodexCommandRunning = input.state?.codexCommand?.status === 'pending';
  const supportsStreaming = getAgentType(activeRun?.agentType ?? input.typeKey)
    .capabilities.supportsTextStreaming;
  const isIdle =
    !input.isCreating &&
    !activeRun &&
    !input.isLoading &&
    !latestRun &&
    !isDshCommandRunning &&
    !isCodexCommandRunning;
  const status = input.isCreating
    ? 'running'
    : activeRun?.status ??
      (input.isLoading || isDshCommandRunning || isCodexCommandRunning
        ? 'running'
        : latestThreadRun?.status ?? 'completed');

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
  isCreating: boolean;
  isLoading: boolean;
  typeKey: AgentTypeKey;
}): AgentThreadCardRuntimeView {
  const statusView = selectAgentThreadCardRunStatus(input);
  const activeRun = statusView.activeRun;
  const isDshCommandRunning = input.state?.dshCommand?.status === 'pending';
  const isCodexCommandRunning = input.state?.codexCommand?.status === 'pending';
  const isCodexCommandStoppable =
    isCodexCommandRunning && isCodexGoalCommand(input.state?.codexCommand?.command);
  // `state.isLoading` is the canonical lifecycle signal. During the short
  // window between stream_start and the run registry update, activeRunId can
  // already be set while `activeRun` is still unavailable. Dropping this
  // fallback makes the renderer leave its rAF streaming path and can rebuild
  // the whole message list through an intermediate empty projection.
  // Native slash commands have their own operation lifecycle. They may use
  // the same backend stream plumbing (notably `/compact`), but the composer
  // must show the DSH-style running spinner while a non-stoppable command is
  // pending. `/goal` is the explicit command-level stop exception below.
  const isModelRunning =
    !isDshCommandRunning &&
    !isCodexCommandRunning &&
    (input.isLoading || activeRun?.status === 'running');
  // `isRunning` describes thread-owned work for the rest of the card (for
  // example settings must remain locked during a DSH command). It does not
  // mean that a synthetic model run was created; stop-button semantics stay
  // tied to `isModelRunning` or the explicit stoppable goal below.
  const isRunning = isModelRunning || isDshCommandRunning || isCodexCommandRunning;
  const isBusy = input.isCreating || isRunning;
  /*
   * 工具调用阶段的 loader:
   * run 状态为 "running" 时(纯文本/推理流)显然要显示; 但 provider 通常
   * 在发出 tool_call 后立刻 stream_end,导致 run 状态变成 "completed" 而
   * tool 仍在外部执行。此时 store 侧仍有 activeRunId / currentTool /
   * 处于 isLoading 的 tool 行 — 任何一条成立都说明 agent 还在工作,应该
   * 把 loading-indicator 继续显示,而不是隐藏到下一轮 stream_start。
   */
  const hasInFlightTool = !!activeRun?.currentTool;
  const hasLoadingToolRow = (input.state?.messages ?? []).some(
    (m) => m.role === 'tool' && m.isLoading,
  );
  const showLoadingIndicator =
    isRunning || hasInFlightTool || hasLoadingToolRow;
  return {
    ...statusView,
    isRunning,
    isModelRunning,
    isDshCommandRunning,
    isCodexCommandRunning,
    isCodexCommandStoppable,
    isBusy,
    showLoadingIndicator,
    // Codex accepts the next prompt into Flowix's serial queue while its
    // current turn is running. The composer decides whether there is input;
    // this base value remains the stop state for an empty composer.
    sendButtonWantsStop: isModelRunning || isCodexCommandStoppable,
  };
}

export function selectAgentThreadCardSendButtonState(input: {
  wantStop: boolean;
  inputValue: string;
  isRunning?: boolean;
  hasAttachments?: boolean;
  hasPendingAttachments?: boolean;
}): { wantStop: boolean; disabled: boolean } {
  const hasInput = !!input.inputValue.trim() || !!input.hasAttachments;
  return {
    wantStop: input.wantStop,
    disabled:
      !!input.isRunning ||
      (!input.wantStop && (!hasInput || !!input.hasPendingAttachments)),
  };
}
