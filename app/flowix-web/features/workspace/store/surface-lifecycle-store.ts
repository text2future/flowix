import type { SurfaceLifecycle, WorkspaceColumnId } from '../model/surface-contract';

const defaultOwner = {};
const lifecycles = new Map<string, { owner: object; lifecycle: SurfaceLifecycle }>();
const subscribers = new Map<string, Set<() => void>>();
const hostViews = new Map<WorkspaceColumnId, { viewId: string }>();

/** Hosts identify the mounted view; navigation need not reconstruct renderer IDs. */
export function registerWorkspaceColumnIdView(host: WorkspaceColumnId, viewId: string): () => void {
  const registration = { viewId };
  hostViews.set(host, registration);
  return () => {
    if (hostViews.get(host) === registration) hostViews.delete(host);
  };
}

export function getWorkspaceHostSurfaceLifecycle(host: WorkspaceColumnId): SurfaceLifecycle | null {
  const view = hostViews.get(host);
  return view ? getWorkspaceSurfaceLifecycle(view.viewId) : null;
}

function emit(viewId: string) {
  subscribers.get(viewId)?.forEach((listener) => listener());
}

/** Register or remove the live lifecycle handlers owned by one surface view. */
export function registerWorkspaceSurfaceLifecycle(viewId: string, lifecycle: SurfaceLifecycle | null, owner: object = defaultOwner): void {
  const previous = lifecycles.get(viewId);
  if (lifecycle === null) {
    if (!previous || previous.owner !== owner) return;
    lifecycles.delete(viewId);
    try { previous.lifecycle.dispose?.(); }
    finally { emit(viewId); }
    return;
  }
  if (previous?.lifecycle === lifecycle && previous.owner === owner) return;
  lifecycles.set(viewId, { owner, lifecycle });
  try {
    if (previous && previous.owner !== owner) previous.lifecycle.dispose?.();
  } finally { emit(viewId); }
}

export function getWorkspaceSurfaceLifecycle(viewId: string): SurfaceLifecycle | null {
  return lifecycles.get(viewId)?.lifecycle ?? null;
}

export function subscribeWorkspaceSurfaceLifecycle(viewId: string, listener: () => void): () => void {
  const viewSubscribers = subscribers.get(viewId) ?? new Set<() => void>();
  viewSubscribers.add(listener);
  subscribers.set(viewId, viewSubscribers);
  return () => {
    viewSubscribers.delete(listener);
    if (viewSubscribers.size === 0) subscribers.delete(viewId);
  };
}

/** Snapshot all mounted surfaces, including background/browser-column views. */
export function listWorkspaceSurfaceLifecycles(): SurfaceLifecycle[] {
  return [...new Set([...lifecycles.values()].map(entry => entry.lifecycle))];
}
