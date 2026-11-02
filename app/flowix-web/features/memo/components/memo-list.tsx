'use client';

import { NotebookDocumentCreateDialog, type NotebookDocumentCreateRequest } from './notebook-document-create-dialog';

import { refreshIndexedMemo } from '@features/memo/services/memo-list-refresh-service';

import { useNotebookBackgroundStore } from '@features/memo/store/notebook-background-store';
import { flushSync } from 'react-dom';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import {
  canonicalDirectoryPath,
  joinNotebookMemoPath,
  notebookRelativeDirectoryPath,
  parentDirectoryPath,
  samePath,
} from '@/lib/path';
import { subscribe } from '@platform/tauri/event-bus';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  ArrowDownUp,
  Check,
  ChevronDown,
  ChevronUp,
  SwatchBook,
  Loader2,
  SquarePen,
  Table2,
  GalleryHorizontalEnd,
} from 'lucide-react';
import {
  getVisibleCreateFilter,
  noteIndexFor,
  noteLookupKey,
  useNoteStore,
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
import { cn, displayTitleFromFilename } from '@/lib/utils';
import { Button } from '@shared/ui/button';
import { Tooltip } from '@shared/ui/tooltip';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { FileTreeLoadingSkeleton } from '@shared/ui/file-tree-loading-skeleton';
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
import { clearWorkspaceDocument } from '@features/workspace/public/note-navigation-api';
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
import { AgentConversationTypeMenuItems } from '@features/agent/components/agent-conversation-type-menu-items';
import {
  createAndOpenAgentConversation,
} from '@features/agent/public/new-conversation-api';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import type { TableViewType } from '@features/multidimensional-table/public/create-api';

import { COLOR_LABEL_KEYS } from './memo-list/color-filter-submenu';
import { MemoNavigationDropdown, MemoNavigationSubmenu } from './memo-navigation-dropdown';
import { MemoListNavigationDrawer } from './memo-list-navigation-drawer';
import { MEMO_CREATE_VIEW_OPTIONS } from './memo-create-view-options';
import { NotebookFolderView } from './notebook-folder-view';
import { useMemoListPagination } from './memo-list/use-memo-list-pagination';
import { MemoListRows, type MemoRowKeepAliveChange } from './memo-list/memo-list-rows';
import {
  findRunningAgentTypeForMemo,
  useRunningAgentTypeIndex,
} from '@features/agent/public/running-agents-api';
const logger = createLogger('memo-list');

async function nextUntitledNoteTitle(parentPath: string, baseTitle: string): Promise<string> {
  const children = await fileApi.getDirChildren(parentPath);
  const existingTitles = new Set(children
    .filter((item) => item.type === 'document' && /\.(md|markdown)$/i.test(item.name))
    .map((item) => displayTitleFromFilename(item.name).trim().toLowerCase()));
  const normalizedBaseTitle = baseTitle.trim();
  if (!existingTitles.has(normalizedBaseTitle.toLowerCase())) return normalizedBaseTitle;
  let number = 1;
  while (existingTitles.has(`${normalizedBaseTitle} ${number}`.toLowerCase())) number += 1;
  return `${normalizedBaseTitle} ${number}`;
}

function EmptyState({ hasNotebooks }: { hasNotebooks: boolean }) {
  const { t } = useI18n();
  if (!hasNotebooks) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-[var(--muted-foreground)]">
        <span className="text-sm">{t('memo.list.emptyNoNotebook')}</span>
        <Button
          variant="ghost"
          size="sm"
          className="rounded-lg border border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
          onClick={() => window.dispatchEvent(new Event('flowix:open-create-notebook'))}
        >
          {t('memo.list.createNotebook')}
        </Button>
      </div>
    );
  }
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
  onCreated?: (selection: { relativePath: string; collectionId: string; viewId: string }) => void | Promise<void>;
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
  // Paging and the virtual rows share the OverlayScrollbar's native scroller.
  const listContainerRef = useRef<HTMLDivElement>(null);
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
  const selectedNote = useNoteStore((s) => s.selectedNote);
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
  const [notebookLoadContext, setNotebookLoadContext] = useState({
    notebookId: selectedNotebookId,
    skipInitialLoading: false,
    notesSettled: false,
  });
  const isCurrentNotebookEntry = notebookLoadContext.notebookId === selectedNotebookId;
  const skipInitialNotebookLoading = isCurrentNotebookEntry
    ? notebookLoadContext.skipInitialLoading
    : Boolean(notebookLoadContext.notebookId);
  const skipMemoListLoading = skipInitialNotebookLoading
    && (!isCurrentNotebookEntry || !notebookLoadContext.notesSettled);
  useEffect(() => {
    if (!selectedNotebookId) return;
    setNotebookLoadContext((previous) => previous.notebookId === selectedNotebookId
      ? previous
      : {
        notebookId: selectedNotebookId,
        skipInitialLoading: Boolean(previous.notebookId),
        notesSettled: false,
      });
  }, [selectedNotebookId]);
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
          const target = useWorkColumnStore.getState().navigation.target;
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
  }, [t]);
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
      setSelectedNotebook: s.setSelectedNotebook,
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
  const pendingDocumentPath = useWorkColumnStore((state) => {
    const { phase, pendingTarget } = state.navigation;
    return phase === 'loading' && pendingTarget?.kind === 'external' ? pendingTarget.path : null;
  });
  const workTargetParentPath = useWorkColumnStore((state) => {
    if (!selectedNotebook) return null;
    // The committed Work target is the implicit destination for tree creation.
    // Fall back to the notebook preference when Work has no in-notebook target.
    const target = state.navigation.target;
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
  const pendingListItem = pendingDocumentPath && selectedNotebook?.path
    ? notes.find((note) => samePath(
        joinNotebookMemoPath(selectedNotebook.path, note.relativePath) ?? '',
        pendingDocumentPath,
      ))
    : undefined;
  const selectedNoteItem = selectedNote
    ? noteIndexFor(notes).get(noteLookupKey(selectedNote.notebookId, selectedNote.relativePath))
    : undefined;
  const selectedListItemKey = pendingDocumentPath
    ? pendingListItem ? noteListItemKey(pendingListItem) : undefined
    : selectedNote
      ? selectedNoteItem
        ? noteListItemKey(selectedNoteItem)
        : `path:${selectedNote.notebookId}:${selectedNote.relativePath}`
      : undefined;
  const [notebookDropdownOpen, setNotebookDropdownOpen] = useState(false);
  const [isCreatingMemo, setIsCreatingMemo] = useState(false);
  const [localNavigationDrawerOpen, setLocalNavigationDrawerOpen] = useState(false);
  const [sortSubmenuOpen, setSortSubmenuOpen] = useState(false);
  const [createFolderRequest, setCreateFolderRequest] = useState<{
    id: number;
    parentPath: string;
  } | null>(null);
  const [createdCardRevealKey, setCreatedCardRevealKey] = useState<string | null>(null);
  const handleCreatedCardRevealed = useCallback(() => {
    setCreatedCardRevealKey(null);
  }, []);
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
    setSortSubmenuOpen(false);
  }, [showFolderView]);

  useEffect(() => {
    setCreateFolderRequest(null);
    setCreatedCardRevealKey(null);
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
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('NOTE_INDEX_PENDING')) {
      const id = useNoteStore.getState().selectedNotebook?.id;
      if (id) useNotebookBackgroundStore.getState().pending(id);
      setMemoListError(null);
      return;
    }
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
      state.dataConditionsByNotebook?.[state.selectedNotebook?.id ?? ''],
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
      state.dataConditionsByNotebook?.[state.selectedNotebook?.id ?? ''],
    );
    if (memoListError?.queryKey === queryKey && memoListError.kind === 'more') return;
    void loadMoreMemos().catch((error) => {
      handleMemoListLoadError(error, 'more');
    });
  }, [handleMemoListLoadError, loadMoreMemos, memoListError]);

  const handleRetryMemoList = useCallback(() => {
    setMemoListError(null);
    triggerMemoListRefresh();
  }, [triggerMemoListRefresh]);

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
      if (!String(error).includes('NOTE_INDEX_PENDING')) toast.error(t('memo.list.loadFailed'));
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
    dataCondition,
  );
  const currentMemoListError = memoListError?.queryKey === currentMemoListQueryKey
    ? memoListError
    : null;
  const hasCurrentMemoListData = loadedMemoListQueryKey === currentMemoListQueryKey
    || memoListQueryKey === currentMemoListQueryKey;
  const backgroundIndex = useNotebookBackgroundStore((state) => selectedNotebookId ? state.statuses[selectedNotebookId] : undefined);
  const indexPreparing = backgroundIndex?.state === 'queued' || backgroundIndex?.state === 'running';
  const indexFailed = backgroundIndex?.state === 'failed';
  // Only the first list attempt after navigation skips its placeholder.
  // Success and failure both restore normal feedback for filters and retries.
  useEffect(() => {
    if (!hasCurrentMemoListData && !currentMemoListError && !indexFailed) return;
    setNotebookLoadContext((previous) => (
      previous.notebookId === selectedNotebookId && !previous.notesSettled
        ? { ...previous, notesSettled: true }
        : previous
    ));
  }, [selectedNotebookId, hasCurrentMemoListData, currentMemoListError, indexFailed]);
  useEffect(() => {
    if (backgroundIndex?.state === 'ready') setMemoListError(null);
  }, [backgroundIndex?.state, backgroundIndex?.revision, selectedNotebookId]);
  const retryIndexOrList = () => {
    if (!selectedNotebookId || !indexFailed) { handleRetryMemoList(); return; }
    const id = selectedNotebookId;
    useNotebookBackgroundStore.getState().pending(id, true);
    void import('@platform/tauri/client/memos').then(({ notebooks }) => notebooks.refreshIndex(id)).catch((error) => {
      const current = useNotebookBackgroundStore.getState().statuses[id];
      if (current) useNotebookBackgroundStore.getState().apply({ ...current, state: 'failed', message: String(error) });
    });
  };

  const showMemoListLoading = indexPreparing || startupPhase === 'loading' || shouldShowMemoListLoading({
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

  const { onScroll: handleMemoListScroll } = useMemoListPagination({
    itemCount: listItems.length,
    loading: showMemoListLoading,
    hasMorePages: memoListHasMore,
    loadingMorePages: memoListLoadingMore,
    loadMorePages: handleLoadMoreMemos,
    scrollerRef: listContainerRef,
    isActive: isActive && dataLoadingEnabled && memoListView !== 'folders',
  });
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
  const handleSaveDefaultCreateFolder = useCallback(async (folderPath: string | null): Promise<boolean> => {
    if (!selectedNotebook) return false;
    const normalizedPath = folderPath?.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || null;
    try {
      const preferences = await fileApi.getNotebookViewPreferences(selectedNotebook.path);
      await fileApi.setNotebookViewPreferences(selectedNotebook.path, {
        ...preferences,
        defaultCreateFolder: normalizedPath,
      });
      setDefaultCreateFolderState({ notebookId: selectedNotebook.id, path: normalizedPath });
      toast.success(t(normalizedPath
        ? 'memo.fileTree.defaultCreateFolderSet'
        : 'memo.fileTree.defaultCreateFolderCleared'));
      return true;
    } catch (error) {
      logger.warn('save default note folder failed', { error, folderPath });
      toast.error(t('memo.fileTree.preferenceSaveFailed'));
      return false;
    }
  }, [selectedNotebook, t]);
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
      host: 'browser-column',
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
  }, [t]);

  const handleRequestDeleteMemo = useCallback((memo: NoteListItem) => {
    window.dispatchEvent(new CustomEvent<NoteListItem>('flowix:request-delete-memo', { detail: memo }));
  }, []);

  const handleFavoriteToggle = useCallback(async (memo: NoteListItem) => {
    const queryKey = useNoteStore.getState().memoListQueryKey;
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
        useNoteStore.getState().applyNoteListChange(memo.notebookId, memo.relativePath, null);
        toast.success(t('memo.favorite.missingCleaned'));
        return;
      }
      await refreshIndexedMemo(memo.notebookId, memo.relativePath);
      const state = useNoteStore.getState();
      // A metadata refresh replaces the card in place. Reload the first page
      // so pin/unpin uses backend ordering and resets the pagination cursor.
      // Do not disturb a different notebook or filter opened during the save.
      if (state.selectedNotebook?.id === memo.notebookId && state.memoListQueryKey === queryKey) {
        const loaded = await state.loadNotes({ source: 'memo-pin-toggle' });
        if (loaded && useNoteStore.getState().memoListQueryKey === queryKey) {
          listContainerRef.current?.scrollTo({ top: 0 });
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [t]);

  const handleColorsChange = useCallback(async (memo: NoteListItem, colors: NoteColor[]) => {
    const path = joinNotebookMemoPath(
      useNoteStore.getState().selectedNotebook?.path ?? '',
      noteListItemRelativePath(memo),
    ) ?? '';
    const saved = await noteRepository.setColors(path, colors);
    if (!saved) {
      triggerMemoListRefresh();
      return;
    }
    await refreshIndexedMemo(memo.notebookId, memo.relativePath);
  }, [triggerMemoListRefresh]);

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
            onFavoriteToggle={handleFavoriteToggle}
            onDelete={handleRequestDeleteMemo}
            onColorsChange={handleColorsChange}
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
      const workTargetParentRelativePath = memoListView !== 'folders' || workTargetParentPath === null
        ? null
        : notebookRelativeDirectoryPath(selectedNotebook.path, workTargetParentPath);
      const parentRelativePath = parentRelativePathOverride
        ?? workTargetParentRelativePath
        ?? (await fileApi.getNotebookViewPreferences(selectedNotebook.path)).defaultCreateFolder
        ?? '';
      const notebookRoot = selectedNotebook.path.replace(/[\\/]+$/, '');
      const namingParentPath = parentRelativePath
        ? `${notebookRoot}/${parentRelativePath}`
        : notebookRoot;
      const title = titleOverride?.trim()
        || await nextUntitledNoteTitle(namingParentPath, t('memo.untitled'));
      const result = await noteRepository.create(
        activeTagId ?? undefined,
        selectedNotebook.id,
        parentRelativePath,
        title,
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
      if (shouldSelectNewMemo) {
        const cardKey = `path:${selectedNotebook.id}:${result.relativePath}`;
        setCreatedCardRevealKey(cardKey);
        prepareForInsert(cardKey);
      }

      // 新笔记插入置顶区域之后，虚拟列表负责定位，动画 hook 负责入场。
      useNoteStore.getState().upsertCreatedNote(result);
      // Opening is a workspace navigation transaction. Leave selection to the
      // facade so a failed document open can restore the previous memo.
      const opening = shouldSelectNewMemo
        ? openNotebookNote(result.path, selectedNotebook, { initialFocus: 'title', treeReveal: 'created-note' })
        : null;
      // The document save emits a path invalidation after applying custom-view
      // properties; the shared list query subscriber reloads this projection.
      if (opening) await opening;
    } catch (error) {
      logger.warn('create memo failed', { error, notebookId: selectedNotebook.id });
      toast.error(t('memo.list.createFailed'));
    } finally {
      setIsCreatingMemo(false);
    }
  }, [
    activeFilter,
    activeTagId,
    activeCustomFilter,
    activeCustomFilterId,
    loadNotebookFilters,
    memoListView,
    prepareForInsert,
    workTargetParentPath,
    selectedNotebook,
    setActiveFilter,
    setSelectedTagId,
    t,
  ]);

  const handleCreateNoteInFolder = useCallback(async (parentPath?: string, title?: string) => {
    if (!selectedNotebook) return;
    if (parentPath === undefined) return handleCreateMemo(undefined, title);
    const root = selectedNotebook.path.replace(/\/+$/, '');
    const parent = parentPath.replace(/\/+$/, '');
    if (parent !== root && !parent.startsWith(`${root}/`)) return;
    const relative = parent === root ? '' : parent.slice(root.length + 1);
    return handleCreateMemo(relative, title);
  }, [handleCreateMemo, selectedNotebook]);

  const openDocumentCreateDialog = (kind: NotebookDocumentCreateRequest['kind'], viewType?: TableViewType) => {
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
  };

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

  // 排序入口尾部展示当前排序方式。
  const sortValueAdornment = activeSort === 'updatedAt'
    ? t('memo.list.sortUpdated')
    : activeSort === 'filenameAsc'
      ? t('memo.list.sortFilenameAsc')
      : activeSort === 'filenameDesc'
        ? t('memo.list.sortFilenameDesc')
        : t('memo.list.sortCreated');
  const visibleCreateViewOptions = createViewsExpanded
    ? MEMO_CREATE_VIEW_OPTIONS
    : MEMO_CREATE_VIEW_OPTIONS.slice(0, 1);
  const createTypeMenuContent = (
    <DropdownMenuContent align="end" className="w-[200px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
      <DropdownMenuLabel className="px-[0.375rem] pb-[0.35rem] pt-[0.35rem] text-xs font-normal leading-[1.2] text-[var(--muted-foreground)]">
        {t('memo.create.documents')}
      </DropdownMenuLabel>
      <DropdownMenuItem
        disabled={!selectedNotebook}
        onClick={() => {
          void handleCreateMemo();
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
      {memoListView === 'folders' && newConversationSelection.options.length > 0 && (
        <>
          <DropdownMenuLabel className="px-[0.375rem] pb-[0.35rem] pt-[0.35rem] text-xs font-normal leading-[1.2] text-[var(--muted-foreground)]">
            {t('memo.create.conversations')}
          </DropdownMenuLabel>
          <AgentConversationTypeMenuItems
            options={newConversationSelection.options}
            disabled={!selectedNotebook}
            onSelect={handleCreateAgentConversation}
          />
        </>
      )}
      {memoListView === 'folders' && (
        <>
          <DropdownMenuLabel className="px-[0.375rem] pb-[0.35rem] pt-[0.35rem] text-xs font-normal leading-[1.2] text-[var(--muted-foreground)]">
            {t('memo.create.newView')}
          </DropdownMenuLabel>
          {visibleCreateViewOptions.map(({ type, labelKey }) => (
            <DropdownMenuItem
              key={type}
              disabled={!selectedNotebook}
              onClick={() => {
                openDocumentCreateDialog('table', type);
              }}
              className="group h-7 items-center gap-2 rounded-lg px-2 py-0 hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
            >
              {type === 'table'
                ? <Table2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                : <span className="h-4 w-4 shrink-0" aria-hidden="true" />}
              <span className="min-w-0 flex-1 truncate text-left">{t(labelKey)}</span>
              <span className="ml-auto shrink-0 text-xs text-[var(--muted-foreground)] opacity-50 group-hover:text-[var(--primary-foreground)] group-focus-visible:text-[var(--primary-foreground)] group-data-[highlighted]:text-[var(--primary-foreground)]">{t('memo.create.note')}</span>
            </DropdownMenuItem>
          ))}
          {createViewsExpanded && (
            <>
              <DropdownMenuItem
                disabled={!selectedNotebook}
                onClick={() => {
                  openDocumentCreateDialog('media-library');
                }}
                className="group h-7 items-center gap-2 rounded-lg px-2 py-0 hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
              >
                <GalleryHorizontalEnd className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-left">{t('memo.create.mediaLibraryMenuLabel')}</span>
                <span className="ml-auto shrink-0 text-xs text-[var(--muted-foreground)] opacity-50 group-hover:text-[var(--primary-foreground)] group-focus-visible:text-[var(--primary-foreground)] group-data-[highlighted]:text-[var(--primary-foreground)]">{t('memo.create.assetShort')}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!selectedNotebook || selectedNotebook.missing}
                onClick={() => {
                  openDocumentCreateDialog('work-documents');
                }}
                className="group h-7 items-center gap-2 rounded-lg px-2 py-0 hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
              >
                <span className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-left">{t('memo.create.workDocumentsMenuLabel')}</span>
                <span className="ml-auto shrink-0 text-xs text-[var(--muted-foreground)] opacity-50 group-hover:text-[var(--primary-foreground)] group-focus-visible:text-[var(--primary-foreground)] group-data-[highlighted]:text-[var(--primary-foreground)]">{t('memo.create.assetShort')}</span>
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuItem
            keepOpenOnClick
            onClick={() => setCreateViewsExpanded((expanded) => !expanded)}
            title={t(createViewsExpanded ? 'memo.create.collapseViews' : 'memo.create.expandViews')}
            className="group h-5 justify-center rounded-lg px-2 py-0 text-[var(--muted-foreground)] hover:text-[color-mix(in_oklch,var(--brand)_65%,white)]"
          >
            {createViewsExpanded
              ? <ChevronUp className="h-4 w-4" aria-hidden="true" />
              : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
            <span className="sr-only">{t(createViewsExpanded ? 'memo.create.collapseViews' : 'memo.create.expandViews')}</span>
          </DropdownMenuItem>
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
        dataCondition={dataCondition}
        memoListRefreshTrigger={memoListRefreshTrigger}
        loadNotes={loadNotes}
        setLoadedMemoListQueryKey={setLoadedMemoListQueryKey}
        setIsMemoListLoading={setIsMemoListLoading}
        onLoadError={handleMemoListLoadError}
        onLoadStart={handleMemoListLoadStart}
        onLoadSuccess={handleMemoListLoadSuccess}
      />
      <div className="flex min-w-0 items-center gap-2 pb-2 pl-[72px] pr-3">
        <div className="min-w-0 flex-1">
          {!showFolderView && (
          <MemoNavigationDropdown
            title={headerLabel}
            titleTooltip={hasActiveFilter ? headerLabel : undefined}
            ariaLabel={t('memo.navigation.menuTitle')}
            open={notebookDropdownOpen}
            onOpenChange={setNotebookDropdownOpen}
            showClear={hasActiveFilter || activeFilter !== 'all' || Boolean(dataCondition)}
            onClear={handleClearFilter}
            notebookPath={selectedNotebook?.path}
            defaultCreateFolder={defaultCreateFolder}
            onSavePath={handleSaveDefaultCreateFolder}
          >
          <div className="space-y-0.5">
            {/* Sort — 二级弹窗，时间范围筛选置于排序项顶部。 */}
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
                    onClick={() => handlePeriodFilterSelect('thisWeek')}
                    onMouseDown={(event) => event.preventDefault()}
                    className={cn(
                      'memo-navigation-submenu-item memo-navigation-submenu-item--neutral-hover mention-note-item cursor-pointer hover:bg-[var(--hover-bg)] focus-visible:bg-[var(--hover-bg)] focus-visible:outline-none',
                      activeFilter === 'thisWeek' && 'is-selected',
                    )}
                  >
                    <span className="mention-note-title">{t('memo.list.filterThisWeek')}</span>
                    {activeFilter === 'thisWeek' && <Check className="w-4 h-4 text-[var(--brand)]" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePeriodFilterSelect('thisMonth')}
                    onMouseDown={(event) => event.preventDefault()}
                    className={cn(
                      'memo-navigation-submenu-item memo-navigation-submenu-item--neutral-hover mention-note-item cursor-pointer hover:bg-[var(--hover-bg)] focus-visible:bg-[var(--hover-bg)] focus-visible:outline-none',
                      activeFilter === 'thisMonth' && 'is-selected',
                    )}
                  >
                    <span className="mention-note-title">{t('memo.list.filterThisMonth')}</span>
                    {activeFilter === 'thisMonth' && <Check className="w-4 h-4 text-[var(--brand)]" />}
                  </button>
                  <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
                  <button
                    type="button"
                    onClick={() => handleSortFromSubmenu('createdAt')}
                    onMouseDown={(event) => event.preventDefault()}
                    className={cn(
                      'memo-navigation-submenu-item memo-navigation-submenu-item--neutral-hover mention-note-item cursor-pointer hover:bg-[var(--hover-bg)] focus-visible:bg-[var(--hover-bg)] focus-visible:outline-none',
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
                      'memo-navigation-submenu-item memo-navigation-submenu-item--neutral-hover mention-note-item cursor-pointer hover:bg-[var(--hover-bg)] focus-visible:bg-[var(--hover-bg)] focus-visible:outline-none',
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
                      'memo-navigation-submenu-item memo-navigation-submenu-item--neutral-hover mention-note-item cursor-pointer hover:bg-[var(--hover-bg)] focus-visible:bg-[var(--hover-bg)] focus-visible:outline-none',
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
                      'memo-navigation-submenu-item memo-navigation-submenu-item--neutral-hover mention-note-item cursor-pointer hover:bg-[var(--hover-bg)] focus-visible:bg-[var(--hover-bg)] focus-visible:outline-none',
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
            /* 文件树只有一个「新建」入口: 点击直接展开类型菜单, 再做二次选择。 */
            <DropdownMenu open={createTypeMenuOpen} onOpenChange={handleCreateTypeMenuOpenChange}>
              <Tooltip content={t('memo.create.chooseType')} shortcut="memo.create">
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    disabled={!selectedNotebook || isCreatingMemo}
                    aria-busy={isCreatingMemo}
                    aria-label={t('memo.create.chooseType')}
                    aria-haspopup="menu"
                    className="h-[30px] w-[30px] justify-center rounded-xl border border-transparent bg-[var(--primary)] p-0 text-[var(--primary-foreground)] hover:opacity-90"
                  >
                    {isCreatingMemo
                      ? <Loader2 className="h-4 w-4 flowix-spin" aria-hidden="true" />
                      : <SquarePen className="h-4 w-4" aria-hidden="true" />}
                  </Button>
                </DropdownMenuTrigger>
              </Tooltip>
              {createTypeMenuContent}
            </DropdownMenu>
          ) : (
            <DropdownMenu open={createTypeMenuOpen} onOpenChange={handleCreateTypeMenuOpenChange}>
              <Tooltip content={t('memo.create.chooseType')} shortcut="memo.create">
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    disabled={isCreatingMemo}
                    aria-busy={isCreatingMemo}
                    aria-label={t('memo.create.chooseType')}
                    className="h-[30px] w-[30px] justify-center rounded-xl border border-transparent bg-[var(--primary)] p-0 text-[var(--primary-foreground)] hover:opacity-90"
                  >
                    {isCreatingMemo
                      ? <Loader2 className="h-4 w-4 flowix-spin" aria-hidden="true" />
                      : <SquarePen className="h-4 w-4" aria-hidden="true" />}
                  </Button>
                </DropdownMenuTrigger>
              </Tooltip>
              {createTypeMenuContent}
            </DropdownMenu>
          )}
        </div>
      </div>

      {documentCreateRequest && <NotebookDocumentCreateDialog request={documentCreateRequest} onClose={() => setDocumentCreateRequest(null)} />}

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
          <OverlayScrollbar
            className="flex h-full min-h-0 min-w-0 w-full"
            scrollerClassName="min-w-0 w-full flex-1 overflow-y-auto px-1 py-2"
            scrollerRef={attachListScroller}
            onScroll={(event) => {
              setShowScrollTopHint(event.currentTarget.scrollTop > 0);
              handleMemoListScroll(event);
            }}
          >
            {currentMemoListError?.kind === 'initial' || (!hasCurrentMemoListData && indexFailed) ? (
              <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-3 px-4 text-center" role="alert">
                <span className="text-sm text-[var(--muted-foreground)]">{t('memo.list.loadFailed')}</span>
                <Button size="sm" className="rounded-lg" onClick={retryIndexOrList}>{t('error.retry')}</Button>
              </div>
            ) : !hasCurrentMemoListData && showMemoListLoading ? (
              skipMemoListLoading
                ? null
                : <ListSurfaceLoadingState ariaLabel={t('memo.list.loadingLibrary')} />
            ) : listItems.length > 0 ? (
              <div key={currentMemoListQueryKey} className="flowix-list-content-enter">
                <MemoListRows
                  items={listItems}
                  scrollElement={listScrollElement}
                  queryKey={currentMemoListQueryKey}
                  revealKey={createdCardRevealKey}
                  onRevealed={handleCreatedCardRevealed}
                  renderRow={renderMemoRow}
                />
              </div>
            ) : (
              <EmptyState hasNotebooks={notebooks.length > 0} />
            )}
            {memoListLoadingMore && listItems.length > 0 && (
              <div
                className="flex h-10 items-center justify-center"
                role="status"
                aria-live="polite"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                <span className="sr-only">{t('memo.list.loadingMore')}</span>
              </div>
            )}
            {currentMemoListError?.kind === 'more' && (
              <div className="flex items-center justify-center gap-2 px-4 py-3 text-center text-xs text-[var(--muted-foreground)]" role="alert">
                <span>{t('memo.list.loadFailed')}</span>
                <Button size="sm" className="rounded-lg" onClick={handleRetryMemoListMore}>{t('error.retry')}</Button>
              </div>
            )}
            {(currentMemoListError?.kind === 'refresh' || (hasCurrentMemoListData && indexFailed)) && (
              <div className="flex items-center justify-center gap-2 px-4 py-3 text-center text-xs text-[var(--muted-foreground)]" role="alert">
                <span>{t('memo.list.loadFailed')}</span>
                <Button size="sm" className="rounded-lg" onClick={retryIndexOrList}>{t('error.retry')}</Button>
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
