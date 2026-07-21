import { create } from 'zustand';

import { loadMemoLibraryMetadata, type MemoLibraryMetadata } from '@features/memo/services/memo-list-metadata-service';
import type { Notebook } from '@features/memo/store/memo-store';

interface MemoLibraryMetadataStore {
  metadata: MemoLibraryMetadata | null;
  queryKey: string | null;
  loadMetadata: (
    notebook: Notebook,
    refreshVersion: number
  ) => Promise<MemoLibraryMetadata | null>;
  clearMetadata: () => void;
}

let metadataRequestSeq = 0;
let inFlightQueryKey: string | null = null;
let inFlightPromise: Promise<MemoLibraryMetadata | null> | null = null;

function getMetadataQueryKey(
  notebookId: string,
  refreshVersion: number
): string {
  return [notebookId, refreshVersion].join(':');
}

export const useMemoLibraryMetadataStore = create<MemoLibraryMetadataStore>()((set, get) => ({
  metadata: null,
  queryKey: null,

  loadMetadata: async (notebook, refreshVersion) => {
    const queryKey = getMetadataQueryKey(notebook.id, refreshVersion);
    const state = get();
    if (state.queryKey === queryKey && state.metadata) {
      return state.metadata;
    }
    if (inFlightQueryKey === queryKey && inFlightPromise) {
      return inFlightPromise;
    }

    const requestSeq = ++metadataRequestSeq;

    inFlightQueryKey = queryKey;
    inFlightPromise = loadMemoLibraryMetadata({ notebook })
      .then((metadata) => {
        if (requestSeq === metadataRequestSeq) {
          set({
            metadata,
            queryKey,
          });
        }
        return metadata;
      })
      .catch((error) => {
        if (requestSeq === metadataRequestSeq) {
          set({
            metadata: null,
            queryKey,
          });
        }
        throw error;
      })
      .finally(() => {
        if (inFlightQueryKey === queryKey) {
          inFlightQueryKey = null;
          inFlightPromise = null;
        }
      });

    return inFlightPromise;
  },

  clearMetadata: () => {
    metadataRequestSeq += 1;
    inFlightQueryKey = null;
    inFlightPromise = null;
    set({
      metadata: null,
      queryKey: null,
    });
  },
}));
