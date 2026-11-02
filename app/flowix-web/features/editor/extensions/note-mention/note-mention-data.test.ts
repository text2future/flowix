import { beforeEach, describe, expect, it, vi } from 'vitest';

const listSummaries = vi.fn();

vi.mock('@platform/tauri/client', () => ({
  notes: {
    listSummaries: (notebookId: string) => listSummaries(notebookId),
  },
}));

vi.mock('@features/memo/store/note-store', () => ({
  useNoteStore: {
    getState: () => ({
      notebooksInitialized: true,
      notebooks: [
        { id: 'nb-a', name: 'A', path: '/a' },
        { id: 'nb-b', name: 'B', path: '/b' },
      ],
    }),
  },
}));

import { invalidateMentionNotes, queryMentionNotes } from './note-mention-data';

describe('queryMentionNotes', () => {
  beforeEach(() => {
    listSummaries.mockReset();
    invalidateMentionNotes();
    listSummaries.mockImplementation(async (notebookId: string) => {
      if (notebookId === 'nb-a') {
        return [{ relativePath: '会议记录.md', title: '会议记录', updatedAt: 20 }];
      }
      return [{ relativePath: '日记.md', title: '日记', updatedAt: 10 }];
    });
  });

  it('reads each notebook once no matter how many queries are typed', async () => {
    const first = await queryMentionNotes('会');
    const second = await queryMentionNotes('日');

    expect(listSummaries).toHaveBeenCalledTimes(2);
    expect(first.map((item) => item.title)).toEqual(['会议记录']);
    expect(second.map((item) => item.title)).toEqual(['日记']);
  });

  it('returns every note newest first when the query is empty', async () => {
    const items = await queryMentionNotes('');

    expect(items.map((item) => item.title)).toEqual(['会议记录', '日记']);
  });

  it('refetches after the notebook cache is invalidated', async () => {
    await queryMentionNotes('会');
    invalidateMentionNotes();
    await queryMentionNotes('会');

    expect(listSummaries).toHaveBeenCalledTimes(4);
  });

  it('keeps the notebook metadata on every item', async () => {
    const items = await queryMentionNotes('日记');

    expect(items[0]).toMatchObject({
      filename: '日记.md',
      notebookId: 'nb-b',
      notebookName: 'B',
      notebookPath: '/b',
      originalPath: null,
    });
  });
});
