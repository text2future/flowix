import { canSwapSessions } from '../model/column-swap';
import { getColumnSessionId, useWorkspaceSessionStore } from '../store/workspace-session-store';
import { seedMainColumn } from '@features/workspace/test-support/workspace-fixtures';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openMain: vi.fn(), openBrowser: vi.fn(),
  prepareDocumentLeave: vi.fn(),
  flushBrowser: vi.fn(),
  mainIdentity: null as { kind: 'external'; path: string } | null,
}));
vi.mock('./workspace-navigation', () => ({
  openExternalTarget: mocks.openMain,
  prepareActiveMainColumnDocumentLeave: mocks.prepareDocumentLeave,
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
  mainColumnTargetIdentity: () => mocks.mainIdentity,
  findWorkspaceContentLocations: () => ({ browserColumn: null }),
  findWorkspaceContentForNavigation: (identity: { kind: 'external'; path: string }) =>
    mocks.mainIdentity?.path === identity.path ? { host: 'column-1', state: 'active' } : null,
  browserColumnTargetIdentity: (target: { activeFilePath: string }) => ({ kind: 'external', path: target.activeFilePath }),
}));
vi.mock('@platform/tauri/client', () => ({ collections: {}, notebooks: {} }));

import { openWorkspaceSurface, openPreparedWorkspaceSurface } from './surface-opening';
import { NavigationCancelledError } from '@/lib/navigation-cancelled-error';

describe('public surface opening host contract', () => {
  const target = { kind: 'external' as const, path: '/notes/a.md', scopePath: '/notes' };
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceSessionStore.getState().reset();
    seedMainColumn({ navigation: {
      phase: 'idle', requestId: 0, target: { kind: 'empty' }, pendingTarget: null,
      previousTarget: null, showMainColumnLoading: false, failure: null, retryToken: null,
    } });
    mocks.prepareDocumentLeave.mockResolvedValue(undefined);
    mocks.flushBrowser.mockReset().mockResolvedValue(true);
    mocks.mainIdentity = null;
    mocks.openMain.mockImplementation(async (path: string) => { mocks.mainIdentity = { kind: 'external', path }; });
    mocks.openBrowser.mockResolvedValue({ host: 'column-2', surfaceId: 'a', alreadyOpen: true });
  });

  it('keeps an explicit main-column request in the main column', async () => {
    await expect(openWorkspaceSurface({ host: 'column-1', target })).resolves.toEqual({
      status: 'opened', host: 'column-1', location: { host: 'column-1', state: 'active' },
    });
    expect(mocks.openMain).toHaveBeenCalledWith(target.path, expect.objectContaining({ destination: 'column-1' }));
    expect(mocks.openBrowser).not.toHaveBeenCalled();
  });

  it('normalizes a refused Work document leave as cancellation', async () => {
    mocks.openMain.mockRejectedValueOnce(new NavigationCancelledError('saving could not be retained'));
    await expect(openWorkspaceSurface({ host: 'column-1', target })).resolves.toEqual({
      status: 'cancelled', host: 'column-1', reason: 'navigation-cancelled',
    });
  });

  it('normalizes a refused main-column leave before opening the browser column as cancellation', async () => {
    mocks.mainIdentity = { kind: 'external', path: target.path };
    mocks.prepareDocumentLeave.mockRejectedValueOnce(new NavigationCancelledError('saving could not be retained'));
    await expect(openWorkspaceSurface({ host: 'column-2', target })).resolves.toEqual({
      status: 'cancelled', host: 'column-2', reason: 'navigation-cancelled',
    });
    expect(mocks.openBrowser).not.toHaveBeenCalled();
  });

  it('keeps explicit Browser opens in Browser and forwards notebook context', async () => {
    await expect(openWorkspaceSurface({ host: 'column-2', target, options: { notebookId: 'book' } }))
      .resolves.toEqual({ status: 'activated', host: 'column-2', location: { host: 'column-2', surfaceId: 'a' } });
    // Notebook ownership is in the target; navigation policy is passed separately.
    expect(mocks.openBrowser).toHaveBeenCalledWith(expect.objectContaining({ notebookId: 'book', activeFilePath: target.path }), { notebookId: 'book' }, expect.any(Function));
    expect(mocks.openMain).not.toHaveBeenCalled();
  });

  it('forwards a created note reveal policy with its document navigation', async () => {
    await openWorkspaceSurface({ host: 'column-1', target: { ...target, treeReveal: 'created-note' } });
    expect(mocks.openMain).toHaveBeenCalledWith(target.path, expect.objectContaining({
      treeReveal: 'created-note',
    }));
  });

  it('publishes main-column changes before opening a second view of the same content', async () => {
    mocks.mainIdentity = { kind: 'external', path: target.path };
    await openWorkspaceSurface({ host: 'column-2', target });
    expect(mocks.prepareDocumentLeave).toHaveBeenCalledOnce();
    expect(mocks.prepareDocumentLeave.mock.invocationCallOrder[0]).toBeLessThan(mocks.openBrowser.mock.invocationCallOrder[0]);
  });

  it('preserves a cancelled Browser navigation result', async () => {
    mocks.openBrowser.mockResolvedValue(null);
    await expect(openWorkspaceSurface({ host: 'column-2', target })).resolves.toEqual({
      status: 'cancelled', host: 'column-2', reason: 'navigation-cancelled',
    });
    expect(mocks.openMain).not.toHaveBeenCalled();
  });

  it('reports a main-column navigation superseded before its target becomes active as cancelled', async () => {
    mocks.openMain.mockImplementation(async () => undefined);
    await expect(openWorkspaceSurface({ host: 'column-1', target })).resolves.toEqual({
      status: 'cancelled', host: 'column-1', reason: 'navigation-cancelled',
    });
  });
  it('keeps a pending open bound to its column if placement changes', async () => {
    const store = useWorkspaceSessionStore.getState();
    const owner = getColumnSessionId('column-1');
    let finish!: (saved: boolean) => void;
    mocks.flushBrowser.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const pending = openWorkspaceSurface({ host: 'column-1', target });
    const revision = useWorkspaceSessionStore.getState().sessions[owner].navigation.transaction.requestId;
    store.updateSession('column-2', (session) => ({ ...session, navigation: { ...session.navigation,
      transaction: { ...session.navigation.transaction, requestId: revision },
    } }));
    store.swapColumnContents(); // Bypass the UI guard to exercise the defensive boundary.
    finish(true);
    await expect(pending).resolves.toMatchObject({ status: 'opened', host: owner });
    expect(mocks.openMain).toHaveBeenCalledOnce();
    expect(mocks.openMain).toHaveBeenCalledWith(target.path, expect.objectContaining({ destination: owner }));
  });

  it('keeps exchange unavailable for the whole delayed save and releases preparation on refusal', async () => {
    let finish!: (saved: boolean) => void;
    mocks.flushBrowser.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const pending = openWorkspaceSurface({ host: 'column-1', target });
    expect(canSwapSessions(useWorkspaceSessionStore.getState().sessions)).toBe(false);
    finish(false);
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
    expect(canSwapSessions(useWorkspaceSessionStore.getState().sessions)).toBe(true);
    expect(mocks.openMain).not.toHaveBeenCalled();
  });

  it('does not let an older save barrier override a later main-column click', async () => {
    let finishFirst!: (saved: boolean) => void;
    mocks.flushBrowser.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishFirst = resolve; }));
    const first = openWorkspaceSurface({ host: 'column-1', target });
    const secondTarget = { ...target, path: '/notes/b.md' };
    await expect(openWorkspaceSurface({ host: 'column-1', target: secondTarget })).resolves.toMatchObject({ status: 'opened' });
    finishFirst(true);
    await expect(first).resolves.toMatchObject({ status: 'cancelled', host: 'column-1' });
    expect(mocks.openMain).toHaveBeenCalledTimes(1);
    expect(mocks.openMain).toHaveBeenCalledWith(secondTarget.path, expect.anything());
  });

  it('keeps a main-column request cancelled when the browser-column save barrier refuses', async () => {
    mocks.flushBrowser.mockResolvedValueOnce(false);
    await expect(openWorkspaceSurface({ host: 'column-1', target })).resolves.toMatchObject({ status: 'cancelled', host: 'column-1' });
    expect(mocks.openMain).not.toHaveBeenCalled();
    expect(mocks.openBrowser).not.toHaveBeenCalled();
  });

  it('traces source, destination and outcome without logging the document path', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      await openWorkspaceSurface({ host: 'column-1', source: 'notebook-tree', target });
      expect(debug).toHaveBeenCalledWith('[workspace-navigation] Navigation requested', expect.objectContaining({
        source: 'notebook-tree', requestedHost: 'column-1', targetKind: 'external', navigationId: expect.any(Number),
      }));
      expect(debug).toHaveBeenCalledWith('[workspace-navigation] Navigation finished', expect.objectContaining({
        actualHost: 'column-1', status: 'opened',
      }));
      expect(JSON.stringify(debug.mock.calls)).not.toContain(target.path);
    } finally {
      debug.mockRestore();
    }
  });

  it('cancels slow target resolution when a later navigation has opened', async () => {
    let finish!: (value: { target: typeof target }) => void;
    const first = openPreparedWorkspaceSurface({ host: 'column-1', target },
      () => new Promise((resolve) => { finish = resolve; }));
    expect(canSwapSessions(useWorkspaceSessionStore.getState().sessions)).toBe(false);
    const next = { ...target, path: '/notes/newer.md' };
    await openWorkspaceSurface({ host: 'column-1', target: next });
    finish({ target });
    await expect(first).resolves.toMatchObject({ status: 'cancelled' });
    expect(mocks.openMain).toHaveBeenCalledTimes(1);
    expect(mocks.openMain).toHaveBeenCalledWith(next.path, expect.anything());
  });

  it('keeps a later browser preparation current when an earlier queued open finishes', async () => {
    let finishFirst!: () => void;
    let finishSecond!: (value: { target: typeof target }) => void;
    mocks.openBrowser.mockImplementationOnce(async (_target, _options, isCurrent: () => boolean) => {
      await new Promise<void>((resolve) => { finishFirst = resolve; });
      if (!isCurrent()) return null;
      useWorkspaceSessionStore.getState().commitTarget(getColumnSessionId('column-2'), { kind: 'web', url: 'https://old.example' });
      return { host: 'column-2', surfaceId: 'old', alreadyOpen: false };
    });
    const first = openWorkspaceSurface({ host: 'column-2', target });
    await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
    const next = { ...target, path: '/notes/newer.md' };
    const second = openPreparedWorkspaceSurface({ host: 'column-2', target: next },
      () => new Promise((resolve) => { finishSecond = resolve; }));
    finishFirst();
    await expect(first).resolves.toMatchObject({ status: 'cancelled' });
    finishSecond({ target: next });
    await expect(second).resolves.toMatchObject({ status: 'activated' });
    expect(mocks.openBrowser).toHaveBeenLastCalledWith(expect.objectContaining({ activeFilePath: next.path }), undefined, expect.any(Function));
  });

  it('releases the preparation intent when target resolution fails', async () => {
    await expect(openPreparedWorkspaceSurface({ host: 'column-1', target }, async () => {
      throw new Error('resolution failed');
    })).rejects.toThrow('resolution failed');
    expect(canSwapSessions(useWorkspaceSessionStore.getState().sessions)).toBe(true);
    expect(mocks.openMain).not.toHaveBeenCalled();
  });

});
