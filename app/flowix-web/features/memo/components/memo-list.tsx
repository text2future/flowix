'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  ArrowDownUp,
  Check,
  FolderPlus,
  LayoutList,
  ListFilter,
  Search,
  SquarePen,
} from 'lucide-react';
import {
  getVisibleCreateFilter,
  MEMO_COLOR_HEX,
  useMemoLibraryMetadataStore,
  useMemoStore,
  useTagStore,
  type ColorFilterValue,
  type MemoColor,
  type MemoItem,
} from '@features/memo';
import { resolveSelectedTagId } from '@features/memo/services/memo-list-metadata-service';
import { useMemoInsertAnimation } from '@features/memo/hooks/use-memo-insert-animation';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Button } from '@shared/ui/button';
import { Tooltip } from '@shared/ui/tooltip';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { DROPDOWN_DIVIDER_SKIN } from '@shared/ui/dropdown-divider';
import { MemoCard } from '@features/memo/components/memo-card';
import { openMemoSession } from '@features/memo/use-cases/open-memo-session';
import {
  getMemoListQueryKey,
  shouldShowMemoListLoading,
} from '@features/memo/components/memo-list-loading-state';
import { MemoListDataLoader } from '@features/memo/components/memo-list-data-loader';
import { memoRepository } from '@features/memo/services/memo-repository';
import { initializeMainWindowStartup } from '@app/main-window-startup';
import { clearWorkspaceDocument } from '@features/workspace/use-cases/workspace-navigation';
import {
  openBrowserColumnMemo,
} from '@features/workspace/use-cases/browser-column-navigation';
import { useI18n } from '@/lib/i18n';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { createLogger } from '@/lib/logger';
import { useDocumentStore } from '@features/document/store';
import { memos as memoApi } from '@platform/tauri/client';

import {
  COLOR_LABEL_KEYS,
  ColorFilterSubmenuContent,
} from './memo-list/color-filter-submenu';
import { MemoNavigationDropdown, MemoNavigationSubmenu } from './memo-navigation-dropdown';
import { MemoListViewTabs } from './memo-list-view-tabs';
import { MemoListNavigationDrawer } from './memo-list-navigation-drawer';
import { NotebookFolderView } from './notebook-folder-view';
import type { NotebookNoteCreateRequest } from './notebook-file-tree';
import { parentRelativePathForTreeCreate } from './memo-create-location';
import { useMemoListWindow } from './memo-list/use-memo-list-window';
import { useDynamicVirtualList } from './memo-list/use-dynamic-virtual-list';
import {
  findRunningAgentTypeForMemo,
  useRunningAgentTypeIndex,
} from './memo-list/running-agent-index';
const logger = createLogger('memo-list');

const HEADER_ICON_BTN_CLASS =
  'h-8 w-8 justify-center rounded-xl p-0 border border-[var(--border)] ' +
  'hover:bg-[var(--muted)] hover:text-[var(--primary)] text-[var(--foreground)]';

// 先以 10 条验证动态虚拟化在真实列表中的行为，稳定后再提升到 50。
const MEMO_VIRTUALIZATION_THRESHOLD = 10;

function EmptyState() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 text-[var(--muted-foreground)]">
      <span className="text-sm">{t("memo.list.emptyNotFound")}</span>
    </div>
  );
}

interface MemoListProps {
  /** The full left navigation owns these controls when it is visible. */
  navigationDrawerEnabled?: boolean;
  /** Keep the memo list mounted while the middle column shows conversations. */
  isActive?: boolean;
  dataLoadingEnabled?: boolean;
}

export function MemoList({
  navigationDrawerEnabled = true,
  isActive = true,
  dataLoadingEnabled = true,
}: MemoListProps) {
  const { t } = useI18n();
  const [showScrollTopHint, setShowScrollTopHint] = useState(false);
  const { registerCard, prepareForInsert, onListRendered } =
    useMemoInsertAnimation();
  // 滚动容器由 OverlayScrollbar 提供。动态虚拟列表只负责在这个节点内
  // 维护可见窗口，不接管 OverlayScrollbar 的滚动条和滚动事件。
  const listContainerRef = useRef<HTMLDivElement>(null);
  // 切片订阅: 替代原来的 `useMemoStore()` 全量订阅。每个 useStore 只取用到的字段,
  // 切到 selector 后, 列表里 5k 笔记的任何 set 都不会让本组件不必要地重渲 ──
  // memos 是大头, 但要 memoize (Array equality) 才能跳过 5k 项深比; 不然
  // store 里 setNotebooks 之类也会触发 memos selector 重跑。Zustand v5 默认
  // 用 Object.is 比对, 同一个 memos 引用相等就跳过, 不需要 useMemo。
  const memos = useMemoStore((s) => s.memos);
  const selectedMemo = useMemoStore((s) => s.selectedMemo);
  const memoListView = useUserSettingsStore((s) => s.settings.memoListView);
  const updateSettings = useUserSettingsStore((s) => s.updateSettings);
  const selectedNotebook = useMemoStore((s) => s.selectedNotebook);
  const refreshTrigger = useMemoStore((s) => s.refreshTrigger);
  const activeFilter = useMemoStore((s) => s.activeFilter);
  const activePluginId = useMemoStore((s) => s.activePluginId);
  const activeSort = useMemoStore((s) => s.activeSort);
  const colorFilter = useMemoStore((s) => s.colorFilter);
  const startupPhase = useMemoStore((s) => s.startupPhase);
  const startupError = useMemoStore((s) => s.startupError);
  const initialMemoQueryKey = useMemoStore((s) => s.initialMemoQueryKey);
  const memoListQueryKey = useMemoStore((s) => s.memoListQueryKey);
  const middleColumnView = useMemoStore((s) => s.middleColumnView);
  const selectedNotebookId = selectedNotebook?.id;
  const selectedTagId = useTagStore((s) => s.selectedTagId);
  const tagMetadataRefreshVersion = useTagStore((s) => s.metadataRefreshVersion);
  const runningAgentTypeIndex = useRunningAgentTypeIndex();
  const getRunningAgentTypeForMemo = useCallback(
    (memo: MemoItem) => findRunningAgentTypeForMemo(runningAgentTypeIndex, memo),
    [runningAgentTypeIndex],
  );
  const activeTagId = activeFilter === 'tagged' ? selectedTagId : null;
  const setSelectedTagId = useTagStore((s) => s.setSelectedTagId);
  const loadLibraryMetadata = useMemoLibraryMetadataStore((s) => s.loadMetadata);
  const {
    setSelectedMemo,
    setSelectedNotebook,
    triggerRefresh,
    setActiveFilter,
    setActiveSort,
    setColorFilter,
    loadMemos,
    loadMoreMemos,
    memoListHasMore,
    memoListLoadingMore,
    handleMemoCreated,
  } = useMemoStore(
    useShallow((s) => ({
      setSelectedMemo: s.setSelectedMemo,
      setSelectedNotebook: s.setSelectedNotebook,
      triggerRefresh: s.triggerRefresh,
      setActiveFilter: s.setActiveFilter,
      setActiveSort: s.setActiveSort,
      setColorFilter: s.setColorFilter,
      loadMemos: s.loadMemos,
      loadMoreMemos: s.loadMoreMemos,
      memoListHasMore: s.memoListHasMore,
      memoListLoadingMore: s.memoListLoadingMore,
      handleMemoCreated: s.handleMemoCreated,
    })),
  );
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [notebookDropdownOpen, setNotebookDropdownOpen] = useState(false);
  const [navigationDrawerOpen, setNavigationDrawerOpen] = useState(false);
  const [colorSubmenuOpen, setColorSubmenuOpen] = useState(false);
  const [sortSubmenuOpen, setSortSubmenuOpen] = useState(false);
  const [viewSubmenuOpen, setViewSubmenuOpen] = useState(false);
  const [createFolderRequest, setCreateFolderRequest] = useState<{
    id: number;
    parentPath: string;
  } | null>(null);
  const [createNoteRequest, setCreateNoteRequest] = useState<NotebookNoteCreateRequest | null>(null);
  const [tagMap, setTagMap] = useState<Record<string, string>>({});
  const [isMemoListLoading, setIsMemoListLoading] = useState(false);
  const [loadedMemoListQueryKey, setLoadedMemoListQueryKey] = useState<string | null>(null);
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  useEffect(() => {
    setCreateFolderRequest(null);
    setCreateNoteRequest(null);
  }, [selectedNotebook?.id]);

  useEffect(() => {
    if (!navigationDrawerEnabled) setNavigationDrawerOpen(false);
  }, [navigationDrawerEnabled]);

  const handleRetryStartup = useCallback(() => {
    void initializeMainWindowStartup().catch((error) => {
      logger.warn('retry memo library initialization failed', { error });
      toast.error(t('memo.list.loadFailed'));
    });
  }, [t]);

  const handleMemoListLoadError = useCallback((error: unknown) => {
    logger.warn('load memos failed', { error });
    toast.error(t('memo.list.loadFailed'));
  }, [t]);

  const handleLoadMoreMemos = useCallback(() => {
    void loadMoreMemos().catch((error) => {
      handleMemoListLoadError(error);
    });
  }, [handleMemoListLoadError, loadMoreMemos]);

  const loadData = useCallback(async () => {
    if (!isActiveRef.current || startupPhase !== 'ready') return;

    const currentNotebook = useMemoStore.getState().selectedNotebook;
    if (!currentNotebook) {
      if (!isActiveRef.current) return;
      setSelectedNotebook(null);
      setSelectedMemo(null);
      void clearWorkspaceDocument();
      setSelectedTagId(null);
      setLoadedMemoListQueryKey(null);
      setIsMemoListLoading(false);
      return;
    }

    const libraryMetadata = await loadLibraryMetadata(
      currentNotebook,
      tagMetadataRefreshVersion
    );
    if (!isActiveRef.current || useMemoStore.getState().startupPhase !== 'ready') return;
    if (!libraryMetadata) return;
    if (useMemoStore.getState().selectedNotebook?.id !== currentNotebook.id) return;

    setTagMap(libraryMetadata.tagMap);

    // selectedTagId 校验: 防止 useTagStore 持久化残留 "已不存在的 tag" 选中态。
    // 用当前 selectedTagId 重新校验 (而非 loadData 开头取的旧值): IPC 期间
    // selectedTagId 可能已变 (重命名 commitRename 更新到新 fullPath), 用旧值
    // 校验出的 null 会覆盖新值, 选中态丢成"全部"。
    const latestSelectedTagId = useTagStore.getState().selectedTagId;
    const resolvedSelectedTagId = resolveSelectedTagId(latestSelectedTagId, libraryMetadata.tagOptions);
    if (resolvedSelectedTagId !== latestSelectedTagId) {
      setSelectedTagId(resolvedSelectedTagId);
    }

  }, [loadLibraryMetadata, setSelectedMemo, setSelectedNotebook, setSelectedTagId, startupPhase, tagMetadataRefreshVersion]);

  useEffect(() => {
    void loadData().catch((error) => {
      if (!isActiveRef.current) return;
      logger.warn('load list metadata failed', { error });
      toast.error(t('memo.list.loadFailed'));
    });
  }, [isActive, loadData, refreshTrigger, selectedNotebookId, t]);

  const currentMemoListQueryKey = getMemoListQueryKey(
    selectedNotebookId,
    activeFilter,
    activeSort,
    activeTagId,
    colorFilter,
    activePluginId,
  );
  const showMemoListLoading = startupPhase === 'loading' || shouldShowMemoListLoading({
      selectedNotebookId,
      isMemoListLoading,
      currentMemoListQueryKey,
      loadedMemoListQueryKey,
    });
  // 选中标签的展示名: tagMap 只收录真实 tag (id = 完整路径, 如
  // "Flowix/云存储"), 不含路径前缀 segment。选中父节点 (e.g. "Flowix")
  // 时 selectedTagId = fullPath "Flowix" 是前缀而非任何 memo 的真实 tag,
  // tagMap 取不到, fallback 到 activeTagId (即 fullPath) 本身展示 ──
  // 与 memo-card 的 `tagMap[tagId] || tagId` 同模式。
  const activeTagName = activeTagId ? (tagMap[activeTagId] ?? activeTagId) : null;

  // 顶部标题文案: 有筛选条件时只展示筛选后缀 (如 "#云存储" / "待办"), 不再带
  // 笔记本名或"全部"前缀; 无任何筛选时展示"全部"。thisWeek/thisMonth 同样计入
  // 筛选条件, 避免选了"只看本周"顶部却仍显示"全部"的误导。tagged 但无具体 tag
  // (activeTagName 为空) 时退回"全部"。
  const { headerLabel, hasActiveFilter } = (() => {
    const parts: string[] = [];
    if (activePluginId) {
      return {
        headerLabel: activePluginId === 'mindmap'
          ? '思维导图'
          : activePluginId === 'webpage' ? '网页' : activePluginId,
        hasActiveFilter: true,
      };
    }
    // tag 保留 "#" 前缀; 其余筛选 (待办/对话/颜色/只看本周/只看本月) 仅展示文案,
    // 不带 "@" 前缀。
    if (activeTagName) parts.push(`#${activeTagName}`);
    if (activeFilter === 'todos') parts.push(t('memo.list.filterTasks'));
    if (activeFilter === 'agents') parts.push(t('memo.navigation.conversations'));
    if (activeFilter === 'color') {
      const colorLabel =
        colorFilter === 'any'
          ? t('memo.list.filterColorAny')
          : colorFilter === 'none'
            ? t('document.color.noColorTooltip')
            : t(COLOR_LABEL_KEYS[colorFilter]);
      parts.push(colorLabel);
    }
    if (activeFilter === 'thisWeek') parts.push(t('memo.list.filterThisWeek'));
    if (activeFilter === 'thisMonth') parts.push(t('memo.list.filterThisMonth'));
    return parts.length > 0
      ? { headerLabel: parts.join(' '), hasActiveFilter: true }
      : { headerLabel: t('memo.navigation.allNotes'), hasActiveFilter: false };
  })();

  // 颜色筛选现在由后端分页接口执行, 这里保留二次过滤作为防御性兼容:
  //   'any'  → memo.colors.length > 0
  //   'none' → memo.colors.length === 0
  //   具体颜色 → memo.colors.includes(c)
  // 仅当 activeFilter === 'color' 时启用, 其他 filter 原样透传。
  const {
    filteredMemos,
    renderedMemos,
    onScroll: handleMemoListScroll,
  } = useMemoListWindow({
    memos,
    activeFilter,
    colorFilter,
    selectedMemoId: selectedMemo?.id,
    queryKey: currentMemoListQueryKey,
    loading: showMemoListLoading,
    hasMorePages: memoListHasMore,
    loadingMorePages: memoListLoadingMore,
    loadMorePages: handleLoadMoreMemos,
    scrollerRef: listContainerRef,
    isActive: isActive && dataLoadingEnabled,
  });

  const memoVirtualizationEnabled =
    filteredMemos.length > MEMO_VIRTUALIZATION_THRESHOLD;
  // ResizeObserver is required for dynamic rows. Older/non-browser test
  // environments gracefully keep the existing document-flow renderer.
  const shouldVirtualizeMemos =
    memoVirtualizationEnabled && typeof ResizeObserver !== 'undefined';
  const getMemoKey = useCallback((memo: MemoItem) => memo.id, []);
  const estimateMemoSize = useCallback(
    (memo: MemoItem) => memo.thumbnail ? 208 : 136,
    [],
  );
  const {
    totalSize: virtualListTotalSize,
    virtualItems,
    getMeasureRef,
    onScroll: handleVirtualListScroll,
  } = useDynamicVirtualList({
    items: renderedMemos,
    getKey: getMemoKey,
    estimateSize: estimateMemoSize,
    scrollerRef: listContainerRef,
    enabled: shouldVirtualizeMemos,
    resetKey: 'detailed',
    keepAliveKeys: [selectedMemo?.id, openDropdown].filter(
      (id): id is string => Boolean(id),
    ),
  });

  // ─── row ref 缓存 ──────────────────────────────────────────────
  // 同一 memo.id 跨 render 拿到**稳定**的 ref 回调, 避免 React 在重渲时
  // 反复调 null/node (动态 virtualizer 仍通过 cardRefs 拿节点做入场动画,
  // 稳定 ref 让它能稳定命中)。
  const rowRefCacheRef = useRef<
    Map<string, (el: HTMLDivElement | null) => void>
  >(new Map());
  const registerCardRef = useRef(registerCard);
  registerCardRef.current = registerCard;
  const getMemoRowRef = (id: string) => {
    const cached = rowRefCacheRef.current.get(id);
    if (cached) return cached;
    const cb = (el: HTMLDivElement | null) => {
      registerCardRef.current(id)(el);
      if (!el) rowRefCacheRef.current.delete(id);
    };
    rowRefCacheRef.current.set(id, cb);
    return cb;
  };
  const measuredRowRefCacheRef = useRef<
    Map<string, (el: HTMLDivElement | null) => void>
  >(new Map());
  const getMeasuredMemoRowRef = (id: string) => {
    const cached = measuredRowRefCacheRef.current.get(id);
    if (cached) return cached;
    const cardRef = getMemoRowRef(id);
    const measureRef = getMeasureRef(id);
    const cb = (el: HTMLDivElement | null) => {
      cardRef(el);
      measureRef(el);
      if (!el) measuredRowRefCacheRef.current.delete(id);
    };
    measuredRowRefCacheRef.current.set(id, cb);
    return cb;
  };
  const handleSelectMemo = useCallback((memo: MemoItem) => {
    void openMemoSession(memo, useMemoStore.getState().selectedNotebook);
  }, []);

  const handleOpenMemoWindow = useCallback((memo: MemoItem) => {
    void openBrowserColumnMemo(memo, useMemoStore.getState().selectedNotebook, 'open-in-column')
      .catch((error) => {
        logger.warn('open memo in browser column failed', { error, memoId: memo.id });
        toast.error(error instanceof Error ? error.message : String(error));
      });
  }, [t]);

  const handleRequestDeleteMemo = useCallback((memo: MemoItem) => {
    window.dispatchEvent(new CustomEvent<MemoItem>('flowix:request-delete-memo', { detail: memo }));
  }, []);

  const handleFavoriteToggle = useCallback(async (memo: MemoItem) => {
    await (memo.favorited
      ? memoRepository.unfavorite(memo.id)
      : memoRepository.favorite(memo.id));
    triggerRefresh();
  }, [triggerRefresh]);

  const handleColorsChange = useCallback(async (memo: MemoItem, colors: MemoColor[]) => {
    await memoRepository.setColors(memo.id, colors);
  }, []);

  const renderMemoRow = (memo: MemoItem, start?: number) => {
    const rowRef = getMeasuredMemoRowRef(memo.id);
    const isVirtualRow = start !== undefined;
    return (
      <div
        key={memo.id}
        ref={rowRef}
        className="min-w-0 w-full"
        style={
          isVirtualRow
            ? {
                position: 'absolute',
                top: start,
                left: 0,
                right: 0,
              }
            : undefined
        }
      >
        <div data-insert-anim className="min-w-0 w-full">
          <MemoCard
            memo={memo}
            tagMap={tagMap}
            isSelected={selectedMemo?.id === memo.id}
            isDropdownOpen={openDropdown === memo.id}
            runningAgentType={getRunningAgentTypeForMemo(memo) ?? undefined}
            onOpenDropdown={setOpenDropdown}
            onSelect={handleSelectMemo}
            onOpenInWindow={handleOpenMemoWindow}
            onFavoriteToggle={handleFavoriteToggle}
            onDelete={handleRequestDeleteMemo}
            onColorsChange={handleColorsChange}
          />
          <hr className={cn('mx-3', DROPDOWN_DIVIDER_SKIN)} />
        </div>
      </div>
    );
  };

  const renderedMemoRows = shouldVirtualizeMemos
    ? virtualItems.map(({ item, start }) => renderMemoRow(item, start))
    : renderedMemos.map((memo) => renderMemoRow(memo));

  const handleFilterChange = (filter: typeof activeFilter) => {
    if (filter !== 'tagged') {
      setSelectedTagId(null);
    }
    // 切到非 color filter 时, 保留 colorFilter 值, 切回时恢复 — 用户预期
    // 切到其他筛选再回来, 之前选的颜色还在。
    setActiveFilter(filter);
  };

  // 颜色二级弹窗的选中回调: 同步 activeFilter='color' + colorFilter, 同时
  // 显式关掉父 dropdown (子菜单 onMouseDown 阻止了冒泡, 父 dropdown
  // setOpen 不会自动触发, 需要手动 setNotebookDropdownOpen(false))。
  const handleColorSubmenuSelect = useCallback(
    (value: ColorFilterValue) => {
      setSelectedTagId(null);
      setColorFilter(value);
      setActiveFilter('color');
      setColorSubmenuOpen(false);
      setNotebookDropdownOpen(false);
    },
    [setActiveFilter, setColorFilter, setSelectedTagId, setNotebookDropdownOpen],
  );

  // 筛选二级弹窗的选中回调 (本周 / 本月): 同步 activeFilter + 关父 dropdown。
  const handleFilterFromSubmenu = useCallback(
    (filter: typeof activeFilter) => {
      handleFilterChange(filter);
      setColorSubmenuOpen(false);
      setNotebookDropdownOpen(false);
    },
    [handleFilterChange, setNotebookDropdownOpen],
  );

  // 排序二级弹窗的选中回调: 同步 activeSort + 关父 dropdown。
  const handleSortFromSubmenu = useCallback(
    (sort: typeof activeSort) => {
      setActiveSort(sort);
      setSortSubmenuOpen(false);
      setNotebookDropdownOpen(false);
    },
    [setActiveSort, setNotebookDropdownOpen],
  );

  // 视图二级弹窗的选中回调。
  const handleViewFromSubmenu = useCallback(
    (view: 'detailed' | 'folders') => {
      void updateSettings({ memoListView: view });
      setViewSubmenuOpen(false);
      setNotebookDropdownOpen(false);
    },
    [setNotebookDropdownOpen, updateSettings],
  );

  // 当 dropdown 关闭时, 同步把 filter / sort submenu 也收掉。
  useEffect(() => {
    if (!notebookDropdownOpen) {
      setColorSubmenuOpen(false);
      setSortSubmenuOpen(false);
      setViewSubmenuOpen(false);
    }
  }, [notebookDropdownOpen]);

  const handleCreateMemo = useCallback(async (
    parentRelativePathOverride?: string,
    titleOverride?: string,
  ) => {
    if (!selectedNotebook) return;
    const previousSelectedMemo = useMemoStore.getState().selectedMemo;
    const createFilter = getVisibleCreateFilter(activeFilter);
    if (createFilter !== activeFilter) {
      setSelectedTagId(null);
      setActiveFilter(createFilter);
    }
    setSelectedMemo(null);

    let result: MemoItem;
    try {
      const parentRelativePath = parentRelativePathOverride ?? (memoListView === 'folders'
        ? parentRelativePathForTreeCreate(
          useDocumentStore.getState().activeMemoSession,
          selectedNotebook.id,
          selectedNotebook.path,
        )
        : undefined);
      result = await memoRepository.create(
        activeTagId ?? undefined,
        selectedNotebook.id,
        parentRelativePath,
      );
    } catch (error) {
      setSelectedMemo(previousSelectedMemo);
      throw error;
    }

    if (!result) {
      setSelectedMemo(previousSelectedMemo);
      return;
    }

    let newMemo = result;
    const requestedTitle = titleOverride?.trim();
    if (requestedTitle && requestedTitle !== result.filename.replace(/\.md$/i, '')) {
      try {
        const renamed = await memoApi.renameMemoTitle({
          id: result.id,
          title: requestedTitle,
          expectedFilename: result.filename,
        });
        newMemo = renamed.memo;
      } catch (error) {
        setSelectedMemo(previousSelectedMemo);
        throw error;
      }
    }
    const shouldSelectNewMemo =
      createFilter === 'all' ||
      (createFilter === 'tagged' && Boolean(activeTagId)) ||
      createFilter === 'thisWeek' ||
      createFilter === 'thisMonth';

    // Synchronously capture pre-render positions BEFORE the store update that
    // adds the new memo. The animation itself runs in the useLayoutEffect below,
    // after React commits the new list but before the browser paints it.
    // 新 memo 永远渲染在列表最前，且初始窗口会包含它 ── 入场动画交给
    // useMemoInsertAnimation.onListRendered 在 layout 阶段跑一次。
    prepareForInsert(newMemo.id);
    // Opening is a workspace navigation transaction. Leave selection to the
    // facade so a failed document open can restore the previous memo.
    handleMemoCreated(newMemo, { select: false });

    if (shouldSelectNewMemo) {
      openMemoSession({ ...newMemo, isOpen: true }, selectedNotebook, { initialFocus: 'title' });
    }
  }, [
    activeFilter,
    activeTagId,
    handleMemoCreated,
    prepareForInsert,
    memoListView,
    selectedNotebook,
    setActiveFilter,
    setSelectedMemo,
    setSelectedTagId,
  ]);

  const handleCreateNoteInFolder = useCallback((parentPath: string, title: string) => {
    if (!selectedNotebook) return;
    const root = selectedNotebook.path.replace(/\/+$/, '');
    const parent = parentPath.replace(/\/+$/, '');
    if (parent !== root && !parent.startsWith(`${root}/`)) return;
    const relative = parent === root ? '' : parent.slice(root.length + 1);
    return handleCreateMemo(relative, title).catch((error) => {
      logger.warn('create memo in notebook folder failed', { error, parentPath });
      throw error;
    });
  }, [handleCreateMemo, selectedNotebook]);

  const handleRequestCreateNote = useCallback(() => {
    if (!selectedNotebook) return;
    const parentRelativePath = parentRelativePathForTreeCreate(
      useDocumentStore.getState().activeMemoSession,
      selectedNotebook.id,
      selectedNotebook.path,
    );
    const notebookRoot = selectedNotebook.path.replace(/\/+$/, '');
    setCreateNoteRequest({
      id: Date.now(),
      parentPath: parentRelativePath
        ? `${notebookRoot}/${parentRelativePath}`
        : notebookRoot,
    });
  }, [selectedNotebook]);

  const handleCreateFolder = useCallback(() => {
    if (!selectedNotebook) return;
    const parentRelativePath = parentRelativePathForTreeCreate(
      useDocumentStore.getState().activeMemoSession,
      selectedNotebook.id,
      selectedNotebook.path,
    );
    const notebookRoot = selectedNotebook.path.replace(/\/+$/, '');
    setCreateFolderRequest({
      id: Date.now(),
      parentPath: parentRelativePath
        ? `${notebookRoot}/${parentRelativePath}`
        : notebookRoot,
    });
  }, [selectedNotebook]);

  // 入场动画入口: 每次 memos 变化时 (含新建/更新/删除) 在 layout 阶段同步
  // 询问 useMemoInsertAnimation 是否有 pending 新 card, 有就跑一次入场
  // 动画; 无就是 no-op。 在 paint 之前跑, 避免首帧闪烁。
  useLayoutEffect(() => {
    onListRendered();
  }, [memos, onListRendered]);

  // 一级筛选 / 排序按钮尾部展示当前值。颜色组的取值是 colorFilter,其他筛选是
  // activeFilter 本身 (thisWeek / thisMonth);排序直接读 activeSort。
  const filterValueAdornment = (() => {
    if (activeFilter === 'thisWeek') return t('memo.list.filterThisWeek');
    if (activeFilter === 'thisMonth') return t('memo.list.filterThisMonth');
    if (activeFilter === 'color') {
      if (colorFilter === 'any') return t('memo.list.filterColorAny');
      if (colorFilter === 'none') return t('memo.list.filterColorNone');
      return t(COLOR_LABEL_KEYS[colorFilter]);
    }
    return null;
  })();
  const sortValueAdornment = activeSort === 'updatedAt'
    ? t('memo.list.sortUpdated')
    : t('memo.list.sortCreated');
  const activeView = memoListView;
  const viewValueAdornment = activeView === 'folders'
    ? t('memo.list.viewFolders')
    : t('memo.list.viewDetailed');

  return (
    <div className="memo-list relative flex h-full min-w-0 select-none flex-col bg-[var(--card)]">
      <MemoListDataLoader
        dataLoadingEnabled={dataLoadingEnabled}
        startupPhase={startupPhase}
        initialMemoQueryKey={initialMemoQueryKey}
        memoListQueryKey={memoListQueryKey}
        selectedNotebookId={selectedNotebookId}
        activeFilter={activeFilter}
        activeSort={activeSort}
        activeTagId={activeTagId}
        colorFilter={colorFilter}
        activePluginId={activePluginId}
        refreshTrigger={refreshTrigger}
        loadedMemoListQueryKey={loadedMemoListQueryKey}
        loadMemos={loadMemos}
        setLoadedMemoListQueryKey={setLoadedMemoListQueryKey}
        setIsMemoListLoading={setIsMemoListLoading}
        onLoadError={handleMemoListLoadError}
      />
      <>
      {/* Memo Tab */}
      <div className="flex min-w-0 items-center gap-2 px-3 pb-2">
        <div className="shrink-0">
          <MemoListViewTabs
            activeTab={middleColumnView === 'conversations' ? 'conversations' : 'notes'}
            onChange={(tab) => setActiveFilter(tab === 'conversations' ? 'agents' : 'all')}
            navigationDrawerEnabled={navigationDrawerEnabled}
            navigationDrawerOpen={navigationDrawerOpen}
            onToggleNavigationDrawer={() => setNavigationDrawerOpen((isOpen) => !isOpen)}
          />
        </div>
        <div className="min-w-0 flex-1">
          <MemoNavigationDropdown
            title={headerLabel}
            titleTooltip={hasActiveFilter ? headerLabel : undefined}
            ariaLabel={t('memo.navigation.menuTitle')}
            open={notebookDropdownOpen}
            onOpenChange={setNotebookDropdownOpen}
          >
          <div className="space-y-0.5">
            {/* Filter — 二级弹窗 (本周 / 本月 / 颜色组) */}
            <MemoNavigationSubmenu
              label={t('memo.list.filterLabel')}
              icon={<ListFilter className="h-4 w-4 shrink-0" aria-hidden="true" />}
              open={colorSubmenuOpen}
              hideHeader
              emptyText=""
              loadingText=""
              valueAdornment={filterValueAdornment && (
                <span className="flex max-w-[100px] items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
                  <span className="truncate">{filterValueAdornment}</span>
                  {activeFilter === 'color' && (
                    <span
                      aria-hidden
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor:
                          colorFilter === 'none'
                            ? 'transparent'
                            : colorFilter === 'any'
                              ? 'var(--muted-foreground)'
                              : MEMO_COLOR_HEX[colorFilter],
                        border: '1px solid var(--border)',
                      }}
                    />
                  )}
                </span>
              )}
              submenuContent={(
                <div className="flex flex-col space-y-0.5">
                  <button
                    type="button"
                    onClick={() => handleFilterFromSubmenu('thisWeek')}
                    onMouseDown={(event) => event.preventDefault()}
                    className={cn(
                      'memo-navigation-submenu-item mention-note-item cursor-pointer hover:bg-[var(--brand)] focus-visible:bg-[var(--brand)] focus-visible:outline-none',
                      activeFilter === 'thisWeek' && 'is-selected',
                    )}
                  >
                    <span className="mention-note-title">{t('memo.list.filterThisWeek')}</span>
                    {activeFilter === 'thisWeek' && <Check className="w-4 h-4 text-[var(--brand)]" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleFilterFromSubmenu('thisMonth')}
                    onMouseDown={(event) => event.preventDefault()}
                    className={cn(
                      'memo-navigation-submenu-item mention-note-item cursor-pointer hover:bg-[var(--brand)] focus-visible:bg-[var(--brand)] focus-visible:outline-none',
                      activeFilter === 'thisMonth' && 'is-selected',
                    )}
                  >
                    <span className="mention-note-title">{t('memo.list.filterThisMonth')}</span>
                    {activeFilter === 'thisMonth' && <Check className="w-4 h-4 text-[var(--brand)]" />}
                  </button>
                  <hr className={cn('mx-2 my-1 border-0', DROPDOWN_DIVIDER_SKIN)} />
                  <div className="px-2 pb-1 pt-1 text-xs font-normal leading-[1.2] text-[var(--muted-foreground)]">
                    {t('memo.list.filterColorGroup')}
                  </div>
                  <ColorFilterSubmenuContent
                    value={colorFilter}
                    onSelect={handleColorSubmenuSelect}
                  />
                </div>
              )}
              onOpenChange={setColorSubmenuOpen}
              onCloseMenu={() => setNotebookDropdownOpen(false)}
            />

            {/* Sort — 二级弹窗 */}
            <MemoNavigationSubmenu
              label={t('memo.list.sortLabel')}
              icon={<ArrowDownUp className="h-4 w-4 shrink-0" aria-hidden="true" />}
              open={sortSubmenuOpen}
              hideHeader
              emptyText=""
              loadingText=""
              valueAdornment={(
                <span className="max-w-[100px] truncate text-xs text-[var(--muted-foreground)]">
                  {sortValueAdornment}
                </span>
              )}
              submenuContent={(
                <div className="flex flex-col space-y-0.5">
                  <button
                    type="button"
                    onClick={() => handleSortFromSubmenu('createdAt')}
                    onMouseDown={(event) => event.preventDefault()}
                    className={cn(
                      'memo-navigation-submenu-item mention-note-item cursor-pointer hover:bg-[var(--brand)] focus-visible:bg-[var(--brand)] focus-visible:outline-none',
                      activeSort === 'createdAt' && 'is-selected',
                    )}
                  >
                    <span className="mention-note-title">{t('memo.list.sortCreated')}</span>
                    {activeSort === 'createdAt' && <Check className="w-4 h-4 text-[var(--brand)]" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSortFromSubmenu('updatedAt')}
                    onMouseDown={(event) => event.preventDefault()}
                    className={cn(
                      'memo-navigation-submenu-item mention-note-item cursor-pointer hover:bg-[var(--brand)] focus-visible:bg-[var(--brand)] focus-visible:outline-none',
                      activeSort === 'updatedAt' && 'is-selected',
                    )}
                  >
                    <span className="mention-note-title">{t('memo.list.sortUpdated')}</span>
                    {activeSort === 'updatedAt' && <Check className="w-4 h-4 text-[var(--brand)]" />}
                  </button>
                </div>
              )}
              onOpenChange={setSortSubmenuOpen}
              onCloseMenu={() => setNotebookDropdownOpen(false)}
            />

            {/* View — 二级弹窗 */}
            <MemoNavigationSubmenu
              label={t('memo.list.viewLabel')}
              icon={<LayoutList className="h-4 w-4 shrink-0" aria-hidden="true" />}
              open={viewSubmenuOpen}
              hideHeader
              emptyText=""
              loadingText=""
              valueAdornment={(
                <span className="max-w-[100px] truncate text-xs text-[var(--muted-foreground)]">
                  {viewValueAdornment}
                </span>
              )}
              submenuContent={(
                <div className="flex flex-col space-y-0.5">
                  <div className="px-2 pb-1 pt-1 text-xs font-normal leading-[1.2] text-[var(--muted-foreground)]">
                    {t('memo.list.viewCardGroup')}
                  </div>
                  {(['detailed', 'folders'] as const).map((view) => (
                    <button
                      key={view}
                      type="button"
                      onClick={() => handleViewFromSubmenu(view)}
                      onMouseDown={(event) => event.preventDefault()}
                      className={cn(
                        'memo-navigation-submenu-item mention-note-item cursor-pointer hover:bg-[var(--brand)] focus-visible:bg-[var(--brand)] focus-visible:outline-none',
                        activeView === view && 'is-selected',
                      )}
                    >
                      <span className="mention-note-title">
                        {view === 'detailed'
                          ? t('memo.list.viewDetailed')
                          : t('memo.list.viewFolders')}
                      </span>
                      {activeView === view && <Check className="w-4 h-4 text-[var(--brand)]" />}
                    </button>
                  ))}
                </div>
              )}
              onOpenChange={setViewSubmenuOpen}
              onCloseMenu={() => setNotebookDropdownOpen(false)}
            />
          </div>
          </MemoNavigationDropdown>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip content={t("memo.list.searchTooltip")} shortcut="palette.search">
            <Button
              size="icon"
              variant="outline"
              className={cn(HEADER_ICON_BTN_CLASS, 'bg-[var(--card)]')}
              onClick={() => window.dispatchEvent(new CustomEvent('flowix:open-palette'))}
              aria-label={t("memo.list.search")}
            >
              <Search className="w-4 h-4" />
            </Button>
          </Tooltip>
          {memoListView === 'folders' && (
            <Tooltip content={t('memo.fileTree.newFolder')}>
              <Button
                size="icon"
                variant="outline"
                className={cn(HEADER_ICON_BTN_CLASS, 'bg-[var(--card)]')}
                onClick={handleCreateFolder}
                aria-label={t('memo.fileTree.newFolder')}
              >
                <FolderPlus className="h-4 w-4" />
              </Button>
            </Tooltip>
          )}
          <Tooltip content={t("memo.list.newMemoTooltip")} shortcut="memo.create">
            <Button
              size="icon"
              className="h-8 w-8 justify-center rounded-xl border border-transparent bg-[var(--primary)] p-0 text-[var(--primary-foreground)] hover:opacity-90"
              onClick={() => {
                if (memoListView === 'folders') handleRequestCreateNote();
                else void handleCreateMemo();
              }}
            >
              <SquarePen className="h-4 w-4 text-[var(--primary-foreground)]" />
            </Button>
          </Tooltip>
        </div>
      </div>
      </>

      <div className="relative flex min-h-0 flex-1">
        {navigationDrawerEnabled && (
          <MemoListNavigationDrawer
            open={navigationDrawerOpen}
            selectedNotebook={selectedNotebook}
            onClose={() => setNavigationDrawerOpen(false)}
          />
        )}
        {startupPhase === 'error' && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-[var(--card)]/95">
            <div className="flex max-w-[260px] flex-col items-center gap-3 px-4 text-center">
              <span className="text-sm text-[var(--muted-foreground)]">
                {t('memo.list.loadFailed')}
              </span>
              {startupError && (
                <span className="max-w-full truncate text-xs text-[var(--muted-foreground)]" title={startupError}>
                  {startupError}
                </span>
              )}
              <Button size="sm" onClick={handleRetryStartup}>
                {t('error.retry')}
              </Button>
            </div>
          </div>
        )}
        {memoListView === 'folders' && selectedNotebook ? (
          <div className="min-h-0 min-w-0 w-full flex-1">
            <NotebookFolderView
              key={selectedNotebook.id}
              notebook={selectedNotebook}
              createFolderRequest={createFolderRequest}
              createNoteRequest={createNoteRequest}
              sort={activeSort}
              onCreateNote={handleCreateNoteInFolder}
            />
          </div>
        ) : (
        <OverlayScrollbar
          className="flex min-h-0 min-w-0 w-full flex-1"
          scrollerClassName="min-w-0 w-full flex-1 overflow-y-auto px-1 py-2"
          scrollerRef={listContainerRef}
          onScroll={(event) => {
            setShowScrollTopHint(event.currentTarget.scrollTop > 0);
            handleMemoListScroll(event);
            handleVirtualListScroll(event);
          }}
        >
          {memos.length > 0 ? (
            <div
              className={cn(
                'relative min-w-0 w-full',
                !shouldVirtualizeMemos && 'flex flex-col',
              )}
              style={
                shouldVirtualizeMemos
                  ? {
                      height: virtualListTotalSize,
                      overflowAnchor: 'none',
                    }
                  : undefined
              }
            >
              {renderedMemoRows}
            </div>
          ) : (
            <EmptyState />
          )}
        </OverlayScrollbar>
        )}

        {memoListView !== 'folders' && <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 z-[3] h-3 bg-gradient-to-b from-[color-mix(in_oklch,var(--foreground)_3%,transparent)] to-transparent transition-opacity duration-200',
            showScrollTopHint ? 'opacity-100' : 'opacity-0',
          )}
        />}

      </div>
    </div>
  );
}
