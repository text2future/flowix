import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  findId: vi.fn((path: string) => `id:${path}`),
  setSelectedNote: vi.fn(),
  documentPath: '/notes/drafts/a.md',
  selected: { notebookId: 'book', relativePath: 'drafts/a.md' } as { notebookId: string; relativePath: string } | null,
  tabs: [] as Array<{ target: { kind: string; activeFilePath: string | null } }>,
}));

vi.mock('@/lib/file-display-registry', () => ({ findFileDisplayId: mocks.findId }));
vi.mock('@features/document/public/workspace-api', () => ({
  getWorkspaceDocumentState: () => ({ activeExternalSession: { fileIdentity: { path: mocks.documentPath } } }),
}));
vi.mock('@features/memo/public/workspace-api', () => ({
  getWorkspaceMemoState: () => ({ selectedNote: mocks.selected, setSelectedNote: mocks.setSelectedNote }),
}));
vi.mock('../store/browser-column-store', () => ({
  useBrowserColumnStore: { getState: () => ({ tabs: mocks.tabs }) },
}));
vi.mock('../store/work-column-store', () => ({
  useWorkColumnStore: { getState: () => ({ navigation: { target: { kind: 'external', path: mocks.documentPath }, pendingTarget: null, previousTarget: null } }) },
}));
vi.mock('../store/workspace-restore-store', () => ({
  useWorkspaceRestoreStore: { getState: () => ({ desiredTarget: null }) },
}));
vi.mock('./workspace-navigation', () => ({ replaceExternalDocumentPath: mocks.replace }));

import { applyNotebookPathMove } from './notebook-path-move';

describe('confirmed notebook path moves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.documentPath = '/notes/drafts/a.md';
    mocks.selected = { notebookId: 'book', relativePath: 'drafts/a.md' };
    mocks.tabs = [];
  });

  it('rebinds the open document and selected note for a file move', () => {
    applyNotebookPathMove({ notebookId: 'book', notebookPath: '/notes', previousRelativePath: 'drafts/a.md', relativePath: 'done/a.md', directory: false });
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith('id:/notes/drafts/a.md', '/notes/drafts/a.md', '/notes/done/a.md');
    expect(mocks.setSelectedNote).toHaveBeenCalledWith({ notebookId: 'book', relativePath: 'done/a.md' });
  });

  it('rebases every open descendant of a moved folder without touching a similarly named folder', () => {
    mocks.tabs = [
      { target: { kind: 'file-browser', activeFilePath: '/notes/drafts/sub/b.md' } },
      { target: { kind: 'file-browser', activeFilePath: '/notes/drafts-old/c.md' } },
    ];
    applyNotebookPathMove({ notebookId: 'book', notebookPath: '/notes', previousRelativePath: 'drafts', relativePath: 'archive', directory: true });
    expect(mocks.replace).toHaveBeenCalledTimes(2);
    expect(mocks.replace).toHaveBeenCalledWith('id:/notes/drafts/a.md', '/notes/drafts/a.md', '/notes/archive/a.md');
    expect(mocks.replace).toHaveBeenCalledWith('id:/notes/drafts/sub/b.md', '/notes/drafts/sub/b.md', '/notes/archive/sub/b.md');
    expect(mocks.setSelectedNote).toHaveBeenCalledWith({ notebookId: 'book', relativePath: 'archive/a.md' });
  });
});
