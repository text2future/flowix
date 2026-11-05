import { create } from 'zustand';

import type { WorkspaceColumnId } from '@features/workspace/public/host-api';
import { subscribeFileDisplayRelease } from '@/lib/file-display-registry';
import {
  documentIdentityKey,
  type DocumentIdentity,
} from './document-identity';

export type DocumentEditorMode = 'rich' | 'source';

const DEFAULT_DOCUMENT_EDITOR_MODE: DocumentEditorMode = 'rich';

interface DocumentEditorViewState {
  modes: Record<string, DocumentEditorMode>;
  setMode: (key: string, mode: DocumentEditorMode) => void;
  clearMode: (key: string) => void;
  reset: () => void;
}

export function documentEditorViewKey(
  hostId: WorkspaceColumnId,
  identity: DocumentIdentity,
): string {
  return `${hostId}:${documentIdentityKey(identity)}`;
}

export const useDocumentEditorViewStore = create<DocumentEditorViewState>((set) => ({
  modes: {},
  setMode: (key, mode) => set((state) => (
    state.modes[key] === mode
      ? state
      : { modes: { ...state.modes, [key]: mode } }
  )),
  clearMode: (key) => set((state) => {
    if (!(key in state.modes)) return state;
    const modes = { ...state.modes };
    delete modes[key];
    return { modes };
  }),
  reset: () => set({ modes: {} }),
}));

export function getDocumentEditorMode(
  hostId: WorkspaceColumnId,
  identity: DocumentIdentity,
): DocumentEditorMode {
  return useDocumentEditorViewStore.getState().modes[documentEditorViewKey(hostId, identity)]
    ?? DEFAULT_DOCUMENT_EDITOR_MODE;
}

export function setDocumentEditorMode(
  hostId: WorkspaceColumnId,
  identity: DocumentIdentity,
  mode: DocumentEditorMode,
): void {
  useDocumentEditorViewStore.getState().setMode(documentEditorViewKey(hostId, identity), mode);
}

/** Drop every host-specific view preference for a reclaimed runtime display. */
export function clearDocumentEditorViews(displayId: string): void {
  const suffix = `:md:${displayId}`;
  useDocumentEditorViewStore.setState((state) => {
    const modes = Object.fromEntries(Object.entries(state.modes).filter(([key]) => !key.endsWith(suffix)));
    if (Object.keys(modes).length === Object.keys(state.modes).length) return state;
    return { modes };
  });
}

subscribeFileDisplayRelease(clearDocumentEditorViews);

export function useDocumentEditorMode(
  hostId: WorkspaceColumnId,
  identity: DocumentIdentity,
): DocumentEditorMode {
  const key = documentEditorViewKey(hostId, identity);
  return useDocumentEditorViewStore((state) => state.modes[key] ?? DEFAULT_DOCUMENT_EDITOR_MODE);
}
