import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useCustomFilterStore } from '@features/memo/store/custom-filter-store';
import { useNoteStore } from '@features/memo/store/note-store';
import { noteRepository } from '@features/memo/services/note-repository';

export { MemoList } from '@features/memo/components/memo-list';
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
export { startNotebookImportWithMonitoring } from '@features/memo/services/notebook-creation-service';

export function useShellSelectedNotebook() {
  return useNoteStore((state) => state.selectedNotebook);
}

export async function createShellNote(notebookId: string) {
  const created = await noteRepository.create(undefined, notebookId);
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

export function useShellDocumentListTitle(input: {
  notebookId: string | null;
  folderPath: string;
  customFilterId: string | null;
} | null): string | null {
  const loadNotebookFilters = useCustomFilterStore((state) => state.loadNotebookFilters);
  const customFilter = useCustomFilterStore((state) => (
    input && input.notebookId && input.customFilterId
      ? state.filtersByNotebook[input.notebookId]?.find((filter) => filter.id === input.customFilterId) ?? null
      : null
  ));

  useEffect(() => {
    if (input?.notebookId) void loadNotebookFilters(input.notebookId);
  }, [input?.notebookId, loadNotebookFilters]);

  if (!input) return null;
  return customFilter?.name
    || input.folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
    || input.folderPath;
}
