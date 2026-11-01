import { invoke } from '@platform/tauri/core';
import { listen } from '@tauri-apps/api/event';

/**
 * Pinned section IPC. Notes keep the flag in frontmatter, documents in the
 * notebook-local resource catalog, collections in `collection_state`; the
 * backend returns them as one list ordered by creation time.
 */
export interface PinnedEntry {
  entryKind: 'note' | 'document' | 'collection';
  relativePath: string;
  title: string;
  createdAt: number;
  modifiedMs: number;
  kind: string;
  collectionId: string | null;
  sizeBytes: number;
}

export interface PinnedEntryPage {
  entries: PinnedEntry[];
  nextCursor: string | null;
  hasMore: boolean;
}

export const pinnedEntries = {
  list: (notebookId: string, cursor?: string | null, limit?: number) =>
    invoke<PinnedEntryPage>('list_pinned_entries', { notebookId, cursor, limit }),
};

/** Document and collection pins have no frontmatter event to piggyback on. */
export function listenToPinnedChanges(handler: (payload: { notebookId: string }) => void) {
  return listen<{ notebookId: string }>('notebook-pinned-changed', (event) => handler(event.payload));
}
