import { canonicalPath } from '@/lib/path';

export type CollectionDatasetFilterTarget = 'notes' | 'media' | 'work_documents';

interface CollectionDatasetFilterRequest {
  indexPath: string;
  target: CollectionDatasetFilterTarget;
}

const DATASET_FILTER_REQUEST_EVENT = 'flowix:collection-dataset-filter-request';
const pendingRequests = new Map<string, { expiresAt: number }>();
const subscribers = new Map<string, Set<() => void>>();

function requestKey(indexPath: string, target: CollectionDatasetFilterTarget): string {
  return `${canonicalPath(indexPath)}\u0000${target}`;
}

/** Open the existing filter editor for a collection domain without changing the active tab. */
export function requestCollectionDatasetFilter(request: CollectionDatasetFilterRequest): void {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  for (const [key, pending] of pendingRequests) {
    if (pending.expiresAt < now) pendingRequests.delete(key);
  }
  window.dispatchEvent(new CustomEvent<CollectionDatasetFilterRequest>(DATASET_FILTER_REQUEST_EVENT, { detail: request }));
  const key = requestKey(request.indexPath, request.target);
  const listeners = subscribers.get(key);
  if (listeners?.size) {
    listeners.forEach((listener) => listener());
    return;
  }
  // A retained panel can be requested while its lazy view chunk is still loading.
  // Keep one short-lived request so that the panel opens the filter on mount.
  pendingRequests.set(key, { expiresAt: now + 10_000 });
}

/** Panels subscribe to requests from the shared collection dataset menu, including before lazy mount. */
export function subscribeCollectionDatasetFilter(
  indexPath: string,
  target: CollectionDatasetFilterTarget,
  onRequest: () => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const key = requestKey(indexPath, target);
  const listeners = subscribers.get(key) ?? new Set<() => void>();
  listeners.add(onRequest);
  subscribers.set(key, listeners);
  const pending = pendingRequests.get(key);
  if (pending) {
    pendingRequests.delete(key);
    if (pending.expiresAt >= Date.now()) onRequest();
  }
  return () => {
    listeners.delete(onRequest);
    if (listeners.size === 0) subscribers.delete(key);
  };
}
