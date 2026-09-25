'use client';

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { displayTitleFromFilename } from '@/lib/utils';
import { useShortcutScope, pushHandler } from '@features/shortcuts';
import { useI18n, type I18nParams } from '@/lib/i18n';
import { useShallow } from 'zustand/react/shallow';
import {
  cloud,
  files,
  listenToCloudStateChanges,
  mediaResources,
  memos,
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
import { joinNotebookMemoPath } from '@/lib/path';
import { Kbd } from '@shared/ui/kbd';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@shared/ui/select';
import { LazyGlobalSearchCommand } from '@features/memo/components/lazy-global-search-command';
import { subscribe } from '@platform/tauri/event-bus';
import { externalDocuments } from '@platform/tauri/client';
import { openNoteByTarget, resolveMemoById } from '@features/memo/use-cases/open-by-target';
import {
  openBrowserColumnMarkdown,
  openBrowserColumnMemoById,
} from '@features/workspace/use-cases/browser-column-navigation';
import { openExternalTarget } from '@features/workspace/use-cases/workspace-navigation';
import { setCurrentWorkspaceNotebook } from '@features/memo/public/workspace-api';
import {
  FLOWIX_EXTERNAL_MARKDOWN_OPEN_EVENT,
  type ExternalMarkdownOpenRequest,
} from '@platform/open-target/types';

const LazyNotebookDialogs = lazy(() =>
  import('@features/memo/components/notebook-dialogs').then((module) => ({
    default: module.NotebookDialogs,
  })),
);

function normalizeNotebookIconId(icon: string | null | undefined): string | null {
  return getNotebookIconOption(icon) ? icon! : null;
}

const NOTEBOOK_DESCRIPTION_START = '<notebook-description>';
const NOTEBOOK_DESCRIPTION_END = '</notebook-description>';
const NOTEBOOK_DESCRIPTION_BLOCK = /<notebook-description>[\s\S]*?<\/notebook-description>/;
const FLOWIX_MANAGED_BLOCK = /<!-- flowix:instructions:start -->[\s\S]*?<!-- flowix:instructions:end -->/;

interface MediaDeleteRequest {
  filePath: string;
  notebookPath: string;
}

function filenameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function extractNotebookDescription(content: string): string {
  const tagged = content.match(/<notebook-description>([\s\S]*?)<\/notebook-description>/);
  if (tagged) return tagged[1].trim();

  // Backward compatibility for descriptions written before the tagged block
  // was introduced. Keep Flowix's generated instructions out of the editor.
  return content.replace(FLOWIX_MANAGED_BLOCK, '').trim();
}

function notebookDescriptionBlock(description: string): string {
  const normalized = description.trim();
  return normalized
    ? `${NOTEBOOK_DESCRIPTION_START}\n${normalized}\n${NOTEBOOK_DESCRIPTION_END}`
    : `${NOTEBOOK_DESCRIPTION_START}\n${NOTEBOOK_DESCRIPTION_END}`;
}

function replaceNotebookDescription(existing: string, description: string): string {
  const block = notebookDescriptionBlock(description);
  if (NOTEBOOK_DESCRIPTION_BLOCK.test(existing)) {
    return existing.replace(NOTEBOOK_DESCRIPTION_BLOCK, block);
  }

  // Migrate legacy untagged content into the new block. The managed Flowix
  // section is retained outside it; all other old content was the former
  // notebook-description field.
  const managed = existing.match(FLOWIX_MANAGED_BLOCK)?.[0].trim() ?? '';
  return managed ? `${managed}\n\n${block}\n` : `${block}\n`;
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
        <Loader2 className="h-4 w-4 animate-spin text-[var(--primary)]" />
        <span>{text}</span>
      </div>
    </div>
  );
}

function ExternalMarkdownOpenDialog() {
  const { t } = useI18n();
  const selectedNotebook = useMemoStore((state) => state.selectedNotebook);
  const notebooks = useMemoStore((state) => state.notebooks);
  const [request, setRequest] = useState<ExternalMarkdownOpenRequest | null>(null);
  const [notebookId, setNotebookId] = useState('');
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    const onRequest = (next: ExternalMarkdownOpenRequest) => {
      if (!next?.filePaths?.length) return;
      setRequest(next);
      setNotebookId((current) => current || selectedNotebook?.id || notebooks[0]?.id || '');
    };
    const unlisten = subscribe<ExternalMarkdownOpenRequest>(FLOWIX_EXTERNAL_MARKDOWN_OPEN_EVENT, onRequest);
    const onWindowRequest = (event: Event) => {
      onRequest((event as CustomEvent<ExternalMarkdownOpenRequest>).detail);
    };
    window.addEventListener(FLOWIX_EXTERNAL_MARKDOWN_OPEN_EVENT, onWindowRequest);
    return () => {
      unlisten();
      window.removeEventListener(FLOWIX_EXTERNAL_MARKDOWN_OPEN_EVENT, onWindowRequest);
    };
  }, [notebooks, selectedNotebook?.id]);

  useEffect(() => {
    if (!request) return;
    setNotebookId((current) => (
      notebooks.some((notebook) => notebook.id === current)
        ? current
        : selectedNotebook?.id || notebooks[0]?.id || ''
    ));
  }, [notebooks, request, selectedNotebook?.id]);

  const close = useCallback(() => {
    if (!opening) setRequest(null);
  }, [opening]);

  const open = useCallback(async () => {
    if (!request || !notebookId) return;
    setOpening(true);
    try {
      const imported: Array<{ id: string; resolved: NonNullable<Awaited<ReturnType<typeof resolveMemoById>>> }> = [];
      for (const filePath of request.filePaths) {
        const content = await externalDocuments.read(filePath, null);
        const memo = await memos.importExternalDocumentToMemo(filePath, content, notebookId);
        if (!memo) throw new Error('Import returned no note');
        const resolved = await resolveMemoById(memo.id);
        if (!resolved) throw new Error('Imported note could not be opened');
        imported.push({ id: memo.id, resolved });
      }
      setRequest(null);
      if (request.destination === 'browser-column') {
        await setCurrentWorkspaceNotebook(notebookId);
        for (const memo of imported) await openBrowserColumnMemoById(memo.id);
      } else {
        await openNoteByTarget(imported[imported.length - 1].resolved);
      }
    } catch (error) {
      toast.error(`${t('memo.externalOpen.failed')}: ${String(error)}`);
    } finally {
      setOpening(false);
    }
  }, [notebookId, request, t]);

  const openDirectly = useCallback(async () => {
    if (!request) return;
    setOpening(true);
    try {
      if (request.destination === 'browser-column') {
        for (const filePath of request.filePaths) {
          await openBrowserColumnMarkdown(filePath);
        }
      } else {
        for (const filePath of request.filePaths) {
          await openExternalTarget(filePath, {
            destination: 'main-third',
            scopePath: selectedNotebook?.path ?? null,
          });
        }
      }
      setRequest(null);
    } catch (error) {
      toast.error(`${t('memo.externalOpen.failed')}: ${String(error)}`);
    } finally {
      setOpening(false);
    }
  }, [request, selectedNotebook?.path, t]);

  const filenames = request?.filePaths.map((path) => path.split(/[\\/]/).pop() || path) ?? [];
  return (
    <Dialog open={!!request} onOpenChange={(openState) => !openState && close()}>
      <DialogContent showCloseButton={!opening}>
        <DialogHeader>
          <DialogTitle>{t('memo.externalOpen.title')}</DialogTitle>
        </DialogHeader>
        <div className="mt-3 max-h-24 overflow-auto rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--muted-foreground)]">
          {filenames.map((filename) => <div key={filename} className="truncate">{filename}</div>)}
        </div>
        <label className="mt-4 block text-sm text-[var(--foreground)]">
          {t('memo.externalOpen.saveTo')}
          <Select
            value={notebookId}
            onValueChange={setNotebookId}
            disabled={opening}
          >
            <SelectTrigger className="mt-2 w-full">
              <span className="min-w-0 flex-1 truncate text-left">
                {notebooks.find((notebook) => notebook.id === notebookId)?.name ?? ''}
              </span>
            </SelectTrigger>
            <SelectContent align="start" className="flowix-preferences-select-content w-72 max-w-[calc(100vw-2rem)]">
              {notebooks.map((notebook) => (
                <SelectItem key={notebook.id} value={notebook.id}>{notebook.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={close} disabled={opening} className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)]">
            {t('dialog.cancel')}
          </button>
          <button type="button" onClick={() => void openDirectly()} disabled={opening} className="h-8 rounded-lg border border-[var(--border)] px-3 text-sm hover:bg-[var(--muted)] disabled:opacity-50">
            {t('memo.externalOpen.openDirectly')}
          </button>
          <button type="button" onClick={() => void open()} disabled={opening || !notebookId} className="h-8 rounded-lg bg-[var(--primary)] px-4 text-sm text-[var(--primary-foreground)] disabled:opacity-50">
            {opening ? t('memo.externalOpen.opening') : t('memo.externalOpen.save')}
          </button>
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
  const [deleteMedia, setDeleteMedia] = useState<MediaDeleteRequest | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [newDefaultPath, setNewDefaultPath] = useState('');
  const [newIcon, setNewIcon] = useState<string | null>(null);
  const [newTemplateId, setNewTemplateId] = useState<string | null>(null);
  const [createMode, setCreateMode] = useState<'create' | 'cloud'>('create');
  const [remoteNotebooks, setRemoteNotebooks] = useState<CloudNotebook[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [syncingRemoteId, setSyncingRemoteId] = useState<string | null>(null);
  const [cloudImporting, setCloudImporting] = useState(false);
  const [editingNotebook, setEditingNotebook] = useState<Notebook | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editIcon, setEditIcon] = useState<string | null>(null);
  const [editNotebookDescription, setEditNotebookDescription] = useState('');
  const [editNotebookDescriptionDirty, setEditNotebookDescriptionDirty] = useState(false);
  const [editNotebookDescriptionLoading, setEditNotebookDescriptionLoading] = useState(false);
  const [editCloudSync, setEditCloudSync] = useState(false);
  const [originalEditCloudSync, setOriginalEditCloudSync] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [cloudSyncAvailable, setCloudSyncAvailable] = useState(false);
  const emptyNotebookPromptedRef = useRef(false);

  const { creationState, createNotebook } = useCreateNotebookFlow({
    onMemoListReloadNeeded: onRefresh,
    onMemoListQueryReset: () => undefined,
    onMemoListLoadingChange: () => undefined,
  });

  const resetCreateState = useCallback(() => {
    setCreateOpen(false);
    setCreateMode('create');
    setNewName('');
    setNewPath('');
    setNewDefaultPath('');
    setNewIcon(null);
    setNewTemplateId(null);
    setRemoteNotebooks([]);
    setRemoteLoading(false);
    setSyncingRemoteId(null);
  }, []);

  const openCreate = useCallback(() => {
    setNewName('');
    setNewPath('');
    setNewDefaultPath('');
    setNewIcon(null);
    setNewTemplateId(null);
    setCreateMode('create');
    setRemoteNotebooks([]);
    setRemoteLoading(false);
    setSyncingRemoteId(null);
    setCreateOpen(true);
  }, []);

  useEffect(() => {
    const name = newName.trim();
    if (!createOpen || createMode !== 'create' || newPath.trim() || !name) {
      setNewDefaultPath('');
      return;
    }

    let cancelled = false;
    void notebookRepository.getDefaultPath(name)
      .then((path) => {
        if (!cancelled) setNewDefaultPath(path);
      })
      .catch(() => {
        if (!cancelled) setNewDefaultPath('');
      });

    return () => {
      cancelled = true;
    };
  }, [createMode, createOpen, newName, newPath]);

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

  useEffect(() => {
    if (!editOpen || !editingNotebook) {
      setEditNotebookDescription('');
      setEditNotebookDescriptionDirty(false);
      setEditNotebookDescriptionLoading(false);
      return;
    }

    const agentsPath = joinNotebookMemoPath(editingNotebook.path, 'AGENTS.md');
    if (!agentsPath) {
      setEditNotebookDescription('');
      setEditNotebookDescriptionDirty(false);
      setEditNotebookDescriptionLoading(false);
      return;
    }

    let cancelled = false;
    setEditNotebookDescriptionLoading(true);
    void files.read(agentsPath, editingNotebook.path)
      .then((content) => {
        if (cancelled) return;
        setEditNotebookDescription(extractNotebookDescription(content ?? ''));
        setEditNotebookDescriptionDirty(false);
      })
      .catch(() => {
        if (cancelled) return;
        setEditNotebookDescription('');
        setEditNotebookDescriptionDirty(false);
      })
      .finally(() => {
        if (!cancelled) setEditNotebookDescriptionLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [editOpen, editingNotebook?.id, editingNotebook?.path]);

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
      setEditNotebookDescription('');
      setEditNotebookDescriptionDirty(false);
      setEditNotebookDescriptionLoading(true);
      setEditOpen(true);
    };
    const handleDeleteMemo = (event: Event) => {
      const memo = (event as CustomEvent<MemoItem>).detail;
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
      toast.success(t('media.fileTree.deleted', { name: filenameFromPath(request.filePath) }));
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
    void createNotebook({ name: newName, path: newPath || undefined, icon: newIcon, templateId: newTemplateId }).then((created) => {
      if (created) resetCreateState();
    });
  }, [createNotebook, newIcon, newName, newPath, newTemplateId, resetCreateState]);

  const closeEdit = useCallback(() => {
    if (editSaving) return;
    setEditOpen(false);
    setEditingNotebook(null);
    setEditName('');
    setEditIcon(null);
    setEditNotebookDescription('');
    setEditNotebookDescriptionDirty(false);
    setEditNotebookDescriptionLoading(false);
    setEditCloudSync(false);
    setOriginalEditCloudSync(false);
    setEditSaving(false);
  }, [editSaving]);

  const confirmEdit = useCallback(async () => {
    if (!editingNotebook || editSaving || editNotebookDescriptionLoading) return;
    const name = editName.trim();
    const icon = editIcon || null;
    const iconChanged = (icon ?? '') !== (normalizeNotebookIconId(editingNotebook.icon) ?? '');
    const metadataChanged = name !== editingNotebook.name || iconChanged;
    const cloudChanged = editCloudSync !== originalEditCloudSync;
    const descriptionChanged = editNotebookDescriptionDirty;
    if (!name || (!metadataChanged && !cloudChanged && !descriptionChanged)) {
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
      if (descriptionChanged) {
        const agentsPath = joinNotebookMemoPath(editingNotebook.path, 'AGENTS.md');
        if (!agentsPath) throw new Error(t('notebook.edit.agents.saveFailed'));
        const existing = (await files.read(agentsPath, editingNotebook.path)) ?? '';
        const next = replaceNotebookDescription(existing, editNotebookDescription);
        if (!await files.write(agentsPath, next, false, editingNotebook.path)) {
          throw new Error(t('notebook.edit.agents.saveFailed'));
        }
      }
      setNotebooks(useMemoStore.getState().notebooks.map((item) => item.id === updated.id ? updated : item));
      if (useMemoStore.getState().selectedNotebook?.id === updated.id) setSelectedNotebook(updated);
      if (cloudChanged && editCloudSync) {
        void cloud.syncNow(editingNotebook.id).catch((error) => {
          toast.error(cloudSyncErrorMessage(error, t));
        });
      }
      toast.success(t(descriptionChanged ? 'notebook.edit.agents.saved' : 'memo.list.updated'));
      closeEdit();
    } catch (error) {
      toast.error(cloudSyncErrorMessage(error, t));
      setEditSaving(false);
    }
  }, [closeEdit, editCloudSync, editIcon, editName, editNotebookDescription, editNotebookDescriptionDirty, editNotebookDescriptionLoading, editSaving, editingNotebook, originalEditCloudSync, setNotebooks, setSelectedNotebook, t]);

  return (
    <>
      <ExternalMarkdownOpenDialog />

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
              {t('memo.delete.description', { name: displayTitleFromFilename(deleteMemo?.filename) } satisfies I18nParams)}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setDeleteMemo(null)} className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)]">
              {t('memo.delete.cancel')}
            </button>
            <button type="button" onClick={handleDeleteConfirm} className="relative h-8 rounded-lg border border-[var(--border)] bg-[var(--card)] pl-3 pr-7 text-sm text-[var(--foreground)] hover:border-[var(--destructive)] hover:bg-transparent hover:text-[var(--destructive)]">
              {t('memo.delete.confirm')}
              <Kbd className="border-0 !text-[var(--foreground)]">↵</Kbd>
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
            <button type="button" onClick={handleMediaDeleteConfirm} className="h-8 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 text-sm text-[var(--foreground)] hover:border-[var(--destructive)] hover:bg-transparent hover:text-[var(--destructive)]">
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
            newNotebookPath={newPath}
            newNotebookDefaultPath={newDefaultPath}
            newNotebookIcon={newIcon}
            onNewNotebookIconChange={setNewIcon}
            newNotebookTemplateId={newTemplateId}
            onNewNotebookTemplateIdChange={setNewTemplateId}
            isCreatingNotebook={creationState.status === 'creating'}
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
            editNotebookDescription={editNotebookDescription}
            onEditNotebookDescriptionChange={(description) => {
              setEditNotebookDescription(description);
              setEditNotebookDescriptionDirty(true);
            }}
            editNotebookDescriptionLoading={editNotebookDescriptionLoading}
            editNotebookDescriptionChanged={editNotebookDescriptionDirty}
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
