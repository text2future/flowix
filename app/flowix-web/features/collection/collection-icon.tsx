import { forwardRef, useEffect, useRef, useState, type ReactNode } from 'react';
import type { IconProps } from '@phosphor-icons/react';
import { getPropertyIconOption } from '@features/document/public/property-display-api';
import type { CollectionDomain } from './model';
import { useFolderAppearance } from './folder-appearance';
import { useCollectionSummary } from './use-collection-summary';

export type CollectionDefaultIcon = 'multidimensional-table' | 'media-library' | 'folder';

/** The tab strip puts note views first, then asset views; the file-tree tab is navigation. */
export function collectionDefaultIcon(views: readonly { domain: CollectionDomain }[]): CollectionDefaultIcon {
  return views.some((view) => view.domain === 'notes') || views.length === 0
    ? 'multidimensional-table' : 'media-library';
}

/**
 * 集合的默认图标 ── 数据库（圆柱体）造型，覆盖原来的表格 / 媒体库默认图形。
 * header（头图下缘 / 标题行内）与树行（文件树 tab、侧边栏、访问空间）共用同一份默认，
 * 与 `TableDocumentIcon` / `MediaLibraryIcon` 共用 viewBox、缩放、描边和透明度，
 * 保证在 h-12 / h-7 / 18px 等尺寸下视觉粗细一致。
 * 保留 Phosphor 兼容组件（forwardRef + IconProps），便于直接替换既有图标位。
 */
export const CollectionDatabaseIcon = forwardRef<SVGSVGElement, IconProps>(
  function CollectionDatabaseIcon({ className }, ref) {
    return (
      <svg ref={ref} xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 18 18" fill="none" opacity={0.6} aria-hidden="true" className={className}>
        <g transform="translate(1.5 1.5) scale(0.625)" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M3 5v14a9 3 0 0 0 18 0V5" />
          <path d="M3 12a9 3 0 0 0 18 0" />
        </g>
      </svg>
    );
  },
);

/**
 * 文件夹的默认图标 ── 与文件树 / 文件列表行内那枚 folder-outline 同形。
 * 文件夹表面不再有集合视图，标题旁不该继续显示数据库图标。
 */
export const CollectionFolderIcon = forwardRef<SVGSVGElement, IconProps>(
  function CollectionFolderIcon({ className }, ref) {
    return (
      <svg ref={ref} xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 18 18" fill="none" opacity={0.6} aria-hidden="true" className={className}>
        <path d="M13.75 5.25C14.855 5.25 15.75 6.145 15.75 7.25V12.75C15.75 13.855 14.855 14.75 13.75 14.75H4.25C3.145 14.75 2.25 13.855 2.25 12.75V4.75C2.25 3.645 3.145 2.75 4.25 2.75H6.075C6.662 2.75 7.219 3.008 7.599 3.455L9.123 5.25H13.749H13.75Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  },
);

export function CollectionIcon({ iconSrc, className, defaultIcon }: {
  defaultIcon?: CollectionDefaultIcon; iconSrc?: string; className?: string;
}) {
  if (iconSrc) return <img src={iconSrc} alt="" className={className} draggable={false} />;
  return defaultIcon === 'folder'
    ? <CollectionFolderIcon className={className} />
    : <CollectionDatabaseIcon className={className} />;
}

/** Rows share persisted overrides; sidebars can supply a folder default for folder collections. */
interface CollectionResourceIconProps {
  filePath?: string;
  /** 文件夹行给出目录路径：图标来自 `folder_index` 表，不再读目录里的 `.index.yaml`。 */
  folderPath?: string;
  notebookPath: string | null;
  notebookId?: string | null;
  fallbackType?: string;
  fallback?: ReactNode;
  folderDefault?: ReactNode;
  className?: string;
  /** Defer summary reads until the icon approaches the visible scroll area. */
  loadWhenVisible?: boolean;
}

function defaultResourceIcon(fallbackType?: string): CollectionDefaultIcon {
  return fallbackType === 'media_library' || fallbackType === 'work_documents'
    ? 'media-library' : 'multidimensional-table';
}

function FolderResourceIcon({ folderPath, notebookPath, notebookId, fallback, folderDefault, className }: CollectionResourceIconProps) {
  const properties = useFolderAppearance(notebookPath, folderPath ?? null, notebookId ?? null);
  const value = properties?.icon?.value;
  const iconSrc = typeof value === 'string' ? getPropertyIconOption(value)?.src : undefined;
  if (iconSrc) return <CollectionIcon iconSrc={iconSrc} className={className} />;
  if (folderDefault !== undefined) return <>{folderDefault}</>;
  if (fallback !== undefined) return <>{fallback}</>;
  return <CollectionIcon className={className} />;
}

function LoadedCollectionResourceIcon({ filePath, notebookPath, fallbackType, fallback, folderDefault, className }: CollectionResourceIconProps) {
  const [snapshot] = useCollectionSummary(filePath ?? '', notebookPath, null);
  const summary = snapshot && snapshot !== 'missing' ? snapshot : null;
  if (!summary && fallback !== undefined) return fallback;
  const value = summary?.properties?.icon?.value;
  const iconSrc = typeof value === 'string' ? getPropertyIconOption(value)?.src : undefined;
  if (!iconSrc && folderDefault !== undefined) return folderDefault;
  const defaultIcon = summary ? collectionDefaultIcon(summary.views) : defaultResourceIcon(fallbackType);
  return <CollectionIcon defaultIcon={defaultIcon} iconSrc={iconSrc} className={className} />;
}

function VisibleCollectionResourceIcon(props: CollectionResourceIconProps) {
  const targetRef = useRef<HTMLSpanElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const target = targetRef.current;
    if (!target || visible) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: '48px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [visible]);

  const { className, fallback, folderDefault, fallbackType } = props;
  const placeholder = fallback ?? folderDefault ?? (
    <CollectionIcon defaultIcon={defaultResourceIcon(fallbackType)} className="h-full w-full object-contain" />
  );
  return (
    <span ref={targetRef} aria-hidden="true" className={`inline-flex ${className ?? ''}`}>
      {visible
        ? <LoadedCollectionResourceIcon
            filePath={props.filePath}
            notebookPath={props.notebookPath}
            fallbackType={fallbackType}
            fallback={fallback}
            folderDefault={folderDefault}
            className="h-full w-full object-contain"
          />
        : placeholder}
    </span>
  );
}

export function CollectionResourceIcon(props: CollectionResourceIconProps) {
  if (props.folderPath) return <FolderResourceIcon {...props} />;
  return props.loadWhenVisible
    ? <VisibleCollectionResourceIcon {...props} />
    : <LoadedCollectionResourceIcon {...props} />;
}
