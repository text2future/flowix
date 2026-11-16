import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notebook } from '@features/memo/store/note-store';

const mocks = vi.hoisted(() => ({
  openSurfaceAtPosition: vi.fn(),
}));

vi.mock('@features/workspace/public/open-surface-api', () => ({
  openSurfaceAtPosition: mocks.openSurfaceAtPosition,
}));

import { openNotebookNote } from './open-notebook-note';

const notebook = { id: 'book-1', path: '/notes' } as Notebook;

describe('openNotebookNote', () => {
  beforeEach(() => {
    mocks.openSurfaceAtPosition.mockResolvedValue({
      status: 'opened', location: { host: 'column-1', state: 'active' },
    });
  });

  it('submits creation positioning with the same target as the new note', async () => {
    await openNotebookNote('/notes/new.md', notebook, { treeReveal: 'created-note' });
    expect(mocks.openSurfaceAtPosition).toHaveBeenLastCalledWith(expect.objectContaining({
      target: {
        kind: 'external', path: '/notes/new.md', scopePath: '/notes',
        transitionId: null, treeReveal: 'created-note',
      },
    }));
  });

  it('opens ordinary Markdown by path without requiring a memo ID', async () => {
    mocks.openSurfaceAtPosition.mockClear();
    await openNotebookNote('/notes/a.md', notebook);
    expect(mocks.openSurfaceAtPosition).toHaveBeenCalledWith({
      index: 0,
      target: { kind: 'external', path: '/notes/a.md', scopePath: '/notes', transitionId: null },
      options: { history: undefined, initialFocus: undefined },
    });
  });

  it('opens plugin Markdown through the path document surface', async () => {
    mocks.openSurfaceAtPosition.mockClear();
    await openNotebookNote('/notes/map.md', notebook);
    expect(mocks.openSurfaceAtPosition).toHaveBeenCalledWith(expect.objectContaining({
      index: 0,
      target: { kind: 'external', path: '/notes/map.md', scopePath: '/notes', transitionId: null },
    }));
  });
});
