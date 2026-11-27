import { afterEach, expect, it } from 'vitest';
import { useWorkspaceSessionStore } from '@features/workspace/public/session-api';
import { reserveSessionNavigationIntent, releaseSessionNavigationIntent } from '@features/workspace/store/session-navigation-intent';
import { canOpenPluginRunResult } from './plugin-run-navigation';

afterEach(() => useWorkspaceSessionStore.getState().reset());

it.each(['column-1', 'column-2'] as const)('does not open a completed run after navigation starts in %s', (host) => {
  const store = useWorkspaceSessionStore.getState();
  store.reset();
  store.commitTarget(host, { kind: 'plugin-workbench', plugin: { manifest: { id: 'example' } } as never });
  const initial = useWorkspaceSessionStore.getState().sessions[host].navigation;
  expect(canOpenPluginRunResult(initial, initial, 'example', '/book', '/book')).toBe(true);

  const intent = reserveSessionNavigationIntent(host);
  const preparing = useWorkspaceSessionStore.getState().sessions[host].navigation;
  expect(preparing.current?.id).toBe(initial.current?.id);
  expect(canOpenPluginRunResult(initial, preparing, 'example', '/book', '/book')).toBe(false);

  releaseSessionNavigationIntent(intent);
  const settled = useWorkspaceSessionStore.getState().sessions[host].navigation;
  expect(canOpenPluginRunResult(initial, settled, 'example', '/book', '/book')).toBe(false);
});
