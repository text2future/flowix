import { useEffect, useState } from 'react';

import { getNotebookTodoCount } from '../../../lib/services/memo-list-metadata-service';

export function useNotebookTodoCount(
  selectedNotebookPath: string | undefined,
  refreshTrigger: number,
  memoCount: number,
) {
  const [todoCount, setTodoCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function loadNotebookTodoCount() {
      if (!selectedNotebookPath) {
        setTodoCount(0);
        return;
      }

      try {
        const count = await getNotebookTodoCount(selectedNotebookPath);
        if (cancelled) return;
        setTodoCount(count);
      } catch (error) {
        if (!cancelled) {
          console.warn('[useNotebookTodoCount] Failed to read memo metadata todos:', error);
          setTodoCount(0);
        }
      }
    }

    loadNotebookTodoCount();

    return () => {
      cancelled = true;
    };
  }, [selectedNotebookPath, refreshTrigger, memoCount]);

  return todoCount;
}
