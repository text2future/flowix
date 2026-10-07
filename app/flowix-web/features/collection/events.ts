import type { CollectionIndexItem } from '@platform/tauri/client';

export interface LocalCollectionChange {
  notebookId: string;
  item: CollectionIndexItem;
  indexSequence: number;
  previousPath: string;
  fileDisplayId: string | null;
}
const subscribers = new Set<(change: LocalCollectionChange) => void>();
export function subscribeLocalCollectionChanges(listener: (change: LocalCollectionChange) => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}
export function publishLocalCollectionChange(change: LocalCollectionChange): void {
  for (const listener of subscribers) listener(change);
}
