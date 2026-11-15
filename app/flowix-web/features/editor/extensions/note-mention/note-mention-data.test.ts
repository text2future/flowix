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

  it('reads only the requested notebook once no matter how many queries are typed', async () => {
    const first = await queryMentionNotes('会', 'nb-a');
    const second = await queryMentionNotes('记录', 'nb-a');

    expect(listSummaries).toHaveBeenCalledTimes(1);
    expect(listSummaries).toHaveBeenCalledWith('nb-a');
    expect(first.map((item) => item.title)).toEqual(['会议记录']);
    expect(second.map((item) => item.title)).toEqual(['会议记录']);
  });

  it('returns the requested notebook notes newest first when the query is empty', async () => {
    const items = await queryMentionNotes('', 'nb-a');

    expect(items.map((item) => item.title)).toEqual(['会议记录']);
  });

  it('refetches after the notebook cache is invalidated', async () => {
    await queryMentionNotes('会', 'nb-a');
    invalidateMentionNotes('nb-a');
    await queryMentionNotes('会', 'nb-a');

    expect(listSummaries).toHaveBeenCalledTimes(2);
  });

  it('keeps the notebook metadata on every item', async () => {
    const items = await queryMentionNotes('日记', 'nb-b');

    expect(items[0]).toMatchObject({
      filename: '日记.md',
      notebookId: 'nb-b',
      notebookName: 'B',
      notebookPath: '/b',
      originalPath: null,
    });
  });
});
