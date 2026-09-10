import { describe, expect, it } from 'vitest';

import type { DocTreeItem } from '@platform/tauri/client';
import { isNotebookTreeItemVisible, sortNotebookTreeItems } from './notebook-folder-view';

function item(name: string, type: DocTreeItem['type']): DocTreeItem {
  return {
    id: name,
    fullPath: `/notebook/${name}`,
    name,
    type,
    parentId: null,
    children: type === 'folder' ? [] : null,
    sizeBytes: null,
    modifiedMs: null,
    createdMs: null,
  };
}

describe('notebook folder view filtering', () => {
  it('keeps folders and Markdown notes while hiding other files', () => {
    expect(isNotebookTreeItemVisible(item('projects', 'folder'))).toBe(true);
    expect(isNotebookTreeItemVisible(item('note.md', 'document'))).toBe(true);
    expect(isNotebookTreeItemVisible(item('note.MARKDOWN', 'document'))).toBe(true);
    expect(isNotebookTreeItemVisible(item('image.png', 'document'))).toBe(false);
  });

  it('hides attachment directories case-insensitively', () => {
    expect(isNotebookTreeItemVisible(item('attachment', 'folder'))).toBe(false);
    expect(isNotebookTreeItemVisible(item('attachments', 'folder'))).toBe(false);
    expect(isNotebookTreeItemVisible(item('ATTACHMENT', 'folder'))).toBe(false);
    expect(isNotebookTreeItemVisible(item('attachment.md', 'document'))).toBe(true);
  });
});

describe('notebook folder sorting', () => {
  it('keeps folders first and sorts notes by the selected timestamp descending', () => {
    const folder = item('projects', 'folder');
    const older = { ...item('older.md', 'document'), createdMs: 10, modifiedMs: 30 };
    const newer = { ...item('newer.md', 'document'), createdMs: 20, modifiedMs: 15 };

    expect(sortNotebookTreeItems([older, newer, folder], 'createdAt').map((entry) => entry.name))
      .toEqual(['projects', 'newer.md', 'older.md']);
    expect(sortNotebookTreeItems([older, newer, folder], 'updatedAt').map((entry) => entry.name))
      .toEqual(['projects', 'older.md', 'newer.md']);
  });
});
