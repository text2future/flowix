import { getSessionRuntimeAtHost } from '../store/workspace-session-store';
import { openWorkspaceSurface as openRuntimeSurface } from './surface-opening';
import { useBrowserColumnStore } from '../store/browser-column-store';
import type {
  OpenWorkspaceSurfaceRequest, BrowserWorkspaceSurfaceRequest, WorkWorkspaceSurfaceRequest,
  WorkWorkspaceOpenResult, BrowserWorkspaceOpenResult, WorkspaceSurfaceOpenResult,
} from '../model/surface-opening';

export function openWorkspaceSurface(request: WorkWorkspaceSurfaceRequest): Promise<WorkWorkspaceOpenResult>;
export function openWorkspaceSurface(request: BrowserWorkspaceSurfaceRequest): Promise<BrowserWorkspaceOpenResult>;
export function openWorkspaceSurface(request: OpenWorkspaceSurfaceRequest): Promise<WorkspaceSurfaceOpenResult>;
/** Public hosts refer to physical containers; adapters are selected by session placement. */
export async function openWorkspaceSurface(request: OpenWorkspaceSurfaceRequest): Promise<WorkspaceSurfaceOpenResult> {
  const runtime = getSessionRuntimeAtHost(request.host);
  if (runtime === request.host) return openRuntimeSurface(request);

  let result: WorkspaceSurfaceOpenResult;
  if (runtime === 'main-third') {
    const target = request.target;
    if (!target) return { status: 'cancelled', host: request.host, reason: 'navigation-cancelled' };
    result = await openRuntimeSurface({ ...request, host: 'main-third', target });
  } else {
    result = await openRuntimeSurface({ ...request, host: 'browser-column', target: request.target });
  }
  if (result.status === 'cancelled') return { ...result, host: request.host };
  if (request.host === 'browser-column') {
    useBrowserColumnStore.getState().setVisible(true);
    return { status: result.status, host: 'browser-column', location: { host: 'browser-column', surfaceId: 'primary-session', runtimeLocation: result.location } };
  }
  return { status: result.status, host: 'main-third', location: { host: 'main-third', state: 'active', runtimeLocation: result.location } };
}
