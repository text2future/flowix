'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, LoaderCircle, Share2 } from 'lucide-react';
import { cloud, listenToCloudSyncStatusChanges } from '@platform/tauri/client/cloud';
import { windows } from '@platform/tauri/client';
import { getCloudSyncAccess } from '@/lib/cloud-account';
import { openCloudLoginDialog } from '@features/preferences/public/cloud-login-dialog';
import { openPaymentDialog } from '@features/cloud-billing/public/payment-dialog';
import { getWorkspaceMemoState } from '@features/memo/public/workspace-api';
import { notebookRelativeDirectoryPath } from '@/lib/path';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { Button } from '@shared/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Tooltip } from '@shared/ui/tooltip';

interface NoteShareControlProps {
  filePath: string;
  flushDocument: () => Promise<boolean>;
  iconButtonClass: string;
  kind?: 'note' | 'folder';
  openRequest?: number;
  hideTrigger?: boolean;
  onOpenChange?: (open: boolean) => void;
  onRequestFailed?: () => void;
}

function shareErrorMessage(error: unknown, t: ReturnType<typeof useI18n>['t']): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('CLOUD_SHARE_INVALID_FOLDER')) return t('document.share.invalidFolder');
  if (message.includes('NOTE_NOT_SYNCED') || message.includes('FOLDER_NOT_SYNCED') || message.includes('CLOUD_SHARE_SYNC_REQUIRED')) {
    return t('document.share.syncRequired');
  }
  if (message.includes('只能同步当前打开的笔记本') || message.includes('笔记本已切换')) {
    return t('document.share.notebookChanged');
  }
  if (message.includes('CLOUD_SHARE_NOTE_TOO_LARGE') || message.includes('NOTE_SHARE_TOO_LARGE')) {
    return t('document.share.tooLarge');
  }
  if (message.includes('CLOUD_SHARE_OFFICIAL_REQUIRED')) {
    return t('document.share.officialOnly');
  }
  const api = /^cloud API error (\d{3}) ([A-Z][A-Z0-9_]{0,79}):/.exec(message);
  const requestId = /\(request id: ([A-Za-z0-9_-]{1,128})\)$/.exec(message)?.[1];
  let result: string;
  if (api && (api[2] === 'COS_READ_FAILED' || api[2] === 'STORAGE_BACKEND_UNAVAILABLE' || api[2] === 'COS_NOT_CONFIGURED')) {
    result = t('document.share.storageFailed');
  } else if ((api && api[1] === '401') || message === 'not authenticated') {
    result = t('document.share.authFailed');
  } else if (api && Number(api[1]) >= 500) {
    result = t('document.share.serverFailed');
  } else if (message.startsWith('cloud request failed:')) {
    result = t('document.share.networkFailed');
  } else {
    result = t('document.share.createFailed');
  }
  if (api) result += ` (${api[2]})`;
  if (requestId) result += ` ${t('document.share.requestId', { id: requestId })}`;
  return result;
}

export function NoteShareControl({ filePath, flushDocument, iconButtonClass, kind = 'note', openRequest = 0, hideTrigger = false, onOpenChange, onRequestFailed }: NoteShareControlProps) {
  const { t, language } = useI18n();
  const urlInputId = useId();
  const [notebook, setNotebook] = useState<{ id: string; relativePath: string; sourcePath: string } | null>(null);
  const [resolutionFailed, setResolutionFailed] = useState(false);
  const [step, setStep] = useState<'login' | 'membership' | 'sync' | 'storage' | null>(null);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<number | null>(null);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const handledRequest = useRef(0);

  const wasOpen = useRef(false);
  useEffect(() => {
    if (open || wasOpen.current) onOpenChange?.(open);
    wasOpen.current = open;
  }, [open, onOpenChange]);

  useEffect(() => {
    let cancelled = false;
    setNotebook(null);
    setResolutionFailed(false);
    if (kind === 'note' && !/\.(?:md|markdown)$/iu.test(filePath)) return () => { cancelled = true; };
    void (async () => {
      const initialState = getWorkspaceMemoState();
      if (initialState.notebooks.length === 0) await initialState.loadNotebooks().catch(() => undefined);
      if (cancelled) return;
      const owner = getWorkspaceMemoState().notebooks
        .flatMap((candidate) => {
          const relativePath = notebookRelativeDirectoryPath(candidate.path, filePath);
          return relativePath === null ? [] : [{ id: candidate.id, path: candidate.path, relativePath }];
        })
        .sort((left, right) => right.path.length - left.path.length)[0];
      if (cancelled) return;
      if (owner) setNotebook({ id: owner.id, relativePath: owner.relativePath, sourcePath: filePath });
      else setResolutionFailed(true);
    })();
    return () => { cancelled = true; };
  }, [filePath, kind]);

  const createLink = useCallback(async (enableSync = false) => {
    if (!notebook || notebook.sourcePath !== filePath) return;
    setCreating(true);
    setStep(null);
    setError(null);
    setUrl(null);
    setExpiresAt(null);
    setCopied(false);
    setCopyError(null);
    let unlisten: (() => void) | undefined;
    try {
      const storage = await cloud.getStorageAccess();
      if (storage.target !== 'official') { setStep('storage'); return; }
      let state = await cloud.getState();
      if (!state.authenticated) { setStep('login'); return; }
      let access = getCloudSyncAccess(state);
      if (access.restriction === 'verifying') {
        await cloud.refreshMembership();
        state = await cloud.getState();
        access = getCloudSyncAccess(state);
      }
      if (access.restriction === 'membership_required') { setStep('membership'); return; }
      if (!access.canUpload || !(await cloud.getStorageAccess()).canUpload) { setStep('storage'); return; }
      const syncState = await cloud.getNotebookState(notebook.id);
      if (!syncState?.enabled && !enableSync) { setStep('sync'); return; }
      setSyncing(true);
      setSyncProgress(null);
      unlisten = listenToCloudSyncStatusChanges((status) => {
        if (status.notebookId !== notebook.id || status.progressTotal == null || status.progressCompleted == null || status.progressTotal === 0) return;
        setSyncProgress(Math.min(100, Math.floor(status.progressCompleted * 100 / status.progressTotal)));
      });
      if (!syncState?.enabled) await cloud.setNotebookEnabled(notebook.id, true);
      const saved = await flushDocument();
      if (!saved) {
        setError(t('document.share.saveFailed'));
        return;
      }
      try {
        await cloud.syncNow(notebook.id);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message.includes('只能同步当前打开的笔记本') || message.includes('笔记本已切换')
          ? t('document.share.notebookChanged') : t('document.share.syncFailed'));
        return;
      }
      setSyncing(false);
      const link = kind === 'folder'
        ? await cloud.createFolderShareLink(notebook.id, notebook.relativePath)
        : await cloud.createNoteShareLink(notebook.id, notebook.relativePath);
      setUrl(link.url);
      setExpiresAt(link.expiresAt);
    } catch (cause) {
      setError(shareErrorMessage(cause, t));
    } finally {
      unlisten?.();
      setSyncing(false);
      setSyncProgress(null);
      setCreating(false);
    }
  }, [filePath, flushDocument, kind, notebook, t]);

  const openDialog = () => {
    setOpen(true);
    if (!creating && (!url || !expiresAt || expiresAt <= Date.now())) void createLink();
  };

  useEffect(() => {
    if (!openRequest || openRequest === handledRequest.current || !notebook || notebook.sourcePath !== filePath) return;
    handledRequest.current = openRequest;
    setOpen(true);
    if (!creating && (!url || !expiresAt || expiresAt <= Date.now())) void createLink();
  }, [openRequest, notebook, filePath, creating, url, expiresAt, createLink]);

  useEffect(() => {
    if (!resolutionFailed || !openRequest || openRequest === handledRequest.current) return;
    handledRequest.current = openRequest;
    onOpenChange?.(false);
    toast.error(t('document.share.notebookUnavailable'));
    onRequestFailed?.();
  }, [resolutionFailed, openRequest, onOpenChange, onRequestFailed, t]);

  const copyLink = async () => {
    if (!url) return;
    setCopying(true);
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setCopying(false);
    } catch {
      setCopying(false);
      setCopyError(t('document.share.copyFailed'));
    }
  };

  if (!notebook || notebook.sourcePath !== filePath) return null;

  const expiryLabel = expiresAt
    ? new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(expiresAt))
    : null;

  return (
    <>
      {!hideTrigger && <Tooltip content={t(kind === 'folder' ? 'document.share.folderTitle' : 'document.share.action')}>
        <button
          type="button"
          className={iconButtonClass}
          aria-label={t(kind === 'folder' ? 'document.share.folderTitle' : 'document.share.action')}
          onClick={openDialog}
        >
          <Share2 className="h-4 w-4 shrink-0" width={16} height={16} viewBox="-1 -1 26 26" aria-hidden="true" />
        </button>
      </Tooltip>}
      <Dialog open={open} onOpenChange={(next) => { if (!creating || syncing) setOpen(next); }}>
        <DialogContent className="max-w-lg" closeDisabled={creating && !syncing}>
          <DialogHeader>
            <DialogTitle>{t(kind === 'folder' && notebook.relativePath === '' ? 'document.share.notebookTitle' : kind === 'folder' ? 'document.share.folderTitle' : 'document.share.title')}</DialogTitle>
            <DialogDescription>{t(step ? `document.share.step.${step}` : kind === 'folder' && notebook.relativePath === '' ? 'document.share.notebookDescription' : kind === 'folder' ? 'document.share.folderDescription' : 'document.share.description')}</DialogDescription>
          </DialogHeader>
          {creating && (
            <div className="flex items-center gap-2 py-3 text-sm text-[var(--muted-foreground)]" role="status">
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
              {syncing && syncProgress === 100
                ? t('document.share.syncFinalizing')
                : syncing && syncProgress !== null
                ? t('document.share.syncProgress', { percent: syncProgress })
                : t(syncing ? 'document.share.syncing' : 'document.share.creating')}
            </div>
          )}
          {syncing && <p className="text-sm text-[var(--muted-foreground)]">{t('document.share.backgroundHint')}</p>}
          {error && <p className="rounded-md bg-[var(--destructive)]/10 px-3 py-2 text-sm text-[var(--destructive)]" role="alert">{error}</p>}
          {url && (
            <div className="space-y-3">
              <label className="block text-sm font-medium" htmlFor={urlInputId}>{t('document.share.linkLabel')}</label>
              <div className="flex gap-2">
                <input
                  id={urlInputId}
                  type="text"
                  readOnly
                  value={url}
                  onFocus={(event) => event.currentTarget.select()}
                  className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm"
                />
                <Button type="button" variant="outline" onClick={() => void copyLink()} disabled={copying}>
                  {copying ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  {copied ? t('document.share.copied') : t('document.share.copy')}
                </Button>
              </div>
              {copyError && <p className="text-sm text-[var(--destructive)]" role="alert">{copyError}</p>}
              {expiryLabel && <p className="text-sm text-[var(--muted-foreground)]">{t('document.share.expires', { date: expiryLabel })}</p>}
              {kind === 'note' && <p className="text-sm text-[var(--muted-foreground)]">{t('document.share.imageNote')}</p>}
            </div>
          )}
          <DialogFooter>
            {step && !creating && <Button type="button" onClick={() => {
              if (step === 'sync') {
                void createLink(true);
              } else {
                setOpen(false);
                void (step === 'login' ? openCloudLoginDialog() : step === 'membership' ? openPaymentDialog('membership') : windows.openPreferences('cloudSync'));
              }
            }}>{t(`document.share.stepAction.${step}`)}</Button>}
            {error && !creating && !step && <Button type="button" variant="outline" onClick={() => void createLink()}>
              {t('document.share.retry')}
            </Button>}
            <Button type="button" variant={url ? 'default' : 'outline'} onClick={() => setOpen(false)} disabled={creating && !syncing}>
              {t(syncing ? 'document.share.backgroundSync' : 'document.share.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
