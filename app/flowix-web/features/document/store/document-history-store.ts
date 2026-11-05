import type { StoreView } from '@shared/create-store-view';
import { ensureCollectionDisplay } from '@/lib/collection-display-registry';
import { createDocumentHistoryView, updateDocumentHistory, fromDocumentHistory, toDocumentHistory, type SessionNavigationEntry, SESSION_HISTORY_LIMIT } from '@features/workspace/public/session-history-api';
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


function pushCapped(stack: SessionNavigationEntry[], input: DocumentHistoryEntry): SessionNavigationEntry[] {
  const entry = normalizeEntry(input);
  const last = stack[stack.length - 1];
  if (last && documentHistoryEntryKey(toDocumentHistory(last)) === documentHistoryEntryKey(entry)) return stack;
  return [...stack, fromDocumentHistory(entry)].slice(-SESSION_HISTORY_LIMIT);
}

export const useDocumentHistoryStore: StoreView<DocumentHistoryStore> = createDocumentHistoryView<DocumentHistoryStore>({
  backStack: [], forwardStack: [],
  pushBack: (entry) => updateDocumentHistory((navigation) => ({ ...navigation,
    backStack: pushCapped(navigation.backStack, entry), forwardStack: [] })),
  pushForward: (entry) => updateDocumentHistory((navigation) => ({ ...navigation,
    forwardStack: pushCapped(navigation.forwardStack, entry) })),
  peekBack: () => { const stack = useDocumentHistoryStore.getState().backStack; return stack[stack.length - 1] ?? null; },
  peekForward: () => { const stack = useDocumentHistoryStore.getState().forwardStack; return stack[stack.length - 1] ?? null; },
  commitBackNavigation: (current, discardCount = 1) => updateDocumentHistory((navigation) => navigation.backStack.length ? {
    ...navigation, backStack: navigation.backStack.slice(0, -Math.max(1, discardCount)),
    forwardStack: current ? pushCapped(navigation.forwardStack, current) : navigation.forwardStack,
  } : navigation),
  commitForwardNavigation: (current, discardCount = 1) => updateDocumentHistory((navigation) => navigation.forwardStack.length ? {
    ...navigation, forwardStack: navigation.forwardStack.slice(0, -Math.max(1, discardCount)),
    backStack: current ? pushCapped(navigation.backStack, current) : navigation.backStack,
  } : navigation),
  recordNavigation: (current, next) => {
    current = current ? normalizeEntry(current) : null;
    next = next ? normalizeEntry(next) : null;
    if (!documentHistoryEntryKey(next) || documentHistoryEntryKey(current) === documentHistoryEntryKey(next)) return;
    updateDocumentHistory((navigation) => ({ ...navigation,
      backStack: current ? pushCapped(navigation.backStack, current) : navigation.backStack, forwardStack: [],
    }));
  },
  replaceFilePath: (previousPath, path) => {
    const previous = canonicalPath(previousPath), next = canonicalPath(path);
    if (!previous || !next || previous === next) return;
    const replace = (entry: SessionNavigationEntry): SessionNavigationEntry => {
      const target = entry.target;
      if (target.kind === 'external' && canonicalPath(target.path) === previous) return { ...entry, target: { ...target, path: next } };
      if (target.kind === 'media' && canonicalPath(target.filePath) === previous) return { ...entry, target: { ...target, filePath: next } };
      return entry;
    };
    updateDocumentHistory((navigation) => ({ ...navigation,
      backStack: navigation.backStack.map(replace), forwardStack: navigation.forwardStack.map(replace),
    }));
  },
  clearForward: () => updateDocumentHistory((navigation) => ({ ...navigation, forwardStack: [] })),
  clear: () => updateDocumentHistory((navigation) => ({ ...navigation, backStack: [], forwardStack: [] })),
});
