import { forwardRef, type ReactNode } from 'react';
import type { IconProps } from '@phosphor-icons/react';
import { getPropertyIconOption } from '@features/document/public/property-display-api';
import type { CollectionDomain } from './model';
import { useCollectionSummary } from './use-collection-summary';

export type CollectionDefaultIcon = 'multidimensional-table' | 'media-library';

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

export function CollectionIcon({ iconSrc, className }: {
  /** 链路兼容保留：默认图形已统一为数据库图标，不再按视图域区分。 */
  defaultIcon?: CollectionDefaultIcon; iconSrc?: string; className?: string;
}) {
  return iconSrc
    ? <img src={iconSrc} alt="" className={className} draggable={false} />
    : <CollectionDatabaseIcon className={className} />;
}

/** Rows share persisted overrides; sidebars can supply a folder default for folder collections. */
export function CollectionResourceIcon({ filePath, notebookPath, fallbackType, fallback, folderDefault, className }: {
  filePath: string; notebookPath: string | null; fallbackType?: string; fallback?: ReactNode; folderDefault?: ReactNode; className?: string;
}) {
  const [snapshot] = useCollectionSummary(filePath, notebookPath, null);
  const summary = snapshot && snapshot !== 'missing' ? snapshot : null;
  if (!summary && fallback !== undefined) return fallback;
  const value = summary?.properties?.icon?.value;
  const iconSrc = typeof value === 'string' ? getPropertyIconOption(value)?.src : undefined;
  if (!iconSrc && folderDefault !== undefined) return folderDefault;
  const defaultIcon = summary ? collectionDefaultIcon(summary.views)
    : fallbackType === 'media_library' || fallbackType === 'work_documents' ? 'media-library' : 'multidimensional-table';
  return <CollectionIcon defaultIcon={defaultIcon} iconSrc={iconSrc} className={className} />;
}
