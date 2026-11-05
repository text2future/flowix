import { beforeEach, expect, it } from 'vitest';
import { SESSION_VIEW_STATE_LIMIT } from '../model/session-limits';
import { useWorkspaceSessionStore } from './workspace-session-store';
import { createSessionWebRuntimeChannel } from './session-web-runtime';
import { createWorkspaceWebRuntime } from '../model/web-navigation';
import { createSessionViewChannel } from '../public/session-view-state-api';

beforeEach(() => useWorkspaceSessionStore.getState().reset());
it('reclaims web views no longer reachable from current or history', () => {
  const store = useWorkspaceSessionStore.getState();
  for (let i = 0; i < SESSION_VIEW_STATE_LIMIT + 5; i++) {
    const url = `https://example.com/${i}`;
    store.commitTarget('column-1', { kind: 'web', url }, { history: 'push' });
    const entry = useWorkspaceSessionStore.getState().sessions['column-1'].navigation.current!;
    createSessionWebRuntimeChannel('column-1', entry.id).write(createWorkspaceWebRuntime(url));
  }
  const session = useWorkspaceSessionStore.getState().sessions['column-1'];
  const live = new Set([session.navigation.current, ...session.navigation.backStack, ...session.navigation.forwardStack]
    .flatMap((entry) => entry ? [entry.id] : []));
  expect(Object.keys(session.viewStates).length).toBeLessThanOrEqual(SESSION_VIEW_STATE_LIMIT);
  expect(Object.keys(session.viewStates).every((id) => live.has(id))).toBe(true);
  expect(session.viewStates[session.navigation.current!.id]?.webRuntime).toBeDefined();
});
it('preserves retained editor slots alongside web state and reclaims cleared forward history', () => {
  const store = useWorkspaceSessionStore.getState();
  store.commitTarget('column-1', { kind: 'web', url: 'https://a.example/' }, { history: 'push' });
  const a = useWorkspaceSessionStore.getState().sessions['column-1'].navigation.current!;
  const channel = createSessionViewChannel('column-1', a.id, 'scroll');
  channel.write({ kind: 'scroll', scrollTop: 42, scrollLeft: 0 });
  createSessionWebRuntimeChannel('column-1', a.id).write(createWorkspaceWebRuntime('https://a.example/'));
  store.commitTarget('column-1', { kind: 'web', url: 'https://b.example/' }, { history: 'push' });
  expect(channel.read()).toEqual({ kind: 'scroll', scrollTop: 42, scrollLeft: 0 });
  store.updateSession('column-1', (session) => ({ ...session, navigation: {
    ...session.navigation, backStack: [], forwardStack: [a],
  } }));
  store.commitTarget('column-1', { kind: 'web', url: 'https://c.example/' }, { history: 'push' });
  expect(channel.read()).toBeUndefined();
});
it('enforces the limit with both history stacks and always keeps the current view', () => {
  const store = useWorkspaceSessionStore.getState();
  store.commitTarget('column-1', { kind: 'web', url: 'https://current.example/' });
  const current = useWorkspaceSessionStore.getState().sessions['column-1'].navigation.current!;
  store.updateSession('column-1', (session) => {
    const entries = Array.from({ length: 200 }, (_, i) => ({ ...current, id: `history-${i}` }));
    return { ...session, navigation: { ...session.navigation, backStack: entries.slice(0, 100), forwardStack: entries.slice(100) },
      viewStates: Object.fromEntries([current, ...entries].map((entry) => [entry.id, { webRuntime: createWorkspaceWebRuntime('https://example.com/') }])) };
  });
  const session = useWorkspaceSessionStore.getState().sessions['column-1'];
  expect(Object.keys(session.viewStates)).toHaveLength(SESSION_VIEW_STATE_LIMIT);
  expect(session.viewStates[current.id]).toBeDefined();
});
