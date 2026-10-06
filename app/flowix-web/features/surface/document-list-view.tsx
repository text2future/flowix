import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Folder, Grid2X2, Inbox, Play } from 'lucide-react';
import { files, mediaResources, type DocumentPage, type DocumentPageItem, type FileBrowserDirectoriesChangedEvent, type MediaResourcePage } from '@platform/tauri/client';
import { externalFileViewKind, fileExtension, isCodeTextFilePath, resourceKindFromPath } from '@features/editor/public/code-file';
import { toast } from '@/lib/toast';
import { canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { subscribe } from '@platform/tauri/event-bus';
import { createLogger } from '@/lib/logger';
import { Dialog, DialogContent, DialogTitle } from '@shared/ui/dialog';
import { Button } from '@shared/ui/button';
import { useI18n } from '@/lib/i18n';
import { NotebookTreeFileIcon } from '@features/memo/components/notebook-tree-file-icon';
import { NotebookTreeResourceIcon } from '@features/memo/components/file-type-icon';
import type { DocumentListSurface } from './types';
import { requestMediaPreview } from './media-preview-tasks';
import documentCardPlaceholder from '@/assets/placeholder-document-card.jpg';
import imageCardPlaceholder from '@/assets/placeholder-image-card.jpg';
import videoCardPlaceholder from '@/assets/placeholder-video-card.jpg';
import codeCardPlaceholder from '@/assets/placeholder-code-card.jpg';
import pdfCardPlaceholder from '@/assets/placeholder-pdf-card.jpg';
import pptCardPlaceholder from '@/assets/placeholder-ppt-card.jpg';
import excelCardPlaceholder from '@/assets/placeholder-excel-card.jpg';
import otherCardPlaceholder from '@/assets/placeholder-other-card.jpg';
import folderCardPlaceholder from '@/assets/placeholder-folder-card.png';

const logger = createLogger('document-list-view');
function cardPlaceholder(item: DocumentPageItem): string {
  if (item.resourceKind === 'folder') return folderCardPlaceholder;
  const extension = fileExtension(item.name);
  if (item.resourceKind === 'note' || extension === 'md' || extension === 'markdown') return documentCardPlaceholder;
  if (item.resourceKind === 'image') return imageCardPlaceholder;
  if (item.resourceKind === 'video') return videoCardPlaceholder;
  if (extension === 'pdf') return pdfCardPlaceholder;
  if (['ppt', 'pptx', 'pps', 'ppsx', 'odp'].includes(extension)) return pptCardPlaceholder;
  if (['xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'tsv', 'ods'].includes(extension)) return excelCardPlaceholder;
  if (isCodeTextFilePath(item.fullPath)) return codeCardPlaceholder;
  return otherCardPlaceholder;
}

function formatUpdatedAgo(timestamp: number | null): string {
  if (!timestamp) return '更新时间未知';
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) return '更新 刚刚';
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `更新 ${elapsedMinutes}分钟前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `更新 ${elapsedHours}小时前`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) return `更新 ${elapsedDays}天前`;
  const elapsedMonths = Math.floor(elapsedDays / 30);
  if (elapsedMonths < 12) return `更新 ${elapsedMonths}个月前`;
  return `更新 ${Math.floor(elapsedMonths / 12)}年前`;
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

function mediaItemRelativeDirectory(filePath: string, notebookPath: string): string {
  const path = canonicalPath(filePath).replace(/\/+$/, '');
  const root = canonicalPath(notebookPath).replace(/\/+$/, '');
  const relativePath = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path.split('/').pop() ?? '';
  const directory = relativePath.split('/').slice(0, -1).join('/');
  return directory || '.';
}

const DocumentCard = memo(function DocumentCard({ item, notebookPath, openItem, mediaLibrary = false, observeMediaCard }: { item: DocumentPageItem; notebookPath: string; openItem: (item: DocumentPageItem) => Promise<void>; mediaLibrary?: boolean; observeMediaCard?: (node: Element, onNear: () => void) => () => void }) {
  const kind = mediaLibrary && (item.resourceKind === 'image' || item.resourceKind === 'video')
    ? item.resourceKind
    : item.resourceKind === 'folder' ? 'other' : externalFileViewKind(item.fullPath);
  const placeholder = cardPlaceholder(item);
  const [preview, setPreview] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [nearViewport, setNearViewport] = useState(false);
  const cardRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!mediaLibrary || !cardRef.current || !observeMediaCard) {
      setNearViewport(true);
      return;
    }
    return observeMediaCard(cardRef.current, () => setNearViewport(true));
  }, [mediaLibrary, observeMediaCard]);
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    if (mediaLibrary && !nearViewport) return () => { cancelled = true; };
    if (mediaLibrary && (kind === 'image' || kind === 'video')) {
      const task = requestMediaPreview(item.fullPath, notebookPath, kind, item.modifiedMs ?? 0);
      void task.promise.then((value) => { if (!cancelled) setPreview(value); });
      return () => { cancelled = true; task.cancel(); };
    }
    if (kind === 'image') {
      void files.readImage(item.fullPath, notebookPath)
        .then((value) => { if (!cancelled) setPreview(value); })
        .catch(() => undefined);
    } else if (kind === 'video') {
      void mediaResources.get(item.fullPath, notebookPath)
        .then(() => files.readVideoPreview(item.fullPath, notebookPath))
        .then((value) => { if (!cancelled) setPreview(value); })
        .catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [item.fullPath, item.modifiedMs, kind, mediaLibrary, nearViewport, notebookPath]);
  const image = <img
    src={preview || placeholder}
    alt=""
    loading={mediaLibrary ? 'eager' : 'lazy'}
    className={`${mediaLibrary ? kind === 'video' ? 'block h-[360px] w-full object-cover' : 'block max-h-[360px] w-full object-contain' : 'h-full w-full object-cover'} ${preview ? '' : 'opacity-50'}`}
  />;
  if (mediaLibrary) return <button type="button" disabled={opening} aria-busy={opening} onClick={() => {
    setOpening(true);
    void openItem(item).finally(() => setOpening(false));
  }} ref={cardRef} className="group mb-[7px] inline-flex w-full break-inside-avoid flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] text-left transition-colors hover:border-[color-mix(in_oklch,var(--border)_90%,var(--foreground)_10%)] disabled:cursor-wait disabled:opacity-70">
    <span className="relative block w-full overflow-hidden bg-[color-mix(in_srgb,var(--card)_94%,var(--foreground)_6%)]">
      {image}
      {kind === 'video' && <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true"><span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/40 text-white shadow-lg backdrop-blur-sm"><Play className="ml-0.5 h-5 w-5 fill-current stroke-current" strokeWidth={1.5} /></span></span>}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-0.5 bg-gradient-to-t from-black/85 via-black/55 to-transparent px-2.5 pb-2.5 pt-8 text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
        <span className="truncate text-[13px] font-medium leading-5" title={item.name}>{item.name}</span>
        <span className="truncate text-[11px] leading-4 text-white/75" title={mediaItemRelativeDirectory(item.fullPath, notebookPath)}>{mediaItemRelativeDirectory(item.fullPath, notebookPath)}</span>
      </span>
    </span>
  </button>;
  return <button type="button" disabled={opening} aria-busy={opening} onClick={() => {
    setOpening(true);
    void openItem(item).finally(() => setOpening(false));
  }} className={`group relative flex h-[210px] min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] text-left transition-[background-color,border-color] hover:border-[color-mix(in_oklch,var(--border)_94%,var(--foreground)_6%)] hover:bg-[color-mix(in_oklch,var(--card)_98%,var(--foreground)_2%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:cursor-wait disabled:opacity-70 ${kind === 'image' || kind === 'video' ? 'block' : ''}`}>
    {kind === 'image' || kind === 'video' ? <>
      <span className="absolute inset-0 block overflow-hidden bg-[color-mix(in_srgb,var(--card)_97%,var(--foreground)_3%)]">
        {image}
      </span>
      {kind === 'video' && <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/40 text-white shadow-lg backdrop-blur-sm">
          <Play className="ml-0.5 h-6 w-6 fill-current stroke-current" strokeWidth={1.5} />
        </span>
      </span>}
      <span className="absolute inset-x-0 bottom-0 flex h-12 items-center justify-between gap-3 bg-gradient-to-t from-black/30 via-black/15 to-transparent px-3 text-white">
        <span className="min-w-0 truncate text-[13px] font-medium leading-5" title={item.name}>{item.name}</span>
        <span className="shrink-0 text-[11px] leading-4 text-white/75">{formatUpdatedAgo(item.modifiedMs)}</span>
      </span>
    </> : <>
    <span className="flex h-[148px] w-full shrink-0 items-center justify-center overflow-hidden border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_97%,var(--foreground)_3%)]">
      {image}
    </span>
    <span className="flex min-w-0 flex-1 items-start gap-1 px-3 py-2.5">
      {item.resourceKind === 'folder'
        ? <Folder className="mt-0.5 h-4 w-4 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
        : <NotebookTreeFileIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium leading-5 text-[var(--foreground)]">{item.resourceKind === 'folder' ? item.name : item.name.replace(/\.[^.]+$/, '')}</span>
        <span className="mt-0.5 block truncate text-[11px] leading-4 text-[var(--muted-foreground)]">{formatUpdatedAgo(item.modifiedMs)}</span>
      </span>
    </span>
    </>}
  </button>;
});

export function DocumentListView({ surface, mediaLibrary = false, libraryName = '媒体库', libraryFilePath, selectedKinds = ['image', 'video'], onKindsChange, onRenameLibrary }: {
  surface: DocumentListSurface;
  mediaLibrary?: boolean;
  libraryName?: string;
  libraryFilePath?: string;
  selectedKinds?: Array<'image' | 'video'>;
  onKindsChange?: (kinds: Array<'image' | 'video'>) => void;
  onRenameLibrary?: (title: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const resourceKindsKey = (surface.filters.resourceKinds ?? []).join('\u0000');
  const [items, setItems] = useState<DocumentPageItem[]>([]);
  const [folders, setFolders] = useState<DocumentPageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [editingLibraryTitle, setEditingLibraryTitle] = useState(false);
  const [libraryTitleDraft, setLibraryTitleDraft] = useState(libraryName);
  const [renamingLibraryTitle, setRenamingLibraryTitle] = useState(false);
  const libraryTitleInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editingLibraryTitle) setLibraryTitleDraft(libraryName);
  }, [editingLibraryTitle, libraryName]);
  const commitLibraryTitle = useCallback(async (rawTitle: string) => {
    setEditingLibraryTitle(false);
    const title = rawTitle.trim();
    if (!onRenameLibrary || !title || title === libraryName) return;
    setRenamingLibraryTitle(true);
    try {
      await onRenameLibrary(title);
    } finally {
      setRenamingLibraryTitle(false);
    }
  }, [libraryName, onRenameLibrary]);
  const [viewport, setViewport] = useState({ top: 0, height: 600, width: 600 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const previewObserverRef = useRef<IntersectionObserver | null>(null);
  const previewCallbacksRef = useRef(new Map<Element, () => void>());
  const loadingRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const requestGenerationRef = useRef(0);
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
      }, { root: scrollRef.current, rootMargin: '600px' });
      previewObserverRef.current = observer;
    }
    previewCallbacksRef.current.set(node, onNear);
    observer.observe(node);
    return () => {
      previewCallbacksRef.current.delete(node);
      previewObserverRef.current?.unobserve(node);
    };
  }, []);
  useEffect(() => () => {
    previewObserverRef.current?.disconnect();
    previewObserverRef.current = null;
    previewCallbacksRef.current.clear();
  }, []);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => setViewport((current) => ({
      ...current,
      top: Math.max(0, element.scrollTop - (headerRef.current?.offsetHeight ?? 0) - 8),
      height: element.clientHeight,
      width: element.clientWidth - 40,
    }));
    update();
    const resize = new ResizeObserver(update);
    resize.observe(element);
    if (headerRef.current) resize.observe(headerRef.current);
    if (!mediaLibrary) element.addEventListener('scroll', update, { passive: true });
    return () => { resize.disconnect(); element.removeEventListener('scroll', update); };
  }, [mediaLibrary]);
  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [surface.displayId]);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribe<{ notebookId: string }>('file-management-changed', ({ notebookId }) => {
    if (notebookId === surface.notebookId) setRevision((value) => value + 1);
  }), [surface.notebookId]);
  useEffect(() => subscribe<{ notebookId: string }>('media-properties-changed', ({ notebookId }) => {
    if (notebookId === surface.notebookId) setRevision((value) => value + 1);
  }), [surface.notebookId]);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => subscribe<FileBrowserDirectoriesChangedEvent>(
    'file-browser-directories-changed',
    (event) => {
      if (canonicalPath(event.rootPath) !== canonicalPath(surface.notebookPath)) return;
      const root = canonicalPath(surface.notebookPath).replace(/\/$/, '');
      const directories = event.directories.filter((directory) => {
        const path = canonicalPath(directory);
        if (path === root) return true;
        return path.startsWith(`${root}/`);
      });
      if (directories.length === 0) return;
      if (loadingRef.current) {
        pendingRefreshRef.current = true;
        return;
      }
      setRevision((value) => value + 1);
    },
  ), [surface.notebookPath]);
  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    let cancelled = false;
    if (!surface.notebookId) {
      loadingRef.current = false;
      setItems([]);
      setError(true);
      setLoading(false);
      return;
    }
    loadingRef.current = true;
    setLoading(true);
    setLoadingMore(false);
    setMoreError(false);
    setError(false);
    setItems([]);
    setFolders([]);
    setHasMore(false);
    setNextCursor(null);
    const pageRequest = mediaLibrary
      ? mediaResources.listPage(surface.notebookPath, (surface.filters.resourceKinds ?? ['image', 'video']).filter((kind): kind is 'image' | 'video' => kind === 'image' || kind === 'video'), null, 48)
      : files.listDocumentPage({ notebookId: surface.notebookId, folderPath: surface.folderPath, resourceKinds: surface.filters.resourceKinds });
    void pageRequest.then((page) => {
      if (cancelled || generation !== requestGenerationRef.current) return;
      if (mediaLibrary) {
        const mediaPage = page as MediaResourcePage;
        setItems(mediaPage.resources.map((resource) => mediaResourceListItem(resource, surface.notebookPath)).filter((item): item is DocumentPageItem => item !== null));
        setFolders([]);
        setNextCursor(mediaPage.nextCursor);
        setHasMore(mediaPage.hasMore);
      } else {
        const documentPage = page as DocumentPage;
        setItems(documentPage.items);
        setFolders(documentPage.folders);
        setNextCursor(documentPage.nextCursor);
        setHasMore(documentPage.hasMore);
      }
    }).catch((error) => {
      logger.warn('loading document page failed', { error });
      if (!cancelled && generation === requestGenerationRef.current) setError(true);
    }).finally(() => {
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
  }, [mediaLibrary, revision, surface.folderPath, surface.filters.resourceKinds, surface.notebookId, surface.notebookPath, resourceKindsKey]);
  const loadMore = useCallback(() => {
    if (!surface.notebookId || !nextCursor || loading || loadingMore || !hasMore) return;
    const generation = requestGenerationRef.current;
    setLoadingMore(true);
    setMoreError(false);
    const pageRequest = mediaLibrary
      ? mediaResources.listPage(surface.notebookPath, (surface.filters.resourceKinds ?? ['image', 'video']).filter((kind): kind is 'image' | 'video' => kind === 'image' || kind === 'video'), nextCursor, 48)
      : files.listDocumentPage({ notebookId: surface.notebookId, folderPath: surface.folderPath, resourceKinds: surface.filters.resourceKinds, cursor: nextCursor });
    void pageRequest.then((page) => {
      if (generation !== requestGenerationRef.current) return;
      const nextItems = mediaLibrary
        ? (page as MediaResourcePage).resources.map((resource) => mediaResourceListItem(resource, surface.notebookPath)).filter((item): item is DocumentPageItem => item !== null)
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
  }, [hasMore, loading, loadingMore, mediaLibrary, nextCursor, resourceKindsKey, surface.filters.resourceKinds, surface.folderPath, surface.notebookId, surface.notebookPath]);
  useEffect(() => {
    if (!hasMore || moreError || !endRef.current || !scrollRef.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) loadMore();
    }, { root: scrollRef.current, rootMargin: '500px' });
    observer.observe(endRef.current);
    return () => observer.disconnect();
  }, [hasMore, loadMore, moreError]);
  const visibleItems = mediaLibrary ? items : [...folders, ...items];
  const columnCount = Math.max(1, Math.floor((viewport.width + 14) / 214));
  const rowHeight = 224;
  const rowCount = Math.ceil(visibleItems.length / columnCount);
  const firstRow = Math.min(Math.max(0, rowCount - 1), Math.max(0, Math.floor(viewport.top / rowHeight) - 2));
  const lastRow = Math.min(rowCount, Math.ceil((viewport.top + viewport.height) / rowHeight) + 2);
  const visibleCards = visibleItems.slice(firstRow * columnCount, lastRow * columnCount);
  const createNote = useCallback(async () => {
    const title = newTitle.trim();
    if (!title || creating || !surface.notebookId) return;
    setCreating(true);
    try {
      let path: string;
      const { noteRepository } = await import('@features/memo/services/note-repository');
      const root = canonicalPath(surface.notebookPath).replace(/\/$/, '');
      const folder = canonicalPath(surface.folderPath).replace(/\/$/, '');
      const relative = folder === root ? '' : folder.slice(root.length + 1);
      const created = await noteRepository.create(undefined, surface.notebookId, relative, title);
      path = created.path;
      setCreateOpen(false);
      setNewTitle('');
      setRevision((value) => value + 1);
      const { openExternalTarget } = await import('@features/workspace/use-cases/workspace-navigation');
      await openExternalTarget(path, { destination: 'main-third', scopePath: surface.notebookPath });
    } catch {
      toast.error('新建笔记失败');
    } finally {
      setCreating(false);
    }
  }, [creating, newTitle, surface.folderPath, surface.notebookId, surface.notebookPath]);
  const openItem = useCallback(async (item: DocumentPageItem) => {
    try {
      if (item.resourceKind === 'folder') {
        const [{ openDocumentListTarget }, { createDocumentListTarget }] = await Promise.all([
          import('@features/workspace/use-cases/workspace-navigation'),
          import('@features/workspace/store/work-column-target'),
        ]);
        openDocumentListTarget(createDocumentListTarget({
          kind: 'folder', path: item.fullPath, notebookPath: surface.notebookPath, notebookId: surface.notebookId,
        }, {}));
        return;
      }
      const { openExternalTarget, openMediaTarget } = await import('@features/workspace/use-cases/workspace-navigation');
      const kind = item.resourceKind ?? resourceKindFromPath(item.fullPath);
      if (kind === 'image' || kind === 'video') {
        await openMediaTarget({ filePath: item.fullPath, notebookId: surface.notebookId, notebookPath: surface.notebookPath, resourceKind: kind });
      } else {
        await openExternalTarget(item.fullPath, { destination: 'main-third', scopePath: surface.notebookPath });
      }
    } catch {
      toast.error('打开文件失败');
    }
  }, [surface.notebookId, surface.notebookPath]);
  return <section className="flex h-full min-h-0 flex-col bg-transparent text-[var(--foreground)]">
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-5 pb-4">
    <div ref={headerRef} className={mediaLibrary ? 'multidimensional-table__view-nav -mx-5 flex min-w-0 shrink-0 items-center justify-between gap-1' : '-mx-5 flex flex-wrap items-center justify-between gap-2 px-5 pt-3'}>
      {mediaLibrary ? <>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-5 py-1">
          <div className="flex max-w-[200px] min-w-0 shrink-0 -translate-x-[2px] items-center gap-1.5 pr-2" title={libraryName} onDoubleClick={onRenameLibrary && !renamingLibraryTitle ? () => { setLibraryTitleDraft(libraryName); setEditingLibraryTitle(true); } : undefined}>
            <NotebookTreeResourceIcon path={libraryFilePath ?? 'media-library.lib.yaml'} className="h-5 w-5 shrink-0" />
            {editingLibraryTitle ? <input
              ref={libraryTitleInputRef}
              autoFocus
              aria-label={t('mediaLibrary.titleLabel')}
              value={libraryTitleDraft}
              size={Math.max(1, libraryTitleDraft.length)}
              disabled={renamingLibraryTitle}
              onChange={(event) => setLibraryTitleDraft(event.currentTarget.value)}
              onBlur={(event) => { void commitLibraryTitle(event.currentTarget.value); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  event.currentTarget.value = libraryName;
                  event.currentTarget.blur();
                }
              }}
              className="h-7 w-auto min-w-[4ch] max-w-[170px] border-0 bg-transparent px-0 text-sm font-medium text-[var(--foreground)] outline-none"
            /> : <span className="truncate text-sm font-medium text-[var(--foreground)]">{libraryName}</span>}
          </div>
          <div className="flex shrink-0 items-center gap-1 rounded-lg bg-[var(--muted)] p-0.5" role="group" aria-label={t('mediaLibrary.filterLabel')}>
            {([
              { label: t('mediaLibrary.all'), kinds: ['image', 'video'] as Array<'image' | 'video'> },
              { label: t('mediaLibrary.images'), kinds: ['image'] as Array<'image' | 'video'> },
              { label: t('mediaLibrary.videos'), kinds: ['video'] as Array<'image' | 'video'> },
            ]).map((option) => {
              const active = option.kinds.length === selectedKinds.length && option.kinds.every((kind) => selectedKinds.includes(kind));
              return <button key={option.label} type="button" aria-pressed={active} onClick={() => onKindsChange?.(option.kinds)} className={`h-7 rounded-md px-2 text-xs transition-colors ${active ? 'bg-[var(--card)] text-[var(--foreground)] shadow-sm' : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'}`}>{option.label}</button>;
            })}
          </div>
        </div>
        <span className="shrink-0 px-5 text-xs text-[var(--muted-foreground)]">{t('mediaLibrary.itemCount', { count: items.length, more: hasMore ? '+' : '' })}</span>
      </> : <>
      <div className="flex items-center" role="group" aria-label={t('memo.documentList.viewType')}>
        <button
          type="button"
          aria-pressed="true"
          className="inline-flex h-8 items-center justify-start gap-1.5 rounded-lg px-0 text-sm font-medium text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        ><Grid2X2 className="h-3.5 w-3.5" aria-hidden="true" />{t('memo.documentList.gallery')}</button>
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" className="px-3" onClick={() => setCreateOpen(true)} disabled={!surface.notebookId}>{t('memo.documentList.new')}</Button>
      </div>
      </>}
    </div>
      {error ? <div className="flex h-full min-h-[160px] items-center justify-center text-center text-sm text-[var(--muted-foreground)]">不支持读取隐藏/系统文件夹</div>
        : loading && visibleItems.length === 0
        ? <div className="flex h-full min-h-[160px] items-center justify-center text-sm text-[var(--muted-foreground)]">正在整理文件列表…</div>
        : !loading && visibleItems.length === 0
        ? <div className="flex h-full min-h-[160px] items-center justify-center text-sm text-[var(--muted-foreground)]">
              <div className="flex flex-col items-center text-center">
                <Inbox className="mb-3 h-10 w-10 opacity-50" strokeWidth={1.25} aria-hidden="true" />
                <span>{mediaLibrary ? t('mediaLibrary.empty') : '列表内容为空'}</span>
              </div>
            </div>
          : mediaLibrary
            ? <div className="pt-3" style={{ columns: '220px', columnGap: '7px', contentVisibility: 'auto', containIntrinsicSize: '1px 1000px' }}>{visibleItems.map((item) => <DocumentCard key={item.fullPath} item={item} notebookPath={surface.notebookPath} openItem={openItem} mediaLibrary observeMediaCard={observeMediaCard} />)}</div>
            : <div style={{ paddingTop: firstRow * rowHeight, paddingBottom: Math.max(0, rowCount - lastRow) * rowHeight }}><div className="grid w-full grid-cols-[repeat(auto-fill,minmax(min(100%,200px),1fr))] items-stretch gap-3.5 pt-3">{visibleCards.map((item) => <DocumentCard key={item.fullPath} item={item} notebookPath={surface.notebookPath} openItem={openItem} />)}</div></div>}
      {moreError && <button type="button" className="mt-4 rounded-lg px-2 py-1 text-sm text-[var(--brand)] hover:bg-[var(--muted)]" onClick={loadMore}>加载失败，点击重试</button>}
      {hasMore && !moreError && <div ref={endRef} className="h-1" aria-hidden="true" />}
    </div>
    {!mediaLibrary && <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent className="max-w-sm"><DialogTitle>新建笔记</DialogTitle><form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void createNote(); }}><input autoFocus value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="笔记标题" className="h-9 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--brand)]" /><div className="flex justify-end gap-2"><Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={() => setCreateOpen(false)}>取消</Button><Button type="submit" size="sm" className="rounded-lg" disabled={!newTitle.trim() || creating}>创建</Button></div></form></DialogContent></Dialog>}
  </section>;
}
