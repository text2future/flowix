import { getSessionId } from './workspace-session-store';
import { sessionFor } from '../model/workspace-session';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceSessionStore } from './workspace-session-store';
import { useWorkColumnStore } from './work-column-store';
import { useBrowserColumnStore } from './browser-column-store';
import { createSessionWebRuntimeChannel } from './session-web-runtime';
import { getWorkspaceDocumentNavigation, recordWorkspaceDocumentNavigation } from '@features/document/public/workspace-api';
import { getWorkspaceSessionNavigation } from '../use-cases/session-navigation';
import { createWorkspaceWebRuntime, navigateWorkspaceWebRuntime } from '../model/web-navigation';
import type { WorkspaceSessionReference } from '../model/workspace-session';

beforeEach(() => {
  localStorage.clear();
  useWorkspaceSessionStore.getState().reset();
});

const web = (url: string) => ({ kind: 'web' as const, url });

describe('one canonical session state source', () => {
  it.each([0, 1] as const)('uses the same current/history transaction in %s', (id) => {
    const store = useWorkspaceSessionStore.getState();
    store.commitTarget(getSessionId(id), web('https://a.example/'), { history: 'push' });
    const a = getWorkspaceSessionNavigation(id).current;
    const events = vi.fn();
    const stop = useWorkspaceSessionStore.subscribe(events);
    try {
      store.commitTarget(getSessionId(id), web('https://b.example/'), { history: 'push' });
      const navigation = getWorkspaceSessionNavigation(id);
      expect(navigation.backStack).toEqual([a]);
      expect(navigation.current?.target).toEqual(web('https://b.example/'));
      expect(events).toHaveBeenCalledTimes(1);
      expect(navigation).toBe(sessionFor(useWorkspaceSessionStore.getState(), id).navigation);
    } finally { stop(); }
  });

  it('makes old Work mutations and direct session mutations address the same state', () => {
    const work = useWorkColumnStore.getState();
    const target = web('https://work.example/');
    const requestId = work.beginNavigation(target, null);
    expect(work.commitNavigation(requestId, target, 'push')).toBe(true);
    const current = getWorkspaceSessionNavigation(0).current!;
    expect(current.target).toBe(target);
    useWorkspaceSessionStore.getState().commitTarget(getSessionId(0), web('https://next.example/'), { history: 'push' });
    expect(useWorkColumnStore.getState().navigation.target).toEqual(web('https://next.example/'));
    expect(getWorkspaceDocumentNavigation().backStack[0]).toMatchObject({ kind: 'web', url: target.url });
  });

  it('normalizes legacy agent spelling once, without retaining a Browser backend', () => {
    useBrowserColumnStore.getState().openContent({
      id: 'agent', title: 'Agent', icon: null, target: { kind: 'agent_conversation', instanceId: 'conversation' },
    });
    expect(getWorkspaceSessionNavigation(1).current?.target).toEqual({
      kind: 'agent-conversation', instanceId: 'conversation',
    });
    useWorkspaceSessionStore.getState().commitTarget(getSessionId(1), web('https://next.example/'), { history: 'push' });
    expect(useBrowserColumnStore.getState().current?.target).toEqual(web('https://next.example/'));
    expect(useBrowserColumnStore.getState().backStack[0].target).toEqual({
      kind: 'agent_conversation', instanceId: 'conversation',
    });
  });

  it('does not rewrite a canonical target when old metadata callbacks update its title', () => {
    const target = { kind: 'external' as const, path: '/book/a.md', scopePath: '/book', transitionId: null };
    useWorkspaceSessionStore.getState().commitTarget(getSessionId(1), target);
    const id = getWorkspaceSessionNavigation(1).current!.id;
    useBrowserColumnStore.getState().updateContentMetadata(id, { title: 'Updated' });
    expect(getWorkspaceSessionNavigation(1).current?.target).toEqual(target);
    expect(getWorkspaceSessionNavigation(1).current?.title).toBe('Updated');
  });

  it('stores old document history writes directly in canonical history', () => {
    recordWorkspaceDocumentNavigation({ kind: 'external', path: '/a.md', scopePath: null, openedAt: 1 },
      { kind: 'external', path: '/b.md', scopePath: null, openedAt: 2 });
    const history = getWorkspaceSessionNavigation(0).backStack;
    expect(history).toHaveLength(1);
    expect(history[0].target).toEqual({ kind: 'external', path: '/a.md', scopePath: null });
    expect(history[0].openedAt).toBe(1);
    expect(history[0].target).not.toHaveProperty('openedAt');
  });

  it('retains stable web identity while the current URL and history update', () => {
    useWorkspaceSessionStore.getState().commitTarget(getSessionId(0), web('https://a.example/'));
    const current = getWorkspaceSessionNavigation(0).current!;
    const runtime = navigateWorkspaceWebRuntime(createWorkspaceWebRuntime('https://a.example/'), 'https://b.example/');
    createSessionWebRuntimeChannel('column-1', current.id).write(runtime);
    const session = sessionFor(useWorkspaceSessionStore.getState(), 0);
    expect(session.navigation.current?.id).toBe(current.id);
    expect(session.navigation.current?.target).toEqual(web('https://b.example/'));
    expect(session.viewStates[current.id].webRuntime).toBe(runtime);
    expect(useWorkColumnStore.getState().navigation.target).toEqual(web('https://b.example/'));
  });

  it('persists current/history/header state together and never writes retired storage keys', () => {
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    try {
      const root = useWorkspaceSessionStore.getState();
      root.commitTarget(getSessionId(0), web('https://a.example/'), { history: 'push' });
      root.commitTarget(getSessionId(0), web('https://b.example/'), { history: 'push' });
      root.setAddressBarVisible(getSessionId(0), getWorkspaceSessionNavigation(0).current!.id, true);
      useBrowserColumnStore.getState().openContent({ id: 'secondary', title: 'Secondary', icon: null, target: web('https://c.example/') });
      expect(new Set(writes.mock.calls.map(([key]) => key))).toEqual(new Set(['flowix.workspace.session-placement']));
      const saved = JSON.parse(localStorage.getItem('flowix.workspace.session-placement')!);
      expect(sessionFor(saved.state, 0).navigation.backStack).toHaveLength(1);
      expect(sessionFor(saved.state, 1).navigation.current?.target.kind).toBe('web');
    } finally { writes.mockRestore(); }
  });

  it('restores the canonical snapshot instead of resurrecting stale legacy history', async () => {
    const id: WorkspaceSessionReference = 0;
    const root = useWorkspaceSessionStore.getState();
    root.commitTarget(getSessionId(id), web('https://current.example/'));
    const current = getWorkspaceSessionNavigation(id).current!;
    root.setAddressBarVisible(getSessionId(id), current.id, true);
    localStorage.setItem('flowix.document-history.v1', JSON.stringify({ state: {
      backStack: [{ kind: 'web', url: 'https://stale.example/', openedAt: 1 }], forwardStack: [],
    } }));
    const saved = localStorage.getItem('flowix.workspace.session-placement')!;
    root.reset();
    localStorage.setItem('flowix.workspace.session-placement', saved);
    await useWorkspaceSessionStore.persist.rehydrate();
    const session = sessionFor(useWorkspaceSessionStore.getState(), id);
    expect(session.navigation.current?.id).toBe(current.id);
    expect(session.navigation.backStack).toEqual([]);
    expect(session.headerState[current.id].addressBarVisible).toBe(true);
  });
});

it('keeps the outgoing Surface ID when a refused replay rolls back its target', () => {
  const root = useWorkspaceSessionStore.getState();
  const target = { kind: 'web' as const, url: 'https://visible.example/' };
  root.commitTarget(getSessionId(0), target);
  const current = getWorkspaceSessionNavigation(0).current!;
  root.updateSession(getSessionId(0), (session) => ({ ...session, navigation: {
    ...session.navigation, transaction: { ...session.navigation.transaction, entryId: 'replay-target' },
  } }));
  const work = useWorkColumnStore.getState();
  const requestId = work.beginNavigation({ kind: 'web', url: 'https://refused.example/' }, null);
  work.failNavigation(requestId, new Error('Save refused'));
  work.commitNavigation(requestId, target);
  expect(getWorkspaceSessionNavigation(0).current?.id).toBe(current.id);
});

it('keeps renderer presentation callbacks out of the canonical content record', async () => {
  const { updatePrimarySurfaceMetadata } = await import('../public/session-runtime-api');
  const root = useWorkspaceSessionStore.getState();
  root.commitTarget(getSessionId(0), { kind: 'web', url: 'https://example.com/' });
  const current = getWorkspaceSessionNavigation(0).current!;
  const presentation = {
    title: 'Page title',
    state: { status: 'ready' },
    actions: [{ id: 'runtime-action', run: () => undefined }],
  };
  updatePrimarySurfaceMetadata(current.id, presentation);
  const entry = getWorkspaceSessionNavigation(0).current!;
  expect(entry.title).toBe('Page title');
  expect(Object.keys(entry).sort()).toEqual(['id', 'icon', 'openedAt', 'target', 'title'].sort());
});

it('lets either session retain the same collection-reference history model', () => {
  useWorkspaceSessionStore.getState().updateSession(getSessionId(1), (session) => ({
    ...session, navigation: { ...session.navigation, backStack: [{
      id: 'collection-history', title: 'Collection', icon: null, openedAt: 1,
      target: { kind: 'collection-reference', notebookId: 'book', collectionId: 'shared-collection', viewId: null },
    }] },
  }));
  expect(getWorkspaceSessionNavigation(1).backStack[0].target.kind).toBe('collection-reference');
  expect(useBrowserColumnStore.getState().backStack[0].target).toMatchObject({
    kind: 'file-browser', collectionDisplay: { notebookId: 'book', collectionId: 'shared-collection' },
  });
});
