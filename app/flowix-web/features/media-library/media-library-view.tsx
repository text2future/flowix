'use client';

import type { CollectionActionsHost } from '@shared/ui/collection-actions';

import { friendlyErrorMessage } from '@/lib/friendly-error-message';

import type { SurfaceLifecycle, SurfacePresentationUpdate } from '@features/workspace/public/surface-api';

import { resolveDatasetFilterForLocation } from '@features/collection/dataset-filter-location';
import { useCollectionDocumentSession, type CollectionDocumentCodec } from '@features/collection/public/collection-session-api';
import { reuseCollectionValue } from '@features/collection/content-equality';
import { FolderCollectionSwitchConfirmDialog, resolveCollectionScope, setCollectionAssetFilter, assetConditionFromFilter, assetKindsForUniverse, normalizeAssetFilterCondition, MEDIA_ASSET_KINDS, type AssetFilterCondition, type AssetFilterSaveOptions } from '@features/collection/public/folder-api';
import { collectionDisplayName, collectionSourceDomain } from '@features/collection/model';
import { collectionDisplayDescriptor } from '@/lib/collection-display-registry';
import { subscribe } from '@platform/tauri/event-bus';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { notebooks as notebookClient, type CollectionChangedEvent } from '@platform/tauri/client';
import { canonicalDirectoryPath, canonicalPath } from '@/lib/path';
import { useNoteStore } from '@features/memo/store/note-store';
import { useNotebookMediaMaintenanceStore } from '@features/memo/store/notebook-media-maintenance-store';
import { DocumentListView } from '@features/surface/document-list-view';
import type { DocumentListViewContext } from '@features/surface/document-list-view-model';
import { findFileDisplayPath, type FileDisplayIdentity } from '@/lib/file-display-registry';
import { displayTitleFromFilename } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { canEditMediaLibraryFilter, hasMediaDatasetFilter, mediaCollectionFilterForSave, mediaLibraryDefaultView, parseMediaLibrary, serializeMediaLibrary, type MediaLibraryDocument, type MediaLibraryKind } from './model';
import { renameMediaLibrary } from './rename-media-library';
import { useMediaLibraryActions } from './use-media-library-actions';
import { MediaLibraryLoadingSkeleton } from '@shared/ui/media-library-loading-skeleton';

/**
 * 图墙的集合文件格式：v2 单类型文件 或 hybrid（v3）文档里的 media 域。
 * 读写、身份校验、旧格式迁移、冲突处理都在会话里（`useCollectionDocumentSession`），
 * 这里只声明「这种文件长什么样」。
 */
const MEDIA_LIBRARY_CODEC: CollectionDocumentCodec<MediaLibraryDocument> = {
  parse: parseMediaLibrary,
  serialize: serializeMediaLibrary,
  collectionId: (document) => document.collection.id,
  revision: (document) => document.collection.revision,
  sourceDomain: (content) => collectionSourceDomain(content, 'media_library'),
  // v1/v2 旧格式补默认视图后就地升级（身份与修订号由会话校验）。
  migrate: (document) => serializeMediaLibrary(document),
  // 外部变更就地替换：未变的部分保留引用，图墙不因刷新丢掉滚动与选中。
  reuse: (current, next) => ({
    ...next,
    dataset: { ...next.dataset, records: reuseCollectionValue(current.dataset.records, next.dataset.records) },
    views: reuseCollectionValue(current.views, next.views),
  }),
};

export function MediaLibraryView({ onSurfaceLifecycleReady, reportPresentation, filePath, fileIdentity, notebookPath: rawNotebookPath, notebookId = null, expectedCollectionId, workspaceHost = 'main-third', editable = true, activeViewId, actionsHost, onOpenNoteFilter, onDatasetFilterOpenChange, pageScroll = false }: { onSurfaceLifecycleReady?: (lifecycle: SurfaceLifecycle | null) => void; reportPresentation?: (update: SurfacePresentationUpdate) => void; filePath: string; fileIdentity?: FileDisplayIdentity; notebookPath: string | null; notebookId?: string | null; expectedCollectionId?: string | null; workspaceHost?: 'main-third' | 'browser-column'; /** 集合外壳里的 tab 面板：只把操作区 portal 进 nav 右侧操作槽（见 DocumentListView）。 */ editable?: boolean; activeViewId?: string | null; actionsHost?: CollectionActionsHost; onOpenNoteFilter?: () => void; onDatasetFilterOpenChange?: (open: boolean) => void; pageScroll?: boolean }) {
  const { t } = useI18n();
  const notebookPath = rawNotebookPath ? canonicalDirectoryPath(rawNotebookPath) : null;
  const notebooks = useNoteStore((state) => state.notebooks);
  const notebook = notebooks.find((candidate) => canonicalDirectoryPath(candidate.path) === (notebookPath ?? ''));
  const resolvedNotebookId = notebookId ?? notebook?.id ?? null;
  const mediaMaintenance = useNotebookMediaMaintenanceStore((state) => resolvedNotebookId ? state.statuses[resolvedNotebookId] : undefined);
  const [retryingMaintenance, setRetryingMaintenance] = useState(false);
  const [confirmFolderSwitch, setConfirmFolderSwitch] = useState(false);
  const displayId = fileIdentity?.displayId;
  // 集合文件会话：读盘 / 迁移 / 身份校验 / 按域写回 / 冲突重放 / 保存闸 / 就地刷新。
  const session = useCollectionDocumentSession<MediaLibraryDocument>({
    filePath,
    fileIdentity,
    notebookPath: rawNotebookPath,
    notebookId,
    expectedCollectionId,
    editable,
    codec: MEDIA_LIBRARY_CODEC,
    loadErrorKey: 'errors.friendly.mediaLoad',
    saveErrorKey: 'errors.friendly.tableViewSave',
    missingScopeMessage: '无法确定媒体库所属的笔记本',
    missingFileMessage: '无法读取媒体库文件',
    // 路径可能被复用：按显示身份认集合，避免打开到「同名替代文件」。
    identityCollectionId: () => (displayId ? collectionDisplayDescriptor(displayId)?.collectionId ?? null : null),
  });
  const {
    document, setDocument, loading, error, retryLoad,
    saving, setSaving, saveInFlightRef, sourceContentRef,
    reportSaveFailure, flush, runSaveLocked, applyRename, persistMutation,
    currentFilePath, refreshContent, refreshError, retryRefresh, sessionKey,
  } = session;

  const retryMediaMaintenance = useCallback(async () => {
    if (!editable || !resolvedNotebookId || retryingMaintenance) return;
    setRetryingMaintenance(true);
    try {
      await notebookClient.retryMediaMaintenance(resolvedNotebookId);
    } catch (reason) {
      toast.error(friendlyErrorMessage(reason, t, 'errors.friendly.mediaMaintenance'));
    } finally {
      setRetryingMaintenance(false);
    }
  }, [resolvedNotebookId, retryingMaintenance, t, editable]);

  useEffect(() => {
    onSurfaceLifecycleReady?.({ status: 'ready', flush });
    return () => onSurfaceLifecycleReady?.(null);
  }, [flush, onSurfaceLifecycleReady]);

  useEffect(() => {
    const refresh = (event: Partial<CollectionChangedEvent> & Pick<CollectionChangedEvent, 'notebookId'>) => {
      const collectionId = document?.collection.id;
      if (event.notebookId !== (notebookId ?? notebook?.id) || !collectionId || !notebookPath) return;
      const root = canonicalDirectoryPath(notebookPath);
      let movedPath: string | null = null;
      if (event.directoryMove) {
        const previous = canonicalPath(`${root}/${event.directoryMove.previousRelativePath}`);
        const next = canonicalPath(`${root}/${event.directoryMove.relativePath}`);
        const current = canonicalPath(currentFilePath);
        if (current === previous || current.startsWith(`${previous}/`)) {
          movedPath = `${next}${current.slice(previous.length)}`;
        } else if (current === next || current.startsWith(`${next}/`)) {
          movedPath = current;
        }
      }
      if (event.collectionId && event.collectionId !== collectionId && !movedPath) return;
      const eventPath = event.relativePath
        ? `${root}/${event.relativePath}`
        : (displayId ? findFileDisplayPath(displayId) : null) ?? currentFilePath;
      refreshContent(movedPath ?? eventPath);
    };
    const stopCollection = subscribe<CollectionChangedEvent>('collection-changed', refresh);
    const stopCatalog = subscribe<{ notebookId: string; operationId?: string }>('file-management-changed', (event) => {
      if (!event.operationId) refresh(event);
    });
    return () => { stopCollection(); stopCatalog(); };
  }, [currentFilePath, displayId, document?.collection.id, notebook?.id, notebookId, notebookPath, refreshContent, sessionKey]);

  const updateFilterCondition = useCallback(async (fileCondition: AssetFilterCondition, options?: AssetFilterSaveOptions) => {
    if (!editable || saving || !notebookPath) return false;
    // 共享「资料筛选」：hybrid 集合里图墙 / 列表同一份配置，单次读改写同时双写两个数据域，
    // 两个面板经 collection-changed 事件各自刷新。
    if (collectionSourceDomain(sourceContentRef.current ?? '', 'media_library') !== null && currentFilePath) {
      try {
        await setCollectionAssetFilter(currentFilePath, notebookPath, normalizeAssetFilterCondition(fileCondition), options);
        return true;
      } catch (error) {
        toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableViewSave'));
        return false;
      }
    }
    if (document && !canEditMediaLibraryFilter(document)) {
      toast.error('当前媒体库包含编辑器不支持的筛选，未保存以保留原条件');
      return false;
    }
    // 独立媒体库文件：只落媒体类目子集。
    const mediaCondition = {
      ...normalizeAssetFilterCondition(fileCondition),
      file_types: assetKindsForUniverse(fileCondition, MEDIA_ASSET_KINDS) as MediaLibraryKind[],
    };
    return persistMutation((current) => ({
      ...current,
      collection: {
        ...current.collection,
        revision: current.collection.revision + 1,
        updated_at: new Date().toISOString(),
      },
      dataset: { ...current.dataset, filter: mediaCollectionFilterForSave(current, mediaCondition, currentFilePath, notebookPath) },
      views: { ...current.views, items: current.views.items.map((view) => view.id === (activeViewId ?? current.views.default_id)
        ? { ...view, filter: { all: [], any: [] } } : view) },
    }));
  }, [currentFilePath, document, notebookPath, persistMutation, saving, sourceContentRef, t, editable, activeViewId]);

  const renameLibrary = useCallback(async (rawTitle: string) => {
    const title = rawTitle.trim();
    const previousPath = canonicalPath(displayId ? findFileDisplayPath(displayId) ?? currentFilePath : currentFilePath);
    const isFolderCollection = document?.collection.placement === 'folder';
    const currentTitle = isFolderCollection
      ? previousPath.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '').split(/[\\/]/).pop() ?? ''
      : displayTitleFromFilename(previousPath);
    if (!editable || !title || title === currentTitle || saving || !notebookPath || !document || saveInFlightRef.current) return;
    if (/[\\/]/.test(title)) {
      toast.error('文件名不能包含路径分隔符');
      return;
    }
    await runSaveLocked(async () => {
      try {
        const result = await renameMediaLibrary({
          notebookPath, notebookId: notebookId ?? notebook?.id,
          collectionId: document.collection.id, title,
        });
        if (!applyRename(result)) { reportSaveFailure(); return false; }
        if (result.errorCode) { console.warn('Collection follow-up failed', result.errorCode); toast.error(t('errors.friendly.collectionPartial')); }
        return true;
      } catch (reason) {
        reportSaveFailure();
        toast.error(friendlyErrorMessage(reason, t, 'errors.friendly.mediaRename'));
        return false;
      }
    });
  }, [applyRename, currentFilePath, displayId, document, notebook?.id, notebookId, notebookPath, reportSaveFailure, runSaveLocked, saveInFlightRef, saving, t, editable]);

  const { addMedia, deleteMedia } = useMediaLibraryActions({
    document, setDocument, notebookPath, notebookId: notebookId ?? notebook?.id ?? null, currentFilePath, saving, editable, setSaving,
    sourceContentRef, saveInFlightRef, persistMutation, reportSaveFailure, t,
  });

  /**
   * 共享「资料筛选」：图墙 / 列表同一份配置。媒体库面板的类目固定为**图片与视频**，
   * 从共享条件里取自己的子集（空子集 = 本面板无内容）；空共享条件 = 全类目。
   */
  const browseCondition = useMemo(() => (document ? assetConditionFromFilter(document.dataset.filter) : {}), [document]);
  const resourceKinds = useMemo(
    () => assetKindsForUniverse(browseCondition, MEDIA_ASSET_KINDS),
    [browseCondition],
  );
  const activeCollectionId = document?.collection.id;
  const libraryDisplayName = document ? collectionDisplayName(currentFilePath, document.collection.placement) : '媒体库';
  useEffect(() => {
    if (!reportPresentation) return;
    if (loading) {
      reportPresentation({ title: libraryDisplayName, state: {
        status: 'loading', loadingMode: 'blocking', retainContent: true,
      } });
    } else if (error) {
      reportPresentation({ title: libraryDisplayName, state: {
        status: 'error',
        message: { key: 'errors.friendly.mediaLoad' },
        actions: [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: retryLoad }],
      } });
    } else if (document) {
      reportPresentation({ title: libraryDisplayName, state: { status: 'ready' } });
    } else {
      reportPresentation({ title: libraryDisplayName, state: {
        status: 'unavailable', reason: 'missing', message: { key: 'mediaLibrary.unavailable' },
        actions: [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: retryLoad }],
      } });
    }
  }, [document, error, libraryDisplayName, loading, reportPresentation, retryLoad]);
  const datasetSource = document?.dataset.source;
  const mediaScope = useMemo(() => {
    if (!notebookPath) return undefined;
    // 取值范围换算只有一份（`resolveCollectionScope`）：图片导览等也要按它取内容。
    return resolveCollectionScope(datasetSource, currentFilePath, notebookPath);
  }, [currentFilePath, datasetSource, notebookPath]);
  const mediaLibraryRecords = useMemo(() => {
    const records = document?.dataset.records.include ?? [];
    if (!mediaScope) return records;
    const base = mediaScope.relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    return records.filter((record) => {
      const path = record.relative_path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!base) return mediaScope.depth === 'descendants' || !path.includes('/');
      if (!path.startsWith(`${base}/`)) return false;
      return mediaScope.depth === 'descendants' || !path.slice(base.length + 1).includes('/');
    });
  }, [document?.dataset.records.include, mediaScope]);
  const mediaLibraryExcludedPaths = useMemo(() => (document?.dataset.records.exclude ?? [])
    .map((record) => record.relative_path)
    .filter((path): path is string => typeof path === 'string'), [document?.dataset.records.exclude]);
  const listContext: DocumentListViewContext | null = useMemo(() => {
    const resolvedNotebookId = notebookId ?? notebook?.id;
    if (!resolvedNotebookId || !notebookPath || !activeCollectionId) return null;
    const libraryIdentity = `media-library:${resolvedNotebookId}:${activeCollectionId}`;
    return {
      displayId: displayId ?? libraryIdentity,
      folderPath: notebookPath,
      notebookPath,
      notebookId: resolvedNotebookId,
      filters: { resourceKinds },
      ...(mediaScope ? { mediaScope } : {}),
      ...((mediaScope || hasMediaDatasetFilter(document?.dataset.filter)
        || browseCondition.path_scope === 'all' || browseCondition.path_contains
        || browseCondition.file_name_contains || browseCondition.file_types)
        ? { mediaDatasetActive: true } : {}),
    };
  }, [activeCollectionId, browseCondition, displayId, document, mediaScope, notebook?.id, notebookId, notebookPath, resourceKinds]);

  if (loading) return reportPresentation ? <MediaLibraryLoadingSkeleton /> : <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">正在打开媒体库…</div>;
  if (error) return reportPresentation ? null : <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--destructive)]">{error}</div>;
  if (!document && reportPresentation) return null;
  if (!document || !listContext) return <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">媒体库不可用</div>;

  return <div className={`relative ${pageScroll ? '' : 'h-full min-h-0'}`}>
    {saving && <span className="pointer-events-none absolute right-5 top-4 z-10 text-[11px] text-[var(--muted-foreground)]">保存中…</span>}
    {refreshError && <div role="alert" className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-lg border border-[var(--destructive)]/30 bg-[var(--destructive)]/5 px-3 py-2 text-xs text-[var(--foreground)]">
      <span className="min-w-0 truncate">{t('errors.friendly.mediaRefresh')}</span>
      <button type="button" onClick={retryRefresh} className="shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs hover:bg-[var(--hover-bg)]">
        {t('error.retry')}
      </button>
    </div>}
    {mediaMaintenance?.state === 'failed' && <div role="alert" className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-lg border border-[var(--destructive)]/30 bg-[var(--destructive)]/5 px-3 py-2 text-xs text-[var(--foreground)]">
      <span className="min-w-0 truncate">{mediaMaintenance.message || t('mediaLibrary.maintenanceFailed')}</span>
      <button type="button" disabled={!editable || retryingMaintenance} onClick={() => void retryMediaMaintenance()} className="shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs hover:bg-[var(--hover-bg)] disabled:opacity-50">
        {retryingMaintenance ? t('mediaLibrary.maintenanceRunning') : t('error.retry')}
      </button>
    </div>}
    {(mediaMaintenance?.state === 'queued' || mediaMaintenance?.state === 'running') && <div role="status" className="mx-4 mt-3 rounded-lg bg-[var(--muted)] px-3 py-2 text-xs text-[var(--muted-foreground)]">
      {mediaMaintenance.state === 'queued' ? t('mediaLibrary.maintenanceQueued') : t('mediaLibrary.maintenanceRunning')}
    </div>}
    <DocumentListView
      key={listContext.displayId}
      listContext={listContext}
      workspaceHost={workspaceHost}
      mediaLibrary
      libraryName={libraryDisplayName}
      libraryFilePath={currentFilePath}
      mediaLibraryFolderPath={document.collection.placement === 'folder'
        ? mediaScope?.relativePath || notebook?.name || ''
        : undefined}
      mediaLibraryFilter={browseCondition}
      mediaLibraryRecords={mediaLibraryRecords}
      mediaLibraryExcludedPaths={mediaLibraryExcludedPaths}
      mediaLibraryDatasetFilter={resolveDatasetFilterForLocation(document.dataset.filter, document.collection.placement, currentFilePath, notebookPath)}
      mediaLibraryViewFilter={(document.views.items.find((view) => view.id === activeViewId) ?? mediaLibraryDefaultView(document)).filter}
      onAddMedia={addMedia}
      onDeleteMedia={deleteMedia}
      libraryActionsDisabled={saving || !editable}
      refreshPaused={saving}
      onMediaLibraryFilterChange={updateFilterCondition}
      onOpenNoteFilter={onOpenNoteFilter}
      onDatasetFilterOpenChange={onDatasetFilterOpenChange}
      onRenameLibrary={renameLibrary}
      onSwitchToTable={document.collection.placement === 'folder' ? () => setConfirmFolderSwitch(true) : undefined}
      actionsHost={actionsHost}
      pageScroll={pageScroll}
    />
    <FolderCollectionSwitchConfirmDialog open={confirmFolderSwitch} onOpenChange={setConfirmFolderSwitch} confirmDisabled={saving} onConfirm={() => {
      setConfirmFolderSwitch(false);
      const resolvedNotebookId = notebookId ?? notebook?.id;
      if (!notebookPath || !resolvedNotebookId) return;
      window.dispatchEvent(new CustomEvent('flowix:request-switch-folder-collection-type', {
        detail: { filePath: currentFilePath, notebookPath, notebookId: resolvedNotebookId, type: 'table' },
      }));
    }} />
  </div>;
}
