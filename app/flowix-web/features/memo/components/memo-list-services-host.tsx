'use client';

import { friendlyErrorMessage } from '@/lib/friendly-error-message';

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { useShortcutScope, pushHandler } from '@features/shortcuts';
import { useI18n, type I18nParams } from '@/lib/i18n';
import { getCloudSyncAccess } from '@/lib/cloud-account';
import { useShallow } from 'zustand/react/shallow';
import {
  cloud,
  listenToCloudStateChanges,
  mediaResources,
  notes,
  notebooks as notebookCommands,
  windows as tauriWindows,
  type CloudNotebook,
  type ObsidianVaultRecord,
} from '@platform/tauri/client';
import { useTauriRpc } from '@platform/tauri/use-tauri-rpc';
import {
  cloudSyncErrorMessage,
  isInvalidRefreshTokenError,
} from '@platform/tauri/errors';
import { useCreateNotebookFlow } from '@features/memo/hooks/use-create-notebook-flow';
import { useImportNotebookSelection } from '@features/memo/hooks/use-import-notebook-selection';
import { useEmptyNotebookPrompt } from '@features/memo/hooks/use-empty-notebook-prompt';
import {
  attachNotebookFolder,
  applyAgentWorkspaceSnapshot,
  loadAgentWorkspace,
  getWorkspaceAgentRepositories,
} from '@features/agent/public/workspace-api';
import { noteRepository } from '@features/memo/services/note-repository';
import { getVisibleCreateFilter, useNoteStore, useTagStore, type NoteListItem, type Notebook } from '@features/memo/store';
import { noteListItemRelativePath } from '@/types/note-item';
import {
  DEFAULT_NOTEBOOK_ICON_ID,
  NotebookIcon,
  resolveNotebookIconId,
} from '@features/memo/components/notebook-icon';
import { openNotebookNote } from '@features/memo/use-cases/open-notebook-note';
import { clearWorkspaceDocument } from '@features/workspace/public/note-navigation-api';
import { selectNotebook } from '@features/workspace/public/main-window-api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { canonicalDirectoryPath, joinNotebookMemoPath } from '@/lib/path';
import { Kbd } from '@shared/ui/kbd';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@shared/ui/select';
import { LazyGlobalSearchCommand } from '@features/memo/components/lazy-global-search-command';
import { subscribePendingOpenTargets } from '@platform/open-target/pending-requests';
import { createDocumentOpenBatch, executeDocumentOpenBatch, type DocumentOpenItem } from '@features/workspace/public/document-open-api';
import { documentIdentityFromFile, saveWorkspaceDocumentPath } from '@features/document/public/workspace-api';
import { ensureFileDisplayIdentity } from '@/lib/file-display-registry';
import {
  FLOWIX_EXTERNAL_DOCUMENT_OPEN_EVENT,
  type ExternalDocumentOpenRequest,
} from '@platform/open-target/types';

const LazyNotebookDialogs = lazy(() =>
  import('@features/memo/components/notebook-dialogs').then((module) => ({
    default: module.NotebookDialogs,
  })),
);

function normalizeNotebookIconId(icon: string | null | undefined): string {
  return resolveNotebookIconId(icon);
}

interface MediaDeleteRequest {
  filePath: string;
  notebookPath: string;
}

function filenameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function sameDirectorySet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightPaths = new Set(right.map(canonicalDirectoryPath));
  return left.every((path) => rightPaths.has(canonicalDirectoryPath(path)));
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
    <div className="pointer-events-auto fixed inset-0 z-[140] flex items-center justify-center bg-[color-mix(in_oklch,var(--card)_82%,transparent)] backdrop-blur-[1px]">
      <div className={cn('flex items-center gap-2 px-3 py-2 text-sm text-[var(--foreground)]', stacked && 'flex-col')} role="status" aria-live="polite">
        <Loader2 className="h-4 w-4 flowix-spin text-[var(--primary)]" />
        <span>{text}</span>
      </div>
    </div>
  );
}

function ExternalDocumentOpenDialog() {
  const { t } = useI18n();
  const selectedNotebook = useNoteStore((state) => state.selectedNotebook);
  const notebooks = useNoteStore((state) => state.notebooks);
  const [requests, setRequests] = useState<Array<{ id: number; items: DocumentOpenItem[] }>>([]);
  const requestSequence = useRef(0);
  const request = requests[0] ?? null;
  const dismissCurrentRequest = useCallback(() => setRequests((current) => current.slice(1)), []);
  const [notebookId, setNotebookId] = useImportNotebookSelection(request?.id, notebooks, selectedNotebook?.id);
  const targetNotebook = notebooks.find((notebook) => notebook.id === notebookId);
  const [operation, setOperation] = useState<'direct' | 'import' | null>(null);
  const opening = operation !== null;

  useEffect(() => {
    const onRequest = (next: ExternalDocumentOpenRequest) => {
      if (!next?.filePaths?.length) return;
      const items = createDocumentOpenBatch(next);
      if (items.length) {
        const id = ++requestSequence.current;
        setRequests((current) => [...current, { id, items }]);
      }
    };
    const unlisten = subscribePendingOpenTargets('external-documents', ({ target }) => {
      if (target.kind === 'external-documents') onRequest({ filePaths: target.filePaths, source: 'open' });
    });
    const onWindowRequest = (event: Event) => {
      onRequest((event as CustomEvent<ExternalDocumentOpenRequest>).detail);
    };
    window.addEventListener(FLOWIX_EXTERNAL_DOCUMENT_OPEN_EVENT, onWindowRequest);
    return () => {
      unlisten();
      window.removeEventListener(FLOWIX_EXTERNAL_DOCUMENT_OPEN_EVENT, onWindowRequest);
    };
  }, []);

  const close = useCallback(() => {
    if (!opening) dismissCurrentRequest();
  }, [opening, dismissCurrentRequest]);

  const execute = useCallback(async (importFiles: boolean) => {
    if (!request || opening || (importFiles && !targetNotebook)) return;
    setOperation(importFiles ? 'import' : 'direct');
    try {
      const result = await executeDocumentOpenBatch(request.items, importFiles ? targetNotebook : undefined);
      if (result.remaining.length) {
        setRequests((current) => current.map((item) => item.id === request.id
          ? { ...item, items: result.remaining } : item));
      } else {
        dismissCurrentRequest();
      }
      if (result.failures.length) {
        console.warn('Opening files failed', result.failures);
        toast.error(t(result.failures.length < request.items.length ? 'errors.friendly.fileOpenPartial' : 'errors.friendly.fileOpen'));
      }
    } catch (error) {
      toast.error(friendlyErrorMessage(error, t, 'errors.friendly.fileOpen'));
    } finally {
      setOperation(null);
    }
  }, [request, opening, targetNotebook, t, dismissCurrentRequest]);

  const fileCount = request?.items.length ?? 0;
  return (
    <Dialog open={!!request} onOpenChange={(openState) => !openState && close()}>
      <DialogContent showCloseButton={!opening} className="max-w-[285px]">
        <DialogHeader>
          <DialogTitle>{t('memo.externalOpen.importCountTitle', { count: fileCount })}</DialogTitle>
        </DialogHeader>
        <div className="mt-5 flex flex-col gap-2">
          <button type="button" onClick={() => void execute(false)} disabled={opening} className="h-8 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 text-sm hover:bg-[var(--muted)] disabled:opacity-50">
            {t(operation === 'direct' ? 'memo.externalOpen.opening' : 'memo.externalOpen.openDirectly')}
          </button>
          {request && (
            <Select value={notebookId} onValueChange={setNotebookId} disabled={opening}>
              <div className="grid w-full grid-cols-[32px_minmax(0,1fr)_32px] rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)]">
                <button type="button" onClick={() => void execute(true)} disabled={opening || !notebookId} className="col-span-2 grid h-8 min-w-0 grid-cols-[32px_minmax(0,1fr)] items-center rounded-l-lg text-sm disabled:opacity-50" title={targetNotebook?.name}>
                  <span className="col-start-2 truncate text-center">
                    {operation === 'import' ? t('memo.externalOpen.importing') : t('memo.externalOpen.importToNotebook', { name: targetNotebook?.name ?? '' })}
                  </span>
                </button>
                <SelectTrigger asChild aria-label={t('memo.externalOpen.importToRoot')}>
                  <button type="button" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-r-lg hover:bg-black/10 disabled:opacity-50">
                    <ChevronDown className="h-4 w-4" />
                  </button>
                </SelectTrigger>
              </div>
              {/* Popup height is capped here; keep it at half the previous 50vh so the
                  notebook list never covers the whole import dialog. */}
              <SelectContent align="end" fitViewport preferBelow maxHeight="25vh" className="flowix-preferences-select-content flowix-notebook-import-select-content w-[245px] max-w-[calc(100vw-2rem)]">
                {notebooks.map((notebook) => (
                  <SelectItem key={notebook.id} value={notebook.id}>
                    <span className="flex min-w-0 items-center gap-2">
                      <NotebookIcon icon={notebook.icon} className="h-6 w-6 rounded-md bg-[var(--muted)] text-xs font-semibold" disableTitle />
                      <span className="truncate">{notebook.name}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </DialogContent>
    </Dialog>
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
  suppressEmptyNotebookPrompt = false,
}: {
  notebookCreateRequest: number;
  onRefresh: () => void;
  suppressEmptyNotebookPrompt?: boolean;
}) {
  const { request } = useTauriRpc();
  const { t } = useI18n();
  const selectedNotebook = useNoteStore((state) => state.selectedNotebook);
  const notebooks = useNoteStore((state) => state.notebooks);
  const activeFilter = useNoteStore((state) => state.activeFilter);
  const startupPhase = useNoteStore((state) => state.startupPhase);
  const selectedTagId = useTagStore((state) => state.selectedTagId);
  const setSelectedTagId = useTagStore((state) => state.setSelectedTagId);
  const {
    setSelectedNotebook,
    setNotebooks,
    setActiveFilter,
    triggerRefresh,
    triggerMemoListRefresh,
  } = useNoteStore(
    useShallow((state) => ({
      setSelectedNotebook: state.setSelectedNotebook,
      setNotebooks: state.setNotebooks,
      setActiveFilter: state.setActiveFilter,
      triggerRefresh: state.triggerRefresh,
      triggerMemoListRefresh: state.triggerMemoListRefresh,
    })),
  );

  const [deleteMemo, setDeleteMemo] = useState<NoteListItem | null>(null);
  const [deleteMedia, setDeleteMedia] = useState<MediaDeleteRequest | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPaths, setNewPaths] = useState<string[]>([]);
  const [newIcon, setNewIcon] = useState<string | null>(DEFAULT_NOTEBOOK_ICON_ID);
  const [createMode, setCreateMode] = useState<'create' | 'cloud'>('create');
  const [remoteNotebooks, setRemoteNotebooks] = useState<CloudNotebook[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [syncingRemoteId, setSyncingRemoteId] = useState<string | null>(null);
  const [cloudImporting, setCloudImporting] = useState(false);
  const [obsidianVaults, setObsidianVaults] = useState<ObsidianVaultRecord[]>([]);
  const [obsidianVaultsLoading, setObsidianVaultsLoading] = useState(false);
  const [obsidianVaultsError, setObsidianVaultsError] = useState(false);
  const [editingNotebook, setEditingNotebook] = useState<Notebook | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editIcon, setEditIcon] = useState<string | null>(DEFAULT_NOTEBOOK_ICON_ID);
  const [editPaths, setEditPaths] = useState<string[]>([]);
  const [editStorageStatus, setEditStorageStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const editLoadGenerationRef = useRef(0);
  const [editOriginalPaths, setEditOriginalPaths] = useState<string[]>([]);
  const [editCloudSync, setEditCloudSync] = useState(false);
  const [originalEditCloudSync, setOriginalEditCloudSync] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const editingNotebookIdRef = useRef<string | null>(null);
  const [cloudSyncAvailable, setCloudSyncAvailable] = useState(false);
  const { creationState, createNotebook } = useCreateNotebookFlow({
    onMemoListReloadNeeded: onRefresh,
  });

  const resetCreateState = useCallback(() => {
    setCreateOpen(false);
    setCreateMode('create');
    setNewName('');
    setNewPaths([]);
    setNewIcon(DEFAULT_NOTEBOOK_ICON_ID);
    setRemoteNotebooks([]);
    setRemoteLoading(false);
    setSyncingRemoteId(null);
    setObsidianVaults([]);
    setObsidianVaultsLoading(false);
    setObsidianVaultsError(false);
  }, []);

  const openCreate = useCallback(() => {
    setNewName('');
    setNewPaths([]);
    setNewIcon(DEFAULT_NOTEBOOK_ICON_ID);
    setCreateMode('create');
    setRemoteNotebooks([]);
    setRemoteLoading(false);
    setSyncingRemoteId(null);
    setObsidianVaults([]);
    setObsidianVaultsLoading(false);
    setObsidianVaultsError(false);
    setCreateOpen(true);
  }, []);

  useEffect(() => {
    if (notebookCreateRequest > 0) openCreate();
  }, [notebookCreateRequest, openCreate]);

  useEmptyNotebookPrompt({
    startupReady: startupPhase === 'ready',
    hasSelectedNotebook: Boolean(selectedNotebook),
    suppressed: suppressEmptyNotebookPrompt,
    openCreate,
  });

  const editingNotebookId = editingNotebook?.id;
  useEffect(() => {
    if (!editOpen || !editingNotebookId) return;
    let cancelled = false;
    void Promise.all([cloud.getState(), cloud.getNotebookState(editingNotebookId)])
      .then(([cloudState, link]) => {
        if (cancelled) return;
        const enabled = Boolean(link?.enabled);
        setCloudSyncAvailable(getCloudSyncAccess(cloudState).canRead);
        setEditCloudSync(enabled);
        setOriginalEditCloudSync(enabled);
      })
      .catch(() => {
        if (!cancelled) setCloudSyncAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editOpen, editingNotebookId]);

  useEffect(() => listenToCloudStateChanges((state) => {
    setCloudSyncAvailable(getCloudSyncAccess(state).canRead);
  }), []);

  const loadEditStorage = useCallback(async (notebook: Notebook) => {
    const generation = ++editLoadGenerationRef.current;
    setEditStorageStatus('loading');
    try {
      let loaded = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (await loadAgentWorkspace()) { loaded = true; break; }
        if (editingNotebookIdRef.current !== notebook.id || generation !== editLoadGenerationRef.current) return;
      }
      if (!loaded) throw new Error('Workspace load superseded');
      if (editingNotebookIdRef.current !== notebook.id || generation !== editLoadGenerationRef.current) return;
      const repositories = getWorkspaceAgentRepositories(notebook.id);
      const paths = [notebook.path, ...repositories.map((repository) => repository.path)
        .filter((path) => canonicalDirectoryPath(path) !== canonicalDirectoryPath(notebook.path))];
      setEditOriginalPaths(paths);
      setEditPaths(paths);
      setEditStorageStatus('ready');
    } catch {
      if (editingNotebookIdRef.current === notebook.id && generation === editLoadGenerationRef.current) {
        setEditStorageStatus('error');
      }
    }
  }, []);

  useEffect(() => {
    const handleOpenCreate = () => openCreate();
    const handleOpenEdit = (event: Event) => {
      const notebook = (event as CustomEvent<Notebook>).detail;
      if (!notebook) return;
      setEditSaving(false);
      editingNotebookIdRef.current = notebook.id;
      setEditingNotebook(notebook);
      setEditName(notebook.name);
      setEditIcon(normalizeNotebookIconId(notebook.icon));
      setEditPaths([notebook.path]);
      setEditOriginalPaths([notebook.path]);
      setEditOpen(true);
      void loadEditStorage(notebook);
    };
    const handleDeleteMemo = (event: Event) => {
      const memo = (event as CustomEvent<NoteListItem>).detail;
      if (memo) setDeleteMemo(memo);
    };
    const handleDeleteMedia = (event: Event) => {
      const request = (event as CustomEvent<MediaDeleteRequest>).detail;
      if (request?.filePath && request?.notebookPath) setDeleteMedia(request);
    };
    const handleTogglePalette = () => setSearchOpen((open) => !open);
    const handleOpenPalette = () => setSearchOpen(true);
    window.addEventListener('flowix:open-create-notebook', handleOpenCreate);
    window.addEventListener('flowix:open-edit-notebook', handleOpenEdit as EventListener);
    window.addEventListener('flowix:request-delete-memo', handleDeleteMemo as EventListener);
    window.addEventListener('flowix:request-delete-media', handleDeleteMedia as EventListener);
    window.addEventListener('flowix:toggle-palette', handleTogglePalette);
    window.addEventListener('flowix:open-palette', handleOpenPalette);
    return () => {
      window.removeEventListener('flowix:open-create-notebook', handleOpenCreate);
      window.removeEventListener('flowix:open-edit-notebook', handleOpenEdit as EventListener);
      window.removeEventListener('flowix:request-delete-memo', handleDeleteMemo as EventListener);
      window.removeEventListener('flowix:request-delete-media', handleDeleteMedia as EventListener);
      window.removeEventListener('flowix:toggle-palette', handleTogglePalette);
      window.removeEventListener('flowix:open-palette', handleOpenPalette);
    };
  }, [openCreate, loadEditStorage]);

  const handleCreateMemo = useCallback(async () => {
    if (!selectedNotebook) return;
    const createFilter = getVisibleCreateFilter(activeFilter);
    if (createFilter !== activeFilter) {
      setSelectedTagId(null);
      setActiveFilter(createFilter);
    }
    const tagId = createFilter === 'tagged' ? selectedTagId : null;
    let created: Awaited<ReturnType<typeof noteRepository.create>>;
    try {
      created = await noteRepository.create(tagId ?? undefined, selectedNotebook.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return;
    }
    useNoteStore.getState().upsertCreatedNote(created);
    const shouldSelectNewMemo =
      createFilter === 'all' ||
      (createFilter === 'tagged' && Boolean(tagId)) ||
      createFilter === 'thisWeek' ||
      createFilter === 'thisMonth';
    if (shouldSelectNewMemo) {
      void openNotebookNote(created.path, selectedNotebook, { initialFocus: 'title' });
    }
    triggerMemoListRefresh();
  }, [activeFilter, selectedNotebook, selectedTagId, setActiveFilter, setSelectedTagId, triggerMemoListRefresh]);

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
      const targetNotebook = useNoteStore.getState().notebooks.find((notebook) => notebook.id === memo.notebookId)
        ?? (selectedNotebook?.id === memo.notebookId ? selectedNotebook : null);
      const path = targetNotebook
        ? joinNotebookMemoPath(targetNotebook.path, noteListItemRelativePath(memo))
        : null;
      if (!path) return;
      const saved = await saveWorkspaceDocumentPath(
        documentIdentityFromFile(ensureFileDisplayIdentity(path)),
        path,
        targetNotebook?.path ?? null,
      );
      if (!saved) {
        const status = await notes.pathStatus(path);
        if (status === 'present') {
          toast.error(t('document.save.failed', { message: '当前页签保存失败，未删除笔记' }));
          return;
        }
      }
      const outcome = await noteRepository.delete(path);
      // MemoEvent or the path-deleted fallback owns list and workspace cleanup.
      if (outcome === 'missingCleaned') toast.success(t('memo.delete.missingCleaned'));
      else toast.success(t('status.deleteCompleted'));
    })().catch((error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
  }, [deleteMemo, t, triggerRefresh]);

  const handleMediaDeleteConfirm = useCallback(() => {
    if (!deleteMedia) return;
    const request = deleteMedia;
    setDeleteMedia(null);
    void (async () => {
      const ok = await mediaResources.delete(request.filePath, request.notebookPath);
      if (!ok) {
        toast.error(t('media.fileTree.deleteFailed'));
        return;
      }
      await clearWorkspaceDocument();
      triggerRefresh();
      toast.success(t('status.deleteCompleted'));
    })().catch((error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
  }, [deleteMedia, t, triggerRefresh]);

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
      const syncAvailable = getCloudSyncAccess(state).canRead;
      setCloudSyncAvailable(syncAvailable);
      if (!state.authenticated) {
        resetCreateState();
        await tauriWindows.openPreferences('cloudSync');
        return;
      }
      if (!syncAvailable) {
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

  const openObsidianVaults = useCallback(async () => {
    setObsidianVaults([]);
    setObsidianVaultsError(false);
    setObsidianVaultsLoading(true);
    try {
      setObsidianVaults(await notebookCommands.listObsidianVaults());
    } catch {
      setObsidianVaultsError(true);
    } finally {
      setObsidianVaultsLoading(false);
    }
  }, []);

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
      if (useNoteStore.getState().selectedNotebook?.id !== local.id) {
        await selectNotebook(local);
        if (useNoteStore.getState().selectedNotebook?.id !== local.id) {
          throw new Error(t('memo.navigation.workspacePreparationFailed'));
        }
      }
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
    const additionalPaths = newPaths.slice(1);
    void createNotebook({ name: newName, path: newPaths[0] || undefined, icon: newIcon }).then(async (created) => {
      if (!created) return;
      resetCreateState();
      let mountFailed = false;
      for (const path of additionalPaths) {
        if (await attachNotebookFolder(created.id, path) === false) mountFailed = true;
      }
      if (mountFailed) toast.error(t('agent.access.saveFailed'));
    });
  }, [createNotebook, newIcon, newName, newPaths, resetCreateState, t]);

  const closeEdit = useCallback(() => {
    if (editSaving) return;
    setEditOpen(false);
    editingNotebookIdRef.current = null;
    ++editLoadGenerationRef.current;
    setEditingNotebook(null);
    setEditName('');
    setEditIcon(DEFAULT_NOTEBOOK_ICON_ID);
    setEditPaths([]);
    setEditOriginalPaths([]);
    setEditCloudSync(false);
    setOriginalEditCloudSync(false);
    setEditSaving(false);
  }, [editSaving]);

  const selectEditDirectory = useCallback(async () => {
    const generation = editLoadGenerationRef.current;
    try {
      const path = await request<string | null>('select_directory');
      if (path && editingNotebookIdRef.current && generation === editLoadGenerationRef.current) {
        setEditPaths((current) => current.some((item) => canonicalDirectoryPath(item) === canonicalDirectoryPath(path))
          ? current : [...current, path]);
      }
    } catch {
      toast.error(t('agent.access.saveFailed'));
    }
  }, [request, t]);

  const confirmEdit = useCallback(async () => {
    if (!editingNotebook || editSaving || editStorageStatus !== 'ready') return;
    const name = editName.trim();
    const icon = normalizeNotebookIconId(editIcon);
    const iconChanged = icon !== normalizeNotebookIconId(editingNotebook.icon);
    const metadataChanged = name !== editingNotebook.name || iconChanged;
    const cloudChanged = editCloudSync !== originalEditCloudSync;
    const primaryPath = editPaths[0];
    const primaryChanged = Boolean(primaryPath)
      && canonicalDirectoryPath(primaryPath) !== canonicalDirectoryPath(editingNotebook.path);
    const desiredRepositoryPaths = editPaths.slice(1);
    const originalRepositoryPaths = editOriginalPaths.filter(
      (path) => canonicalDirectoryPath(path) !== canonicalDirectoryPath(editingNotebook.path),
    );
    const repositoriesChanged = !sameDirectorySet(desiredRepositoryPaths, originalRepositoryPaths);
    if (!name || !primaryPath || (!metadataChanged && !cloudChanged && !primaryChanged && !repositoriesChanged)) {
      closeEdit();
      return;
    }
    try {
      setEditSaving(true);
      const result = await notebookCommands.saveSettings({
        id: editingNotebook.id, name, icon, primaryPath,
        repositoryPaths: desiredRepositoryPaths,
        expectedPrimaryPath: editingNotebook.path,
        expectedRepositoryPaths: originalRepositoryPaths,
      });
      const updated = result.notebook;
      applyAgentWorkspaceSnapshot(result.workspace);
      setNotebooks(useNoteStore.getState().notebooks.map((item) => item.id === updated.id ? updated : item));
      if (useNoteStore.getState().selectedNotebook?.id === updated.id) setSelectedNotebook(updated);
      setEditingNotebook(updated);
      const savedPaths = [updated.path, ...getWorkspaceAgentRepositories(updated.id).map((repository) => repository.path)];
      setEditPaths(savedPaths);
      setEditOriginalPaths(savedPaths);
      if (primaryChanged) onRefresh();
      if (cloudChanged) {
        try {
          await cloud.setNotebookEnabled(updated.id, editCloudSync);
          setOriginalEditCloudSync(editCloudSync);
        } catch {
          toast.error(t('notebook.edit.cloudPartialFailure'));
          setEditSaving(false);
          return;
        }
      }
      if (cloudChanged && editCloudSync) {
        void cloud.syncNow(editingNotebook.id).catch((error) => {
          toast.error(cloudSyncErrorMessage(error, t));
        });
      }
      toast.success(t('memo.list.updated'));
      closeEdit();
    } catch (error) {
      const message = String(error);
      toast.error(t(message.includes('NOTEBOOK_SETTINGS_CONFLICT')
        ? 'notebook.edit.storageConflict'
        : message.includes('PRIMARY_DIRECTORY_OVERLAP')
          ? 'notebook.edit.primaryOverlap'
          : 'agent.access.saveFailed'));
      setEditSaving(false);
    }
  }, [closeEdit, editCloudSync, editIcon, editName, editOriginalPaths, editPaths, editSaving, editStorageStatus, editingNotebook, onRefresh, originalEditCloudSync, setNotebooks, setSelectedNotebook, t]);

  const editNotebookStorageChanged = Boolean(editingNotebook) && (
    canonicalDirectoryPath(editPaths[0] ?? '') !== canonicalDirectoryPath(editingNotebook?.path ?? '')
    || !sameDirectorySet(
      editPaths.slice(1),
      editOriginalPaths.filter((path) => canonicalDirectoryPath(path) !== canonicalDirectoryPath(editingNotebook?.path ?? '')),
    )
  );

  return (
    <>
      <ExternalDocumentOpenDialog />

      {cloudImporting && (
        <BlockingOperationStatus
          text={t('notebook.cloudImport.syncing')}
          stacked
        />
      )}

      {deleteMemo && <DeleteDialogShortcuts onCancel={() => setDeleteMemo(null)} onConfirm={handleDeleteConfirm} />}
      {deleteMedia && <DeleteDialogShortcuts onCancel={() => setDeleteMedia(null)} onConfirm={handleMediaDeleteConfirm} />}
      <Dialog open={!!deleteMemo} onOpenChange={(open) => !open && setDeleteMemo(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('memo.delete.title')}</DialogTitle>
            <DialogDescription>
              {t('memo.delete.description', { name: deleteMemo?.title ?? '' } satisfies I18nParams)}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setDeleteMemo(null)} className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)]">
              {t('memo.delete.cancel')}
            </button>
            <button type="button" onClick={handleDeleteConfirm} className="relative h-8 rounded-lg border border-[var(--destructive)] bg-[var(--destructive)] pl-3 pr-7 text-sm text-white hover:opacity-90">
              {t('memo.delete.confirm')}
              <Kbd className="border-0 !text-white">↵</Kbd>
            </button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={!!deleteMedia} onOpenChange={(open) => !open && setDeleteMedia(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('media.fileTree.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('media.fileTree.deleteDescription', { name: deleteMedia ? filenameFromPath(deleteMedia.filePath) : '' })}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setDeleteMedia(null)} className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)]">
              {t('dialog.cancel')}
            </button>
            <button type="button" onClick={handleMediaDeleteConfirm} className="h-8 rounded-lg border border-[var(--destructive)] bg-[var(--destructive)] px-3 text-sm text-white hover:opacity-90">
              {t('dialog.delete')}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {(createOpen || editOpen) && (
        <Suspense fallback={null}>
          <LazyNotebookDialogs
            createOpen={createOpen}
            onCreateOpenChange={(open) => {
              if (open) setCreateOpen(true);
              else if (creationState.status !== 'creating') resetCreateState();
            }}
            newNotebookName={newName}
            onNewNotebookNameChange={setNewName}
            newNotebookPaths={newPaths}
            newNotebookIcon={newIcon}
            onNewNotebookIconChange={setNewIcon}
            isCreatingNotebook={creationState.status === 'creating'}
            cloudSyncAvailable={cloudSyncAvailable}
            createMode={createMode}
            remoteNotebooks={remoteNotebooks}
            remoteNotebooksLoading={remoteLoading}
            remoteNotebookSyncingId={syncingRemoteId}
            obsidianVaults={obsidianVaults}
            obsidianVaultsLoading={obsidianVaultsLoading}
            obsidianVaultsError={obsidianVaultsError}
            onOpenRemoteNotebooks={() => void openRemoteNotebooks()}
            onOpenObsidianVaults={() => void openObsidianVaults()}
            onBackToCreate={() => {
              setCreateMode('create');
              setRemoteNotebooks([]);
              setObsidianVaults([]);
              setObsidianVaultsError(false);
            }}
            onSelectRemoteNotebook={(item) => void selectRemoteNotebook(item)}
            onSelectObsidianVault={(vault) => {
              setNewPaths((current) => current.includes(vault.path) ? current : [...current, vault.path]);
            }}
            onSelectDirectory={async () => {
              const path = await request<string | null>('select_directory');
              if (path) setNewPaths((current) => current.includes(path) ? current : [...current, path]);
            }}
            onImportProjectDirectory={async (source) => {
              const path = await request<string | null>('select_project_directory', { projectSource: source });
              if (path) setNewPaths((current) => current.includes(path) ? current : [...current, path]);
            }}
            onRemoveDirectory={(path) => setNewPaths((current) => current.filter((item) => item !== path))}
            onSetPrimaryDirectory={(path) => {
              setNewPaths((current) => current.includes(path)
                ? [path, ...current.filter((item) => item !== path)]
                : current);
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
                toast.error(friendlyErrorMessage(error, t, 'errors.friendly.cloudSync'));
              });
            }}
            editSaving={editSaving}
            editNotebookCloudSyncChanged={editCloudSync !== originalEditCloudSync}
            onConfirmEdit={() => void confirmEdit()}
            onCancelEdit={closeEdit}
            editNotebookPaths={editPaths}
            editStorageStatus={editStorageStatus}
            onRetryEditStorage={() => { if (editingNotebook) void loadEditStorage(editingNotebook); }}
            onSelectEditDirectory={() => void selectEditDirectory()}
            onRemoveEditDirectory={(path) => {
              setEditPaths((current) => current.length > 1
                ? current.filter((item) => canonicalDirectoryPath(item) !== canonicalDirectoryPath(path))
                : current);
            }}
            onSetPrimaryEditDirectory={(path) => {
              setEditPaths((current) => current.some((item) => canonicalDirectoryPath(item) === canonicalDirectoryPath(path))
                ? [path, ...current.filter((item) => canonicalDirectoryPath(item) !== canonicalDirectoryPath(path))]
                : current);
            }}
            editNotebookStorageChanged={editNotebookStorageChanged}
          />
        </Suspense>
      )}

      <LazyGlobalSearchCommand open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  );
}
