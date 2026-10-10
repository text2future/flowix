import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openExternalTarget, store } = vi.hoisted(() => ({
  openExternalTarget: vi.fn(),
  store: {
    notebooks: [{ id: 'work-id', name: 'My Vault', path: 'C:/Notes' }],
    loadNotebooks: vi.fn(),
  },
}));

vi.mock('@features/memo/store/note-store', () => ({ useNoteStore: { getState: () => store } }));
vi.mock('@features/workspace/use-cases/workspace-navigation', () => ({
  clearWorkspaceDocument: vi.fn(),
  openExternalTarget,
}));
vi.mock('@features/memo/public/workspace-api', () => ({ setCurrentWorkspaceNotebook: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({ notes: {
  resolveLocation: vi.fn(),
  pathStatus: vi.fn().mockResolvedValue('present'),
} }));

import { openNoteByDeepLink } from './open-by-target';
import { peekAgentLocationRequest, cancelAgentLocationRequest } from '../../document/use-cases/agent-location-navigation';

describe('note deep links', () => {
  beforeEach(() => openExternalTarget.mockClear());

  it('opens a note by notebook name and relative file', async () => {
    await openNoteByDeepLink('flowix://open?b=My+Vault&f=Projects%2FPlan.md');
    expect(openExternalTarget).toHaveBeenCalledWith('C:/Notes/Projects/Plan.md', {
      scopePath: 'C:/Notes',
      destination: 'main-third',
    });
  });

  it('still opens existing book/file links', async () => {
    await openNoteByDeepLink('flowix://open?book=My+Vault&file=Projects%2FPlan.md');
    expect(openExternalTarget).toHaveBeenCalledWith('C:/Notes/Projects/Plan.md', {
      scopePath: 'C:/Notes',
      destination: 'main-third',
    });
  });

  it('rejects legacy memo ID links', async () => {
    await expect(openNoteByDeepLink('flowix://memo/abc12345')).rejects.toThrow('Expired note link');
    expect(openExternalTarget).not.toHaveBeenCalled();
  });

  it('publishes a heading anchor request for hash deep links', async () => {
    openExternalTarget.mockResolvedValueOnce({ host: 'main-third', state: 'active' });
    await openNoteByDeepLink('flowix://open?b=My+Vault&f=Projects%2FPlan.md#%E7%9B%AE%E6%A0%87%E4%B8%8E%E8%8C%83%E5%9B%B4');
    expect(openExternalTarget).toHaveBeenCalledWith('C:/Notes/Projects/Plan.md', {
      scopePath: 'C:/Notes',
      destination: 'main-third',
    });
    const request = peekAgentLocationRequest('C:/Notes/Projects/Plan.md');
    expect(request?.anchor).toBe('目标与范围');
    expect(request?.host).toBe('main-third');
    cancelAgentLocationRequest('C:/Notes/Projects/Plan.md');
  });

  it('accepts the legacy heading parameter and normalizes it to a slug', async () => {
    openExternalTarget.mockResolvedValueOnce({ host: 'main-third', state: 'active' });
    await openNoteByDeepLink('flowix://open?b=My+Vault&f=Projects%2FPlan.md&heading=Step%201%3A%20Setup');
    const request = peekAgentLocationRequest('C:/Notes/Projects/Plan.md');
    expect(request?.anchor).toBe('step-1-setup');
    cancelAgentLocationRequest('C:/Notes/Projects/Plan.md');
  });

  it('does not treat an empty heading parameter as an anchor', async () => {
    openExternalTarget.mockResolvedValueOnce({ host: 'main-third', state: 'active' });
    await openNoteByDeepLink('flowix://open?b=My+Vault&f=Projects%2FPlan.md&heading=');
    expect(peekAgentLocationRequest('C:/Notes/Projects/Plan.md')).toBeNull();
  });

  it('routes anchor requests to the browser column tab when content lands there', async () => {
    openExternalTarget.mockResolvedValueOnce({ host: 'browser-column', tabId: 'tab-7' });
    await openNoteByDeepLink('flowix://open?b=My+Vault&f=Projects%2FPlan.md#%E7%BB%93%E8%AE%BA');
    const request = peekAgentLocationRequest('C:/Notes/Projects/Plan.md');
    expect(request?.host).toBe('browser-column');
    expect(request?.viewId).toBe('tab-7');
    cancelAgentLocationRequest('C:/Notes/Projects/Plan.md');
  });

  it('falls back to main-third when the open result does not report a location', async () => {
    // openExternalTarget 的 markdown 主区分支返回 null，但内容实际落在 main-third。
    openExternalTarget.mockResolvedValueOnce(undefined);
    await openNoteByDeepLink('flowix://open?b=My+Vault&f=Projects%2FPlan.md#%E7%9B%AE%E6%A0%87');
    const request = peekAgentLocationRequest('C:/Notes/Projects/Plan.md');
    expect(request?.anchor).toBe('目标');
    expect(request?.host).toBe('main-third');
    expect(request?.viewId).toBe('main-third');
    cancelAgentLocationRequest('C:/Notes/Projects/Plan.md');
  });
});
