import { normalizeNoteFilterCondition, noteFilterTitleQuery, createNoteFilterMatcher, type NoteFilterCondition, type NoteFilterField } from '@features/collection/public/note-filter-api';
import { getAllPresets } from '@features/document/properties/presets';
import { usePropertyPresetStore } from '@features/properties/property-preset-store';
import { applyNoteListChanges, type NoteListChange } from './note-list-projection';
import { NoteListSession } from './note-list-session';
import { useNotebookBackgroundStore } from '@features/memo/store/notebook-background-store';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { noteRepository, notebookRepository, type FilterType, type SortType } from '@features/memo/services/note-repository';
import { getNoteQueryKey } from '@features/memo/services/note-query-key';
import { STORAGE_KEYS } from '@/lib/constants';
import { createLogger } from '@/lib/logger';
import { useTagStore } from '@features/memo/store/tag-store';
import {
  memoMatchesCustomFilter,
  useCustomFilterStore,
  type CustomFilter,
} from '@features/memo/store/custom-filter-store';
import { normalizePluginId } from '@features/plugin/plugin-note';

import type { NoteColor, NoteListItem } from '@/types/note-item';
import type { CreatedNoteDocument, NoteEntry } from '@platform/tauri/client';
export { NOTE_COLORS } from '@/types/note-item';

// Clear the retired Memo list UI state when this module loads; Note state uses a new key.
if (typeof window !== 'undefined') {
  try {
    window.localStorage.removeItem('flowix-memo-storage');
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

// 颜色筛选二级选项。'any' = 任意带色 (memo.colors.length > 0),
// 'none' = 无色 (memo.colors.length === 0), 其它值是具体颜色单选。
// 颜色值会通过独立的后端分页参数下发, 保证颜色筛选和分页结果一致。
export type ColorFilterValue = 'any' | 'none' | NoteColor;

// FilterType 增加了中间列专用的 'color' 维度。后端 filter 仍使用 all,
// 具体颜色通过 color 参数传递。
export type ExtendedFilterType = FilterType | 'color' | 'custom';

/** Which primary surface is shown in the middle column. */
export type MiddleColumnView = 'notes' | 'conversations';

export type NoteLibraryStartupPhase = 'idle' | 'loading' | 'ready' | 'error';

interface MemoListPageQuery {
  notebookId?: string;
  filter: ExtendedFilterType;
  sort: SortType;
  tagId?: string;
  color?: ColorFilterValue;
  pluginId: string | null;
  customFilterId: string | null;
  dataCondition?: NoteFilterCondition | null;
}

const MEMO_LIST_PAGE_SIZE = 50;

/**
 * O(1) lookup for "the note behind this tree row". Rows used to call
 * `state.notes.find(...)` inside their store selector, which made every note
 * update cost `visible rows × notes` string comparisons. The index is keyed by
 * the array identity, so it is rebuilt only when the list actually changes.
 */
const noteIndexCache = new WeakMap<readonly NoteListItem[], Map<string, NoteListItem>>();

export function noteLookupKey(notebookId: string, relativePath: string): string {
  return `${notebookId}\u0000${relativePath}`;
}

export function noteIndexFor(notes: readonly NoteListItem[]): Map<string, NoteListItem> {
  let index = noteIndexCache.get(notes);
  if (!index) {
    index = new Map();
    for (const note of notes) {
      index.set(noteLookupKey(note.notebookId, note.relativePath), note);
    }
    noteIndexCache.set(notes, index);
  }
  return index;
}

const memoListRequestLogger = createLogger('memo-list-query');
const noteStoreLogger = createLogger('memo:note-store');
const recentMemoListRequestCounts = new Map<string, { startedAt: number; count: number }>();

/** Development-only visibility into repeated backend reads for one query burst. */
function recordMemoListRequest(queryKey: string, requestSeq: number, source: string): void {
  if (!import.meta.env.DEV) return;

  const now = Date.now();
  const previous = recentMemoListRequestCounts.get(queryKey);
  const isSameBurst = previous != null && now - previous.startedAt <= 500;
  const count = isSameBurst && previous ? previous.count + 1 : 1;
  recentMemoListRequestCounts.delete(queryKey);
  recentMemoListRequestCounts.set(queryKey, {
    startedAt: isSameBurst && previous ? previous.startedAt : now,
    count,
  });
  if (recentMemoListRequestCounts.size > 64) {
    const oldestQueryKey = recentMemoListRequestCounts.keys().next().value;
    if (oldestQueryKey) recentMemoListRequestCounts.delete(oldestQueryKey);
  }

  memoListRequestLogger.debug('list query request started', {
    queryKey,
    requestSeq,
    source,
    requestsInBurst: count,
  });
}

export interface SelectedNoteIdentity {
  notebookId: string;
  relativePath: string;
}

// 文档颜色标签 — 跟后端 `NoteColor` 镜像 (`#[serde(rename_all = "lowercase")]`),
// 写入 memo index。单文档可挂多个色, 空数组即"无颜色"。色值在
// `NOTE_COLOR_HEX` 集中维护, picker / 列表 dot 共用。

/**
 * 7 色色板 → 返回 `var(--memo-color-<key>)`, 由 css/theme/{light,dark,rock}.css
 * 各主题文件定义实际 OKLCH 色值。这样:
 *   - 各主题能各自微调 L / C / hue, 暗底提一档亮度、浅底降 chroma 让色
 *     块"嵌进"岩灰底。
 *   - 消费点 (picker 按钮底色 / 列表小圆点) 不需要感知主题 ── 读 `style={{
 *     backgroundColor: NOTE_COLOR_HEX[c] }}` 一致, 浏览器在元素层面解析 var。
 *
 * 历史: 此前是硬编码 hex (Tailwind 500 阶), L=62–80% 偏亮、chroma 中等,
 * 在暗底上不够"立得住"。改 OKLCH + 主题感知后, 整体降 L 6–10%、提 chroma
 * 15–25%, 跨主题色相识别稳定 (hue 不动或偏移 ≤ 8°)。
 */
export const NOTE_COLOR_HEX: Record<NoteColor, string> = {
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
  /** Device-local pinned state from the notebook registry. */
  pinned?: boolean;
  missing?: boolean;
}

/** 最近在资料文件树中打开的文档。只持久化路径，不缓存文档内容。 */
// 把前端的 `ExtendedFilterType` 转成后端识别的 `FilterType`。
// 颜色由后端独立的 color 参数筛选；自定义条件暂时在每个原始页上筛选。
// 两者使用 all 查询入口，其余 filter 原样下发。
function toBackendFilter(filter: ExtendedFilterType): FilterType {
  return filter === 'color' || filter === 'custom' ? 'all' : filter;
}

export interface NoteLibraryStore {
  /** Note list data, keyed by notebook id and relative path. */
  notes: NoteListItem[];
  notebooks: Notebook[];
  /** Whether the backend notebook collection has completed its first load. */
  notebooksInitialized: boolean;
  /** Lifecycle of the main-window notebook + initial memo bootstrap. */
  startupPhase: NoteLibraryStartupPhase;
  startupError: string | null;
  /** Query satisfied by the initial memo load, if startup reached ready. */
  initialMemoQueryKey: string | null;
  // Selection state
  selectedNote: SelectedNoteIdentity | null;
  selectedNotebook: Notebook | null;
  /** Stable persisted identity; the full entity is hydrated from backend data. */
  selectedNotebookId: string | null;
  // UI filter/sort
  middleColumnView: MiddleColumnView;
  activeFilter: ExtendedFilterType;
  activePluginId: string | null;
  activeCustomFilterId: string | null;
  activeSort: SortType;
  dataConditionsByNotebook: Record<string, NoteFilterCondition>;
  setDataCondition: (notebookId: string, condition: NoteFilterCondition) => void;
  // 'color' 二级弹窗用的具体颜色值。'any'/'none'/具体颜色 (NOTE_COLORS)。
  // 当 activeFilter !== 'color' 时此值仍然保留, 切回颜色筛选时恢复。
  colorFilter: ColorFilterValue;
  /** Broad refresh for the list and notebook-scoped dependent surfaces. */
  refreshTrigger: number;
  /** Query-only invalidation. Does not reload notebook metadata consumers. */
  memoListRefreshTrigger: number;
  /** Cursor state for the currently loaded memo query. Not persisted. */
  memoListQueryKey: string | null;
  memoListQuery: MemoListPageQuery | null;
  memoListNextCursor: string | null;
  memoListHasMore: boolean;
  memoListLoadingMore: boolean;

  // Setters
  /**
   * Replace the notebook snapshot. When supplied, selectedNotebookId is
   * applied in the same state update so deletion/reconciliation cannot expose
   * a transient `null` selection to notebook synchronization effects.
   */
  setNotebooks: (notebooks: Notebook[], selectedNotebookId?: string | null) => void;
  setStartupPhase: (phase: NoteLibraryStartupPhase, error?: string | null) => void;
  setStartupReady: (initialMemoQueryKey: string) => void;
  setSelectedNote: (identity: SelectedNoteIdentity | null) => void;
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
  triggerNotebookMetadataRefresh: () => void;
  /** Invalidate only the currently selected memo-list query. */
  triggerMemoListRefresh: () => void;
  // Data loading
  loadNotes: (params?: { notebookId?: string; filter?: ExtendedFilterType; sort?: SortType; tagId?: string; source?: string }) => Promise<boolean>;
  upsertCreatedNote: (created: CreatedNoteDocument) => void;
  /** Resume an unloaded query; preserve an existing browsing window. */
  handleMemoListInvalidation: (notebookId: string) => void;
  rebaseNoteListPaths: (notebookId: string, from: string, to: string, directory: boolean) => void;
  /** Patch loaded cards without changing order or cursor; null removes a row. */
  applyNoteListChange: (notebookId: string, relativePath: string, entry: NoteEntry | null) => void;
  applyNoteListBatch: (changes: readonly { notebookId: string; relativePath: string; entry: NoteEntry | null }[]) => void;
  loadMoreMemos: () => Promise<boolean>;
  loadNotebooks: () => Promise<void>;
  createNote: (tag: string | undefined, notebookId: string) => Promise<CreatedNoteDocument>;
  /** Invalidate the Note list after create/delete events that change its query result. */
  handleMemoEvent: () => void;
}


function toNoteListItem(
  note: Awaited<ReturnType<typeof noteRepository.listByPath>>['notes'][number],
  notebookId: string,
): NoteListItem {
  const relativePath = note.relativePath.replace(/\\/g, '/');
  return {
    ...note,
    kind: 'path-note',
    notebookId,
    relativePath,
    filename: relativePath.split('/').pop() || relativePath,
    thumbnail: note.thumbnail,
    properties: note.properties as Record<string, unknown>,
  };
}

export function getVisibleCreateFilter(filter: ExtendedFilterType): ExtendedFilterType {
  return filter === 'agents' || filter === 'todos' || filter === 'color' || filter === 'custom' ? 'all' : filter;
}

// 只恢复侧边栏能够表达的导航入口。颜色 / 时间等筛选属于中间列的
// 临时筛选，持久化它们会导致重启后侧边栏没有任何对应的选中项。
function isSidebarNavigationFilter(
  filter: ExtendedFilterType,
): filter is 'all' | 'agents' | 'todos' | 'tagged' | 'custom' {
  return filter === 'all'
    || filter === 'agents'
    || filter === 'todos'
    || filter === 'tagged'
    || filter === 'custom';
}

const listSession = new NoteListSession<NoteListChange>(
  (change) => `${change.notebookId}\u0000${change.kind}\u0000${change.relativePath}`,
);

function currentNoteQueryKey(state: NoteLibraryStore): string {
  return getNoteQueryKey(
    state.selectedNotebook?.id, state.activeFilter, state.activeSort,
    state.activeFilter === 'tagged' ? useTagStore.getState().selectedTagId : null,
    state.colorFilter, state.activePluginId,
    state.activeFilter === 'custom' ? state.activeCustomFilterId : null,
    state.dataConditionsByNotebook?.[state.selectedNotebook?.id ?? ''],
  );
}

/**
 * The list query implied by the current filter state. Loading the list and
 * deciding whether a freshly created note belongs in it must agree, so both
 * go through this builder instead of re-deriving the fields at each call site.
 */
function currentListQuery(
  state: NoteLibraryStore,
  notebookId: string,
): MemoListPageQuery & { notebookId: string } {
  const filter = state.activeFilter;
  return {
    notebookId,
    filter,
    sort: state.activeSort,
    tagId: filter === 'tagged' ? useTagStore.getState().selectedTagId ?? undefined : undefined,
    color: filter === 'color' ? state.colorFilter : undefined,
    pluginId: state.activePluginId,
    customFilterId: filter === 'custom' ? state.activeCustomFilterId : null,
    dataCondition: state.dataConditionsByNotebook?.[notebookId] ?? null,
  };
}

function getCustomFilter(notebookId: string, filterId: string | null): CustomFilter | null {
  if (!filterId) return null;
  return useCustomFilterStore.getState().filtersByNotebook[notebookId]
    ?.find((filter) => filter.id === filterId) ?? null;
}

function mapMemoPage(
  notes: Awaited<ReturnType<typeof noteRepository.listByPath>>['notes'],
  notebookId: string,
  customFilter: CustomFilter | null,
): NoteListItem[] {
  return notes
    .map((note) => toNoteListItem(note, notebookId))
    .filter((note) => !customFilter || memoMatchesCustomFilter(note, customFilter));
}

let memoFilterPropertyRegistry: ReturnType<typeof usePropertyPresetStore.getState>['registry'] | null = null;
let memoFilterPropertyFields: NoteFilterField[] = [];

function getMemoFilterPropertyFields(): NoteFilterField[] {
  const registry = usePropertyPresetStore.getState().registry;
  if (registry !== memoFilterPropertyRegistry) {
    memoFilterPropertyRegistry = registry;
    memoFilterPropertyFields = getAllPresets(
      [...(registry.systemFields ?? []), ...registry.fields],
      (key) => key,
    ).map((preset) => ({ id: preset.key, property_key: preset.key, type: preset.kind }));
  }
  return memoFilterPropertyFields;
}

function matchesMemoDataCondition(memo: NoteListItem, condition?: NoteFilterCondition | null): boolean {
  return createNoteFilterMatcher(condition, getMemoFilterPropertyFields())(memo);
}

async function loadMatchingMemoPage(
  query: MemoListPageQuery & { notebookId: string },
  customFilter: CustomFilter | null,
  isCurrent: () => boolean,
  cursor?: string,
) {
  const notes: NoteListItem[] = [];
  let nextCursor = cursor;
  let hasMore = false;
  const matchesDataCondition = createNoteFilterMatcher(query.dataCondition, getMemoFilterPropertyFields());
  const titleFilter = noteFilterTitleQuery(query.dataCondition);
  do {
    const response = await noteRepository.listByPath({
      notebookId: query.notebookId,
      filter: toBackendFilter(query.filter),
      sort: query.sort,
      tagId: query.tagId,
      color: query.color,
      ...(nextCursor ? { cursor: nextCursor } : {}),
      limit: MEMO_LIST_PAGE_SIZE - notes.length,
      titleFilter,
    });
    if (!isCurrent()) return { notes: [], nextCursor: null, hasMore: false };
    notes.push(...mapMemoPage(response.notes, query.notebookId, customFilter)
      .filter(matchesDataCondition));
    const previousCursor = nextCursor;
    nextCursor = response.nextCursor ?? undefined;
    hasMore = (response.hasMore ?? Boolean(nextCursor)) && Boolean(nextCursor);
    if (nextCursor && nextCursor === previousCursor) {
      hasMore = false;
      break;
    }
  } while (query.dataCondition && hasMore && notes.length < MEMO_LIST_PAGE_SIZE);
  return { notes, nextCursor: nextCursor ?? null, hasMore };
}

function matchesMemoListQuery(
  memo: NoteListItem,
  query: MemoListPageQuery,
  customFilter: CustomFilter | null,
  now = Date.now(),
): boolean {
  if (!matchesMemoDataCondition(memo, query.dataCondition)) return false;
  if (query.pluginId) {
    return normalizePluginId(memo.properties.flowix_plugin) === query.pluginId;
  }

  if (query.filter === 'custom') return Boolean(customFilter && memoMatchesCustomFilter(memo, customFilter));
  if (query.filter === 'color') {
    if (query.color === 'any') return memo.colors.length > 0;
    if (query.color === 'none') return memo.colors.length === 0;
    return Boolean(query.color && memo.colors.includes(query.color));
  }
  if (query.filter === 'favorited') return memo.favorited;
  if (query.filter === 'todos') return memo.todos.length > 0;
  if (query.filter === 'agents') return memo.agents.length > 0;
  if (query.filter === 'tagged') {
    if (!query.tagId) return memo.tags.length > 0;
    return memo.tags.some((tag) => tag === query.tagId || tag.startsWith(`${query.tagId}/`));
  }
  if (query.filter === 'thisWeek' || query.filter === 'thisMonth') {
    const date = new Date(now);
    const start = query.filter === 'thisWeek'
      ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
      : Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    return memo.createdAt >= start && memo.createdAt <= now;
  }
  return true;
}

function applySessionUpdates(
  notes: NoteListItem[],
  query: MemoListPageQuery,
  customFilter: CustomFilter | null,
): NoteListItem[] {
  const updated = applyNoteListChanges(notes, listSession.changes(), note => matchesMemoListQuery(note, query, customFilter));
  return query.dataCondition
    ? updated.filter(note => matchesMemoDataCondition(note, query.dataCondition))
    : updated;
}

function mergeMemoListItems(
  existing: readonly NoteListItem[],
  incoming: readonly NoteListItem[],
): NoteListItem[] {
  const byPath = new Map(existing.map((note) => [
    `${note.notebookId}\u0000${note.relativePath}`,
    note,
  ]));
  for (const note of incoming) {
    byPath.set(`${note.notebookId}\u0000${note.relativePath}`, note);
  }
  return [...byPath.values()];
}

function invalidatePendingMemoLoads(): void {
  listSession.invalidate();
}

export const useNoteStore = create<NoteLibraryStore>()(
  persist(
    (set, get) => ({
      notes: [],
      notebooks: [],
      notebooksInitialized: false,
      startupPhase: 'idle',
      startupError: null,
      initialMemoQueryKey: null,
      selectedNote: null,
      selectedNotebook: null,
      selectedNotebookId: null,
      middleColumnView: 'notes',
      activeFilter: 'all',
      activePluginId: null,
      activeCustomFilterId: null,
      activeSort: 'createdAt',
      dataConditionsByNotebook: {},
      setDataCondition: (notebookId, condition) => {
        // Location is stored separately by the navigation entry point.
        const normalized: NoteFilterCondition = normalizeNoteFilterCondition({ ...condition, path: null });
        delete normalized.path;
        const properties = normalized.property_conditions ?? [];
        set(state => {
          const conditions = { ...state.dataConditionsByNotebook };
          if (properties.length || normalized.file_condition?.file_name_contains || normalized.file_condition?.file_type) {
            conditions[notebookId] = normalized;
          } else {
            delete conditions[notebookId];
          }
          if (JSON.stringify(state.dataConditionsByNotebook?.[notebookId]) === JSON.stringify(conditions[notebookId])) return state;
          if (state.selectedNotebook?.id === notebookId) invalidatePendingMemoLoads();
          return { dataConditionsByNotebook: conditions, memoListLoadingMore: false };
        });
      },
      colorFilter: 'any',
      refreshTrigger: 0,
      memoListRefreshTrigger: 0,
      memoListQueryKey: null,
      memoListQuery: null,
      memoListNextCursor: null,
      memoListHasMore: false,
      memoListLoadingMore: false,

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
          selectedNote: state.selectedNote
            && state.selectedNote.notebookId === selectedNotebook?.id
            && notebooks.some((notebook) => notebook.id === state.selectedNote?.notebookId)
            ? state.selectedNote
            : null,
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
      setSelectedNote: (selectedNote) => set({ selectedNote }),
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
            selectedNote: null,
            notes: [],
            middleColumnView: 'notes',
            activeFilter: 'all',
            activePluginId: null,
            activeCustomFilterId: null,
          });
          return;
        }
        set({ selectedNotebook: notebook, selectedNotebookId: nextNotebookId });
      },
      // Surface navigation is independent from note filtering. Keep the last
      // note filter intact while the user visits the conversation surface.
      setMiddleColumnView: (view) => {
        const previous = get();
        if (previous.middleColumnView === view) return;
        set({
          middleColumnView: view,
          ...(view === 'notes' && previous.activeFilter === 'agents'
            ? { activeFilter: 'all', activeCustomFilterId: null, activePluginId: null }
            : {}),
        });
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
          ...(filter === 'custom' ? {} : { activeCustomFilterId: null }),
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
      triggerNotebookMetadataRefresh: () => set(state => ({ refreshTrigger: state.refreshTrigger + 1 })),
      triggerRefresh: () => set((state) => ({
        refreshTrigger: state.refreshTrigger + 1,
        memoListRefreshTrigger: state.memoListRefreshTrigger + 1,
      })),
      triggerMemoListRefresh: () => set((state) => ({
        memoListRefreshTrigger: state.memoListRefreshTrigger + 1,
      })),

      loadNotes: async (params) => {
        const state = get();
        const notebookId = params?.notebookId || state.selectedNotebook?.id;
        if (!notebookId) return false;
        const requestSeq = listSession.beginQuery();
        try {
          await useCustomFilterStore.getState().loadNotebookFilters(notebookId);
          if (!listSession.isCurrent(requestSeq)) return false;
          const filter = params?.filter || state.activeFilter;
          const pluginId = state.activePluginId;
          const customFilterId = filter === 'custom' ? state.activeCustomFilterId : null;
          const sort = params?.sort || state.activeSort;
          const tagId = params?.tagId
            ?? (filter === 'tagged' ? useTagStore.getState().selectedTagId ?? undefined : undefined);
          const color = filter === 'color' ? state.colorFilter : undefined;
          const queryKey = getNoteQueryKey(
            notebookId,
            filter,
            sort,
            tagId ?? null,
            color ?? state.colorFilter,
            pluginId,
            customFilterId,
            state.dataConditionsByNotebook?.[notebookId],
          );
          const dataCondition = state.dataConditionsByNotebook?.[notebookId] ?? null;
          const customFilter = getCustomFilter(notebookId, customFilterId);
          const query: MemoListPageQuery & { notebookId: string } = {
            notebookId,
            filter,
            sort,
            tagId,
            color,
            pluginId,
            customFilterId,
            dataCondition,
          };
          if (query.pluginId) {
            recordMemoListRequest(queryKey, requestSeq, params?.source ?? 'unspecified');
            const indexed = await noteRepository.listAllByPath(query.notebookId);
            if (!listSession.isCurrent(requestSeq)) return false;
            const loadedNotes = indexed
              .map((note) => toNoteListItem(note, query.notebookId))
              .filter(note => matchesMemoListQuery(note, query, customFilter));
            const notes = applySessionUpdates(
              loadedNotes,
              query,
              customFilter,
            );
            listSession.finishQuery(requestSeq);
            set({
              notes,
              memoListQueryKey: queryKey,
              memoListQuery: query,
              memoListNextCursor: null,
              memoListHasMore: false,
            });
            return true;
          }

          recordMemoListRequest(queryKey, requestSeq, params?.source ?? 'unspecified');
          const response = await loadMatchingMemoPage(query, customFilter, () => listSession.isCurrent(requestSeq));
          if (!listSession.isCurrent(requestSeq)) return false;
          const hasMore = response.hasMore ?? Boolean(response.nextCursor);
          const notes = applySessionUpdates(
            response.notes,
            query,
            customFilter,
          );

          listSession.finishQuery(requestSeq);
          set({
            notes,
            memoListQueryKey: queryKey,
            memoListQuery: query,
            memoListNextCursor: response.nextCursor ?? null,
            memoListHasMore: hasMore,
          });
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('NOTE_INDEX_PENDING')) {
            useNotebookBackgroundStore.getState().pending(notebookId);
            return false;
          }
          // Backend status supplies a local failure/retry surface. Do not let
          // fire-and-forget refresh consumers reject during offline maintenance.
          if (message.includes('NOTE_INDEX_UNAVAILABLE')) return false;
          throw error;
        } finally {
          listSession.finishQuery(requestSeq);
          if (listSession.isCurrent(requestSeq)) {
            set({ memoListLoadingMore: false });
          }
        }
      },

      upsertCreatedNote: (created) => {
        const state = get();
        if (state.selectedNotebook?.id !== created.notebookId || state.activePluginId) return;
        const note = toNoteListItem(created.entry, created.notebookId);
        // Same predicate as the list loader. The hand-written copy that used to
        // live here drifted: it had no color / thisWeek / thisMonth branches, so
        // those filters admitted notes that the list itself would never show.
        const query = currentListQuery(state, created.notebookId);
        const customFilter = getCustomFilter(created.notebookId, query.customFilterId);
        if (!matchesMemoListQuery(note, query, customFilter)) return;
        invalidatePendingMemoLoads();
        set((current) => {
          const remaining = current.notes.filter((item) => (
            item.notebookId !== created.notebookId || item.relativePath !== note.relativePath
          ));
          const firstUnpinned = remaining.findIndex((item) => !item.favorited);
          const insertionIndex = note.favorited ? 0
            : firstUnpinned < 0 ? remaining.length : firstUnpinned;
          return {
            // Explicit creation leads the unpinned notes without displacing pinned notes.
            notes: [...remaining.slice(0, insertionIndex), note, ...remaining.slice(insertionIndex)],
            memoListLoadingMore: false,
          };
        });
      },

      handleMemoListInvalidation: (notebookId) => {
        const state = get();
        if (state.selectedNotebook?.id !== notebookId) return;
        // No current window exists yet after a cold-index/query transition.
        // Allow the loader to resume automatically when preparation finishes.
        if (state.memoListQueryKey !== currentNoteQueryKey(state)) {
          state.triggerMemoListRefresh();
        }
      },

      rebaseNoteListPaths: (notebookId, from, to, directory) => {
        const state = get();
        if (state.selectedNotebook?.id !== notebookId) return;
        const source = from.replace(/\\/g, '/');
        const destination = to.replace(/\\/g, '/');
        const change: NoteListChange = {
          kind: 'move', notebookId, relativePath: source,
          destination, directory,
        };
        listSession.remember(change);
        const query = state.memoListQuery;
        const notes = query?.notebookId === notebookId
          ? applyNoteListChanges(state.notes, [change], note => matchesMemoListQuery(note, query, getCustomFilter(notebookId, query.customFilterId)))
          : state.notes;
        const selected = state.selectedNote;
        let selectedNote = selected;
        if (selected?.notebookId === notebookId) {
          const selectedPath = selected.relativePath.replace(/\\/g, '/');
          if (selectedPath === source || (directory && selectedPath.startsWith(`${source}/`))) {
            selectedNote = { ...selected, relativePath: `${destination}${selectedPath.slice(source.length)}` };
          }
        }
        const filteredNotes = query?.dataCondition
          ? notes.filter(note => matchesMemoDataCondition(note, query.dataCondition))
          : notes;
        if (filteredNotes !== state.notes || selectedNote !== selected) set({ notes: filteredNotes, selectedNote });
        if (query?.dataCondition) get().triggerMemoListRefresh();
      },

      applyNoteListChange: (notebookId, relativePath, entry) => {
        get().applyNoteListBatch([{ notebookId, relativePath, entry }]);
      },

      applyNoteListBatch: (entries) => {
        const state = get();
        const changes: NoteListChange[] = entries
          .filter(change => change.notebookId === state.selectedNotebook?.id)
          .map(({ notebookId, relativePath, entry }) => ({
            kind: 'entry', notebookId,
            relativePath: relativePath.replace(/\\/g, '/'),
            memo: entry ? toNoteListItem(entry, notebookId) : null,
          }));
        if (!changes.length) return;
        for (const change of changes) listSession.remember(change);
        const query = state.memoListQuery;
        if (!query?.notebookId || query.notebookId !== state.selectedNotebook?.id) return;
        const customFilter = getCustomFilter(query.notebookId, query.customFilterId);
        const notes = applyNoteListChanges(state.notes, changes, note => matchesMemoListQuery(note, query, customFilter));
        if (notes !== state.notes) set({ notes });
        if (query.dataCondition && changes.some(change => change.kind === 'entry' && change.memo
          && matchesMemoListQuery(change.memo, query, customFilter)
          && !state.notes.some(note => note.relativePath === change.relativePath))) {
          get().triggerMemoListRefresh();
        }
      },

      loadMoreMemos: async () => {
        const state = get();
        const query = state.memoListQuery;
        if (
          listSession.loadingQuery
          || !state.memoListHasMore
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
        const currentQueryKey = currentNoteQueryKey(state);
        if (currentQueryKey !== state.memoListQueryKey) return false;

        const requestSeq = listSession.nextPage();
        const cursor = state.memoListNextCursor;
        set({ memoListLoadingMore: true });
        try {
          const customFilter = getCustomFilter(query.notebookId, query.customFilterId);
          const response = await loadMatchingMemoPage(
            { ...query, notebookId: query.notebookId }, customFilter, () => listSession.isCurrent(requestSeq), cursor,
          );
          if (!listSession.isCurrent(requestSeq)) return false;

          const hasMore = response.hasMore ?? Boolean(response.nextCursor);
          const notes = applySessionUpdates(
            mergeMemoListItems(
              get().notes,
              response.notes,
            ),
            query,
            customFilter,
          );
          set({
            notes,
            memoListNextCursor: response.nextCursor ?? null,
            memoListHasMore: hasMore,
          });
          return true;
        } finally {
          if (listSession.isCurrent(requestSeq)) {
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
        const previousById = new Map(get().notebooks.map((notebook) => [notebook.id, notebook] as const));
        const order = nextOrderIds.map((id, index) => ({
          id,
          sort: (index + 1) * 10,
        }));
        try {
          const updated = await notebookRepository.reorder(order);
          set({ notebooks: updated.map((notebook) => {
            const previous = previousById.get(notebook.id);
            return {
              ...notebook,
              memoCount: notebook.memoCount ?? previous?.memoCount,
              pinned: notebook.pinned ?? previous?.pinned,
            };
          }) as Notebook[] });
        } catch (error) {
          // 失败时重新拉一次 list 跟服务端对齐 (notebook 列表较短, 直接重拉比
          // 维护本地乐观回滚更稳)。
          noteStoreLogger.error('reorderNotebooks failed', { error });
          const nbList = await notebookRepository.list();
          set({ notebooks: nbList as Notebook[] });
        }
      },

      createNote: async (tag, notebookId) => {
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
        const result = await noteRepository.create(createTag, notebookId);
        get().upsertCreatedNote(result);
        // Other windows preserve their loaded window; this window reveals the created card directly.
        useTagStore.getState().triggerMetadataRefresh();
        return result;
      },
      // Legacy collection events preserve loaded cards while metadata refreshes.
      handleMemoEvent: () => {
        const state = get();
        if (state.selectedNotebook) state.handleMemoListInvalidation(state.selectedNotebook.id);
        state.triggerNotebookMetadataRefresh();
      },
    }),
    {
      name: STORAGE_KEYS.NOTE,
      partialize: (state) => ({
        // Persist identities and notebook-scoped list conditions. Entities are backend data
        // and may be renamed, deleted, or updated while the app is closed.
        selectedNotebookId: state.selectedNotebookId ?? state.selectedNotebook?.id ?? null,
        selectedNote: state.selectedNote,
        // 侧边栏入口要和中间列一起恢复。中间列的颜色 / 时间筛选不属于
        // 侧边栏导航，因此恢复时归位到“全部”。
        middleColumnView: state.middleColumnView,
        dataConditionsByNotebook: state.dataConditionsByNotebook,
        activeFilter: isSidebarNavigationFilter(state.activeFilter)
          ? state.activeFilter
          : 'all',
        activeCustomFilterId: state.activeFilter === 'custom'
          ? state.activeCustomFilterId
          : null,
      }),
    }
  )
);
