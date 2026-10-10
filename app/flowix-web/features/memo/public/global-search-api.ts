import { useShallow } from 'zustand/react/shallow';
import { useNoteStore } from '@features/memo/store/note-store';
import { useTagStore } from '@features/memo/store/tag-store';

export { NotebookIcon } from '@features/memo/components/notebook-icon';
export { openNotebookNote } from '@features/memo/use-cases/open-notebook-note';
export type { Notebook } from '@features/memo/store/note-store';

export function useGlobalSearchMemoViewModel() {
  const memo = useNoteStore(useShallow((state) => ({
    selectedNotebook: state.selectedNotebook,
    notebooks: state.notebooks,
    activeFilter: state.activeFilter,
    setActiveFilter: state.setActiveFilter,
    createNote: state.createNote,
    loadNotes: state.loadNotes,
  })));
  const setSelectedTagId = useTagStore((state) => state.setSelectedTagId);
  return { ...memo, setSelectedTagId };
}
