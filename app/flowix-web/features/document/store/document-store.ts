import { create } from 'zustand';
import { NavigationCancelledError } from '@/lib/navigation-cancelled-error';
import { prepareDocumentLeave } from '@features/document/store/document-session-service';
import { canonicalPath } from '@/lib/path';
import {
  attachDocumentOpenJourney,
  markDocumentOpenTrace,
  startDocumentOpenTrace,
} from '@/lib/document-open-perf';
import { documentIdentityFromFile, type DocumentIdentity } from '@features/document/store/document-identity';
import { ensureFileDisplayIdentity, type FileDisplayIdentity } from '@/lib/file-display-registry';


export type DocumentSource = 'external';
export type DocumentLoadOutcome = 'pending' | 'ready' | 'unavailable' | null;

export interface ExternalDocumentSession {
  fileIdentity: FileDisplayIdentity;
  scopePath: string | null;
  notebookId?: string | null;
  notebookPath?: string | null;
  relativePath?: string | null;
  indexable?: boolean;
  initialFocus?: 'title' | 'body';
  openedAt: number;
  transitionId: number;
}

function sessionIdentity(session: ExternalDocumentSession): DocumentIdentity {
  return documentIdentityFromFile(session.fileIdentity);
}

function sessionPath(session: ExternalDocumentSession): string {
  return session.fileIdentity.path;
}

function sessionScopePath(session: ExternalDocumentSession): string | null {
  return session.scopePath;
}

interface DocumentStore {
  currentDocumentPath: string | null;
  currentDocumentSource: DocumentSource | null;
  /** A right-panel surface which is not backed by an editable document. */
  activeAgentConversationId: string | null;
  activeExternalSession: ExternalDocumentSession | null;
  isDocumentTransitioning: boolean;
  documentTransitionId: number;
  documentLoadOutcome: DocumentLoadOutcome;
  finishDocumentTransition: (transitionId: number, outcome?: 'ready' | 'unavailable') => void;
  replaceActiveExternalPath: (displayId: string, path: string) => void;
  openExternalDocument: (path: string | null, options?: {
    scopePath?: string | null;
    notebookId?: string | null;
    notebookPath?: string | null;
    relativePath?: string | null;
    indexable?: boolean;
    initialFocus?: 'title' | 'body';
  }) => Promise<void>;
  openAgentConversation: (instanceId: string) => Promise<void>;
  closeAgentConversation: () => void;
  clearDocument: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------
//
// A document session transition has two phases, both owned by this store:
//   1. retain the outgoing draft and start its save/checkpoint work
//      (calls document-session-service.prepareDocumentLeave for the previous path)
//   2. commit the new session state via set(...)
//
// Navigation does not block on disk I/O. The outgoing runtime session stays
// retained until its queued save or recovery checkpoint settles. Operations
// that overwrite or delete the path use saveDocumentPath as a durability barrier.
//
// If there is no previous session (first open after launch), the flush
// is a no-op.
// ---------------------------------------------------------------------------

function documentState(path: string | null, source: DocumentSource | null) {
  return {
    currentDocumentPath: path,
    currentDocumentSource: path ? source : null,
    activeAgentConversationId: null,
    activeExternalSession: null,
    isDocumentTransitioning: false,
    documentLoadOutcome: null,
  };
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
    canonicalPath(state.activeExternalSession.fileIdentity.path) === canonicalNewPath &&
    state.activeExternalSession.scopePath === canonicalScopePath
  );
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
    activeExternalSession: null,
    isDocumentTransitioning: false,
    documentTransitionId: 0,
    documentLoadOutcome: null,
    finishDocumentTransition: (transitionId, outcome = 'ready') => {
      set((state) => {
        if (state.documentTransitionId !== transitionId || !state.isDocumentTransitioning) return state;
        return { isDocumentTransitioning: false, documentLoadOutcome: outcome };
      });
    },
    replaceActiveExternalPath: (displayId, path) => {
      const canonicalNewPath = canonicalPath(path);
      set((state) => {
        if (
          state.currentDocumentSource !== 'external' ||
          state.activeExternalSession?.fileIdentity.displayId !== displayId
        ) {
          return state;
        }
        if (state.currentDocumentPath === canonicalNewPath
          && state.activeExternalSession.fileIdentity.path === canonicalNewPath) return state;
        return {
          currentDocumentPath: canonicalNewPath,
          activeExternalSession: {
            ...state.activeExternalSession,
            fileIdentity: { ...state.activeExternalSession.fileIdentity, path: canonicalNewPath },
            relativePath: state.activeExternalSession.notebookId && state.activeExternalSession.notebookPath
              && canonicalNewPath.startsWith(`${canonicalPath(state.activeExternalSession.notebookPath).replace(/\/+$/, '')}/`)
              ? canonicalNewPath.slice(canonicalPath(state.activeExternalSession.notebookPath).replace(/\/+$/, '').length + 1)
              : state.activeExternalSession.relativePath,
          },
        };
      });
    },
    openExternalDocument: async (path, {
      scopePath = null, notebookId = null, notebookPath = null, relativePath = null, indexable = false, initialFocus,
    } = {}) => {
      const canonicalNewPath = path ? canonicalPath(path) : null;
      const canonicalScopePath = scopePath ? canonicalPath(scopePath) : null;
      // Returning to the visible document must supersede a queued switch too.
      if (!get().isDocumentTransitioning && isSameExternalTarget(get(), canonicalNewPath, canonicalScopePath)) {
        return;
      }

      const transitionId = get().documentTransitionId + 1;
      // Continue a journey begun at the user action (file-tree click, list
      // row, search hit) under this transitionId so elapsedMs spans the whole
      // open. Absent journey → trace starts here (traceStartedLate behaviour).
      const journeyAttached = attachDocumentOpenJourney(transitionId, path);
      startDocumentOpenTrace(transitionId, {
        source: 'external',
        path,
        hasPrevious: !!get().activeExternalSession,
        journeyAttached,
      });
      markDocumentOpenTrace(transitionId, 'navigation:external-start', {
        scopePath: canonicalScopePath,
      });
      set({
        isDocumentTransitioning: true,
        documentTransitionId: transitionId,
        documentLoadOutcome: 'pending',
      });
      return enqueueTransition(async () => {
        try {
          if (get().documentTransitionId !== transitionId) return;
          if (isSameExternalTarget(get(), canonicalNewPath, canonicalScopePath)) {
            get().finishDocumentTransition(transitionId);
            return;
          }

          const prev = get().activeExternalSession;
          if (prev) {
            const prepared = await prepareDocumentLeave(
              sessionIdentity(prev),
              sessionPath(prev),
              sessionScopePath(prev),
            );
            if (!prepared) throw new NavigationCancelledError('Document switch cancelled because saving could not be retained');
          }
          if (get().documentTransitionId !== transitionId) return;
          set(() => {
            if (!canonicalNewPath) return documentState(null, null);
            const openedAt = Date.now();
            return {
              currentDocumentPath: canonicalNewPath,
              currentDocumentSource: 'external',
              activeAgentConversationId: null,
              activeExternalSession: {
                fileIdentity: ensureFileDisplayIdentity(canonicalNewPath),
                scopePath: canonicalScopePath,
                notebookId,
                notebookPath,
                relativePath,
                indexable,
                initialFocus,
                openedAt,
                transitionId,
              },
              isDocumentTransitioning: true,
              documentLoadOutcome: 'pending',
            };
          });
        } catch (err) {
          get().finishDocumentTransition(transitionId);
          throw err;
        }
      });
    },
    openAgentConversation: async (instanceId) => {
      const normalizedInstanceId = instanceId.trim();
      if (!normalizedInstanceId || get().activeAgentConversationId === normalizedInstanceId) return;

      return enqueueTransition(async () => {
        const prev = get().activeExternalSession;
        if (prev) {
          const prepared = await prepareDocumentLeave(sessionIdentity(prev), sessionPath(prev), sessionScopePath(prev));
          if (!prepared) throw new NavigationCancelledError('Session switch cancelled because saving could not be retained');
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
        const prev = get().activeExternalSession;
        if (prev) {
          const prepared = await prepareDocumentLeave(sessionIdentity(prev), sessionPath(prev), sessionScopePath(prev));
          if (!prepared) throw new NavigationCancelledError('Document close cancelled because saving could not be retained');
        }
        set(documentState(null, null));
      });
    },
  })
);
