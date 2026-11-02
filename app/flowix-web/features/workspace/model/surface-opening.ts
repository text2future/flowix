import type { MarkdownLocation } from '@platform/tauri/client';
import type { WorkWorkspaceSurfaceTarget, BrowserWorkspaceSurfaceTarget } from './surface-target';

export type RuntimeWorkspaceContentLocation =
  | { host: 'main-third'; state: 'active' | 'pending' }
  | { host: 'browser-column'; surfaceId: string };

/** Physical placement plus the stable runtime address used by legacy editor ports. */
export type WorkspaceContentLocation = RuntimeWorkspaceContentLocation & {
  runtimeLocation?: RuntimeWorkspaceContentLocation;
};

export interface WorkspaceOpenNavigationOptions {
  history?: 'push' | 'skip';
  /** Replay an existing session entry without changing its Surface identity. */
  navigationEntryId?: string;
  /** Re-resolve and commit an already-open collection after its backing file changes. */
  refresh?: boolean;
}
export interface WorkWorkspaceSurfaceOptions extends WorkspaceOpenNavigationOptions {
  notebookId?: string | null;
  markdownLocation?: MarkdownLocation | null;
  initialFocus?: 'title' | 'body';
}
export type BrowserWorkspaceSurfaceOptions = WorkWorkspaceSurfaceOptions;
export type WorkspaceNavigationSource = 'notebook-tree' | 'notebook-tree-new-tab' | 'agent-message' | 'html-link';

export interface WorkWorkspaceSurfaceRequest {
  source?: WorkspaceNavigationSource;
  /** Callers own the destination; focus and runtime state must not infer it. */
  host: 'main-third';
  target: WorkWorkspaceSurfaceTarget;
  options?: WorkWorkspaceSurfaceOptions;
}
export interface BrowserWorkspaceSurfaceRequest {
  source?: WorkspaceNavigationSource;
  host: 'browser-column';
  target: BrowserWorkspaceSurfaceTarget;
  options?: BrowserWorkspaceSurfaceOptions;
}
export type OpenWorkspaceSurfaceRequest = WorkWorkspaceSurfaceRequest | BrowserWorkspaceSurfaceRequest;
export type WorkWorkspaceOpenResult =
  | { status: 'opened' | 'activated'; host: 'main-third'; location: Extract<WorkspaceContentLocation, { host: 'main-third' }> }
  | { status: 'cancelled'; host: 'main-third'; reason: 'navigation-cancelled' };
export type BrowserWorkspaceOpenResult =
  | { status: 'opened' | 'activated'; host: 'browser-column'; location: Extract<WorkspaceContentLocation, { host: 'browser-column' }> }
  | { status: 'cancelled'; host: 'browser-column'; reason: 'navigation-cancelled' };
export type WorkspaceSurfaceOpenResult = WorkWorkspaceOpenResult | BrowserWorkspaceOpenResult;
/** Internal Browser adapter detail, normalized by openWorkspaceSurface. */
export type BrowserColumnNavigationResult = {
  host: 'browser-column';
  surfaceId: string;
  alreadyOpen: boolean;
} | null;
