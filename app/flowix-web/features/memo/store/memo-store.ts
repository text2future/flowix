import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { memoRepository, notebookRepository, type FilterType, type SortType } from '@features/memo/services';
import { STORAGE_KEYS } from '@/lib/constants';
import { useTagStore } from '@features/memo/store/tag-store';

import type { MemoColor, MemoItem } from '@/types/memo-item';

// 颜色筛选二级选项。'any' = 任意带色 (memo.colors.length > 0),
// 'none' = 无色 (memo.colors.length === 0), 其它值是具体颜色单选。
// 颜色值会通过独立的后端分页参数下发, 保证颜色筛选和分页结果一致。
export type ColorFilterValue = 'any' | 'none' | MemoColor;

// FilterType 增加了中间列专用的 'color' 维度。后端 filter 仍使用 all,
// 具体颜色通过 color 参数传递。
export type ExtendedFilterType = FilterType | 'color';

/** Which primary surface is shown in the middle column. */
export type MiddleColumnView = 'notes' | 'conversations';

export type MemoLibraryStartupPhase = 'idle' | 'loading' | 'ready' | 'error';

interface MemoListPageQuery {
  notebookId?: string;
  filter: ExtendedFilterType;
  sort: SortType;
  tagId?: string;
  color?: ColorFilterValue;
  pluginId: string | null;
}

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
  /** Number of notes in the notebook when loaded for card-style selectors. */
  memoCount?: number;
  path: string;
  createdAt: number;
  updatedAt: number;
  isDefault: boolean;
  /** User-defined display order; smaller values appear first. Mirrors the
   * Rust `NotebookConfig.sort` field. */
  sort?: number;
  missing?: boolean;
}

/** 最近在资料文件树中打开的文档。只持久化路径，不缓存文档内容。 */
function compareMemoItems(sort: SortType) {
  return (a: MemoItem, b: MemoItem) => {
    // 置顶优先于任何 sort 维度: pinned memo 始终靠前.
    // filter === 'favorited' 时所有可见 memo 都是 favorited, 此分支恒 false.
    if (a.favorited !== b.favorited) {
      return Number(b.favorited) - Number(a.favorited);
    }

    if (sort === 'filenameAsc' || sort === 'filenameDesc') {
      const filenameOrder = a.filename.toLowerCase().localeCompare(b.filename.toLowerCase())
        || a.filename.localeCompare(b.filename)
        || a.id.localeCompare(b.id);
      return sort === 'filenameDesc' ? -filenameOrder : filenameOrder;
    }

    if (sort === 'updatedAt') {
      return (b.updatedAt - a.updatedAt) || b.id.localeCompare(a.id);
    }

    return (b.createdAt - a.createdAt) || b.id.localeCompare(a.id);
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
  /** Whether the backend notebook collection has completed its first load. */
  notebooksInitialized: boolean;
  /** Lifecycle of the main-window notebook + initial memo bootstrap. */
  startupPhase: MemoLibraryStartupPhase;
  startupError: string | null;
  /** Query satisfied by the initial memo load, if startup reached ready. */
  initialMemoQueryKey: string | null;
  // Selection state
  selectedMemo: MemoItem | null;
  /** Stable persisted identity; the full entity is hydrated from backend data. */
  selectedMemoId: string | null;
  selectedNotebook: Notebook | null;
  /** Stable persisted identity; the full entity is hydrated from backend data. */
  selectedNotebookId: string | null;
  // UI filter/sort
  middleColumnView: MiddleColumnView;
  activeFilter: ExtendedFilterType;
  activePluginId: string | null;
  activeSort: SortType;
  // 'color' 二级弹窗用的具体颜色值。'any'/'none'/具体颜色 (MEMO_COLORS)。
  // 当 activeFilter !== 'color' 时此值仍然保留, 切回颜色筛选时恢复。
  colorFilter: ColorFilterValue;
  // Reload trigger
  refreshTrigger: number;
  /** Cursor state for the currently loaded memo query. Not persisted. */
  memoListQueryKey: string | null;
  memoListQuery: MemoListPageQuery | null;
  memoListNextCursor: string | null;
  memoListHasMore: boolean;
  memoListLoadingMore: boolean;

  // Setters
  setMemos: (memos: MemoItem[]) => void;
  /**
   * Replace the notebook snapshot. When supplied, selectedNotebookId is
   * applied in the same state update so deletion/reconciliation cannot expose
   * a transient `null` selection to notebook synchronization effects.
   */
  setNotebooks: (notebooks: Notebook[], selectedNotebookId?: string | null) => void;
  setStartupPhase: (phase: MemoLibraryStartupPhase, error?: string | null) => void;
  setStartupReady: (initialMemoQueryKey: string) => void;
  setSelectedMemo: (memo: MemoItem | null) => void;
  setSelectedNotebook: (notebook: Notebook | null) => void;
  /**
   * Persist a new notebook display order. `nextOrderIds` is the desired
   * sequence; the store assigns sparse sort values internally and replaces
   * the local cache with the backend's response.
   */
  reorderNotebooks: (nextOrderIds: string[]) => Promise<void>;
  setMiddleColumnView: (view: MiddleColumnView) => void;
  setActiveFilter: (filter: ExtendedFilterType) => void;
  setActivePluginId: (pluginId: string | null) => void;
  setActiveSort: (sort: SortType) => void;
  setColorFilter: (color: ColorFilterValue) => void;
  triggerRefresh: () => void;
  upsertMemo: (memo: MemoItem) => void;
  // Incremental memo update (avoids full reload)
  // v2 rename 联动: filename 加入可 patch 字段, rename 时只 patch filename + updatedAt
  // 即可, 不动 preview / tags / todos 这些派生字段 (rename 期间 body 不变)。
  updateMemoMeta: (id: string, meta: Partial<Pick<MemoItem, 'updatedAt' | 'preview' | 'thumbnail' | 'favorited' | 'filename'>>) => void;
  // Data loading
  loadMemos: (params?: { notebookId?: string; filter?: ExtendedFilterType; sort?: SortType; tagId?: string }) => Promise<boolean>;
  loadMoreMemos: () => Promise<boolean>;
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

// 只恢复侧边栏能够表达的导航入口。颜色 / 时间等筛选属于中间列的
// 临时筛选，持久化它们会导致重启后侧边栏没有任何对应的选中项。
function isSidebarNavigationFilter(
  filter: ExtendedFilterType,
): filter is 'all' | 'agents' | 'todos' | 'tagged' {
  return filter === 'all'
    || filter === 'agents'
    || filter === 'todos'
    || filter === 'tagged';
}

let loadMemosRequestSeq = 0;

function invalidatePendingMemoLoads(): void {
  loadMemosRequestSeq += 1;
}

export const useMemoStore = create<MemoStore>()(
  persist(
    (set, get) => ({
      memos: [],
      notebooks: [],
      notebooksInitialized: false,
      startupPhase: 'idle',
      startupError: null,
      initialMemoQueryKey: null,
      selectedMemo: null,
      selectedMemoId: null,
      selectedNotebook: null,
      selectedNotebookId: null,
      middleColumnView: 'notes',
      activeFilter: 'all',
      activePluginId: null,
      activeSort: 'createdAt',
      colorFilter: 'any',
      refreshTrigger: 0,
      memoListQueryKey: null,
      memoListQuery: null,
      memoListNextCursor: null,
      memoListHasMore: false,
      memoListLoadingMore: false,

      setMemos: (memos) => {
        invalidatePendingMemoLoads();
        set({
          memos,
          memoListQueryKey: null,
          memoListQuery: null,
          memoListNextCursor: null,
          memoListHasMore: false,
          memoListLoadingMore: false,
        });
      },
      setNotebooks: (notebooks, selectedNotebookIdOverride) => set((state) => {
        // Prefer the persisted id. The object fallback keeps tests and
        // pre-migration in-memory callers compatible while the first backend
        // snapshot is being applied.
        const selectedNotebookId = selectedNotebookIdOverride === undefined
          ? state.selectedNotebookId ?? state.selectedNotebook?.id ?? null
          : selectedNotebookIdOverride;
        const selectedNotebook = selectedNotebookId
          ? notebooks.find((notebook) => notebook.id === selectedNotebookId) ?? null
          : null;
        return {
          notebooks,
          selectedNotebook,
          selectedNotebookId: selectedNotebook?.id ?? null,
          notebooksInitialized: true,
        };
      }),
      setStartupPhase: (startupPhase, startupError = null) => set({
        startupPhase,
        startupError,
        ...(startupPhase === 'loading' ? { initialMemoQueryKey: null } : {}),
      }),
      setStartupReady: (initialMemoQueryKey) => set({
        startupPhase: 'ready',
        startupError: null,
        initialMemoQueryKey,
      }),
      setSelectedMemo: (memo) => set({
        selectedMemo: memo,
        selectedMemoId: memo?.id ?? null,
      }),
      setSelectedNotebook: (notebook) => {
        const currentNotebookId = get().selectedNotebookId
          ?? get().selectedNotebook?.id
          ?? null;
        const nextNotebookId = notebook?.id ?? null;
        if (currentNotebookId !== nextNotebookId) {
          useTagStore.getState().setSelectedTagId(null);
          set({
            selectedNotebook: notebook,
            selectedNotebookId: nextNotebookId,
            middleColumnView: 'notes',
            activeFilter: 'all',
            activePluginId: null,
          });
          return;
        }
        set({ selectedNotebook: notebook, selectedNotebookId: nextNotebookId });
      },
      // 中间列五种入口互斥单选 ── 全集: 全部 / 对话 / 待办 / 标签 /
      // 文件夹浏览。每条 setter 都把其他状态归位, 避免点标签时文件树还
      // 霸着中间列。
      setMiddleColumnView: (view) => {
        get().setActiveFilter(view === 'conversations' ? 'agents' : 'all');
      },
      setActiveFilter: (filter) => {
        const previous = get();
        const selectedTagId = useTagStore.getState().selectedTagId;
        const shouldClearTag = filter !== 'tagged';
        const nextView: MiddleColumnView = filter === 'agents' ? 'conversations' : 'notes';
        // Artifact plugins use `activeFilter: 'all'` as their list fallback.
        // Clicking the notes entry must still leave that plugin view, even
        // when the filter value itself is already `all`.
        if (
          previous.activeFilter === filter
          && previous.middleColumnView === nextView
          && previous.activePluginId === null
          && (!shouldClearTag || selectedTagId === null)
        ) return;
        set({
          middleColumnView: nextView,
          activeFilter: filter,
          activePluginId: null,
        });
        if (shouldClearTag && selectedTagId !== null) {
          useTagStore.getState().setSelectedTagId(null);
        }
      },
      setActivePluginId: (pluginId) => set({
        activePluginId: pluginId,
      }),
      setActiveSort: (sort) => set({ activeSort: sort }),
      setColorFilter: (color) => set({ colorFilter: color }),
      triggerRefresh: () => set((state) => ({ refreshTrigger: state.refreshTrigger + 1 })),

      upsertMemo: (memo) => {
        invalidatePendingMemoLoads();
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
        invalidatePendingMemoLoads();
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
        const pluginId = state.activePluginId;
        const sort = params?.sort || state.activeSort;
        const tagId = params?.tagId;
        const color = filter === 'color' ? state.colorFilter : undefined;
        const queryKey = JSON.stringify({
          notebookId: notebookId ?? null,
          filter,
          sort,
          tagId: tagId ?? null,
          color: color ?? null,
          pluginId: pluginId ?? null,
        });
        const response = pluginId && notebookId
          ? {
              memos: await memoRepository.listPluginNotes(pluginId, notebookId),
              nextCursor: null,
              hasMore: false,
            }
          : await memoRepository.list({
              notebookId,
              filter: toBackendFilter(filter),
              sort,
              tagId,
              color,
              limit: 50,
            });
        if (requestSeq !== loadMemosRequestSeq) {
          return false;
        }
        const nextMemos = response.memos as MemoItem[];
        const latestState = get();
        // Loading a list only updates the second column. The selected memo is
        // the source of the work-column document and may legitimately be
        // absent from a filtered result (for example when switching to
        // todos/tags), so do not derive document selection from this query.
        // Explicit actions such as opening, deleting, or changing notebook
        // still update `selectedMemo` through their own store actions.
        const restoredMemo = latestState.selectedMemoId
          ? nextMemos.find((memo) => memo.id === latestState.selectedMemoId)
          : null;
        set({
          memos: nextMemos,
          memoListQueryKey: queryKey,
          memoListQuery: {
            notebookId,
            filter,
            sort,
            tagId,
            color,
            pluginId: pluginId ?? null,
          },
          memoListNextCursor: response.nextCursor ?? null,
          memoListHasMore: response.hasMore ?? Boolean(response.nextCursor),
          memoListLoadingMore: false,
          ...(restoredMemo
            ? {
                selectedMemo: {
                  ...restoredMemo,
                  isOpen: latestState.selectedMemo?.isOpen,
                },
              }
            : {}),
        });
        return true;
      },

      loadMoreMemos: async () => {
        const state = get();
        const query = state.memoListQuery;
        if (
          !state.memoListHasMore
          || state.memoListLoadingMore
          || !state.memoListNextCursor
          || !state.memoListQueryKey
          || !query?.notebookId
          || query.pluginId
        ) {
          return false;
        }

        // Do not let a scroll event from the previous query append into a new
        // notebook/filter while its first page is still in flight.
        const currentQueryKey = JSON.stringify({
          notebookId: state.selectedNotebook?.id ?? null,
          filter: state.activeFilter,
          sort: state.activeSort,
          tagId: state.activeFilter === 'tagged'
            ? useTagStore.getState().selectedTagId ?? null
            : null,
          color: state.activeFilter === 'color' ? state.colorFilter : null,
          pluginId: state.activePluginId ?? null,
        });
        if (currentQueryKey !== state.memoListQueryKey) return false;

        const requestSeq = ++loadMemosRequestSeq;
        const cursor = state.memoListNextCursor;
        set({ memoListLoadingMore: true });
        try {
          const response = await memoRepository.list({
            notebookId: query.notebookId,
            filter: toBackendFilter(query.filter),
            sort: query.sort,
            tagId: query.tagId,
            color: query.color,
            cursor,
            limit: 50,
          });
          if (requestSeq !== loadMemosRequestSeq) return false;

          set((current) => {
            const byId = new Map(current.memos.map((memo) => [memo.id, memo]));
            for (const memo of response.memos) byId.set(memo.id, memo);
            return {
              memos: [...byId.values()],
              memoListNextCursor: response.nextCursor ?? null,
              memoListHasMore: response.hasMore ?? Boolean(response.nextCursor),
              memoListLoadingMore: false,
            };
          });
          return true;
        } finally {
          if (requestSeq === loadMemosRequestSeq) {
            set({ memoListLoadingMore: false });
          }
        }
      },

      loadNotebooks: async () => {
        const nbList = await notebookRepository.list();
        get().setNotebooks(nbList as Notebook[]);
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
        invalidatePendingMemoLoads();
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
          invalidatePendingMemoLoads();
          const state = get();
          set({
            memos: state.memos.filter(m => m.id !== id),
            selectedMemo: state.selectedMemo?.id === id ? null : state.selectedMemo,
            selectedMemoId: state.selectedMemoId === id ? null : state.selectedMemoId,
          });
        }
        return success;
      },

      favoriteMemo: async (id) => {
        invalidatePendingMemoLoads();
        return await memoRepository.favorite(id);
      },

      unfavoriteMemo: async (id) => {
        invalidatePendingMemoLoads();
        return await memoRepository.unfavorite(id);
      },

      // 设置 / 清除文档颜色标签 (多选)。 乐观更新: 本地先改 `colors`,
      // 后端 `set_memo_colors` 写 memo index + emit `Updated` 事件,
      // 后续 `useMemoEvents` 收到后调 `readMemo` 把权威值回灌, 自然收敛。
      setMemoColors: async (id, colors) => {
        invalidatePendingMemoLoads();
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
        invalidatePendingMemoLoads();
        if (!memo) {
          get().triggerRefresh();
          return;
        }

        set((state) => ({
          memos:
            state.activeFilter === 'tagged'
              ? state.memos
              : upsertSortedMemo(state.memos, memo, state.activeFilter, state.activeSort),
          selectedMemoId: options?.select ? memo.id : state.selectedMemoId,
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
        invalidatePendingMemoLoads();
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
        invalidatePendingMemoLoads();
        set((state) => ({
          memos: state.memos.filter((m) => m.id !== id),
          selectedMemo:
            state.selectedMemo?.id === id ? null : state.selectedMemo,
          selectedMemoId: state.selectedMemoId === id ? null : state.selectedMemoId,
        }));
        // Deleted 不 bump refreshTrigger — 列表已经同步, 没有需要重拉的派生字段
      },
    }),
    {
      name: STORAGE_KEYS.MEMO,
      partialize: (state) => ({
        // Persist identities only. Notebook/Memo entities are backend data
        // and may be renamed, deleted, or updated while the app is closed.
        selectedNotebookId: state.selectedNotebookId ?? state.selectedNotebook?.id ?? null,
        selectedMemoId: state.selectedMemoId ?? state.selectedMemo?.id ?? null,
        // 侧边栏入口要和中间列一起恢复。中间列的颜色 / 时间筛选不属于
        // 侧边栏导航，因此恢复时归位到“全部”。
        middleColumnView: state.middleColumnView,
        activeFilter: isSidebarNavigationFilter(state.activeFilter)
          ? state.activeFilter
          : 'all',
      }),
      // Migrate the old persisted shape, which stored full selected entities.
      // Do not rehydrate those stale objects into runtime state.
      merge: (persisted, current) => {
        const legacy = persisted as Partial<MemoStore> & {
          selectedNotebook?: Notebook | null;
          selectedMemo?: MemoItem | null;
        };
        return {
          ...current,
          ...legacy,
          middleColumnView: legacy.middleColumnView
            ?? (legacy.activeFilter === 'agents' ? 'conversations' : 'notes'),
          selectedNotebook: null,
          selectedMemo: null,
          selectedNotebookId: legacy.selectedNotebookId
            ?? legacy.selectedNotebook?.id
            ?? null,
          selectedMemoId: legacy.selectedMemoId
            ?? legacy.selectedMemo?.id
            ?? null,
        };
      },
    }
  )
);
