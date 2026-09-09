import { create } from 'zustand';
import {
  flushDocumentPath,
  stageDocumentSnapshot,
} from '@features/document/store/document-session-service';
import { canonicalPath } from '@/lib/path';
import type { DocumentIdentity } from '@features/document/store/document-identity';
import {
  useDocumentHistoryStore,
  type DocumentHistoryEntry,
  type MemoHistoryEntry,
} from '@features/document/store/document-history-store';


export type DocumentSource = 'memo' | 'external';

export interface MemoDocumentSession {
  id: string;
  memoId: string;
  path: string;
  notebookId: string | null;
  notebookPath: string | null;
  openedAt: number;
  transitionId: number;
  initialFocus?: 'title' | 'body';
}

export interface ExternalDocumentSession {
  id: string;
  path: string;
  scopePath: string | null;
  openedAt: number;
  transitionId: number;
}

type ActiveDocumentSession = MemoDocumentSession | ExternalDocumentSession;

function sessionIdentity(session: ActiveDocumentSession): DocumentIdentity {
  return 'memoId' in session
    ? { kind: 'memo', id: session.memoId }
    : { kind: 'external', path: session.path };
}

function sessionScopePath(session: ActiveDocumentSession): string | null {
  return 'scopePath' in session ? session.scopePath : null;
}

interface DocumentStore {
  currentDocumentPath: string | null;
  currentDocumentSource: DocumentSource | null;
  /** A right-panel surface which is not backed by an editable document. */
  activeAgentConversationId: string | null;
  activeMemoSession: MemoDocumentSession | null;
  activeExternalSession: ExternalDocumentSession | null;
  isDocumentTransitioning: boolean;
  documentTransitionId: number;
  finishDocumentTransition: (transitionId: number) => void;
  replaceActiveMemoPath: (memoId: string, path: string) => void;
  openMemoDocument: (params: {
    memoId: string;
    path: string | null;
    notebookId?: string | null;
    notebookPath?: string | null;
    history?: 'push' | 'skip';
    initialContent?: string;
    initialFocus?: 'title' | 'body';
  }) => Promise<void>;
  openExternalDocument: (path: string | null, options?: {
    history?: 'push' | 'skip';
    scopePath?: string | null;
  }) => Promise<void>;
  openAgentConversation: (instanceId: string, options?: { history?: 'push' | 'skip' }) => Promise<void>;
  closeAgentConversation: () => void;
  clearDocument: () => Promise<void>;
  discardMemoDocument: (memoId: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------
//
// A document session transition has two phases, both owned by this store:
//   1. flush the outgoing document's pending edits to disk
//      (calls document-session-service.flushDocumentPath for the previous path)
//   2. commit the new session state via set(...)
//
// The flush awaits the save queue's chain — see save-queue.ts — so by
// the time set() runs, the outgoing document's last edit is on disk
// (or a CAS refusal toast has been surfaced). React then re-renders
// with the new session; useDocumentContent's reloadDocument effect
// reads the new path and re-hydrates the buffer.
//
// If there is no previous session (first open after launch), the flush
// is a no-op.
// ---------------------------------------------------------------------------

function documentState(path: string | null, source: DocumentSource | null) {
  return {
    currentDocumentPath: path,
    currentDocumentSource: path ? source : null,
    activeAgentConversationId: null,
    activeMemoSession: null,
    activeExternalSession: null,
    isDocumentTransitioning: false,
  };
}

function memoHistoryEntryFromSession(session: MemoDocumentSession): MemoHistoryEntry {
  return {
    kind: 'memo',
    memoId: session.memoId,
    notebookId: session.notebookId,
    notebookPath: session.notebookPath,
    path: session.path,
    openedAt: session.openedAt,
  };
}

function activeHistoryEntry(state: DocumentStore): DocumentHistoryEntry | null {
  if (state.activeMemoSession) return memoHistoryEntryFromSession(state.activeMemoSession);
  if (state.activeExternalSession) {
    return {
      kind: 'external',
      path: state.activeExternalSession.path,
      scopePath: state.activeExternalSession.scopePath,
      openedAt: state.activeExternalSession.openedAt,
    };
  }
  if (state.activeAgentConversationId) {
    return {
      kind: 'agent-conversation',
      instanceId: state.activeAgentConversationId,
      openedAt: Date.now(),
    };
  }
  return null;
}

function isSameMemoTarget(
  state: DocumentStore,
  memoId: string,
  canonicalNewPath: string | null,
): boolean {
  return (
    !!canonicalNewPath &&
    state.currentDocumentSource === 'memo' &&
    state.activeMemoSession?.memoId === memoId &&
    canonicalPath(state.activeMemoSession.path) === canonicalNewPath
  );
}

function isSameExternalTarget(
  state: DocumentStore,
  canonicalNewPath: string | null,
  canonicalScopePath: string | null,
): boolean {
  return (
    !!canonicalNewPath &&
    state.currentDocumentSource === 'external' &&
    !!state.activeExternalSession &&
    canonicalPath(state.activeExternalSession.path) === canonicalNewPath &&
    state.activeExternalSession.scopePath === canonicalScopePath
  );
}

function logOpenDocPerf(label: string, startedAt: number, meta?: Record<string, unknown>) {
  console.info('[perf:open-doc]', label, {
    elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
    ...meta,
  });
}

let transitionChain: Promise<void> = Promise.resolve();

function enqueueTransition<T>(work: () => Promise<T>): Promise<T> {
  const run = transitionChain.catch(() => undefined).then(work);
  transitionChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export const useDocumentStore = create<DocumentStore>()(
  (set, get) => ({
    currentDocumentPath: null,
    currentDocumentSource: null,
    activeAgentConversationId: null,
    activeMemoSession: null,
    activeExternalSession: null,
    isDocumentTransitioning: false,
    documentTransitionId: 0,
    finishDocumentTransition: (transitionId) => {
      set((state) => {
        if (state.documentTransitionId !== transitionId) return state;
        return { isDocumentTransitioning: false };
      });
    },
    replaceActiveMemoPath: (memoId, path) => {
      const canonicalNewPath = canonicalPath(path);
      set((state) => {
        if (
          state.currentDocumentSource !== 'memo' ||
          state.activeMemoSession?.memoId !== memoId
        ) {
          return state;
        }
        return {
          currentDocumentPath: canonicalNewPath,
          currentDocumentSource: state.currentDocumentSource,
          activeAgentConversationId: null,
          activeMemoSession: {
            ...state.activeMemoSession,
            path: canonicalNewPath,
          },
          activeExternalSession: state.activeExternalSession,
        };
      });
    },
    openMemoDocument: async ({
      memoId,
      path,
      notebookId = null,
      notebookPath = null,
      history = 'push',
      initialContent,
      initialFocus,
    }) => {
      const startedAt = performance.now();
      const canonicalNewPath = path ? canonicalPath(path) : null;
      if (isSameMemoTarget(get(), memoId, canonicalNewPath)) {
        logOpenDocPerf('openMemoDocument:same-target', startedAt, { memoId });
        return;
      }

      const transitionId = get().documentTransitionId + 1;
      logOpenDocPerf('openMemoDocument:start', startedAt, {
        memoId,
        transitionId,
        hasPrevious: !!(get().activeMemoSession ?? get().activeExternalSession),
      });
      set({ isDocumentTransitioning: true, documentTransitionId: transitionId });
      return enqueueTransition(async () => {
        const queuedAt = performance.now();
        try {
          if (isSameMemoTarget(get(), memoId, canonicalNewPath)) {
            get().finishDocumentTransition(transitionId);
            logOpenDocPerf('openMemoDocument:queued-same-target', startedAt, { memoId, transitionId });
            return;
          }

          const previousHistoryEntry = activeHistoryEntry(get());
          const prev = get().activeMemoSession ?? get().activeExternalSession;
          if (prev) {
            const flushStartedAt = performance.now();
            // Flush pending edits on the outgoing document before
            // committing the new session. All document transitions are
            // queued here, so rapid clicks cannot overlap flush/set phases.
            const flushed = await flushDocumentPath(sessionIdentity(prev), prev.path, sessionScopePath(prev));
            if (!flushed) throw new Error('Document switch cancelled because saving did not complete');
            logOpenDocPerf('openMemoDocument:flush-previous', flushStartedAt, {
              transitionId,
              previousPath: prev.path,
            });
          }
          if (
            history === 'push' &&
            previousHistoryEntry &&
            canonicalNewPath
          ) {
            useDocumentHistoryStore.getState().pushBack(previousHistoryEntry);
          }
          if (canonicalNewPath && initialContent !== undefined) {
            stageDocumentSnapshot(
              { kind: 'memo', id: memoId },
              canonicalNewPath,
              initialContent,
            );
          }
          set(() => {
            if (!canonicalNewPath) return documentState(null, null);
            const openedAt = Date.now();
            return {
              currentDocumentPath: canonicalNewPath,
              currentDocumentSource: 'memo',
              activeAgentConversationId: null,
              activeMemoSession: {
                id: `memo:${memoId}`,
                memoId,
                path: canonicalNewPath,
                notebookId,
                notebookPath,
                openedAt,
                transitionId,
                initialFocus,
              },
              activeExternalSession: null,
              isDocumentTransitioning: true,
            };
          });
          logOpenDocPerf('openMemoDocument:commit-session', startedAt, {
            memoId,
            transitionId,
            queuedMs: Math.round((queuedAt - startedAt) * 10) / 10,
          });
        } catch (err) {
          get().finishDocumentTransition(transitionId);
          logOpenDocPerf('openMemoDocument:error', startedAt, { memoId, transitionId });
          throw err;
        }
      });
    },
    openExternalDocument: async (path, { history = 'push', scopePath = null } = {}) => {
      const canonicalNewPath = path ? canonicalPath(path) : null;
      const canonicalScopePath = scopePath ? canonicalPath(scopePath) : null;
      if (isSameExternalTarget(get(), canonicalNewPath, canonicalScopePath)) {
        return;
      }

      const transitionId = get().documentTransitionId + 1;
      set({ isDocumentTransitioning: true, documentTransitionId: transitionId });
      return enqueueTransition(async () => {
        try {
          if (isSameExternalTarget(get(), canonicalNewPath, canonicalScopePath)) {
            get().finishDocumentTransition(transitionId);
            return;
          }

          const previousHistoryEntry = activeHistoryEntry(get());
          const prev = get().activeMemoSession ?? get().activeExternalSession;
          if (prev) {
            const flushed = await flushDocumentPath(
              sessionIdentity(prev),
              prev.path,
              sessionScopePath(prev),
            );
            if (!flushed) throw new Error('Document switch cancelled because saving did not complete');
          }
          if (history === 'push' && previousHistoryEntry && canonicalNewPath) {
            useDocumentHistoryStore.getState().pushBack(previousHistoryEntry);
          }
          set(() => {
            if (!canonicalNewPath) return documentState(null, null);
            const openedAt = Date.now();
            return {
              currentDocumentPath: canonicalNewPath,
              currentDocumentSource: 'external',
              activeAgentConversationId: null,
              activeMemoSession: null,
              activeExternalSession: {
                id: `external:${canonicalNewPath}`,
                path: canonicalNewPath,
                scopePath: canonicalScopePath,
                openedAt,
                transitionId,
              },
              isDocumentTransitioning: true,
            };
          });
        } catch (err) {
          get().finishDocumentTransition(transitionId);
          throw err;
        }
      });
    },
    openAgentConversation: async (instanceId, { history = 'push' } = {}) => {
      const normalizedInstanceId = instanceId.trim();
      if (!normalizedInstanceId || get().activeAgentConversationId === normalizedInstanceId) return;

      return enqueueTransition(async () => {
        const previousHistoryEntry = activeHistoryEntry(get());
        const prev = get().activeMemoSession ?? get().activeExternalSession;
        if (prev) {
          const flushed = await flushDocumentPath(sessionIdentity(prev), prev.path, sessionScopePath(prev));
          if (!flushed) throw new Error('Session switch cancelled because saving did not complete');
        }
        if (history === 'push' && previousHistoryEntry) {
          useDocumentHistoryStore.getState().pushBack(previousHistoryEntry);
        }
        set({
          ...documentState(null, null),
          activeAgentConversationId: normalizedInstanceId,
        });
      });
    },
    closeAgentConversation: () => {
      if (!get().activeAgentConversationId) return;
      set({ activeAgentConversationId: null });
    },
    clearDocument: async () => {
      return enqueueTransition(async () => {
        const prev = get().activeMemoSession ?? get().activeExternalSession;
        if (prev) {
          const flushed = await flushDocumentPath(sessionIdentity(prev), prev.path, sessionScopePath(prev));
          if (!flushed) throw new Error('Document close cancelled because saving did not complete');
        }
        set(documentState(null, null));
      });
    },
    discardMemoDocument: async (memoId) => {
      return enqueueTransition(async () => {
        const activeMemo = get().activeMemoSession;
        if (activeMemo?.memoId === memoId) {
          // The source has already been deleted, so flushing would either
          // recreate it or fail and strand its tab. This path is deliberately
          // narrower than clearDocument: callers must identify the deleted
          // memo whose active session may be discarded.
          set(documentState(null, null));
        }
      });
    },
  })
);
