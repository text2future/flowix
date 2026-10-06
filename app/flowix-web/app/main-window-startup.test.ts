import { beforeEach, describe, expect, it, vi } from 'vitest';
import { boot } from '@platform/tauri/client';
import { useNoteStore } from '@features/memo/store/note-store';
import { useDocumentStore } from '@features/document/store/document-store';
import { waitForInitialDocumentLoad } from '@features/document/public/startup-api';

const mocks = vi.hoisted(() => ({
  initializeNoteLibrary: vi.fn(),
  captureWorkspaceRestoreTarget: vi.fn(),
  restoreExternalDocumentWorkspace: vi.fn(),
  restoreMediaWorkspace: vi.fn(),
  restoreTableWorkspace: vi.fn(),
  setWorkspaceRestoreStatus: vi.fn(),
  restoreAgentConversationWorkspace: vi.fn(),
  calls: [] as string[],
}));

vi.mock('@features/memo/public/app-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@features/memo/public/app-api')>()),
  initializeNotebookContext: mocks.initializeNoteLibrary,
}));
vi.mock('@features/workspace/public/startup-api', () => ({
  captureWorkspaceRestoreTarget: mocks.captureWorkspaceRestoreTarget,
  restoreExternalDocumentWorkspace: mocks.restoreExternalDocumentWorkspace,
  restoreMediaWorkspace: mocks.restoreMediaWorkspace,
  restoreTableWorkspace: mocks.restoreTableWorkspace,
  setWorkspaceRestoreStatus: mocks.setWorkspaceRestoreStatus,
  restoreAgentConversationWorkspace: mocks.restoreAgentConversationWorkspace,
}));

import { initializeMainWindowStartup } from './main-window-startup';

describe('initializeMainWindowStartup', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    useNoteStore.getState().setStartupPhase('idle');
    useDocumentStore.setState({ isDocumentTransitioning: false, documentTransitionId: 0 });
    mocks.calls.length = 0;
    mocks.initializeNoteLibrary.mockReset().mockImplementation(async () => {
      mocks.calls.push('memo-library');
    });
    mocks.captureWorkspaceRestoreTarget.mockReset().mockReturnValue(null);
    mocks.restoreExternalDocumentWorkspace.mockReset();
    mocks.restoreMediaWorkspace.mockReset();
    mocks.setWorkspaceRestoreStatus.mockReset();
    mocks.restoreAgentConversationWorkspace.mockReset().mockImplementation(async () => {
      mocks.calls.push('agent-workspace');
    });
  });

  it('runs startup stages in dependency order', async () => {
    await initializeMainWindowStartup();

    expect(mocks.calls).toEqual([
      'memo-library',
    ]);
  });

  it('stops dependent restoration when library initialization fails', async () => {
    mocks.initializeNoteLibrary.mockRejectedValueOnce(new Error('backend unavailable'));

    await expect(initializeMainWindowStartup()).rejects.toThrow('backend unavailable');
    expect(mocks.restoreExternalDocumentWorkspace).not.toHaveBeenCalled();
    expect(mocks.restoreAgentConversationWorkspace).not.toHaveBeenCalled();
  });

  it('shows a retryable error when the native notebook identity cannot be read', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(boot, 'waitForStartupReady').mockResolvedValue();
    vi.spyOn(boot, 'getStartupNotebookId').mockRejectedValue(new Error('notebook identity unavailable'));
    const notifyInteractive = vi.spyOn(boot, 'notifyStartupInteractive').mockResolvedValue();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    await expect(initializeMainWindowStartup()).rejects.toThrow('notebook identity unavailable');

    expect(mocks.initializeNoteLibrary).not.toHaveBeenCalled();
    expect(useNoteStore.getState().startupPhase).toBe('error');
    expect(notifyInteractive).toHaveBeenCalledOnce();
  });

  it('holds background maintenance until the restored document finishes loading', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(boot, 'waitForStartupReady').mockResolvedValue();
    vi.spyOn(boot, 'getStartupNotebookId').mockResolvedValue('notebook-a');
    vi.spyOn(boot, 'recordStartupStage').mockResolvedValue();
    const notifyInteractive = vi.spyOn(boot, 'notifyStartupInteractive').mockResolvedValue();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    mocks.captureWorkspaceRestoreTarget.mockReturnValue({ kind: 'external', path: '/notes/active.md', scopePath: '/notes' });
    mocks.restoreExternalDocumentWorkspace.mockImplementationOnce(async () => {
      useDocumentStore.setState({ isDocumentTransitioning: true, documentTransitionId: 1 });
    });

    const startup = initializeMainWindowStartup();
    await vi.waitFor(() => expect(useDocumentStore.getState().isDocumentTransitioning).toBe(true));
    expect(notifyInteractive).not.toHaveBeenCalled();

    useDocumentStore.getState().finishDocumentTransition(1);
    await startup;
    expect(notifyInteractive).toHaveBeenCalledOnce();
  });

  it('releases the initial document barrier if its load stalls', async () => {
    vi.useFakeTimers();
    try {
      useDocumentStore.setState({ isDocumentTransitioning: true, documentTransitionId: 1 });
      const wait = waitForInitialDocumentLoad(100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(wait).resolves.toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });
});
