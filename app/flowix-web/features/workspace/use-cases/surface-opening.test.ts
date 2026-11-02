import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openWork: vi.fn(), openBrowser: vi.fn(),
  prepareDocumentLeave: vi.fn(),
  flushBrowser: vi.fn(),
  workIdentity: null as { kind: 'external'; path: string } | null,
}));
vi.mock('./workspace-navigation', () => ({
  openExternalTarget: mocks.openWork,
  prepareActiveWorkColumnDocumentLeave: mocks.prepareDocumentLeave,
  openCollectionTarget: vi.fn(),
  openMediaLibraryTarget: vi.fn(), openMediaTarget: vi.fn(),
  openPluginWorkbench: vi.fn(), openTableTarget: vi.fn(), openWebTarget: vi.fn(),
}));
vi.mock('./browser-column-navigation', () => ({
  openBrowserColumnTarget: mocks.openBrowser,
  createFileBrowserTarget: (path: string, scopePath: string | null) => ({
    kind: 'file-browser', activeFilePath: path, scopePath, folderPath: null,
    notebookId: null, fileTreeVisible: true, fileTreeWidth: 220,
  }),
}));
vi.mock('./prepare-browser-document-for-work', () => ({ flushBrowserViewBeforeOpeningWork: mocks.flushBrowser }));
vi.mock('./agent-conversation-navigation', () => ({ selectAndOpenAgentConversation: vi.fn() }));
vi.mock('./workspace-content-activation', () => ({
  workColumnTargetIdentity: () => mocks.workIdentity,
  findWorkspaceContentLocations: () => ({ browserColumn: null }),
  findWorkspaceContentForNavigation: (identity: { kind: 'external'; path: string }) =>
    mocks.workIdentity?.path === identity.path ? { host: 'main-third', state: 'active' } : null,
  browserColumnTargetIdentity: (target: { activeFilePath: string }) => ({ kind: 'external', path: target.activeFilePath }),
}));
vi.mock('@platform/tauri/client', () => ({ collections: {}, notebooks: {} }));

import { useWorkColumnStore } from '../store/work-column-store';
import { openWorkspaceSurface } from './surface-opening';
import { NavigationCancelledError } from '@/lib/navigation-cancelled-error';

describe('public surface opening host contract', () => {
  const target = { kind: 'external' as const, path: '/notes/a.md', scopePath: '/notes' };
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkColumnStore.setState({ navigation: {
      phase: 'idle', requestId: 0, target: { kind: 'empty' }, pendingTarget: null,
      previousTarget: null, showWorkColumnLoading: false, failure: null, retryToken: null,
    } });
    mocks.prepareDocumentLeave.mockResolvedValue(undefined);
    mocks.flushBrowser.mockReset().mockResolvedValue(true);
    mocks.workIdentity = null;
    mocks.openWork.mockImplementation(async (path: string) => { mocks.workIdentity = { kind: 'external', path }; });
    mocks.openBrowser.mockResolvedValue({ host: 'browser-column', surfaceId: 'a', alreadyOpen: true });
  });

  it('keeps an explicit Work request in Work', async () => {
    await expect(openWorkspaceSurface({ host: 'main-third', target })).resolves.toEqual({
      status: 'opened', host: 'main-third', location: { host: 'main-third', state: 'active' },
    });
    expect(mocks.openWork).toHaveBeenCalledWith(target.path, expect.objectContaining({ destination: 'main-third' }));
    expect(mocks.openBrowser).not.toHaveBeenCalled();
  });

  it('normalizes a refused Work document leave as cancellation', async () => {
    mocks.openWork.mockRejectedValueOnce(new NavigationCancelledError('saving could not be retained'));
    await expect(openWorkspaceSurface({ host: 'main-third', target })).resolves.toEqual({
      status: 'cancelled', host: 'main-third', reason: 'navigation-cancelled',
    });
  });

  it('normalizes a refused Work leave before opening Browser as cancellation', async () => {
    mocks.workIdentity = { kind: 'external', path: target.path };
    mocks.prepareDocumentLeave.mockRejectedValueOnce(new NavigationCancelledError('saving could not be retained'));
    await expect(openWorkspaceSurface({ host: 'browser-column', target })).resolves.toEqual({
      status: 'cancelled', host: 'browser-column', reason: 'navigation-cancelled',
    });
    expect(mocks.openBrowser).not.toHaveBeenCalled();
  });

  it('keeps explicit Browser opens in Browser and forwards notebook context', async () => {
    await expect(openWorkspaceSurface({ host: 'browser-column', target, options: { notebookId: 'book' } }))
      .resolves.toEqual({ status: 'activated', host: 'browser-column', location: { host: 'browser-column', surfaceId: 'a' } });
    // Notebook ownership is in the target; navigation policy is passed separately.
    expect(mocks.openBrowser).toHaveBeenCalledWith(expect.objectContaining({ notebookId: 'book', activeFilePath: target.path }), { notebookId: 'book' });
    expect(mocks.openWork).not.toHaveBeenCalled();
  });

  it('forwards a created note reveal policy with its document navigation', async () => {
    await openWorkspaceSurface({ host: 'main-third', target: { ...target, treeReveal: 'created-note' } });
    expect(mocks.openWork).toHaveBeenCalledWith(target.path, expect.objectContaining({
      treeReveal: 'created-note',
    }));
  });

  it('publishes Work changes before opening a second view of the same content', async () => {
    mocks.workIdentity = { kind: 'external', path: target.path };
    await openWorkspaceSurface({ host: 'browser-column', target });
    expect(mocks.prepareDocumentLeave).toHaveBeenCalledOnce();
    expect(mocks.prepareDocumentLeave.mock.invocationCallOrder[0]).toBeLessThan(mocks.openBrowser.mock.invocationCallOrder[0]);
  });

  it('preserves a cancelled Browser navigation result', async () => {
    mocks.openBrowser.mockResolvedValue(null);
    await expect(openWorkspaceSurface({ host: 'browser-column', target })).resolves.toEqual({
      status: 'cancelled', host: 'browser-column', reason: 'navigation-cancelled',
    });
    expect(mocks.openWork).not.toHaveBeenCalled();
  });

  it('reports a Work navigation superseded before its target becomes active as cancelled', async () => {
    mocks.openWork.mockImplementation(async () => undefined);
    await expect(openWorkspaceSurface({ host: 'main-third', target })).resolves.toEqual({
      status: 'cancelled', host: 'main-third', reason: 'navigation-cancelled',
    });
  });
  it('does not let an older save barrier override a later Work click', async () => {
    let finishFirst!: (saved: boolean) => void;
    mocks.flushBrowser.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishFirst = resolve; }));
    const first = openWorkspaceSurface({ host: 'main-third', target });
    const secondTarget = { ...target, path: '/notes/b.md' };
    await expect(openWorkspaceSurface({ host: 'main-third', target: secondTarget })).resolves.toMatchObject({ status: 'opened' });
    finishFirst(true);
    await expect(first).resolves.toMatchObject({ status: 'cancelled', host: 'main-third' });
    expect(mocks.openWork).toHaveBeenCalledTimes(1);
    expect(mocks.openWork).toHaveBeenCalledWith(secondTarget.path, expect.anything());
  });

  it('keeps a Work request cancelled when the Browser save barrier refuses', async () => {
    mocks.flushBrowser.mockResolvedValueOnce(false);
    await expect(openWorkspaceSurface({ host: 'main-third', target })).resolves.toMatchObject({ status: 'cancelled', host: 'main-third' });
    expect(mocks.openWork).not.toHaveBeenCalled();
    expect(mocks.openBrowser).not.toHaveBeenCalled();
  });

  it('traces source, destination and outcome without logging the document path', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      await openWorkspaceSurface({ host: 'main-third', source: 'notebook-tree', target });
      expect(debug).toHaveBeenCalledWith('[workspace-navigation] Navigation requested', expect.objectContaining({
        source: 'notebook-tree', requestedHost: 'main-third', targetKind: 'external', navigationId: expect.any(Number),
      }));
      expect(debug).toHaveBeenCalledWith('[workspace-navigation] Navigation finished', expect.objectContaining({
        actualHost: 'main-third', status: 'opened',
      }));
      expect(JSON.stringify(debug.mock.calls)).not.toContain(target.path);
    } finally {
      debug.mockRestore();
    }
  });

});
