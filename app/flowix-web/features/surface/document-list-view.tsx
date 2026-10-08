import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Folder, Grid2X2, Inbox, Play } from 'lucide-react';
import { FunnelIcon, PlusIcon, TrashSimpleIcon } from '@phosphor-icons/react';
import { files, mediaResources, type DocumentPage, type DocumentPageItem, type FileBrowserDirectoriesChangedEvent, type MediaResourcePage, type NotebookFolderOption } from '@platform/tauri/client';
import { externalFileViewKind, fileExtension, isCodeTextFilePath, resourceKindFromPath } from '@features/editor/public/code-file';
import { toast } from '@/lib/toast';
import { canonicalPath, joinNotebookMemoPath } from '@/lib/path';
import { subscribe } from '@platform/tauri/event-bus';
import { createLogger } from '@/lib/logger';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Button } from '@shared/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { useI18n } from '@/lib/i18n';
import { hasMediaLibraryDatasetCondition, matchesMediaLibraryDataset, normalizeMediaLibraryFileCondition, type MediaLibraryFileCondition, type MediaLibraryRecord } from '@features/media-library/model';
import { NotebookTreeFileIcon } from '@features/memo/components/notebook-tree-file-icon';
import { NotebookTreeResourceIcon } from '@features/memo/components/file-type-icon';
import { ResourceFolderIcon } from './resource-file-icon';
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
const MEDIA_LIBRARY_PAGE_SIZE = 30;
// Keep the loading effect stable when ordinary folders omit media records.
const EMPTY_MEDIA_LIBRARY_RECORDS: MediaLibraryRecord[] = [];

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

async function loadLinkedMediaItems(
  records: MediaLibraryRecord[],
  notebookPath: string,
  onBatch: (items: DocumentPageItem[]) => void,
): Promise<void> {
  // Keep record resolution bounded when a library links many local attachments.
  for (let offset = 0; offset < records.length; offset += 8) {
    const batch = records.slice(offset, offset + 8);
    const resolved = await Promise.all(batch.map(async (record) => {
      const filePath = joinNotebookMemoPath(notebookPath, record.note_path);
      if (!filePath) return null;
      try {
        const { resource } = await mediaResources.get(filePath, notebookPath);
        return mediaResourceListItem(resource, notebookPath);
      } catch { return null; }
    }));
    const items = resolved.filter((item): item is DocumentPageItem => item !== null);
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

function mediaItemRelativePath(filePath: string, notebookPath: string): string {
  const path = canonicalPath(filePath).replace(/\/+$/, '');
  const root = canonicalPath(notebookPath).replace(/\/+$/, '');
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path.split('/').pop() ?? '';
}

function mediaItemRelativeDirectory(filePath: string, notebookPath: string): string {
  return mediaItemRelativePath(filePath, notebookPath).split('/').slice(0, -1).join('/') || '.';
}

const DocumentCard = memo(function DocumentCard({ item, notebookPath, openItem, mediaLibrary = false, observeMediaCard, manuallyAddedImage = false, onRequestDelete, deleteLabel, deleteDisabled = false }: { item: DocumentPageItem; notebookPath: string; openItem: (item: DocumentPageItem) => Promise<void>; mediaLibrary?: boolean; observeMediaCard?: (node: Element, onNear: () => void) => () => void; manuallyAddedImage?: boolean; onRequestDelete?: (item: DocumentPageItem) => void; deleteLabel?: string; deleteDisabled?: boolean }) {
  const kind = mediaLibrary && (item.resourceKind === 'image' || item.resourceKind === 'video')
    ? item.resourceKind
    : item.resourceKind === 'folder' ? 'other' : externalFileViewKind(item.fullPath);
  const placeholder = cardPlaceholder(item);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
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
    if (mediaLibrary && !nearViewport) {
      setPreviewLoading(false);
      return () => { cancelled = true; };
    }
    if (mediaLibrary && (kind === 'image' || kind === 'video')) {
      setPreviewLoading(true);
      const task = requestMediaPreview(item.fullPath, notebookPath, kind, item.modifiedMs ?? 0);
      void task.promise.then((value) => {
        if (cancelled) return;
        setPreview(value);
        if (!value) setPreviewLoading(false);
      });
      return () => { cancelled = true; task.cancel(); };
    }
    setPreviewLoading(false);
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
    onLoad={() => { if (mediaLibrary && preview) setPreviewLoading(false); }}
    onError={() => {
      if (!mediaLibrary || !preview) return;
      setPreview(null);
      setPreviewLoading(false);
    }}
    loading={mediaLibrary ? 'eager' : 'lazy'}
    className={`${mediaLibrary ? kind === 'video' ? 'block h-[360px] w-full object-cover' : 'block max-h-[360px] w-full object-contain' : 'h-full w-full object-cover'} ${preview ? '' : 'opacity-50'}`}
  />;
  if (mediaLibrary) return <div className="group relative w-full break-inside-avoid">
    <button type="button" disabled={opening} aria-busy={opening || previewLoading} onClick={() => {
    setOpening(true);
    void openItem(item).finally(() => setOpening(false));
  }} ref={cardRef} className="group flex w-full flex-col overflow-hidden rounded-[6px] border border-[var(--border)] bg-[var(--card)] text-left transition-colors hover:border-[color-mix(in_oklch,var(--border)_90%,var(--foreground)_10%)] disabled:cursor-wait disabled:opacity-70">
    <span className="relative block w-full overflow-hidden bg-[color-mix(in_srgb,var(--card)_94%,var(--foreground)_6%)]">
      {image}
      {previewLoading && <span aria-hidden="true" className="pointer-events-none absolute inset-0 animate-pulse bg-[var(--muted)]" />}
      {kind === 'video' && <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true"><span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/40 text-white shadow-lg backdrop-blur-sm"><Play className="ml-0.5 h-5 w-5 fill-current stroke-current" strokeWidth={1.5} /></span></span>}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-0.5 bg-gradient-to-t from-black/40 via-black/25 to-transparent px-2.5 pb-2.5 pt-8 text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
        <span className="truncate text-[13px] font-medium leading-5" title={item.name}>{item.name}</span>
        <span className="truncate text-[11px] leading-4 text-white/75" title={mediaItemRelativeDirectory(item.fullPath, notebookPath)}>{mediaItemRelativeDirectory(item.fullPath, notebookPath)}</span>
      </span>
    </span>
    </button>
    {manuallyAddedImage && onRequestDelete && <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={deleteLabel}
      title={deleteLabel}
      disabled={deleteDisabled}
      onClick={() => onRequestDelete(item)}
      className="absolute right-2 top-2 z-10 h-7 w-7 rounded-lg bg-[var(--card)]/90 p-0 text-[var(--muted-foreground)] opacity-0 shadow-sm transition-opacity hover:bg-[var(--card)] hover:text-[var(--destructive)] group-hover:opacity-100 group-focus-within:opacity-100"
    ><TrashSimpleIcon size={14} weight="bold" aria-hidden="true" /></Button>}
  </div>;
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

export function DocumentListView({ surface, mediaLibrary = false, libraryName = '媒体库', libraryFilePath, mediaLibraryFilter = {}, mediaLibraryRecords = EMPTY_MEDIA_LIBRARY_RECORDS, onMediaLibraryFilterChange, onRenameLibrary, onAddMedia, onDeleteLibrary, onDeleteManualMedia, libraryActionsDisabled = false }: {
  surface: DocumentListSurface;
  mediaLibrary?: boolean;
  libraryName?: string;
  libraryFilePath?: string;
  mediaLibraryFilter?: MediaLibraryFileCondition;
  mediaLibraryRecords?: MediaLibraryRecord[];
  onAddMedia?: () => Promise<boolean>;
  onDeleteManualMedia?: (item: DocumentPageItem) => Promise<boolean>;
  onMediaLibraryFilterChange?: (condition: MediaLibraryFileCondition) => Promise<boolean>;
  onRenameLibrary?: (title: string) => Promise<void>;
  onDeleteLibrary?: () => void;
  libraryActionsDisabled?: boolean;
}) {
  const { t } = useI18n();
  const resourceKindsKey = (surface.filters.resourceKinds ?? []).join('\u0000');
  const hasMediaDataset = hasMediaLibraryDatasetCondition(mediaLibraryFilter);
  const hasLinkedMedia = mediaLibraryRecords.length > 0;
  const [items, setItems] = useState<DocumentPageItem[]>([]);
  const [linkedItems, setLinkedItems] = useState<DocumentPageItem[]>([]);
  const [addingMedia, setAddingMedia] = useState(false);
  const [manualMediaToDelete, setManualMediaToDelete] = useState<DocumentPageItem | null>(null);
  const [deletingManualMedia, setDeletingManualMedia] = useState(false);
  const [folders, setFolders] = useState<DocumentPageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingLinkedItems, setLoadingLinkedItems] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [editingLibraryTitle, setEditingLibraryTitle] = useState(false);
  const [libraryTitleDraft, setLibraryTitleDraft] = useState(libraryName);
  const [renamingLibraryTitle, setRenamingLibraryTitle] = useState(false);
  const [mediaNameQuery, setMediaNameQuery] = useState('');
  const [mediaPathQuery, setMediaPathQuery] = useState('');
  const [mediaTypeQuery, setMediaTypeQuery] = useState<'any' | 'image' | 'video'>('any');
  const [mediaFiltersOpen, setMediaFiltersOpen] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [folderOptions, setFolderOptions] = useState<NotebookFolderOption[]>([]);
  const [folderOptionsLoading, setFolderOptionsLoading] = useState(false);
  const libraryTitleInputRef = useRef<HTMLInputElement>(null);
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
    requestAnimationFrame(() => libraryTitleInputRef.current?.select());
  }, [libraryName, onRenameLibrary, renamingLibraryTitle]);
  useEffect(() => {
    if (!editingLibraryTitle) return;
    const blurOnOutsidePointer = (event: PointerEvent) => {
      const input = libraryTitleInputRef.current;
      if (input && !event.composedPath().includes(input)) input.blur();
    };
    document.addEventListener('pointerdown', blurOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', blurOnOutsidePointer, true);
  }, [editingLibraryTitle]);
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
  useEffect(() => {
    if (!mediaLibrary) return;
    scrollRef.current?.scrollTo(0, 0);
  }, [mediaLibrary, mediaLibraryFilter.file_name_contains, mediaLibraryFilter.file_type, mediaLibraryFilter.path_contains, resourceKindsKey]);
  useEffect(() => {
    if (!folderPickerOpen || !surface.notebookPath) return;
    let active = true;
    setFolderOptionsLoading(true);
    void files.getNotebookFolderOptions(surface.notebookPath).then((options) => {
      if (active) setFolderOptions(options);
    }).catch(() => {
      if (active) setFolderOptions([]);
    }).finally(() => {
      if (active) setFolderOptionsLoading(false);
    });
    return () => { active = false; };
  }, [folderPickerOpen, surface.notebookPath]);
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
      const changedPaths = event.paths ?? [];
      // Library-config mutations update the catalog separately, but do not change the media rows shown here.
      if (mediaLibrary && changedPaths.length > 0 && changedPaths.every((path) => /\.lib\.ya?ml$/i.test(path))) return;
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
  ), [mediaLibrary, surface.notebookPath]);
  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    let cancelled = false;
    if (!surface.notebookId) {
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
    setItems([]);
    setLinkedItems([]);
    setFolders([]);
    setHasMore(false);
    setNextCursor(null);
    const pageRequest = mediaLibrary
      ? hasMediaDataset
        ? mediaResources.listPage(surface.notebookPath, (surface.filters.resourceKinds ?? ['image', 'video']).filter((kind): kind is 'image' | 'video' => kind === 'image' || kind === 'video'), null, MEDIA_LIBRARY_PAGE_SIZE)
        : Promise.resolve({ resources: [], nextCursor: null, hasMore: false } satisfies MediaResourcePage)
      : files.listDocumentPage({ notebookId: surface.notebookId, folderPath: surface.folderPath, resourceKinds: surface.filters.resourceKinds });
    const linkedRequest = mediaLibrary
      ? loadLinkedMediaItems(mediaLibraryRecords, surface.notebookPath, (batch) => {
        if (cancelled || generation !== requestGenerationRef.current) return;
        setLinkedItems((current) => [...current, ...batch]);
        // Libraries that only contain explicit records can render as soon as
        // their first bounded batch resolves, while later batches continue.
        if (!hasMediaDataset) setLoading(false);
      })
      : Promise.resolve();
    const pageTask = pageRequest.then((page) => {
      if (cancelled || generation !== requestGenerationRef.current) return;
      if (mediaLibrary) {
        const mediaPage = page as MediaResourcePage;
        setItems(mediaPage.resources.map((resource) => mediaResourceListItem(resource, surface.notebookPath)).filter((item): item is DocumentPageItem => item !== null));
        setFolders([]);
        setNextCursor(mediaPage.nextCursor);
        setHasMore(mediaPage.hasMore);
        // Show the independently loaded resource page without waiting for all
        // explicit record paths to resolve.
        if (hasMediaDataset) setLoading(false);
      } else {
        const documentPage = page as DocumentPage;
        setItems(documentPage.items);
        setFolders(documentPage.folders);
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
  }, [hasMediaDataset, hasLinkedMedia, mediaLibrary, mediaLibraryRecords, revision, surface.folderPath, surface.filters.resourceKinds, surface.notebookId, surface.notebookPath, resourceKindsKey]);
  const loadMore = useCallback(() => {
    if (!surface.notebookId || (mediaLibrary && !hasMediaDataset) || !nextCursor || loading || loadingMore || !hasMore) return;
    const generation = requestGenerationRef.current;
    setLoadingMore(true);
    setMoreError(false);
    const pageRequest = mediaLibrary
      ? mediaResources.listPage(surface.notebookPath, (surface.filters.resourceKinds ?? ['image', 'video']).filter((kind): kind is 'image' | 'video' => kind === 'image' || kind === 'video'), nextCursor, MEDIA_LIBRARY_PAGE_SIZE)
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
  }, [hasMediaDataset, hasMore, loading, loadingMore, mediaLibrary, nextCursor, resourceKindsKey, surface.filters.resourceKinds, surface.folderPath, surface.notebookId, surface.notebookPath]);
  useEffect(() => {
    if (!hasMore || moreError || !endRef.current || !scrollRef.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) loadMore();
    }, { root: scrollRef.current, rootMargin: '500px' });
    observer.observe(endRef.current);
    return () => observer.disconnect();
  }, [hasMore, loadMore, moreError]);
  const appliedMediaNameQuery = (mediaLibraryFilter.file_name_contains ?? '').trim().toLocaleLowerCase();
  const appliedMediaPathQuery = (mediaLibraryFilter.path_contains ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase();
  const visibleItems = mediaLibrary
    ? [...new Map([
      ...linkedItems,
      ...(hasMediaDataset ? items.filter((item) => (
        (item.resourceKind === 'image' || item.resourceKind === 'video')
        && matchesMediaLibraryDataset({ relativePath: mediaItemRelativePath(item.fullPath, surface.notebookPath), kind: item.resourceKind }, mediaLibraryFilter)
      )) : []),
    ].map((item) => [canonicalPath(item.fullPath), item])).values()]
    : [...folders, ...items];
  const mediaFilterCount = (appliedMediaNameQuery ? 1 : 0)
    + (appliedMediaPathQuery ? 1 : 0)
    + (mediaLibraryFilter.file_type ? 1 : 0);
  const linkedMediaPathKeys = useMemo(() => new Set(mediaLibraryRecords.flatMap((record) => {
    const filePath = joinNotebookMemoPath(surface.notebookPath, record.note_path);
    return filePath ? [canonicalPath(filePath).toLocaleLowerCase()] : [];
  })), [mediaLibraryRecords, surface.notebookPath]);
  const mediaDraftFilterCount = (mediaNameQuery.trim() ? 1 : 0)
    + (mediaPathQuery.trim() ? 1 : 0)
    + (mediaTypeQuery === 'any' ? 0 : 1);
  const saveMediaFilters = useCallback(async () => {
    if (!onMediaLibraryFilterChange) return false;
    const condition = normalizeMediaLibraryFileCondition({
      file_name_contains: mediaNameQuery.trim(),
      file_type: mediaTypeQuery === 'any' ? undefined : mediaTypeQuery,
      path_contains: mediaPathQuery.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
    });
    const currentPath = (mediaLibraryFilter.path_contains ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (condition.file_name_contains === (mediaLibraryFilter.file_name_contains?.trim() || undefined)
      && condition.file_type === mediaLibraryFilter.file_type
      && condition.path_contains === (currentPath || undefined)) return true;
    return onMediaLibraryFilterChange(condition);
  }, [mediaLibraryFilter.file_name_contains, mediaLibraryFilter.file_type, mediaLibraryFilter.path_contains, mediaNameQuery, mediaPathQuery, mediaTypeQuery, onMediaLibraryFilterChange]);
  const applyMediaFilters = useCallback(async () => {
    if (await saveMediaFilters()) setMediaFiltersOpen(false);
  }, [saveMediaFilters]);
  const confirmDeleteManualMedia = useCallback(async () => {
    if (!manualMediaToDelete || !onDeleteManualMedia || deletingManualMedia) return;
    setDeletingManualMedia(true);
    try {
      if (await onDeleteManualMedia(manualMediaToDelete)) {
        setManualMediaToDelete(null);
        setRevision((value) => value + 1);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('media.fileTree.deleteFailed'));
    } finally {
      setDeletingManualMedia(false);
    }
  }, [deletingManualMedia, manualMediaToDelete, onDeleteManualMedia, t]);
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
          <div className="flex h-7 max-w-[500px] min-w-0 -translate-x-[2px] items-center gap-1.5 pr-2" title={libraryName} onDoubleClick={editingLibraryTitle ? undefined : beginLibraryTitleEdit}>
            <NotebookTreeResourceIcon path={libraryFilePath ?? 'media-library.lib.yaml'} className="h-5 w-5 shrink-0" />
            {editingLibraryTitle ? <input
              ref={libraryTitleInputRef}
              autoFocus
              aria-label={t('mediaLibrary.titleLabel')}
              value={libraryTitleDraft}
              disabled={renamingLibraryTitle}
              onChange={(event) => setLibraryTitleDraft(event.currentTarget.value)}
              onBlur={(event) => { void commitLibraryTitle(event.currentTarget.value); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setLibraryTitleDraft(libraryName);
                  setEditingLibraryTitle(false);
                }
              }}
              className="h-7 w-auto min-w-[4ch] max-w-[170px] flex-none [field-sizing:content] border-0 bg-transparent px-0 text-sm font-medium text-[var(--foreground)] outline-none"
            /> : <span className="inline-flex h-full min-w-0 flex-1 items-center truncate text-sm font-medium text-[var(--foreground)]">{libraryName}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 px-5">
          <span className="text-sm text-[var(--muted-foreground)]">{t('mediaLibrary.itemCount', { count: visibleItems.length, more: hasMore ? '+' : '' })}</span>
          <span aria-hidden="true" className="h-[1em] w-px shrink-0 bg-[var(--border)]" />
          <div className="flex shrink-0 items-center gap-0">
            <Popover open={mediaFiltersOpen} onOpenChange={(open) => {
              setMediaFiltersOpen(open);
              if (open) {
                setMediaNameQuery(mediaLibraryFilter.file_name_contains ?? '');
                setMediaTypeQuery(mediaLibraryFilter.file_type ?? 'any');
                setMediaPathQuery(mediaLibraryFilter.path_contains ?? '');
              } else {
                setFolderPickerOpen(false);
                void saveMediaFilters();
              }
            }}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('mediaLibrary.filterLabel')}
                  title={t('mediaLibrary.filterLabel')}
                  className={`h-7 w-7 rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] data-[state=open]:bg-[var(--muted)] data-[state=open]:text-[var(--foreground)] ${mediaFiltersOpen || mediaFilterCount > 0 ? 'bg-[var(--muted)] text-[var(--foreground)]' : ''}`}
                ><FunnelIcon size={14} weight="bold" aria-hidden="true" /></Button>
              </PopoverTrigger>
              <PopoverContent align="end" side="bottom" sideOffset={0} fitViewport style={{ zIndex: 150 }} ignorePopoverOutside={folderPickerOpen} className="max-h-[min(70vh,420px)] w-[320px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl px-1 py-2 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <p className="agent-thread-card__codex-settings-title px-2">{t('multidimensionalTable.autoCollect.file')}</p>
                    {mediaDraftFilterCount > 0 && <button type="button" className="mx-2 rounded-lg px-2 py-1 text-xs text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]" onClick={() => {
                      setMediaNameQuery('');
                      setMediaTypeQuery('any');
                      setMediaPathQuery('');
                    }}>{t('mediaLibrary.clearFilters')}</button>}
                  </div>
                  <label className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-2 px-2">
                    <span className="px-0.5 text-sm text-[var(--foreground)]">{t('mediaLibrary.filterFileName')}</span>
                    <input
                      autoFocus
                      value={mediaNameQuery}
                      onChange={(event) => setMediaNameQuery(event.currentTarget.value)}
                      placeholder={t('mediaLibrary.filterFileNamePlaceholder')}
                      aria-label={t('mediaLibrary.filterFileName')}
                      className="h-8 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--brand)]"
                    />
                  </label>
                  <div className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-2 px-2">
                    <span className="px-0.5 text-sm text-[var(--foreground)]">{t('mediaLibrary.filterType')}</span>
                    <Select value={mediaTypeQuery} onValueChange={(value) => setMediaTypeQuery(value as 'any' | 'image' | 'video')}>
                      <SelectTrigger className="h-8 min-w-0 w-full rounded-lg bg-transparent px-2 text-left text-sm">
                        <SelectValue>{mediaTypeQuery === 'image' ? t('mediaLibrary.images') : mediaTypeQuery === 'video' ? t('mediaLibrary.videos') : t('mediaLibrary.all')}</SelectValue>
                      </SelectTrigger>
                      <SelectContent align="start" fitViewport style={{ zIndex: 170 }} className="flowix-preferences-select-content">
                        <SelectItem value="any">{t('mediaLibrary.all')}</SelectItem>
                        <SelectItem value="image">{t('mediaLibrary.images')}</SelectItem>
                        <SelectItem value="video">{t('mediaLibrary.videos')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-2 px-2">
                    <span className="px-0.5 text-sm text-[var(--foreground)]">{t('mediaLibrary.filterPath')}</span>
                    <Popover open={folderPickerOpen} onOpenChange={setFolderPickerOpen}>
                      <PopoverTrigger asChild>
                        <button type="button" disabled={!surface.notebookPath} className="flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-transparent px-2 text-left text-sm disabled:opacity-50">
                          <span className="min-w-0 truncate">{mediaPathQuery || t('mediaLibrary.chooseFolder')}</span>
                          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent side="bottom" align="start" sideOffset={4} style={{ zIndex: 170 }} className="max-h-[min(60vh,280px)] w-[260px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                        {folderOptionsLoading ? <p className="px-2 py-2 text-xs text-[var(--muted-foreground)]">{t('mediaLibrary.loadingFolders')}</p>
                          : <div className="space-y-0.5">
                            <button
                              type="button"
                              aria-pressed={!mediaPathQuery}
                              onClick={() => { setMediaPathQuery(''); setFolderPickerOpen(false); }}
                              className={`flex h-8 w-full items-center gap-2 rounded-lg pr-2 text-left text-sm hover:bg-[var(--muted)] ${!mediaPathQuery ? 'bg-[var(--muted)]' : ''}`}
                            >
                              <span className="flex min-w-0 flex-1 items-center gap-2 pl-2">
                                <ResourceFolderIcon expanded={false} className="h-[18px] w-[18px] shrink-0" />
                                <span className="min-w-0 truncate">{t('mediaLibrary.anyFolder')}</span>
                              </span>
                            </button>
                            {folderOptions.length === 0 ? <p className="px-2 py-2 text-xs text-[var(--muted-foreground)]">{t('mediaLibrary.noFolders')}</p> : folderOptions.map((option) => {
                              const segments = option.relativePath.split('/');
                              const folderName = segments[segments.length - 1] ?? option.relativePath;
                              const selected = mediaPathQuery === option.relativePath;
                              return <button
                                key={option.relativePath}
                                type="button"
                                title={option.relativePath}
                                aria-pressed={selected}
                                onClick={() => { setMediaPathQuery(option.relativePath); setFolderPickerOpen(false); }}
                                className={`flex h-8 w-full items-center gap-2 rounded-lg pr-2 text-left text-sm hover:bg-[var(--muted)] ${selected ? 'bg-[var(--muted)]' : ''}`}
                                style={{ paddingLeft: `${8 + option.depth * 16}px` }}
                              >
                                <ResourceFolderIcon expanded={false} className="h-[18px] w-[18px] shrink-0" />
                                <span className="min-w-0 truncate">{folderName}</span>
                              </button>;
                            })}
                          </div>}
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>
                <div className="mt-2 mx-2"><button type="button" className="flex h-8 w-full items-center justify-center rounded-lg border border-[var(--border)] bg-white text-sm text-gray-900 hover:bg-gray-100 disabled:opacity-50" onClick={() => void applyMediaFilters()}>{t('mediaLibrary.apply')}</button></div>
              </PopoverContent>
            </Popover>
            {onAddMedia && <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t('mediaLibrary.addMedia')}
              title={t('mediaLibrary.addMedia')}
              disabled={addingMedia || libraryActionsDisabled}
              onClick={() => {
                if (addingMedia) return;
                setAddingMedia(true);
                void onAddMedia().then((changed) => { if (changed) setRevision((value) => value + 1); }).catch((error) => {
                  toast.error(error instanceof Error ? error.message : t('mediaLibrary.addMediaFailed'));
                }).finally(() => setAddingMedia(false));
              }}
              className="h-7 w-7 rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
            ><PlusIcon size={14} weight="bold" aria-hidden="true" /></Button>}
            {onDeleteLibrary && <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t('mediaLibrary.deleteLibrary')}
              title={t('mediaLibrary.deleteLibrary')}
              disabled={libraryActionsDisabled}
              onClick={onDeleteLibrary}
              className="h-7 w-7 rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--destructive)]"
            ><TrashSimpleIcon size={14} weight="bold" aria-hidden="true" /></Button>}
          </div>
        </div>
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
        : (loading || (mediaLibrary && loadingLinkedItems)) && visibleItems.length === 0
        ? <div className="flex h-full min-h-[160px] items-center justify-center text-sm text-[var(--muted-foreground)]">正在整理文件列表…</div>
        : !loading && visibleItems.length === 0 && !(mediaLibrary && hasMore)
        ? <div className="flex h-full min-h-[160px] items-center justify-center text-sm text-[var(--muted-foreground)]">
              <div className="flex flex-col items-center text-center">
                <Inbox className="mb-3 h-10 w-10 opacity-50" strokeWidth={1.25} aria-hidden="true" />
                <span>{mediaLibrary ? (mediaFilterCount > 0 ? t('mediaLibrary.noMatches') : t('mediaLibrary.empty')) : '列表内容为空'}</span>
              </div>
            </div>
          : mediaLibrary && visibleItems.length === 0 && hasMore
            ? <div className="flex h-full min-h-[160px] items-center justify-center text-sm text-[var(--muted-foreground)]">{t('mediaLibrary.searchingMore')}</div>
          : mediaLibrary
            ? <div className="gap-0.5 pt-0" style={{ columns: '220px', columnGap: '2px', contentVisibility: 'auto', containIntrinsicSize: '1px 1000px' }}>{visibleItems.map((item) => {
              const manuallyAddedImage = item.resourceKind === 'image' && linkedMediaPathKeys.has(canonicalPath(item.fullPath).toLocaleLowerCase());
              return <div key={item.fullPath} className="break-inside-avoid py-px"><DocumentCard item={item} notebookPath={surface.notebookPath} openItem={openItem} mediaLibrary observeMediaCard={observeMediaCard} manuallyAddedImage={manuallyAddedImage} onRequestDelete={onDeleteManualMedia ? setManualMediaToDelete : undefined} deleteLabel={t('media.fileTree.delete')} deleteDisabled={libraryActionsDisabled || deletingManualMedia} /></div>;
            })}</div>
            : <div style={{ paddingTop: firstRow * rowHeight, paddingBottom: Math.max(0, rowCount - lastRow) * rowHeight }}><div className="grid w-full grid-cols-[repeat(auto-fill,minmax(min(100%,200px),1fr))] items-stretch gap-3.5 pt-3">{visibleCards.map((item) => <DocumentCard key={item.fullPath} item={item} notebookPath={surface.notebookPath} openItem={openItem} />)}</div></div>}
      {moreError && <button type="button" className="mt-4 rounded-lg px-2 py-1 text-sm text-[var(--brand)] hover:bg-[var(--muted)]" onClick={loadMore}>加载失败，点击重试</button>}
      {hasMore && !moreError && <div ref={endRef} className="h-1" aria-hidden="true" />}
    </div>
    {mediaLibrary && <Dialog open={!!manualMediaToDelete} onOpenChange={(open) => { if (!open && !deletingManualMedia) setManualMediaToDelete(null); }}>
      <DialogContent className="max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('media.fileTree.deleteTitle')}</DialogTitle>
          <DialogDescription>{t('media.fileTree.deleteDescription', { name: manualMediaToDelete?.name ?? '' })}</DialogDescription>
        </DialogHeader>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" className="rounded-lg" disabled={deletingManualMedia} onClick={() => setManualMediaToDelete(null)}>{t('dialog.cancel')}</Button>
          <Button type="button" variant="outline" size="sm" disabled={deletingManualMedia} onClick={() => void confirmDeleteManualMedia()} className="rounded-lg hover:border-[var(--destructive)] hover:bg-transparent hover:text-[var(--destructive)]">{t('dialog.delete')}</Button>
        </div>
      </DialogContent>
    </Dialog>}
    {!mediaLibrary && <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent className="max-w-sm"><DialogTitle>新建笔记</DialogTitle><form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void createNote(); }}><input autoFocus value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="笔记标题" className="h-9 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--brand)]" /><div className="flex justify-end gap-2"><Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={() => setCreateOpen(false)}>取消</Button><Button type="submit" size="sm" className="rounded-lg" disabled={!newTitle.trim() || creating}>创建</Button></div></form></DialogContent></Dialog>}
  </section>;
}
