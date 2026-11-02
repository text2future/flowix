import { getDocumentSession } from '../store/document-runtime-session';
import { useDocumentStore } from '@features/document/store/document-store';
import type { ExternalDocumentSession } from '@features/document/store/document-store';
import {
  useDocumentHistoryStore,
  type DocumentHistoryEntry,
  type MediaHistoryEntry,
} from '@features/document/store/document-history-store';
import {
  prepareDocumentLeave,
  saveDocumentPath,
  rebaseActiveDocumentPath,
} from '@features/document/store/document-session-service';
import { findFileDisplayId, findFileDisplayPath, rebaseFileDisplayPath } from '@/lib/file-display-registry';
import { canonicalPath } from '@/lib/path';
import type { DocumentIdentity } from '@features/document/store/document-identity';
import { rebaseRecoveryDraftPath } from '@features/document/store/recovery-draft-store';
export { rebaseStoredRecoveryDraftPaths } from '@features/document/store/recovery-draft-store';
import { listDocumentSessions } from '@features/document/store/document-runtime-session';
import { applyLoadedDocumentContent, captureLatestDocumentContent, hasDocumentUnsavedChanges } from '@features/document/store/document-session-service';
import { subscribeDocumentBufferChanges } from '@features/document/store/buffer-registry';

export { documentIdentityFromFile } from '@features/document/store/document-identity';
export { deleteExternalDocument } from '@features/document/use-cases/delete-external-document';

/** Protect a live editor draft while a background note-link rewrite runs. */
export function hasLiveUnsavedDocumentAtPath(path: string): boolean {
  const target = canonicalPath(path);
  return listDocumentSessions().some((session) => {
    if (canonicalPath(session.identity.path) !== target || !session.buffer) return false;
    captureLatestDocumentContent(session.identity);
    return hasDocumentUnsavedChanges(session.identity);
  });
}

/** Background writes must update retained tabs too: reopening uses this cache. */
export function acceptBackgroundDocumentContent(path: string, content: string): boolean {
  const target = canonicalPath(path);
  let accepted = true;
  for (const session of listDocumentSessions()) {
    if (canonicalPath(session.identity.path) !== target || !session.buffer) continue;
    captureLatestDocumentContent(session.identity);
    if (hasDocumentUnsavedChanges(session.identity)) { accepted = false; continue; }
    if (session.buffer.content === content && session.buffer.lastSavedContent === content) continue;
    applyLoadedDocumentContent(session.identity, path, content, { preservePending: false, setAsCurrent: false });
  }
  return accepted;
}

export function subscribeWorkspaceDocumentSaves(listener: () => void): () => void {
  return subscribeDocumentBufferChanges((_identity, reason) => {
    if (reason === 'save_settled') listener();
  });
}

export function getWorkspaceDocumentPaths(): string[] {
  const state = useDocumentStore.getState();
  return [state.activeExternalSession?.fileIdentity.path]
    .filter((path): path is string => Boolean(path));
}

export function subscribeWorkspaceDocumentPaths(listener: () => void): () => void {
  return useDocumentStore.subscribe((state, previous) => {
    if (state.activeExternalSession !== previous.activeExternalSession) listener();
  });
}

type DocumentState = ReturnType<typeof useDocumentStore.getState>;

/**
 * Document capabilities used by workspace navigation.
 *
 * Keep this contract narrower than DocumentStore: workspace owns placement and
 * navigation transactions, while document owns session lifecycle and flushing.
 */
export type WorkspaceDocumentState = Pick<
  DocumentState,
  | 'activeExternalSession'
  | 'activeAgentConversationId'
  | 'openExternalDocument'
  | 'openAgentConversation'
  | 'closeAgentConversation'
  | 'clearDocument'
  | 'replaceActiveExternalPath'
>;

export function getWorkspaceDocumentState(): WorkspaceDocumentState {
  return useDocumentStore.getState();
}

export function recordWorkspaceDocumentNavigation(
  current: DocumentHistoryEntry | null,
  next: DocumentHistoryEntry | null,
): void {
  useDocumentHistoryStore.getState().recordNavigation(current, next);
}

export function replaceWorkspaceDocumentPath(
  identity: DocumentIdentity,
  path: string,
): boolean {
  const previous = canonicalPath(identity.path);
  const next = canonicalPath(path);
  if (!previous || !next) return false;
  // A command response and its broadcast can confirm the same move. Allow
  // callers to finish projections, but never rebase a display already at C.
  if (findFileDisplayPath(identity.displayId) !== next
    && !rebaseWorkspaceDocumentPath(identity, next)) return false;
  useDocumentStore.getState().replaceActiveExternalPath(identity.displayId, next);
  useDocumentHistoryStore.getState().replaceFilePath(previous, next);
  return true;
}

/** Rebase the shared live document identity after either a Memo or file rename. */
export function rebaseWorkspaceDocumentPath(
  identity: DocumentIdentity,
  path: string,
): boolean {
  const previous = canonicalPath(identity.path);
  const next = canonicalPath(path);
  if (!previous || !next) return false;
  if (previous === next) return true;
  const ownsPrevious = findFileDisplayId(previous) === identity.displayId;
  if (!rebaseFileDisplayPath(previous, next, identity.displayId)) return false;
  if (ownsPrevious) rebaseRecoveryDraftPath({ ...identity, path: previous }, next);
  getDocumentSession(identity).fallbackPath = next;
  rebaseActiveDocumentPath(identity, next);
  return true;
}

export async function prepareWorkspaceDocumentLeave(
  identity: DocumentIdentity,
  path: string,
  scopePath?: string | null,
): Promise<boolean> {
  return prepareDocumentLeave(identity, path, scopePath);
}

/** Destructive writes must wait until the current editor body and title are durable. */
export async function saveWorkspaceDocumentPath(
  identity: DocumentIdentity,
  path: string,
  scopePath?: string | null,
): Promise<boolean> {
  return saveDocumentPath(identity, path, scopePath);
}

export type {
  DocumentHistoryEntry,
  MediaHistoryEntry,
  ExternalDocumentSession,
};

export function getWorkspaceDocumentHistory(): DocumentHistoryEntry[] {
  const state = useDocumentHistoryStore.getState();
  return [...state.backStack, ...state.forwardStack];
}

/** History remains addressable even when no live display owns its old path. */
export function replaceWorkspaceDocumentHistoryPath(previousPath: string, path: string): void {
  useDocumentHistoryStore.getState().replaceFilePath(previousPath, path);
}
export function subscribeWorkspaceDocumentHistory(listener: () => void): () => void {
  return useDocumentHistoryStore.subscribe(listener);
}

/** Compatibility adapter for session navigation; histories remain owned by their runtime. */
export function getWorkspaceDocumentNavigation() {
  const { backStack, forwardStack } = useDocumentHistoryStore.getState();
  return { backStack, forwardStack };
}
