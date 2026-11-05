import { seedWorkColumn } from '@features/workspace/test-support/workspace-fixtures';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserColumnStore } from '../store/browser-column-store';
import { useWorkColumnStore } from '../store/work-column-store';
import { useWorkspaceFocusStore } from '../store/workspace-focus-store';
import { useWorkspaceSessionStore } from '../store/workspace-session-store';
import { openExternallyCreatedNote, openCreatedDocumentFromNotice } from './open-externally-created-note';
import { openWorkspaceSurface } from './surface-opening';

vi.mock('./surface-opening', () => ({ openWorkspaceSurface: vi.fn().mockResolvedValue({ status: 'opened' }) }));

const workTarget = { kind: 'external' as const, path: '/notes/Note.md', scopePath: '/notes', transitionId: null };

describe('external note creation notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceSessionStore.getState().reset();
    seedWorkColumn(useWorkColumnStore.getInitialState());
    useBrowserColumnStore.getState().reset();
    useWorkspaceFocusStore.getState().reset();
  });

  it('keeps Work focus and does not duplicate the document being edited', async () => {
    const work = useWorkColumnStore.getState();
    const requestId = work.beginNavigation(workTarget, null);
    work.commitNavigation(requestId, workTarget);
    await openExternallyCreatedNote('/notes/Note.md', '/notes', 'nb');
    expect(openWorkspaceSurface).not.toHaveBeenCalled();
    expect(useBrowserColumnStore.getState().current).toBeNull();
    expect(useWorkspaceFocusStore.getState().focusedColumnId).toBe('column-1');
  });

  it('does not steal focus for a document currently being opened in Work', async () => {
    useWorkColumnStore.getState().beginNavigation(workTarget, null);
    await openExternallyCreatedNote('/notes/Note.md', '/notes', 'nb');
    expect(openWorkspaceSurface).not.toHaveBeenCalled();
    expect(useWorkspaceFocusStore.getState().focusedColumnId).toBe('column-1');
  });

  it('treats a historical target as a new open rather than an already open background tab', async () => {
    const browser = useBrowserColumnStore.getState();
    for (const name of ['Note', 'Other']) {
      browser.openContent({ id: name, title: name, icon: null, target: {
        kind: 'file-browser', activeFilePath: `/notes/${name}.md`, notebookId: 'nb',
        folderPath: null, scopePath: '/notes', fileTreeVisible: false, fileTreeWidth: 220,
      } });
    }
    browser.setVisible(false);
    await openExternallyCreatedNote('/notes/Note.md', '/notes', 'nb');
    expect(openWorkspaceSurface).toHaveBeenCalledOnce();
    expect(useBrowserColumnStore.getState()).toMatchObject({ current: { id: 'Other' }, visible: true });
    expect(useWorkspaceFocusStore.getState().focusedColumnId).toBe('column-1');
  });

  it('opens a genuinely new document through the usual browser navigation', async () => {
    await openExternallyCreatedNote('/notes/New.md', '/notes', 'nb');
    expect(openWorkspaceSurface).toHaveBeenCalledExactlyOnceWith({
      host: 'column-2',
      target: { kind: 'external', path: '/notes/New.md', scopePath: '/notes', transitionId: null },
      options: { notebookId: 'nb' },
    });
  });

  it.each([openExternallyCreatedNote, openCreatedDocumentFromNotice])('opens notices in the right position after a swap (%#)', async (open) => {
    const store = useWorkspaceSessionStore.getState();
    store.commitTarget('column-2', { kind: 'web', url: 'https://left.example/' });
    store.swapColumnContents();
    const left = useWorkspaceSessionStore.getState().sessions['column-2'];
    await open('/notes/New.md', '/notes', 'nb');
    expect(openWorkspaceSurface).toHaveBeenCalledExactlyOnceWith({
      host: 'column-1',
      target: { kind: 'external', path: '/notes/New.md', scopePath: '/notes', transitionId: null },
      options: { notebookId: 'nb' },
    });
    expect(useWorkspaceSessionStore.getState().sessions['column-2']).toBe(left);
    expect(useWorkspaceSessionStore.getState().browserLayout.visible).toBe(true);
  });
});
