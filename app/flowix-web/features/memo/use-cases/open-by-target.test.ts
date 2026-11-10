import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openWorkspaceSurface, store } = vi.hoisted(() => ({
  openWorkspaceSurface: vi.fn(),
  store: {
    notebooks: [{ id: 'work-id', name: 'My Vault', path: 'C:/Notes' }],
    loadNotebooks: vi.fn(),
  },
}));

vi.mock('@features/memo/store/note-store', () => ({ useNoteStore: { getState: () => store } }));
vi.mock('@features/workspace/public/note-navigation-api', () => ({
  clearWorkspaceDocument: vi.fn(),
  openWorkspaceSurface,
}));
vi.mock('@features/memo/public/workspace-api', () => ({ setCurrentWorkspaceNotebook: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({ notes: {
  resolveLocation: vi.fn(),
  pathStatus: vi.fn().mockResolvedValue('present'),
} }));

import { openNoteByDeepLink } from './open-by-target';
import { peekAgentLocationRequest, cancelAgentLocationRequest } from '../../document/use-cases/agent-location-navigation';

describe('note deep links', () => {
  beforeEach(() => {
    openWorkspaceSurface.mockClear();
    openWorkspaceSurface.mockResolvedValue({
      status: 'opened', host: 'column-1', location: { host: 'column-1', state: 'active' },
    });
  });

  it('opens a note by notebook name and relative file', async () => {
    await openNoteByDeepLink('flowix://open?b=My+Vault&f=Projects%2FPlan.md');
    expect(openWorkspaceSurface).toHaveBeenCalledWith({
      index: 0,
      target: { kind: 'external', path: 'C:/Notes/Projects/Plan.md', scopePath: 'C:/Notes', transitionId: null },
    });
  });

  it('still opens existing book/file links', async () => {
    await openNoteByDeepLink('flowix://open?book=My+Vault&file=Projects%2FPlan.md');
    expect(openWorkspaceSurface).toHaveBeenCalledWith({
      index: 0,
      target: { kind: 'external', path: 'C:/Notes/Projects/Plan.md', scopePath: 'C:/Notes', transitionId: null },
    });
  });

  it('rejects legacy memo ID links', async () => {
    await expect(openNoteByDeepLink('flowix://memo/abc12345')).rejects.toThrow('Expired note link');
    expect(openWorkspaceSurface).not.toHaveBeenCalled();
  });

  it('publishes a heading anchor request for hash deep links', async () => {
    openWorkspaceSurface.mockResolvedValueOnce({ status: 'opened', host: 'column-1', location: { host: 'column-1', state: 'active' } });
    await openNoteByDeepLink('flowix://open?b=My+Vault&f=Projects%2FPlan.md#%E7%9B%AE%E6%A0%87%E4%B8%8E%E8%8C%83%E5%9B%B4');
    expect(openWorkspaceSurface).toHaveBeenCalledWith({
      index: 0,
      target: { kind: 'external', path: 'C:/Notes/Projects/Plan.md', scopePath: 'C:/Notes', transitionId: null },
    });
    const request = peekAgentLocationRequest('C:/Notes/Projects/Plan.md');
    expect(request?.anchor).toBe('目标与范围');
    expect(request?.host).toBe('column-1');
    cancelAgentLocationRequest('C:/Notes/Projects/Plan.md');
  });

  it('accepts the legacy heading parameter and normalizes it to a slug', async () => {
    openWorkspaceSurface.mockResolvedValueOnce({ status: 'opened', host: 'column-1', location: { host: 'column-1', state: 'active' } });
    await openNoteByDeepLink('flowix://open?b=My+Vault&f=Projects%2FPlan.md&heading=Step%201%3A%20Setup');
    const request = peekAgentLocationRequest('C:/Notes/Projects/Plan.md');
    expect(request?.anchor).toBe('step-1-setup');
    cancelAgentLocationRequest('C:/Notes/Projects/Plan.md');
  });

  it('does not treat an empty heading parameter as an anchor', async () => {
    openWorkspaceSurface.mockResolvedValueOnce({ status: 'opened', host: 'column-1', location: { host: 'column-1', state: 'active' } });
    await openNoteByDeepLink('flowix://open?b=My+Vault&f=Projects%2FPlan.md&heading=');
    expect(peekAgentLocationRequest('C:/Notes/Projects/Plan.md')).toBeNull();
  });

  it('routes anchor requests to the browser column tab when content lands there', async () => {
    openWorkspaceSurface.mockResolvedValueOnce({ status: 'opened', host: 'column-2', location: { host: 'column-2', surfaceId: 'tab-7' } });
    await openNoteByDeepLink('flowix://open?b=My+Vault&f=Projects%2FPlan.md#%E7%BB%93%E8%AE%BA');
    const request = peekAgentLocationRequest('C:/Notes/Projects/Plan.md');
    expect(request?.host).toBe('column-2');
    expect(request?.viewId).toBe('tab-7');
    cancelAgentLocationRequest('C:/Notes/Projects/Plan.md');
  });

  it('does not publish an anchor when the open was cancelled', async () => {
    openWorkspaceSurface.mockResolvedValueOnce({ status: 'cancelled', host: 'column-1', reason: 'navigation-cancelled' });
    await openNoteByDeepLink('flowix://open?b=My+Vault&f=Projects%2FPlan.md#%E7%9B%AE%E6%A0%87');
    expect(peekAgentLocationRequest('C:/Notes/Projects/Plan.md')).toBeNull();
  });

  it('opens a note in the browser column without touching the work column', async () => {
    openWorkspaceSurface.mockResolvedValueOnce({
      status: 'opened', host: 'column-2', location: { host: 'column-2', surfaceId: 'file:C:/Notes/Projects/Plan.md' },
    });
    await openNoteByDeepLink('flowix://open?b=My+Vault&f=Projects%2FPlan.md', null, {
      destination: 1,
    });
    expect(openWorkspaceSurface).toHaveBeenCalledWith({
      index: 1,
      target: { kind: 'external', path: 'C:/Notes/Projects/Plan.md', scopePath: 'C:/Notes', transitionId: null },
      options: { notebookId: 'work-id' },
    });
  });

  it('publishes the anchor against the browser column tab', async () => {
    openWorkspaceSurface.mockResolvedValueOnce({
      status: 'opened', host: 'column-2', location: { host: 'column-2', surfaceId: 'tab-note' },
    });
    await openNoteByDeepLink('flowix://open?b=My+Vault&f=Projects%2FPlan.md#%E7%BB%93%E8%AE%BA', null, {
      destination: 1,
    });
    const request = peekAgentLocationRequest('C:/Notes/Projects/Plan.md');
    expect(request?.host).toBe('column-2');
    expect(request?.viewId).toBe('tab-note');
    cancelAgentLocationRequest('C:/Notes/Projects/Plan.md');
  });

  it('opens a cross-notebook link by notebook ID', async () => {
    await openNoteByDeepLink('flowix://open?notebookId=work-id&f=Projects%2FPlan.md');
    expect(openWorkspaceSurface).toHaveBeenCalledWith({
      index: 0,
      target: { kind: 'external', path: 'C:/Notes/Projects/Plan.md', scopePath: 'C:/Notes', transitionId: null },
    });
  });

  it('resolves a notebook-relative link inside the referring notebook', async () => {
    await openNoteByDeepLink('flowix://open?f=Projects%2FPlan.md', null, { ownerNotebookId: 'work-id' });
    expect(openWorkspaceSurface).toHaveBeenCalledWith({
      index: 0,
      target: { kind: 'external', path: 'C:/Notes/Projects/Plan.md', scopePath: 'C:/Notes', transitionId: null },
    });
  });

  it('refuses a notebook-relative link with no notebook to resolve it', async () => {
    await expect(openNoteByDeepLink('flowix://open?f=Projects%2FPlan.md'))
      .rejects.toThrow('missing its notebook');
    expect(openWorkspaceSurface).not.toHaveBeenCalled();
  });
});
