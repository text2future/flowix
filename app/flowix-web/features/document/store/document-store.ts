import { create } from 'zustand';
import {
  flushDocumentPath,
  stageDocumentSnapshot,
} from '@features/document/store/document-session-service';
import { canonicalPath } from '@/lib/path';
import type { DocumentIdentity } from '@features/document/store/document-identity';
import { useDocumentHistoryStore, type MemoHistoryEntry } from '@features/document/store/document-history-store';


export type DocumentSource = 'memo' | 'external';

export interface MemoDocumentSession {
  id: string;
  memoId: string;
  path: string;
  notebookId: string | null;
  notebookPath: string | null;
  openedAt: number;
  transitionId: number;
}

interface ExternalDocumentSession {
  id: string;
  path: string;
  openedAt: number;
  transitionId: number;
}

type ActiveDocumentSession = MemoDocumentSession | ExternalDocumentSession;

function sessionIdentity(session: ActiveDocumentSession): DocumentIdentity {
  return 'memoId' in session
    ? { kind: 'memo', id: session.memoId }
    : { kind: 'external', path: session.path };
}

interface DocumentStore {
  currentDocumentPath: string | null;
  currentDocumentSource: DocumentSource | null;
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
  }) => Promise<void>;
  openExternalDocument: (path: string | null) => Promise<void>;
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
): boolean {
  return (
    !!canonicalNewPath &&
    state.currentDocumentSource === 'external' &&
    !!state.activeExternalSession &&
    canonicalPath(state.activeExternalSession.path) === canonicalNewPath
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

          const prev = get().activeMemoSession ?? get().activeExternalSession;
          const prevMemo = get().activeMemoSession;
          if (prev) {
            const flushStartedAt = performance.now();
            // Flush pending edits on the outgoing document before
            // committing the new session. All document transitions are
            // queued here, so rapid clicks cannot overlap flush/set phases.
            const flushed = await flushDocumentPath(sessionIdentity(prev), prev.path);
            if (!flushed) throw new Error('Document switch cancelled because saving did not complete');
            logOpenDocPerf('openMemoDocument:flush-previous', flushStartedAt, {
              transitionId,
              previousPath: prev.path,
            });
          }
          if (
            history === 'push' &&
            prevMemo &&
            canonicalNewPath &&
            (prevMemo.memoId !== memoId || prevMemo.path !== canonicalNewPath)
          ) {
            useDocumentHistoryStore.getState().pushBack(memoHistoryEntryFromSession(prevMemo));
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
              activeMemoSession: {
                id: `memo:${memoId}`,
                memoId,
                path: canonicalNewPath,
                notebookId,
                notebookPath,
                openedAt,
                transitionId,
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
    openExternalDocument: async (path) => {
      const canonicalNewPath = path ? canonicalPath(path) : null;
      if (isSameExternalTarget(get(), canonicalNewPath)) {
        return;
      }

      const transitionId = get().documentTransitionId + 1;
      set({ isDocumentTransitioning: true, documentTransitionId: transitionId });
      return enqueueTransition(async () => {
        try {
          if (isSameExternalTarget(get(), canonicalNewPath)) {
            get().finishDocumentTransition(transitionId);
            return;
          }

          const prev = get().activeMemoSession ?? get().activeExternalSession;
          if (prev) {
            const flushed = await flushDocumentPath(sessionIdentity(prev), prev.path);
            if (!flushed) throw new Error('Document switch cancelled because saving did not complete');
          }
          set(() => {
            if (!canonicalNewPath) return documentState(null, null);
            const openedAt = Date.now();
            return {
              currentDocumentPath: canonicalNewPath,
              currentDocumentSource: 'external',
              activeMemoSession: null,
              activeExternalSession: {
                id: `external:${canonicalNewPath}`,
                path: canonicalNewPath,
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
    clearDocument: async () => {
      return enqueueTransition(async () => {
        const prev = get().activeMemoSession ?? get().activeExternalSession;
        if (prev) {
          const flushed = await flushDocumentPath(sessionIdentity(prev), prev.path);
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
