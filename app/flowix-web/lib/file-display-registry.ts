import { findCollectionDisplayPath, pinCollectionDisplay } from './collection-display-registry';
import { canonicalPath, fileLocatorKey } from '@/lib/path';

export interface FileDisplayIdentity {
  path: string;
  displayId: string;
}

const displayIdsByFile = new Map<string, string>();
const pathsByDisplay = new Map<string, string>();
const pinnedDisplayIds = new Map<string, number>();
const displayReleaseSubscribers = new Set<(displayId: string) => void>();
let nextDisplaySequence = 0;
let reconciliationSuspensions = 0;
let deferredLiveFileKeys: Set<string> | null = null;
let currentLiveFileKeys = new Set<string>();

function createDisplayId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  nextDisplaySequence += 1;
  return `display:${randomId ?? `${Date.now().toString(36)}-${nextDisplaySequence.toString(36)}`}`;
}

/** Runtime identity shared by every open surface displaying the same local file. */
function getFileDisplayId(path: string): string {
  const key = fileLocatorKey(path);
  const existing = displayIdsByFile.get(key);
  if (existing) return existing;
  const displayId = createDisplayId();
  displayIdsByFile.set(key, displayId);
  pathsByDisplay.set(displayId, canonicalPath(path));
  return displayId;
}

/** Resolve a canonical file path and its shared runtime display identity. */
export function ensureFileDisplayIdentity(path: string): FileDisplayIdentity {
  const normalizedPath = canonicalPath(path);
  return { path: normalizedPath, displayId: getFileDisplayId(normalizedPath) };
}

/** Read a live identity without creating one. Surface resolution must stay read-only. */
export function findFileDisplayIdentity(path: string): FileDisplayIdentity | null {
  const normalizedPath = canonicalPath(path);
  const displayId = findFileDisplayId(normalizedPath);
  return displayId ? { path: normalizedPath, displayId } : null;
}

/** Read an identity that should already have been initialized by an open/store transition. */
export function requireFileDisplayIdentity(path: string): FileDisplayIdentity {
  const identity = findFileDisplayIdentity(path);
  if (!identity) {
    throw new Error(`Missing runtime file identity for an open surface: ${canonicalPath(path)}`);
  }
  return identity;
}

/** Read a live file identity without allocating one. */
export function findFileDisplayId(path: string): string | null {
  return displayIdsByFile.get(fileLocatorKey(path)) ?? null;
}

/** Resolve the latest path at the instant a queued write executes. */
export function findFileDisplayPath(displayId: string): string | null {
  return findCollectionDisplayPath(displayId) ?? pathsByDisplay.get(displayId) ?? null;
}

/** True while an open surface or an in-flight file operation still owns this ID. */
export function isFileDisplayIdLive(displayId: string): boolean {
  return pinnedDisplayIds.has(displayId)
    || [...displayIdsByFile.values()].includes(displayId);
}

/** Keep a runtime identity alive during an operation that temporarily removes its file reference. */
export function pinFileDisplayId(displayId: string): () => void {
  const collectionPin = pinCollectionDisplay(displayId);
  if (collectionPin) return collectionPin;
  pinnedDisplayIds.set(displayId, (pinnedDisplayIds.get(displayId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remainingPins = (pinnedDisplayIds.get(displayId) ?? 1) - 1;
    if (remainingPins > 0) pinnedDisplayIds.set(displayId, remainingPins);
    else pinnedDisplayIds.delete(displayId);
    reconcileFileDisplayKeys(new Set(currentLiveFileKeys));
  };
}

export function subscribeFileDisplayRelease(
  subscriber: (displayId: string) => void,
): () => void {
  displayReleaseSubscribers.add(subscriber);
  return () => displayReleaseSubscribers.delete(subscriber);
}

/** Preserve the runtime identity when the backing file is renamed. */
export function rebaseFileDisplayPath(
  previousPath: string,
  nextPath: string,
  expectedDisplayId?: string,
): boolean {
  const previous = canonicalPath(previousPath);
  const next = canonicalPath(nextPath);
  if (!previous || !next || previous === next) return false;
  const previousKey = fileLocatorKey(previous);
  const nextKey = fileLocatorKey(next);
  const displayId = expectedDisplayId ?? displayIdsByFile.get(previousKey);
  if (!displayId) return false;
  // A delayed event for A->B must not move an already confirmed C back to B.
  if (pathsByDisplay.get(displayId) !== previous) return false;
  const destinationDisplayId = displayIdsByFile.get(nextKey);
  if (destinationDisplayId && destinationDisplayId !== displayId) return false;
  if (displayIdsByFile.get(previousKey) === displayId) displayIdsByFile.delete(previousKey);
  displayIdsByFile.set(nextKey, displayId);
  pathsByDisplay.set(displayId, next);
  if (currentLiveFileKeys.delete(previousKey)) currentLiveFileKeys.add(nextKey);
  if (deferredLiveFileKeys?.delete(previousKey)) deferredLiveFileKeys.add(nextKey);
  return true;
}

function reconcileFileDisplayKeys(liveKeys: Set<string>): void {
  currentLiveFileKeys = liveKeys;
  if (reconciliationSuspensions > 0) {
    deferredLiveFileKeys = liveKeys;
    return;
  }

  for (const key of liveKeys) {
    if (!displayIdsByFile.has(key)) {
      const displayId = createDisplayId();
      displayIdsByFile.set(key, displayId);
      pathsByDisplay.set(displayId, key.slice('file:'.length));
    }
  }
  for (const [key, displayId] of displayIdsByFile) {
    if (!liveKeys.has(key) && !pinnedDisplayIds.has(displayId)) {
      displayIdsByFile.delete(key);
      pathsByDisplay.delete(displayId);
      for (const subscriber of displayReleaseSubscribers) subscriber(displayId);
    }
  }
}

/** Keep one runtime identity while either document column references a file. */
export function reconcileFileDisplays(files: Iterable<{ path: string }>): void {
  const liveKeys = new Set([...files]
    .filter((file) => Boolean(file.path))
    .map((file) => fileLocatorKey(file.path)));
  reconcileFileDisplayKeys(liveKeys);
}

/** Avoid pruning an old path between store updates during a rename. */
export function suspendFileDisplayReconciliation(): () => void {
  reconciliationSuspensions += 1;
  let resumed = false;
  return () => {
    if (resumed) return;
    resumed = true;
    reconciliationSuspensions = Math.max(0, reconciliationSuspensions - 1);
    if (reconciliationSuspensions === 0 && deferredLiveFileKeys) {
      const liveKeys = deferredLiveFileKeys;
      deferredLiveFileKeys = null;
      reconcileFileDisplayKeys(liveKeys);
    }
  };
}
