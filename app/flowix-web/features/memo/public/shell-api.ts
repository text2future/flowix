import { useShallow } from 'zustand/react/shallow';
import { useNoteStore } from '@features/memo/store/note-store';
import { noteRepository } from '@features/memo/services/note-repository';
import { notes as noteApi, type NoteTemplate } from '@platform/tauri/client';

export { MemoList } from '@features/memo/components/memo-list';
export { useNotebookNoteIcon } from '@features/memo/hooks/use-notebook-note-icon';
export { NotebookNoteIcon } from '@features/memo/components/notebook-note-icon';
export { NotebookTreeFileIcon } from '@features/memo/components/notebook-tree-file-icon';
export { useMemoListHoverPreview } from '@features/memo/components/use-memo-list-hover-preview';
export { MemoListTitlebarWin } from '@features/memo/components/memo-list-titlebar-win';
export { MemoListTitlebarMac } from '@features/memo/components/memo-list-titlebar-mac';
export { NoteNavigationPanel } from '@features/memo/components/note-navigation-panel';
export {
  NoteNavigationDrawer,
  type NoteNavigationDrawerPhase,
} from '@features/memo/components/note-navigation-drawer';
export { MemoListServicesHost } from '@features/memo/components/memo-list-services-host';
export { useNotebookTodoCount } from '@features/memo/components/use-notebook-todo-count';
export {
  type MemoItem,
  type Notebook,
} from '@features/memo/store';
export type { NoteTemplate };
export { startNotebookImportWithMonitoring } from '@features/memo/services/notebook-creation-service';

export function useShellSelectedNotebook() {
  return useNoteStore((state) => state.selectedNotebook);
}

export async function createShellNote(notebookId: string) {
  const created = await noteRepository.create(undefined, notebookId);
  useNoteStore.getState().upsertCreatedNote(created);
  return created;
}

export function listShellNoteTemplates(): Promise<NoteTemplate[]> {
  return noteApi.listTemplates();
}

export async function createShellNoteFromTemplate(templateId: string, notebookId: string) {
  const created = await noteApi.createFromTemplate(templateId, notebookId);
  useNoteStore.getState().upsertCreatedNote(created);
  return created;
}

export function useShellMemoViewModel() {
  return useNoteStore(useShallow((state) => ({
    notebooks: state.notebooks,
    selectedNotebook: state.selectedNotebook,
    startupPhase: state.startupPhase,
    middleColumnView: state.middleColumnView,
    activeFilter: state.activeFilter,
    activePluginId: state.activePluginId,
    activeSort: state.activeSort,
    setActiveFilter: state.setActiveFilter,
    setMiddleColumnView: state.setMiddleColumnView,
    loadNotes: state.loadNotes,
    triggerRefresh: state.triggerRefresh,
  })));
}

export function showAgentConversationsView(): void {
  useNoteStore.getState().setMiddleColumnView('conversations');
}

/** The one list data source that must be ready before the workspace is shown. */

export { useAccessSpaceSelectionCount, useAccessSpaceSelectedPaths, useAccessSpaceSelectionContentKinds } from '@features/memo/store/notebook-tree-selection-store';
