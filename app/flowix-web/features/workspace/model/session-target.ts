import type { FileBrowserTarget, WorkspaceContentTarget } from './surface-target';

/** A resolved target has the same shape in every session and container. */
export type SessionSurfaceTarget = FileBrowserTarget | Exclude<WorkspaceContentTarget, { kind: 'external' }>
  | (Extract<WorkspaceContentTarget, { kind: 'external' }> & { transitionId: number | null });
