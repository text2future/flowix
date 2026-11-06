// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAiCreditBalance } = vi.hoisted(() => ({
  getAiCreditBalance: vi.fn(async () => ({ balanceMicrocredits: 1_000_000 })),
}));

vi.mock('@platform/tauri/client', () => ({
  cloud: { getAiCreditBalance },
}));

import { useAgentCloudAccessStore } from '@features/agent/store/agent-cloud-access-store';
import { useAgentDataStore } from '@features/agent/store/agent-data-store';
import {
  cloudAccessReplyForError,
  createCloudAccessRunEnd,
  resolveCloudAccessForSend,
} from './cloud-access-preflight';

const THREAD = 'thread-cloud-preflight';

function setPiAccount(options: {
  providerId?: string;
  authenticated?: boolean;
}): void {
  const state = useAgentDataStore.getState();
  useAgentDataStore.setState({
    piCloudAccountId: options.authenticated === false ? null : 'user-1',
    agents: {
      ...state.agents,
      pi: {
        ...state.agents.pi,
        user: {
          ...state.agents.pi.user,
          model: options.providerId
            ? { id: `${options.providerId}/auto`, providerId: options.providerId }
            : undefined,
        },
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useAgentCloudAccessStore.setState({ entries: {} });
  getAiCreditBalance.mockResolvedValue({ balanceMicrocredits: 1_000_000 });
  setPiAccount({ providerId: 'flowix-cloud-member' });
});

afterEach(() => {
  useAgentCloudAccessStore.setState({ entries: {} });
});

describe('resolveCloudAccessForSend', () => {
  it('blocks a signed-out account without asking for a balance', async () => {
    setPiAccount({ providerId: 'flowix-cloud-member', authenticated: false });
    await expect(resolveCloudAccessForSend(THREAD, 'pi')).resolves.toBe('signed_out');
    expect(getAiCreditBalance).not.toHaveBeenCalled();
    expect(useAgentCloudAccessStore.getState().entries[THREAD]).toBe('signed_out');
  });

  it('blocks a cloud model with an empty balance before the request is made', async () => {
    getAiCreditBalance.mockResolvedValue({ balanceMicrocredits: 0 });
    await expect(resolveCloudAccessForSend(THREAD, 'pi')).resolves.toBe('no_credits');
    expect(getAiCreditBalance).toHaveBeenCalledTimes(1);
    expect(useAgentCloudAccessStore.getState().entries[THREAD]).toBe('no_credits');
  });

  it('lets a funded account through and clears an earlier notice', async () => {
    useAgentCloudAccessStore.getState().setAccess(THREAD, 'no_credits');
    await expect(resolveCloudAccessForSend(THREAD, 'pi')).resolves.toBeNull();
    expect(useAgentCloudAccessStore.getState().entries[THREAD]).toBeUndefined();
  });

  it('fails open when the balance cannot be read', async () => {
    getAiCreditBalance.mockRejectedValue(new Error('offline'));
    await expect(resolveCloudAccessForSend(THREAD, 'pi')).resolves.toBeNull();
    expect(useAgentCloudAccessStore.getState().entries[THREAD]).toBeUndefined();
  });

  it('ignores the balance for user-owned providers and other agents', async () => {
    setPiAccount({ providerId: 'custom-provider' });
    await expect(resolveCloudAccessForSend(THREAD, 'pi')).resolves.toBeNull();
    await expect(resolveCloudAccessForSend(THREAD, 'codex')).resolves.toBeNull();
    expect(getAiCreditBalance).not.toHaveBeenCalled();
  });

  it('closes the blocked turn as a normal end, not a failure', () => {
    expect(createCloudAccessRunEnd(THREAD, 'pi', 'run-1')).toMatchObject({
      kind: 'stream_end',
      agentType: 'pi',
      threadId: THREAD,
      runId: 'run-1',
      reason: null,
    });
  });

  it('converts a Cloud no-credit failure into the purchase card reply', () => {
    const reply = cloudAccessReplyForError(THREAD, {
      kind: 'error',
      agentType: 'pi',
      threadId: THREAD,
      runId: 'run-2',
      timestamp: Date.now(),
      message: 'pi exited with status 1',
      errorDetails: {
        category: 'quota_exhausted',
        retryable: false,
        upstreamMessage: 'Your Flowix credit balance must be greater than zero',
      },
    });
    expect(reply).toMatchObject({ kind: 'stream_end', runId: 'run-2', reason: null });
    expect(useAgentCloudAccessStore.getState().entries[THREAD]).toBe('no_credits');
  });

  it('leaves unrelated failures on the ordinary error path', () => {
    expect(cloudAccessReplyForError(THREAD, {
      kind: 'error',
      agentType: 'pi',
      threadId: THREAD,
      runId: 'run-3',
      timestamp: Date.now(),
      message: 'model not found',
      errorDetails: { category: 'model_not_found', retryable: false },
    })).toBeNull();
    expect(cloudAccessReplyForError(THREAD, {
      kind: 'error',
      agentType: 'codex',
      threadId: THREAD,
      runId: 'run-4',
      timestamp: Date.now(),
      message: 'insufficient credits',
    })).toBeNull();
    expect(useAgentCloudAccessStore.getState().entries[THREAD]).toBeUndefined();
  });
});
