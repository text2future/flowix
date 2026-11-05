import { getSessionId } from '../store/workspace-session-store';
import { sessionFor } from '../model/workspace-session';
import { sessionTargetKey } from '../model/session-target-key';
import { useWorkspaceSessionStore } from '../store/workspace-session-store';
import type { FileBrowserContext, FileBrowserTarget } from '../model/surface-target';

export { resolveFileBrowserContext } from '../use-cases/file-browser-context';
export { setCollectionActiveView } from '../use-cases/collection-view-state';

/** Ignore events from a file-browser view retired by a newer navigation. */
export function updatePrimaryFileBrowserContext(expected: FileBrowserTarget, patch: Partial<FileBrowserContext>) {
  useWorkspaceSessionStore.getState().updateSession(getSessionId('column-1'), (session) => {
    const current = session.navigation.current;
    const target = current?.target;
    if (session.navigation.transaction.phase === 'loading' || target?.kind !== 'file-browser'
      || target.activeFilePath !== expected.activeFilePath || target.folderPath !== expected.folderPath) return session;
    return { ...session, navigation: { ...session.navigation,
      current: current ? { ...current, target: { ...target, ...patch } } : null } };
  });
}

/** Rendering keys are session-owned, so changing a URL never remounts its WebView. */
export function primarySurfaceInstanceId(target: import('../store/work-column-target').WorkColumnTarget, fallback: string): string {
  const current = sessionFor(useWorkspaceSessionStore.getState(), 'column-1').navigation.current;
  return current?.target === target ? current.id : fallback;
}

export function primaryCurrentEntryId(): string | null {
  return sessionFor(useWorkspaceSessionStore.getState(), 'column-1').navigation.current?.id ?? null;
}

/** Ignore late presentation events from a Surface superseded by navigation. */
export function updatePrimarySurfaceMetadata(entryId: string | null, metadata: { title?: string; icon?: string }) {
  if (!entryId) return;
  useWorkspaceSessionStore.getState().updateSession(getSessionId('column-1'), (session) => {
    const current = session.navigation.current;
    if (!current || current.id !== entryId
      || ((metadata.title === undefined || metadata.title === current.title) && (metadata.icon === undefined || metadata.icon === current.icon))) return session;
    return { ...session, navigation: { ...session.navigation, current: { ...current,
      ...(metadata.title !== undefined ? { title: metadata.title } : {}),
      ...(metadata.icon !== undefined ? { icon: metadata.icon } : {}),
    } } };
  });
}

/** Bind at resolution time so a retained renderer never adopts a newer entry. */
export function primaryEntryIdForTarget(target: import('../store/work-column-target').WorkColumnTarget): string | null {
  const current = sessionFor(useWorkspaceSessionStore.getState(), 'column-1').navigation.current;
  return current && sessionTargetKey(current.target) === sessionTargetKey(target) ? current.id : null;
}

export { resolveSessionDocumentContext } from '../use-cases/session-document-context';

export { updateWorkColumnTargets } from '../store/session-mutations';
