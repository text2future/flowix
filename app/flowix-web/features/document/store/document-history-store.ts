import { ensureCollectionDisplay } from '@/lib/collection-display-registry';
import { createPrimaryHistoryFacade } from '@features/workspace/public/session-history-api';
import { canonicalPath, fileLocatorKey } from '@/lib/path';
import { canonicalUrl } from '@/lib/url';

export type * from '@features/workspace/public/session-history-api';
import type { DocumentHistoryEntry } from '@features/workspace/public/session-history-api';

interface DocumentHistoryStore {
  backStack: DocumentHistoryEntry[];
  forwardStack: DocumentHistoryEntry[];
  pushBack: (entry: DocumentHistoryEntry) => void;
  pushForward: (entry: DocumentHistoryEntry) => void;
  peekBack: () => DocumentHistoryEntry | null;
  peekForward: () => DocumentHistoryEntry | null;
  commitBackNavigation: (current: DocumentHistoryEntry | null, discardCount?: number) => void;
  commitForwardNavigation: (current: DocumentHistoryEntry | null, discardCount?: number) => void;
  recordNavigation: (current: DocumentHistoryEntry | null, next: DocumentHistoryEntry | null) => void;
  replaceFilePath: (previousPath: string, path: string) => void;
  clearForward: () => void;
  clear: () => void;
}

const MAX_HISTORY_ENTRIES = 100;

export function documentHistoryEntryKey(entry: DocumentHistoryEntry | null): string | null {
  if (!entry) return null;
  if (entry.kind === 'collection' || entry.kind === 'document-list') return entry.displayId;
  if (entry.kind === 'file-browser') return `file-browser:${fileLocatorKey(entry.activeFilePath ?? entry.folderPath ?? '')}`;
  if (entry.kind === 'folder-collection') return `folder-collection:${fileLocatorKey(entry.folderPath)}`;
  if (entry.kind === 'agent-conversation') return `agent-conversation:${entry.instanceId}`;
  if (entry.kind === 'web') {
    const url = canonicalUrl(entry.url);
    return url ? `web:${url}` : null;
  }
  if (entry.kind === 'media') return fileLocatorKey(entry.filePath);
  return fileLocatorKey(entry.path);
}

/** Normalize legacy per-view IDs at the history boundary, keeping keys display-based. */
function normalizeEntry(entry: DocumentHistoryEntry): DocumentHistoryEntry {
  return entry.kind === 'collection'
    ? { ...entry, ...ensureCollectionDisplay(entry, entry.displayId) }
    : entry;
}


function pushCapped(
  stack: DocumentHistoryEntry[],
  entry: DocumentHistoryEntry,
): DocumentHistoryEntry[] {
  entry = normalizeEntry(entry);
  if (stack[stack.length - 1]
    && documentHistoryEntryKey(stack[stack.length - 1]) === documentHistoryEntryKey(entry)) {
    return stack;
  }
  return [...stack, entry].slice(-MAX_HISTORY_ENTRIES);
}

export const useDocumentHistoryStore = createPrimaryHistoryFacade<DocumentHistoryStore>((set, get) => ({
  backStack: [],
  forwardStack: [],
  pushBack: (entry) => set((state) => ({
    backStack: pushCapped(state.backStack, entry),
    forwardStack: [],
  })),
  pushForward: (entry) => set((state) => ({
    forwardStack: pushCapped(state.forwardStack, entry),
  })),
  peekBack: () => get().backStack[get().backStack.length - 1] ?? null,
  peekForward: () => get().forwardStack[get().forwardStack.length - 1] ?? null,
  commitBackNavigation: (current, discardCount = 1) => set((state) => {
    if (state.backStack.length === 0) return state;
    return {
      backStack: state.backStack.slice(0, -Math.max(1, discardCount)),
      forwardStack: current
        ? pushCapped(state.forwardStack, current)
        : state.forwardStack,
    };
  }),
  commitForwardNavigation: (current, discardCount = 1) => set((state) => {
    if (state.forwardStack.length === 0) return state;
    return {
      backStack: current
        ? pushCapped(state.backStack, current)
        : state.backStack,
      forwardStack: state.forwardStack.slice(0, -Math.max(1, discardCount)),
    };
  }),
  recordNavigation: (current, next) => set((state) => {
    current = current ? normalizeEntry(current) : null;
    next = next ? normalizeEntry(next) : null;
    const currentKey = documentHistoryEntryKey(current);
    const nextKey = documentHistoryEntryKey(next);
    if (!nextKey || currentKey === nextKey) return state;
    return {
      backStack: current
        ? pushCapped(state.backStack, current)
        : state.backStack,
      forwardStack: [],
    };
  }),
  replaceFilePath: (previousPath, path) => set((state) => {
    const previous = canonicalPath(previousPath);
    const next = canonicalPath(path);
    if (!previous || !next || previous === next) return state;
    const replace = (entry: DocumentHistoryEntry): DocumentHistoryEntry => {
      if (entry.kind === 'external') {
        return canonicalPath(entry.path) === previous ? { ...entry, path: next } : entry;
      }
      if (entry.kind === 'media') {
        return canonicalPath(entry.filePath) === previous ? { ...entry, filePath: next } : entry;
      }
      return entry;
    };
    return {
      backStack: state.backStack.map(replace),
      forwardStack: state.forwardStack.map(replace),
    };
  }),
  clearForward: () => set({ forwardStack: [] }),
  clear: () => set({ backStack: [], forwardStack: [] }),
}));
