import type { CollectionActionsHost } from '@shared/ui/collection-actions';
import { useCollectionScrollRoot } from '@shared/ui/collection-scroll-context';
import { useTitleEditCaret } from '@shared/hooks/use-title-edit-caret';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Inbox, ChevronRight } from 'lucide-react';
import type { DocumentPageItem } from '@platform/tauri/client';
import { resourceKindFromPath } from '@features/editor/public/code-file';
import { toast } from '@/lib/toast';
import { canonicalPath } from '@/lib/path';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Button } from '@shared/ui/button';
import { CollectionAreaMenu } from '@shared/ui/collection-area-menu';
import { assetAreaMenuItems } from '@shared/ui/collection-area-menu-items';
import { useI18n } from '@/lib/i18n';
import type { MediaLibraryRecord } from '@features/media-library/public/model-api';
import type { AssetFilterCondition, AssetFilterSaveOptions } from '@features/collection/public/folder-api';
import { subscribeCollectionDatasetFilter } from '@features/collection/public/dataset-filter-api';
import type { DocumentListViewContext } from './document-list-view-model';
import { useDocumentListData } from './use-document-list-data';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { openPath } from '@platform/tauri/opener';
import { WorkDocumentsLoadingSkeleton } from '@shared/ui/work-documents-loading-skeleton';
import {
  DocumentCard, WorkDocumentListRow, VirtualizedMediaColumn,
  MEDIA_COLUMN_GAP, MEDIA_CARD_MIN_WIDTH,
  WORK_DOCUMENT_CARD_MIN_WIDTH, WORK_DOCUMENT_CARD_HEIGHT,
  matchesMediaRuleFilter, matchesAssetRuleFilter, mediaItemRelativePath,
} from './document-list-cards';
import { DocumentListHeader, type DocumentListMode } from './document-list-header';
import { useDatasetFilter } from './use-dataset-filter';

// Keep the loading effect stable when ordinary folders omit media records.
const EMPTY_MEDIA_LIBRARY_RECORDS: MediaLibraryRecord[] = [];
/** 非集合外壳场景（独立媒体库 / 文档列表）：右键菜单不挂任何项。 */
const NO_AREA_MENU_ITEMS: ReturnType<typeof assetAreaMenuItems> = [];
const ROW_HEIGHT = 224;

export function DocumentListView({ listContext, mediaLibrary = false, workDocuments = false, libraryName = '媒体库', libraryFilePath, mediaLibraryFolderPath, workDocumentsFolderPath, mediaLibraryFilter = {}, workDocumentsFilter = {}, mediaLibraryRecords = EMPTY_MEDIA_LIBRARY_RECORDS, mediaLibraryExcludedPaths = [], mediaLibraryDatasetFilter, mediaLibraryViewFilter, assetViewFilter, onMediaLibraryFilterChange, onWorkDocumentsFilterChange, onOpenNoteFilter, onDatasetFilterOpenChange, onLoadingChange, onRenameLibrary, onAddMedia, onDeleteMedia, onImportFiles, onSwitchToTable, libraryActionsDisabled = false, refreshPaused = false, workspaceHost = 'column-1', actionsHost, pageScroll = false }: {
  listContext: DocumentListViewContext;
  mediaLibrary?: boolean;
  workDocuments?: boolean;
  /** 整页滚动（集合外壳）：不建内部滚动区，列表自然撑开，滚动交给外壳的页面滚动容器。 */
  pageScroll?: boolean;
  libraryName?: string;
  libraryFilePath?: string;
  /** 媒体库面板的固定位置（文件夹类型的集合）；undefined = 位置可改。 */
  mediaLibraryFolderPath?: string;
  /** 列表面板的固定位置（文件夹类型的集合）；undefined = 位置可改。 */
  workDocumentsFolderPath?: string;
  mediaLibraryFilter?: AssetFilterCondition;
  workDocumentsFilter?: AssetFilterCondition;
  mediaLibraryRecords?: MediaLibraryRecord[];
  mediaLibraryExcludedPaths?: string[];
  mediaLibraryDatasetFilter?: Record<string, unknown> | null;
  assetViewFilter?: Record<string, unknown> | null;
  mediaLibraryViewFilter?: Record<string, unknown> | null;
  onAddMedia?: () => Promise<boolean>;
  /** 列表（work_documents）集合的「导入文件…」：把外部文件复制进集合的数据范围。 */
  onImportFiles?: () => Promise<boolean>;
  onDeleteMedia?: (item: DocumentPageItem) => Promise<boolean>;
  onMediaLibraryFilterChange?: (condition: AssetFilterCondition, options?: AssetFilterSaveOptions) => Promise<boolean>;
  onWorkDocumentsFilterChange?: (condition: AssetFilterCondition, options?: AssetFilterSaveOptions) => Promise<boolean>;
  /** Open the collection's note filter from the shared dataset menu. */
  onOpenNoteFilter?: () => void;
  onDatasetFilterOpenChange?: (open: boolean) => void;
  onLoadingChange?: (loading: boolean) => void;
  onRenameLibrary?: (title: string) => Promise<void>;
  onSwitchToTable?: () => void;
  libraryActionsDisabled?: boolean;
  refreshPaused?: boolean;
  workspaceHost?: 'column-1' | 'column-2';
  /** 集合外壳里的 tab 面板：本组件不再渲染自己的标题/操作行（tab 下只有数据列表），
   *  只把「一行操作」portal 进外壳 nav 右侧的操作槽（集合名由外壳统一给）。 */
  actionsHost?: CollectionActionsHost;
}) {
  const { t } = useI18n();
  const resourceKindsKey = (listContext.filters.resourceKinds ?? []).join('\u0000');
  const {
    items, linkedItems, folders, hasMediaDataset, hasLinkedMedia, loading, loadingLinkedItems,
    moreError, hasMore, error, loadMore, refresh,
  } = useDocumentListData({ listContext, mediaLibrary, workDocuments, mediaLibraryRecords, refreshPaused });
  useEffect(() => {
    if (workDocuments) onLoadingChange?.(loading);
  }, [loading, onLoadingChange, workDocuments]);

  // ── 标题 / 重命名 ────────────────────────────────────────────────────────
  const [editingLibraryTitle, setEditingLibraryTitle] = useState(false);
  const [libraryTitleDraft, setLibraryTitleDraft] = useState(libraryName);
  const [renamingLibraryTitle, setRenamingLibraryTitle] = useState(false);
  const { inputRef: libraryTitleInputRef, captureCaret: captureLibraryTitleCaret } = useTitleEditCaret(editingLibraryTitle);
  useEffect(() => {
    if (!editingLibraryTitle) setLibraryTitleDraft(libraryName);
  }, [editingLibraryTitle, libraryName]);
  const commitLibraryTitle = useCallback(async (rawTitle: string) => {
    const title = rawTitle.trim();
    setEditingLibraryTitle(false);
    if (renamingLibraryTitle) return;
    if (!onRenameLibrary || !title || title === libraryName) {
      setEditingLibraryTitle(false);
      return;
    }
    setRenamingLibraryTitle(true);
    try {
      await onRenameLibrary(title);
    } finally {
      setRenamingLibraryTitle(false);
      setEditingLibraryTitle(false);
    }
  }, [libraryName, onRenameLibrary, renamingLibraryTitle]);
  const beginLibraryTitleEdit = useCallback(() => {
    if (!onRenameLibrary || renamingLibraryTitle) return;
    setLibraryTitleDraft(libraryName);
    setEditingLibraryTitle(true);
  }, [libraryName, onRenameLibrary, renamingLibraryTitle]);
  useEffect(() => {
    if (!editingLibraryTitle || !mediaLibrary) return;
    const blurOnOutsidePointer = (event: PointerEvent) => {
      const input = libraryTitleInputRef.current;
      if (input && !event.composedPath().includes(input)) input.blur();
    };
    document.addEventListener('pointerdown', blurOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', blurOnOutsidePointer, true);
  }, [editingLibraryTitle, mediaLibrary, libraryTitleInputRef]);

  // ── 资料筛选（图墙 / 列表共用一份配置）────────────────────────────────────
  const activeFileCondition = workDocuments ? workDocumentsFilter : mediaLibraryFilter;
  /** 类型多选按字符串比较，避免数组每次渲染都换引用（滚动期间会反复触发重置）。 */
  const activeFileTypesKey = (activeFileCondition.file_types ?? []).join(' ');
  const filter = useDatasetFilter({
    condition: activeFileCondition,
    onChange: workDocuments ? onWorkDocumentsFilterChange : onMediaLibraryFilterChange,
    notebookPath: listContext.notebookPath,
    fixedFolderPath: workDocuments ? workDocumentsFolderPath : mediaLibraryFolderPath,
    busy: libraryActionsDisabled,
    onOpenChange: onDatasetFilterOpenChange,
  });
  useEffect(() => {
    if (!actionsHost || !libraryFilePath || (!mediaLibrary && !workDocuments)) return;
    return subscribeCollectionDatasetFilter(libraryFilePath, mediaLibrary ? 'media' : 'work_documents', filter.openMenu);
  }, [actionsHost, filter.openMenu, libraryFilePath, mediaLibrary, workDocuments]);

  // ── 滚动 / 视口测量 ──────────────────────────────────────────────────────
  const [viewport, setViewport] = useState({ top: 0, height: 600, width: 600 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pageScrollRoot = useCollectionScrollRoot();
  const pageScrollRef = useMemo(() => ({ current: pageScrollRoot }), [pageScrollRoot]);
  const viewportRef = pageScroll ? pageScrollRef : scrollRef;
  const headerRef = useRef<HTMLDivElement>(null);
  const headerEmbedded = actionsHost !== undefined;
  const mediaGridRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [mediaGridScrollMargin, setMediaGridScrollMargin] = useState(0);
  const previewObserverRef = useRef<IntersectionObserver | null>(null);
  const previewCallbacksRef = useRef(new Map<Element, () => void>());
  const observeMediaCard = useCallback((node: Element, onNear: () => void) => {
    let observer = previewObserverRef.current;
    if (!observer) {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          previewCallbacksRef.current.get(entry.target)?.();
          previewCallbacksRef.current.delete(entry.target);
          previewObserverRef.current?.unobserve(entry.target);
        }
      }, { root: viewportRef.current, rootMargin: '600px' });
      previewObserverRef.current = observer;
    }
    previewCallbacksRef.current.set(node, onNear);
    observer.observe(node);
    return () => {
      previewCallbacksRef.current.delete(node);
      previewObserverRef.current?.unobserve(node);
    };
  }, [viewportRef]);
  useEffect(() => () => {
    previewObserverRef.current?.disconnect();
    previewObserverRef.current = null;
    previewCallbacksRef.current.clear();
  }, [viewportRef]);
  useEffect(() => {
    // 整页滚动：滚动容器是外壳的 `.collection-page-scroll` 祖先，列表自身不滚动。
    const element = viewportRef.current;
    if (!element) return;
    // Scroll fires far more often than the viewport actually changes. Coalesce
    // to one measurement per frame and bail out when the numbers are identical,
    // otherwise every scroll event re-rendered the whole card grid.
    const measure = () => setViewport((current) => {
      if (pageScroll) {
        const list = listRef.current;
        if (!list) return current;
        // 列表顶端已被滚出可视区多少像素 + 可视区高度；宽度即列表自身宽度。
        const top = Math.max(0, element.getBoundingClientRect().top - list.getBoundingClientRect().top);
        const height = element.clientHeight;
        const width = list.clientWidth;
        return current.top === top && current.height === height && current.width === width
          ? current
          : { top, height, width };
      }
      // 嵌入模式下 header 已 portal 到 nav（不在滚动流内），滚动偏移不再扣除 header 高度。
      const top = Math.max(0, element.scrollTop - (headerEmbedded ? 0 : (headerRef.current?.offsetHeight ?? 0) + 8));
      const height = element.clientHeight;
      const width = element.clientWidth - 40;
      return current.top === top && current.height === height && current.width === width
        ? current
        : { top, height, width };
    });
    const measureMediaGridOffset = () => {
      const grid = mediaGridRef.current;
      if (!grid) return;
      const gridTop = grid.getBoundingClientRect().top;
      const scrollTop = element.getBoundingClientRect().top;
      const next = Math.max(0, gridTop - scrollTop + element.scrollTop);
      setMediaGridScrollMargin((current) => current === next ? current : next);
    };
    let frame = 0;
    const schedule = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
        measureMediaGridOffset();
      });
    };
    measure();
    measureMediaGridOffset();
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    if (headerRef.current) resize.observe(headerRef.current);
    if (mediaGridRef.current) resize.observe(mediaGridRef.current);
    if (!mediaLibrary) element.addEventListener('scroll', schedule, { passive: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      resize.disconnect();
      element.removeEventListener('scroll', schedule);
    };
  }, [mediaLibrary, headerEmbedded, pageScroll, viewportRef]);
  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [listContext.displayId]);
  useEffect(() => {
    if (!mediaLibrary && !workDocuments) return;
    scrollRef.current?.scrollTo(0, 0);
  }, [mediaLibrary, workDocuments, activeFileCondition.file_name_contains, activeFileTypesKey, activeFileCondition.path_contains, activeFileCondition.path_scope, resourceKindsKey]);
  useEffect(() => {
    const root = viewportRef.current;
    if (!hasMore || moreError || !endRef.current || !root) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) loadMore();
    }, { root, rootMargin: '500px' });
    observer.observe(endRef.current);
    return () => observer.disconnect();
  }, [hasMore, loadMore, moreError, viewportRef]);

  // ── 可见条目 ─────────────────────────────────────────────────────────────
  const excludedMediaPathSet = useMemo(
    () => new Set(mediaLibraryExcludedPaths.map((path) => path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase())),
    [mediaLibraryExcludedPaths],
  );
  // Derived once per data/filter change. Previously this ran on every render,
  // including each scroll frame, so the whole list was re-filtered and de-duped
  // dozens of times per second while scrolling.
  const visibleItems = useMemo(() => (mediaLibrary
    ? [...new Map([
      ...linkedItems.filter((item) => !excludedMediaPathSet.has(mediaItemRelativePath(item.fullPath, listContext.notebookPath).toLocaleLowerCase())
        && matchesMediaRuleFilter(item, listContext.notebookPath, mediaLibraryViewFilter)),
      ...(hasMediaDataset ? items.filter((item) => (
        (item.resourceKind === 'image' || item.resourceKind === 'video')
        && !excludedMediaPathSet.has(mediaItemRelativePath(item.fullPath, listContext.notebookPath).toLocaleLowerCase())
        && matchesMediaRuleFilter(item, listContext.notebookPath, mediaLibraryDatasetFilter)
        && matchesMediaRuleFilter(item, listContext.notebookPath, mediaLibraryViewFilter)
      )) : []),
    ].map((item) => [canonicalPath(item.fullPath), item])).values()]
    : [...folders, ...items].filter((item) => !workDocuments || matchesAssetRuleFilter(item, listContext.notebookPath, assetViewFilter))), [
    workDocuments, assetViewFilter,
    mediaLibrary,
    linkedItems,
    items,
    folders,
    hasMediaDataset,
    mediaLibraryViewFilter,
    mediaLibraryDatasetFilter,
    excludedMediaPathSet,
    listContext.notebookPath,
  ]);
  useEffect(() => {
    if (!mediaLibrary) return;
    const element = viewportRef.current;
    const grid = mediaGridRef.current;
    if (!element || !grid) return;
    const next = Math.max(
      0,
      grid.getBoundingClientRect().top
        - element.getBoundingClientRect().top
        + element.scrollTop,
    );
    setMediaGridScrollMargin((current) => current === next ? current : next);
  }, [mediaLibrary, visibleItems.length, viewportRef]);

  // ── 虚拟化窗口 ───────────────────────────────────────────────────────────
  const columnCount = Math.max(1, Math.floor((viewport.width + 14) / 214));
  const mediaColumnCount = Math.min(
    Math.max(1, Math.floor((viewport.width + MEDIA_COLUMN_GAP) / (MEDIA_CARD_MIN_WIDTH + MEDIA_COLUMN_GAP))),
    Math.max(1, visibleItems.length),
  );
  const mediaColumns = useMemo(() => {
    const columns: DocumentPageItem[][] = Array.from({ length: mediaColumnCount }, () => []);
    // Appending a page keeps existing cards in their columns while the column count is unchanged.
    visibleItems.forEach((item, index) => columns[index % mediaColumnCount].push(item));
    return columns;
  }, [visibleItems, mediaColumnCount]);
  const rowCount = Math.ceil(visibleItems.length / columnCount);
  const firstRow = Math.min(Math.max(0, rowCount - 1), Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - 2));
  const lastRow = Math.min(rowCount, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + 2);
  const visibleCards = visibleItems.slice(firstRow * columnCount, lastRow * columnCount);
  // 工作文档卡片（竖排：上图标下标题，宽 200px）按固定卡片高 + 14px 行距做窗口虚拟化。
  const workColumnCount = Math.max(1, Math.floor((viewport.width + MEDIA_COLUMN_GAP) / (WORK_DOCUMENT_CARD_MIN_WIDTH + MEDIA_COLUMN_GAP)));
  const workRowStride = WORK_DOCUMENT_CARD_HEIGHT + MEDIA_COLUMN_GAP;
  const workRowCount = Math.ceil(visibleItems.length / workColumnCount);
  const workFirstRow = Math.min(Math.max(0, workRowCount - 1), Math.max(0, Math.floor(viewport.top / workRowStride) - 2));
  const workLastRow = Math.min(workRowCount, Math.ceil((viewport.top + viewport.height) / workRowStride) + 2);
  const visibleWorkRows = visibleItems.slice(workFirstRow * workColumnCount, workLastRow * workColumnCount);

  // ── 打开 / 新建 / 删除 ───────────────────────────────────────────────────
  const [addingMedia, setAddingMedia] = useState(false);
  const [mediaToDelete, setMediaToDelete] = useState<DocumentPageItem | null>(null);
  const [deletingMedia, setDeletingMedia] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const addMedia = () => {
    if (addingMedia || !onAddMedia) return;
    setAddingMedia(true);
    void onAddMedia().then((changed) => { if (changed) refresh(); }).catch((error) => {
      toast.error(error instanceof Error ? error.message : t('mediaLibrary.addMediaFailed'));
    }).finally(() => setAddingMedia(false));
  };
  const confirmDeleteMedia = useCallback(async () => {
    if (!mediaToDelete || !onDeleteMedia || deletingMedia) return;
    setDeletingMedia(true);
    try {
      if (await onDeleteMedia(mediaToDelete)) {
        setMediaToDelete(null);
        refresh();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('media.fileTree.deleteFailed'));
    } finally {
      setDeletingMedia(false);
    }
  }, [deletingMedia, mediaToDelete, onDeleteMedia, refresh, t]);
  const createNote = useCallback(async () => {
    const title = newTitle.trim();
    if (!title || creating || !listContext.notebookId) return;
    setCreating(true);
    try {
      const { noteRepository } = await import('@features/memo/services/note-repository');
      const root = canonicalPath(listContext.notebookPath).replace(/\/$/, '');
      const folder = canonicalPath(listContext.folderPath).replace(/\/$/, '');
      const relative = folder === root ? '' : folder.slice(root.length + 1);
      const created = await noteRepository.create(undefined, listContext.notebookId, relative, title);
      setCreateOpen(false);
      setNewTitle('');
      refresh();
      const { openWorkspaceSurface } = await import('@features/workspace/public/open-surface-api');
      await openWorkspaceSurface({
        index: 0,
        target: { kind: 'external', path: created.path, scopePath: listContext.notebookPath, transitionId: null },
      });
    } catch {
      toast.error('新建笔记失败');
    } finally {
      setCreating(false);
    }
  }, [creating, newTitle, listContext.folderPath, listContext.notebookId, listContext.notebookPath, refresh]);
  const openItem = useCallback(async (item: DocumentPageItem) => {
    try {
      if (workDocuments) {
        const { openWorkspaceSurface } = await import('@features/workspace/public/open-surface-api');
        await openWorkspaceSurface({
          index: 1,
          target: { kind: 'external', path: item.fullPath, scopePath: listContext.notebookPath, transitionId: null },
          options: { notebookId: listContext.notebookId },
        });
        return;
      }
      if (item.resourceKind === 'folder') {
        if (!listContext.notebookId) throw new Error('无法确定文件夹所属笔记本');
        const { openFolderCollectionFromFolder } = await import('@features/workspace/public/main-window-api');
        await openFolderCollectionFromFolder(listContext.notebookId, item.fullPath, workspaceHost);
        return;
      }
      if (item.isDirectory) {
        await openPath(item.fullPath);
        return;
      }
      const { openWorkspaceSurface } = await import('@features/workspace/public/session-opening-api');
      const kind = item.resourceKind ?? resourceKindFromPath(item.fullPath);
      if (kind === 'image' || kind === 'video') {
        await openWorkspaceSurface({ columnId: workspaceHost, target: {
          kind: 'media', filePath: item.fullPath, notebookId: listContext.notebookId,
          notebookPath: listContext.notebookPath, resourceKind: kind,
        } });
      } else {
        const target = { kind: 'external' as const, path: item.fullPath, scopePath: listContext.notebookPath, transitionId: null };
        await openWorkspaceSurface({ columnId: workspaceHost, target });
      }
    } catch {
      toast.error('打开文件失败');
    }
  }, [listContext.notebookId, listContext.notebookPath, workDocuments, workspaceHost]);

  const mode: DocumentListMode = mediaLibrary ? 'media' : workDocuments ? 'work' : 'documents';
  /**
   * 列表区域右键菜单 ── 只在集合外壳里出现（actionsHost 由外壳注入）：
   * 图墙与列表都属于资料视图，菜单只有一项「导入文件…」（媒体库添加图片 / 视频，
   * 列表导入普通文件），两者各自走已有的导入通道。
   */
  const importFilesFromMenu = () => {
    if (!onImportFiles || libraryActionsDisabled) return;
    void onImportFiles().then((changed) => { if (changed) refresh(); }).catch((error) => {
      toast.error(error instanceof Error ? error.message : t('mediaLibrary.addMediaFailed'));
    });
  };
  const areaMenuItems = !actionsHost
    ? NO_AREA_MENU_ITEMS
    : mediaLibrary
      ? assetAreaMenuItems({ t, onImportFiles: onAddMedia && !libraryActionsDisabled ? addMedia : undefined })
      : workDocuments
        ? assetAreaMenuItems({ t, onImportFiles: onImportFiles && !libraryActionsDisabled ? importFilesFromMenu : undefined })
        : NO_AREA_MENU_ITEMS;
  const folderTitle = listContext.folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || listContext.folderPath;
  const headerNode = <DocumentListHeader
    mode={mode}
    folderTitle={folderTitle}
    libraryName={libraryName}
    libraryFilePath={libraryFilePath}
    visibleCount={visibleItems.length}
    hasMore={hasMore}
    filter={filter}
    onOpenNoteFilter={onOpenNoteFilter}
    actionsHost={actionsHost}
    headerRef={headerRef}
    rename={{
      editing: editingLibraryTitle,
      draft: libraryTitleDraft,
      setDraft: setLibraryTitleDraft,
      inputRef: libraryTitleInputRef,
      captureCaret: captureLibraryTitleCaret,
      beginEdit: beginLibraryTitleEdit,
      commit: commitLibraryTitle,
      cancel: () => { setLibraryTitleDraft(libraryName); setEditingLibraryTitle(false); },
      busy: renamingLibraryTitle,
      disabled: mediaLibrary
        ? !onRenameLibrary || renamingLibraryTitle
        : !onRenameLibrary || libraryActionsDisabled,
    }}
    actions={{
      onAddMedia: onAddMedia ? addMedia : undefined,
      addingMedia,
      disabled: libraryActionsDisabled,
      onSwitchToTable,
      onCreateNote: () => setCreateOpen(true),
      canCreateNote: Boolean(listContext.notebookId),
    }}
  />;

  const body = <>
    {headerNode}
    {error ? <div className="flex h-full min-h-[160px] items-center justify-center text-center text-sm text-[var(--muted-foreground)]">
      {workDocuments ? <div className="flex items-center gap-3">
        <span>{t('memo.documentList.workDocumentsLoadFailed')}</span>
        <Button type="button" variant="ghost" size="sm" onClick={refresh}>{t('error.retry')}</Button>
      </div> : '不支持读取隐藏/系统文件夹'}
    </div>
      : (loading || (mediaLibrary && loadingLinkedItems)) && visibleItems.length === 0
      ? workDocuments ? <WorkDocumentsLoadingSkeleton showHeader={false} />
        : <div className="flex h-full min-h-[160px] items-center justify-center text-sm text-[var(--muted-foreground)]">正在整理文件列表…</div>
      : !loading && visibleItems.length === 0 && !(mediaLibrary && hasMore)
      ? <div className="flex h-full min-h-[160px] items-center justify-center text-sm text-[var(--muted-foreground)]">
            <div className="flex flex-col items-center text-center">
              {!mediaLibrary && <Inbox className="mb-3 h-10 w-10 opacity-50" strokeWidth={1.25} aria-hidden="true" />}
              {mediaLibrary && !hasMediaDataset && !hasLinkedMedia ? <div className="flex items-center gap-1">
                <span>未添加图片或视频，</span>
                <button type="button" disabled={libraryActionsDisabled || !onMediaLibraryFilterChange} onClick={filter.openMenu} className="inline-flex items-center gap-0.5 text-[var(--foreground)] hover:text-[var(--brand)] disabled:opacity-50">
                  选择数据<ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                {onAddMedia && <button type="button" disabled={libraryActionsDisabled || addingMedia} onClick={addMedia} className="inline-flex items-center gap-0.5 text-[var(--foreground)] hover:text-[var(--brand)] disabled:opacity-50">
                  添加<ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>}
              </div> : mediaLibrary && mediaLibraryFolderPath !== undefined ? <div className="flex items-center gap-1">
                <span>未添加图片或视频，</span>
                {onAddMedia && <button type="button" disabled={libraryActionsDisabled || addingMedia} onClick={addMedia} className="inline-flex items-center gap-0.5 text-[var(--foreground)] hover:text-[var(--brand)] disabled:opacity-50">
                  添加<ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>}
              </div> : workDocuments && filter.filterCount === 0 ? <div className="flex items-center gap-1">
                <span>{t('workDocuments.noDataSelected')}</span>
                <button type="button" disabled={libraryActionsDisabled || !onWorkDocumentsFilterChange} onClick={filter.openMenu} className="inline-flex items-center gap-0.5 text-[var(--foreground)] hover:text-[var(--brand)] disabled:opacity-50">
                  {t('workDocuments.selectData')}<ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div> : workDocuments ? <span>{t('memo.documentList.workDocumentsEmpty')}</span> : <span>列表内容为空</span>}
            </div>
          </div>
        : mediaLibrary && visibleItems.length === 0 && hasMore
          ? <div className="flex h-full min-h-[160px] items-center justify-center text-sm text-[var(--muted-foreground)]">{t('mediaLibrary.searchingMore')}</div>
        : mediaLibrary
          ? <div ref={mediaGridRef} className="flex w-full items-start pt-0" style={{ gap: MEDIA_COLUMN_GAP }}>{mediaColumns.map((column, columnIndex) => (
            <VirtualizedMediaColumn
              key={columnIndex}
              items={column}
              scrollerRef={viewportRef}
              scrollMargin={mediaGridScrollMargin}
              renderCard={(item) => (
                <DocumentCard
                  item={item}
                  notebookPath={listContext.notebookPath}
                  openItem={openItem}
                  mediaLibrary
                  observeMediaCard={observeMediaCard}
                  onRequestDelete={onDeleteMedia ? setMediaToDelete : undefined}
                  deleteLabel={t('media.fileTree.delete')}
                  deleteDisabled={libraryActionsDisabled || deletingMedia}
                />
              )}
            />
          ))}</div>
          : workDocuments
            ? <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(min(100%,200px),1fr))] items-stretch gap-3.5" style={{ paddingTop: workFirstRow * workRowStride, paddingBottom: Math.max(0, workRowCount - workLastRow) * workRowStride }}>{visibleWorkRows.map((item) => <WorkDocumentListRow key={item.fullPath} item={item} notebookPath={listContext.notebookPath} openItem={openItem} />)}</div>
            : <div style={{ paddingTop: firstRow * ROW_HEIGHT, paddingBottom: Math.max(0, rowCount - lastRow) * ROW_HEIGHT }}><div className="grid w-full grid-cols-[repeat(auto-fill,minmax(min(100%,200px),1fr))] items-stretch gap-3.5 pt-3">{visibleCards.map((item) => <DocumentCard key={item.fullPath} item={item} notebookPath={listContext.notebookPath} openItem={openItem} />)}</div></div>}
    {moreError && <button type="button" className="mt-4 rounded-lg px-2 py-1 text-sm text-[var(--brand)] hover:bg-[var(--muted)]" onClick={loadMore}>加载失败，点击重试</button>}
    {hasMore && !moreError && <div ref={endRef} className="h-1" aria-hidden="true" />}
  </>;
  return <section className={`flex min-h-0 flex-col bg-transparent text-[var(--foreground)] ${pageScroll ? '' : 'h-full'}`}>
    <CollectionAreaMenu items={areaMenuItems}>
    {pageScroll
      ? <div ref={listRef} className="flex min-w-0 flex-1 flex-col">{body}</div>
      : <OverlayScrollbar
          className="flex h-full min-h-0 min-w-0 flex-1"
          scrollerClassName={`h-full min-h-0 min-w-0 w-full flex-1 overflow-auto ${headerEmbedded ? 'px-0' : 'px-5'} pb-4`}
          scrollerRef={scrollRef}
        >{body}</OverlayScrollbar>}
    </CollectionAreaMenu>
    {mediaLibrary && <Dialog open={!!mediaToDelete} onOpenChange={(open) => { if (!open && !deletingMedia) setMediaToDelete(null); }}>
      <DialogContent className="max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('mediaLibrary.deleteImageTitle')}</DialogTitle>
          <DialogDescription>{t('mediaLibrary.deleteImageDescription', { name: mediaToDelete?.name ?? '' })}</DialogDescription>
        </DialogHeader>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" className="rounded-lg" disabled={deletingMedia} onClick={() => setMediaToDelete(null)}>{t('dialog.cancel')}</Button>
          <Button type="button" variant="outline" size="sm" disabled={deletingMedia} onClick={() => void confirmDeleteMedia()} className="rounded-lg border-[var(--destructive)] bg-[var(--destructive)] text-white hover:opacity-90">{t('dialog.delete')}</Button>
        </div>
      </DialogContent>
    </Dialog>}
    {!mediaLibrary && <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent className="max-w-sm"><DialogTitle>新建笔记</DialogTitle><form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void createNote(); }}><input autoFocus value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="笔记标题" className="h-9 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--brand)]" /><div className="flex justify-end gap-2"><Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={() => setCreateOpen(false)}>取消</Button><Button type="submit" size="sm" className="rounded-lg" disabled={!newTitle.trim() || creating}>创建</Button></div></form></DialogContent></Dialog>}
  </section>;
}
