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

export interface DeleteTagReport {
  affectedMemos: number;
  deletedTags: string[];
}

interface TagStore {
  tags: MemoTagItem[];
  selectedTagId: string | null;
  metadataRefreshVersion: number;
  setSelectedTagId: (id: string | null) => void;
  triggerMetadataRefresh: () => void;
  loadTags: (notebookId?: string) => Promise<void>;
  /**
   * 移动 subtag: 把 `oldPath` 整棵子树重命名为 `newPath` (含 prefix
   * 替换), 批量改写所有受影响 memo 的 .md body + 同步 memo index。
   * 成功后 triggerMetadataRefresh, 触发面板 / 下拉 / 列表重拉。
   * 编辑器 `#` mention 缓存的失效由调用方 (applyTagMove) 调
   * invalidateMentionTags, 避免本 store 反向依赖 editor。
   */
  moveTag: (
    notebookId: string,
    oldPath: string,
    newPath: string,
  ) => Promise<MoveTagReport | null>;
  /**
   * 删除 subtag: 把 `tagPath` 自身及整棵子树从 memo index + 文档 body
   * 移除。 调用方负责 UI 副作用:
   * - 如果 selectedTagId 命中被删子树, 调用方需 setSelectedTagId(null)
   *   并切 activeFilter 到 'all' (因为旧的 tag 不存在了)
   * - 调用方在成功后调 invalidateMentionTags + clearLibraryMetadata
   *
   * selectedTagId 处理**不**放在 store 里 ── store 不感知 UI 维度
   * (activeFilter 来自 memo-store), 跟 moveTag 把 selectedTagId 重写
   * 留在 panel 里是同一原则。
   */
  deleteTag: (
    notebookId: string,
    tagPath: string,
  ) => Promise<DeleteTagReport | null>;
}

export const useTagStore = create<TagStore>()(
  persist(
    (set, get) => ({
      tags: [],
      selectedTagId: null,
      metadataRefreshVersion: 0,

      setSelectedTagId: (id) => set({ selectedTagId: id }),

      triggerMetadataRefresh: () => set((state) => ({
        metadataRefreshVersion: state.metadataRefreshVersion + 1,
      })),

      loadTags: async (notebookId?: string) => {
        const response = await tags.getAll(notebookId);
        set({ tags: response.tags });
      },

      moveTag: async (
        notebookId: string,
        oldPath: string,
        newPath: string,
      ) => {
        const report = await tags.move(notebookId, oldPath, newPath);
        if (report) {
          // 通知下游: tag 列表 / 标签面板 / 下拉缓存 都需要重新拉。
          // 编辑器 `#` mention 缓存的失效由调用方 (note-navigation-panel
          // 的 applyTagMove) 调 invalidateMentionTags, 避免本 store 反向
          // 依赖 editor (memo-store -> tag-store -> editor -> memo-store 循环)。
          get().triggerMetadataRefresh();
        }
        return report;
      },

      deleteTag: async (
        notebookId: string,
        tagPath: string,
      ) => {
        const report = await tags.delete(notebookId, tagPath);
        if (report) {
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
