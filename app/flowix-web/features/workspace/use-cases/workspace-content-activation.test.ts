import { seedWorkColumn } from '@features/workspace/test-support/workspace-fixtures';
import { beforeEach, describe, expect, it } from 'vitest';

import { useBrowserColumnStore } from '@features/workspace/store/browser-column-store';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { activateExistingWorkspaceContent } from './workspace-content-activation';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';

function resetWorkspace() {
  seedWorkColumn({
    navigation: {
      phase: 'idle',
      showWorkColumnLoading: false,
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
      kind: 'external',
      path: '/notes/a.md',
      scopePath: '/notes',
      transitionId: 1,
    });
    useWorkspaceFocusStore.getState().focusColumn('column-2');

    expect(activateExistingWorkspaceContent({ kind: 'external', path: '/notes/a.md' })).toEqual({
      host: 'column-1',
      state: 'active',
    });
    expect(useWorkspaceFocusStore.getState().focusedColumnId).toBe('column-1');
  });

  it('reveals the browser column and activates its matching tab and host', () => {
    const browserColumn = useBrowserColumnStore.getState();
    browserColumn.openContent({
      id: 'memo:b',
      title: 'B',
      icon: null,
      target: {
        kind: 'file-browser',
        notebookId: 'notebook-a',
        folderPath: '/notes', scopePath: '/notes', fileTreeVisible: true, fileTreeWidth: 220,
        activeFilePath: '/notes/b.md',
      },
    });
    browserColumn.openContent({
      id: 'memo:a',
      title: 'A',
      icon: null,
      target: {
        kind: 'file-browser',
        notebookId: 'notebook-a',
        folderPath: '/notes', scopePath: '/notes', fileTreeVisible: true, fileTreeWidth: 220,
        activeFilePath: '/notes/a.md',
      },
    });
    browserColumn.focusContent('memo:b');
    browserColumn.setVisible(false);

    expect(activateExistingWorkspaceContent({ kind: 'external', path: '/notes/a.md' })).toEqual({
      host: 'column-2',
      surfaceId: 'memo:a',
    });
    expect(useBrowserColumnStore.getState()).toMatchObject({
      visible: true,
    });
    expect(useWorkspaceFocusStore.getState().focusedColumnId).toBe('column-2');
  });

  it('treats Markdown and text views of the same canonical path as one document', () => {
    useBrowserColumnStore.getState().openContent({
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
      host: 'column-2',
      surfaceId: 'file:/notes/a.md',
    });
  });

  it('prefers the third column when legacy state contains the target twice', () => {
    commitWorkColumnTarget({ kind: 'agent-conversation', instanceId: 'agent-a' });
    useBrowserColumnStore.getState().openContent({
      id: 'agent:agent-a',
      title: 'Agent A',
      icon: null,
      target: { kind: 'agent_conversation', instanceId: 'agent-a' },
    });

    expect(activateExistingWorkspaceContent({
      kind: 'agent-conversation',
      instanceId: 'agent-a',
    })).toEqual({ host: 'column-1', state: 'active' });
    expect(useWorkspaceFocusStore.getState().focusedColumnId).toBe('column-1');
  });

  it('treats a pending work-column open as existing content', () => {
    useWorkColumnStore.getState().beginNavigation({
      kind: 'external',
      path: '/notes/pending.md',
      scopePath: '/notes',
      transitionId: null,
    }, null);

    expect(activateExistingWorkspaceContent({
      kind: 'external',
      path: '/notes/pending.md',
    })).toEqual({ host: 'column-1', state: 'pending' });
    expect(useBrowserColumnStore.getState().current).toBeNull();
    expect(useWorkspaceFocusStore.getState().focusedColumnId).toBe('column-1');
  });
});
