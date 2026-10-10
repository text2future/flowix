import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoEvent } from '@/types/memo';
import { createMemoDedupMiddleware } from './memo-dispatcher-dedup';

function updated(revision: number, notebookId = 'notebook'): Extract<MemoEvent, { kind: 'updated' }> {
  return {
    kind: 'updated', id: 'memo', path: '/note.md', notebookId, revision,
    changeId: `change-${revision}`, source: 'user_edit',
    derivedChanged: { tags: false, todos: false, agents: false },
    memo: {
      id: 'memo', filename: 'note.md', relativePath: 'note.md', preview: '', tags: [], todos: [], agents: [],
      createdAt: 1, updatedAt: 1, favorited: false, icon: null, colors: [], properties: {},
    },
  };
}

describe('memo event ordering', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('routes superseded backend observations only to metadata refresh', () => {
    const next = vi.fn();
    const refresh = vi.fn();
    const dispatch = createMemoDedupMiddleware({ onDiscardedDerivedChange: refresh })(next);
    dispatch({ ...updated(100), derivedOnly: true, derivedChanged: { tags: false, todos: true, agents: false } });
    dispatch(updated(2));
    vi.runAllTimers();
    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0][0].revision).toBe(2);
    expect(refresh).toHaveBeenCalledWith({ notebookId: 'notebook', derivedChanged: { tags: false, todos: true, agents: false } });
  });

  it.each([false, true])('preserves stale derived signals without replaying content, alreadyDelivered=%s', (alreadyDelivered) => {
    const next = vi.fn();
    const refresh = vi.fn();
    const dispatch = createMemoDedupMiddleware({ onDiscardedDerivedChange: refresh })(next);
    dispatch(updated(3));
    if (alreadyDelivered) vi.runAllTimers();
    dispatch({ ...updated(2), derivedChanged: { tags: true, todos: true, agents: false } });
    vi.runAllTimers();
    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0][0].revision).toBe(3);
    expect(refresh).toHaveBeenCalledWith({ notebookId: 'notebook', derivedChanged: { tags: true, todos: true, agents: false } });
    expect(refresh.mock.calls[0][0]).not.toHaveProperty('memo');
  });

  it('does not let a late older revision replace pending or delivered content', () => {
    const next = vi.fn();
    const dispatch = createMemoDedupMiddleware()(next);
    dispatch(updated(3));
    dispatch(updated(2));
    vi.runAllTimers();
    dispatch(updated(1));
    vi.runAllTimers();
    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0][0].revision).toBe(3);
  });

  it('keeps notebook identities separate', () => {
    const next = vi.fn();
    const dispatch = createMemoDedupMiddleware()(next);
    dispatch(updated(3, 'first'));
    dispatch(updated(1, 'second'));
    vi.runAllTimers();
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('retains all derived refresh signals while coalescing', () => {
    const next = vi.fn();
    const dispatch = createMemoDedupMiddleware()(next);
    dispatch({ ...updated(1), derivedChanged: { tags: true, todos: false, agents: false } });
    dispatch({ ...updated(2), derivedChanged: { tags: false, todos: true, agents: false } });
    vi.runAllTimers();
    expect(next.mock.calls[0][0].derivedChanged).toEqual({ tags: true, todos: true, agents: false });
  });

  it('flushes earlier metadata snapshots before tag changes', () => {
    const next = vi.fn();
    const dispatch = createMemoDedupMiddleware()(next);
    dispatch(updated(1));
    dispatch({ kind: 'tags_deleted', notebookId: 'notebook', affectedRelativePaths: ['note.md'], deletedTags: ['tag'] });
    vi.runAllTimers();
    expect(next.mock.calls.map(([event]) => event.kind)).toEqual(['updated', 'tags_deleted']);
  });

  it('rejects updates older than a delivered deletion', () => {
    const next = vi.fn();
    const dispatch = createMemoDedupMiddleware()(next);
    const { memo, ...event } = updated(4);
    dispatch({ ...event, kind: 'deleted', relativePath: memo.relativePath ?? memo.filename });
    dispatch(updated(3));
    vi.runAllTimers();
    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0][0].kind).toBe('deleted');
  });

  it('allows same-content metadata updates at the same revision', () => {
    const next = vi.fn();
    const dispatch = createMemoDedupMiddleware()(next);
    dispatch(updated(1));
    vi.runAllTimers();
    dispatch({ ...updated(1), memo: { ...updated(1).memo, favorited: true } });
    vi.runAllTimers();
    expect(next).toHaveBeenCalledTimes(2);
    expect(next.mock.calls[1][0].memo.favorited).toBe(true);
  });
});
