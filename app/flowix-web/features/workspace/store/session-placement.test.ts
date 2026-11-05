import { getSessionId } from './workspace-session-store';
import { createSessionWebRuntimeChannel } from './session-web-runtime';
import { createWorkspaceWebRuntime } from '../model/web-navigation';
import { beforeEach, describe, expect, it } from 'vitest';
import { sessionFor } from '../model/workspace-session';
import { createSessionViewChannel } from '../public/session-view-state-api';
import { getColumnIdForSession, getColumnSessionId, useWorkspaceSessionStore } from './workspace-session-store';

const web = (name: string) => ({ kind: 'web' as const, url: `https://${name}.example/` });
beforeEach(() => { localStorage.clear(); useWorkspaceSessionStore.getState().reset(); });

describe('stable sessions and column placement', () => {
  it('swaps placement without copying sessions, histories or view state', () => {
    const store = useWorkspaceSessionStore.getState();
    store.commitTarget(getSessionId(0), web('a'), { history: 'push' });
    store.commitTarget(getSessionId(0), web('b'), { history: 'push' });
    const before = useWorkspaceSessionStore.getState();
    const id = getColumnSessionId('column-1');
    store.swapColumnContents();
    const after = useWorkspaceSessionStore.getState();
    expect(after.sessions).toBe(before.sessions);
    expect(sessionFor(after, 1)).toBe(before.sessions[id]);
    expect(getColumnSessionId('column-1')).toBe(id);
    expect(getColumnIdForSession(id)).toBe('column-1');
    store.swapColumnContents();
    expect(useWorkspaceSessionStore.getState().placement).toEqual(before.placement);
  });

  it('keeps delayed view teardown writes attached to the original session', () => {
    const store = useWorkspaceSessionStore.getState();
    store.commitTarget(getSessionId(0), web('a'));
    const session = sessionFor(useWorkspaceSessionStore.getState(), 0);
    const entry = session.navigation.current!.id;
    const channel = createSessionViewChannel(0, entry, 'scroll');
    store.swapColumnContents();
    channel.write({ kind: 'scroll', scrollTop: 123, scrollLeft: 0 });
    expect(sessionFor(useWorkspaceSessionStore.getState(), 1).viewStates[entry].recovery?.slots.scroll)
      .toEqual({ kind: 'scroll', scrollTop: 123, scrollLeft: 0 });
    expect(sessionFor(useWorkspaceSessionStore.getState(), 0).viewStates[entry]).toBeUndefined();
  });

  it('commits a captured session transaction to that session after placement changes', () => {
    const store = useWorkspaceSessionStore.getState();
    const id = getColumnSessionId('column-1');
    store.updateSession(getSessionId(id), (session) => ({ ...session, navigation: { ...session.navigation,
      transaction: { ...session.navigation.transaction, phase: 'loading', requestId: 7 },
    } }));
    // Low-level placement operation: the UI retains its existing busy guard.
    store.swapColumnContents();
    expect(store.commitTarget(getSessionId(id), web('loaded'), { expectedRequestId: 7 })).toBe(true);
    expect(sessionFor(useWorkspaceSessionStore.getState(), 1).navigation.current?.target).toEqual(web('loaded'));
    expect(sessionFor(useWorkspaceSessionStore.getState(), 0).navigation.current).toBeNull();
  });

  it('persists and restores swapped placement and stable identities', () => {
    const store = useWorkspaceSessionStore.getState();
    store.commitTarget(getSessionId(0), web('a'));
    store.swapColumnContents();
    const saved = JSON.parse(localStorage.getItem('flowix.workspace.session-placement')!);
    expect(saved.version).toBe(6);
    const merge = useWorkspaceSessionStore.persist.getOptions().merge!;
    const restored = merge(saved.state, useWorkspaceSessionStore.getState());
    expect(restored.placement).toEqual({ 0: 'column-2', 1: 'column-1' });
    expect(sessionFor(restored, 1).navigation.current?.target).toEqual(web('a'));
  });

  it.each(['column', 'legacy'])('migrates %s session keys and rejects duplicate placement', (format) => {
    const current = useWorkspaceSessionStore.getState();
    const first = format === 'column' ? 0 : 'primary-session';
    const second = format === 'column' ? 1 : 'secondary-session';
    const restored = useWorkspaceSessionStore.persist.getOptions().merge!({
      sessions: { [first]: current.sessions['column-1'], [second]: current.sessions['column-2'] },
      placement: { 0: 'column-2', 1: 'column-2' },
    }, current);
    expect(restored.placement).toEqual({ 0: 'column-1', 1: 'column-2' });
    expect(sessionFor(restored, 0).id).toBe('column-1');
    expect(sessionFor(restored, 1).id).toBe('column-2');
  });
});

describe('legacy placement and delayed web callbacks', () => {
  it('migrates v5 position names and session identities without losing their content', () => {
    const store = useWorkspaceSessionStore.getState();
    store.commitTarget('column-1', web('first'));
    store.commitTarget('column-2', web('second'));
    const state = useWorkspaceSessionStore.getState();
    const restored = useWorkspaceSessionStore.persist.getOptions().merge!({
      placement: { 'column-1': 'session-2', 'column-2': 'session-1' },
      sessions: {
        'session-1': { ...state.sessions['column-1'], id: 'session-1' },
        'session-2': { ...state.sessions['column-2'], id: 'session-2' },
      },
    }, state);
    expect(restored.placement).toEqual({ 0: 'column-2', 1: 'column-1' });
    expect(sessionFor(restored, 0)).toMatchObject({ id: 'column-2', navigation: { current: { target: web('second') } } });
    expect(sessionFor(restored, 1)).toMatchObject({ id: 'column-1', navigation: { current: { target: web('first') } } });
  });

  it('restores a swapped v2 host mapping with the content in the same positions', () => {
    const store = useWorkspaceSessionStore.getState();
    store.commitTarget(getSessionId(0), web('a'));
    store.commitTarget(getSessionId(1), web('b'));
    const current = useWorkspaceSessionStore.getState();
    const restored = useWorkspaceSessionStore.persist.getOptions().merge!({
      hosts: { 'main-third': 'secondary-session', 'browser-column': 'primary-session' },
      sessions: { 'primary-session': current.sessions['column-1'], 'secondary-session': current.sessions['column-2'] },
    }, current);
    expect(restored.placement).toEqual({ 0: 'column-2', 1: 'column-1' });
    expect(sessionFor(restored, 0).navigation.current?.target).toEqual(web('b'));
    expect(sessionFor(restored, 1).navigation.current?.target).toEqual(web('a'));
  });

  it('ignores invalid v2 host mappings and gives valid new placement precedence', () => {
    const current = useWorkspaceSessionStore.getState();
    const merge = useWorkspaceSessionStore.persist.getOptions().merge!;
    const hosts = { 'column-1': 'secondary-session', 'column-2': 'secondary-session' };
    expect(merge({ hosts }, current).placement).toEqual(current.placement);
    expect(merge({ hosts: { ...hosts, 'column-2': 'primary-session' }, placement: current.placement }, current).placement)
      .toEqual(current.placement);
  });

  it('routes a late iframe update to its original session after a swap', () => {
    const store = useWorkspaceSessionStore.getState();
    store.commitTarget(getSessionId(0), web('a'));
    store.commitTarget(getSessionId(1), web('b'));
    const before = useWorkspaceSessionStore.getState();
    const entry = before.sessions['column-1'].navigation.current!.id;
    const channel = createSessionWebRuntimeChannel('column-1', entry);
    const publish = (url: string) => channel.write(createWorkspaceWebRuntime(url));
    store.swapColumnContents();
    publish('https://a.example/late');
    const after = useWorkspaceSessionStore.getState();
    expect(after.sessions['column-2']).toBe(before.sessions['column-2']);
    expect(after.sessions['column-1'].viewStates[entry]?.webRuntime?.currentUrl).toBe('https://a.example/late');
    expect(sessionFor(after, 1).navigation.current?.target).toEqual({ kind: 'web', url: 'https://a.example/late' });
  });

  it('updates a retained history runtime without changing the newer current URL', () => {
    const store = useWorkspaceSessionStore.getState();
    store.commitTarget(getSessionId(0), web('a'), { history: 'push' });
    const entry = sessionFor(useWorkspaceSessionStore.getState(), 0).navigation.current!.id;
    const channel = createSessionViewChannel(0, entry, 'scroll');
    channel.write({ kind: 'scroll', scrollTop: 12, scrollLeft: 0 });
    store.commitTarget(getSessionId(0), web('b'), { history: 'push' });
    store.swapColumnContents();
    createSessionWebRuntimeChannel('column-1', entry).write(createWorkspaceWebRuntime('https://a.example/late'));
    const session = sessionFor(useWorkspaceSessionStore.getState(), 1);
    expect(session.navigation.current?.target).toEqual(web('b'));
    expect(session.viewStates[entry].recovery?.slots.scroll).toEqual({ kind: 'scroll', scrollTop: 12, scrollLeft: 0 });
    expect(session.viewStates[entry].webRuntime?.currentUrl).toBe('https://a.example/late');
    store.reset();
    const reset = useWorkspaceSessionStore.getState();
    createSessionWebRuntimeChannel('column-1', entry).write(createWorkspaceWebRuntime('https://a.example/stale'));
    expect(useWorkspaceSessionStore.getState()).toBe(reset);
  });
});

it('drops callbacks for an evicted legacy UUID entry without relying on an ID prefix', () => {
  const store = useWorkspaceSessionStore.getState();
  const entryId = crypto.randomUUID();
  store.commitTarget('column-1', web('legacy'), { entryId });
  const channel = createSessionWebRuntimeChannel('column-1', entryId);
  const runtime = createWorkspaceWebRuntime('https://legacy.example/late');
  channel.write(runtime);
  expect(channel.read()).toBe(runtime);
  store.reset();
  const reset = useWorkspaceSessionStore.getState();
  channel.write(runtime);
  expect(useWorkspaceSessionStore.getState()).toBe(reset);
});
