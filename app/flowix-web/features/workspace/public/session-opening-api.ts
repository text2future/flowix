import { openWorkspaceSurface as openInRuntime, openPreparedWorkspaceSurface as openPreparedInRuntime } from '../use-cases/surface-opening';
import { useWorkspaceSessionStore } from '../store/workspace-session-store';
import type { WorkspaceColumnId } from '../model/workspace-session';
import type { OpenableWorkspaceSurfaceTarget } from '../model/surface-target';
import type { WorkspaceSurfaceOpenOptions, WorkspaceNavigationSource, WorkspaceSurfaceOpenResult } from '../model/surface-opening';

export interface OpenSurfaceInColumnRequest {
  columnId: WorkspaceColumnId;
  target: OpenableWorkspaceSurfaceTarget;
  options?: WorkspaceSurfaceOpenOptions;
  source?: WorkspaceNavigationSource;
}
/** Column-local actions retain their owning instance even after it changes position. */
export function openSurfaceInColumn({ columnId, ...request }: OpenSurfaceInColumnRequest): Promise<WorkspaceSurfaceOpenResult> {
  const store = useWorkspaceSessionStore.getState();
  if (store.placement[1] === columnId) store.setBrowserLayout({ visible: true });
  return openInRuntime({ ...request, host: columnId });
}

/** Capture the destination before asynchronous target classification starts. */
export function openPreparedSurfaceInColumn(
  { columnId, ...request }: OpenSurfaceInColumnRequest,
  prepare: (isCurrent: () => boolean) => Promise<Pick<OpenSurfaceInColumnRequest, 'target' | 'options'>>,
): Promise<WorkspaceSurfaceOpenResult> {
  const store = useWorkspaceSessionStore.getState();
  if (store.placement[1] === columnId) store.setBrowserLayout({ visible: true });
  return openPreparedInRuntime({ ...request, host: columnId }, prepare);
}
