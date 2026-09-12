export { MemoList } from '@features/memo/components/memo-list';
export { useMemoListHoverPreview } from '@features/memo/components/use-memo-list-hover-preview';
export { MemoListTitlebarWin } from '@features/memo/components/memo-list-titlebar-win';
export { MemoListTitlebarMac } from '@features/memo/components/memo-list-titlebar-mac';
export { NoteNavigationPanel } from '@features/memo/components/note-navigation-panel';
export { NoteNavigationDrawer } from '@features/memo/components/note-navigation-drawer';
export { MemoListServicesHost } from '@features/memo/components/memo-list-services-host';
export { useNotebookTodoCount } from '@features/memo/components/use-notebook-todo-count';
export {
  type MemoItem,
  type Notebook,
} from '@features/memo/store';

export function useShellMemoViewModel() {
  return useMemoStore(useShallow((state) => ({
    memos: state.memos,
    notebooks: state.notebooks,
    selectedMemo: state.selectedMemo,
    selectedNotebook: state.selectedNotebook,
    middleColumnView: state.middleColumnView,
    activeFilter: state.activeFilter,
    activePluginId: state.activePluginId,
    activeSort: state.activeSort,
    setActiveFilter: state.setActiveFilter,
    loadMemos: state.loadMemos,
    triggerRefresh: state.triggerRefresh,
    updateMemoMeta: state.updateMemoMeta,
    setMemoColors: state.setMemoColors,
  })));
}
import { useShallow } from 'zustand/react/shallow';
import { useMemoStore } from '@features/memo/store/memo-store';
