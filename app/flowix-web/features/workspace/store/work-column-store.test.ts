import { beforeEach, describe, expect, it } from 'vitest';

import { useWorkColumnStore } from './work-column-store';

describe('work-column store', () => {
  beforeEach(() => {
    useWorkColumnStore.setState({
      navigation: {
        phase: 'idle',
        showWorkColumnLoading: false,
        requestId: 0,
        target: { kind: 'empty' },
        pendingTarget: null,
        previousTarget: null,
        failure: null,
        retryToken: null,
      },
    });
  });

  it('owns the runtime work-column target independently from restore state', () => {
    const requestId = useWorkColumnStore.getState().beginNavigation(
      { kind: 'external', path: '/notebook/readme.md', scopePath: '/notebook', transitionId: null },
      null,
    );
    useWorkColumnStore.getState().commitNavigation(requestId, {
      kind: 'external',
      path: '/notebook/readme.md',
      scopePath: '/notebook',
      transitionId: 3,
    });

    expect(useWorkColumnStore.getState().navigation).toEqual({
      phase: 'committed',
      showWorkColumnLoading: false,
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
    useWorkColumnStore.setState((state) => ({ navigation: { ...state.navigation, target } }));
    useWorkColumnStore.getState().replaceExternalPath('/notes/drafts/a.md', '/notes/done/a.md');
    expect(useWorkColumnStore.getState().navigation.target).toMatchObject({
      path: '/notes/done/a.md', fileBrowser: { folderPath: '/notes/done' },
    });
  });

  it('ignores stale commits and preserves the committed target while loading', () => {
    const first = useWorkColumnStore.getState().beginNavigation({ kind: 'web', url: 'https://one.test' }, null);
    useWorkColumnStore.getState().commitNavigation(first, { kind: 'web', url: 'https://one.test' });
    const second = useWorkColumnStore.getState().beginNavigation({ kind: 'empty' }, null);

    expect(useWorkColumnStore.getState().navigation).toMatchObject({
      phase: 'loading',
      requestId: second,
      target: { kind: 'web', url: 'https://one.test' },
    });
    expect(useWorkColumnStore.getState().commitNavigation(first, { kind: 'empty' })).toBe(false);
    expect(useWorkColumnStore.getState().navigation.phase).toBe('loading');
  });

  it('can run a transaction without visually blocking the current surface', () => {
    const requestId = useWorkColumnStore.getState().beginNavigation(
      { kind: 'web', url: 'https://one.test' },
      null,
      true,
      false,
    );

    expect(useWorkColumnStore.getState().navigation).toMatchObject({
      requestId,
      phase: 'loading',
      showWorkColumnLoading: false,
    });
  });

  it('records the latest navigation failure without discarding the last surface', () => {
    const requestId = useWorkColumnStore.getState().beginNavigation({ kind: 'web', url: 'https://one.test' }, 'retry-1');
    useWorkColumnStore.getState().commitNavigation(requestId, { kind: 'web', url: 'https://one.test' });
    const retryId = useWorkColumnStore.getState().beginNavigation({ kind: 'empty' }, 'retry-2');

    expect(useWorkColumnStore.getState().failNavigation(retryId, new Error('save refused'))).toBe(true);
    expect(useWorkColumnStore.getState().navigation).toEqual({
      phase: 'failed',
      showWorkColumnLoading: false,
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
    const committedId = useWorkColumnStore.getState().beginNavigation(
      { kind: 'web', url: 'https://one.test' },
      null,
    );
    useWorkColumnStore.getState().commitNavigation(
      committedId,
      { kind: 'web', url: 'https://one.test' },
    );
    const failedId = useWorkColumnStore.getState().beginNavigation(
      { kind: 'empty' },
      'retry-dismiss',
    );
    useWorkColumnStore.getState().failNavigation(failedId, new Error('failed'));

    expect(useWorkColumnStore.getState().dismissNavigationFailure()).toBe('retry-dismiss');
    expect(useWorkColumnStore.getState().navigation).toMatchObject({
      phase: 'committed',
      target: { kind: 'web', url: 'https://one.test' },
      pendingTarget: null,
      failure: null,
      retryToken: null,
    });
  });
});
