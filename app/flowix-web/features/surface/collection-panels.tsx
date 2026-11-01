import { lazy, Suspense } from 'react';
import type { CollectionDomain } from '@features/collection/public/folder-api';
import { INACTIVE_COLLECTION_ACTIONS_HOST, type CollectionActionsHost } from '@shared/ui/collection-actions';
import { CollectionFilesTab } from './collection-files-tab';
import { COLLECTION_PANEL_FALLBACK } from './collection-panel-fallback';
import type { CollectionHostTabsState } from './use-collection-surface-state';
import type { WorkspaceSurfaceRenderContext } from './workspace-surface-renderer-contract';
import type { SurfaceLifecycle, SurfacePresentationUpdate } from '@features/workspace/public/surface-api';
import type { CollectionDatasetFilterTarget } from '@features/collection/public/dataset-filter-api';

const MediaLibraryView = lazy(() => import('@features/media-library/public/surface-api').then((module) => ({ default: module.MediaLibraryView })));
const WorkDocumentsCollectionView = lazy(() => import('./work-documents-collection-view').then((module) => ({ default: module.WorkDocumentsCollectionView })));

/** Panels retain state when hidden; the active panel or an open cross-domain filter owns the action slot. */
export function CollectionPanels({ tabs, domains, filesRoot, notebookId, notebookPath, host, indexPath, expectedCollectionId, actionsHost, datasetFilterOwner, onDatasetFilterVisibilityChange, onOpenNoteFilter, editable, onSurfaceLifecycleReady, reportPresentation }: {
  tabs: Pick<CollectionHostTabsState, 'active' | 'activeDomain' | 'activeViewId' | 'mounted' | 'showFiles'>;
  domains: readonly CollectionDomain[];
  filesRoot: string;
  notebookId: string | null;
  notebookPath: string | null;
  host: WorkspaceSurfaceRenderContext['host'];
  indexPath: string;
  expectedCollectionId?: string | null;
  actionsHost: CollectionActionsHost;
  datasetFilterOwner: CollectionDatasetFilterTarget | null;
  onDatasetFilterVisibilityChange: (target: CollectionDatasetFilterTarget, open: boolean) => void;
  onOpenNoteFilter?: () => void;
  editable: boolean;
  onSurfaceLifecycleReady?: (lifecycle: SurfaceLifecycle | null) => void;
  reportPresentation?: (update: SurfacePresentationUpdate) => void;
}) {
  return <>
    {/* 文件树随整页滚动：自己不设滚动容器、也不吃高度，表头 sticky 吸在 tab 条下沿。 */}
    {tabs.showFiles ? (
      <div className={tabs.active === 'files' ? 'flex flex-col' : 'hidden'}>
        <CollectionFilesTab rootPath={filesRoot} notebookId={notebookId} notebookPath={notebookPath} host={host} />
      </div>
    ) : null}
    {/* 图墙与列表都自然撑开，虚拟化和翻页订阅外壳滚动，不再创建内部滚动区。
        同一域的面板保持挂载，切 tab 只切可见性与操作区归属。 */}
    {tabs.mounted.includes('media') && domains.includes('media') ? (
      <div className={tabs.activeDomain === 'media' ? 'flex flex-col px-4' : 'hidden'}>
        <Suspense fallback={COLLECTION_PANEL_FALLBACK}>
          <MediaLibraryView
            pageScroll
            editable={editable}
            activeViewId={tabs.activeViewId}
            onSurfaceLifecycleReady={tabs.activeDomain === 'media' ? onSurfaceLifecycleReady : undefined}
            reportPresentation={tabs.activeDomain === 'media' ? reportPresentation : undefined}
            filePath={indexPath}
            notebookPath={notebookPath}
            notebookId={notebookId}
            expectedCollectionId={expectedCollectionId}
            workspaceHost={host}
            actionsHost={datasetFilterOwner === 'media' || (datasetFilterOwner === null && tabs.activeDomain === 'media') ? actionsHost : INACTIVE_COLLECTION_ACTIONS_HOST}
            onOpenNoteFilter={onOpenNoteFilter}
            onDatasetFilterOpenChange={(open) => onDatasetFilterVisibilityChange('media', open)}
          />
        </Suspense>
      </div>
    ) : null}
    {tabs.mounted.includes('work_documents') && domains.includes('work_documents') ? (
      /* 列表（工作文档域）：整页滚动下的流式面板——列表自然撑开，滚动交给页面滚动容器
          （不锁 `--collection-content-h`，那会让它内部滚动）。 */
      <div className={tabs.activeDomain === 'work_documents' ? 'flex flex-col px-4' : 'hidden'}>
        <Suspense fallback={COLLECTION_PANEL_FALLBACK}>
          <WorkDocumentsCollectionView
            editable={editable}
            activeViewId={tabs.activeViewId}
            onSurfaceLifecycleReady={tabs.activeDomain === 'work_documents' ? onSurfaceLifecycleReady : undefined}
            reportPresentation={tabs.activeDomain === 'work_documents' ? reportPresentation : undefined}
            filePath={indexPath}
            notebookPath={notebookPath}
            notebookId={notebookId}
            expectedCollectionId={expectedCollectionId}
            workspaceHost={host}
            actionsHost={datasetFilterOwner === 'work_documents' || (datasetFilterOwner === null && tabs.activeDomain === 'work_documents') ? actionsHost : INACTIVE_COLLECTION_ACTIONS_HOST}
            onOpenNoteFilter={onOpenNoteFilter}
            onDatasetFilterOpenChange={(open) => onDatasetFilterVisibilityChange('work_documents', open)}
            pageScroll
          />
        </Suspense>
      </div>
    ) : null}
  </>;
}
