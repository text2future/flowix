import type { WorkspaceSession } from './workspace-session';
import { sessionTargetKey } from './session-target-key';
import { SESSION_HISTORY_LIMIT } from './session-navigation';
import type { SessionSurfaceTarget } from './session-target';

export interface CommitSessionTargetOptions {
  history?: 'push' | 'skip';
  expectedRequestId?: number;
  entryId?: string;
  title?: string;
  icon?: string | null;
}

/** Both runtimes commit the same current-entry/history transaction. */
export function commitSessionTarget(
  session: WorkspaceSession,
  target: SessionSurfaceTarget,
  options: CommitSessionTargetOptions = {},
): WorkspaceSession {
  const navigation = session.navigation;
  if (options.expectedRequestId !== undefined && options.expectedRequestId !== navigation.transaction.requestId) return session;
  const previous = navigation.current;
  const same = previous !== null && sessionTargetKey(previous.target) === sessionTargetKey(target);
  const requested = options.entryId ?? (navigation.transaction.phase === 'failed' ? undefined : navigation.transaction.entryId);
  const occupied = requested && [...navigation.backStack, ...navigation.forwardStack].some((entry) => entry.id === requested);
  const id = same && options.history !== 'skip' ? previous.id : options.history !== 'skip' && occupied && !same ? 'surface:' + crypto.randomUUID()
    : requested ?? (same ? previous.id : 'surface:' + crypto.randomUUID());
  const retained = options.history === 'skip' ? [...navigation.backStack, ...navigation.forwardStack].find((entry) => entry.id === id) : undefined;
  const current = target.kind === 'empty' ? null : {
    id, target, title: retained?.title ?? options.title ?? (same ? previous.title : ''),
    icon: retained ? retained.icon : options.icon !== undefined ? options.icon : same ? previous.icon : null,
    openedAt: retained?.openedAt ?? (same ? previous.openedAt : Date.now()),
  };
  const push = options.history === 'push' && !same && current !== null;
  return { ...session, navigation: {
    current,
    backStack: push && previous ? [...navigation.backStack, previous].slice(-SESSION_HISTORY_LIMIT) : navigation.backStack,
    forwardStack: push ? [] : navigation.forwardStack,
    transaction: { ...navigation.transaction, phase: current ? 'committed' : 'idle',
      requestId: options.expectedRequestId ?? navigation.transaction.requestId + 1,
      pendingTarget: null, showBlockingLoading: false, failure: null, retryToken: null, entryId: undefined },
  } };
}
