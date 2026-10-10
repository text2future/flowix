import { listDocumentSessions, findDocumentSession, subscribeDocumentSessions } from '../store/document-runtime-session';
import { isTitleSaving, subscribeTitleChanges } from '../store/document-title-session';
import { clearRecoveryDraftThrough } from '../store/recovery-draft-store';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useI18n } from '@/lib/i18n';
import { findFileDisplayPath } from '@/lib/file-display-registry';
import { captureLatestDocumentContent, getDocumentBuffer, protectDocumentDraft, saveDocumentContent, applyLoadedDocumentContent } from '../store/document-session-service';
import { notifyDocumentBufferChanged, subscribeDocumentBufferChanges } from '../store/buffer-registry';
import type { DocumentIdentity } from '../store/document-identity';
import { localDocumentOperations } from '../use-cases/local-document-operations';
import { clearActionableNotice, upsertActionableNotice } from '@features/notifications/actionable-notice-store';

const saveNoticeId = (displayId: string) => `document-save:${displayId}`;
const conflictNoticeId = (displayId: string) => `document-conflict:${displayId}`;

export function DocumentSaveStatus({ identity, scopePath }: {
  identity: DocumentIdentity; scopePath: string | null;
}) {
  const { t } = useI18n();
  const subscribe = useCallback((notify: () => void) => {
    const stopBody = subscribeDocumentBufferChanges(changed => {
      if (changed.displayId === identity.displayId) notify();
    });
    const stopTitle = subscribeTitleChanges(displayId => {
      if (displayId === identity.displayId) notify();
    });
    return () => { stopBody(); stopTitle(); };
  }, [identity.displayId]);
  const snapshot = useCallback(() => {
    const buffer = getDocumentBuffer(identity);
    return JSON.stringify([
      buffer.saveError,
      buffer.conflicted,
      buffer.capturedRevision,
      buffer.conflictContent !== null,
      buffer.savingRevision,
      isTitleSaving(identity.displayId),
    ]);
  }, [identity]);
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const buffer = getDocumentBuffer(identity);
  const path = findFileDisplayPath(identity.displayId) ?? identity.path;
  const filename = path.split(/[\\/]/).pop() ?? path;

  const resolve = useCallback(async (choice: 'retry' | 'local' | 'disk') => {
    const currentBuffer = getDocumentBuffer(identity);
    if (currentBuffer.savingRevision !== null || isTitleSaving(identity.displayId)) return;
    const currentPath = findFileDisplayPath(identity.displayId) ?? identity.path;
    captureLatestDocumentContent(identity);
    const revision = currentBuffer.capturedRevision;
    try {
      if (choice !== 'retry') {
        // Keep the local copy recoverable before an explicit conflict decision.
        if (!await protectDocumentDraft(identity, currentPath, 'save-error')) return;
        const disk = await localDocumentOperations.read({ path: currentPath, scopePath });
        if (disk === null) throw new Error(t('document.save.missing'));
        captureLatestDocumentContent(identity);
        if (currentBuffer.capturedRevision !== revision) return;
        if (choice === 'disk') {
          await clearRecoveryDraftThrough(
            { ...identity, path: currentPath },
            findDocumentSession(identity.displayId)!.recoveryRevision,
          );
          captureLatestDocumentContent(identity);
          if (currentBuffer.capturedRevision !== revision) return;
          applyLoadedDocumentContent(identity, currentPath, disk, { preservePending: false });
          void protectDocumentDraft(identity, currentPath, 'autosave');
          return;
        }
        // This decision authorizes replacing the disk version just read. If
        // the file changes again, the conditional writer reconciles it anew.
        currentBuffer.lastSavedContent = disk;
        currentBuffer.conflicted = false;
        currentBuffer.conflictContent = null;
      }
      currentBuffer.saveError = null;
      await saveDocumentContent({ identity, path: currentPath, content: currentBuffer.content, scopePath, force: true });
    } catch (error) {
      currentBuffer.saveError = error instanceof Error ? error.message : String(error);
    } finally {
      notifyDocumentBufferChanged(identity, 'save_settled');
    }
  }, [identity, scopePath, t]);

  useEffect(() => {
    const saveId = saveNoticeId(identity.displayId);
    const conflictId = conflictNoticeId(identity.displayId);
    // Keep an actionable notice visible while an explicit retry or conflict
    // decision is still writing. The settled buffer state decides whether it
    // should be cleared or replaced with a new failure notice.
    if (buffer.savingRevision !== null) return;
    if (buffer.conflicted) {
      clearActionableNotice(saveId);
      upsertActionableNotice({
        id: conflictId,
        priority: 100,
        tone: 'warning',
        title: `${filename} · ${t('document.save.conflictPrompt')}`,
        message: buffer.saveError
          ? `${t('document.save.conflictHelp')}\n${buffer.saveError}`
          : t('document.save.conflictHelp'),
        revision: `${buffer.capturedRevision}:${buffer.conflictContent?.length ?? 0}`,
        actions: [
          { id: 'disk', label: t('document.save.useDisk'), variant: 'outline', run: () => resolve('disk') },
          { id: 'local', label: t('document.save.keepLocal'), variant: 'default', run: () => resolve('local') },
        ],
      });
      return;
    }
    clearActionableNotice(conflictId);
    if (buffer.saveError) {
      upsertActionableNotice({
        id: saveId,
        priority: 80,
        tone: 'error',
        title: filename,
        message: t('document.save.failed', { message: buffer.saveError }),
        revision: `${buffer.capturedRevision}:${buffer.saveError}`,
        actions: [{ id: 'retry', label: t('document.save.retry'), variant: 'default', run: () => resolve('retry') }],
      });
    } else {
      clearActionableNotice(saveId);
    }
  }, [buffer, buffer.conflictContent, buffer.conflicted, buffer.capturedRevision, buffer.saveError, buffer.savingRevision, filename, identity.displayId, resolve, t]);

  useEffect(() => () => {
    clearActionableNotice(saveNoticeId(identity.displayId));
    clearActionableNotice(conflictNoticeId(identity.displayId));
  }, [identity.displayId]);

  return null;
}

const subscribeNotifications = (notify: () => void) => {
  const stopSessions = subscribeDocumentSessions(notify);
  const stopBody = subscribeDocumentBufferChanges(notify);
  const stopTitle = subscribeTitleChanges(notify);
  return () => { stopSessions(); stopBody(); stopTitle(); };
};
const notificationSnapshot = () => JSON.stringify(listDocumentSessions()
  .filter(session => session.buffer && (session.buffer.conflicted || session.buffer.saveError))
  .map(session => session.identity.displayId).sort());

/** Exactly one document notice bridge per window, independent of editor mounts. */
export function DocumentSaveNotifications() {
  const snapshot = useSyncExternalStore(subscribeNotifications, notificationSnapshot, notificationSnapshot);
  const displayIds: string[] = JSON.parse(snapshot);
  return <>{displayIds.map(displayId => {
    const session = findDocumentSession(displayId)!;
    return <DocumentSaveStatus key={displayId} identity={session.identity}
      scopePath={session.retainedAdapter?.scopePath ?? null} />;
  })}</>;
}
