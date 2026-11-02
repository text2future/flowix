import { getWorkspaceMemoState } from '@features/memo/public/workspace-api';
import { useWorkspaceSessionStore, getSessionAtHost } from '../store/workspace-session-store';
import { sessionTargetKey } from '../model/session-target-key';
import type { WorkspaceSessionId } from '../model/workspace-session';
import type { WorkspaceSurfaceHost } from '../model/surface-contract';
import type { SessionNavigationEntry } from '../model/session-navigation';

const sequences: Record<WorkspaceSessionId, number> = { 'primary-session': 0, 'secondary-session': 0 };

/** Direct canonical state: there are no per-container navigation read models. */
export function getWorkspaceSessionNavigation(sessionId: WorkspaceSessionId) {
  return useWorkspaceSessionStore.getState().sessions[sessionId].navigation;
}

/** One history algorithm for both containers, with save/load delegated to Surface opening. */
export async function navigateWorkspaceSession(sessionId: WorkspaceSessionId, direction: 'back' | 'forward'): Promise<boolean | null> {
  const sequence = ++sequences[sessionId];
  const session = useWorkspaceSessionStore.getState().sessions[sessionId];
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
    if (sequences[sessionId] !== sequence) return false;
    const result = await openWorkspaceSurface({
      host: session.runtime === 'primary-runtime' ? 'main-third' : 'browser-column', target,
      options: { history: 'skip', navigationEntryId: next.id },
    });
    if (result.status === 'cancelled') return null;
  } catch {
    return false;
  }
  if (sequences[sessionId] !== sequence) return false;
  let committed = false;
  useWorkspaceSessionStore.getState().updateSession(sessionId, (latest) => {
    const navigation = latest.navigation;
    const currentStack = direction === 'back' ? navigation.backStack : navigation.forwardStack;
    if (currentStack !== stack || navigation.current?.id !== next.id
      || sessionTargetKey(navigation.current.target) !== sessionTargetKey(next.target)) return latest;
    const append = (items: SessionNavigationEntry[]) => before.current
      ? [...items, before.current].slice(-100) : items;
    committed = true;
    return { ...latest, navigation: { ...navigation,
      backStack: direction === 'back' ? stack.slice(0, -discardCount) : append(before.backStack),
      forwardStack: direction === 'forward' ? stack.slice(0, -discardCount) : append(before.forwardStack),
    } };
  });
  return committed;
}

export function navigateWorkspaceHost(host: WorkspaceSurfaceHost, direction: 'back' | 'forward') {
  return navigateWorkspaceSession(getSessionAtHost(host), direction);
}

export function subscribeWorkspaceSessionNavigation(listener: () => void) {
  return useWorkspaceSessionStore.subscribe(listener);
}
