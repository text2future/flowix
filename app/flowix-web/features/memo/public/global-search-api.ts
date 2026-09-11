import { useShallow } from 'zustand/react/shallow';
import { useMemoStore } from '@features/memo/store/memo-store';
import { useTagStore } from '@features/memo/store/tag-store';

export { NotebookIcon } from '@features/memo/components/notebook-icon';
export { openMemoSession } from '@features/memo/use-cases/open-memo-session';
export type { Notebook } from '@features/memo/store/memo-store';

export function useGlobalSearchMemoViewModel() {
  const memo = useMemoStore(useShallow((state) => ({
    selectedNotebook: state.selectedNotebook,
    memosInStore: state.memos,
    notebooks: state.notebooks,
    activeFilter: state.activeFilter,
    setActiveFilter: state.setActiveFilter,
    createMemo: state.createMemo,
    handleMemoCreated: state.handleMemoCreated,
  })));
  const setSelectedTagId = useTagStore((state) => state.setSelectedTagId);
  return { ...memo, setSelectedTagId };
}
