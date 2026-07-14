import { create } from 'zustand';

import { getNotebookTodoCount } from '@features/memo/services/memo-list-metadata-service';

interface TodoCountStore {
  counts: Record<string, number>;
  setTodoCount: (notebookId: string, count: number) => void;
  loadTodoCount: (notebookId: string) => Promise<void>;
}

export const useTodoCountStore = create<TodoCountStore>()((set) => ({
  counts: {},

  setTodoCount: (notebookId, count) => {
    set((state) => ({
      counts: {
        ...state.counts,
        [notebookId]: count,
      },
    }));
  },

  loadTodoCount: async (notebookId) => {
    const count = await getNotebookTodoCount(notebookId);
    set((state) => ({
      counts: {
        ...state.counts,
        [notebookId]: count,
      },
    }));
  },
}));
