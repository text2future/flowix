import { describe, expect, it } from 'vitest';
import type { ThreadState } from '@features/agent/store/chat-store';
import {
  selectAgentThreadCardRunStatus,
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

  it('selects send button state from loading and input text', () => {
    expect(selectAgentThreadCardSendButtonState({
      isLoading: false,
      inputValue: '',
    })).toEqual({ wantStop: false, disabled: true });
    expect(selectAgentThreadCardSendButtonState({
      isLoading: false,
      inputValue: 'hello',
    })).toEqual({ wantStop: false, disabled: false });
    expect(selectAgentThreadCardSendButtonState({
      isLoading: true,
      inputValue: '',
    })).toEqual({ wantStop: true, disabled: false });
  });
});
