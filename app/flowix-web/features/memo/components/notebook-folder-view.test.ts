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
    memoCreatedMs: null,
  };
}

describe('notebook folder view filtering', () => {
  it('shows folders, notes, media, and other file types', () => {
    expect(isNotebookTreeItemVisible(item('projects', 'folder'))).toBe(true);
    expect(isNotebookTreeItemVisible(item('note.md', 'document'))).toBe(true);
    expect(isNotebookTreeItemVisible(item('note.MARKDOWN', 'document'))).toBe(true);
    expect(isNotebookTreeItemVisible(item('image.png', 'document'))).toBe(true);
    expect(isNotebookTreeItemVisible(item('video.mp4', 'document'))).toBe(true);
    expect(isNotebookTreeItemVisible(item('archive.zip', 'document'))).toBe(true);
    expect(isNotebookTreeItemVisible(item('main.ts', 'document'))).toBe(true);
  });

  it('hides attachment directories case-insensitively', () => {
    expect(isNotebookTreeItemVisible(item('attachment', 'folder'))).toBe(false);
    expect(isNotebookTreeItemVisible(item('attachments', 'folder'))).toBe(false);
    expect(isNotebookTreeItemVisible(item('ATTACHMENT', 'folder'))).toBe(false);
    expect(isNotebookTreeItemVisible(item('attachment.md', 'document'))).toBe(true);
    expect(isNotebookTreeItemVisible(item('AGENTS.md', 'document'))).toBe(false);
  });

  it('hides hidden directories and their Markdown descendants by default', () => {
    expect(isNotebookTreeItemVisible({ ...item('.codex', 'folder'), fullPath: '/notebook/.codex' }, '/notebook')).toBe(false);
    expect(isNotebookTreeItemVisible({ ...item('SKILL.md', 'document'), fullPath: '/notebook/.codex/skills/SKILL.md' }, '/notebook')).toBe(false);
    expect(isNotebookTreeItemVisible({ ...item('SKILL.md', 'document'), fullPath: '/notebook/.codex/skills/SKILL.md' }, '/notebook', true)).toBe(true);
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

  it('sorts notes by filename in either direction', () => {
    const folder = item('projects', 'folder');
    const alpha = item('alpha.md', 'document');
    const zulu = item('Zulu.md', 'document');

    expect(sortNotebookTreeItems([zulu, alpha, folder], 'filenameAsc').map((entry) => entry.name))
      .toEqual(['projects', 'alpha.md', 'Zulu.md']);
    expect(sortNotebookTreeItems([zulu, alpha, folder], 'filenameDesc').map((entry) => entry.name))
      .toEqual(['projects', 'Zulu.md', 'alpha.md']);
  });

  it('uses the indexed memo creation time when the file was atomically replaced', () => {
    const replacedOlder = {
      ...item('older.md', 'document'),
      createdMs: 100,
      memoCreatedMs: 10,
    };
    const genuinelyNewer = {
      ...item('newer.md', 'document'),
      createdMs: 20,
      memoCreatedMs: 20,
    };

    expect(sortNotebookTreeItems([replacedOlder, genuinelyNewer], 'createdAt').map((entry) => entry.name))
      .toEqual(['newer.md', 'older.md']);
  });
});
