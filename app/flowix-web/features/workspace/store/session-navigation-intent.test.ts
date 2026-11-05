import { beforeEach, expect, it } from 'vitest';
import { useWorkspaceSessionStore } from './workspace-session-store';
import { reserveSessionNavigationIntent, releaseSessionNavigationIntent, isSessionNavigationIntentCurrent } from './session-navigation-intent';
import { canSwapSessions } from '../model/column-swap';
beforeEach(() => useWorkspaceSessionStore.getState().reset());
it('blocks exchange during save preparation and releases a refused or unused intent', () => {
  const intent = reserveSessionNavigationIntent('column-1', 'history-entry');
  expect(canSwapSessions(useWorkspaceSessionStore.getState().sessions)).toBe(false);
  releaseSessionNavigationIntent(intent);
  expect(canSwapSessions(useWorkspaceSessionStore.getState().sessions)).toBe(true);
  expect(useWorkspaceSessionStore.getState().sessions['column-1'].navigation.transaction).toMatchObject({ phase: 'idle', entryId: undefined });
});
it('uses session identity when both sessions happen to have the same request number', () => {
  const first = reserveSessionNavigationIntent('column-1');
  const other = reserveSessionNavigationIntent('column-2');
  expect(first.requestId).toBe(other.requestId);
  useWorkspaceSessionStore.getState().swapColumnContents(); // low-level placement only
  reserveSessionNavigationIntent('column-2');
  expect(isSessionNavigationIntentCurrent(first)).toBe(true);
  expect(isSessionNavigationIntentCurrent(other)).toBe(false);
});
it('never releases a newer preparation or a loader which consumed the intent', () => {
  const first = reserveSessionNavigationIntent('column-1');
  const second = reserveSessionNavigationIntent('column-1');
  releaseSessionNavigationIntent(first);
  expect(useWorkspaceSessionStore.getState().sessions['column-1'].navigation.transaction.phase).toBe('preparing');
  useWorkspaceSessionStore.getState().updateSession('column-1', (session) => ({ ...session, navigation: {
    ...session.navigation, transaction: { ...session.navigation.transaction, phase: 'loading' },
  } }));
  releaseSessionNavigationIntent(second);
  expect(useWorkspaceSessionStore.getState().sessions['column-1'].navigation.transaction.phase).toBe('loading');
});
