'use client';

import { NotebookDocumentCreateDialog, type NotebookDocumentCreateRequest } from './notebook-document-create-dialog';

import { flushSync } from 'react-dom';
import { useColumnNavigation, columnTarget } from '@features/workspace/public/column-navigation-api';
import { useActiveFilePath } from '@features/workspace/public/active-file-path-api';
import { middleColumnSelectionKey } from './memo-list-selection';
import {
  joinNotebookMemoPath,
  notebookRelativeDirectoryPath,
  parentDirectoryPath,
  samePath,
} from '@/lib/path';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  useNoteStore,
} from '@features/memo/store/note-store';
import { useCustomFilterStore } from '@features/memo/store/custom-filter-store';
import { useTagStore } from '@features/memo/store/tag-store';
import {
  noteListItemKey,
  type NoteListItem,
} from '@/types/note-item';
import { useMemoInsertAnimation } from '@features/memo/hooks/use-memo-insert-animation';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Button } from '@shared/ui/button';
import { FileTreeLoadingSkeleton } from '@shared/ui/file-tree-loading-skeleton';
import { ListSurfaceLoadingState, ListSurfaceViewport } from '@shared/ui/list-surface';
import { DROPDOWN_DIVIDER_SKIN } from '@shared/ui/dropdown-divider';
import { MemoCard } from '@features/memo/components/memo-card';
import { openPathNoteSession } from '@features/memo/use-cases/open-memo-session';
import { openNotebookNote } from '@features/memo/use-cases/open-notebook-note';
import { MemoListDataLoader } from '@features/memo/components/memo-list-data-loader';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { useI18n } from '@/lib/i18n';
import {
  useMemoListViewPreference,
} from '@features/preferences/public/runtime-api';
import { createLogger } from '@/lib/logger';
import { orderNoteTemplates } from '@/lib/note-template-order';
import { files as fileApi, notes as noteApi, type NoteTemplate } from '@platform/tauri/client';
import type { AgentTypeKey } from '@/types/agent';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
import { useNewConversationAgentSelection } from '@features/agent/hooks/use-new-conversation-agent-selection';
import {
  createAndOpenAgentConversation,
} from '@features/agent/public/new-conversation-api';
import type { TableViewType } from '@features/multidimensional-table/public/create-api';

import { COLOR_LABEL_KEYS } from './memo-list/color-filter-submenu';
import { NotebookFolderView } from './notebook-folder-view';
import { useMemoListPagination } from './memo-list/use-memo-list-pagination';
import { useMemoListLoadController } from './memo-list/use-memo-list-load-controller';
import { useMemoListCreationActions } from './memo-list/use-memo-list-creation-actions';
import type { MemoRowKeepAliveChange } from './memo-list/memo-list-rows';
import { MemoListHeader } from './memo-list/memo-list-header';
import { MemoListViewport } from './memo-list/memo-list-viewport';
import { useNotebookDefaultCreateFolder } from './memo-list/use-notebook-default-create-folder';
import { useMemoListNotebookMetadata } from './memo-list/use-memo-list-notebook-metadata';
import { useMemoListItemActions } from './memo-list/use-memo-list-item-actions';
import {
  findRunningAgentTypeForMemo,
  useRunningAgentTypeIndex,
} from '@features/agent/public/running-agents-api';
const logger = createLogger('memo-list');

interface MemoListProps {
  /** Keep the memo list mounted while the middle column shows conversations. */
  isActive?: boolean;
  dataLoadingEnabled?: boolean;
}

interface OpenCreateTableDialogRequest {
  notebookId: string;
  onCreated?: (selection: { relativePath: string; collectionId: string; viewId: string }) => void | Promise<void>;
}

interface OpenNotebookDocumentCreateDialogRequest {
  notebookId: string;
  kind: NotebookDocumentCreateRequest['kind'];
  viewType?: TableViewType;
}

export function MemoList({
  isActive = true,
  dataLoadingEnabled = true,
}: MemoListProps) {
  const { t } = useI18n();
  const [showScrollTopHint, setShowScrollTopHint] = useState(false);
  const { registerCard, prepareForInsert, onListRendered } =
    useMemoInsertAnimation();
  // Paging and the virtual rows share the OverlayScrollbar's native scroller.
  const listContainerRef = useRef<HTMLDivElement>(null);
  const scrollListToTop = useCallback(() => {
    listContainerRef.current?.scrollTo({ top: 0 });
  }, []);
  const [listScrollElement, setListScrollElement] = useState<HTMLDivElement | null>(null);
  const attachListScroller = useCallback((element: HTMLDivElement | null) => {
    listContainerRef.current = element;
    setListScrollElement(element);
  }, []);
  // 切片订阅: 替代原来的 `useNoteStore()` 全量订阅。每个 useStore 只取用到的字段,
  // 切到 selector 后, 列表里 5k 笔记的任何 set 都不会让本组件不必要地重渲 ──
  // memos 是大头, 但要 memoize (Array equality) 才能跳过 5k 项深比; 不然
  // store 里 setNotebooks 之类也会触发 memos selector 重跑。Zustand v5 默认
  // 用 Object.is 比对, 同一个 memos 引用相等就跳过, 不需要 useMemo。
  const notes = useNoteStore((s) => s.notes);
  const notebooks = useNoteStore((s) => s.notebooks);
  const memoListView = useMemoListViewPreference();
  const selectedNotebook = useNoteStore((s) => s.selectedNotebook);
  const showFolderView = memoListView === 'folders' && Boolean(selectedNotebook);
  const NotebookLoadingState = memoListView === 'folders' ? FileTreeLoadingSkeleton : ListSurfaceLoadingState;
  const [createTypeMenuOpen, setCreateTypeMenuOpen] = useState(false);
  const [createViewsExpanded, setCreateViewsExpanded] = useState(false);
  const [documentCreateRequest, setDocumentCreateRequest] = useState<NotebookDocumentCreateRequest | null>(null);
  const [createTemplates, setCreateTemplates] = useState<NoteTemplate[]>([]);
  // A stale Zustand snapshot can survive a Vite HMR update with this field
  // missing even though the current store initializer provides an empty map.
  const refreshAgentRuntimeIfStale = useAgentRuntimeStore((s) => s.refreshIfStale);
  const refreshTrigger = useNoteStore((s) => s.refreshTrigger);
  const activeFilter = useNoteStore((s) => s.activeFilter);
  const activePluginId = useNoteStore((s) => s.activePluginId);
  const activeCustomFilterId = useNoteStore((s) => s.activeCustomFilterId);
  const dataCondition = useNoteStore(s => s.dataConditionsByNotebook?.[selectedNotebook?.id ?? ''] ?? null);
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
  const memoListRefreshTrigger = useNoteStore((s) => s.memoListRefreshTrigger);
  const selectedNotebookId = selectedNotebook?.id;
  const handleCreateTypeMenuOpenChange = useCallback((open: boolean) => {
    setCreateTypeMenuOpen(open);
    if (!open) setCreateViewsExpanded(false);
  }, []);
  useEffect(() => {
    const handleOpenCreateTableDialog = (event: Event) => {
      const requestEvent = event as CustomEvent<OpenCreateTableDialogRequest>;
      const notebook = useNoteStore.getState().notebooks.find((entry) => entry.id === requestEvent.detail?.notebookId);
      if (!notebook || notebook.missing) return;
      requestEvent.preventDefault();
      setDocumentCreateRequest({
        kind: 'table', notebook,
        parentFolder: async () => {
          // Follow the currently browsed Work folder; fall back to the
          // notebook's default note folder, then the root.
          const target = columnTarget(0);
          if (target.kind === 'folder-collection' && (!target.notebookId || target.notebookId === notebook.id)) {
            return notebookRelativeDirectoryPath(notebook.path, target.folderPath);
          }
          if ((target.kind === 'collection' || target.kind === 'table' || target.kind === 'media-library')
            && (!target.notebookId || target.notebookId === notebook.id)) {
            const parentPath = parentDirectoryPath(target.filePath, notebook.path);
            return notebookRelativeDirectoryPath(notebook.path, parentPath);
          }
          return (await fileApi.getNotebookViewPreferences(notebook.path)).defaultCreateFolder;
        },
        onTableCreated: requestEvent.detail.onCreated,
      });
    };
    window.addEventListener('flowix:open-create-table-dialog', handleOpenCreateTableDialog);
    return () => window.removeEventListener('flowix:open-create-table-dialog', handleOpenCreateTableDialog);
  }, []);
  const newConversationSelection = useNewConversationAgentSelection();
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
  const selectedTagId = useTagStore((s) => s.selectedTagId);
  const {
    defaultCreateFolder,
    defaultCreateFolderReady,
    handleSetDefaultCreateFolder,
    handleSaveDefaultCreateFolder,
  } = useNotebookDefaultCreateFolder(selectedNotebook);
  const runningAgentTypeIndex = useRunningAgentTypeIndex();
  const getRunningAgentTypeForMemo = useCallback(
    (memo: NoteListItem) => findRunningAgentTypeForMemo(runningAgentTypeIndex, memo),
    [runningAgentTypeIndex],
  );
  const activeTagId = activeFilter === 'tagged' ? selectedTagId : null;
  const setSelectedTagId = useTagStore((s) => s.setSelectedTagId);
  const {
    triggerMemoListRefresh,
    setActiveFilter,
    setActiveSort,
    setColorFilter,
    loadNotes,
    loadMoreMemos,
    memoListHasMore,
    memoListLoadingMore,
  } = useNoteStore(
    useShallow((s) => ({
      triggerMemoListRefresh: s.triggerMemoListRefresh,
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
  const {
    currentMemoListQueryKey,
    currentMemoListError,
    hasCurrentMemoListData,
    indexFailed,
    setIsMemoListLoading,
    setLoadedMemoListQueryKey,
    showMemoListLoading,
    skipInitialNotebookLoading,
    skipMemoListLoading,
    handleRetryStartup,
    handleMemoListLoadError,
    handleMemoListLoadStart,
    handleMemoListLoadSuccess,
    handleLoadMoreMemos,
    handleRetryMemoListMore,
    retryIndexOrList,
  } = useMemoListLoadController({
    selectedNotebookId,
    startupPhase,
    activeFilter,
    activeSort,
    activeTagId,
    colorFilter,
    activePluginId,
    activeCustomFilterId,
    dataCondition,
    memoListQueryKey,
    loadMoreMemos,
    triggerMemoListRefresh,
  });
  const tagMap = useMemoListNotebookMetadata({
    isActive,
    startupPhase,
    refreshTrigger,
    selectedNotebookId,
    setIsMemoListLoading,
    setLoadedMemoListQueryKey,
  });
  const pendingDocumentPath = useColumnNavigation(0, (navigation) => {
    const { phase, pendingTarget } = navigation.transaction;
    return phase === 'loading' && pendingTarget?.kind === 'external' ? pendingTarget.path : null;
  });
  const workTargetParentPath = useColumnNavigation(0, (navigation) => {
    if (!selectedNotebook) return null;
    // The committed Work target is the implicit destination for tree creation.
    // Fall back to the notebook preference when Work has no in-notebook target.
    const target = navigation.current?.target ?? { kind: 'empty' };
    let parentPath: string | null = null;

    if (target.kind === 'folder-collection' && target.notebookId === selectedNotebook.id) {
      parentPath = target.folderPath;
    } else if (
      (target.kind === 'collection' || target.kind === 'table' || target.kind === 'media-library')
      && (!target.notebookId || target.notebookId === selectedNotebook.id)
    ) {
      parentPath = parentDirectoryPath(target.filePath, selectedNotebook.path);
    } else if (target.kind === 'external') {
      parentPath = parentDirectoryPath(target.path, selectedNotebook.path);
    } else if (target.kind === 'media') {
      parentPath = parentDirectoryPath(target.filePath, selectedNotebook.path);
    }

    if (parentPath === null) return null;
    return notebookRelativeDirectoryPath(selectedNotebook.path, parentPath) === null
      ? null
      : parentPath;
  });
  const {
    isCreatingMemo,
    createdCardRevealKey,
    handleCreatedCardRevealed,
    handleCreateMemo,
    handleCreateNoteInFolder,
  } = useMemoListCreationActions({
    notebook: selectedNotebook,
    activeFilter,
    activeTagId,
    activeCustomFilterId,
    activeCustomFilter,
    folderMode: memoListView === 'folders',
    workTargetParentPath,
    loadNotebookFilters,
    setActiveFilter,
    setSelectedTagId,
    prepareForInsert,
  });
  const pendingListItem = pendingDocumentPath && selectedNotebook?.path
    ? notes.find((note) => samePath(
        joinNotebookMemoPath(selectedNotebook.path, note.relativePath) ?? '',
        pendingDocumentPath,
      ))
    : undefined;
  // 选中态只认中间列：两列交换内容后焦点可能停在右侧会话，跟随 selectedNote
  // 或焦点都会高亮到用户没在看的那一份。
  const middleColumnFilePath = useActiveFilePath();
  const middleColumnListItemKey = middleColumnSelectionKey({
    middleColumnFilePath,
    notebook: selectedNotebook,
    notes,
  });
  const selectedListItemKey = pendingDocumentPath
    ? pendingListItem ? noteListItemKey(pendingListItem) : undefined
    : middleColumnListItemKey;
  const [notebookDropdownOpen, setNotebookDropdownOpen] = useState(false);
  const [sortSubmenuOpen, setSortSubmenuOpen] = useState(false);
  const [createFolderRequest, setCreateFolderRequest] = useState<{
    id: number;
    parentPath: string;
  } | null>(null);
  const [foldersMounted, setFoldersMounted] = useState(memoListView === 'folders');

  useEffect(() => {
    if (memoListView === 'folders') setFoldersMounted(true);
  }, [memoListView]);

  useEffect(() => {
    if (!showFolderView) return;
    setNotebookDropdownOpen(false);
    setSortSubmenuOpen(false);
  }, [showFolderView]);

  useEffect(() => {
    setCreateFolderRequest(null);
    handleCreatedCardRevealed();
  }, [handleCreatedCardRevealed, selectedNotebook?.id]);

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
      // 下拉按钮本身保留；笔记 tab（偏好 'detailed'）无筛选时标题展示「笔记」，
      // 文件夹视图（无选中笔记本的兜底场景）仍展示「全部」。
      : {
        headerLabel: memoListView === 'detailed'
          ? t('memo.list.viewCardsShort')
          : t('memo.list.headerAll'),
        hasActiveFilter: false,
      };
  })();

  const { onScroll: handleMemoListScroll } = useMemoListPagination({
    itemCount: listItems.length,
    loading: showMemoListLoading,
    hasMorePages: memoListHasMore,
    loadingMorePages: memoListLoadingMore,
    loadMorePages: handleLoadMoreMemos,
    scrollerRef: listContainerRef,
    isActive: isActive && dataLoadingEnabled && memoListView !== 'folders',
  });
  const handleSelectMemo = useCallback((memo: NoteListItem) => {
    flushSync(() => {
      void openPathNoteSession(memo, useNoteStore.getState().selectedNotebook);
    });
  }, []);

  const handleOpenMemoWindow = useCallback((memo: NoteListItem) => {
    const notebook = useNoteStore.getState().selectedNotebook;
    if (!notebook?.path) return;
    const path = joinNotebookMemoPath(notebook.path, memo.relativePath) ?? memo.relativePath;
    const open = openWorkspaceSurface({
      index: 1,
      target: { kind: 'external', path, scopePath: notebook.path, transitionId: null },
    });
    void open
      .catch((error) => {
        logger.warn('open memo in browser column failed', {
          error,
          path: memo.relativePath,
        });
        toast.error(error instanceof Error ? error.message : String(error));
      });
  }, []);

  const handleRequestDeleteMemo = useCallback((memo: NoteListItem) => {
    window.dispatchEvent(new CustomEvent<NoteListItem>('flowix:request-delete-memo', { detail: memo }));
  }, []);
  const { handleFavoriteToggleAction, handleColorsChangeAction } = useMemoListItemActions({
    triggerMemoListRefresh,
    scrollListToTop,
  });

  const cardRefCacheRef = useRef(new Map<string, (element: HTMLDivElement | null) => void>());
  const registerCardRef = useRef(registerCard);
  registerCardRef.current = registerCard;
  const getMemoCardRef = (key: string) => {
    const cached = cardRefCacheRef.current.get(key);
    if (cached) return cached;
    const ref = (element: HTMLDivElement | null) => {
      registerCardRef.current(key)(element);
      if (!element) cardRefCacheRef.current.delete(key);
    };
    cardRefCacheRef.current.set(key, ref);
    return ref;
  };

  const renderMemoRow = (memo: NoteListItem, onKeepAliveChange: MemoRowKeepAliveChange) => {
    const itemKey = noteListItemKey(memo);
    return (
      <div
        key={itemKey}
        ref={getMemoCardRef(itemKey)}
        className="min-w-0 w-full"
      >
        <div data-insert-anim className="min-w-0 w-full">
          <MemoCard
            memo={memo}
            tagMap={tagMap}
            isSelected={selectedListItemKey === itemKey}
            runningAgentType={getRunningAgentTypeForMemo(memo) ?? undefined}
            onSelect={handleSelectMemo}
            onOpenInWindow={handleOpenMemoWindow}
            onFavoriteToggle={handleFavoriteToggleAction}
            onDelete={handleRequestDeleteMemo}
            onColorsChange={handleColorsChangeAction}
            onKeepAliveChange={onKeepAliveChange}
          />
          <hr className={cn('mx-3', DROPDOWN_DIVIDER_SKIN)} />
        </div>
      </div>
    );
  };

  const handleFilterChange = useCallback((filter: typeof activeFilter) => {
    if (filter !== 'tagged') {
      setSelectedTagId(null);
    }
    // 切到非 color filter 时, 保留 colorFilter 值, 切回时恢复 — 用户预期
    // 切到其他筛选再回来, 之前选的颜色还在。
    setActiveFilter(filter);
  }, [setActiveFilter, setSelectedTagId]);

  const handleClearFilter = useCallback(() => {
    setSelectedTagId(null);
    setColorFilter('any');
    setActiveFilter('all');
    const state = useNoteStore.getState();
    if (state.selectedNotebook) state.setDataCondition(state.selectedNotebook.id, {});
    setNotebookDropdownOpen(false);
  }, [setActiveFilter, setColorFilter, setSelectedTagId]);

  // 排序二级弹窗顶部的时间范围选中回调: 同步 activeFilter + 关闭菜单。
  const handlePeriodFilterSelect = useCallback(
    (filter: typeof activeFilter) => {
      handleFilterChange(filter);
      setSortSubmenuOpen(false);
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

  // 当 dropdown 关闭时, 同步把 sort submenu 收掉。
  useEffect(() => {
    if (!notebookDropdownOpen) {
      setSortSubmenuOpen(false);
    }
  }, [notebookDropdownOpen]);

  const openDocumentCreateDialog = useCallback((kind: NotebookDocumentCreateRequest['kind'], viewType?: TableViewType) => {
    if (!selectedNotebook || selectedNotebook.missing) return;
    const notebook = selectedNotebook;
    handleCreateTypeMenuOpenChange(false);
    setDocumentCreateRequest({
      kind, notebook, viewType,
      parentFolder: async () => {
        if (workTargetParentPath !== null) {
          const relative = notebookRelativeDirectoryPath(notebook.path, workTargetParentPath);
          if (relative !== null) return relative;
        }
        return defaultCreateFolderReady
          ? defaultCreateFolder
          : (await fileApi.getNotebookViewPreferences(notebook.path)).defaultCreateFolder;
      },
    });
  }, [defaultCreateFolder, defaultCreateFolderReady, handleCreateTypeMenuOpenChange, selectedNotebook, workTargetParentPath]);
  useEffect(() => {
    const handleOpenNotebookDocumentCreateDialog = (event: Event) => {
      const request = (event as CustomEvent<OpenNotebookDocumentCreateDialogRequest>).detail;
      if (!request) return;
      const notebook = useNoteStore.getState().notebooks.find((entry) => entry.id === request.notebookId);
      if (!notebook || notebook.missing) return;
      event.preventDefault();
      openDocumentCreateDialog(request.kind, request.viewType);
    };
    window.addEventListener('flowix:open-create-notebook-document-dialog', handleOpenNotebookDocumentCreateDialog);
    return () => window.removeEventListener('flowix:open-create-notebook-document-dialog', handleOpenNotebookDocumentCreateDialog);
  }, [openDocumentCreateDialog]);

  const handleCreateAgentConversation = useCallback((typeKey: AgentTypeKey) => {
    if (!selectedNotebookId) return;
    createAndOpenAgentConversation(typeKey, selectedNotebookId);
  }, [selectedNotebookId]);

  const handleCreateFromTemplate = useCallback(async (templateId: string) => {
    if (!selectedNotebook) return;
    try {
      const created = await noteApi.createFromTemplate(templateId, selectedNotebook.id);
      useNoteStore.getState().upsertCreatedNote(created);
      handleCreateTypeMenuOpenChange(false);
      await openNotebookNote(created.path, selectedNotebook);
    } catch (error) {
      logger.error('create note from template failed', { error, templateId, notebookId: selectedNotebook.id });
      toast.error(error instanceof Error ? error.message : t('memo.create.templateFailed'));
    }
  }, [handleCreateTypeMenuOpenChange, selectedNotebook, t]);

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
    onListRendered(listContainerRef.current);
  }, [listItems, onListRendered]);

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
        dataCondition={dataCondition}
        memoListRefreshTrigger={memoListRefreshTrigger}
        loadNotes={loadNotes}
        setLoadedMemoListQueryKey={setLoadedMemoListQueryKey}
        setIsMemoListLoading={setIsMemoListLoading}
        onLoadError={handleMemoListLoadError}
        onLoadStart={handleMemoListLoadStart}
        onLoadSuccess={handleMemoListLoadSuccess}
      />
      <MemoListHeader
        state={{
          folderMode: memoListView === 'folders',
          folderViewVisible: showFolderView,
          title: headerLabel,
          hasActiveFilter,
          hasDataCondition: Boolean(dataCondition),
          activeFilter,
          activeSort,
          notebookPath: selectedNotebook?.path,
          hasNotebook: Boolean(selectedNotebook),
          notebookMissing: Boolean(selectedNotebook?.missing),
          defaultCreateFolder,
          notebookDropdownOpen,
          sortSubmenuOpen,
          createTypeMenuOpen,
          isCreatingMemo,
          createTemplates,
          conversationOptions: newConversationSelection.options,
          createViewsExpanded,
        }}
        actions={{
          onNotebookDropdownOpenChange: setNotebookDropdownOpen,
          onSortSubmenuOpenChange: setSortSubmenuOpen,
          onCreateTypeMenuOpenChange: handleCreateTypeMenuOpenChange,
          onClearFilter: handleClearFilter,
          onSaveDefaultCreateFolder: handleSaveDefaultCreateFolder,
          onSelectPeriod: handlePeriodFilterSelect,
          onSelectSort: handleSortFromSubmenu,
          onToggleCreateViewsExpanded: () => setCreateViewsExpanded((expanded) => !expanded),
          onCreateMemo: () => { void handleCreateMemo(); },
          onCreateFromTemplate: handleCreateFromTemplate,
          onCreateAgentConversation: handleCreateAgentConversation,
          onOpenDocumentCreate: openDocumentCreateDialog,
        }}
      />

      {documentCreateRequest && <NotebookDocumentCreateDialog request={documentCreateRequest} onClose={() => setDocumentCreateRequest(null)} />}

      <ListSurfaceViewport className="flex">
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
          <NotebookLoadingState
            ariaLabel={t('memo.list.loadingNotebook')}
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
              skipInitialLoading={skipInitialNotebookLoading}
              createFolderRequest={createFolderRequest}
              onCreateFolder={handleCreateFolder}
              defaultCreateFolder={defaultCreateFolder}
              onSetDefaultCreateFolder={(folderPath) => { void handleSetDefaultCreateFolder(folderPath); }}
              isActive={isActive && dataLoadingEnabled && showFolderView && defaultCreateFolderReady}
              onCreateNote={handleCreateNoteInFolder}
            />
          </div>
        )}
        {foldersMounted && selectedNotebook && showFolderView && !defaultCreateFolderReady && !skipInitialNotebookLoading && (
          <NotebookLoadingState
            ariaLabel={t('memo.list.loadingNotebook')}
            className="absolute inset-0 z-10 bg-[var(--card)]/80"
          />
        )}
        <div
          className={cn('absolute inset-0', showFolderView ? 'hidden' : '')}
          aria-hidden={showFolderView}
        >
          <MemoListViewport
            active={isActive && !showFolderView}
            items={listItems}
            notebooksExist={notebooks.length > 0}
            scrollElement={listScrollElement}
            scrollerRef={attachListScroller}
            onScroll={(event) => {
              setShowScrollTopHint(event.currentTarget.scrollTop > 0);
              handleMemoListScroll(event);
            }}
            showScrollTopHint={memoListView !== 'folders' && showScrollTopHint}
            queryKey={currentMemoListQueryKey}
            error={currentMemoListError}
            hasData={hasCurrentMemoListData}
            indexFailed={indexFailed}
            loading={showMemoListLoading}
            skipInitialLoading={skipMemoListLoading}
            loadingMore={memoListLoadingMore}
            revealKey={createdCardRevealKey}
            onRevealed={handleCreatedCardRevealed}
            renderRow={renderMemoRow}
            onRetry={retryIndexOrList}
            onRetryMore={handleRetryMemoListMore}
          />
        </div>
      </ListSurfaceViewport>
    </div>
  );
}
