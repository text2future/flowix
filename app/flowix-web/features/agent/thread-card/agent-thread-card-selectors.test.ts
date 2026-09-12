import { describe, expect, it } from 'vitest';
import type { ThreadState } from '@features/agent/store/agent-session-test-facade';
import {
  selectAgentThreadCardRunStatus,
  selectAgentThreadCardRuntimeView,
  selectAgentThreadCardSendButtonState,
} from './agent-thread-card-selectors';

function threadState(overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    messages: [],
    isLoading: false,
    activeRunId: null,
    runs: {},
    pendingAssistantId: null,
    pendingReasoningId: null,
    oldestSequence: null,
    hasMoreHistory: false,
    loadingMore: false,
    ...overrides,
  };
}

describe('agent thread card selectors', () => {
  it('returns idle status when there is no run or loading state', () => {
    const status = selectAgentThreadCardRunStatus({
      state: undefined,
      isCreating: false,
      isLoading: false,
      typeKey: 'codex',
    });

    expect(status).toMatchObject({
      isIdle: true,
      shouldShowStatus: false,
      status: 'completed',
      statusClass: 'idle',
    });
  });

  it('returns the active run as running', () => {
    const status = selectAgentThreadCardRunStatus({
      state: threadState({
        activeRunId: 'run-1',
        runs: {
          'run-1': {
            runId: 'run-1',
            agentType: 'codex',
            threadId: 'thread-1',
            status: 'running',
            startedAt: 10,
          },
        },
      }),
      isCreating: false,
      isLoading: true,
      typeKey: 'codex',
    });

    expect(status.shouldShowStatus).toBe(true);
    expect(status.status).toBe('running');
    expect(status.latestRun?.runId).toBe('run-1');
  });

  it('uses the latest thread runtime when no active run is present', () => {
    const status = selectAgentThreadCardRunStatus({
      state: threadState({
        runs: {
          'run-thread': {
            runId: 'run-thread',
            agentType: 'codex',
            threadId: 'thread-1',
            status: 'failed',
            startedAt: 10,
          },
        },
      }),
      isCreating: false,
      isLoading: false,
      typeKey: 'codex',
    });

    expect(status.shouldShowStatus).toBe(true);
    expect(status.status).toBe('failed');
    expect(status.latestRun?.runId).toBe('run-thread');
  });

  it('derives Thread Card runtime UI from the active thread run', () => {
    const runtime = selectAgentThreadCardRuntimeView({
      state: threadState({
        activeRunId: 'run-thread',
        runs: {
          'run-thread': {
            runId: 'run-thread',
            agentType: 'codex',
            threadId: 'thread-1',
            status: 'running',
            startedAt: 20,
          },
        },
      }),
      isCreating: false,
      isLoading: false,
      typeKey: 'codex',
    });

    expect(runtime.isRunning).toBe(true);
    expect(runtime.isBusy).toBe(true);
    expect(runtime.showLoadingIndicator).toBe(true);
    expect(runtime.sendButtonWantsStop).toBe(true);
  });

  it('keeps streaming mode during the run-registry handoff', () => {
    const runtime = selectAgentThreadCardRuntimeView({
      state: threadState({
        activeRunId: 'run-handoff',
        runs: {},
      }),
      isCreating: false,
      isLoading: true,
      typeKey: 'codex',
    });

    expect(runtime.isRunning).toBe(true);
    expect(runtime.isBusy).toBe(true);
    expect(runtime.showLoadingIndicator).toBe(true);
    expect(runtime.sendButtonWantsStop).toBe(true);
  });

  it('keeps the loading indicator on while a tool call is in flight', () => {
    // Provider 通常在发出 tool_call 后立即 stream_end, 导致 run.status 变成
    // "completed" 而 activeRunId 被清空 —— 此时 store 侧 run 上仍有
    // currentTool (或还有 isLoading 的 tool 行), 表示 agent 仍在工作,
    // 9 宫格应当继续显示而不是等到下一轮 stream_start。
    const runtime = selectAgentThreadCardRuntimeView({
      state: threadState({
        activeRunId: null,
        runs: {
          'run-tool': {
            runId: 'run-tool',
            agentType: 'codex',
            threadId: 'thread-1',
            status: 'completed',
            startedAt: 30,
            currentTool: 'Bash',
          },
        },
        messages: [
          {
            id: 'tool-1',
            role: 'tool',
            content: '',
            timestamp: '2026-01-01T00:00:00.000Z',
            toolCallId: 'call-1',
            toolName: 'Bash',
            isLoading: true,
          },
        ],
      }),
      isCreating: false,
      isLoading: false,
      typeKey: 'codex',
    });

    expect(runtime.isRunning).toBe(false);
    expect(runtime.showLoadingIndicator).toBe(true);
    expect(runtime.sendButtonWantsStop).toBe(false);
  });

  it('treats a pending DSH command as thread work without inventing a model run', () => {
    const runtime = selectAgentThreadCardRuntimeView({
      state: threadState({
        dshCommand: {
          id: 'command-1',
          name: 'compact',
          args: '',
          status: 'pending',
          startedAt: 40,
        },
      }),
      isCreating: false,
      isLoading: false,
      typeKey: 'deepseek-harness',
    });

    expect(runtime.status).toBe('running');
    expect(runtime.isRunning).toBe(true);
    expect(runtime.isBusy).toBe(true);
    expect(runtime.showLoadingIndicator).toBe(true);
    expect(runtime.sendButtonWantsStop).toBe(false);
  });

  it('treats a pending Codex command like DSH command work', () => {
    const runtime = selectAgentThreadCardRuntimeView({
      state: threadState({
        isLoading: true,
        codexCommand: {
          id: 'codex-command-1',
          command: '/compact',
          status: 'pending',
          startedAt: 40,
        },
      }),
      isCreating: false,
      isLoading: true,
      typeKey: 'codex',
    });

    expect(runtime.status).toBe('running');
    expect(runtime.isRunning).toBe(true);
    expect(runtime.isBusy).toBe(true);
    expect(runtime.showLoadingIndicator).toBe(true);
    expect(runtime.sendButtonWantsStop).toBe(false);
    expect(runtime.isCodexCommandStoppable).toBe(false);
  });

  it('makes a pending Codex goal command stoppable while keeping message loading', () => {
    const runtime = selectAgentThreadCardRuntimeView({
      state: threadState({
        isLoading: true,
        codexCommand: {
          id: 'codex-command-goal',
          command: '/goal set ship it',
          status: 'pending',
          startedAt: 40,
        },
      }),
      isCreating: false,
      isLoading: true,
      typeKey: 'codex',
    });

    expect(runtime.isRunning).toBe(true);
    expect(runtime.isBusy).toBe(true);
    expect(runtime.showLoadingIndicator).toBe(true);
    expect(runtime.isCodexCommandStoppable).toBe(true);
    expect(runtime.sendButtonWantsStop).toBe(true);
  });

  it('hides the loading indicator when the run truly settled', () => {
    const runtime = selectAgentThreadCardRuntimeView({
      state: threadState({
        activeRunId: null,
        runs: {
          'run-done': {
            runId: 'run-done',
            agentType: 'codex',
            threadId: 'thread-1',
            status: 'completed',
            startedAt: 30,
            endedAt: 31,
          },
        },
        messages: [
          {
            id: 'tool-1',
            role: 'tool',
            content: 'output',
            timestamp: '2026-01-01T00:00:00.000Z',
            toolCallId: 'call-1',
            toolName: 'Bash',
            isLoading: false,
          },
        ],
      }),
      isCreating: false,
      isLoading: false,
      typeKey: 'codex',
    });

    expect(runtime.isRunning).toBe(false);
    expect(runtime.showLoadingIndicator).toBe(false);
  });

  it('selects send button state from loading and input text', () => {
    expect(selectAgentThreadCardSendButtonState({
      wantStop: false,
      inputValue: '',
    })).toEqual({ wantStop: false, disabled: true });
    expect(selectAgentThreadCardSendButtonState({
      wantStop: false,
      inputValue: 'hello',
    })).toEqual({ wantStop: false, disabled: false });
    expect(selectAgentThreadCardSendButtonState({
      wantStop: true,
      inputValue: '',
    })).toEqual({ wantStop: true, disabled: false });
    expect(selectAgentThreadCardSendButtonState({
      wantStop: false,
      inputValue: '',
      hasAttachments: true,
    })).toEqual({ wantStop: false, disabled: false });
    expect(selectAgentThreadCardSendButtonState({
      wantStop: false,
      inputValue: 'hello',
      hasPendingAttachments: true,
    })).toEqual({ wantStop: false, disabled: true });
    expect(selectAgentThreadCardSendButtonState({
      wantStop: false,
      inputValue: 'hello',
      isRunning: true,
    })).toEqual({ wantStop: false, disabled: true });
  });
});
