import { useShallow } from 'zustand/react/shallow';
import { notebooks as notebooksClient } from '@platform/tauri/client';
import {
  useNoteStore,
  type NoteLibraryStore,
  type Notebook,
} from '@features/memo/store/note-store';

/** Memo-list and notebook-selection capabilities required by workspace flows. */
export type WorkspaceMemoState = Pick<
  NoteLibraryStore,
  | 'notebooks'
  | 'selectedNotebook'
  | 'selectedNotebookId'
  | 'selectedNote'
  | 'setNotebooks'
  | 'setSelectedNotebook'
  | 'setSelectedNote'
  | 'setActiveFilter'
  | 'setActivePluginId'
  | 'loadNotes'
  | 'loadNotebooks'
>;

export function getWorkspaceMemoState(): WorkspaceMemoState {
  return useNoteStore.getState();
}

/** Reactive workspace selectors for app-level notebook navigation. */
export function useWorkspaceMemoViewModel() {
  return useNoteStore(useShallow((state) => ({
    notebooks: state.notebooks,
    selectedNotebook: state.selectedNotebook,
    startupPhase: state.startupPhase,
    setActiveFilter: state.setActiveFilter,
    setActivePluginId: state.setActivePluginId,
    triggerRefresh: state.triggerRefresh,
  })));
}

export function getSelectedWorkspaceNotebookId(): string | null {
  const state = useNoteStore.getState();
  return state.selectedNotebookId ?? state.selectedNotebook?.id ?? null;
}

// The navigation transaction and the main-window synchronization effect can
// observe the same selection change. Keep the last successful native sync so
// the effect does not start a second migration pass for the same notebook.
let lastPersistedWorkspaceNotebookId: string | null | undefined;
let requestedWorkspaceNotebookId: string | null | undefined;
let workspaceNotebookRequestRevision = 0;
let workspaceNotebookTransition: Promise<void> = Promise.resolve();

export function getLastPersistedWorkspaceNotebookId(): string | null | undefined {
  return lastPersistedWorkspaceNotebookId;
}

/** Whether the selected notebook needs a native sync or would supersede one in flight. */
export function needsWorkspaceNotebookPersistence(notebookId: string | null): boolean {
  return (requestedWorkspaceNotebookId !== undefined && requestedWorkspaceNotebookId !== notebookId)
    || (lastPersistedWorkspaceNotebookId !== undefined && lastPersistedWorkspaceNotebookId !== notebookId);
}

/** Persist the notebook selected by a workspace navigation transaction. */
export function setCurrentWorkspaceNotebook(
  notebook: Pick<Notebook, 'id'> | string | null,
): Promise<void> {
  const notebookId = typeof notebook === 'string' ? notebook : notebook?.id ?? null;
  const revision = ++workspaceNotebookRequestRevision;
  requestedWorkspaceNotebookId = notebookId;
  const operation = workspaceNotebookTransition.then(async () => {
    // Coalesce requests that have not reached native yet. An in-flight call
    // still completes first; the newest request then restores the intended id.
    if (revision !== workspaceNotebookRequestRevision || lastPersistedWorkspaceNotebookId === notebookId) return;
    await notebooksClient.setCurrent(notebookId);
    lastPersistedWorkspaceNotebookId = notebookId;
  });
  workspaceNotebookTransition = operation.then(() => undefined, () => undefined).finally(() => {
    if (revision === workspaceNotebookRequestRevision) requestedWorkspaceNotebookId = undefined;
  });
  return operation;
}

export type { Notebook };

export { updateNoteLinksAfterMove } from '../services/note-link-rewriter';
