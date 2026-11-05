import { describe, expect, it } from 'vitest';
import { middleColumnSelectionKey } from './memo-list-selection';
import type { NoteListItem } from '@/types/note-item';

const notebook = { id: 'nb-1', path: '/vault/notes' };

function note(relativePath: string, notebookId = 'nb-1'): NoteListItem {
  return {
    kind: 'path-note',
    notebookId,
    relativePath,
    filename: relativePath,
    title: relativePath,
    preview: '',
    thumbnail: null,
    tags: [],
    todos: [],
    agents: [],
    createdAt: 0,
    updatedAt: 0,
    favorited: false,
    icon: null,
    colors: [],
    properties: {},
  };
}

describe('middleColumnSelectionKey', () => {
  it('highlights the note shown in the middle column', () => {
    expect(middleColumnSelectionKey({
      middleColumnFilePath: '/vault/notes/folder/a.md',
      notebook,
      notes: [note('folder/a.md'), note('folder/b.md')],
    })).toBe('path:nb-1:folder/a.md');
  });

  it('ignores a document outside the visible notebook', () => {
    expect(middleColumnSelectionKey({
      middleColumnFilePath: '/vault/other/a.md',
      notebook,
      notes: [note('folder/a.md')],
    })).toBeUndefined();
  });

  it('keeps the row key shape when the note is not on the loaded page', () => {
    expect(middleColumnSelectionKey({
      middleColumnFilePath: '/vault/notes/folder/later.md',
      notebook,
      notes: [],
    })).toBe('path:nb-1:folder/later.md');
  });

  it('highlights nothing when the middle column holds no file', () => {
    expect(middleColumnSelectionKey({
      middleColumnFilePath: null,
      notebook,
      notes: [note('folder/a.md')],
    })).toBeUndefined();
  });
});
