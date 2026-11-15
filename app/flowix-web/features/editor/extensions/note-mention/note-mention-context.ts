import { Extension } from '@tiptap/core';

export interface NoteMentionContextStorage {
  getNotebookId: () => string | null | undefined;
}

declare module '@tiptap/core' {
  interface Storage {
    noteMentionContext: NoteMentionContextStorage;
  }
}

/** Supplies the owning notebook dynamically to the note mention picker. */
export const NoteMentionContext = Extension.create<{
  getNotebookId: () => string | null | undefined;
}>({
  name: 'noteMentionContext',

  addOptions() {
    return { getNotebookId: () => null };
  },

  addStorage() {
    return {
      getNotebookId: () => this.options.getNotebookId(),
    };
  },
});
