import { describe, expect, it, vi } from 'vitest';
import { CloudAccessBlockedError } from '@features/agent/config/cloud-access';

const mocks = vi.hoisted(() => ({
  send: vi.fn(), login: vi.fn(), credits: vi.fn(), started: vi.fn(),
}));
vi.mock('@features/agent/store/agent-session-store', () => ({ useAgentSessionStore: { getState: () => ({ sendMessageToThread: mocks.send }) } }));
vi.mock('@features/preferences/public/cloud-login-dialog', () => ({ openCloudLoginDialog: mocks.login }));
vi.mock('@features/agent/thread-card/cloud-access/cloud-credits-dialog', () => ({ openCloudCreditsDialog: mocks.credits }));
vi.mock('@features/agent/runtime/workspace-snapshot', () => ({ markConversationWorkspaceStarted: mocks.started }));

import { acceptComposerSubmission } from './composer-submission-service';

const binding = { instanceId: 'instance', threadId: 'thread', typeKey: 'pi' as const,
  title: 'test', runtimeConfig: null, isFirstMessage: true };
const snapshot = { markdown: '你好', prompt: '你好', displayContent: '你好', attachments: [] };

describe('Cloud access on composer submission', () => {
  it.each([
    ['signed_out', 'login'], ['no_credits', 'credits'],
  ] as const)('opens %s dialog and rejects the draft for restoration', async (kind, dialog) => {
    vi.clearAllMocks();
    const error = new CloudAccessBlockedError(kind);
    mocks.send.mockRejectedValueOnce(error);
    await expect(acceptComposerSubmission(binding, snapshot, 'message')).rejects.toBe(error);
    expect(mocks[dialog]).toHaveBeenCalledOnce();
    expect(mocks[dialog === 'login' ? 'credits' : 'login']).not.toHaveBeenCalled();
    expect(mocks.started).not.toHaveBeenCalled();
  });
});
