import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PinnedEntry, PinnedEntryPage } from '@platform/tauri/client/pinned';
import type { NotebookChange } from '@platform/tauri/notebook-change-events';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  ready: null as null | (() => void),
  notify: null as null | ((change: NotebookChange) => void),
  pinnedChanged: null as null | ((payload: { notebookId: string }) => void),
}));

vi.mock('@platform/tauri/client/pinned', () => ({
  pinnedEntries: { list: mocks.list },
  listenToPinnedChanges: (handler: (payload: { notebookId: string }) => void) => {
    mocks.pinnedChanged = handler;
    return Promise.resolve(() => { mocks.pinnedChanged = null; });
  },
}));
vi.mock('@features/memo/services/note-repository', () => ({
  noteRepository: { listByPath: vi.fn(), getIndexed: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@/lib/memo-dispatcher', () => ({ registerMemoEventHandler: () => () => {} }));
vi.mock('@platform/tauri/notebook-change-events', () => ({
  subscribeNotebookChanges: (
    handler: (change: NotebookChange) => void,
    options: { onListenerReady: () => void },
  ) => {
    mocks.notify = handler;
    mocks.ready = options.onListenerReady;
    return () => { mocks.notify = null; };
  },
}));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));

import { useNotebookPinnedNotes } from './use-notebook-pinned-notes';
import { noteMetadata } from '../services/note-metadata-service';

function noteEntry(relativePath: string, createdAt = 1): PinnedEntry {
  return {
    entryKind: 'note',
    relativePath,
    title: relativePath,
    createdAt,
    modifiedMs: createdAt + 1,
    kind: 'note',
    collectionId: null,
    sizeBytes: 0,
  };
}

function documentEntry(relativePath: string, createdAt = 1): PinnedEntry {
  return {
    entryKind: 'document',
    relativePath,
    title: '',
    createdAt,
    modifiedMs: createdAt + 1,
    kind: 'web',
    collectionId: null,
    sizeBytes: 12,
  };
}

function collectionEntry(relativePath: string, createdAt = 1): PinnedEntry {
  return {
    entryKind: 'collection',
    relativePath,
    title: '客户反馈',
    createdAt,
    modifiedMs: createdAt + 1,
    kind: 'table',
    collectionId: 'col_1',
    sizeBytes: 0,
  };
}

function page(entries: PinnedEntry[], overrides: Partial<PinnedEntryPage> = {}): PinnedEntryPage {
  return { entries, nextCursor: null, hasMore: false, ...overrides };
}

let root: Root;
let latest: ReturnType<typeof useNotebookPinnedNotes> | null;

function Harness() {
  latest = useNotebookPinnedNotes({
    notebookId: 'nb-1', notebookPath: '/notes/nb-1', isActive: true, refreshTrigger: 0,
  });
  return null;
}

function data() {
  if (!latest) throw new Error('Harness is not mounted');
  return latest;
}

describe('notebook pinned entries', () => {
  beforeEach(() => {
    noteMetadata.clear();
    latest = null;
    mocks.list.mockReset();
    mocks.pinnedChanged = null;
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  it('loads one page at a time and keeps earlier pages reachable', async () => {
    mocks.list
      .mockResolvedValueOnce(page([noteEntry('first.md')], { nextCursor: 'page-2', hasMore: true }))
      .mockResolvedValueOnce(page([noteEntry('second.md')]));

    await act(async () => root.render(createElement(Harness)));
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(data().pinnedItems.map((item) => item.name)).toEqual(['first.md']);
    expect(data().hasMore).toBe(true);

    await act(async () => data().loadMore());
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.list).toHaveBeenLastCalledWith('nb-1', 'page-2', 100);
    expect(data().pinnedItems.map((item) => item.name)).toEqual(['second.md']);
    expect(data().hasMore).toBe(false);
    expect(data().hasPrevious).toBe(true);

    await act(async () => data().loadPrevious());
    expect(data().pinnedItems.map((item) => item.name)).toEqual(['first.md']);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('renders notes, documents, and collections in backend order', async () => {
    mocks.list.mockResolvedValueOnce(page([
      collectionEntry('views/feedback.table.yaml', 30),
      documentEntry('docs/spec.html', 20),
      noteEntry('notes/plan.md', 10),
    ]));
    await act(async () => root.render(createElement(Harness)));

    const items = data().pinnedItems;
    expect(items.map((item) => item.fullPath)).toEqual([
      '/notes/nb-1/views/feedback.table.yaml',
      '/notes/nb-1/docs/spec.html',
      '/notes/nb-1/notes/plan.md',
    ]);
    expect(items.map((item) => item.pinnedEntryKind)).toEqual(['collection', 'document', 'note']);
    expect(items[0].name).toBe('客户反馈');
    expect(items[0].pinnedCollectionType).toBe('table');
    expect(items[0].pinnedCollectionId).toBe('col_1');
    // Documents and collections share the creation timestamp the backend sorted by.
    expect(items[1].memoCreatedMs).toBe(20);
    expect(items[2].memoCreatedMs).toBe(10);
  });

  it('refreshes when a document or collection pin changes', async () => {
    mocks.list
      .mockResolvedValueOnce(page([noteEntry('a.md')]))
      .mockResolvedValueOnce(page([noteEntry('a.md'), documentEntry('b.html', 5)]));
    await act(async () => root.render(createElement(Harness)));
    expect(data().pinnedItems).toHaveLength(1);

    await act(async () => mocks.pinnedChanged?.({ notebookId: 'nb-1' }));
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(data().pinnedItems).toHaveLength(2);
  });

  it('ignores pin events from other notebooks', async () => {
    mocks.list.mockResolvedValue(page([noteEntry('pinned.md')]));
    await act(async () => root.render(createElement(Harness)));
    await act(async () => mocks.pinnedChanged?.({ notebookId: 'other' }));
    expect(mocks.list).toHaveBeenCalledOnce();
  });

  it('reconciles the current page on listener recovery', async () => {
    mocks.list
      .mockResolvedValueOnce(page([noteEntry('old.md')]))
      .mockResolvedValueOnce(page([noteEntry('new.md')]));
    await act(async () => root.render(createElement(Harness)));
    expect(data().pinnedItems[0].name).toBe('old.md');
    await act(async () => mocks.ready?.());
    expect(data().pinnedItems[0].name).toBe('new.md');
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('collapses a burst of pin events into one trailing read', async () => {
    let resolveFirst!: (value: PinnedEntryPage) => void;
    mocks.list
      .mockReturnValueOnce(new Promise<PinnedEntryPage>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(page([noteEntry('a.md')]))
      .mockResolvedValueOnce(page([noteEntry('a.md'), documentEntry('b.html', 5)]));
    vi.useFakeTimers();
    try {
      await act(async () => root.render(createElement(Harness)));
      expect(mocks.list).toHaveBeenCalledTimes(1);

      // A sync burst while the first read is still in flight must not queue one
      // read per event; the hook marks the read stale and re-reads once.
      await act(async () => {
        for (let index = 0; index < 20; index++) mocks.pinnedChanged?.({ notebookId: 'nb-1' });
      });
      expect(mocks.list).toHaveBeenCalledTimes(1);

      await act(async () => { resolveFirst(page([noteEntry('a.md')])); });
      expect(mocks.list).toHaveBeenCalledTimes(1);

      await act(async () => { vi.advanceTimersByTime(200); });
      expect(mocks.list).toHaveBeenCalledTimes(2);
      expect(data().pinnedItems.map((item) => item.name)).toEqual(['a.md']);

      // Further events after the burst are cheap: the hook is idle again.
      await act(async () => mocks.pinnedChanged?.({ notebookId: 'nb-1' }));
      expect(mocks.list).toHaveBeenCalledTimes(3);
      expect(data().pinnedItems.map((item) => item.name)).toEqual(['a.md', 'b.html']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the current page when an unloaded note only changes metadata', async () => {
    mocks.list
      .mockResolvedValueOnce(page([noteEntry('first.md')], { nextCursor: 'page-2', hasMore: true }))
      .mockResolvedValueOnce(page([noteEntry('second.md')]));
    await act(async () => root.render(createElement(Harness)));
    await act(async () => data().loadMore());
    await act(async () => mocks.notify?.({
      kind: 'resource-updated', notebookId: 'nb-1', relativePath: 'deep/unloaded.md',
      entry: { ...noteEntry('deep/unloaded.md'), favorited: true, icon: 'book' },
      previousFavorited: true,
      source: 'native',
    } as unknown as NotebookChange));
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(data().pinnedItems.map((item) => item.name)).toEqual(['second.md']);
    expect(data().hasPrevious).toBe(true);
  });
});
