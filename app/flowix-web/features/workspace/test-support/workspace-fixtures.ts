import { useWorkColumnStore, type WorkColumnStore } from '@features/workspace/store/work-column-store';
import { useBrowserColumnStore } from '@features/workspace/store/browser-column-store';
import { getColumnSessionId, useWorkspaceSessionStore } from '@features/workspace/store/workspace-session-store';
import { fromBrowserEntry } from '@features/workspace/store/session-legacy-projections';
import { sessionTargetKey } from '@features/workspace/model/session-target-key';
import { emptySessionTransaction } from '@features/workspace/model/session-navigation';

type WorkFixture = Partial<WorkColumnStore>;
type BrowserFixture = Partial<ReturnType<typeof useBrowserColumnStore.getState>>;

/** Test setup only. Production read models deliberately have no state patch API. */
export function seedWorkColumn(input: WorkFixture | ((state: WorkColumnStore) => WorkFixture), _replace?: boolean) {
  const previous = useWorkColumnStore.getState();
  const patch = typeof input === 'function' ? input(previous) : input;
  const next = { ...previous, ...patch };
  useWorkspaceSessionStore.getState().updateSession(getColumnSessionId('column-1'), (session) => {
    const { target, showWorkColumnLoading, ...transaction } = next.navigation;
    const before = session.navigation.current;
    const same = before && sessionTargetKey(before.target) === sessionTargetKey(target);
    const current = target.kind === 'empty' ? null : {
      id: same ? before.id : 'surface:' + crypto.randomUUID(), target,
      title: same ? before.title : '', icon: same ? before.icon : null, openedAt: same ? before.openedAt : 0,
    };
    return { ...session, notebookSwitchesInFlight: next.notebookSwitchesInFlight,
      navigation: { ...session.navigation, current, transaction: { ...transaction, showBlockingLoading: showWorkColumnLoading } } };
  });
}
export function seedBrowserColumn(input: BrowserFixture | ((state: ReturnType<typeof useBrowserColumnStore.getState>) => BrowserFixture)) {
  const previous = useBrowserColumnStore.getState();
  const patch = typeof input === 'function' ? input(previous) : input;
  const next = { ...previous, ...patch };
  useWorkspaceSessionStore.getState().updateSession(getColumnSessionId('column-2'), (session) => {
    const current = next.current ? fromBrowserEntry(next.current) : null;
    return { ...session, navigation: { current,
      backStack: next.backStack.map((entry) => fromBrowserEntry(entry)),
      forwardStack: next.forwardStack.map((entry) => fromBrowserEntry(entry)),
      transaction: { ...emptySessionTransaction(), phase: current ? 'committed' : 'idle' } },
      viewStates: current && next.webRuntime ? { ...session.viewStates, [current.id]: { webRuntime: next.webRuntime } } : session.viewStates,
    };
  });
  useWorkspaceSessionStore.getState().setBrowserLayout({ visible: next.visible, splitRatio: next.splitRatio });
}
