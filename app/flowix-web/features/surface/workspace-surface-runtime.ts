import { useSyncExternalStore } from 'react';
import type { SurfacePresentationUpdate, SurfaceState, WorkspaceColumnId } from '@features/workspace/model/surface-contract';

const snapshots = new Map<string, Readonly<SurfacePresentationUpdate>>();
const listeners = new Map<string, Set<() => void>>();
const owners = new Map<string, object>();
const pendingUpdates = new Map<string, { owner: object; update: Readonly<SurfacePresentationUpdate> }>();
const hostViews = new Map<WorkspaceColumnId, string>();
const startupListeners = new Set<() => void>();
let startupHosts: readonly WorkspaceColumnId[] = [];
const startupOutcomes = new Map<string, 'ready' | 'failed'>();
const emptySurfaceIdentityByHost = new Map<WorkspaceColumnId, string>();
let startupIdentities: Partial<Record<WorkspaceColumnId, string>> = {};

function emit(viewId: string) {
  listeners.get(viewId)?.forEach((listener) => listener());
}

function emitStartup() {
  startupListeners.forEach((listener) => listener());
}

/** Freeze the visible surface set for this startup attempt before waiting. */
export function beginWorkspaceSurfaceStartup(
  hosts: readonly WorkspaceColumnId[],
  identities: Partial<Record<WorkspaceColumnId, string>> = {},
): void {
  startupHosts = hosts;
  startupIdentities = identities;
  startupOutcomes.clear();
  for (const host of hosts) {
    if (emptySurfaceIdentityByHost.get(host) === identities[host]) {
      startupOutcomes.set(host, 'ready');
      continue;
    }
    const viewId = hostViews.get(host);
    const state = viewId ? snapshots.get(viewId)?.state : undefined;
    if (state) updateStartupSurfaceState(viewId!, state);
  }
  emitStartup();
}

export function registerStartupSurfaceHostView(host: WorkspaceColumnId, viewId: string): () => void {
  emptySurfaceIdentityByHost.delete(host);
  hostViews.set(host, viewId);
  startupOutcomes.delete(host);
  const state = snapshots.get(viewId)?.state;
  if (state) updateStartupSurfaceState(viewId, state);
  emitStartup();
  return () => {
    if (hostViews.get(host) !== viewId) return;
    hostViews.delete(host);
    startupOutcomes.delete(host);
    emitStartup();
  };
}

export function reportEmptyWorkspaceSurfaceForIdentity(host: WorkspaceColumnId, identity: string): void {
  emptySurfaceIdentityByHost.set(host, identity);
  if (!startupHosts.includes(host)) return;
  if (startupIdentities[host] !== identity) return;
  startupOutcomes.set(host, 'ready');
  emitStartup();
}

export function waitForWorkspaceSurfaceStartup(timeoutMs = 60_000): Promise<'ready' | 'timeout' | 'failed'> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: 'ready' | 'timeout' | 'failed') => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      startupListeners.delete(check);
      resolve(result);
    };
    const check = () => {
      if (startupHosts.some((host) => !hostViews.has(host) && !startupOutcomes.has(host))) return;
      if (startupHosts.some((host) => startupOutcomes.get(host) === 'failed')) finish('failed');
      else if (startupHosts.every((host) => startupOutcomes.get(host) === 'ready')) finish('ready');
    };
    const timeout = setTimeout(() => finish('timeout'), timeoutMs);
    startupListeners.add(check);
    check();
  });
}

function updateStartupSurfaceState(viewId: string, state: SurfaceState): void {
  const host = [...hostViews.entries()].find(([, currentViewId]) => currentViewId === viewId)?.[0];
  if (!host || !startupHosts.includes(host)) return;
  if (state.status === 'loading') startupOutcomes.delete(host);
  else if (state.status === 'error' || state.status === 'unavailable') startupOutcomes.set(host, 'failed');
  else startupOutcomes.set(host, 'ready');
  emitStartup();
}

export function registerWorkspaceSurfacePresentationOwner(
  viewId: string,
  owner: object,
  initialUpdate: Readonly<SurfacePresentationUpdate> = {},
): () => void {
  owners.set(viewId, owner);
  const pending = pendingUpdates.get(viewId);
  pendingUpdates.delete(viewId);
  const update = pending?.owner === owner
    ? { ...initialUpdate, ...pending.update }
    : initialUpdate;
  if (Object.keys(update).length === 0) snapshots.delete(viewId);
  else snapshots.set(viewId, update);
  if (update.state) updateStartupSurfaceState(viewId, update.state);
  emit(viewId);
  return () => {
    if (owners.get(viewId) !== owner) return;
    owners.delete(viewId);
    if (pendingUpdates.get(viewId)?.owner === owner) pendingUpdates.delete(viewId);
    clearSnapshot(viewId);
  };
}

function clearSnapshot(viewId: string) {
  if (!snapshots.delete(viewId)) return;
  emit(viewId);
}

export function reportWorkspaceSurfacePresentation(
  viewId: string,
  update: SurfacePresentationUpdate,
  owner?: object,
): boolean {
  const currentOwner = owners.get(viewId);
  if (currentOwner && owner !== currentOwner) return false;
  if (!currentOwner && owner) {
    const previousPending = pendingUpdates.get(viewId);
    const previous = previousPending?.owner === owner ? previousPending.update : {};
    pendingUpdates.set(viewId, { owner, update: { ...previous, ...update } });
    return true;
  }
  if (!currentOwner && !owner && pendingUpdates.has(viewId)) return false;
  const previous = snapshots.get(viewId) ?? {};
  const next = { ...previous, ...update };
  if (Object.keys(update).every((key) => Object.is(previous[key as keyof SurfacePresentationUpdate], update[key as keyof SurfacePresentationUpdate]))) return true;
  snapshots.set(viewId, next);
  if (update.state) updateStartupSurfaceState(viewId, update.state);
  emit(viewId);
  return true;
}

export function clearWorkspaceSurfacePresentation(viewId: string, owner?: object) {
  const currentOwner = owners.get(viewId);
  if (currentOwner && owner !== currentOwner) return;
  clearSnapshot(viewId);
}

export function getWorkspaceSurfacePresentation(viewId: string): Readonly<SurfacePresentationUpdate> {
  return snapshots.get(viewId) ?? EMPTY_PRESENTATION;
}

const EMPTY_PRESENTATION: Readonly<SurfacePresentationUpdate> = Object.freeze({});

export function useWorkspaceSurfacePresentation(viewId: string): Readonly<SurfacePresentationUpdate> {
  return useSyncExternalStore(
    (listener) => {
      const viewListeners = listeners.get(viewId) ?? new Set<() => void>();
      viewListeners.add(listener);
      listeners.set(viewId, viewListeners);
      return () => {
        viewListeners.delete(listener);
        if (viewListeners.size === 0) listeners.delete(viewId);
      };
    },
    () => getWorkspaceSurfacePresentation(viewId),
    () => EMPTY_PRESENTATION,
  );
}
