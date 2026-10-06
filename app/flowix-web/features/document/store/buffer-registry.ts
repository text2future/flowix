import { getDocumentSession, findDocumentSession, releaseDocumentSession, notifyDocumentSessions } from './document-runtime-session';
import { hasTitleDraft } from './document-title-session';
import { scheduleSave, waitForSaveQueue } from '@features/document/store/save-queue';
import { emptyDocumentBuffer, type DocumentBuffer } from '@features/document/store/document-buffer';
import { canonicalPath } from '@/lib/path';
import { isDocumentContentEqual } from '@features/document/store/buffer-equality';
import {
  documentIdentityKey,
  normalizeDocumentIdentity,
  type DocumentIdentity,
} from '@features/document/store/document-identity';
import { clearRecoveryDraftThrough } from '@features/document/store/recovery-draft-store';
import { pinFileDisplayId } from '@/lib/file-display-registry';


let currentPath: string | null = null;
let currentIdentity: DocumentIdentity | null = null;

export type DocumentBufferChangeReason = 'edited' | 'loaded' | 'save_settled' | 'merged';
type DocumentBufferChangeListener = (
  identity: DocumentIdentity,
  reason: DocumentBufferChangeReason,
) => void;
const documentBufferChangeListeners = new Set<DocumentBufferChangeListener>();

export function subscribeDocumentBufferChanges(
  listener: DocumentBufferChangeListener,
): () => void {
  documentBufferChangeListeners.add(listener);
  return () => documentBufferChangeListeners.delete(listener);
}

export function notifyDocumentBufferChanged(
  identity: DocumentIdentity,
  reason: DocumentBufferChangeReason,
): void {
  const normalized = normalizeDocumentIdentity(identity);
  for (const listener of [...documentBufferChangeListeners]) {
    listener(normalized, reason);
  }
}

export function getCurrentPath(): string | null {
  return currentPath;
}

export function getCurrentIdentity(): DocumentIdentity | null {
  return currentIdentity;
}

export function getBuffer(identity: DocumentIdentity): DocumentBuffer | undefined {
  const normalized = normalizeDocumentIdentity(identity);
  return findDocumentSession(normalized.displayId)?.buffer;
}

export function getOrCreateBuffer(identity: DocumentIdentity): DocumentBuffer {
  const normalized = normalizeDocumentIdentity(identity);
  const session = getDocumentSession(normalized);
  return session.buffer ??= emptyDocumentBuffer();
}

/** Drop an unowned buffer once its latest revision is safely durable. */
export function releaseDocumentBuffer(displayId: string): void {
  const key = `md:${displayId}`;
  const session = findDocumentSession(displayId);
  const buffer = session?.buffer;
  if (buffer && (
    buffer.savingRevision !== null
    || (buffer.saveState !== 'clean' && buffer.durableRevision < buffer.capturedRevision)
  )) return;

  if (currentIdentity && documentIdentityKey(currentIdentity) === key) {
    currentIdentity = null;
    currentPath = null;
  }
  if (session) {
    session.buffer = undefined;
    session.loaded = false;
    notifyDocumentSessions();
  }
  releaseDocumentSession(displayId);
}

export function setCurrentDocument(identity: DocumentIdentity | null, path: string | null): void {
  if (!identity || !path) {
    currentPath = null;
    currentIdentity = null;
    return;
  }

  const normalized = normalizeDocumentIdentity(identity);
  const nextPath = canonicalPath(path);
  const currentKey = currentIdentity ? documentIdentityKey(currentIdentity) : null;
  if (documentIdentityKey(normalized) === currentKey && nextPath === currentPath) {
    currentIdentity = normalized;
    return;
  }

  currentIdentity = normalized;
  currentPath = nextPath;
  getOrCreateBuffer(normalized);
}

/** Rebase the active path without treating live editor bytes as a disk load. */
export function rebaseCurrentDocumentPath(identity: DocumentIdentity, path: string): void {
  const normalized = normalizeDocumentIdentity(identity);
  if (!currentIdentity || documentIdentityKey(normalized) !== documentIdentityKey(currentIdentity)) return;
  const nextPath = canonicalPath(path);
  currentIdentity = {
    ...normalized,
    path: nextPath,
  };
  currentPath = nextPath;
}

export function hasUnsavedLocalChanges(identity?: DocumentIdentity): boolean {
  const target = identity ?? getCurrentIdentity();
  if (!target) return false;
  const buf = getBuffer(target);
  if (!buf) return false;
  return buf.savingRevision !== null || buf.conflicted || !isDocumentContentEqual(target, buf.content, buf.lastSavedContent);
}

/**
 * Accept the in-memory content as intentionally abandoned without writing it.
 * This is reserved for a document whose backing source has already vanished;
 * normal navigation must continue to use the save barrier.
 */
export function discardUnsavedLocalChanges(identity: DocumentIdentity): void {
  const normalized = normalizeDocumentIdentity(identity);
  const buf = getBuffer(normalized);
  if (!buf) return;
  buf.lastSavedContent = buf.content;
  buf.pendingContent = null;
  buf.savedRevision = buf.capturedRevision;
  buf.durableRevision = buf.capturedRevision;
  buf.pendingRevision = null;
  buf.savingRevision = null;
  buf.saveState = 'clean';
  buf.saveError = null;
  buf.conflicted = false;
  buf.conflictContent = null;
  void clearRecoveryDraftThrough(normalized, getDocumentSession(normalized).recoveryRevision);
  notifyDocumentBufferChanged(normalized, 'save_settled');
}

export function applyLoadedContent(
  identity: DocumentIdentity,
  path: string,
  fullContent: string,
  options?: { preservePending?: boolean; setAsCurrent?: boolean },
): DocumentBuffer {
  if (options?.setAsCurrent !== false) setCurrentDocument(identity, path);
  const buf = getOrCreateBuffer(identity);
  getDocumentSession(identity).loaded = true;
  const initialContent = options?.preservePending
    ? (buf.pendingContent ?? fullContent)
    : fullContent;
  buf.content = initialContent;
  buf.lastSavedContent = fullContent;
  if (!options?.preservePending) {
    buf.saveError = null;
    buf.conflicted = false;
    buf.conflictContent = null;
    buf.pendingContent = null;
    buf.durableRevision = buf.capturedRevision;
    buf.savedRevision = buf.capturedRevision;
    buf.savingRevision = null;
    buf.pendingRevision = null;
    buf.saveState = 'clean';
  }
  notifyDocumentBufferChanged(identity, 'loaded');
  return buf;
}

export interface FlushCallbacks {
  onSaved?: (writtenPath: string, content: string, revision: number) => void;
  onCasRefused?: (content: string, revision: number) => void;
  onError?: (content: string, revision: number, err: unknown) => void;
}

export async function flushDocument(
  identity: DocumentIdentity,
  path: string,
  callbacks?: FlushCallbacks & {
    scopePath?: string | null;
    force?: boolean;
  },
): Promise<boolean> {
  const normalized = normalizeDocumentIdentity(identity);
  const buf = getBuffer(normalized);
  if (!buf) return true;
  if (buf.conflicted) return false;
  const currentBodyIsSaved = () => !buf.conflicted
    && buf.saveError === null
    && buf.savingRevision === null
    && buf.savedRevision >= buf.capturedRevision
    && isDocumentContentEqual(normalized, buf.content, buf.lastSavedContent);
  if (!callbacks?.force && currentBodyIsSaved()) {
    return true;
  }

  const revision = buf.capturedRevision;
  buf.savingRevision = revision;
  buf.pendingRevision = revision;
  buf.saveState = 'saving';
  notifyDocumentBufferChanged(normalized, 'save_settled');

  const releaseDisplayPin = pinFileDisplayId(normalized.displayId);
  try {
    const queueKey = documentIdentityKey(normalized);
    const saved = await scheduleSave({
      queueKey,
      path: canonicalPath(path),
      revision,
      scopePath: callbacks?.scopePath ?? null,
      readExpected: () => buf.lastSavedContent,
      latest: () => ({ content: buf.content, revision: buf.capturedRevision }),
      isBlocked: () => buf.conflicted,
      onStarted: (revision) => {
        buf.savingRevision = revision; buf.saveState = 'saving';
        notifyDocumentBufferChanged(normalized, 'save_settled');
      },
      onSaved: (writtenPath, writtenContent, savedRevision, submittedContent, merged) => {
        if (merged) {
          // A rich editor may still have an unserialized keystroke. Capture it
          // before deciding whether the merged save can replace its document.
          const session = getDocumentSession(normalized);
          const wasCapturing = session.capturing;
          session.capturing = true;
          try {
            for (const capture of [...session.captures]) {
              if (!capture.isActive || capture.isActive()) capture.capture();
            }
          } finally {
            session.capturing = wasCapturing;
          }
        }
        const canApplyMerge = merged && isDocumentContentEqual(normalized, buf.content, submittedContent);
        const changedWhileMerging = merged && !canApplyMerge;
        buf.lastSavedContent = writtenContent;
        if (canApplyMerge) {
          buf.content = writtenContent;
          buf.editRevision += 1;
          buf.capturedRevision = buf.editRevision;
          buf.pendingContent = null;
          buf.pendingRevision = null;
        }
        buf.saveError = null;
        buf.savedRevision = Math.max(buf.savedRevision, savedRevision);
        buf.durableRevision = Math.max(buf.durableRevision, savedRevision);
        if (buf.savingRevision === savedRevision) buf.savingRevision = null;
        if (changedWhileMerging) {
          // The saved merge contains an older editor snapshot. Keep the newer
          // draft in memory instead of letting a queued write erase disk edits.
          buf.conflicted = true;
          buf.conflictContent = writtenContent;
          buf.saveState = 'conflict';
        } else if (isDocumentContentEqual(normalized, buf.content, writtenContent)) {
          buf.pendingContent = null;
          buf.pendingRevision = null;
          // The current bytes are now canonical even if an equivalent edit
          // revision was captured while this request was in flight.
          buf.savedRevision = Math.max(buf.savedRevision, buf.capturedRevision);
          buf.durableRevision = Math.max(buf.durableRevision, buf.capturedRevision);
          buf.saveState = 'clean';
        } else if (buf.pendingContent !== null && isDocumentContentEqual(normalized, buf.pendingContent, writtenContent)) {
          buf.pendingContent = null;
          buf.pendingRevision = null;
          buf.saveState = 'clean';
        } else {
          buf.saveState = buf.savingRevision !== null ? 'saving' : 'dirty';
        }
        if (!hasTitleDraft(normalized.displayId) && buf.saveState === 'clean') {
          void clearRecoveryDraftThrough({ ...normalized, path: writtenPath }, getDocumentSession(normalized).recoveryRevision);
        }
        callbacks?.onSaved?.(writtenPath, writtenContent, savedRevision);
        notifyDocumentBufferChanged(normalized, canApplyMerge ? 'merged' : 'save_settled');
      },
      onCasRefused: (written, refusedRevision) => {
        // All queued body writes are blocked by this conflict, including a
        // newer revision queued while the refused request was in flight.
        buf.savingRevision = null;
        buf.conflicted = true;
        buf.saveState = 'conflict';
        callbacks?.onCasRefused?.(written, refusedRevision);
        notifyDocumentBufferChanged(normalized, 'save_settled');
      },
      onError: (written, failedRevision, err) => {
        if (buf.savingRevision === failedRevision) buf.savingRevision = null;
        buf.saveError = err instanceof Error ? err.message : String(err);
        buf.saveState = 'error';
        callbacks?.onError?.(written, failedRevision, err);
        notifyDocumentBufferChanged(normalized, 'save_settled');
      },
    }, buf.content);
    if (!saved) return false;
    // A write can succeed while newer typing queues another revision. Report
    // success only after that queue settles and the current editor bytes are
    // the bytes acknowledged on disk.
    await waitForSaveQueue(queueKey);
    return currentBodyIsSaved();
  } finally {
    releaseDisplayPin();
  }
}
