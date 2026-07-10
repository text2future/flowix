import { create } from 'zustand';

export type MemoHistoryEntry = {
  kind: 'memo';
  memoId: string;
  notebookId: string | null;
  notebookPath: string | null;
  path: string;
  title?: string;
  openedAt: number;
};

export type ExternalHistoryEntry = {
  kind: 'external';
  path: string;
  openedAt: number;
};

export type DocumentHistoryEntry = MemoHistoryEntry | ExternalHistoryEntry;

interface DocumentHistoryStore {
  backStack: DocumentHistoryEntry[];
  forwardStack: DocumentHistoryEntry[];
  pushBack: (entry: DocumentHistoryEntry) => void;
  pushForward: (entry: DocumentHistoryEntry) => void;
  peekBack: () => DocumentHistoryEntry | null;
  peekForward: () => DocumentHistoryEntry | null;
  commitBackNavigation: (current: DocumentHistoryEntry | null) => void;
  commitForwardNavigation: (current: DocumentHistoryEntry | null) => void;
  clearForward: () => void;
  clear: () => void;
}

const MAX_HISTORY_ENTRIES = 30;

function entryKey(entry: DocumentHistoryEntry): string {
  return entry.kind === 'memo'
    ? `memo:${entry.memoId}:${entry.path}`
    : `external:${entry.path}`;
}

function pushCapped(
  stack: DocumentHistoryEntry[],
  entry: DocumentHistoryEntry,
): DocumentHistoryEntry[] {
  if (stack[stack.length - 1] && entryKey(stack[stack.length - 1]) === entryKey(entry)) {
    return stack;
  }
  return [...stack, entry].slice(-MAX_HISTORY_ENTRIES);
}

export const useDocumentHistoryStore = create<DocumentHistoryStore>()((set, get) => ({
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
  commitBackNavigation: (current) => set((state) => {
    if (state.backStack.length === 0) return state;
    return {
      backStack: state.backStack.slice(0, -1),
      forwardStack: current
        ? pushCapped(state.forwardStack, current)
        : state.forwardStack,
    };
  }),
  commitForwardNavigation: (current) => set((state) => {
    if (state.forwardStack.length === 0) return state;
    return {
      backStack: current
        ? pushCapped(state.backStack, current)
        : state.backStack,
      forwardStack: state.forwardStack.slice(0, -1),
    };
  }),
  clearForward: () => set({ forwardStack: [] }),
  clear: () => set({ backStack: [], forwardStack: [] }),
}));

