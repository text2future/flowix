import { useCallback, useEffect, useRef, useState } from 'react';
import { files, mediaResources, type DocumentPage, type DocumentPageItem, type FileBrowserDirectoriesChangedEvent, type MediaResourcePage } from '@platform/tauri/client';
import { subscribe } from '@platform/tauri/event-bus';
import { canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { createLogger } from '@/lib/logger';
import type { MediaLibraryRecord } from '@features/media-library/model';
import { workDocumentsResourceKindsChanged } from '@features/work-documents/model';
import type { DocumentListViewContext } from './document-list-view-model';

const logger = createLogger('document-list-data');
const MEDIA_LIBRARY_PAGE_SIZE = 30;

async function loadLinkedMediaItems(
  records: MediaLibraryRecord[],
  notebookPath: string,
  onBatch: (items: DocumentPageItem[]) => void,
  shouldStop: () => boolean,
): Promise<void> {
  // Keep record resolution bounded when a library links many local attachments.
  for (let offset = 0; offset < records.length; offset += 8) {
    if (shouldStop()) return;
    const batch = records.slice(offset, offset + 8);
    const resolved = await Promise.all(batch.map(async (record) => {
      const filePath = joinNotebookMemoPath(notebookPath, record.relative_path);
      if (!filePath) return null;
      try {
        const { resource } = await mediaResources.get(filePath, notebookPath);
        return mediaResourceListItem(resource, notebookPath);
      } catch { return null; }
    }));
    const items = resolved.filter((item): item is DocumentPageItem => item !== null);
    if (shouldStop()) return;
    if (items.length) onBatch(items);
  }
}

function mediaResourceListItem(resource: { relativePath: string; kind: 'image' | 'video'; sizeBytes: number; modifiedMs: number; createdAt: number }, notebookPath: string): DocumentPageItem | null {
  const fullPath = joinNotebookMemoPath(notebookPath, resource.relativePath);
  if (!fullPath) return null;
  return {
    fullPath,
    name: resource.relativePath.split(/[\\/]/).filter(Boolean).pop() ?? resource.relativePath,
    resourceKind: resource.kind,
    sizeBytes: resource.sizeBytes,
    modifiedMs: resource.modifiedMs,
    createdMs: resource.createdAt,
  };
}

/** Owns paging, cancellation and coalesced refreshes; UI action permissions are separate. */
export function useDocumentListData({ listContext, mediaLibrary, workDocuments = false, mediaLibraryRecords, refreshPaused }: {
  listContext: DocumentListViewContext;
  mediaLibrary: boolean;
  workDocuments?: boolean;
  mediaLibraryRecords: MediaLibraryRecord[];
  refreshPaused: boolean;
}) {
  const resourceKindsKey = (listContext.filters.resourceKinds ?? []).join('\u0000');
  const hasMediaDataset = Boolean(listContext.mediaScope || listContext.mediaDatasetActive);
  const hasWorkDocumentsDataset = Boolean(listContext.workDocumentsFilter
    && Object.values(listContext.workDocumentsFilter).some((value) => Boolean(value)));
  const hasLinkedMedia = mediaLibraryRecords.length > 0;
  const [items, setItems] = useState<DocumentPageItem[]>([]);
  const [linkedItems, setLinkedItems] = useState<DocumentPageItem[]>([]);
  const [folders, setFolders] = useState<DocumentPageItem[]>([]);
  const [loading, setLoading] = useState(() => !workDocuments || hasWorkDocumentsDataset);
  const [loadingLinkedItems, setLoadingLinkedItems] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const loadingRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const loadedListIdentityRef = useRef<string | null>(null);
  const refreshPausedRef = useRef(false);
  refreshPausedRef.current = refreshPaused;
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const requestRefresh = useCallback(() => {
    if (loadingRef.current || refreshPausedRef.current) {
      pendingRefreshRef.current = true;
      return;
    }
    setRevision((value) => value + 1);
  }, []);
  useEffect(() => subscribe<{ notebookId: string; resourceKinds?: string[] }>('file-management-changed', ({ notebookId, resourceKinds }) => {
    if (notebookId !== listContext.notebookId) return;
    if (workDocuments && !workDocumentsResourceKindsChanged(resourceKinds)) return;
    if (mediaLibrary && resourceKinds && !resourceKinds.some((kind) => kind === 'image' || kind === 'video')) return;
    requestRefresh();
  }), [requestRefresh, listContext.notebookId, mediaLibrary, workDocuments]);
  useEffect(() => subscribe<{ notebookId: string }>('media-properties-changed', ({ notebookId }) => {
    if (!workDocuments && notebookId === listContext.notebookId) requestRefresh();
  }), [requestRefresh, listContext.notebookId, workDocuments]);
  useEffect(() => subscribe<FileBrowserDirectoriesChangedEvent>(
    'file-browser-directories-changed',
    (event) => {
      if (canonicalPath(event.rootPath) !== canonicalPath(listContext.notebookPath)) return;
      const changedPaths = event.paths ?? [];
      // Library-config mutations update the catalog separately, but do not change the media rows shown here.
      if (mediaLibrary && changedPaths.length > 0 && changedPaths.every((path) => /\.lib\.ya?ml$/i.test(path))) return;
      const root = canonicalPath(listContext.notebookPath).replace(/\/$/, '');
      const directories = event.directories.filter((directory) => {
        const path = canonicalPath(directory);
        if (path === root) return true;
        return path.startsWith(`${root}/`);
      });
      if (directories.length === 0) return;
      requestRefresh();
    },
  ), [mediaLibrary, requestRefresh, listContext.notebookPath]);
  useEffect(() => {
    if (refreshPaused) {
      loadingRef.current = false;
      pendingRefreshRef.current = true;
      return;
    }
    pendingRefreshRef.current = false;
    const generation = ++requestGenerationRef.current;
    let cancelled = false;
    if (!listContext.notebookId) {
      loadingRef.current = false;
      setItems([]);
      setError(true);
      setLoading(false);
      setLoadingLinkedItems(false);
      return;
    }
    if (mediaLibrary && !hasMediaDataset && !hasLinkedMedia) {
      loadingRef.current = false;
      setLoading(false);
      setLoadingMore(false);
      setMoreError(false);
      setError(false);
      setItems([]);
      setLinkedItems([]);
      setLoadingLinkedItems(false);
      setFolders([]);
      setHasMore(false);
      setNextCursor(null);
      return () => { cancelled = true; requestGenerationRef.current += 1; };
    }
    loadingRef.current = true;
    setLoading(true);
    setLoadingLinkedItems(mediaLibrary && hasLinkedMedia);
    setLoadingMore(false);
    setMoreError(false);
    setError(false);
    // 共享资料筛选的空子集：该面板类目内没有可展示的类型 → 查询直接给空页
    // （Rust 侧 kinds 为空数组=不过滤，语义不同，必须在前端拦截；显式记录仍正常加载）。
    const mediaKindsEmpty = mediaLibrary && (listContext.filters.resourceKinds?.length === 0);
    const workKindsEmpty = workDocuments && (listContext.workDocumentsFilter?.file_types?.length === 0);
    const emptyMediaPage = { resources: [], nextCursor: null, hasMore: false } satisfies MediaResourcePage;
    const emptyDocumentPage = { folders: [], nextCursor: null, hasMore: false, items: [] } satisfies DocumentPage;
    if (workDocuments && !hasWorkDocumentsDataset) {
      loadingRef.current = false;
      setLoading(false);
      setLoadingMore(false);
      setMoreError(false);
      setError(false);
      setItems([]);
      setLinkedItems([]);
      setLoadingLinkedItems(false);
      setFolders([]);
      setHasMore(false);
      setNextCursor(null);
      return () => { cancelled = true; requestGenerationRef.current += 1; };
    }
    loadingRef.current = true;
    setLoading(true);
    setLoadingLinkedItems(mediaLibrary && hasLinkedMedia);
    setLoadingMore(false);
    setMoreError(false);
    setError(false);
    const listIdentity = JSON.stringify([listContext.displayId, listContext.notebookPath, mediaLibrary, workDocuments]);
    if (loadedListIdentityRef.current !== listIdentity) {
      setItems([]);
      setLinkedItems([]);
      setFolders([]);
    }
    loadedListIdentityRef.current = listIdentity;
    setHasMore(false);
    setNextCursor(null);
    const pageRequest = workDocuments
      ? (workKindsEmpty
        ? Promise.resolve(emptyDocumentPage)
        : files.listWorkDocumentsPage(listContext.notebookId, null, MEDIA_LIBRARY_PAGE_SIZE, {
          fileNameContains: listContext.workDocumentsFilter?.file_name_contains,
          resourceKinds: listContext.workDocumentsFilter?.file_types,
          path: listContext.workDocumentsFilter?.path_scope === 'all' ? '' : listContext.workDocumentsFilter?.path_contains,
        }))
      : mediaLibrary
      ? hasMediaDataset
        ? (mediaKindsEmpty
          ? Promise.resolve(emptyMediaPage)
          : mediaResources.listPage(listContext.notebookPath, (listContext.filters.resourceKinds ?? ['image', 'video']).filter((kind): kind is 'image' | 'video' => kind === 'image' || kind === 'video'), null, MEDIA_LIBRARY_PAGE_SIZE, listContext.mediaScope?.relativePath ?? null, listContext.mediaScope?.depth))
        : Promise.resolve(emptyMediaPage)
      : files.listDocumentPage({ notebookId: listContext.notebookId, folderPath: listContext.folderPath, resourceKinds: listContext.filters.resourceKinds });
    const nextLinkedItems: DocumentPageItem[] = [];
    const linkedRequest = mediaLibrary
      ? loadLinkedMediaItems(mediaLibraryRecords, listContext.notebookPath, (batch) => {
        if (cancelled || generation !== requestGenerationRef.current) return;
        nextLinkedItems.push(...batch);
        setLinkedItems([...nextLinkedItems]);
        // Libraries that only contain explicit records can render as soon as
        // their first bounded batch resolves, while later batches continue.
        if (!hasMediaDataset) setLoading(false);
      }, () => cancelled || generation !== requestGenerationRef.current)
      : Promise.resolve();
    const pageTask = pageRequest.then((page) => {
      if (cancelled || generation !== requestGenerationRef.current) return;
      if (mediaLibrary) {
        const mediaPage = page as MediaResourcePage;
        setItems(mediaPage.resources.map((resource) => mediaResourceListItem(resource, listContext.notebookPath)).filter((item): item is DocumentPageItem => item !== null));
        setFolders([]);
        setNextCursor(mediaPage.nextCursor);
        setHasMore(mediaPage.hasMore);
        // Show the independently loaded resource page without waiting for all
        // explicit record paths to resolve.
        if (hasMediaDataset) setLoading(false);
      } else {
        const documentPage = page as DocumentPage;
        setItems(documentPage.items);
        setFolders(workDocuments ? [] : documentPage.folders);
        setNextCursor(documentPage.nextCursor);
        setHasMore(documentPage.hasMore);
        setLoading(false);
      }
    }).catch((error) => {
      logger.warn('loading document page failed', { error });
      if (!cancelled && generation === requestGenerationRef.current) setError(true);
    });
    const linkedTask = linkedRequest.catch((error) => {
      logger.warn('loading linked media records failed', { error });
    }).then(() => {
      if (!cancelled && generation === requestGenerationRef.current) {
        setLinkedItems([...nextLinkedItems]);
        setLoadingLinkedItems(false);
        if (mediaLibrary && !hasMediaDataset) setLoading(false);
      }
    });
    void Promise.all([pageTask, linkedTask]).finally(() => {
      if (!cancelled && generation === requestGenerationRef.current) {
        loadingRef.current = false;
        setLoading(false);
        if (pendingRefreshRef.current) {
          pendingRefreshRef.current = false;
          setRevision((value) => value + 1);
        }
      }
    });
    return () => { cancelled = true; requestGenerationRef.current += 1; };
  }, [hasMediaDataset, hasLinkedMedia, hasWorkDocumentsDataset, refreshPaused, mediaLibrary, workDocuments, mediaLibraryRecords, revision, listContext.displayId, listContext.folderPath, listContext.mediaScope?.relativePath, listContext.mediaScope?.depth, listContext.mediaDatasetActive, listContext.notebookId, listContext.notebookPath, listContext.workDocumentsFilter?.file_name_contains, listContext.workDocumentsFilter?.file_types?.join(' '), listContext.workDocumentsFilter?.path_contains, listContext.workDocumentsFilter?.path_scope, resourceKindsKey]);
  const loadMore = useCallback(() => {
    if (!listContext.notebookId || refreshPausedRef.current || (mediaLibrary && !hasMediaDataset) || (workDocuments && !hasWorkDocumentsDataset) || !nextCursor || loading || loadingMore || !hasMore) return;
    const generation = requestGenerationRef.current;
    setLoadingMore(true);
    setMoreError(false);
    const pageRequest = workDocuments
      ? files.listWorkDocumentsPage(listContext.notebookId, nextCursor, MEDIA_LIBRARY_PAGE_SIZE, {
        fileNameContains: listContext.workDocumentsFilter?.file_name_contains,
        resourceKinds: listContext.workDocumentsFilter?.file_types,
        path: listContext.workDocumentsFilter?.path_scope === 'all' ? '' : listContext.workDocumentsFilter?.path_contains,
      })
      : mediaLibrary
      ? mediaResources.listPage(listContext.notebookPath, (listContext.filters.resourceKinds ?? ['image', 'video']).filter((kind): kind is 'image' | 'video' => kind === 'image' || kind === 'video'), nextCursor, MEDIA_LIBRARY_PAGE_SIZE, listContext.mediaScope?.relativePath ?? null, listContext.mediaScope?.depth)
      : files.listDocumentPage({ notebookId: listContext.notebookId, folderPath: listContext.folderPath, resourceKinds: listContext.filters.resourceKinds, cursor: nextCursor });
    void pageRequest.then((page) => {
      if (generation !== requestGenerationRef.current) return;
      const nextItems = mediaLibrary
        ? (page as MediaResourcePage).resources.map((resource) => mediaResourceListItem(resource, listContext.notebookPath)).filter((item): item is DocumentPageItem => item !== null)
        : (page as DocumentPage).items;
      setItems((current) => [...current, ...nextItems]);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    }).catch((error) => {
      logger.warn('loading next document page failed', { error });
      if (generation === requestGenerationRef.current) setMoreError(true);
    }).finally(() => {
      if (generation === requestGenerationRef.current) setLoadingMore(false);
    });
  }, [hasMediaDataset, hasWorkDocumentsDataset, hasMore, loading, loadingMore, mediaLibrary, workDocuments, nextCursor, resourceKindsKey, listContext.filters.resourceKinds, listContext.folderPath, listContext.mediaScope?.relativePath, listContext.mediaScope?.depth, listContext.mediaDatasetActive, listContext.notebookId, listContext.notebookPath, listContext.workDocumentsFilter?.file_name_contains, listContext.workDocumentsFilter?.file_types?.join(' '), listContext.workDocumentsFilter?.path_contains, listContext.workDocumentsFilter?.path_scope]);
  return { items, linkedItems, folders, loading, loadingLinkedItems, loadingMore, moreError, hasMore,
    hasMediaDataset, hasLinkedMedia, error, loadMore, refresh: requestRefresh };
}
