import type { WorkspaceSessionId } from '../model/workspace-session';
import type { SessionSurfaceTarget } from '../model/session-target';
import type { SessionNavigationEntry } from '../model/session-navigation';
import { emptySessionTransaction } from '../model/session-navigation';
import { getColumnSessionId, useWorkspaceSessionStore } from './workspace-session-store';

/** In-place target maintenance must preserve entry identity and navigation intent. */
export function updateWorkColumnTargets(transform: (target: SessionSurfaceTarget) => SessionSurfaceTarget) {
  useWorkspaceSessionStore.getState().updateSession(getColumnSessionId('column-1'), (session) => {
    const navigation = session.navigation;
    const current = navigation.current;
    const target = current ? transform(current.target) : null;
    const pending = navigation.transaction.pendingTarget;
    const previous = navigation.transaction.previousTarget;
    const pendingTarget = pending ? transform(pending) : null;
    const previousTarget = previous ? transform(previous) : null;
    if (target === (current?.target ?? null) && pendingTarget === pending && previousTarget === previous) return session;
    return { ...session, navigation: { ...navigation,
      current: current && target ? { ...current, target } : current,
      transaction: { ...navigation.transaction, pendingTarget, previousTarget },
    } };
  });
}

export function mapSessionEntries(id: WorkspaceSessionId, transform: (entry: SessionNavigationEntry) => SessionNavigationEntry | null) {
  useWorkspaceSessionStore.getState().updateSession(id, (session) => {
    const navigation = session.navigation;
    const map = (entries: SessionNavigationEntry[]) => {
      const next = entries.flatMap((entry) => { const value = transform(entry); return value ? [value] : []; });
      return next.length === entries.length && next.every((entry, index) => entry === entries[index]) ? entries : next;
    };
    const current = navigation.current ? transform(navigation.current) : null;
    if (current?.target.kind === 'collection-reference') throw new Error('An unresolved reference cannot become the current surface');
    const backStack = map(navigation.backStack);
    const forwardStack = map(navigation.forwardStack);
    if (current === navigation.current && backStack === navigation.backStack && forwardStack === navigation.forwardStack) return session;
    return { ...session, navigation: { ...navigation,
      current: current as typeof navigation.current, backStack, forwardStack,
      transaction: navigation.current && !current
        ? { ...emptySessionTransaction(), requestId: navigation.transaction.requestId + 1 } : navigation.transaction,
    } };
  });
}
