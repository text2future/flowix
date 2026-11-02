import { beforeEach, describe, expect, it, vi } from 'vitest';

const open = vi.hoisted(() => vi.fn());
vi.mock('./surface-opening', () => ({ openWorkspaceSurface: open }));
vi.mock('./browser-column-navigation', () => ({ openBrowserColumnTarget: vi.fn() }));
import { useWorkspaceSessionStore } from '../store/workspace-session-store';
import { useBrowserColumnStore } from '../store/browser-column-store';
import { openWorkspaceSurface } from './host-surface-opening';

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceSessionStore.getState().reset();
  useBrowserColumnStore.getState().reset();
  open.mockImplementation(async (request) => request.host === 'main-third'
    ? { status: 'opened', host: 'main-third', location: { host: 'main-third', state: 'active' } }
    : { status: 'opened', host: 'browser-column', location: { host: 'browser-column', surfaceId: 'secondary-view' } });
});

describe('container to session routing', () => {
  it('preserves the ordinary host contract before relocation', async () => {
    const request = { host: 'main-third' as const, target: { kind: 'web' as const, url: 'https://example.com/' } };
    const result = await openWorkspaceSurface(request);
    expect(open).toHaveBeenCalledWith(request);
    if (result.status === 'cancelled') throw new Error('Unexpected cancellation');
    expect(result.location).toEqual({ host: 'main-third', state: 'active' });
  });

  it('opens in the session now occupying Work and retains its runtime location', async () => {
    useWorkspaceSessionStore.getState().swap();
    const result = await openWorkspaceSurface({ host: 'main-third',
      target: { kind: 'external', path: '/book/a.md', scopePath: '/book' },
      options: { notebookId: 'book' } });
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ host: 'browser-column',
      options: { notebookId: 'book' } }));
    if (result.status === 'cancelled') throw new Error('Unexpected cancellation');
    expect(result.location).toEqual({ host: 'main-third', state: 'active',
      runtimeLocation: { host: 'browser-column', surfaceId: 'secondary-view' } });
    expect(useBrowserColumnStore.getState().visible).toBe(false);
  });

  it('opens file-browser targets in the primary adapter after it moves to Browser', async () => {
    useWorkspaceSessionStore.getState().swap();
    const target = { kind: 'file-browser' as const, folderPath: '/book', activeFilePath: null,
      scopePath: '/book', notebookId: 'book', fileTreeVisible: true, fileTreeWidth: 220 };
    const result = await openWorkspaceSurface({ host: 'browser-column', target });
    expect(open).toHaveBeenCalledWith({ host: 'main-third', target });
    expect(result.host).toBe('browser-column');
    expect(useBrowserColumnStore.getState().visible).toBe(true);
  });

  it('keeps cancellation on the requested physical host', async () => {
    useWorkspaceSessionStore.getState().swap();
    open.mockResolvedValueOnce({ status: 'cancelled', host: 'browser-column', reason: 'navigation-cancelled' });
    await expect(openWorkspaceSurface({ host: 'main-third',
      target: { kind: 'web', url: 'https://example.com/' } })).resolves.toEqual({
      status: 'cancelled', host: 'main-third', reason: 'navigation-cancelled',
    });
  });
});
