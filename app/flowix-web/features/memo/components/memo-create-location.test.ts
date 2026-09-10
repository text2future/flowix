import { describe, expect, it } from 'vitest';

import type { MemoDocumentSession } from '@features/document/store/document-store';
import { parentRelativePathForTreeCreate } from './memo-create-location';

function session(path: string, notebookId = 'work'): MemoDocumentSession {
  return {
    id: 'session', memoId: 'memo', path, notebookId,
    notebookPath: '/notes/work', openedAt: 0, transitionId: 0,
  };
}

describe('tree-view memo create location', () => {
  it('uses the selected note parent directory', () => {
    expect(parentRelativePathForTreeCreate(
      session('/notes/work/projects/alpha/note.md'), 'work', '/notes/work',
    )).toBe('projects/alpha');
  });

  it('falls back to notebook root for a root note or unrelated session', () => {
    expect(parentRelativePathForTreeCreate(
      session('/notes/work/note.md'), 'work', '/notes/work',
    )).toBeUndefined();
    expect(parentRelativePathForTreeCreate(
      session('/notes/other/note.md', 'other'), 'work', '/notes/work',
    )).toBeUndefined();
  });
});
