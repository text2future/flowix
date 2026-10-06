import { getDocumentSession, findDocumentSession, listDocumentSessions, releaseDocumentSession, type PersistenceAdapter } from './document-runtime-session';
import { cancelDocumentCapture, scheduleDocumentCapture, hasDocumentCommit, waitForDocumentCommits, documentCommitDiagnostics } from './document-commit-queue';
import { getTitleDraft, hasTitleDraft, isTitleProtected, markTitleProtected, flushTitleDraft, subscribeTitleChanges } from './document-title-session';
import { pinFileDisplayId, findFileDisplayPath } from '@/lib/file-display-registry';
import { subscribeDocumentBufferChanges } from './buffer-registry';
import {
  applyLoadedContent,
  discardUnsavedLocalChanges,
  flushDocument,
  getBuffer,
  getCurrentIdentity,
  getCurrentPath,
  getOrCreateBuffer,
  hasUnsavedLocalChanges,
  notifyDocumentBufferChanged,
  releaseDocumentBuffer,
  rebaseCurrentDocumentPath,
  setCurrentDocument,
  type FlushCallbacks,
} from '@features/document/store/buffer-registry';
import { isDocumentContentEqual } from '@features/document/store/buffer-equality';
import type { DocumentBuffer } from '@features/document/store/document-buffer';
import {
  documentIdentityKey,
  type DocumentIdentity,
} from '@features/document/store/document-identity';
import { canonicalPath } from '@/lib/path';
import { persistRecoveryDraft, clearRecoveryDraftThrough, flushRecoveryOperations } from '@features/document/store/recovery-draft-store';
import { subscribeFileDisplayRelease } from '@/lib/file-display-registry';
import { waitForSaveQueue } from '@features/document/store/save-queue';

const RECOVERY_DRAFT_WRITE_TIMEOUT_MS = 3_000;

const pendingReleasedDisplays = new Set<string>();
const releaseChecksInFlight = new Set<string>();

function cleanupReleasedDisplayBuffer(displayId: string): void {
  const key = `md:${displayId}`;
  pendingReleasedDisplays.add(displayId);
  if (releaseChecksInFlight.has(displayId)) return;
  releaseChecksInFlight.add(displayId);

  void waitForSaveQueue(key).then((settled) => {
    if (!settled) {
      pendingReleasedDisplays.delete(displayId);
      return;
    }
    // A store update can release the identity just before React unmounts its
    // editor. The final capture unregister retries this cleanup afterwards.
    if (findDocumentSession(displayId)?.captures.size) return;
    releaseDocumentBuffer(displayId);
    stagedDocumentSnapshots.delete(key);
    releaseDocumentSession(displayId);
    pendingReleasedDisplays.delete(displayId);
  }).catch(() => {
    pendingReleasedDisplays.delete(displayId);
  }).finally(() => {
    releaseChecksInFlight.delete(displayId);
  });
}

subscribeFileDisplayRelease(cleanupReleasedDisplayBuffer);

/** Register a mounted editor capable of publishing its latest content. */
export function registerDocumentCapture(
  identity: DocumentIdentity,
  capture: () => string | null,
  hostId?: string,
  isActive?: () => boolean,
): () => void {
  const session = getDocumentSession(identity);
  const registration = { hostId, capture, isActive };
  session.captures.add(registration);
  return () => {
    session.captures.delete(registration);
    if (!session.captures.size && pendingReleasedDisplays.has(identity.displayId)) {
      cleanupReleasedDisplayBuffer(identity.displayId);
    }
  };
}

/** Only the editing surface may publish deferred full-document snapshots. */
export function captureLatestDocumentContent(identity: DocumentIdentity, hostId?: string): void {
  const session = findDocumentSession(identity.displayId);
  if (!session) return;
  const wasCapturing = session.capturing; session.capturing = true;
  try {
    for (const registration of [...session.captures]) {
      if (hostId !== undefined ? registration.hostId !== hostId : registration.isActive && !registration.isActive()) continue;
      registration.capture();
    }
  } finally { session.capturing = wasCapturing; }
}

/** All surfaces feed one session-owned clock and persistence operation. */
export function scheduleDocumentSessionSave(identity: DocumentIdentity): void {
  const session = getDocumentSession(identity);
  if (session.capturing) return;
  scheduleDocumentCapture(documentIdentityKey(identity), () => commitDocumentSession(session.identity));
}

export function commitDocumentSession(identity: DocumentIdentity): void {
  const session = getDocumentSession(identity);
  cancelDocumentCapture(documentIdentityKey(identity));
  session.capturing = true;
  try { captureLatestDocumentContent(identity); }
  finally { session.capturing = false; }
  const path = session.identity.path;
  if (!path) return;
  void protectDocumentDraft(session.identity, path, 'autosave');
  if (hasUnsavedLocalChanges(identity)) {
    void flushDocument(session.identity, path, { scopePath: session.retainedAdapter?.scopePath }).then(saved => {
      if (!saved) void protectDocumentDraft(session.identity, session.identity.path, 'save-error');
    });
  }
}

export async function protectDocumentDraft(
  identity: DocumentIdentity,
  path: string,
  reason: 'autosave' | 'save-timeout' | 'save-error' | 'shutdown',
): Promise<boolean> {
  const buffer = getOrCreateBuffer(identity);
  const title = getTitleDraft(identity.displayId);
  if (!hasUnsavedLocalChanges(identity) && !title) return true;
  const bodyRevision = buffer.capturedRevision;
  const revision = getDocumentSession(identity).recoveryRevision;
  const protectedByDraft = await waitWithTimeout(persistRecoveryDraft({
    identity: { ...identity, path: canonicalPath(path) },
    originalPath: canonicalPath(path),
    revision,
    bodyRevision,
    title: title ?? undefined,
    content: buffer.content,
    baseContent: buffer.lastSavedContent,
    reason,
  }), RECOVERY_DRAFT_WRITE_TIMEOUT_MS);
  if (protectedByDraft !== true) return false;
  if (title) markTitleProtected(identity.displayId, title.revision);
  buffer.durableRevision = Math.max(buffer.durableRevision, bodyRevision);
  if (!buffer.conflicted && !buffer.saveError && buffer.savedRevision < buffer.capturedRevision) buffer.saveState = 'protected';
  notifyDocumentBufferChanged(identity, 'save_settled');
  return true;
}

/** Reconcile an external write without losing the editor's scheduled save.
 * A failed or stale recovery checkpoint falls back to the ordinary session
 * save clock, which will retry protection and the conditional disk write.
 */
export async function reconcileUnsavedExternalDocumentChange(
  identity: DocumentIdentity,
  path: string,
  scopePath: string | null,
): Promise<void> {
  captureLatestDocumentContent(identity);
  if (!hasUnsavedLocalChanges(identity)) return;
  const buffer = getOrCreateBuffer(identity);
  const revision = buffer.capturedRevision;
  const protectedDraft = await protectDocumentDraft(identity, path, 'autosave').catch(() => false);
  captureLatestDocumentContent(identity);
  if (!hasUnsavedLocalChanges(identity)) return;
  if (!protectedDraft || buffer.capturedRevision !== revision) {
    scheduleDocumentSessionSave(identity);
    return;
  }
  cancelDocumentCapture(documentIdentityKey(identity));
  await saveDocumentContent({
    identity, path, content: buffer.content, scopePath, force: true,
  });
}

export function applyRecoveryDraftContent(
  identity: DocumentIdentity,
  content: string,
  revision: number,
): DocumentBuffer {
  const buffer = getOrCreateBuffer(identity);
  buffer.content = content;
  buffer.pendingContent = content;
  buffer.editRevision = Math.max(buffer.editRevision, revision);
  buffer.capturedRevision = Math.max(buffer.capturedRevision, revision);
  buffer.durableRevision = Math.max(buffer.durableRevision, revision);
  buffer.pendingRevision = buffer.capturedRevision;
  buffer.saveState = 'protected';
  notifyDocumentBufferChanged(identity, 'loaded');
  return buffer;
}

function waitWithTimeout(promise: Promise<boolean>, timeoutMs: number): Promise<boolean | 'timeout'> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve('timeout'), timeoutMs);
    void promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      () => {
        window.clearTimeout(timer);
        resolve(false);
      },
    );
  });
}


interface DocumentDraftSnapshot {
  identity: DocumentIdentity;
  path: string;
  content: string;
}

interface DocumentEditResult {
  changed: boolean;
  buffer: DocumentBuffer;
}

interface StagedDocumentSnapshot {
  path: string;
  content: string;
}

const stagedDocumentSnapshots = new Map<string, StagedDocumentSnapshot>();

/** One-shot authoritative content returned together with memo metadata. */
export function stageDocumentSnapshot(
  identity: DocumentIdentity,
  path: string,
  content: string,
): void {
  stagedDocumentSnapshots.set(documentIdentityKey(identity), {
    path: canonicalPath(path),
    content,
  });
}

export function consumeStagedDocumentSnapshot(
  identity: DocumentIdentity,
  path: string,
): string | null {
  const key = documentIdentityKey(identity);
  const snapshot = stagedDocumentSnapshots.get(key);
  if (!snapshot || snapshot.path !== canonicalPath(path)) return null;
  stagedDocumentSnapshots.delete(key);
  return snapshot.content;
}

interface SaveDocumentContentOptions {
  path: string;
  identity: DocumentIdentity;
  content: string;
  /** Authorized file-tree root for external code/text documents. */
  scopePath?: string | null;
  force?: boolean;
  callbacks?: FlushCallbacks;
}

export function getActiveDocumentDraft(): DocumentDraftSnapshot | null {
  const identity = getCurrentIdentity();
  const path = getCurrentPath();
  return identity && path ? getDocumentDraft(identity, path) : null;
}

export function getDocumentDraft(
  identity: DocumentIdentity,
  path: string,
): DocumentDraftSnapshot | null {
  const buffer = getBuffer(identity);
  if (!path || !buffer || buffer.content == null) return null;
  return { identity, path, content: buffer.content };
}

/** Record user edits against the buffer owned by the runtime display identity. */
export function recordDocumentEdit(identity: DocumentIdentity, content: string): DocumentEditResult {
  const buffer = getOrCreateBuffer(identity);
  if (content === buffer.content) {
    return { changed: !isDocumentContentEqual(identity, content, buffer.lastSavedContent), buffer };
  }
  retainDocumentDraft(identity);
  getDocumentSession(identity).recoveryRevision += 1;
  buffer.editRevision += 1;
  buffer.capturedRevision = buffer.editRevision;
  if (buffer.savingRevision === null && !buffer.conflicted && isDocumentContentEqual(identity, content, buffer.lastSavedContent)) {
    buffer.content = content;
    buffer.pendingContent = null;
    buffer.pendingRevision = null;
    buffer.savedRevision = buffer.capturedRevision;
    buffer.durableRevision = buffer.capturedRevision;
    buffer.saveState = 'clean';
    notifyDocumentBufferChanged(identity, 'edited');
    return { changed: false, buffer };
  }
  buffer.content = content;
  buffer.pendingContent = content;
  buffer.pendingRevision = buffer.capturedRevision;
  buffer.saveState = buffer.conflicted ? 'conflict' : 'dirty';
  notifyDocumentBufferChanged(identity, 'edited');
  return { changed: true, buffer };
}

/** Write a buffer snapshot to its current backing path. */
export async function saveDocumentContent({
  path,
  identity,
  content,
  scopePath,
  force,
  callbacks,
}: SaveDocumentContentOptions): Promise<boolean> {
  if (!path) return true;
  const buffer = getOrCreateBuffer(identity);

  if (content !== buffer.content) {
    recordDocumentEdit(identity, content);
  }

  return flushDocument(identity, path, { scopePath, force, ...callbacks });
}

export function flushDocumentPath(
  identity: DocumentIdentity,
  path: string,
  scopePath: string | null = null,
): Promise<boolean> {
  return prepareDocumentLeave(identity, path, scopePath);
}

/** Wait until the current editor buffer is on disk before reading it for a snapshot or preview. */
export async function saveDocumentPath(
  identity: DocumentIdentity,
  path: string,
  scopePath: string | null = null,
): Promise<boolean> {
  if (!path) return false;
  cancelDocumentCapture(documentIdentityKey(identity));
  captureLatestDocumentContent(identity);
  await flushTitleDraft(identity.displayId);
  return flushDocument(identity, path, { scopePath });
}

/**
 * Capture and retain the outgoing session, then save and checkpoint in the
 * background. Only desktop shutdown waits for durability.
 */
export async function prepareDocumentLeave(
  identity: DocumentIdentity,
  path: string,
  scopePath: string | null = null,
): Promise<boolean> {
  cancelDocumentCapture(documentIdentityKey(identity));
  captureLatestDocumentContent(identity);
  void flushTitleDraft(identity.displayId);
  if (!hasUnsavedLocalChanges(identity) && !hasTitleDraft(identity.displayId)) return true;
  retainDocumentDraft(identity);
  void flushDocument(identity, path, { scopePath });
  void protectDocumentDraft(identity, findFileDisplayPath(identity.displayId) ?? path, 'autosave');
  // Navigation keeps the session in memory. Only application shutdown is a
  // durability barrier; moving focus must never wait for a filesystem lock.
  return true;
}

export function getDocumentBuffer(identity: DocumentIdentity): DocumentBuffer {
  return getOrCreateBuffer(identity);
}

export function hasDocumentUnsavedChanges(identity?: DocumentIdentity): boolean {
  return hasUnsavedLocalChanges(identity);
}

export function discardDocumentDraft(identity: DocumentIdentity): void {
  discardUnsavedLocalChanges(identity);
}

export function applyLoadedDocumentContent(
  identity: DocumentIdentity,
  path: string,
  fullContent: string,
  options?: { preservePending?: boolean; setAsCurrent?: boolean },
): DocumentBuffer {
  return applyLoadedContent(identity, path, fullContent, options);
}

export function setActiveDocumentPath(identity: DocumentIdentity | null, path: string | null): void {
  setCurrentDocument(identity, path);
}

export function rebaseActiveDocumentPath(identity: DocumentIdentity, path: string): void {
  rebaseCurrentDocumentPath(identity, path);
}

const retainedDrafts = new Map<string, () => void>();
function retainDocumentDraft(identity: DocumentIdentity): void {
  const key = documentIdentityKey(identity);
  if (!retainedDrafts.has(key)) retainedDrafts.set(key, pinFileDisplayId(identity.displayId));
}
export function registerDocumentPersistence(identity: DocumentIdentity, adapter: PersistenceAdapter): () => void {
  const session = getDocumentSession(identity);
  session.adapters.add(adapter);
  session.retainedAdapter = adapter;
  return () => {
    session.adapters.delete(adapter);
    session.retainedAdapter = [...session.adapters].slice(-1)[0] ?? adapter;
    releaseDocumentSession(identity.displayId);
  };
}
subscribeTitleChanges((displayId, edited) => {
  const session = findDocumentSession(displayId);
  if (!session) return;
  const { identity } = session;
  const buffer = getOrCreateBuffer(identity);
  if (edited) {
    retainDocumentDraft(identity);
    session.recoveryRevision += 1;
    scheduleDocumentSessionSave(identity);
  } else if (!hasTitleDraft(displayId) && !hasUnsavedLocalChanges(identity)) {
    buffer.savedRevision = buffer.capturedRevision;
    buffer.durableRevision = buffer.capturedRevision;
    void clearRecoveryDraftThrough({ ...identity, path: findFileDisplayPath(identity.displayId) ?? identity.path }, session.recoveryRevision);
    notifyDocumentBufferChanged(identity, 'save_settled');
  }
});
subscribeDocumentBufferChanges((identity) => {
  const buffer = getBuffer(identity);
  if (!buffer || buffer.durableRevision < buffer.capturedRevision) return;
  const title = getTitleDraft(identity.displayId);
  if (title && !isTitleProtected(identity.displayId)) return;
  const key = documentIdentityKey(identity);
  const release = retainedDrafts.get(key);
  retainedDrafts.delete(key);
  release?.();
});

/** Called by the desktop close/quit handshake, not fire-and-forget unload. */
export async function flushAllDocumentSessions(): Promise<boolean> {
  const registrations = listDocumentSessions().flatMap(session => {
    const adapter = [...session.adapters].slice(-1)[0] ?? session.retainedAdapter;
    return adapter ? [{ identity: session.identity, adapter }] : [];
  });
  const results = await Promise.all(registrations.map(async ({ identity, adapter }) => {
    const key = documentIdentityKey(identity);
    cancelDocumentCapture(key);
    captureLatestDocumentContent(identity);
    adapter.capture();
    const titleSave = flushTitleDraft(identity.displayId);
    const bodySave = flushDocument(identity, adapter.path(), { scopePath: adapter.scopePath });
    const protectedDraft = protectDocumentDraft(identity, adapter.path(), 'shutdown');
    const result = await waitWithTimeout(Promise.all([titleSave, bodySave, waitForDocumentCommits(key)])
      .then(values => values.every(Boolean)), 5_000);
    captureLatestDocumentContent(identity);
    if (result === true && !hasUnsavedLocalChanges(identity) && !hasTitleDraft(identity.displayId)) return true;
    // A timed-out mutation may have renamed the file. Do not close the process
    // until its outcome is known, even when a recovery checkpoint exists.
    if (hasDocumentCommit(key)) return false;
    if (await waitWithTimeout(protectedDraft, 3_000) !== true) return false;
    const protectedLatest = await waitWithTimeout(protectDocumentDraft(identity, adapter.path(), 'shutdown'), 3_000);
    captureLatestDocumentContent(identity);
    const buffer = getDocumentBuffer(identity);
    return protectedLatest && buffer.durableRevision >= buffer.capturedRevision
      && isTitleProtected(identity.displayId) && !hasDocumentCommit(key);
  }));
  const recoverySettled = await waitWithTimeout(flushRecoveryOperations(), 3_000);
  return results.every(Boolean) && recoverySettled === true && documentCommitDiagnostics().active === 0;
}
