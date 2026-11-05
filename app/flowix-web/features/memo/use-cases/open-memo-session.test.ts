import { describe, expect, it, vi } from 'vitest';
import type { Notebook } from '@features/memo/store/note-store';

const openNotebookNote = vi.hoisted(() => vi.fn().mockResolvedValue({ host: 'column-1' }));
vi.mock('./open-notebook-note', () => ({ openNotebookNote }));

import { openPathNoteSession } from './open-memo-session';

const notebook = { id: 'notes', path: '/notes', name: 'Notes' } as Notebook;

describe('path note opening', () => {
  it('opens a current list item by notebook and relative path', async () => {
    openNotebookNote.mockClear();
    await openPathNoteSession({
      notebookId: 'notes', relativePath: 'Folder/Note.md', properties: {},
    } as Parameters<typeof openPathNoteSession>[0], notebook);
    expect(openNotebookNote).toHaveBeenCalledWith('/notes/Folder/Note.md', notebook,
      expect.objectContaining({ mayBePlugin: false }));
  });
});
