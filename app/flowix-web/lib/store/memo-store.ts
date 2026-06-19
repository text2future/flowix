import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { memoRepository, notebookRepository, type FilterType, type SortType } from '../services/memo-repository';
import { STORAGE_KEYS } from '../constants';

import type { MemoColor, MemoItem } from '../../types/memo-item';

// 文档颜色标签 — 跟后端 `MemoColor` 镜像 (`#[serde(rename_all = "lowercase")]`),
// 写入 index.json。单文档可挂多个色, 空数组即"无颜色"。色值在
// `MEMO_COLOR_HEX` 集中维护, picker / 列表 dot 共用。

export const MEMO_COLORS: readonly MemoColor[] = [
  'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'gray',
] as const;

/**
 * 7 色色板 → 返回 `var(--memo-color-<key>)`, 由 css/theme/{light,dark,rock}.css
 * 各主题文件定义实际 OKLCH 色值。这样:
 *   - 三套主题能各自微调 L / C / hue, 暗底提一档亮度、rock 降 chroma 让色
 *     块"嵌进"岩灰底。
 *   - 消费点 (picker 按钮底色 / 列表小圆点) 不需要感知主题 ── 读 `style={{
 *     backgroundColor: MEMO_COLOR_HEX[c] }}` 一致, 浏览器在元素层面解析 var。
 *
 * 历史: 此前是硬编码 hex (Tailwind 500 阶), L=62–80% 偏亮、chroma 中等,
 * 在暗底上不够"立得住"。改 OKLCH + 主题感知后, 整体降 L 6–10%、提 chroma
 * 15–25%, 跨主题色相识别稳定 (hue 不动或偏移 ≤ 8°)。
 */
export const MEMO_COLOR_HEX: Record<MemoColor, string> = {
  red: 'var(--memo-color-red)',
  orange: 'var(--memo-color-orange)',
  yellow: 'var(--memo-color-yellow)',
  green: 'var(--memo-color-green)',
  cyan: 'var(--memo-color-cyan)',
  blue: 'var(--memo-color-blue)',
  gray: 'var(--memo-color-gray)',
};

export interface Notebook {
  id: string;
  name: string;
  icon: string;
  path: string;
  createdAt: number;
  updatedAt: number;
  isDefault: boolean;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'completed';
}

export interface MemoMeta {
  type: string;
  agent_name?: string;
  agent_description?: string;
}

export type SortOption = 'createdAt' | 'updatedAt' | 'title';

function compareMemoItems(filter: FilterType, sort: SortType) {
  return (a: MemoItem, b: MemoItem) => {
    if (filter === 'all' && a.favorited !== b.favorited) {
      return Number(b.favorited) - Number(a.favorited);
    }

    if (sort === 'updatedAt') {
      return b.updatedAt - a.updatedAt;
    }

    return b.createdAt - a.createdAt;
  };
}

function memoMatchesFilter(memo: MemoItem, filter: FilterType): boolean {
  const now = new Date();
  switch (filter) {
    case 'todos':
      return memo.todos.length > 0;
    case 'favorited':
      return memo.favorited;
    case 'tagged':
      return memo.tags.length > 0;
    case 'thisWeek': {
      const day = now.getDay();
      const diffToMonday = day === 0 ? 6 : day - 1;
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - diffToMonday);
      return memo.createdAt >= start.getTime() && memo.createdAt <= now.getTime();
    }
    case 'thisMonth': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      return memo.createdAt >= start && memo.createdAt <= now.getTime();
    }
    default:
      return true;
  }
}

function upsertSortedMemo(
  current: MemoItem[],
  memo: MemoItem,
  filter: FilterType,
  sort: SortType
): MemoItem[] {
  const withoutExisting = current.filter((item) => item.id !== memo.id);
  if (!memoMatchesFilter(memo, filter)) {
    return withoutExisting;
  }
  return [...withoutExisting, memo].sort(compareMemoItems(filter, sort));
}

export interface MemoStore {
  // List data
  memos: MemoItem[];
  notebooks: Notebook[];
  // Selection state
  selectedMemo: MemoItem | null;
  selectedNotebook: Notebook | null;
  // UI filter/sort
  activeFilter: FilterType;
  activeSort: SortType;
  // Reload trigger
  refreshTrigger: number;

  // Setters
  setMemos: (memos: MemoItem[]) => void;
  setNotebooks: (notebooks: Notebook[]) => void;
  setSelectedMemo: (memo: MemoItem | null) => void;
  setSelectedNotebook: (notebook: Notebook | null) => void;
  setActiveFilter: (filter: FilterType) => void;
  setActiveSort: (sort: SortType) => void;
  triggerRefresh: () => void;
  upsertMemo: (memo: MemoItem) => void;
  // Incremental memo update (avoids full reload)
  // v2 rename 联动: filename 加入可 patch 字段, rename 时只 patch filename + updatedAt
  // 即可, 不动 preview / tags / todos 这些派生字段 (rename 期间 body 不变)。
  updateMemoMeta: (id: string, meta: Partial<Pick<MemoItem, 'updatedAt' | 'preview' | 'favorited' | 'filename'>>) => void;
  // Data loading
  loadMemos: (params?: { notebookId?: string; filter?: FilterType; sort?: SortType; tagId?: string }) => Promise<void>;
  loadNotebooks: () => Promise<void>;
  createMemo: (tag?: string, notebookId?: string) => Promise<MemoItem>;
  deleteMemo: (id: string) => Promise<boolean>;
  favoriteMemo: (id: string) => Promise<boolean>;
  unfavoriteMemo: (id: string) => Promise<boolean>;
  setMemoColors: (id: string, colors: MemoColor[]) => Promise<boolean>;

  // 后端 memo-event 推送的 store action — 由 useMemoEvents 监听器调用。
  // 设计: 只做"乐观更新" + `triggerRefresh`, 真正重排 / preview 刷新走
  // MemoList 里 [refreshTrigger] useEffect 的 loadData 管线, 避免在 store
  // 里维护两套排序逻辑。
  handleMemoCreated: (memo?: MemoItem, options?: { select?: boolean }) => void;
  /**
   * v2: 后端 emit 的 `Updated` payload 携带完整 memo (rename_memo_file /
   * reload_memo_from_disk / read_memo 之后的最新 entry)。store 拿 memo 按 id
   * 决定是 update (已在 memos 数组里) 还是 insert (不在 memos 数组里)。
   *
   * 不再调 readMemo IPC, 不再依赖 path 比对 filename, 不再手工合成 patched
   * 对象。 唯一保留的是 selectedMemo.isOpen 字段 (前端 UI 状态, 不归后端管)。
   */
  handleMemoUpdated: (memo: MemoItem) => void;
  handleMemoDeleted: (id: string) => void;
}

function omitUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, fieldValue]) => fieldValue !== undefined)
  ) as Partial<T>;
}

export const useMemoStore = create<MemoStore>()(
  persist(
    (set, get) => ({
      memos: [],
      notebooks: [],
      selectedMemo: null,
      selectedNotebook: null,
      activeFilter: 'all',
      activeSort: 'createdAt',
      refreshTrigger: 0,

      setMemos: (memos) => set({ memos }),
      setNotebooks: (notebooks) => set({ notebooks }),
      setSelectedMemo: (memo) => set({ selectedMemo: memo }),
      setSelectedNotebook: (notebook) => set({ selectedNotebook: notebook }),
      setActiveFilter: (filter) => set({ activeFilter: filter }),
      setActiveSort: (sort) => set({ activeSort: sort }),
      triggerRefresh: () => set((state) => ({ refreshTrigger: state.refreshTrigger + 1 })),

      upsertMemo: (memo) => {
        set((state) => ({
          memos: state.memos.some((item) => item.id === memo.id)
            ? upsertSortedMemo(state.memos, memo, state.activeFilter, state.activeSort)
            : state.memos,
          selectedMemo:
            state.selectedMemo?.id === memo.id
              ? { ...memo, isOpen: state.selectedMemo.isOpen }
              : state.selectedMemo,
        }));
      },

      updateMemoMeta: (id, meta) => {
        const nextMeta = omitUndefined(meta);
        set((state) => ({
          memos: state.memos.map((m) => m.id === id ? { ...m, ...nextMeta } : m),
          selectedMemo: state.selectedMemo?.id === id
            ? { ...state.selectedMemo, ...nextMeta }
            : state.selectedMemo,
        }));
      },

      loadMemos: async (params) => {
        const state = get();
        const response = await memoRepository.list({
          notebookId: params?.notebookId || state.selectedNotebook?.id,
          filter: params?.filter || state.activeFilter,
          sort: params?.sort || state.activeSort,
          tagId: params?.tagId,
        });
        const nextMemos = response.memos as MemoItem[];
        const latestSelectedMemo = get().selectedMemo;
        const selectedMemo = latestSelectedMemo
          ? nextMemos.find((memo) => memo.id === latestSelectedMemo.id) ?? null
          : null;

        set({
          memos: nextMemos,
          selectedMemo,
        });
      },

      loadNotebooks: async () => {
        const nbList = await notebookRepository.list();
        set({ notebooks: nbList as Notebook[] });
      },

      createMemo: async (tag, notebookId) => {
        // v4: 不再 markLocalMemoCreated — 后端 SelfWriteSuppressor 把
        // desktop 自写的 memo-event 在 watcher 端就掐掉, 不再到前端。
        // 事件去重/抑制由后端统一负责, 前端 store 不需要任何补丁。
        const memo = await memoRepository.create(tag, notebookId);
        const state = get();
        set({
          memos: upsertSortedMemo(state.memos, memo as MemoItem, state.activeFilter, state.activeSort),
        });
        return memo as MemoItem;
      },

      deleteMemo: async (id) => {
        const success = await memoRepository.delete(id);
        if (success) {
          const state = get();
          set({
            memos: state.memos.filter(m => m.id !== id),
            selectedMemo: state.selectedMemo?.id === id ? null : state.selectedMemo,
          });
        }
        return success;
      },

      favoriteMemo: async (id) => {
        return await memoRepository.favorite(id);
      },

      unfavoriteMemo: async (id) => {
        return await memoRepository.unfavorite(id);
      },

      // 设置 / 清除文档颜色标签 (多选)。 乐观更新: 本地先改 `colors`,
      // 后端 `set_memo_colors` 写 index.json + emit `Updated` 事件,
      // 后续 `useMemoEvents` 收到后调 `readMemo` 把权威值回灌, 自然收敛。
      setMemoColors: async (id, colors) => {
        const state = get();
        const next = state.memos.map((m) => m.id === id ? { ...m, colors } : m);
        const nextSelected = state.selectedMemo?.id === id
          ? { ...state.selectedMemo, colors }
          : state.selectedMemo;
        set({ memos: next, selectedMemo: nextSelected });
        return await memoRepository.setColors(id, colors);
      },

      // ===== memo-event 推送入口 =====
      // useMemoEvents 监听后端 memo-event, 按 kind 派发到下面三个 action。
      // 仅做"乐观更新" (UI 立刻动) + 触发 refreshTrigger, 真正的 sort / preview
      // 重算走 MemoList 的 [refreshTrigger] useEffect → loadData → get_memos 拉一遍。
      // 这样 store 不维护第二套排序, index.json 是唯一真源。

      handleMemoCreated: (memo, options) => {
        if (!memo) {
          get().triggerRefresh();
          return;
        }

        set((state) => ({
          memos:
            state.activeFilter === 'tagged'
              ? state.memos
              : upsertSortedMemo(state.memos, memo, state.activeFilter, state.activeSort),
          selectedMemo:
            options?.select
              ? { ...memo, isOpen: true }
              : state.selectedMemo?.id === memo.id
                ? { ...memo, isOpen: state.selectedMemo.isOpen }
                : state.selectedMemo,
        }));
        if (get().activeFilter === 'tagged') {
          get().triggerRefresh();
        }
      },

      handleMemoUpdated: (memo) => {
        // v2: 按 id 决定 update / insert, 保留 selectedMemo.isOpen。
        // - memos 数组里有这条 id: 替换为后端发来的权威 memo, 重排
        // - 没有: 直接 push 进数组 (罕见, 但 reconcile / external tool create
        //   等场景可能出现, 后端 emit 走 Updated 路径时用 minimal memo 兜底)
        set((state) => {
          const exists = state.memos.some((m) => m.id === memo.id);
          const nextMemos = exists
            ? upsertSortedMemo(state.memos, memo, state.activeFilter, state.activeSort)
            : upsertSortedMemo(state.memos, memo, state.activeFilter, state.activeSort);
          // 保留 selectedMemo 的 isOpen 状态
          const nextSelected = state.selectedMemo?.id === memo.id
            ? { ...memo, isOpen: state.selectedMemo.isOpen }
            : state.selectedMemo;
          return { memos: nextMemos, selectedMemo: nextSelected };
        });
      },

      handleMemoDeleted: (id) => {
        set((state) => ({
          memos: state.memos.filter((m) => m.id !== id),
          selectedMemo:
            state.selectedMemo?.id === id ? null : state.selectedMemo,
        }));
        // Deleted 不 bump refreshTrigger — 列表已经同步, 没有需要重拉的派生字段
      },
    }),
    {
      name: STORAGE_KEYS.MEMO,
      partialize: (state) => ({
        selectedNotebook: state.selectedNotebook,
        selectedMemo: state.selectedMemo,
      }),
    }
  )
);
