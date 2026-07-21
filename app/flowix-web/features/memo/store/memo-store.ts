import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { memoRepository, notebookRepository, type FilterType, type SortType } from '@features/memo/services';
import { STORAGE_KEYS } from '@/lib/constants';
import { useTagStore } from '@features/memo/store/tag-store';

import type { MemoColor, MemoItem } from '@/types/memo-item';

// 颜色筛选二级选项。'any' = 任意带色 (memo.colors.length > 0),
// 'none' = 无色 (memo.colors.length === 0), 其它值是具体颜色单选。
// 走前端 store 过滤, 不下发后端 — 后端 `filter_memos` 不识别 'color'。
export type ColorFilterValue = 'any' | 'none' | MemoColor;

// FilterType 增加了前端专用的 'color' 维度。后端不识别时, `loadMemos`
// 会把它转译成 'all' 走全量, 由前端在 useMemo 里按 `colorFilter` 二次过滤。
export type ExtendedFilterType = FilterType | 'color';

// 文档颜色标签 — 跟后端 `MemoColor` 镜像 (`#[serde(rename_all = "lowercase")]`),
// 写入 memo index。单文档可挂多个色, 空数组即"无颜色"。色值在
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
  icon?: string | null;
  path: string;
  createdAt: number;
  updatedAt: number;
  isDefault: boolean;
  /** User-defined display order; smaller values appear first. Mirrors the
   * Rust `NotebookConfig.sort` field. */
  sort?: number;
  missing?: boolean;
}

function compareMemoItems(sort: SortType) {
  return (a: MemoItem, b: MemoItem) => {
    // 置顶优先于任何 sort 维度: pinned memo 始终靠前.
    // filter === 'favorited' 时所有可见 memo 都是 favorited, 此分支恒 false.
    if (a.favorited !== b.favorited) {
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
    case 'agents':
      return memo.agents.length > 0;
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

// 把前端的 `ExtendedFilterType` 转成后端识别的 `FilterType`。
// 'color' 是前端专用, 在后端没有意义 → 退化成 'all' 拉全量, 由前端 store
// 在 useMemo 里按 `colorFilter` 二次过滤。其他值原样下发。
function toBackendFilter(filter: ExtendedFilterType): FilterType {
  return filter === 'color' ? 'all' : filter;
}

function upsertSortedMemo(
  current: MemoItem[],
  memo: MemoItem,
  filter: ExtendedFilterType,
  sort: SortType
): MemoItem[] {
  const withoutExisting = current.filter((item) => item.id !== memo.id);
  // 'color' 在 memoMatchesFilter 的 default 分支会被放行 (后端没返回任何
  // 数据可过滤, 这里只是 upsert 排序); 实际 UI 端会在 useMemo 里按
  // colorFilter 二次过滤, 新建笔记不挂色会自然落选。
  if (!memoMatchesFilter(memo, filter as FilterType)) {
    return withoutExisting;
  }
  return [...withoutExisting, memo].sort(compareMemoItems(sort));
}

export interface MemoStore {
  // List data
  memos: MemoItem[];
  notebooks: Notebook[];
  // Selection state
  selectedMemo: MemoItem | null;
  selectedNotebook: Notebook | null;
  // UI filter/sort
  activeFilter: ExtendedFilterType;
  activeSort: SortType;
  // 'color' 二级弹窗用的具体颜色值。'any'/'none'/具体颜色 (MEMO_COLORS)。
  // 当 activeFilter !== 'color' 时此值仍然保留, 切回颜色筛选时恢复。
  colorFilter: ColorFilterValue;
  // Reload trigger
  refreshTrigger: number;

  // Setters
  setMemos: (memos: MemoItem[]) => void;
  setNotebooks: (notebooks: Notebook[]) => void;
  setSelectedMemo: (memo: MemoItem | null) => void;
  setSelectedNotebook: (notebook: Notebook | null) => void;
  /**
   * Persist a new notebook display order. `nextOrderIds` is the desired
   * sequence; the store assigns sparse sort values internally and replaces
   * the local cache with the backend's response.
   */
  reorderNotebooks: (nextOrderIds: string[]) => Promise<void>;
  setActiveFilter: (filter: ExtendedFilterType) => void;
  setActiveSort: (sort: SortType) => void;
  setColorFilter: (color: ColorFilterValue) => void;
  triggerRefresh: () => void;
  upsertMemo: (memo: MemoItem) => void;
  // Incremental memo update (avoids full reload)
  // v2 rename 联动: filename 加入可 patch 字段, rename 时只 patch filename + updatedAt
  // 即可, 不动 preview / tags / todos 这些派生字段 (rename 期间 body 不变)。
  updateMemoMeta: (id: string, meta: Partial<Pick<MemoItem, 'updatedAt' | 'preview' | 'thumbnail' | 'favorited' | 'filename'>>) => void;
  // Data loading
  loadMemos: (params?: { notebookId?: string; filter?: ExtendedFilterType; sort?: SortType; tagId?: string }) => Promise<void>;
  loadNotebooks: () => Promise<void>;
  createMemo: (tag?: string, notebookId?: string) => Promise<MemoItem>;
  deleteMemo: (id: string) => Promise<boolean>;
  favoriteMemo: (id: string) => Promise<boolean>;
  unfavoriteMemo: (id: string) => Promise<boolean>;
  setMemoColors: (id: string, colors: MemoColor[]) => Promise<boolean>;

  // 后端 memo-event 推送的 store action — 由 memo-dispatcher 调用。
  // 单条 memo 的权威 payload 直接增量更新列表；notebook 级的 tags/todos
  // 派生视图由 dispatcher 触发对应 store 重新查询。
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

export function getVisibleCreateFilter(filter: ExtendedFilterType): ExtendedFilterType {
  return filter === 'agents' || filter === 'todos' || filter === 'color' ? 'all' : filter;
}

let loadMemosRequestSeq = 0;

export const useMemoStore = create<MemoStore>()(
  persist(
    (set, get) => ({
      memos: [],
      notebooks: [],
      selectedMemo: null,
      selectedNotebook: null,
      activeFilter: 'all',
      activeSort: 'createdAt',
      colorFilter: 'any',
      refreshTrigger: 0,

      setMemos: (memos) => set({ memos }),
      setNotebooks: (notebooks) => set((state) => {
        const selectedNotebook = state.selectedNotebook
          ? notebooks.find((notebook) => notebook.id === state.selectedNotebook?.id) ?? state.selectedNotebook
          : state.selectedNotebook;
        return { notebooks, selectedNotebook };
      }),
      setSelectedMemo: (memo) => set({ selectedMemo: memo }),
      setSelectedNotebook: (notebook) => {
        const currentNotebookId = get().selectedNotebook?.id ?? null;
        const nextNotebookId = notebook?.id ?? null;
        if (currentNotebookId !== nextNotebookId) {
          useTagStore.getState().setSelectedTagId(null);
          set({ selectedNotebook: notebook, activeFilter: 'all' });
          return;
        }
        set({ selectedNotebook: notebook });
      },
      setActiveFilter: (filter) => set({ activeFilter: filter }),
      setActiveSort: (sort) => set({ activeSort: sort }),
      setColorFilter: (color) => set({ colorFilter: color }),
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
        const requestSeq = ++loadMemosRequestSeq;
        const state = get();
        const notebookId = params?.notebookId || state.selectedNotebook?.id;
        const filter = params?.filter || state.activeFilter;
        const sort = params?.sort || state.activeSort;
        const tagId = params?.tagId;
        // 'color' 是前端专用, 转 'all' 走全量, 由 useMemo 按 colorFilter 过滤。
        const response = await memoRepository.list({
          notebookId,
          filter: toBackendFilter(filter),
          sort,
          tagId,
        });
        if (requestSeq !== loadMemosRequestSeq) {
          return;
        }
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
      /**
       * Reorder notebooks by submitting the new id order to the backend.
       * `nextOrderIds` is the desired sequence of notebook ids; the action
       * assigns sort = (index + 1) * 10 (step 10 keeps room for future
       * inserts) and replaces the local cache with the backend's response
       * so that any normalization logic stays server-authoritative.
       */
      reorderNotebooks: async (nextOrderIds: string[]) => {
        if (nextOrderIds.length === 0) return;
        const order = nextOrderIds.map((id, index) => ({
          id,
          sort: (index + 1) * 10,
        }));
        try {
          const updated = await notebookRepository.reorder(order);
          set({ notebooks: updated as Notebook[] });
        } catch (error) {
          // 失败时重新拉一次 list 跟服务端对齐 (notebook 列表较短, 直接重拉比
          // 维护本地乐观回滚更稳)。
          console.error('[reorderNotebooks] failed', error);
          const nbList = await notebookRepository.list();
          set({ notebooks: nbList as Notebook[] });
        }
      },

      createMemo: async (tag, notebookId) => {
        // v4: 不再 markLocalMemoCreated — 后端 SelfWriteSuppressor 把
        // desktop 自写的 memo-event 在 watcher 端就掐掉, 不再到前端。
        // 事件去重/抑制由后端统一负责, 前端 store 不需要任何补丁。
        const state = get();
        const selectedTagId = useTagStore.getState().selectedTagId;
        const createFilter = getVisibleCreateFilter(state.activeFilter);
        if (createFilter !== state.activeFilter) {
          useTagStore.getState().setSelectedTagId(null);
          set({ activeFilter: createFilter });
        }
        const createTag = tag ?? (createFilter === 'tagged' ? selectedTagId ?? undefined : undefined);
        const memo = await memoRepository.create(createTag, notebookId);
        set({
          memos: upsertSortedMemo(get().memos, memo as MemoItem, createFilter, state.activeSort),
        });
        // 新建 memo 可能引入新 tag (body 派生) ── 主动 bump metadata refresh,
        // 让侧栏标签树立即出现新节点 / 更新计数。后端 SelfWriteSuppressor 会
        // 掐掉 desktop 自写的 memo-event, 不会自动触发 refresh, 必须手动调。
        useTagStore.getState().triggerMetadataRefresh();
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
      // 后端 `set_memo_colors` 写 memo index + emit `Updated` 事件,
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
      // memo-dispatcher 监听后端 memo-event 后按 kind 派发到下面三个 action。
      // 这里只处理 memo 列表里的单条记录；tags/todos 的 notebook 级刷新
      // 由 dispatcher 根据 derivedChanged 信号交给 tag/todo store。

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
          const nextMemos = upsertSortedMemo(state.memos, memo, state.activeFilter, state.activeSort);
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
