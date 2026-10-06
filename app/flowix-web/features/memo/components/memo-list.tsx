import { joinNotebookMemoPath } from '@/lib/path';
import { subscribe } from '@platform/tauri/event-bus';
'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  ArrowDownUp,
  ChevronDown,
  Check,
  SwatchBook,
  ListFilter,
  Loader2,
  MoreHorizontal,
  SquarePen,
} from 'lucide-react';
import {
  getVisibleCreateFilter,
  NOTE_COLOR_HEX,
  useNoteStore,
  type ColorFilterValue,
} from '@features/memo/store/note-store';
import { useMemoLibraryMetadataStore } from '@features/memo/store/memo-library-metadata-store';
import { useCustomFilterStore } from '@features/memo/store/custom-filter-store';
import { setDocumentProperties } from '@features/document/public/path-properties';
import { useTagStore } from '@features/memo/store/tag-store';
import {
  noteListItemKey,
  noteListItemRelativePath,
  type NoteColor,
  type NoteListItem,
} from '@/types/note-item';
import { resolveSelectedTagId } from '@features/memo/services/memo-list-metadata-service';
import { useMemoInsertAnimation } from '@features/memo/hooks/use-memo-insert-animation';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Button } from '@shared/ui/button';
import { Tooltip } from '@shared/ui/tooltip';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { ListSurfaceLoadingState, ListSurfaceViewport } from '@shared/ui/list-surface';
import { DROPDOWN_DIVIDER_SKIN } from '@shared/ui/dropdown-divider';
import { POPUP_SEPARATOR_CLASS } from '@shared/ui/popup-separator';
import { MemoCard } from '@features/memo/components/memo-card';
import { openPathNoteSession } from '@features/memo/use-cases/open-memo-session';
import { openNotebookNote } from '@features/memo/use-cases/open-notebook-note';
import {
  getMemoListQueryKey,
  shouldShowMemoListLoading,
} from '@features/memo/components/memo-list-loading-state';
import { MemoListDataLoader } from '@features/memo/components/memo-list-data-loader';
import { noteRepository } from '@features/memo/services/note-repository';
import { initializeMainWindowStartup } from '@app/main-window-startup';
import { clearWorkspaceDocument, openExternalTarget } from '@features/workspace/use-cases/workspace-navigation';
import { openBrowserColumnText } from '@features/workspace/use-cases/browser-column-navigation';
import { useI18n } from '@/lib/i18n';
import {
  useMemoListViewPreference,
} from '@features/preferences/public/runtime-api';
import { createLogger } from '@/lib/logger';
import { orderNoteTemplates } from '@/lib/note-template-order';
import { useDocumentStore } from '@features/document/store';
import { files as fileApi, notes as noteApi, type NoteTemplate } from '@platform/tauri/client';
import { canonicalDirectoryPath } from '@/lib/path';
import { AGENT_TYPES, isAgentTypeSelectable, isAlwaysVisibleNewConversationAgent } from '@/lib/agent-types';
import type { AgentTypeKey } from '@/types/agent';
import { AgentIcon } from '@features/agent/components/agent-icon';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
import { createAndOpenAgentConversation } from '@features/agent/public/shell-api';
import { isAgentRuntimeInstalledState, normalizeAgentRuntimeStatus } from '@features/agent/runtime/agent-runtime-status';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { createTableDocumentFile, type TableViewType } from '@features/multidimensional-table/public/create-api';
import { createMediaLibraryFile } from '@features/media-library/model';

import {
  COLOR_LABEL_KEYS,
  ColorFilterSubmenuContent,
} from './memo-list/color-filter-submenu';
import { MemoNavigationDropdown, MemoNavigationSubmenu } from './memo-navigation-dropdown';
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
  /** When provided, the notes tab is controlled by the main navigation drawer. */
  navigationDrawerOpen?: boolean;
  onToggleNavigationDrawer?: () => void;
  /** Keep the memo list mounted while the middle column shows conversations. */
  isActive?: boolean;
  dataLoadingEnabled?: boolean;
}

interface OpenCreateTableDialogRequest {
  notebookId: string;
  onCreated?: (selection: { relativePath: string; tableId: string; viewId: string }) => void | Promise<void>;
}

export function MemoList({
  navigationDrawerEnabled = true,
  navigationDrawerOpen: controlledNavigationDrawerOpen,
  onToggleNavigationDrawer,
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
  // 切片订阅: 替代原来的 `useNoteStore()` 全量订阅。每个 useStore 只取用到的字段,
  // 切到 selector 后, 列表里 5k 笔记的任何 set 都不会让本组件不必要地重渲 ──
  // memos 是大头, 但要 memoize (Array equality) 才能跳过 5k 项深比; 不然
  // store 里 setNotebooks 之类也会触发 memos selector 重跑。Zustand v5 默认
  // 用 Object.is 比对, 同一个 memos 引用相等就跳过, 不需要 useMemo。
  const notes = useNoteStore((s) => s.notes);
  const selectedNote = useNoteStore((s) => s.selectedNote);
  const memoListView = useMemoListViewPreference();
  const selectedNotebook = useNoteStore((s) => s.selectedNotebook);
  const showFolderView = memoListView === 'folders' && Boolean(selectedNotebook);
  const [createTypeMenuOpen, setCreateTypeMenuOpen] = useState(false);
  const [newTableDialogOpen, setNewTableDialogOpen] = useState(false);
  const [newTableName, setNewTableName] = useState('新建多维表格');
  const [newTableViewType, setNewTableViewType] = useState<TableViewType>('table');
  const [createTableDialogNotebookId, setCreateTableDialogNotebookId] = useState<string | null>(null);
  const createTableOnCreatedRef = useRef<OpenCreateTableDialogRequest['onCreated'] | null>(null);
  const [createMoreMenuOpen, setCreateMoreMenuOpen] = useState(false);
  const [isCreatingTable, setIsCreatingTable] = useState(false);
  const [newLibraryDialogOpen, setNewLibraryDialogOpen] = useState(false);
  const [newLibraryName, setNewLibraryName] = useState('');
  const [isCreatingLibrary, setIsCreatingLibrary] = useState(false);
  const [createTemplates, setCreateTemplates] = useState<NoteTemplate[]>([]);
  const agentRuntimeStatusByType = useAgentRuntimeStore((s) => s.statusByType);
  const agentRuntimeIsChecking = useAgentRuntimeStore((s) => s.isChecking);
  const refreshAgentRuntimeIfStale = useAgentRuntimeStore((s) => s.refreshIfStale);
  const refreshTrigger = useNoteStore((s) => s.refreshTrigger);
  const activeFilter = useNoteStore((s) => s.activeFilter);
  const activePluginId = useNoteStore((s) => s.activePluginId);
  const activeCustomFilterId = useNoteStore((s) => s.activeCustomFilterId);
  const loadNotebookFilters = useCustomFilterStore((s) => s.loadNotebookFilters);
  const activeSort = useNoteStore((s) => s.activeSort);
  const colorFilter = useNoteStore((s) => s.colorFilter);
  const activeCustomFilter = useCustomFilterStore((s) => (
    activeCustomFilterId
      ? s.filtersByNotebook[selectedNotebook?.id ?? '']?.find((filter) => filter.id === activeCustomFilterId) ?? null
      : null
  ));
  const startupPhase = useNoteStore((s) => s.startupPhase);
  const startupError = useNoteStore((s) => s.startupError);
  const initialMemoQueryKey = useNoteStore((s) => s.initialMemoQueryKey);
  const memoListQueryKey = useNoteStore((s) => s.memoListQueryKey);
  const selectedNotebookId = selectedNotebook?.id;
  useEffect(() => {
    const handleOpenCreateTableDialog = (event: Event) => {
      const requestEvent = event as CustomEvent<OpenCreateTableDialogRequest>;
      const notebook = useNoteStore.getState().notebooks.find((entry) => entry.id === requestEvent.detail?.notebookId);
      if (!notebook || notebook.missing) return;
      requestEvent.preventDefault();
      createTableOnCreatedRef.current = requestEvent.detail.onCreated;
      setCreateTableDialogNotebookId(notebook.id);
      setNewTableViewType('table');
      setNewTableName(t('memo.create.tableDefaultName'));
      setNewTableDialogOpen(true);
    };
    window.addEventListener('flowix:open-create-table-dialog', handleOpenCreateTableDialog);
    return () => window.removeEventListener('flowix:open-create-table-dialog', handleOpenCreateTableDialog);
  }, [t]);
  const newConversationAgentTypes = AGENT_TYPES.filter((type) => {
    if (!isAgentTypeSelectable(type.key)) return false;
    if (isAlwaysVisibleNewConversationAgent(type.key)) return true;
    return isAgentRuntimeInstalledState(normalizeAgentRuntimeStatus(
      agentRuntimeStatusByType[type.key],
      agentRuntimeIsChecking,
    ));
  });
  useEffect(() => {
    if (createTypeMenuOpen && memoListView === 'folders') void refreshAgentRuntimeIfStale();
  }, [createTypeMenuOpen, memoListView, refreshAgentRuntimeIfStale]);
  useEffect(() => {
    if (!createTypeMenuOpen) return;
    let cancelled = false;
    void noteApi.listTemplates()
      .then((templates) => {
        if (!cancelled) setCreateTemplates(orderNoteTemplates(templates).slice(0, 5));
      })
      .catch((error) => {
        if (!cancelled) logger.warn('load note templates for create menu failed', { error });
      });
    return () => {
      cancelled = true;
    };
  }, [createTypeMenuOpen]);
  useEffect(() => {
    if (selectedNotebookId) void loadNotebookFilters(selectedNotebookId);
  }, [loadNotebookFilters, selectedNotebookId]);
  const [defaultCreateFolderState, setDefaultCreateFolderState] = useState<{
    notebookId: string;
    path: string | null;
  } | null>(null);
  const defaultCreateFolder = defaultCreateFolderState !== null
    && selectedNotebook != null
    && defaultCreateFolderState.notebookId === selectedNotebook.id
    ? defaultCreateFolderState.path
    : null;
  const defaultCreateFolderReady = selectedNotebook != null
    && defaultCreateFolderState?.notebookId === selectedNotebook.id;
  const selectedTagId = useTagStore((s) => s.selectedTagId);
  const tagMetadataRefreshVersion = useTagStore((s) => s.metadataRefreshVersion);
  const runningAgentTypeIndex = useRunningAgentTypeIndex();
  const getRunningAgentTypeForMemo = useCallback(
    (memo: NoteListItem) => findRunningAgentTypeForMemo(runningAgentTypeIndex, memo),
    [runningAgentTypeIndex],
  );
  const activeTagId = activeFilter === 'tagged' ? selectedTagId : null;
  const setSelectedTagId = useTagStore((s) => s.setSelectedTagId);
  const loadLibraryMetadata = useMemoLibraryMetadataStore((s) => s.loadMetadata);
  const {
    setSelectedNotebook,
    triggerRefresh,
    setActiveFilter,
    setActiveSort,
    setColorFilter,
    loadNotes,
    loadMoreMemos,
    memoListHasMore,
    memoListLoadingMore,
  } = useNoteStore(
    useShallow((s) => ({
      setSelectedNotebook: s.setSelectedNotebook,
      triggerRefresh: s.triggerRefresh,
      setActiveFilter: s.setActiveFilter,
      setActiveSort: s.setActiveSort,
      setColorFilter: s.setColorFilter,
      loadNotes: s.loadNotes,
      loadMoreMemos: s.loadMoreMemos,
      memoListHasMore: s.memoListHasMore,
      memoListLoadingMore: s.memoListLoadingMore,
    })),
  );
  const listItems: NoteListItem[] = notes;
  useEffect(() => subscribe<{ notebookId: string; relativePath: string }>(
    'flowix:path-note-changed',
    ({ notebookId }) => {
      const state = useNoteStore.getState();
      if (state.selectedNotebook?.id === notebookId) {
        void state.loadNotes({ notebookId });
      }
    },
  ), []);
  useEffect(() => subscribe<{ notebookId: string }>('file-management-changed', ({ notebookId }) => {
    if (useNoteStore.getState().selectedNotebook?.id === notebookId) {
      useNoteStore.getState().triggerRefresh();
    }
  }), []);
  useEffect(() => subscribe<{ notebookPath: string; defaultCreateFolderChanged: boolean }>(
    'notebook-view-preferences-changed',
    ({ notebookPath, defaultCreateFolderChanged }) => {
      if (!defaultCreateFolderChanged) return;
      const selectedNotebook = useNoteStore.getState().selectedNotebook;
      if (!selectedNotebook || canonicalDirectoryPath(selectedNotebook.path) !== canonicalDirectoryPath(notebookPath)) return;
      void fileApi.getNotebookViewPreferences(selectedNotebook.path).then((preferences) => {
        if (useNoteStore.getState().selectedNotebook?.id === selectedNotebook.id) {
          setDefaultCreateFolderState({
            notebookId: selectedNotebook.id,
            path: preferences.defaultCreateFolder ?? null,
          });
        }
      }).catch((error) => {
        logger.warn('refresh notebook default create folder failed', { error, notebookId: selectedNotebook.id });
      });
    },
  ), []);
  const selectedListItemKey = selectedNote
      ? `path:${selectedNote.notebookId}:${selectedNote.relativePath}`
      : undefined;
  const [notebookDropdownOpen, setNotebookDropdownOpen] = useState(false);
  const [isCreatingMemo, setIsCreatingMemo] = useState(false);
  const [localNavigationDrawerOpen, setLocalNavigationDrawerOpen] = useState(false);
  const [colorSubmenuOpen, setColorSubmenuOpen] = useState(false);
  const [sortSubmenuOpen, setSortSubmenuOpen] = useState(false);
  const [createFolderRequest, setCreateFolderRequest] = useState<{
    id: number;
    parentPath: string;
  } | null>(null);
  const [createNoteRequest, setCreateNoteRequest] = useState<NotebookNoteCreateRequest | null>(null);
  const [tagMap, setTagMap] = useState<Record<string, string>>({});
  const [isMemoListLoading, setIsMemoListLoading] = useState(false);
  const [loadedMemoListQueryKey, setLoadedMemoListQueryKey] = useState<string | null>(null);
  const [memoListError, setMemoListError] = useState<{
    queryKey: string;
    kind: 'initial' | 'refresh' | 'more';
  } | null>(null);
  const [foldersMounted, setFoldersMounted] = useState(memoListView === 'folders');
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  useEffect(() => {
    if (memoListView === 'folders') setFoldersMounted(true);
  }, [memoListView]);

  useEffect(() => {
    if (!showFolderView) return;
    setNotebookDropdownOpen(false);
    setColorSubmenuOpen(false);
    setSortSubmenuOpen(false);
  }, [showFolderView]);

  useEffect(() => {
    setCreateFolderRequest(null);
    setCreateNoteRequest(null);
  }, [selectedNotebook?.id]);

  useEffect(() => {
    let current = true;
    setDefaultCreateFolderState(null);
    if (!selectedNotebook) return () => { current = false; };
    void fileApi.getNotebookViewPreferences(selectedNotebook.path)
      .then((preferences) => {
        if (current) {
          setDefaultCreateFolderState({
            notebookId: selectedNotebook.id,
            path: preferences.defaultCreateFolder ?? null,
          });
        }
      })
      .catch((error) => {
        logger.warn('load notebook view preferences failed', { error, notebookId: selectedNotebook.id });
        if (current) setDefaultCreateFolderState({ notebookId: selectedNotebook.id, path: null });
      });
    return () => { current = false; };
  }, [selectedNotebook?.id, selectedNotebook?.path]);

  useEffect(() => {
    if (!navigationDrawerEnabled && controlledNavigationDrawerOpen === undefined) {
      setLocalNavigationDrawerOpen(false);
    }
  }, [controlledNavigationDrawerOpen, navigationDrawerEnabled]);

  const navigationDrawerControlled =
    controlledNavigationDrawerOpen !== undefined && Boolean(onToggleNavigationDrawer);
  const navigationDrawerOpen = navigationDrawerControlled
    ? controlledNavigationDrawerOpen
    : localNavigationDrawerOpen;

  const handleRetryStartup = useCallback(() => {
    void initializeMainWindowStartup().catch((error) => {
      logger.warn('retry memo library initialization failed', { error });
      toast.error(t('memo.list.loadFailed'));
    });
  }, [t]);

  const handleMemoListLoadError = useCallback((error: unknown, requestedKind?: 'initial' | 'more') => {
    logger.warn('load memos failed', { error });
    const state = useNoteStore.getState();
    const queryKey = getMemoListQueryKey(
      state.selectedNotebook?.id,
      state.activeFilter,
      state.activeSort,
      state.activeFilter === 'tagged' ? useTagStore.getState().selectedTagId : null,
      state.colorFilter,
      state.activePluginId,
      state.activeCustomFilterId,
    );
    const kind = requestedKind
      ?? (state.memoListQueryKey === queryKey ? 'refresh' : 'initial');
    setMemoListError({ queryKey, kind });
  }, []);
  const handleMemoListLoadStart = useCallback((queryKey: string) => {
    setMemoListError((current) => current?.queryKey === queryKey ? null : current);
  }, []);
  const handleMemoListLoadSuccess = useCallback((queryKey: string) => {
    setMemoListError((current) => current?.queryKey === queryKey ? null : current);
  }, []);

  const handleLoadMoreMemos = useCallback(() => {
    const state = useNoteStore.getState();
    const queryKey = getMemoListQueryKey(
      state.selectedNotebook?.id,
      state.activeFilter,
      state.activeSort,
      state.activeFilter === 'tagged' ? useTagStore.getState().selectedTagId : null,
      state.colorFilter,
      state.activePluginId,
      state.activeCustomFilterId,
    );
    if (memoListError?.queryKey === queryKey && memoListError.kind === 'more') return;
    void loadMoreMemos().catch((error) => {
      handleMemoListLoadError(error, 'more');
    });
  }, [handleMemoListLoadError, loadMoreMemos, memoListError]);

  const handleRetryMemoList = useCallback(() => {
    setMemoListError(null);
    triggerRefresh();
  }, [triggerRefresh]);

  const handleRetryMemoListMore = useCallback(() => {
    setMemoListError(null);
    void loadMoreMemos().catch((error) => handleMemoListLoadError(error, 'more'));
  }, [handleMemoListLoadError, loadMoreMemos]);

  const loadData = useCallback(async () => {
    if (!isActiveRef.current || startupPhase !== 'ready') return;

    const currentNotebook = useNoteStore.getState().selectedNotebook;
    if (!currentNotebook) {
      if (!isActiveRef.current) return;
      setSelectedNotebook(null);
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
    if (!isActiveRef.current || useNoteStore.getState().startupPhase !== 'ready') return;
    if (!libraryMetadata) return;
    if (useNoteStore.getState().selectedNotebook?.id !== currentNotebook.id) return;

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

  }, [loadLibraryMetadata, setSelectedNotebook, setSelectedTagId, startupPhase, tagMetadataRefreshVersion]);

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
    activeCustomFilterId,
  );
  const currentMemoListError = memoListError?.queryKey === currentMemoListQueryKey
    ? memoListError
    : null;
  const hasCurrentMemoListData = loadedMemoListQueryKey === currentMemoListQueryKey
    || memoListQueryKey === currentMemoListQueryKey;
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
    if (activeFilter === 'custom' && activeCustomFilter) {
      return { headerLabel: activeCustomFilter.name, hasActiveFilter: true };
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
    memos: listItems,
    activeFilter,
    colorFilter,
    selectedItemKey: selectedListItemKey,
    queryKey: currentMemoListQueryKey,
    loading: showMemoListLoading,
    hasMorePages: memoListHasMore,
    loadingMorePages: memoListLoadingMore,
    loadMorePages: handleLoadMoreMemos,
    scrollerRef: listContainerRef,
    isActive: isActive && dataLoadingEnabled && memoListView !== 'folders',
  });
  const listRenderedMemos = renderedMemos;
  const listFilteredMemosCount = filteredMemos.length;
  const handleSetDefaultCreateFolder = useCallback(async (folderPath: string) => {
    if (!selectedNotebook) return;
    const root = canonicalDirectoryPath(selectedNotebook.path);
    const folder = canonicalDirectoryPath(folderPath);
    if (folder !== root && !folder.startsWith(`${root}/`)) return;
    const relative = folder === root ? null : folder.slice(root.length + 1);
    try {
      const preferences = await fileApi.getNotebookViewPreferences(selectedNotebook.path);
      const nextDefaultFolder = defaultCreateFolder === relative ? null : relative;
      await fileApi.setNotebookViewPreferences(selectedNotebook.path, {
        ...preferences,
        defaultCreateFolder: nextDefaultFolder,
      });
      setDefaultCreateFolderState({ notebookId: selectedNotebook.id, path: nextDefaultFolder });
      toast.success(t(defaultCreateFolder === relative
        ? 'memo.fileTree.defaultCreateFolderCleared'
        : 'memo.fileTree.defaultCreateFolderSet'));
    } catch (error) {
      logger.warn('set notebook default create folder failed', { error, folderPath });
      toast.error(t('memo.fileTree.preferenceSaveFailed'));
    }
  }, [defaultCreateFolder, selectedNotebook, t]);
  const memoVirtualizationEnabled =
    listFilteredMemosCount > MEMO_VIRTUALIZATION_THRESHOLD;
  // ResizeObserver is required for dynamic rows. Older/non-browser test
  // environments gracefully keep the existing document-flow renderer.
  const canVirtualizeMemos =
    memoVirtualizationEnabled && typeof ResizeObserver !== 'undefined';
  const getMemoKey = useCallback((memo: NoteListItem) => noteListItemKey(memo), []);
  const estimateMemoSize = useCallback(
    (memo: NoteListItem) => memo.thumbnail ? 208 : 136,
    [],
  );
  const {
    totalSize: virtualListTotalSize,
    virtualItems,
    getMeasureRef,
    isVirtualizationReady,
    onScroll: handleVirtualListScroll,
  } = useDynamicVirtualList({
    items: listRenderedMemos,
    getKey: getMemoKey,
    estimateSize: estimateMemoSize,
    scrollerRef: listContainerRef,
    enabled: canVirtualizeMemos,
    resetKey: currentMemoListQueryKey,
    keepAliveKeys: [selectedListItemKey].filter(
      (key): key is string => Boolean(key),
    ),
  });
  // A width change invalidates the prefix offsets, not just the visible row.
  // The hook temporarily renders the loaded prefix in normal flow until the
  // new geometry has been measured and the scroll anchor restored.
  const shouldVirtualizeMemos = canVirtualizeMemos && isVirtualizationReady;

  // ─── row ref 缓存 ──────────────────────────────────────────────
  // 同一路径 key 跨 render 拿到**稳定**的 ref 回调, 避免 React 在重渲时
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
  const handleSelectMemo = useCallback((memo: NoteListItem) => {
    void openPathNoteSession(memo, useNoteStore.getState().selectedNotebook);
  }, []);

  const handleOpenMemoWindow = useCallback((memo: NoteListItem) => {
    const notebook = useNoteStore.getState().selectedNotebook;
    if (!notebook?.path) return;
    const path = joinNotebookMemoPath(notebook.path, memo.relativePath) ?? memo.relativePath;
    const open = openBrowserColumnText(path, notebook.path);
    void open
      .catch((error) => {
        logger.warn('open memo in browser column failed', {
          error,
          path: memo.relativePath,
        });
        toast.error(error instanceof Error ? error.message : String(error));
      });
  }, [t]);

  const handleRequestDeleteMemo = useCallback((memo: NoteListItem) => {
    window.dispatchEvent(new CustomEvent<NoteListItem>('flowix:request-delete-memo', { detail: memo }));
  }, []);

  const handleFavoriteToggle = useCallback(async (memo: NoteListItem) => {
    const path = joinNotebookMemoPath(
      useNoteStore.getState().selectedNotebook?.path ?? '',
      noteListItemRelativePath(memo),
    ) ?? '';
    try {
      const outcome = await (memo.favorited
        ? noteRepository.unfavorite(path)
        : noteRepository.favorite(path));
      if (outcome === 'notSaved') {
        toast.error(t(memo.favorited ? 'document.command.unpinFailed' : 'document.command.pinFailed'));
        return;
      }
      if (outcome === 'missingCleaned') {
        useNoteStore.setState((state) => ({
          notes: state.notes.filter((item) =>
            item.notebookId !== memo.notebookId || item.relativePath !== memo.relativePath),
        }));
      }
      triggerRefresh();
      if (outcome === 'missingCleaned') toast.success(t('memo.favorite.missingCleaned'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [t, triggerRefresh]);

  const handleColorsChange = useCallback(async (memo: NoteListItem, colors: NoteColor[]) => {
    const path = joinNotebookMemoPath(
      useNoteStore.getState().selectedNotebook?.path ?? '',
      noteListItemRelativePath(memo),
    ) ?? '';
    await noteRepository.setColors(path, colors);
    triggerRefresh();
  }, [triggerRefresh]);

  const renderMemoRow = (memo: NoteListItem, start?: number) => {
    const itemKey = noteListItemKey(memo);
    const rowRef = getMeasuredMemoRowRef(itemKey);
    const isVirtualRow = start !== undefined;
    return (
      <div
        key={itemKey}
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
            isSelected={selectedListItemKey === itemKey}
            runningAgentType={getRunningAgentTypeForMemo(memo) ?? undefined}
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
    : listRenderedMemos.map((memo) => renderMemoRow(memo));

  const handleFilterChange = (filter: typeof activeFilter) => {
    if (filter !== 'tagged') {
      setSelectedTagId(null);
    }
    // 切到非 color filter 时, 保留 colorFilter 值, 切回时恢复 — 用户预期
    // 切到其他筛选再回来, 之前选的颜色还在。
    setActiveFilter(filter);
  };

  const handleClearFilter = useCallback(() => {
    setSelectedTagId(null);
    setColorFilter('any');
    setActiveFilter('all');
    setNotebookDropdownOpen(false);
  }, [setActiveFilter, setColorFilter, setSelectedTagId]);

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

  // 当 dropdown 关闭时, 同步把 filter / sort submenu 也收掉。
  useEffect(() => {
    if (!notebookDropdownOpen) {
      setColorSubmenuOpen(false);
      setSortSubmenuOpen(false);
    }
  }, [notebookDropdownOpen]);

  const handleCreateMemo = useCallback(async (
    parentRelativePathOverride?: string,
    titleOverride?: string,
  ) => {
    if (!selectedNotebook) return;
    setIsCreatingMemo(true);
    try {
    let customFilterForCreation = activeCustomFilter;
    if (activeFilter === 'custom' && activeCustomFilterId && !customFilterForCreation) {
      await loadNotebookFilters(selectedNotebook.id);
      customFilterForCreation = useCustomFilterStore.getState().filtersByNotebook[selectedNotebook.id]
        ?.find((filter) => filter.id === activeCustomFilterId) ?? null;
    }
    const shouldCreateIntoCustomFilter = activeFilter === 'custom'
      && customFilterForCreation?.documentType === 'note';
    const createFilter = shouldCreateIntoCustomFilter ? 'custom' : getVisibleCreateFilter(activeFilter);
    if (createFilter !== activeFilter) {
      setSelectedTagId(null);
      setActiveFilter(createFilter);
    }
    const parentRelativePath = parentRelativePathOverride ?? (memoListView === 'folders'
      ? parentRelativePathForTreeCreate(
        useDocumentStore.getState().activeExternalSession,
        selectedNotebook.id,
        selectedNotebook.path,
      ) ?? ''
      : undefined);
    const result = await noteRepository.create(
      activeTagId ?? undefined,
      selectedNotebook.id,
      parentRelativePath,
      titleOverride?.trim() || undefined,
    );
    if (shouldCreateIntoCustomFilter && customFilterForCreation) {
      const saved = await setDocumentProperties(result.path, {
        [customFilterForCreation.key]: customFilterForCreation.value,
      });
      if (!saved) throw new Error('Failed to apply the active custom view to the new note');
    }
    const shouldSelectNewMemo =
      createFilter === 'all' ||
      (createFilter === 'tagged' && Boolean(activeTagId)) ||
      createFilter === 'thisWeek' ||
      createFilter === 'thisMonth' ||
      (createFilter === 'custom' && shouldCreateIntoCustomFilter);

    // Synchronously capture pre-render positions BEFORE the store update that
    // adds the new memo. The animation itself runs in the useLayoutEffect below,
    // after React commits the new list but before the browser paints it.
    // 新 memo 永远渲染在列表最前，且初始窗口会包含它 ── 入场动画交给
    // useMemoInsertAnimation.onListRendered 在 layout 阶段跑一次。
    prepareForInsert(`path:${selectedNotebook.id}:${result.relativePath}`);
    useNoteStore.getState().upsertCreatedNote(result);
    // Opening is a workspace navigation transaction. Leave selection to the
    // facade so a failed document open can restore the previous memo.
    const opening = shouldSelectNewMemo
      ? openNotebookNote(result.path, selectedNotebook, { initialFocus: 'title' })
      : null;
    void loadNotes({ notebookId: selectedNotebook.id, filter: createFilter })
      .then((loaded) => {
        if (!loaded) return;
        const state = useNoteStore.getState();
        if (state.selectedNotebook?.id !== selectedNotebook.id
          || state.activeFilter !== createFilter
          || state.activeCustomFilterId !== activeCustomFilterId
          || (createFilter === 'tagged' && useTagStore.getState().selectedTagId !== activeTagId)) return;
        if (!state.notes.some((note) => (
          note.notebookId === result.notebookId && note.relativePath === result.relativePath
        ))) state.upsertCreatedNote(result);
      })
      .catch((error) => {
        logger.warn('refresh note list after create failed', { error, notebookId: selectedNotebook.id });
      });
    if (opening) await opening;
    } finally { setIsCreatingMemo(false); }
  }, [
    activeFilter,
    activeTagId,
    activeCustomFilter,
    activeCustomFilterId,
    loadNotebookFilters,
    loadNotes,
    prepareForInsert,
    memoListView,
    selectedNotebook,
    setActiveFilter,
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
      useDocumentStore.getState().activeExternalSession,
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

  const handleCreateTable = useCallback(async () => {
    const targetNotebook = createTableDialogNotebookId
      ? useNoteStore.getState().notebooks.find((entry) => entry.id === createTableDialogNotebookId) ?? null
      : selectedNotebook;
    if (!targetNotebook || targetNotebook.missing || isCreatingTable) return;
    const onCreated = createTableOnCreatedRef.current;
    const useSelectedNotebookFolder = targetNotebook.id === selectedNotebook?.id && defaultCreateFolderReady;
    setIsCreatingTable(true);
    try {
      const parentRelativePath = useSelectedNotebookFolder
        ? defaultCreateFolder ?? undefined
        : (await fileApi.getNotebookViewPreferences(targetNotebook.path)).defaultCreateFolder ?? undefined;
      const created = await createTableDocumentFile(targetNotebook.path, parentRelativePath, newTableName, newTableViewType);
      const view = created.table.table.views[0];
      if (!view) throw new Error('新建多维表格没有可用视图');
      await onCreated?.({ relativePath: created.relativePath, tableId: created.table.table.id, viewId: view.id });
      setNewTableDialogOpen(false);
      setCreateTypeMenuOpen(false);
      setCreateTableDialogNotebookId(null);
      createTableOnCreatedRef.current = null;
      await openExternalTarget(created.filePath, { scopePath: targetNotebook.path, notebookId: targetNotebook.id, destination: 'main-third' });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建多维表格失败');
    } finally {
      setIsCreatingTable(false);
    }
  }, [createTableDialogNotebookId, defaultCreateFolder, defaultCreateFolderReady, isCreatingTable, newTableName, newTableViewType, selectedNotebook]);

  const handleCreateMediaLibrary = useCallback(async () => {
    if (!selectedNotebook || isCreatingLibrary) return;
    setIsCreatingLibrary(true);
    try {
      const parentRelativePath = defaultCreateFolderReady
        ? defaultCreateFolder ?? undefined
        : (await fileApi.getNotebookViewPreferences(selectedNotebook.path)).defaultCreateFolder ?? undefined;
      const { filePath } = await createMediaLibraryFile(selectedNotebook.path, parentRelativePath, newLibraryName);
      setNewLibraryDialogOpen(false);
      setCreateTypeMenuOpen(false);
      await openExternalTarget(filePath, { scopePath: selectedNotebook.path, notebookId: selectedNotebook.id, destination: 'main-third' });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建媒体库失败');
    } finally {
      setIsCreatingLibrary(false);
    }
  }, [defaultCreateFolder, defaultCreateFolderReady, isCreatingLibrary, newLibraryName, selectedNotebook]);

  const handleCreateAgentConversation = useCallback((typeKey: AgentTypeKey) => {
    if (!selectedNotebookId) return;
    createAndOpenAgentConversation(typeKey, selectedNotebookId);
  }, [selectedNotebookId]);

  const handleCreateFromTemplate = useCallback(async (templateId: string) => {
    if (!selectedNotebook) return;
    try {
      const created = await noteApi.createFromTemplate(templateId, selectedNotebook.id);
      await useNoteStore.getState().loadNotes({ notebookId: selectedNotebook.id });
      setCreateTypeMenuOpen(false);
      await openNotebookNote(created.path, selectedNotebook);
    } catch (error) {
      logger.error('create note from template failed', { error, templateId, notebookId: selectedNotebook.id });
      toast.error(error instanceof Error ? error.message : t('memo.create.templateFailed'));
    }
  }, [selectedNotebook, t]);

  const handleCreateFolder = useCallback(() => {
    if (!selectedNotebook) return;
    const notebookRoot = selectedNotebook.path.replace(/\/+$/, '');
    setCreateFolderRequest({
      id: Date.now(),
      parentPath: notebookRoot,
    });
  }, [selectedNotebook]);

  // 入场动画入口: 每次主列表行变化时在 layout 阶段同步
  // 询问 useMemoInsertAnimation 是否有 pending 新 card, 有就跑一次入场
  // 动画; 无就是 no-op。 在 paint 之前跑, 避免首帧闪烁。
  useLayoutEffect(() => {
    onListRendered();
  }, [listItems, onListRendered]);

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
    : activeSort === 'filenameAsc'
      ? t('memo.list.sortFilenameAsc')
      : activeSort === 'filenameDesc'
        ? t('memo.list.sortFilenameDesc')
        : t('memo.list.sortCreated');
  const createTypeMenuContent = (
    <DropdownMenuContent align="end" className="w-[190px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
      <DropdownMenuLabel className="px-[0.375rem] pb-[0.35rem] pt-[0.35rem] text-xs font-normal leading-[1.2] text-[var(--muted-foreground)]">
        {t('memo.create.documents')}
      </DropdownMenuLabel>
      <DropdownMenuItem
        disabled={!selectedNotebook}
        onClick={() => {
          if (memoListView === 'folders') handleRequestCreateNote();
          else void handleCreateMemo();
        }}
        className="group h-7 items-center gap-2 rounded-lg px-2 py-0 hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
      >
        <SquarePen className="h-4 w-4" aria-hidden="true" />
        {t('memo.create.note')}
      </DropdownMenuItem>
      {createTemplates.map((template) => (
        <DropdownMenuItem
          key={template.id}
          disabled={!selectedNotebook}
          onClick={() => void handleCreateFromTemplate(template.id)}
          className="group h-7 items-center gap-2 rounded-lg px-2 py-0 hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
        >
          <SwatchBook className="h-4 w-4" aria-hidden="true" />
          <span className="min-w-0 truncate">{template.name}</span>
        </DropdownMenuItem>
      ))}
      <MemoNavigationSubmenu
        label={t('editor.toolbar.more')}
        icon={<MoreHorizontal className="h-4 w-4" aria-hidden="true" />}
        open={createMoreMenuOpen}
        onOpenChange={setCreateMoreMenuOpen}
        emptyText=""
        loadingText=""
        hideHeader
        onCloseMenu={() => setCreateTypeMenuOpen(false)}
        submenuClassName="w-[147px]"
        submenuContent={(
          <div className="flex flex-col gap-0.5">
            {([
              { type: 'table' as const, label: t('memo.create.table') },
              { type: 'gallery' as const, label: t('editor.slash.label.galleryView') },
              { type: 'kanban' as const, label: t('editor.slash.label.kanbanView') },
              { type: 'calendar' as const, label: t('editor.slash.label.calendarView') },
            ]).map(({ type, label }) => (
              <button
                key={type}
                type="button"
                disabled={!selectedNotebook}
                className="memo-navigation-submenu-item mention-note-item !h-7 !min-h-7 !rounded-lg !py-0 !pl-[6px] !pr-2 hover:bg-[var(--brand)] focus-visible:bg-[var(--brand)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setNewTableViewType(type);
                  setNewTableName(t('memo.create.tableDefaultName'));
                  setCreateTableDialogNotebookId(null);
                  createTableOnCreatedRef.current = null;
                  setCreateMoreMenuOpen(false);
                  setCreateTypeMenuOpen(false);
                  setNewTableDialogOpen(true);
                }}
              >
                <span className="mention-note-title">{label}</span>
              </button>
            ))}
            <button
              type="button"
              disabled={!selectedNotebook || isCreatingLibrary}
              className="memo-navigation-submenu-item mention-note-item !h-7 !min-h-7 !rounded-lg !py-0 !pl-[6px] !pr-2 hover:bg-[var(--brand)] focus-visible:bg-[var(--brand)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setNewLibraryName(t('memo.create.mediaLibraryDefaultName'));
                setCreateMoreMenuOpen(false);
                setCreateTypeMenuOpen(false);
                setNewLibraryDialogOpen(true);
              }}
            >
              <span className="mention-note-title">{t('memo.create.mediaLibrary')}</span>
            </button>
          </div>
        )}
      />
      {memoListView === 'folders' && (
        <>
          <DropdownMenuLabel className="px-[0.375rem] pb-[0.35rem] pt-[0.35rem] text-xs font-normal leading-[1.2] text-[var(--muted-foreground)]">
            {t('memo.create.conversations')}
          </DropdownMenuLabel>
          {newConversationAgentTypes.map((type) => {
            const runtimeStatus = normalizeAgentRuntimeStatus(
              agentRuntimeStatusByType[type.key],
              agentRuntimeIsChecking,
            );
            const showNotInstalled = isAlwaysVisibleNewConversationAgent(type.key)
              && runtimeStatus.state === 'not-installed';
            const name = type.nameKey
              ? t(type.nameKey as Parameters<typeof t>[0])
              : type.name;
            return (
              <DropdownMenuItem
                key={type.key}
                disabled={!selectedNotebook}
                onClick={() => handleCreateAgentConversation(type.key)}
                className="agent-conversation-new-agent-item group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
              >
                <AgentIcon typeKey={type.key} alt="" className="h-4 w-4 shrink-0 object-contain" />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {showNotInstalled && (
                  <span className="shrink-0 text-xs text-[var(--muted-foreground)] group-hover:text-[var(--primary-foreground)]">
                    {t('agent.status.notInstalled')}
                  </span>
                )}
              </DropdownMenuItem>
            );
          })}
        </>
      )}
    </DropdownMenuContent>
  );
  return (
    <div className="memo-list relative flex h-full min-w-0 select-none flex-col bg-[var(--list-bg)]">
      <MemoListDataLoader
        dataLoadingEnabled={dataLoadingEnabled && memoListView !== 'folders'}
        startupPhase={startupPhase}
        initialMemoQueryKey={initialMemoQueryKey}
        memoListQueryKey={memoListQueryKey}
        selectedNotebookId={selectedNotebookId}
        activeFilter={activeFilter}
        activeSort={activeSort}
        activeTagId={activeTagId}
        colorFilter={colorFilter}
        activePluginId={activePluginId}
        activeCustomFilterId={activeCustomFilterId}
        refreshTrigger={refreshTrigger}
        loadNotes={loadNotes}
        setLoadedMemoListQueryKey={setLoadedMemoListQueryKey}
        setIsMemoListLoading={setIsMemoListLoading}
        onLoadError={handleMemoListLoadError}
        onLoadStart={handleMemoListLoadStart}
        onLoadSuccess={handleMemoListLoadSuccess}
      />
      <div className="flex min-w-0 items-center gap-2 pb-2 pl-[100px] pr-3">
        <div className="min-w-0 flex-1">
          {!showFolderView && (
          <MemoNavigationDropdown
            title={headerLabel}
            titleTooltip={hasActiveFilter ? headerLabel : undefined}
            ariaLabel={t('memo.navigation.menuTitle')}
            open={notebookDropdownOpen}
            onOpenChange={setNotebookDropdownOpen}
            showClear={hasActiveFilter}
            onClear={handleClearFilter}
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
                              : NOTE_COLOR_HEX[colorFilter],
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
                  <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
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
                  <button
                    type="button"
                    onClick={() => handleSortFromSubmenu('filenameAsc')}
                    onMouseDown={(event) => event.preventDefault()}
                    className={cn(
                      'memo-navigation-submenu-item mention-note-item cursor-pointer hover:bg-[var(--brand)] focus-visible:bg-[var(--brand)] focus-visible:outline-none',
                      activeSort === 'filenameAsc' && 'is-selected',
                    )}
                  >
                    <span className="mention-note-title">{t('memo.list.sortFilenameAsc')}</span>
                    {activeSort === 'filenameAsc' && <Check className="w-4 h-4 text-[var(--brand)]" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSortFromSubmenu('filenameDesc')}
                    onMouseDown={(event) => event.preventDefault()}
                    className={cn(
                      'memo-navigation-submenu-item mention-note-item cursor-pointer hover:bg-[var(--brand)] focus-visible:bg-[var(--brand)] focus-visible:outline-none',
                      activeSort === 'filenameDesc' && 'is-selected',
                    )}
                  >
                    <span className="mention-note-title">{t('memo.list.sortFilenameDesc')}</span>
                    {activeSort === 'filenameDesc' && <Check className="w-4 h-4 text-[var(--brand)]" />}
                  </button>
                </div>
              )}
              onOpenChange={setSortSubmenuOpen}
              onCloseMenu={() => setNotebookDropdownOpen(false)}
            />

          </div>
          </MemoNavigationDropdown>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {memoListView === 'folders' ? (
            <div className="flex h-[30px] items-center overflow-hidden rounded-xl bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90">
              <Tooltip content={t('memo.create.note')} shortcut="memo.create">
                <Button
                  size="icon"
                  disabled={!selectedNotebook || isCreatingMemo || isCreatingTable}
                  aria-busy={isCreatingMemo || isCreatingTable}
                  aria-label={t('memo.create.note')}
                  onClick={handleRequestCreateNote}
                  className="h-[30px] w-[25px] justify-start rounded-none border-0 bg-transparent pl-[7px] pr-[2px] text-[var(--primary-foreground)] hover:bg-white/10"
                >
                  {isCreatingMemo || isCreatingTable
                    ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    : <SquarePen className="h-4 w-4" aria-hidden="true" />}
                </Button>
              </Tooltip>
              <DropdownMenu open={createTypeMenuOpen} onOpenChange={setCreateTypeMenuOpen}>
                <Tooltip content={t('memo.create.chooseType')}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon"
                      disabled={isCreatingMemo || isCreatingTable}
                      aria-label={t('memo.create.chooseType')}
                      aria-haspopup="menu"
                      className="h-[30px] w-[16px] justify-end rounded-none border-0 bg-transparent pr-[4px] text-[var(--primary-foreground)] hover:bg-white/10"
                    >
                      <ChevronDown className="size-[12px]" aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                </Tooltip>
                {createTypeMenuContent}
              </DropdownMenu>
            </div>
          ) : (
            <DropdownMenu open={createTypeMenuOpen} onOpenChange={setCreateTypeMenuOpen}>
              <Tooltip content={t('memo.create.chooseType')} shortcut="memo.create">
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    disabled={isCreatingMemo || isCreatingTable}
                    aria-busy={isCreatingMemo || isCreatingTable}
                    aria-label={t('memo.create.chooseType')}
                    className="h-[30px] w-[30px] justify-center rounded-xl border border-transparent bg-[var(--primary)] p-0 text-[var(--primary-foreground)] hover:opacity-90"
                  >
                    {isCreatingMemo || isCreatingTable
                      ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      : <SquarePen className="h-4 w-4" aria-hidden="true" />}
                  </Button>
                </DropdownMenuTrigger>
              </Tooltip>
              {createTypeMenuContent}
            </DropdownMenu>
          )}
        </div>
      </div>

      <Dialog open={newTableDialogOpen} onOpenChange={(open) => {
        setNewTableDialogOpen(open);
        if (!open) {
          setCreateTableDialogNotebookId(null);
          createTableOnCreatedRef.current = null;
        }
      }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">{newTableViewType === 'table' ? t('memo.create.tableDialogTitle') : `${t('memo.create.tableDialogTitle')} · ${newTableViewType === 'gallery' ? t('editor.slash.label.galleryView') : newTableViewType === 'kanban' ? t('editor.slash.label.kanbanView') : t('editor.slash.label.calendarView')}`}</DialogTitle>
            <DialogDescription>{t('memo.create.tableDescription')}</DialogDescription>
          </DialogHeader>
          <form className="mt-2 space-y-4" onSubmit={(event) => { event.preventDefault(); void handleCreateTable(); }}>
            <input
              autoFocus
              value={newTableName}
              onChange={(event) => setNewTableName(event.target.value)}
              placeholder={t('memo.create.tableDefaultName')}
              className="h-8 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--brand)]"
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" className="h-8 rounded-lg text-sm" onClick={() => {
                setNewTableDialogOpen(false);
                setCreateTableDialogNotebookId(null);
                createTableOnCreatedRef.current = null;
              }}>{t('dialog.cancel')}</Button>
              <Button type="submit" size="sm" className="h-8 rounded-lg text-sm" disabled={!newTableName.trim() || isCreatingTable}>
                {isCreatingTable ? t('memo.create.creating') : t('memo.create.confirm')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={newLibraryDialogOpen} onOpenChange={setNewLibraryDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('memo.create.mediaLibraryTitle')}</DialogTitle>
            <DialogDescription>{t('memo.create.mediaLibraryDescription')}</DialogDescription>
          </DialogHeader>
          <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void handleCreateMediaLibrary(); }}>
            <input autoFocus value={newLibraryName} onChange={(event) => setNewLibraryName(event.target.value)} placeholder={t('memo.create.mediaLibraryDefaultName')} className="h-9 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--brand)]" />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={() => setNewLibraryDialogOpen(false)}>{t('dialog.cancel')}</Button>
              <Button type="submit" size="sm" className="rounded-lg" disabled={!newLibraryName.trim() || isCreatingLibrary}>{isCreatingLibrary ? t('memo.create.creating') : t('memo.create.confirm')}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <ListSurfaceViewport className="flex">
        {navigationDrawerEnabled && !navigationDrawerControlled && (
          <MemoListNavigationDrawer
            open={navigationDrawerOpen}
            selectedNotebook={selectedNotebook}
            onClose={() => setLocalNavigationDrawerOpen(false)}
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
              <Button size="sm" className="rounded-lg" onClick={handleRetryStartup}>
                {t('error.retry')}
              </Button>
            </div>
      </div>
    )}
        {(startupPhase === 'idle' || startupPhase === 'loading') && (
          <ListSurfaceLoadingState
            label={t('memo.list.loadingNotebook')}
            className="absolute inset-0 z-20 bg-[var(--card)]/80"
          />
        )}
        {foldersMounted && selectedNotebook && (
          <div
            className={cn('absolute inset-0', showFolderView && defaultCreateFolderReady ? '' : 'hidden')}
            aria-hidden={!showFolderView || !defaultCreateFolderReady}
          >
            <NotebookFolderView
              key={selectedNotebook.id}
              notebook={selectedNotebook}
              createFolderRequest={createFolderRequest}
              createNoteRequest={createNoteRequest}
              onCreateFolder={handleCreateFolder}
              defaultCreateFolder={defaultCreateFolder}
              onSetDefaultCreateFolder={(folderPath) => { void handleSetDefaultCreateFolder(folderPath); }}
              isActive={isActive && dataLoadingEnabled && showFolderView}
              onCreateNote={handleCreateNoteInFolder}
            />
          </div>
        )}
        {foldersMounted && selectedNotebook && showFolderView && !defaultCreateFolderReady && (
          <ListSurfaceLoadingState
            label={t('memo.list.loadingNotebook')}
            className="absolute inset-0 z-10 bg-[var(--card)]/80"
          />
        )}
        <div
          className={cn('absolute inset-0', showFolderView ? 'hidden' : '')}
          aria-hidden={showFolderView}
        >
          <OverlayScrollbar
            className="flex h-full min-h-0 min-w-0 w-full"
            scrollerClassName="min-w-0 w-full flex-1 overflow-y-auto px-1 py-2"
            scrollerRef={listContainerRef}
            onScroll={(event) => {
              setShowScrollTopHint(event.currentTarget.scrollTop > 0);
              handleMemoListScroll(event);
              handleVirtualListScroll(event);
            }}
          >
            {currentMemoListError?.kind === 'initial' ? (
              <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-3 px-4 text-center" role="alert">
                <span className="text-sm text-[var(--muted-foreground)]">{t('memo.list.loadFailed')}</span>
                <Button size="sm" className="rounded-lg" onClick={handleRetryMemoList}>{t('error.retry')}</Button>
              </div>
            ) : !hasCurrentMemoListData && showMemoListLoading ? (
              <ListSurfaceLoadingState label={t('memo.list.loadingLibrary')} />
            ) : listRenderedMemos.length > 0 ? (
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
            {currentMemoListError?.kind === 'more' && (
              <div className="flex items-center justify-center gap-2 px-4 py-3 text-center text-xs text-[var(--muted-foreground)]" role="alert">
                <span>{t('memo.list.loadFailed')}</span>
                <Button size="sm" className="rounded-lg" onClick={handleRetryMemoListMore}>{t('error.retry')}</Button>
              </div>
            )}
            {currentMemoListError?.kind === 'refresh' && (
              <div className="flex items-center justify-center gap-2 px-4 py-3 text-center text-xs text-[var(--muted-foreground)]" role="alert">
                <span>{t('memo.list.loadFailed')}</span>
                <Button size="sm" className="rounded-lg" onClick={handleRetryMemoList}>{t('error.retry')}</Button>
              </div>
            )}
          </OverlayScrollbar>
        </div>

        {memoListView !== 'folders' && <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 z-[3] h-6 bg-gradient-to-b from-[var(--list-bg)] to-transparent transition-opacity duration-200',
            showScrollTopHint ? 'opacity-100' : 'opacity-0',
          )}
        />}

      </ListSurfaceViewport>
    </div>
  );
}
