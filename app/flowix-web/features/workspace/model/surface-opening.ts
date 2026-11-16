import type { MarkdownLocation } from '@platform/tauri/client';
import type { OpenableWorkspaceSurfaceTarget } from './surface-target';
import type { WorkspaceColumnId } from './workspace-session';

export type RuntimeWorkspaceContentLocation =
  | { host: 'column-1'; state: 'active' | 'pending' }
  | { host: 'column-2'; surfaceId: string };

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
export interface WorkspaceSurfaceOpenOptions extends WorkspaceOpenNavigationOptions {
  notebookId?: string | null;
  markdownLocation?: MarkdownLocation | null;
  initialFocus?: 'title' | 'body';
}
export type WorkspaceNavigationSource = 'notebook-tree' | 'notebook-tree-new-tab' | 'agent-message' | 'html-link';

/** One open protocol for every column; only `host` selects the destination. */
export interface WorkspaceSurfaceOpenRequest {
  source?: WorkspaceNavigationSource;
  /** Callers own the destination; focus and runtime state must not infer it. */
  host: WorkspaceColumnId;
  target: OpenableWorkspaceSurfaceTarget;
  options?: WorkspaceSurfaceOpenOptions;
}
export type MainWorkspaceOpenResult =
  | { status: 'opened' | 'activated'; host: 'column-1'; location: Extract<WorkspaceContentLocation, { host: 'column-1' }> }
  | { status: 'cancelled'; host: 'column-1'; reason: 'navigation-cancelled' };
export type BrowserWorkspaceOpenResult =
  | { status: 'opened' | 'activated'; host: 'column-2'; location: Extract<WorkspaceContentLocation, { host: 'column-2' }> }
  | { status: 'cancelled'; host: 'column-2'; reason: 'navigation-cancelled' };
export type WorkspaceSurfaceOpenResult = MainWorkspaceOpenResult | BrowserWorkspaceOpenResult;
/** Internal Browser adapter detail, normalized by openWorkspaceSurface. */
export type BrowserColumnNavigationResult = {
  host: 'column-2';
  surfaceId: string;
  alreadyOpen: boolean;
} | null;
