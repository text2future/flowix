import type { ReactNode } from 'react';
import { ContentIcon } from '@features/content/public/content-api';
import { getPropertyIconOption } from '@features/document/public/property-display-api';
import type { CollectionDomain } from './model';
import { useCollectionSummary } from './use-collection-summary';

export type CollectionDefaultIcon = 'multidimensional-table' | 'media-library';

/** The tab strip puts note views first, then asset views; the file-tree tab is navigation. */
export function collectionDefaultIcon(views: readonly { domain: CollectionDomain }[]): CollectionDefaultIcon {
  return views.some((view) => view.domain === 'notes') || views.length === 0
    ? 'multidimensional-table' : 'media-library';
}

export function CollectionIcon({ defaultIcon = 'multidimensional-table', iconSrc, className }: {
  defaultIcon?: CollectionDefaultIcon; iconSrc?: string; className?: string;
}) {
  return iconSrc
    ? <img src={iconSrc} alt="" className={className} draggable={false} />
    : <ContentIcon content={{ kind: defaultIcon }} className={className} />;
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
