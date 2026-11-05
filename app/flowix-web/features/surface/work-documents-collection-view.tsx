'use client';

import type { CollectionActionsHost } from '@shared/ui/collection-actions';

import { canonicalDirectoryPath, canonicalPath, parentDirectoryPath } from '@/lib/path';
import { dialogs, files } from '@platform/tauri/client';
import { useNoteStore } from '@features/memo/store/note-store';
import { subscribe } from '@platform/tauri/event-bus';
import type { CollectionChangedEvent } from '@platform/tauri/client';
import { collectionDisplayName, collectionSourceDomain } from '@features/collection/model';
import { useCollectionDocumentSession, type CollectionDocumentCodec } from '@features/collection/public/collection-session-api';
import { assetConditionFromFilter, assetKindsForUniverse, normalizeAssetFilterCondition, resolveCollectionSaveDirectory, resolveCollectionLocationScope, setCollectionAssetFilter, WORK_ASSET_KINDS, type AssetFilterCondition, type AssetFilterSaveOptions } from '@features/collection/public/folder-api';
import { isSameCollectionFile, subscribeCollectionContent } from '@features/collection/public/content-events-api';
import { renameCollectionAtPath } from '@features/collection/mutations';
import { DocumentListView } from './document-list-view';
import type { DocumentListViewContext } from './document-list-view-model';
import type { FileDisplayIdentity } from '@/lib/file-display-registry';
import { toast } from '@/lib/toast';
import type { SurfaceLifecycle, SurfacePresentationUpdate } from '@features/workspace/public/surface-api';
import { WorkDocumentsLoadingSkeleton } from '@shared/ui/work-documents-loading-skeleton';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  canEditWorkDocumentsFilter,
  normalizeWorkDocumentsCondition,
  parseWorkDocumentsCollection,
  serializeWorkDocumentsCollection,
  workDocumentsFilterFromCondition,
  type WorkDocumentsDocument,
  type WorkDocumentsKind,
} from '@features/work-documents/model';

/**
 * 列表的集合文件格式：v2 单类型文件 或 hybrid（v3）文档里的 work_documents 域。
 * 没有 `migrate` —— work_documents 是 hybrid 才引入的域，不存在 v1/v2 旧格式要升级。
 */
const WORK_DOCUMENTS_CODEC: CollectionDocumentCodec<WorkDocumentsDocument> = {
  parse: parseWorkDocumentsCollection,
  serialize: serializeWorkDocumentsCollection,
  collectionId: (document) => document.collection.id,
  revision: (document) => document.collection.revision,
  sourceDomain: (content) => collectionSourceDomain(content, 'work_documents'),
};

export function WorkDocumentsCollectionView({ onSurfaceLifecycleReady, reportPresentation, filePath, fileIdentity, notebookPath: rawNotebookPath, notebookId = null, expectedCollectionId, workspaceHost = 'column-1', editable = true, activeViewId, actionsHost, onOpenNoteFilter, onDatasetFilterOpenChange, pageScroll = false }: {
  onSurfaceLifecycleReady?: (lifecycle: SurfaceLifecycle | null) => void;
  reportPresentation?: (update: SurfacePresentationUpdate) => void;
  filePath: string;
  fileIdentity?: FileDisplayIdentity;
  notebookPath: string | null;
  notebookId?: string | null;
  expectedCollectionId?: string | null;
  workspaceHost?: 'column-1' | 'column-2';
  /** 集合外壳里的 tab 面板：只把操作区 portal 进 nav 右侧操作槽（见 DocumentListView）。 */
  actionsHost?: CollectionActionsHost;
  onOpenNoteFilter?: () => void;
  onDatasetFilterOpenChange?: (open: boolean) => void;
  editable?: boolean;
  activeViewId?: string | null;
  /** 整页滚动（集合外壳）：列表自然撑开，滚动交给外壳的页面滚动容器。 */
  pageScroll?: boolean;
}) {
  const notebookPath = rawNotebookPath ? canonicalDirectoryPath(rawNotebookPath) : null;
  const notebooks = useNoteStore((state) => state.notebooks);
  const notebook = notebooks.find((candidate) => canonicalDirectoryPath(candidate.path) === (notebookPath ?? ''));
  const resolvedNotebookId = notebookId ?? notebook?.id ?? null;
  const [listLoading, setListLoading] = useState(true);
  const session = useCollectionDocumentSession<WorkDocumentsDocument>({
    filePath,
    fileIdentity,
    notebookPath: rawNotebookPath,
    notebookId,
    expectedCollectionId,
    editable,
    codec: WORK_DOCUMENTS_CODEC,
    loadErrorKey: 'collection.load.workDocuments',
    saveErrorKey: 'errors.friendly.tableViewSave',
    missingScopeMessage: '无法确定列表所属的笔记本',
    missingFileMessage: '无法读取列表集合文件',
  });
  const {
    document, loading, error, retryLoad, saving, saveInFlightRef,
    reportSaveFailure, flush, runSaveLocked, applyRename, persistMutation,
    currentFilePath, sourceContentRef, refreshContent, displayId,
  } = session;

  useEffect(() => {
    onSurfaceLifecycleReady?.({ status: 'ready', flush });
    return () => onSurfaceLifecycleReady?.(null);
  }, [flush, onSurfaceLifecycleReady]);

  useEffect(() => {
    const refresh = (event: Partial<CollectionChangedEvent> & Pick<CollectionChangedEvent, 'notebookId'>) => {
      if (event.notebookId !== resolvedNotebookId) return;
      const collectionId = document?.collection.id;
      if (event.collectionId && collectionId && event.collectionId !== collectionId) return;
      if (event.relativePath) {
        const root = canonicalDirectoryPath(notebookPath ?? '').replace(/\/$/, '');
        const changedPath = canonicalPath(`${root}/${event.relativePath}`);
        if (changedPath !== canonicalPath(currentFilePath) && event.collectionId) return;
      }
      // 就地重读集合文件：不整页重挂，列表的滚动与已加载页都保留。
      refreshContent(currentFilePath);
    };
    const stopCollection = subscribe<CollectionChangedEvent>('collection-changed', refresh);
    // 本进程内的写入经集合网关广播内容（tab 条增删视图、共享资料筛选、表格保存…）。
    const stopContent = subscribeCollectionContent((change) => {
      if (!isSameCollectionFile(change.indexPath, currentFilePath)) return;
      refreshContent(change.indexPath);
    });
    const stopCatalog = subscribe<{ notebookId: string; operationId?: string; resourceKinds?: string[] }>('file-management-changed', (event) => {
      if (event.notebookId === resolvedNotebookId && !event.operationId && event.resourceKinds === undefined) {
        refreshContent(currentFilePath);
      }
    });
    return () => { stopCollection(); stopContent(); stopCatalog(); };
  }, [currentFilePath, document?.collection.id, notebookPath, refreshContent, resolvedNotebookId]);

  const updateFilterCondition = useCallback(async (condition: AssetFilterCondition, options?: AssetFilterSaveOptions) => {
    if (!editable || saving) return false;
    // 共享「资料筛选」：hybrid 集合里列表 / 图墙同一份配置，单次读改写同时双写两个数据域。
    if (document && notebookPath
      && collectionSourceDomain(sourceContentRef.current ?? '', 'work_documents') !== null) {
      try {
        await setCollectionAssetFilter(currentFilePath, notebookPath, normalizeAssetFilterCondition(condition), options);
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '保存资料筛选失败');
        return false;
      }
    }
    const normalized = normalizeWorkDocumentsCondition({
      ...condition,
      file_types: assetKindsForUniverse(condition, WORK_ASSET_KINDS) as WorkDocumentsKind[],
    });
    const filter = workDocumentsFilterFromCondition(normalized);
    return persistMutation((current) => {
      if (!canEditWorkDocumentsFilter(current.dataset.filter)) {
        throw new Error('当前列表集合包含筛选面板无法完整编辑的条件，已取消保存以保留原条件');
      }
      return {
        ...current,
        collection: { ...current.collection, revision: current.collection.revision + 1, updated_at: new Date().toISOString() },
        dataset: { ...current.dataset, filter },
      };
    });
  }, [currentFilePath, document, notebookPath, persistMutation, saving, sourceContentRef, editable]);

  const renameCollection = useCallback(async (rawTitle: string) => {
    const title = rawTitle.trim();
    if (!editable || !title || saving || !notebookPath || !document || !resolvedNotebookId || saveInFlightRef.current) return;
    if (/[\\/]/.test(title)) { toast.error('文件名不能包含路径分隔符'); return; }
    await runSaveLocked(async () => {
      try {
        const result = await renameCollectionAtPath(currentFilePath, notebookPath, title, resolvedNotebookId, document.collection.id);
        if (!applyRename(result)) { reportSaveFailure(); return false; }
        return true;
      } catch (reason) {
        reportSaveFailure();
        toast.error(reason instanceof Error ? reason.message : '重命名列表集合失败');
        return false;
      }
    });
  }, [applyRename, currentFilePath, document, notebookPath, reportSaveFailure, resolvedNotebookId, runSaveLocked, saveInFlightRef, saving, editable]);

  /**
   * 列表 tab 的「导入文件…」── 把外部文件复制到集合的保存目录。
   * 落点走唯一的 `resolveCollectionSaveDirectory`（与新建笔记 / 媒体库添加同一口径），
   * 保证导入的文件落在集合的数据范围内，否则列表里根本看不到。
   */
  const importFiles = useCallback(async (): Promise<boolean> => {
    if (!editable || !notebookPath || !document || !resolvedNotebookId || saving || saveInFlightRef.current) return false;
    const selected = await dialogs.selectFiles({ multiple: true });
    if (!selected?.length) return false;
    let directory: string;
    try {
      directory = resolveCollectionSaveDirectory({
        filePath: currentFilePath,
        notebookPath,
        placement: document.collection.placement,
        source: document.dataset.source,
        filter: document.dataset.filter,
        defaultDirectory: parentDirectoryPath(currentFilePath, notebookPath),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '集合保存目录无效');
      return false;
    }
    let imported = 0;
    let failed = 0;
    for (const sourcePath of selected) {
      try {
        await files.importFile(sourcePath, directory, notebookPath);
        imported += 1;
      } catch (error) {
        failed += 1;
        console.warn('[work-documents] importing file failed', error);
      }
    }
    if (failed) toast.error(`${failed} 个文件导入失败`);
    return imported > 0;
  }, [currentFilePath, document, editable, notebookPath, resolvedNotebookId, saveInFlightRef, saving]);

  const collectionId = document?.collection.id;
  const collectionName = document ? collectionDisplayName(currentFilePath, document.collection.placement) : '工作文档';
  /**
   * 共享「资料筛选」：列表 / 图墙同一份配置。列表面板的类目为 6 种文档类，
   * 从共享条件里取自己的子集（空子集 = 本面板无内容）；空共享条件 = 全类目。
   */
  const scope = useMemo(() => document
    ? resolveCollectionLocationScope(document, currentFilePath, notebookPath) : undefined,
  [currentFilePath, document, notebookPath]);
  const condition = useMemo(() => ({
    ...assetConditionFromFilter(document?.dataset.filter),
    // Location belongs to the collection, independently of secondary filter syntax.
    path_contains: scope?.relativePath || undefined,
    path_scope: scope?.relativePath === '' ? 'all' as const : undefined,
  }), [document?.dataset.filter, scope]);
  const workKinds = useMemo(() => assetKindsForUniverse(condition, WORK_ASSET_KINDS), [condition]);
  const fixedFolderPath = document?.collection.placement === 'folder' ? scope?.relativePath : undefined;
  const listContext: DocumentListViewContext | null = useMemo(() => {
    if (!resolvedNotebookId || !notebookPath || !collectionId) return null;
    return {
      displayId: displayId ?? `work-documents:${resolvedNotebookId}:${collectionId}`,
      folderPath: notebookPath,
      notebookPath,
      notebookId: resolvedNotebookId,
      filters: {},
      workDocumentsFilter: { ...condition, file_types: workKinds },
    };
  }, [collectionId, condition, displayId, notebookPath, resolvedNotebookId, workKinds]);

  useEffect(() => {
    if (!reportPresentation) return;
    const hasDataSelection = Object.values(condition).some(Boolean);
    if (loading || (!error && document && listContext && hasDataSelection && listLoading)) reportPresentation({ title: collectionName, state: { status: 'loading', loadingMode: 'blocking', retainContent: true } });
    else if (error) reportPresentation({ title: collectionName, state: { status: 'error', message: { key: 'error.unexpected', fallbackText: error }, actions: [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: retryLoad }] } });
    else if (document && listContext) reportPresentation({ title: collectionName, state: { status: 'ready' } });
    else reportPresentation({ title: collectionName, state: { status: 'unavailable', reason: 'missing', message: { key: 'workDocuments.unavailable' }, actions: [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: retryLoad }] } });
  }, [collectionName, condition, document, error, listContext, listLoading, loading, reportPresentation, retryLoad]);

  if (loading) return reportPresentation ? <WorkDocumentsLoadingSkeleton /> : <div className="flex h-full min-h-0 items-center justify-center text-sm text-[var(--muted-foreground)]">正在打开工作文档集合…</div>;
  if (error) return reportPresentation ? null : <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--destructive)]">{error}</div>;
  if (!document || !listContext) return reportPresentation ? null : <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">工作文档集合不可用</div>;

  return <div className={`relative ${pageScroll ? '' : 'h-full min-h-0'}`}>
    {saving && <span className="pointer-events-none absolute right-5 top-4 z-10 text-[11px] text-[var(--muted-foreground)]">保存中…</span>}
    <DocumentListView
      key={listContext.displayId}
      listContext={listContext}
      workspaceHost={workspaceHost}
      workDocuments
      libraryName={collectionName}
      libraryFilePath={currentFilePath}
      workDocumentsFilter={condition}
      assetViewFilter={(document.views.items.find((view) => view.id === activeViewId) ?? document.views.items.find((view) => view.id === document.views.default_id))?.filter}
      workDocumentsFolderPath={fixedFolderPath}
      onLoadingChange={setListLoading}
      onWorkDocumentsFilterChange={updateFilterCondition}
      onOpenNoteFilter={onOpenNoteFilter}
      onDatasetFilterOpenChange={onDatasetFilterOpenChange}
      onRenameLibrary={renameCollection}
      onImportFiles={importFiles}
      libraryActionsDisabled={saving || !editable}
      refreshPaused={saving}
      actionsHost={actionsHost}
      pageScroll={pageScroll}
    />
  </div>;
}
