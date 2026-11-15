import { useNoteStore, type Notebook } from '../store/note-store';

/** Reactive lookup for a notebook that can own notebook-scoped resources. */
export function useNotebookById(notebookId: string | null): Notebook | undefined {
  return useNoteStore((state) => state.notebooks.find((notebook) => notebook.id === notebookId && !notebook.missing));
}
