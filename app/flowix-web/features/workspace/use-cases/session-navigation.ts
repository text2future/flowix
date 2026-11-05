import { getSessionId } from '../store/workspace-session-store';
import { SESSION_HISTORY_LIMIT } from '../model/session-limits';
import { sessionFor } from '../model/workspace-session';
import { getWorkspaceMemoState } from '@features/memo/public/workspace-api';
import { useWorkspaceSessionStore, getColumnSessionId, getColumnIdForSession } from '../store/workspace-session-store';
import { sessionTargetKey } from '../model/session-target-key';
import type { WorkspaceSessionReference } from '../model/workspace-session';
import type { WorkspaceColumnId } from '../model/surface-contract';
import type { SessionNavigationEntry } from '../model/session-navigation';

const sequences = new Map<WorkspaceSessionReference, number>();

/** Direct canonical state: there are no per-container navigation read models. */
export function getWorkspaceSessionNavigation(sessionId: WorkspaceSessionReference) {
  return sessionFor(useWorkspaceSessionStore.getState(), sessionId).navigation;
}

/** One history algorithm for both containers, with save/load delegated to Surface opening. */
export async function navigateWorkspaceSession(sessionId: WorkspaceSessionReference, direction: 'back' | 'forward'): Promise<boolean | null> {
  sessionId = sessionFor(useWorkspaceSessionStore.getState(), sessionId).id;
  const sequence = (sequences.get(sessionId) ?? 0) + 1;
  sequences.set(sessionId, sequence);
  const session = sessionFor(useWorkspaceSessionStore.getState(), sessionId);
  const before = session.navigation;
  const stack = direction === 'back' ? before.backStack : before.forwardStack;
  const currentKey = before.current ? sessionTargetKey(before.current.target) : null;
  let discardCount = 0;
  let next: SessionNavigationEntry | undefined;
  for (let index = stack.length - 1; index >= 0; index--) {
    discardCount++;
    if (sessionTargetKey(stack[index].target) !== currentKey) { next = stack[index]; break; }
  }
  if (!next || next.target.kind === 'empty') return false;
  let target = next.target;
  if (target.kind === 'folder-collection' && !target.notebookPath) {
    const notebookId = target.notebookId;
    const notebook = getWorkspaceMemoState().notebooks.find((book) => book.id === notebookId);
    if (!notebook) return false;
    target = { ...target, notebookPath: notebook.path };
  }
  try {
    // Loading the renderer adapter is optional; session state itself has no renderer dependency.
    const { openWorkspaceSurface } = await import('./surface-opening');
    if (sequences.get(sessionId) !== sequence) return false;
    const result = await openWorkspaceSurface({
      host: getColumnIdForSession(session.id), target,
      options: { history: 'skip', navigationEntryId: next.id },
    });
    if (result.status === 'cancelled') return null;
  } catch {
    return false;
  }
  if (sequences.get(sessionId) !== sequence) return false;
  let committed = false;
  useWorkspaceSessionStore.getState().updateSession(getSessionId(sessionId), (latest) => {
    const navigation = latest.navigation;
    const currentStack = direction === 'back' ? navigation.backStack : navigation.forwardStack;
    if (currentStack !== stack || navigation.current?.id !== next.id
      || sessionTargetKey(navigation.current.target) !== sessionTargetKey(next.target)) return latest;
    const append = (items: SessionNavigationEntry[]) => before.current
      ? [...items, before.current].slice(-SESSION_HISTORY_LIMIT) : items;
    committed = true;
    return { ...latest, navigation: { ...navigation,
      backStack: direction === 'back' ? stack.slice(0, -discardCount) : append(before.backStack),
      forwardStack: direction === 'forward' ? stack.slice(0, -discardCount) : append(before.forwardStack),
    } };
  });
  return committed;
}

export function navigateWorkspaceHost(host: WorkspaceColumnId, direction: 'back' | 'forward') {
  return navigateWorkspaceSession(getColumnSessionId(host), direction);
}

export function subscribeWorkspaceSessionNavigation(listener: () => void) {
  return useWorkspaceSessionStore.subscribe(listener);
}
