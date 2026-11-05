import { openWorkspaceSurface as openInRuntime } from '../use-cases/surface-opening';
import { useWorkspaceSessionStore } from '../store/workspace-session-store';
import type { WorkspaceColumnId } from '../model/workspace-session';
import type { WorkWorkspaceSurfaceTarget } from '../model/surface-target';
import type { WorkWorkspaceSurfaceOptions, WorkspaceNavigationSource, WorkspaceSurfaceOpenResult } from '../model/surface-opening';

export interface OpenColumnRequest {
  columnId: WorkspaceColumnId;
  target: WorkWorkspaceSurfaceTarget;
  options?: WorkWorkspaceSurfaceOptions;
  source?: WorkspaceNavigationSource;
}
/** Column-local actions retain their owning instance even after it changes position. */
export function openWorkspaceSurface({ columnId, ...request }: OpenColumnRequest): Promise<WorkspaceSurfaceOpenResult> {
  const store = useWorkspaceSessionStore.getState();
  if (store.placement[1] === columnId) store.setBrowserLayout({ visible: true });
  return openInRuntime({ ...request, host: columnId });
}
