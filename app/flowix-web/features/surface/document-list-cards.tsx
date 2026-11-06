'use client';

import { matchesAssetCollectionFilter } from '@features/collection/public/asset-filter-api';

/**
 * 集合列表里的三种卡片：图墙卡（媒体库）、工作文档卡、普通文件/文件夹卡。
 * 只负责「一张卡长什么样」，数据获取、筛选、滚动虚拟化都在 `document-list-view` 里。
 */
import { memo, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Folder, Play } from 'lucide-react';
import { TrashSimpleIcon } from '@phosphor-icons/react';
import { files, mediaResources, type DocumentPageItem } from '@platform/tauri/client';
import { externalFileViewKind, fileExtension, isCodeTextFilePath } from '@features/editor/public/code-file';
import { canonicalPath } from '@/lib/path';
import { useI18n } from '@/lib/i18n';
import { matchesMediaCollectionFilter } from '@features/media-library/public/model-api';
import { NoteContentIcon as NotebookTreeFileIcon, NotebookTreeResourceIcon } from '@features/content/public/content-api';
import { requestMediaPreview } from './media-preview-tasks';
import { Button } from '@shared/ui/button';
import { formatUpdatedAt, formatUpdatedAgo } from '@/lib/collection-updated-time';

import documentCardPlaceholder from '@/assets/placeholder-document-card.jpg';
import imageCardPlaceholder from '@/assets/placeholder-image-card.jpg';
import videoCardPlaceholder from '@/assets/placeholder-video-card.jpg';
import codeCardPlaceholder from '@/assets/placeholder-code-card.jpg';
import pdfCardPlaceholder from '@/assets/placeholder-pdf-card.jpg';
import pptCardPlaceholder from '@/assets/placeholder-ppt-card.jpg';
import excelCardPlaceholder from '@/assets/placeholder-excel-card.jpg';
import otherCardPlaceholder from '@/assets/placeholder-other-card.jpg';
import folderCardPlaceholder from '@/assets/placeholder-folder-card.png';

export const MEDIA_CARD_MIN_WIDTH = 160;
export const MEDIA_COLUMN_GAP = 2;
const MEDIA_CARD_ESTIMATED_HEIGHT = 320;
export const WORK_DOCUMENT_CARD_MIN_WIDTH = 200;
export const WORK_DOCUMENT_CARD_HEIGHT = 164;
export const WORK_DOCUMENT_GRID_GAP = 14;

export function cardPlaceholder(item: DocumentPageItem): string {
  if (item.resourceKind === 'folder') return folderCardPlaceholder;
  const extension = fileExtension(item.name);
  if (item.resourceKind === 'note' || ['md', 'markdown', 'doc', 'docx', 'odt', 'pages', 'wps', 'html', 'htm'].includes(extension)) return documentCardPlaceholder;
  if (item.resourceKind === 'image') return imageCardPlaceholder;
  if (item.resourceKind === 'video') return videoCardPlaceholder;
  if (extension === 'pdf') return pdfCardPlaceholder;
  if (['ppt', 'pptx', 'pps', 'ppsx', 'odp', 'key'].includes(extension)) return pptCardPlaceholder;
  if (['xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'tsv', 'ods'].includes(extension)) return excelCardPlaceholder;
  if (isCodeTextFilePath(item.fullPath)) return codeCardPlaceholder;
  return otherCardPlaceholder;
}

/** 文件相对笔记本的路径（图墙筛选条件用的就是这层路径）。 */
export function mediaItemRelativePath(filePath: string, notebookPath: string): string {
  const path = canonicalPath(filePath).replace(/\/+$/, '');
  const root = canonicalPath(notebookPath).replace(/\/+$/, '');
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path.split('/').pop() ?? '';
}

/** 文件所在目录（相对笔记本）；根目录显示 `.`。 */
export function mediaItemRelativeDirectory(filePath: string, notebookPath: string): string {
  return mediaItemRelativePath(filePath, notebookPath).split('/').slice(0, -1).join('/') || '.';
}

export function matchesMediaRuleFilter(item: DocumentPageItem, notebookPath: string, filter?: Record<string, unknown> | null): boolean {
  if (item.resourceKind !== 'image' && item.resourceKind !== 'video') return false;
  return matchesMediaCollectionFilter(mediaItemRelativePath(item.fullPath, notebookPath), item.resourceKind, filter);
}

/** 图墙的瀑布流列：按列虚拟化，追加一页时已有卡片留在原列（列数不变时）。 */
export const VirtualizedMediaColumn = memo(function VirtualizedMediaColumn({
  items,
  scrollerRef,
  scrollMargin,
  renderCard,
}: {
  items: readonly DocumentPageItem[];
  scrollerRef: RefObject<HTMLDivElement | null>;
  scrollMargin: number;
  renderCard: (item: DocumentPageItem) => ReactNode;
}) {
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollerRef.current,
    initialRect: { width: MEDIA_CARD_MIN_WIDTH, height: 600 },
    estimateSize: () => MEDIA_CARD_ESTIMATED_HEIGHT,
    getItemKey: (index) => items[index]?.fullPath ?? index,
    measureElement: (element) => {
      const measured = element.getBoundingClientRect().height;
      return measured > 0 ? measured : MEDIA_CARD_ESTIMATED_HEIGHT;
    },
    scrollMargin,
    gap: MEDIA_COLUMN_GAP,
    overscan: 4,
  });

  return (
    <div className="relative min-w-0 flex-1" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((virtualItem) => {
        const item = items[virtualItem.index];
        if (!item) return null;
        return (
          <div
            key={virtualItem.key}
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 top-0 w-full min-w-0 py-px"
            style={{ transform: `translateY(${virtualItem.start - scrollMargin}px)` }}
          >
            {renderCard(item)}
          </div>
        );
      })}
    </div>
  );
});

export const DocumentCard = memo(function DocumentCard({ item, notebookPath, openItem, mediaLibrary = false, observeMediaCard, onRequestDelete, deleteLabel, deleteDisabled = false }: { item: DocumentPageItem; notebookPath: string; openItem: (item: DocumentPageItem) => Promise<void>; mediaLibrary?: boolean; observeMediaCard?: (node: Element, onNear: () => void) => () => void; onRequestDelete?: (item: DocumentPageItem) => void; deleteLabel?: string; deleteDisabled?: boolean }) {
  const { t } = useI18n();
  const kind = mediaLibrary && (item.resourceKind === 'image' || item.resourceKind === 'video')
    ? item.resourceKind
    : item.resourceKind === 'folder' ? 'other' : externalFileViewKind(item.fullPath);
  const placeholder = cardPlaceholder(item);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [nearViewport, setNearViewport] = useState(false);
  const [cardHovered, setCardHovered] = useState(false);
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
  if (mediaLibrary) return <div className="group relative w-full break-inside-avoid" onMouseEnter={() => setCardHovered(true)} onMouseLeave={() => setCardHovered(false)}>
    <button type="button" disabled={opening} aria-busy={opening || previewLoading} onClick={() => {
    setOpening(true);
    void openItem(item).finally(() => setOpening(false));
  }} ref={cardRef} className="group flex w-full flex-col overflow-hidden rounded-[6px] border border-[var(--border)] bg-[var(--card)] text-left transition-colors hover:border-[color-mix(in_oklch,var(--border)_90%,var(--foreground)_10%)] disabled:cursor-wait disabled:opacity-70">
    <span className="relative block w-full overflow-hidden bg-[color-mix(in_srgb,var(--card)_94%,var(--foreground)_6%)]">
      {image}
      {previewLoading && <span aria-hidden="true" className="pointer-events-none absolute inset-0 animate-pulse bg-[var(--muted)]" />}
      {kind === 'video' && <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true"><span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/40 text-white shadow-lg backdrop-blur-sm"><Play className="ml-0.5 h-5 w-5 fill-current stroke-current" strokeWidth={1.5} /></span></span>}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-0.5 bg-gradient-to-t from-black/40 via-black/25 to-transparent px-2.5 pb-2 pt-8 text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
        <span className="truncate text-[11px] leading-4 text-white/75" title={mediaItemRelativeDirectory(item.fullPath, notebookPath)}>{mediaItemRelativeDirectory(item.fullPath, notebookPath)}</span>
        <span className="truncate text-[13px] font-medium leading-5" title={item.name}>{item.name}</span>
      </span>
    </span>
    </button>
    {item.resourceKind === 'image' && onRequestDelete && <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={deleteLabel}
      title={deleteLabel}
      disabled={deleteDisabled}
      onClick={() => onRequestDelete(item)}
      style={{ backgroundColor: 'color-mix(in srgb, var(--hover-bg) 36%, transparent)' }}
      className={`absolute right-2 top-2 z-10 h-7 w-7 rounded-lg p-0 text-[var(--foreground)] shadow-sm transition-[opacity,color] hover:text-[var(--destructive)] ${cardHovered ? 'opacity-100' : 'opacity-0 group-focus-within:opacity-100'}`}
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
        <span className="shrink-0 text-[11px] leading-4 text-white/75">{formatUpdatedAgo(item.modifiedMs, t)}</span>
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
        <span className="mt-0.5 block truncate text-[11px] leading-4 text-[var(--muted-foreground)]">{formatUpdatedAgo(item.modifiedMs, t)}</span>
      </span>
    </span>
    </>}
  </button>;
});

/** 工作文档卡片：顶部 16:9 预览区贴边（网页等出预览图，其余显示同侧边栏的文件图标）+ 底部最多两行标题（左对齐）与更新时间（文件树格式）。 */
export const WorkDocumentListRow = memo(function WorkDocumentListRow({ item, notebookPath, openItem }: { item: DocumentPageItem; notebookPath: string; openItem: (item: DocumentPageItem) => Promise<void> }) {
  const [opening, setOpening] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const { t, language } = useI18n();
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    if (!item.modifiedMs) return undefined;
    const task = requestMediaPreview(item.fullPath, notebookPath, 'document', item.modifiedMs);
    void task.promise.then((value) => {
      if (!cancelled) setPreview(value);
    });
    return () => {
      cancelled = true;
      task.cancel();
    };
  }, [item.fullPath, item.modifiedMs, notebookPath]);
  return <button type="button" disabled={opening} aria-busy={opening} title={item.name} onClick={() => {
    setOpening(true);
    void openItem(item).finally(() => setOpening(false));
  }} className="flex h-[164px] w-full min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] text-left transition-[background-color,border-color] hover:border-[color-mix(in_oklch,var(--border)_94%,var(--foreground)_6%)] hover:bg-[color-mix(in_oklch,var(--card)_98%,var(--foreground)_2%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:cursor-wait disabled:opacity-70">
    <span className="block h-[112px] w-full shrink-0 overflow-hidden bg-[color-mix(in_srgb,var(--card)_97%,var(--foreground)_3%)]">
      {preview
        ? <img src={preview} alt="" loading="lazy" className="h-full w-full object-cover object-top" />
        : <span className="flex h-full w-full items-center justify-center">
          <NotebookTreeResourceIcon path={item.fullPath} className="h-12 w-12 text-[var(--muted-foreground)]" />
        </span>}
    </span>
    <span className="mt-1.5 h-5 w-full min-w-0 truncate px-3 text-sm font-medium leading-5 text-[var(--foreground)]">{item.resourceKind === 'folder' ? item.name : item.name.replace(/\.[^.]+$/, '')}</span>
    {item.modifiedMs ? <span className="mt-0.5 w-full min-w-0 truncate px-3 pb-2 text-xs leading-4 text-[var(--muted-foreground)]">{t('collection.time.updated', { time: formatUpdatedAt(item.modifiedMs, language, t) })}</span> : null}
  </button>;
});

export function matchesAssetRuleFilter(item: DocumentPageItem, notebookPath: string, filter?: Record<string, unknown> | null): boolean {
  return matchesAssetCollectionFilter(mediaItemRelativePath(item.fullPath, notebookPath), item.assetKind ?? item.resourceKind, filter);
}
