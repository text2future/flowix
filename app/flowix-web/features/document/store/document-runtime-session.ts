import { findFileDisplayPath, isFileDisplayIdLive } from '@/lib/file-display-registry';
import type { DocumentIdentity } from './document-identity';
import type { DocumentBuffer } from './document-buffer';
import type { MemoTitleSession } from './document-title-session';
import type { CommitQueue, CaptureClock } from './document-commit-queue';
import type { RecoveryDraft } from './recovery-draft-store';

export interface DocumentCapture {
  hostId?: string;
  capture: () => string | null;
  isActive?: () => boolean;
}
export interface PersistenceAdapter {
  capture: () => void;
  path: () => string;
  scopePath: string | null;
}
/** Runtime-only ownership. Never serialize this record or its displayId. */
export interface DocumentRuntimeSession {
  identity: DocumentIdentity;
  fallbackPath: string;
  buffer?: DocumentBuffer;
  loaded: boolean;
  capturing: boolean;
  recoveryRevision: number;
  /** Link semantics already applied to this live body; revision guards canonical-save hints. */
  linkRewriteStage?: { batchId: string; through: number; revision: number };
  openingRead?: { path: string; promise: Promise<string | null> };
  openingRecovery?: { path: string; promise: Promise<RecoveryDraft | null> };
  title?: MemoTitleSession;
  /** Recovery-only input; never the displayed title or an automatic rename intent. */
  restoredTitle?: { draft: string; filename: string };
  queue?: CommitQueue;
  clock?: CaptureClock;
  captures: Set<DocumentCapture>;
  adapters: Set<PersistenceAdapter>;
  retainedAdapter?: PersistenceAdapter;
}
const sessions = new Map<string, DocumentRuntimeSession>();
const listeners = new Set<() => void>();
export function subscribeDocumentSessions(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function notifyDocumentSessions(): void { for (const listener of listeners) listener(); }
export function listDocumentSessions(): DocumentRuntimeSession[] { return [...sessions.values()]; }
export function findDocumentSession(displayId: string): DocumentRuntimeSession | undefined { return sessions.get(displayId); }
export function getDocumentSession(input: DocumentIdentity | string): DocumentRuntimeSession {
  const displayId = typeof input === 'string' ? input : input.displayId;
  let session = sessions.get(displayId);
  if (!session) {
    session = { fallbackPath: typeof input === 'string' ? '' : input.path,
      identity: { kind: 'md', displayId,
        get path() { return findFileDisplayPath(displayId) ?? sessions.get(displayId)?.fallbackPath ?? ''; } },
      loaded: false, capturing: false, recoveryRevision: 0, captures: new Set(), adapters: new Set() };
    sessions.set(displayId, session);
  } else if (typeof input !== 'string') {
    if (!session.fallbackPath) session.fallbackPath = input.path;
  }
  return session;
}
export function releaseDocumentSession(displayId: string): void {
  const session = sessions.get(displayId);
  if (!session || isFileDisplayIdLive(displayId) || session.queue || session.clock
    || session.captures.size || session.adapters.size || session.buffer || session.title) return;
  sessions.delete(displayId);
  notifyDocumentSessions();
}
