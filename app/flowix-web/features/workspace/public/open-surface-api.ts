import { openWorkspaceSurface as openInRuntime } from '../use-cases/surface-opening';
import { useWorkspaceSessionStore } from '../store/workspace-session-store';
import type { OpenableWorkspaceSurfaceTarget } from '../model/surface-target';
import type { WorkspaceColumnIndex } from '../model/workspace-session';
import type { WorkspaceSurfaceOpenOptions, WorkspaceNavigationSource, WorkspaceSurfaceOpenResult } from '../model/surface-opening';

/** Position-based opening captures the column before any asynchronous preparation. */
export interface OpenSurfaceAtPositionRequest {
  index: WorkspaceColumnIndex;
  target: OpenableWorkspaceSurfaceTarget;
  options?: WorkspaceSurfaceOpenOptions;
  source?: WorkspaceNavigationSource;
}
export function openSurfaceAtPosition(request: OpenSurfaceAtPositionRequest): Promise<WorkspaceSurfaceOpenResult> {
  const store = useWorkspaceSessionStore.getState();
  const columnId = store.placement[request.index];
  if (request.index === 1) store.setBrowserLayout({ visible: true });
  const { index: _index, ...rest } = request;
  return openInRuntime({ ...rest, host: columnId });
}
export type * from '../model/surface-opening';
export type { WorkspaceSurfaceOpenTarget, OpenableWorkspaceSurfaceTarget, CollectionReferenceSurfaceTarget } from '../model/surface-target';
