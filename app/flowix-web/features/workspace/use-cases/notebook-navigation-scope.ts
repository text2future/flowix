import { getSessionId, useWorkspaceSessionStore } from '../store/workspace-session-store';
import type { WorkspaceColumnId } from '../model/surface-contract';
import { getWorkspaceMemoState, needsWorkspaceNotebookPersistence, setCurrentWorkspaceNotebook, type Notebook } from '@features/memo/public/workspace-api';

/** Notebook selection and compensation shared by file, folder and explicit selection. */
export function createNotebookNavigationScope(isCurrentNavigation: (requestId: number) => boolean, columnId: WorkspaceColumnId = 'column-1') {
  const previousNotebook = getWorkspaceMemoState().selectedNotebook;
  const previousNote = getWorkspaceMemoState().selectedNote;
  let switched = false;
  return {
    async switchTo(notebookId: string, requestId: number, knownNotebook?: Notebook) {
      const state = getWorkspaceMemoState();
      if (getSessionId(0) !== columnId || !isCurrentNavigation(requestId)) return;
      const selectionAlreadyMatches = notebookId === (state.selectedNotebookId ?? state.selectedNotebook?.id);
      if (selectionAlreadyMatches && !needsWorkspaceNotebookPersistence(notebookId)) return;
      const store = useWorkspaceSessionStore.getState();
      store.updateSession(columnId, session => ({ ...session, notebookSwitchesInFlight: session.notebookSwitchesInFlight + 1 }));
      try {
        await setCurrentWorkspaceNotebook(notebookId);
        switched = true;
        if (!isCurrentNavigation(requestId)) return;
        if (selectionAlreadyMatches) return;
        let notebook = knownNotebook ?? getWorkspaceMemoState().notebooks.find(item => item.id === notebookId);
        if (!notebook) {
          await getWorkspaceMemoState().loadNotebooks();
          if (!isCurrentNavigation(requestId)) return;
          notebook = getWorkspaceMemoState().notebooks.find(item => item.id === notebookId);
        }
        if (!notebook) throw new Error('Notebook is unavailable');
        getWorkspaceMemoState().setSelectedNotebook(notebook);
        getWorkspaceMemoState().setSelectedNote(null);
        await getWorkspaceMemoState().loadNotes({ notebookId });
      } finally {
        store.updateSession(columnId, session => ({ ...session, notebookSwitchesInFlight: Math.max(0, session.notebookSwitchesInFlight - 1) }));
      }
    },
    async rollback(requestId: number) {
      if (getSessionId(0) !== columnId || !isCurrentNavigation(requestId)) return;
      if (switched) {
        await setCurrentWorkspaceNotebook(previousNotebook?.id ?? null);
        if (!isCurrentNavigation(requestId)) return;
        getWorkspaceMemoState().setSelectedNotebook(previousNotebook);
        if (previousNotebook) await getWorkspaceMemoState().loadNotes({ notebookId: previousNotebook.id });
      }
      if (isCurrentNavigation(requestId)) getWorkspaceMemoState().setSelectedNote(previousNote);
    },
  };
}
