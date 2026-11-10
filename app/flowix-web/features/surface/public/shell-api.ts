export {
  WorkColumnContentHost,
  WorkColumnSurfaceHost,
  getWorkColumnSurfaceDefinition,
  surfaceSupports,
} from '@features/surface/registry';
export { resolveWorkColumnContent } from '@features/surface/resolver';
export {
  resolveWorkColumnRuntimePresentation,
  resolveWorkColumnPresentation,
} from '@features/surface/presentation';
export type {
  WorkColumnDocumentHeaderPresentation,
  WorkColumnHeaderPresentation,
  WorkColumnPresentation,
} from '@features/surface/presentation';
export type {
  CodeSurface,
  DocumentSurfaceContext,
  ExternalDocumentProps,
  HtmlFileSurface,
  ImageFileSurface,
  MDSurface,
  UnavailableFileSurface,
  VideoFileSurface,
  WorkColumnContentPresentation,
  WorkColumnEmptyStateTone,
} from '@features/surface/types';
export {
  BrowserColumnSurfaceHost,
  getBrowserColumnSurfaceDefinition,
  type BrowserColumnSurface,
  type BrowserColumnSurfaceChrome,
} from '@features/surface/browser-column-registry';
export { resolveBrowserColumnSurface } from '@features/surface/browser-column-registry';
export {
  WorkspaceSurfaceRendererView,
  getWorkspaceSurfaceRendererDefinition,
  workspaceSurfaceRendererRegistry,
  workspaceSurfaceRendererSupportsHost,
} from '@features/surface/workspace-surface-renderer-registry';
export type {
  WorkspaceSurfaceRendererData,
  WorkspaceSurfaceRendererDefinition,
  WorkspaceSurfaceRenderContext,
} from '@features/surface/workspace-surface-renderer-registry';
export { WorkspaceSurfaceStateView } from '@features/surface/workspace-surface-state-view';
export {
  beginWorkspaceSurfaceStartup,
  waitForWorkspaceSurfaceStartup,
  useWorkspaceSurfacePresentation,
} from '@features/surface/workspace-surface-runtime';
/** 资源文件夹图标（seti 主题）：供跨 feature 的文件夹选择器等 surface 复用。 */
export { ResourceFolderIcon } from '@features/surface/resource-file-icon';
/** 文档标题栏面包屑：统一根目录解析（scope → 笔记本归属 → 文件树根），文件段按文件树口径隐藏后缀。 */
export { resolveDocumentBreadcrumb } from '@features/surface/file-browser-breadcrumb';

export { collectionIndexPath, browserCollectionIndexPath } from '../collection-frame';
