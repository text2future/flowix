import { listDocumentSessions, findDocumentSession, subscribeDocumentSessions } from '../store/document-runtime-session';
import { isTitleSaving, subscribeTitleChanges } from '../store/document-title-session';
import { clearRecoveryDraftThrough } from '../store/recovery-draft-store';
import { toast as notifications } from 'sonner';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useI18n } from '@/lib/i18n';
import { findFileDisplayPath } from '@/lib/file-display-registry';
import { captureLatestDocumentContent, getDocumentBuffer, protectDocumentDraft, saveDocumentContent, applyLoadedDocumentContent } from '../store/document-session-service';
import { notifyDocumentBufferChanged, subscribeDocumentBufferChanges } from '../store/buffer-registry';
import type { DocumentIdentity } from '../store/document-identity';
import { localDocumentOperations } from '../use-cases/local-document-operations';
import { Button } from '@shared/ui/button';

export function DocumentSaveStatus({ identity, scopePath, inline = false }: {
  identity: DocumentIdentity; scopePath: string | null; inline?: boolean;
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
    return JSON.stringify([buffer.saveState, buffer.saveError, buffer.conflicted, buffer.savingRevision, isTitleSaving(identity.displayId)]);
  }, [identity]);
  const status = useSyncExternalStore(subscribe, snapshot, snapshot);
  const buffer = getDocumentBuffer(identity);
  const [working, setWorking] = useState(false);
  const saving = buffer.savingRevision !== null || isTitleSaving(identity.displayId);
  void status;

  const resolve = async (choice: 'retry' | 'local' | 'disk') => {
    if (working || saving) return;
    setWorking(true);
    const path = findFileDisplayPath(identity.displayId) ?? identity.path;
    captureLatestDocumentContent(identity);
    const revision = buffer.capturedRevision;
    try {
      if (choice !== 'retry') {
        // Keep the local copy recoverable before an explicit conflict decision.
        if (!await protectDocumentDraft(identity, path, 'save-error')) return;
        const disk = await localDocumentOperations.read({
          path, scopePath,
        });
        if (disk === null) throw new Error(t('document.save.missing'));
        captureLatestDocumentContent(identity);
        if (buffer.capturedRevision !== revision) return;
        if (choice === 'disk') {
          await clearRecoveryDraftThrough({ ...identity, path }, findDocumentSession(identity.displayId)!.recoveryRevision);
          captureLatestDocumentContent(identity);
          if (buffer.capturedRevision !== revision) return;
          applyLoadedDocumentContent(identity, path, disk, { preservePending: false });
          void protectDocumentDraft(identity, path, 'autosave');
          return;
        }
        // This decision authorizes replacing the disk version just read. If
        // the file changes again, the conditional writer reconciles it anew.
        buffer.lastSavedContent = disk;
        buffer.conflicted = false;
        buffer.conflictContent = null;
      }
      buffer.saveError = null;
      await saveDocumentContent({ identity, path, content: buffer.content, scopePath, force: true });
    } catch (error) {
      buffer.saveError = error instanceof Error ? error.message : String(error);
    } finally {
      notifyDocumentBufferChanged(identity, 'save_settled');
      setWorking(false);
    }
  };
  const notificationId = `document-save:${identity.displayId}`;
  useEffect(() => () => { if (!inline) notifications.dismiss(notificationId); }, [inline, notificationId]);
  useEffect(() => {
    if (inline) return;
    if (buffer.conflicted || !buffer.saveError) { notifications.dismiss(notificationId); return; }
    notifications.custom(() => <div role="status" aria-live="polite" className="flex w-[var(--width)] flex-wrap items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--floating-bg)] px-4 py-3 text-sm text-[var(--floating-foreground)] shadow-lg">
    <span className="w-full truncate font-medium" title={identity.path}>{identity.path.split(/[\\/]/).pop()}</span>
    <span>{t('document.save.failed', { message: buffer.saveError ?? '' })}</span>
    <button className="underline" disabled={working || saving} onClick={() => void resolve('retry')}>{t('document.save.retry')}</button>
  </div>, { id: notificationId, duration: Infinity });
  });
  if (inline && buffer.conflicted) {
    return <div role="alert" aria-live="polite"
      className="absolute left-1/2 top-0 z-[30] flex w-max max-w-[calc(100%-1rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--card)] p-2 text-sm text-[var(--foreground)] shadow-lg animate-in slide-in-from-top-2 fade-in duration-200">
      <span className="px-1 font-medium whitespace-nowrap">{t('document.save.conflictPrompt')}</span>
      <Button variant="outline" size="sm" className="rounded-lg" disabled={working || saving} onClick={() => void resolve('disk')}>
        {t('document.save.useDisk')}
      </Button>
      <Button size="sm" className="rounded-lg" disabled={working || saving} onClick={() => void resolve('local')}>
        {t('document.save.keepLocal')}
      </Button>
    </div>;
  }
  return null;
}

export function DocumentConflictPanel(props: { identity: DocumentIdentity; scopePath: string | null }) {
  return <DocumentSaveStatus {...props} inline />;
}

const subscribeNotifications = (notify: () => void) => {
  const stopSessions = subscribeDocumentSessions(notify);
  const stopBody = subscribeDocumentBufferChanges(notify);
  const stopTitle = subscribeTitleChanges(notify);
  return () => { stopSessions(); stopBody(); stopTitle(); };
};
const notificationSnapshot = () => JSON.stringify(listDocumentSessions()
  .filter(session => !session.buffer?.conflicted && session.buffer?.saveError)
  .map(session => session.identity.displayId).sort());

/** Exactly one host per window, independent of editor mounts. */
export function DocumentSaveNotifications() {
  const snapshot = useSyncExternalStore(subscribeNotifications, notificationSnapshot, notificationSnapshot);
  const displayIds: string[] = JSON.parse(snapshot);
  return <>{displayIds.map(displayId => {
    const session = findDocumentSession(displayId)!;
    return <DocumentSaveStatus key={displayId} identity={session.identity}
      scopePath={session.retainedAdapter?.scopePath ?? null} />;
  })}</>;
}
