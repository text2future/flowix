import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { tags } from '../tauri/client';
import { STORAGE_KEYS } from '../constants';

export interface MemoTagItem {
  id: string;
  name: string;
}

interface TagStore {
  tags: MemoTagItem[];
  selectedTagId: string | null;
  setTags: (tags: MemoTagItem[]) => void;
  addTag: (tag: MemoTagItem) => void;
  updateTag: (id: string, name: string) => void;
  removeTag: (id: string) => void;
  setSelectedTagId: (id: string | null) => void;
  loadTags: () => Promise<void>;
  createTag: (name: string) => Promise<MemoTagItem | null>;
  renameTag: (id: string, name: string) => Promise<MemoTagItem | null>;
  deleteTag: (id: string) => Promise<boolean>;
}

export const useTagStore = create<TagStore>()(
  persist(
    (set, get) => ({
      tags: [],
      selectedTagId: null,

      setTags: (tags) => set({ tags: [...tags].sort((a, b) => a.name.localeCompare(b.name)) }),

      addTag: (tag) => set((state) => ({
        tags: [...state.tags, tag].sort((a, b) => a.name.localeCompare(b.name)),
      })),

      updateTag: (id, name) => set((state) => ({
        tags: state.tags.map(t => t.id === id ? { ...t, name } : t)
          .sort((a, b) => a.name.localeCompare(b.name)),
      })),

      removeTag: (id) => set((state) => ({
        tags: state.tags.filter(t => t.id !== id),
      })),

      setSelectedTagId: (id) => set({ selectedTagId: id }),

      loadTags: async () => {
        const response = await tags.getAll();
        set({ tags: response.tags });
      },

      createTag: async (name: string) => {
        const tag = await tags.create(name);
        if (tag) {
          get().addTag(tag);
        }
        return tag;
      },

      renameTag: async (id: string, name: string) => {
        const tag = await tags.rename(id, name);
        if (tag) {
          get().updateTag(id, name);
        }
        return tag;
      },

      deleteTag: async (id: string) => {
        const success = await tags.delete(id);
        if (success) {
          get().removeTag(id);
        }
        return success;
      },
    }),
    {
      name: STORAGE_KEYS.TAG,
    }
  )
);