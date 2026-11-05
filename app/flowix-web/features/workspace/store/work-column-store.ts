import { getColumnSessionId, useWorkspaceSessionStore } from './workspace-session-store';
import type { SessionNavigationState } from '../model/session-navigation';
import { createWorkColumnView } from './session-read-models';
import { canonicalPath } from '@/lib/path';

import {
  EMPTY_WORK_COLUMN_TARGET,
  type WorkColumnNavigationState,
  type WorkColumnTarget,
} from './work-column-target';

/** Compatibility API for the first column. Canonical state belongs to WorkspaceSessionStore. */
export interface WorkColumnStore {
  navigation: WorkColumnNavigationState;
  notebookSwitchesInFlight: number;
  beginNavigation: (
    pendingTarget: WorkColumnTarget,
    retryToken: string | null,
    preservePreviousTarget?: boolean,
    showWorkColumnLoading?: boolean,
  ) => number;
  commitNavigation: (requestId: number, target: WorkColumnTarget, history?: 'push' | 'skip') => boolean;
  failNavigation: (requestId: number, error: unknown) => boolean;
  dismissNavigationFailure: () => string | null;
  isCurrentNavigation: (requestId: number) => boolean;
  beginNotebookSwitch: () => void;
  endNotebookSwitch: () => void;
  replaceExternalPath: (previousPath: string, path: string) => void;
}

/** Legacy read shape; actions write canonical session state directly. */
function navigation() {
  return useWorkspaceSessionStore.getState().sessions[getColumnSessionId('column-1')].navigation;
}
function updateNavigation(update: (state: SessionNavigationState) => SessionNavigationState) {
  useWorkspaceSessionStore.getState().updateSession(getColumnSessionId('column-1'), (session) => {
    const next = update(session.navigation);
    return next === session.navigation ? session : { ...session, navigation: next };
  });
}

export const useWorkColumnStore = createWorkColumnView<WorkColumnStore>({
  notebookSwitchesInFlight: 0,
  navigation: { phase: 'idle', showWorkColumnLoading: false, requestId: 0,
    target: EMPTY_WORK_COLUMN_TARGET, pendingTarget: null, previousTarget: null, failure: null, retryToken: null },
  beginNavigation: (pendingTarget, retryToken, preservePreviousTarget = false, showBlockingLoading = true) => {
    const requestId = navigation().transaction.requestId + 1;
    updateNavigation((state) => ({ ...state, transaction: { ...state.transaction,
      phase: 'loading', showBlockingLoading, requestId, pendingTarget,
      previousTarget: preservePreviousTarget ? state.transaction.previousTarget : state.current?.target ?? EMPTY_WORK_COLUMN_TARGET,
      failure: null, retryToken } }));
    return requestId;
  },
  commitNavigation: (requestId, target, history = 'skip') =>
    useWorkspaceSessionStore.getState().commitTarget(getColumnSessionId('column-1'), target, { expectedRequestId: requestId, history }),
  failNavigation: (requestId, error) => {
    if (navigation().transaction.requestId !== requestId) return false;
    updateNavigation((state) => ({ ...state, transaction: { ...state.transaction,
      phase: 'failed', showBlockingLoading: false,
      failure: { code: 'navigation-failed', message: error instanceof Error ? error.message : String(error),
        requestId, retryToken: state.transaction.retryToken } } }));
    return true;
  },
  dismissNavigationFailure: () => {
    const state = navigation();
    if (state.transaction.phase !== 'failed') return null;
    updateNavigation((current) => ({ ...current, transaction: { ...current.transaction,
      phase: current.current ? 'committed' : 'idle', showBlockingLoading: false,
      pendingTarget: null, failure: null, retryToken: null } }));
    return state.transaction.retryToken;
  },
  beginNotebookSwitch: () => useWorkspaceSessionStore.getState().updateSession(getColumnSessionId('column-1'),
    (session) => ({ ...session, notebookSwitchesInFlight: session.notebookSwitchesInFlight + 1 })),
  endNotebookSwitch: () => useWorkspaceSessionStore.getState().updateSession(getColumnSessionId('column-1'),
    (session) => ({ ...session, notebookSwitchesInFlight: Math.max(0, session.notebookSwitchesInFlight - 1) })),
  replaceExternalPath: (previousPath, path) => {
    const previousParent = canonicalPath(previousPath).replace(/\/[^/]*$/, '');
    const nextParent = canonicalPath(path).replace(/\/[^/]*$/, '');
    const replace = (target: WorkColumnTarget): WorkColumnTarget => (
      target.kind === 'external' && canonicalPath(target.path) === canonicalPath(previousPath)
        ? { ...target, path, fileBrowser: target.fileBrowser
          ? { ...target.fileBrowser, folderPath: target.fileBrowser.folderPath
            && canonicalPath(target.fileBrowser.folderPath) === previousParent ? nextParent : target.fileBrowser.folderPath }
          : undefined }
        : (target.kind === 'collection' || target.kind === 'table' || target.kind === 'media-library')
          && canonicalPath(target.filePath) === canonicalPath(previousPath) ? { ...target, filePath: path } : target
    );
    updateNavigation((state) => ({ ...state,
      current: state.current ? { ...state.current, target: replace(state.current.target) } : null,
      transaction: { ...state.transaction,
        pendingTarget: state.transaction.pendingTarget ? replace(state.transaction.pendingTarget) : null,
        previousTarget: state.transaction.previousTarget ? replace(state.transaction.previousTarget) : null } }));
  },
  isCurrentNavigation: (requestId) => navigation().transaction.requestId === requestId,
});
