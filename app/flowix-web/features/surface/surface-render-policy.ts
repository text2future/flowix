import type { WorkspaceColumnId } from '@features/workspace/public/surface-api';

/**
 * Which side paints the dedicated loading layer for a surface.
 *
 * The main column reuses the column header's own loading layer, so its surfaces
 * must not paint a second centered loader; the secondary column has no such
 * header contract and owns its loader.
 */
export type SurfaceLoadingOwner = 'host' | 'surface';

/**
 * Which side wraps a file surface in the file tree shell.
 *
 * The main column renders `CodeSurfaceFileBrowser` itself (it predates the
 * `wrapInFileBrowser` port); the secondary column passes the shell down through
 * the render context because its file tree belongs to the column, not the surface.
 */
export type SurfaceFileShellOwner = 'surface' | 'host';

/** Which column instance a collection active-view write belongs to. */
export type CollectionSurfaceLocation =
  | { host: 'column-1' }
  | { host: 'column-2'; surfaceId: string };

/**
 * Everything a renderer may not know about its column.
 *
 * Renderers only see `WorkspaceSurfaceRendererData`; the column they are mounted
 * in used to leak into them as `context.host === 'column-1'` checks. Those checks
 * are decisions about the *column*, so they are declared once, per column, here.
 * `context.host` itself stays available for what is genuinely column identity:
 * capability lookup, session id, and the `workspaceHost` document prop.
 */
export interface SurfaceRenderPolicy {
  loadingOwner: SurfaceLoadingOwner;
  /**
   * View id a document session may use as its navigation location.
   * Undefined means the column owns navigation history (the main column reuses
   * the session's own id).
   */
  navigationViewId?: string;
  fileShell: SurfaceFileShellOwner;
  collectionLocation: CollectionSurfaceLocation;
}

/** Declare the per-column render decisions. Behavior must stay equal to the old inline checks. */
export function surfaceRenderPolicy(columnId: WorkspaceColumnId, viewId: string): SurfaceRenderPolicy {
  return columnId === 'column-1'
    ? { loadingOwner: 'host', navigationViewId: undefined, fileShell: 'surface', collectionLocation: { host: 'column-1' } }
    : { loadingOwner: 'surface', navigationViewId: viewId, fileShell: 'host', collectionLocation: { host: 'column-2', surfaceId: viewId } };
}
