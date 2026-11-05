import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteEntry } from '@platform/tauri/client';
import type { NotebookChange } from '@platform/tauri/notebook-change-events';

const mocks = vi.hoisted(() => ({
  notify: null as null | ((change: NotebookChange) => void),
  ready: null as null | (() => void),
  metadata: vi.fn(),
  loadNotebooks: vi.fn(async () => {}),
  nativeEvents: new Map<string, () => void>(),
  getIndexed: vi.fn(), batch: vi.fn(), apply: vi.fn(), refresh: vi.fn(), stale: vi.fn(), rebase: vi.fn(),
  notes: [] as { notebookId: string; relativePath: string }[],
}));
vi.mock('@platform/tauri/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
vi.mock('@platform/tauri/event-bus', () => ({ subscribe: (event: string, callback: () => void) => { mocks.nativeEvents.set(event, callback); return () => { mocks.nativeEvents.delete(event); }; } }));
vi.mock('@platform/tauri/notebook-change-events', () => ({
  subscribeNotebookChanges: (handler: (change: NotebookChange) => void, options: { onListenerReady: () => void }) => {
    mocks.ready = options.onListenerReady;
    mocks.notify = handler;
    return () => { mocks.notify = null; };
  },
}));
vi.mock('./note-repository', () => ({ noteRepository: { getIndexed: mocks.getIndexed } }));
vi.mock('@features/memo/store/note-store', () => ({
  useNoteStore: { getState: () => ({
    selectedNotebook: { id: 'book' }, notes: mocks.notes, loadNotebooks: mocks.loadNotebooks,
    handleMemoListInvalidation: mocks.stale, rebaseNoteListPaths: mocks.rebase, triggerNotebookMetadataRefresh: mocks.metadata,
    applyNoteListChange: mocks.apply, applyNoteListBatch: mocks.batch,
    triggerMemoListRefresh: mocks.refresh, triggerRefresh: mocks.refresh,
  }) },
}));

import { mountMemoListRefreshService, refreshIndexedMemo } from './memo-list-refresh-service';

describe('memo list path updates', () => {
  let dispose: () => void;
  const changed = { kind: 'query-invalidated', notebookId: 'book', relativePath: 'note.md' } as const;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getIndexed.mockReset();
    mocks.notes = [];
    mocks.rebase.mockImplementation((notebookId: string, from: string, to: string) => {
      mocks.notes = mocks.notes.map(note => note.notebookId === notebookId && note.relativePath === from
        ? { ...note, relativePath: to } : note);
    });
    dispose = mountMemoListRefreshService();
  });
  afterEach(() => { dispose(); vi.useRealTimers(); });
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

  it('reloads notebook locations when a registered folder moves and unsubscribes on disposal', async () => {
    mocks.nativeEvents.get('notebooks-changed')?.();
    await settle();
    expect(mocks.loadNotebooks).toHaveBeenCalledOnce();
    dispose();
    expect(mocks.nativeEvents.has('notebooks-changed')).toBe(false);
  });

  it('reconciles the selected notebook on listener recovery and discards stale queued events', async () => {
    vi.useFakeTimers();
    let finish!: (entry: unknown) => void;
    mocks.getIndexed.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    mocks.notify?.(changed);
    mocks.notify?.({ kind: 'resource-updated', notebookId: 'book', relativePath: 'other.md', entry: { relativePath: 'other.md' } as NoteEntry });
    mocks.ready?.();
    finish({ relativePath: 'note.md', preview: 'stale' });
    await vi.advanceTimersByTimeAsync(24);
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.batch).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.metadata).toHaveBeenCalledOnce();
    dispose();
    mocks.ready?.();
    await vi.advanceTimersByTimeAsync(24);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it('patches a path invalidation without resetting the list query', async () => {
    const entry = { relativePath: 'note.md', preview: 'indexed' };
    mocks.getIndexed.mockResolvedValueOnce(entry);
    mocks.notify?.(changed);
    await settle();
    expect(mocks.apply).toHaveBeenCalledWith('book', 'note.md', entry);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('batches background cards and keeps the latest notification for each path', async () => {
    vi.useFakeTimers();
    const update = (path: string, preview: string) => mocks.notify?.({
      kind: 'resource-updated', notebookId: 'book', relativePath: path,
      entry: { relativePath: path, preview } as Extract<NotebookChange, { kind: 'resource-updated' }>['entry'],
    });
    update('a.md', 'old');
    update('b.md', 'other');
    await vi.advanceTimersByTimeAsync(12);
    update('a.md', 'latest');
    expect(mocks.batch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(12);
    expect(mocks.batch).toHaveBeenCalledExactlyOnceWith([
      { notebookId: 'book', relativePath: 'b.md', entry: expect.objectContaining({ preview: 'other' }) },
      { notebookId: 'book', relativePath: 'a.md', entry: expect.objectContaining({ preview: 'latest' }) },
    ]);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('flushes queued edits before deletion and discards queued work on disposal', async () => {
    vi.useFakeTimers();
    const change = {
      kind: 'resource-updated', notebookId: 'book', relativePath: 'note.md',
      entry: { relativePath: 'note.md' },
    } as Extract<NotebookChange, { kind: 'resource-updated' }>;
    mocks.notify?.(change);
    mocks.notify?.({ kind: 'resource-deleted', notebookId: 'book', relativePath: 'note.md' });
    expect(mocks.batch).toHaveBeenCalledOnce();
    expect(mocks.batch.mock.invocationCallOrder[0]).toBeLessThan(mocks.apply.mock.invocationCallOrder[0]);
    mocks.notify?.(change);
    dispose();
    await vi.advanceTimersByTimeAsync(24);
    expect(mocks.batch).toHaveBeenCalledOnce();
  });

  it('ignores an older index read after a full-entry notification', async () => {
    let resolve!: (entry: unknown) => void;
    mocks.getIndexed.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    mocks.notify?.(changed);
    const entry = { relativePath: 'note.md', preview: 'newer' } as Extract<NotebookChange, { kind: 'resource-updated' }>['entry'];
    mocks.notify?.({ kind: 'resource-updated', originWindowLabel: 'main', notebookId: 'book', relativePath: 'note.md', entry });
    resolve({ relativePath: 'note.md', preview: 'older' });
    await settle();
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(mocks.apply).toHaveBeenCalledWith('book', 'note.md', entry);
  });

  it('coalesces repeated invalidations and re-reads after the last notification', async () => {
    let resolve!: (entry: unknown) => void;
    mocks.getIndexed.mockImplementationOnce(() => new Promise(done => { resolve = done; }))
      .mockResolvedValueOnce({ relativePath: 'note.md', preview: 'latest' });
    mocks.notify?.(changed);
    mocks.notify?.(changed);
    resolve({ relativePath: 'note.md', preview: 'obsolete' });
    await settle();
    expect(mocks.getIndexed).toHaveBeenCalledTimes(2);
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(mocks.apply).toHaveBeenCalledWith('book', 'note.md', expect.objectContaining({ preview: 'latest' }));
  });

  it('applies deletion immediately and cancels an older pending read', async () => {
    let resolve!: (entry: unknown) => void;
    mocks.getIndexed.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    mocks.notify?.(changed);
    mocks.notify?.({ kind: 'resource-deleted', notebookId: 'book', relativePath: 'note.md' });
    resolve({ relativePath: 'note.md' });
    await settle();
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(mocks.apply).toHaveBeenCalledWith('book', 'note.md', null);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it('rebases identity before overlapping metadata reads can complete or be superseded', async () => {
    mocks.notes = [{ notebookId: 'book', relativePath: 'old.md' }];
    let resolveOld!: (entry: unknown) => void;
    let resolveNew!: (entry: unknown) => void;
    mocks.getIndexed.mockImplementationOnce(() => new Promise(done => { resolveOld = done; }))
      .mockImplementationOnce(() => new Promise(done => { resolveNew = done; }));
    mocks.notify?.({ ...changed, relativePath: 'new.md' });
    mocks.notify?.({ kind: 'path-moved', notebookId: 'book', previousRelativePath: 'old.md', relativePath: 'new.md', directory: false });
    expect(mocks.notes[0].relativePath).toBe('new.md');
    expect(mocks.rebase).toHaveBeenCalledWith('book', 'old.md', 'new.md', false);
    const entry = { relativePath: 'new.md', preview: 'latest' } as Extract<NotebookChange, { kind: 'resource-updated' }>['entry'];
    mocks.notify?.({ kind: 'resource-updated', originWindowLabel: 'main', notebookId: 'book', relativePath: 'new.md', entry });
    resolveOld({ relativePath: 'new.md', preview: 'stale' });
    resolveNew({ relativePath: 'new.md', preview: 'also stale' });
    await settle();
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(mocks.apply).toHaveBeenCalledWith('book', 'new.md', entry);
  });

  it('marks broad background changes stale without replacing the loaded window', async () => {
    vi.useFakeTimers();
    mocks.notify?.({ kind: 'query-invalidated', notebookId: 'book', relativePath: null });
    await vi.advanceTimersByTimeAsync(24);
    expect(mocks.stale).toHaveBeenCalledWith('book');
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('recovers from a transient read failure and reports exhausted retries', async () => {
    vi.useFakeTimers();
    mocks.getIndexed.mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce({ relativePath: 'note.md' });
    const recovered = refreshIndexedMemo('book', 'note.md');
    await vi.advanceTimersByTimeAsync(120);
    await expect(recovered).resolves.toBe('updated');
    expect(mocks.getIndexed).toHaveBeenCalledTimes(2);
    mocks.getIndexed.mockReset().mockRejectedValue(new Error('unavailable'));
    const failed = refreshIndexedMemo('book', 'note.md');
    await vi.advanceTimersByTimeAsync(480);
    await expect(failed).resolves.toBe('failed');
    expect(mocks.getIndexed).toHaveBeenCalledTimes(3);
    expect(mocks.stale).toHaveBeenCalledWith('book');
  });

  it('cancels retry timers when disposed', async () => {
    vi.useFakeTimers();
    mocks.getIndexed.mockRejectedValue(new Error('busy'));
    const pending = refreshIndexedMemo('book', 'note.md');
    await settle();
    dispose();
    await expect(pending).resolves.toBe('skipped');
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.getIndexed).toHaveBeenCalledTimes(1);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

});
