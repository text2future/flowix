import { beforeEach, describe, expect, it } from 'vitest';

import { useBrowserColumnStore } from '@features/workspace/store/browser-column-store';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { activateExistingWorkspaceContent } from './workspace-content-activation';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';

function resetWorkspace() {
  useWorkColumnStore.setState({
    navigation: {
      phase: 'idle',
      requestId: 0,
      target: { kind: 'empty' },
      pendingTarget: null,
      previousTarget: null,
      failure: null,
      retryToken: null,
    },
  });
}

function commitWorkColumnTarget(target: Parameters<ReturnType<typeof useWorkColumnStore.getState>['beginNavigation']>[0]) {
  const store = useWorkColumnStore.getState();
  const requestId = store.beginNavigation(target, null);
  store.commitNavigation(requestId, target);
}

describe('workspace content activation', () => {
  beforeEach(() => {
    resetWorkspace();
    useBrowserColumnStore.getState().reset();
  });

  it('focuses the third column when the memo is already its active target', () => {
    commitWorkColumnTarget({
      kind: 'memo',
      memoId: 'memo-a',
      path: '/notes/a.md',
      notebookId: 'notebook-a',
      notebookPath: '/notes',
      transitionId: 1,
    });
    useWorkspaceFocusStore.getState().focusHost('browser-column');

    expect(activateExistingWorkspaceContent({ kind: 'memo', memoId: 'memo-a' })).toEqual({
      host: 'main-third',
      state: 'active',
    });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('main-third');
  });

  it('reveals the browser column and activates its matching tab and host', () => {
    const browserColumn = useBrowserColumnStore.getState();
    browserColumn.openTab({
      id: 'memo:b',
      title: 'B',
      icon: null,
      target: {
        kind: 'memo',
        memoId: 'b',
        notebookId: 'notebook-a',
        notebookPath: '/notes',
        filePath: '/notes/b.md',
      },
    });
    browserColumn.openTab({
      id: 'memo:a',
      title: 'A',
      icon: null,
      target: {
        kind: 'memo',
        memoId: 'a',
        notebookId: 'notebook-a',
        notebookPath: '/notes',
        filePath: '/notes/a.md',
      },
    });
    browserColumn.commitTab('memo:b');
    browserColumn.setVisible(false);

    expect(activateExistingWorkspaceContent({ kind: 'memo', memoId: 'a' })).toEqual({
      host: 'browser-column',
      tabId: 'memo:a',
    });
    expect(useBrowserColumnStore.getState()).toMatchObject({
      visible: true,
      activeTabId: 'memo:a',
    });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('browser-column');
  });

  it('treats Markdown and text views of the same canonical path as one document', () => {
    useBrowserColumnStore.getState().openTab({
      id: 'file:/notes/a.md',
      title: 'A',
      icon: null,
      target: {
        kind: 'file-browser', folderPath: null, notebookId: null, fileTreeVisible: true, fileTreeWidth: 220, activeFilePath: '/notes\\a.md',
        scopePath: '/notes',
      },
    });

    expect(activateExistingWorkspaceContent({
      kind: 'external',
      path: '/notes/a.md',
    })).toEqual({
      host: 'browser-column',
      tabId: 'file:/notes/a.md',
    });
  });

  it('prefers the third column when legacy state contains the target twice', () => {
    commitWorkColumnTarget({ kind: 'agent-conversation', instanceId: 'agent-a' });
    useBrowserColumnStore.getState().openTab({
      id: 'agent:agent-a',
      title: 'Agent A',
      icon: null,
      target: { kind: 'agent_conversation', instanceId: 'agent-a' },
    });

    expect(activateExistingWorkspaceContent({
      kind: 'agent-conversation',
      instanceId: 'agent-a',
    })).toEqual({ host: 'main-third', state: 'active' });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('main-third');
  });

  it('treats a pending work-column open as existing content', () => {
    useWorkColumnStore.getState().beginNavigation({
      kind: 'memo',
      memoId: 'memo-pending',
      path: '/notes/pending.md',
      notebookId: 'notebook-a',
      notebookPath: '/notes',
      transitionId: null,
    }, null);

    expect(activateExistingWorkspaceContent({
      kind: 'memo',
      memoId: 'memo-pending',
    })).toEqual({ host: 'main-third', state: 'pending' });
    expect(useBrowserColumnStore.getState().tabs).toEqual([]);
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('main-third');
  });
});
