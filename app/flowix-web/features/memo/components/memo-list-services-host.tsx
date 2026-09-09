'use client';

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { displayTitleFromFilename } from '@/lib/utils';
import { useShortcutScope, pushHandler } from '@features/shortcuts';
import { useI18n, type I18nParams } from '@/lib/i18n';
import { useShallow } from 'zustand/react/shallow';
import {
  cloud,
  listenToCloudStateChanges,
  windows as tauriWindows,
  type CloudNotebook,
} from '@platform/tauri/client';
import { useTauriRpc } from '@platform/tauri/use-tauri-rpc';
import { cloudSyncErrorMessage, isInvalidRefreshTokenError } from '@platform/tauri/errors';
import { useCreateNotebookFlow } from '@features/memo/hooks/use-create-notebook-flow';
import { memoRepository, notebookRepository } from '@features/memo/services/memo-repository';
import { getVisibleCreateFilter, useMemoStore, useTagStore, type MemoItem, type Notebook } from '@features/memo/store';
import { getNotebookIconOption } from '@features/memo/components/notebook-icon';
import { openMemoSession } from '@features/memo/use-cases/open-memo-session';
import { clearWorkspaceDocument } from '@features/workspace/use-cases/workspace-navigation';
import {
  flushBrowserColumnMemo,
  removeBrowserColumnTabsByMemoId,
} from '@features/workspace/use-cases/browser-column-navigation';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Kbd } from '@shared/ui/kbd';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { LazyGlobalSearchCommand } from '@features/memo/components/lazy-global-search-command';

const LazyNotebookDialogs = lazy(() =>
  import('@features/memo/components/notebook-dialogs').then((module) => ({
    default: module.NotebookDialogs,
  })),
);

function normalizeNotebookIconId(icon: string | null | undefined): string | null {
  return getNotebookIconOption(icon) ? icon! : null;
}

function DeleteDialogShortcuts({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useShortcutScope('dialog');

  useEffect(() => {
    const popCancel = pushHandler('dialog.cancel', onCancel);
    const popConfirm = pushHandler('dialog.confirm', () => {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)
      ) {
        return false;
      }
      onConfirm();
    });
    return () => {
      popCancel();
      popConfirm();
    };
  }, [onCancel, onConfirm]);

  return null;
}

function BlockingOperationStatus({ text, stacked }: { text: string; stacked: boolean }) {
  return (
    <div className="pointer-events-auto fixed inset-0 z-[1400] flex items-center justify-center bg-[color-mix(in_oklch,var(--card)_82%,transparent)] backdrop-blur-[1px]">
      <div className={cn('flex items-center gap-2 px-3 py-2 text-sm text-[var(--foreground)]', stacked && 'flex-col')} role="status" aria-live="polite">
        <Loader2 className="h-4 w-4 animate-spin text-[var(--primary)]" />
        <span>{text}</span>
      </div>
    </div>
  );
}

/**
 * Application-level host for memo actions that must remain available while
 * the middle column switches from MemoList to AgentConversationList.
 *
 * This component intentionally renders no list. It owns only global event
 * bridges, dialogs, command-palette state, and memo/notebook commands.
 */
export function MemoListServicesHost({
  notebookCreateRequest,
  onRefresh,
}: {
  notebookCreateRequest: number;
  onRefresh: () => void;
}) {
  const { request } = useTauriRpc();
  const { t } = useI18n();
  const selectedMemo = useMemoStore((state) => state.selectedMemo);
  const selectedNotebook = useMemoStore((state) => state.selectedNotebook);
  const notebooks = useMemoStore((state) => state.notebooks);
  const activeFilter = useMemoStore((state) => state.activeFilter);
  const startupPhase = useMemoStore((state) => state.startupPhase);
  const selectedTagId = useTagStore((state) => state.selectedTagId);
  const setSelectedTagId = useTagStore((state) => state.setSelectedTagId);
  const {
    setSelectedMemo,
    setSelectedNotebook,
    setNotebooks,
    setActiveFilter,
    triggerRefresh,
    handleMemoCreated,
  } = useMemoStore(
    useShallow((state) => ({
      setSelectedMemo: state.setSelectedMemo,
      setSelectedNotebook: state.setSelectedNotebook,
      setNotebooks: state.setNotebooks,
      setActiveFilter: state.setActiveFilter,
      triggerRefresh: state.triggerRefresh,
      handleMemoCreated: state.handleMemoCreated,
    })),
  );

  const [deleteMemo, setDeleteMemo] = useState<MemoItem | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [newIcon, setNewIcon] = useState<string | null>(null);
  const [createMode, setCreateMode] = useState<'create' | 'cloud'>('create');
  const [remoteNotebooks, setRemoteNotebooks] = useState<CloudNotebook[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [syncingRemoteId, setSyncingRemoteId] = useState<string | null>(null);
  const [cloudImporting, setCloudImporting] = useState(false);
  const [editingNotebook, setEditingNotebook] = useState<Notebook | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editIcon, setEditIcon] = useState<string | null>(null);
  const [editCloudSync, setEditCloudSync] = useState(false);
  const [originalEditCloudSync, setOriginalEditCloudSync] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [cloudSyncAvailable, setCloudSyncAvailable] = useState(false);
  const emptyNotebookPromptedRef = useRef(false);

  const { blockingLoadingText, createNotebook } = useCreateNotebookFlow({
    onMemoListReloadNeeded: onRefresh,
    onMemoListQueryReset: () => undefined,
    onMemoListLoadingChange: () => undefined,
  });

  const resetCreateState = useCallback(() => {
    setCreateOpen(false);
    setCreateMode('create');
    setNewName('');
    setNewPath('');
    setNewIcon(null);
    setRemoteNotebooks([]);
    setRemoteLoading(false);
    setSyncingRemoteId(null);
  }, []);

  const openCreate = useCallback(() => {
    setNewName('');
    setNewPath('');
    setNewIcon(null);
    setCreateMode('create');
    setRemoteNotebooks([]);
    setRemoteLoading(false);
    setSyncingRemoteId(null);
    setCreateOpen(true);
  }, []);

  useEffect(() => {
    if (notebookCreateRequest > 0) openCreate();
  }, [notebookCreateRequest, openCreate]);

  useEffect(() => {
    if (startupPhase !== 'ready') return;
    if (selectedNotebook) {
      emptyNotebookPromptedRef.current = false;
      return;
    }
    if (emptyNotebookPromptedRef.current) return;
    emptyNotebookPromptedRef.current = true;
    openCreate();
  }, [openCreate, selectedNotebook, startupPhase]);

  useEffect(() => {
    if (!editOpen || !editingNotebook) return;
    let cancelled = false;
    void Promise.all([cloud.getState(), cloud.getNotebookState(editingNotebook.id)])
      .then(([cloudState, link]) => {
        if (cancelled) return;
        const enabled = Boolean(link?.enabled);
        setCloudSyncAvailable(cloudState.authenticated && cloudState.enabled);
        setEditCloudSync(enabled);
        setOriginalEditCloudSync(enabled);
      })
      .catch(() => {
        if (!cancelled) setCloudSyncAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editOpen, editingNotebook]);

  useEffect(() => listenToCloudStateChanges((state) => {
    setCloudSyncAvailable(state.authenticated && state.enabled);
  }), []);

  useEffect(() => {
    const handleOpenCreate = () => openCreate();
    const handleOpenEdit = (event: Event) => {
      const notebook = (event as CustomEvent<Notebook>).detail;
      if (!notebook) return;
      setEditSaving(false);
      setEditingNotebook(notebook);
      setEditName(notebook.name);
      setEditIcon(normalizeNotebookIconId(notebook.icon));
      setEditOpen(true);
    };
    const handleDeleteMemo = (event: Event) => {
      const memo = (event as CustomEvent<MemoItem>).detail;
      if (memo) setDeleteMemo(memo);
    };
    const handleTogglePalette = () => setSearchOpen((open) => !open);
    const handleOpenPalette = () => setSearchOpen(true);
    window.addEventListener('flowix:open-create-notebook', handleOpenCreate);
    window.addEventListener('flowix:open-edit-notebook', handleOpenEdit as EventListener);
    window.addEventListener('flowix:request-delete-memo', handleDeleteMemo as EventListener);
    window.addEventListener('flowix:toggle-palette', handleTogglePalette);
    window.addEventListener('flowix:open-palette', handleOpenPalette);
    return () => {
      window.removeEventListener('flowix:open-create-notebook', handleOpenCreate);
      window.removeEventListener('flowix:open-edit-notebook', handleOpenEdit as EventListener);
      window.removeEventListener('flowix:request-delete-memo', handleDeleteMemo as EventListener);
      window.removeEventListener('flowix:toggle-palette', handleTogglePalette);
      window.removeEventListener('flowix:open-palette', handleOpenPalette);
    };
  }, [openCreate]);

  const handleCreateMemo = useCallback(async () => {
    if (!selectedNotebook) return;
    const previousSelectedMemo = useMemoStore.getState().selectedMemo;
    const createFilter = getVisibleCreateFilter(activeFilter);
    if (createFilter !== activeFilter) {
      setSelectedTagId(null);
      setActiveFilter(createFilter);
    }
    const tagId = createFilter === 'tagged' ? selectedTagId : null;
    setSelectedMemo(null);
    let created: MemoItem;
    try {
      created = await memoRepository.create(tagId ?? undefined, selectedNotebook.id);
    } catch (error) {
      setSelectedMemo(previousSelectedMemo);
      toast.error(error instanceof Error ? error.message : String(error));
      return;
    }
    handleMemoCreated(created, { select: false });
    const shouldSelectNewMemo =
      createFilter === 'all' ||
      (createFilter === 'tagged' && Boolean(tagId)) ||
      createFilter === 'thisWeek' ||
      createFilter === 'thisMonth';
    if (shouldSelectNewMemo) {
      void openMemoSession({ ...created, isOpen: true }, selectedNotebook, { initialFocus: 'title' });
    }
  }, [activeFilter, handleMemoCreated, selectedNotebook, selectedTagId, setActiveFilter, setSelectedMemo, setSelectedTagId]);

  useEffect(() => {
    const handleRequest = () => void handleCreateMemo();
    window.addEventListener('flowix:create-memo', handleRequest);
    return () => window.removeEventListener('flowix:create-memo', handleRequest);
  }, [handleCreateMemo]);

  const handleDeleteConfirm = useCallback(() => {
    if (!deleteMemo) return;
    const memo = deleteMemo;
    setDeleteMemo(null);
    void (async () => {
      const flushed = await flushBrowserColumnMemo(memo.id);
      if (flushed === false) {
        toast.error(t('document.save.failed', { message: '当前页签保存失败，未删除笔记' }));
        return;
      }
      if (!await memoRepository.delete(memo.id)) return;
      removeBrowserColumnTabsByMemoId(memo.id);
      if (selectedMemo?.id === memo.id) {
        setSelectedMemo(null);
        await clearWorkspaceDocument();
      }
      triggerRefresh();
    })().catch((error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
  }, [deleteMemo, selectedMemo, setSelectedMemo, t, triggerRefresh]);

  const handleInvalidCloudSession = useCallback(async (error: unknown) => {
    if (!isInvalidRefreshTokenError(error)) return false;
    try {
      await cloud.logout();
    } catch {
      // The preferences window remains the recovery surface.
    }
    resetCreateState();
    toast.error(t('preferences.cloud.sessionExpired'));
    void tauriWindows.openPreferences('cloudSync').catch(() => undefined);
    return true;
  }, [resetCreateState, t]);

  const openRemoteNotebooks = useCallback(async () => {
    try {
      const state = await cloud.getState();
      setCloudSyncAvailable(state.authenticated && state.enabled);
      if (!state.authenticated) {
        resetCreateState();
        await tauriWindows.openPreferences('cloudSync');
        return;
      }
      setCreateMode('cloud');
      setRemoteLoading(true);
      setRemoteNotebooks(await cloud.listNotebooks());
    } catch (error) {
      if (!await handleInvalidCloudSession(error)) toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      setRemoteLoading(false);
    }
  }, [handleInvalidCloudSession, resetCreateState, t]);

  const selectRemoteNotebook = useCallback(async (remote: CloudNotebook) => {
    if (remote.synced || syncingRemoteId) return;
    try {
      setSyncingRemoteId(remote.id);
      let local = notebooks.find((item) => item.id === remote.id);
      if (!local) {
        const path = await request<string | null>('select_directory');
        if (!path) return;
        local = await createNotebook({
          cloudNotebookId: remote.id,
          name: remote.name,
          path,
          icon: normalizeNotebookIconId(remote.icon),
        }) ?? undefined;
      }
      if (!local) return;
      setCloudImporting(true);
      await cloud.linkNotebook(local.id, remote.id);
      await cloud.syncNow(local.id);
      resetCreateState();
      onRefresh();
      toast.success(t('notebook.cloudImport.complete'));
    } catch (error) {
      if (!await handleInvalidCloudSession(error)) toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      setCloudImporting(false);
      setSyncingRemoteId(null);
    }
  }, [createNotebook, handleInvalidCloudSession, notebooks, onRefresh, request, resetCreateState, syncingRemoteId, t]);

  const confirmCreate = useCallback(() => {
    if (!newName.trim()) return;
    void createNotebook({ name: newName, path: newPath || undefined, icon: newIcon }).then((created) => {
      if (created) resetCreateState();
    });
  }, [createNotebook, newIcon, newName, newPath, resetCreateState]);

  const closeEdit = useCallback(() => {
    if (editSaving) return;
    setEditOpen(false);
    setEditingNotebook(null);
    setEditName('');
    setEditIcon(null);
    setEditCloudSync(false);
    setOriginalEditCloudSync(false);
    setEditSaving(false);
  }, [editSaving]);

  const confirmEdit = useCallback(async () => {
    if (!editingNotebook || editSaving) return;
    const name = editName.trim();
    const icon = editIcon || null;
    const iconChanged = (icon ?? '') !== (normalizeNotebookIconId(editingNotebook.icon) ?? '');
    const metadataChanged = name !== editingNotebook.name || iconChanged;
    const cloudChanged = editCloudSync !== originalEditCloudSync;
    if (!name || (!metadataChanged && !cloudChanged)) {
      closeEdit();
      return;
    }
    try {
      setEditSaving(true);
      const updated = metadataChanged
        ? await notebookRepository.update(editingNotebook.id, name, icon ?? '')
        : editingNotebook;
      if (!updated) throw new Error(t('memo.list.updateFailed'));
      if (cloudChanged) await cloud.setNotebookEnabled(editingNotebook.id, editCloudSync);
      setNotebooks(useMemoStore.getState().notebooks.map((item) => item.id === updated.id ? updated : item));
      if (useMemoStore.getState().selectedNotebook?.id === updated.id) setSelectedNotebook(updated);
      if (cloudChanged && editCloudSync) {
        void cloud.syncNow(editingNotebook.id).catch((error) => {
          toast.error(cloudSyncErrorMessage(error, t));
        });
      }
      toast.success(t('memo.list.updated'));
      closeEdit();
    } catch (error) {
      toast.error(cloudSyncErrorMessage(error, t));
      setEditSaving(false);
    }
  }, [closeEdit, editCloudSync, editIcon, editName, editSaving, editingNotebook, originalEditCloudSync, setNotebooks, setSelectedNotebook, t]);

  return (
    <>
      {(blockingLoadingText || cloudImporting) && (
        <BlockingOperationStatus
          text={cloudImporting ? t('notebook.cloudImport.syncing') : blockingLoadingText!}
          stacked={cloudImporting}
        />
      )}

      {deleteMemo && <DeleteDialogShortcuts onCancel={() => setDeleteMemo(null)} onConfirm={handleDeleteConfirm} />}
      <Dialog open={!!deleteMemo} onOpenChange={(open) => !open && setDeleteMemo(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('memo.delete.title')}</DialogTitle>
            <DialogDescription>
              {t('memo.delete.description', { name: displayTitleFromFilename(deleteMemo?.filename) } satisfies I18nParams)}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setDeleteMemo(null)} className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)]">
              {t('memo.delete.cancel')}
            </button>
            <button type="button" onClick={handleDeleteConfirm} className="relative h-8 rounded-lg bg-[var(--destructive)] pl-3 pr-7 text-sm text-white hover:opacity-90">
              {t('memo.delete.confirm')}
              <Kbd className="!text-white border-0">↵</Kbd>
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {(createOpen || editOpen) && (
        <Suspense fallback={null}>
          <LazyNotebookDialogs
            createOpen={createOpen}
            onCreateOpenChange={(open) => open ? setCreateOpen(true) : resetCreateState()}
            newNotebookName={newName}
            onNewNotebookNameChange={setNewName}
            newNotebookPath={newPath}
            onNewNotebookPathChange={setNewPath}
            newNotebookIcon={newIcon}
            onNewNotebookIconChange={setNewIcon}
            cloudSyncAvailable={cloudSyncAvailable}
            createMode={createMode}
            remoteNotebooks={remoteNotebooks}
            remoteNotebooksLoading={remoteLoading}
            remoteNotebookSyncingId={syncingRemoteId}
            onOpenRemoteNotebooks={() => void openRemoteNotebooks()}
            onBackToCreate={() => { setCreateMode('create'); setRemoteNotebooks([]); }}
            onSelectRemoteNotebook={(item) => void selectRemoteNotebook(item)}
            onSelectDirectory={async () => {
              const path = await request<string | null>('select_directory');
              if (path) setNewPath(path);
            }}
            onConfirmCreate={confirmCreate}
            onCancelCreate={resetCreateState}
            editOpen={editOpen}
            onEditOpenChange={(open) => open ? setEditOpen(true) : closeEdit()}
            editingNotebook={editingNotebook}
            editNotebookName={editName}
            onEditNotebookNameChange={setEditName}
            editNotebookIcon={editIcon}
            onEditNotebookIconChange={setEditIcon}
            editNotebookCloudSync={editCloudSync}
            onEditNotebookCloudSyncChange={setEditCloudSync}
            onEditNotebookCloudSyncUnavailable={() => {
              void tauriWindows.openPreferences('cloudSync').catch((error) => {
                toast.error(`${t('notebook.cloudSync.failed')}: ${String(error)}`);
              });
            }}
            editSaving={editSaving}
            editNotebookCloudSyncChanged={editCloudSync !== originalEditCloudSync}
            onConfirmEdit={() => void confirmEdit()}
            onCancelEdit={closeEdit}
          />
        </Suspense>
      )}

      <LazyGlobalSearchCommand open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  );
}
