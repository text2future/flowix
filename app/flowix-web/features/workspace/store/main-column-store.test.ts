import { reserveSessionNavigationIntent } from './session-navigation-intent';
import { getColumnSessionId } from './workspace-session-store';
import { seedMainColumn } from '@features/workspace/test-support/workspace-fixtures';
import { beforeEach, describe, expect, it } from 'vitest';

import { useMainColumnStore } from './main-column-store';

describe('main-column store', () => {
  beforeEach(() => {
    seedMainColumn({
      navigation: {
        phase: 'idle',
        showMainColumnLoading: false,
        requestId: 0,
        target: { kind: 'empty' },
        pendingTarget: null,
        previousTarget: null,
        failure: null,
        retryToken: null,
      },
    });
  });

  it('reserves preflight intent on the transaction revision without changing visible content', () => {
    const store = useMainColumnStore.getState();
    const target = { kind: 'web' as const, url: 'https://visible.test' };
    const committed = store.beginNavigation(target, null);
    store.commitNavigation(committed, target);
    const oldLoader = store.beginNavigation({ kind: 'empty' }, 'retry-old');
    const intent = reserveSessionNavigationIntent(getColumnSessionId('column-1')).requestId;
    expect(store.isCurrentNavigation(oldLoader)).toBe(false);
    expect(store.commitNavigation(oldLoader, { kind: 'empty' })).toBe(false);
    expect(useMainColumnStore.getState().navigation).toMatchObject({
      requestId: intent, target, phase: 'preparing', pendingTarget: null,
      showMainColumnLoading: false, retryToken: null,
    });
    store.beginNavigation({ kind: 'empty' }, null);
    expect(store.isCurrentNavigation(intent)).toBe(false);
  });

  it('owns the runtime main-column target independently from restore state', () => {
    const requestId = useMainColumnStore.getState().beginNavigation(
      { kind: 'external', path: '/notebook/readme.md', scopePath: '/notebook', transitionId: null },
      null,
    );
    useMainColumnStore.getState().commitNavigation(requestId, {
      kind: 'external',
      path: '/notebook/readme.md',
      scopePath: '/notebook',
      transitionId: 3,
    });

    expect(useMainColumnStore.getState().navigation).toEqual({
      phase: 'committed',
      showMainColumnLoading: false,
      requestId,
      target: {
        kind: 'external',
        path: '/notebook/readme.md',
        scopePath: '/notebook',
        transitionId: 3,
      },
      pendingTarget: null,
      previousTarget: { kind: 'empty' },
      failure: null,
      retryToken: null,
    });
  });

  it('updates the open file and its displayed folder after a confirmed move', () => {
    const target = {
      kind: 'external' as const,
      path: '/notes/drafts/a.md', scopePath: '/notes', transitionId: null,
      fileBrowser: { folderPath: '/notes/drafts', notebookId: 'book', scopePath: '/notes', fileTreeVisible: true, fileTreeWidth: 220 },
    };
    seedMainColumn((state) => ({ navigation: { ...state.navigation, target } }));
    useMainColumnStore.getState().replaceExternalPath('/notes/drafts/a.md', '/notes/done/a.md');
    expect(useMainColumnStore.getState().navigation.target).toMatchObject({
      path: '/notes/done/a.md', fileBrowser: { folderPath: '/notes/done' },
    });
  });

  it('ignores stale commits and preserves the committed target while loading', () => {
    const first = useMainColumnStore.getState().beginNavigation({ kind: 'web', url: 'https://one.test' }, null);
    useMainColumnStore.getState().commitNavigation(first, { kind: 'web', url: 'https://one.test' });
    const second = useMainColumnStore.getState().beginNavigation({ kind: 'empty' }, null);

    expect(useMainColumnStore.getState().navigation).toMatchObject({
      phase: 'loading',
      requestId: second,
      target: { kind: 'web', url: 'https://one.test' },
    });
    expect(useMainColumnStore.getState().commitNavigation(first, { kind: 'empty' })).toBe(false);
    expect(useMainColumnStore.getState().navigation.phase).toBe('loading');
  });

  it('can run a transaction without visually blocking the current surface', () => {
    const requestId = useMainColumnStore.getState().beginNavigation(
      { kind: 'web', url: 'https://one.test' },
      null,
      true,
      false,
    );

    expect(useMainColumnStore.getState().navigation).toMatchObject({
      requestId,
      phase: 'loading',
      showMainColumnLoading: false,
    });
  });

  it('does not publish a creation reveal policy from failed or superseded navigation', () => {
    const store = useMainColumnStore.getState();
    const created = {
      kind: 'external' as const, path: '/notes/new.md', scopePath: '/notes',
      transitionId: null, treeReveal: 'created-note' as const,
    };
    const failedId = store.beginNavigation(created, null);
    store.failNavigation(failedId, new Error('open failed'));
    expect(useMainColumnStore.getState().navigation.target).toEqual({ kind: 'empty' });
    const staleId = store.beginNavigation(created, null);
    const ordinary = { kind: 'external' as const, path: '/notes/other.md', scopePath: '/notes', transitionId: null };
    const currentId = store.beginNavigation(ordinary, null);
    expect(store.commitNavigation(staleId, created)).toBe(false);
    expect(store.commitNavigation(currentId, ordinary)).toBe(true);
    expect(useMainColumnStore.getState().navigation.target).toEqual(ordinary);
  });

  it('records the latest navigation failure without discarding the last surface', () => {
    const requestId = useMainColumnStore.getState().beginNavigation({ kind: 'web', url: 'https://one.test' }, 'retry-1');
    useMainColumnStore.getState().commitNavigation(requestId, { kind: 'web', url: 'https://one.test' });
    const retryId = useMainColumnStore.getState().beginNavigation({ kind: 'empty' }, 'retry-2');

    expect(useMainColumnStore.getState().failNavigation(retryId, new Error('save refused'))).toBe(true);
    expect(useMainColumnStore.getState().navigation).toEqual({
      phase: 'failed',
      showMainColumnLoading: false,
      requestId: retryId,
      target: { kind: 'web', url: 'https://one.test' },
      pendingTarget: { kind: 'empty' },
      previousTarget: { kind: 'web', url: 'https://one.test' },
      failure: {
        code: 'navigation-failed',
        message: 'save refused',
        requestId: retryId,
        retryToken: 'retry-2',
      },
      retryToken: 'retry-2',
    });
  });

  it('dismisses a failure while retaining the last committed target', () => {
    const committedId = useMainColumnStore.getState().beginNavigation(
      { kind: 'web', url: 'https://one.test' },
      null,
    );
    useMainColumnStore.getState().commitNavigation(
      committedId,
      { kind: 'web', url: 'https://one.test' },
    );
    const failedId = useMainColumnStore.getState().beginNavigation(
      { kind: 'empty' },
      'retry-dismiss',
    );
    useMainColumnStore.getState().failNavigation(failedId, new Error('failed'));

    expect(useMainColumnStore.getState().dismissNavigationFailure()).toBe('retry-dismiss');
    expect(useMainColumnStore.getState().navigation).toMatchObject({
      phase: 'committed',
      target: { kind: 'web', url: 'https://one.test' },
      pendingTarget: null,
      failure: null,
      retryToken: null,
    });
  });
});
