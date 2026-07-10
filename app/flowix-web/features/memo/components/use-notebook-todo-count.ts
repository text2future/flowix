import { useEffect } from 'react';

import { useTodoCountStore } from '@features/memo/store/todo-count-store';

export function useNotebookTodoCount(selectedNotebookId: string | undefined) {
  const storedCount = useTodoCountStore((state) =>
    selectedNotebookId ? state.counts[selectedNotebookId] : undefined
  );
  const loadTodoCount = useTodoCountStore((state) => state.loadTodoCount);

  useEffect(() => {
    let cancelled = false;

    async function loadNotebookTodoCount() {
      if (!selectedNotebookId) {
        return;
      }

      try {
        await loadTodoCount(selectedNotebookId);
      } catch (error) {
        if (!cancelled) {
          console.warn('[useNotebookTodoCount] Failed to read memo metadata todos:', error);
        }
      }
    }

    loadNotebookTodoCount();

    return () => {
      cancelled = true;
    };
  }, [selectedNotebookId, loadTodoCount]);

  return storedCount ?? 0;
}
