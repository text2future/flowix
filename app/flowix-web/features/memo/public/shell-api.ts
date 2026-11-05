import { useShallow } from 'zustand/react/shallow';
import { useNoteStore } from '@features/memo/store/note-store';
import type { NoteTemplate } from '@platform/tauri/client';

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

export { useShellSelectedNotebook, createShellNote, listShellNoteTemplates, createShellNoteFromTemplate } from './note-creation-api';

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

/** The one list data source that must be ready before the workspace is shown. */

export { useAccessSpaceSelectionCount, useAccessSpaceSelectedPaths, useAccessSpaceSelectionContentKinds } from '@features/memo/store/notebook-tree-selection-store';
