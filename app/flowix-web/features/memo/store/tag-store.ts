import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { tags } from '@platform/tauri/client';
import { STORAGE_KEYS } from '@/lib/constants';

export interface MemoTagItem {
  id: string;
  name: string;
}

export interface MoveTagReport {
  affectedMemos: number;
  renamedTags: [string, string][];
}

interface TagStore {
  tags: MemoTagItem[];
  selectedTagId: string | null;
  metadataRefreshVersion: number;
  setTags: (tags: MemoTagItem[]) => void;
  addTag: (tag: MemoTagItem) => void;
  updateTag: (id: string, name: string) => void;
  removeTag: (id: string) => void;
  setSelectedTagId: (id: string | null) => void;
  triggerMetadataRefresh: () => void;
  loadTags: (notebookId?: string) => Promise<void>;
  createTag: (name: string) => Promise<MemoTagItem | null>;
  renameTag: (id: string, name: string) => Promise<MemoTagItem | null>;
  deleteTag: (id: string) => Promise<boolean>;
  /**
   * 移动 subtag: 把 `oldPath` 整棵子树重命名为 `newPath` (含 prefix
   * 替换), 批量改写所有受影响 memo 的 .md body + 同步 memo index。
   * 成功后 invalidateMentionTags + triggerMetadataRefresh, 触发面板 /
   * 下拉 / 列表重拉。
   */
  moveTag: (
    notebookId: string,
    oldPath: string,
    newPath: string,
  ) => Promise<MoveTagReport | null>;
}

export const useTagStore = create<TagStore>()(
  persist(
    (set, get) => ({
      tags: [],
      selectedTagId: null,
      metadataRefreshVersion: 0,

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

      triggerMetadataRefresh: () => set((state) => ({
        metadataRefreshVersion: state.metadataRefreshVersion + 1,
      })),

      loadTags: async (notebookId?: string) => {
        const response = await tags.getAll(notebookId);
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

      moveTag: async (
        notebookId: string,
        oldPath: string,
        newPath: string,
      ) => {
        const report = await tags.move(notebookId, oldPath, newPath);
        if (report) {
          // 通知下游: tag 列表 / 标签面板 / 下拉缓存 都需要重新拉
          get().triggerMetadataRefresh();
        }
        return report;
      },
    }),
    {
      name: STORAGE_KEYS.TAG,
    }
  )
);
