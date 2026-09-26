export {
  WorkColumnContentHost,
  WorkColumnSurfaceHost,
  getWorkColumnSurfaceDefinition,
  surfaceSupports,
} from '@features/surface/registry';
export { resolveWorkColumnContent } from '@features/surface/resolver';
export { resolveWorkColumnPresentation } from '@features/surface/presentation';
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
  NoteSurface,
  UnavailableFileSurface,
  VideoFileSurface,
  WorkColumnContentPresentation,
  WorkColumnEmptyStateTone,
} from '@features/surface/types';
export {
  BrowserColumnSurfaceHost,
  getBrowserColumnSurfaceDefinition,
  type BrowserColumnFlushRegistration,
  type BrowserColumnSurface,
  type BrowserColumnSurfaceChrome,
} from '@features/surface/browser-column-registry';
export { resolveBrowserColumnSurface } from '@features/surface/browser-column-registry';
