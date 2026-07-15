'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useShallow } from 'zustand/react/shallow';
import { DocumentContainer } from '@features/document/components/document-container';
import { DocumentTitlebarMac } from '@features/document/components/document-titlebar-mac';
import { DocumentTitlebarWin } from '@features/document/components/document-titlebar-win';
import { useDocumentCommands } from '@features/document/components/use-document-commands';
import { useDocumentStore } from '@features/document/store';
import { useMemoStore, type MemoItem } from '@features/memo';
import { registerMemoEventHandler } from '@/lib/memo-dispatcher';
import { displayTitleFromFilename } from '@/lib/utils';
import { memos as memosClient, windows, type NoteWindowPayload } from '@platform/tauri/client';
import { WindowsTitlebarControls } from '@shared/window-titlebar-controls';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';
import { Kbd } from '@shared/ui/kbd';
import { useI18n, type I18nParams } from '@features/i18n';
import type { MemoEvent } from '@/types/memo';

const FIXED_NOTE_WINDOW_TITLE = 'Flowix';
const NOOP = () => {};

function isWindowsPlatform(): boolean {
  return /Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform);
}

function memoIdFromHash(hash: string): string | null {
  const prefix = '#note-window/';
  if (!hash.startsWith(prefix)) return null;
  const raw = hash.slice(prefix.length).split(/[?#]/)[0];
  return raw ? decodeURIComponent(raw) : null;
}

export function FixedNoteWindow() {
  const { t } = useI18n();
  const memoId = useMemo(() => memoIdFromHash(window.location.hash), []);
  const [payload, setPayload] = useState<NoteWindowPayload | null>(null);
  const [currentMemo, setCurrentMemo] = useState<MemoItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [isSearchPanelOpen, setIsSearchPanelOpen] = useState(false);
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);
  const currentDocumentContentRef = useRef('');

  const {
    currentDocumentPath,
    activeMemoSession,
    isDocumentTransitioning,
    openMemoDocument,
    clearDocument,
  } = useDocumentStore(
    useShallow((store) => ({
      currentDocumentPath: store.currentDocumentPath,
      activeMemoSession: store.activeMemoSession,
      isDocumentTransitioning: store.isDocumentTransitioning,
      openMemoDocument: store.openMemoDocument,
      clearDocument: store.clearDocument,
    })),
  );
  const updateMemoMeta = useMemoStore((store) => store.updateMemoMeta);
  const setMemoColors = useMemoStore((store) => store.setMemoColors);

  const getCurrentDocumentContent = useCallback(() => currentDocumentContentRef.current, []);
  const {
    handleCopyFullText,
    handleCopyLink,
    handleTogglePin,
    handleColorsChange,
    handleExportMarkdown,
    handleSaveAsTemplate,
    handleExportWord,
  } = useDocumentCommands({
    currentDocumentPath,
    getCurrentDocumentContent,
    currentMemo,
    isExternalDocument: false,
    updateMemoMeta,
    setMemoColors,
  });

  const handleOpenNoteProperties = useCallback(() => {
    if (!currentMemo) return;
    window.dispatchEvent(
      new CustomEvent('flowix:open-note-properties', { detail: { memoId: currentMemo.id } })
    );
  }, [currentMemo]);

  const handleRequestDeleteMemo = useCallback(() => {
    if (!currentMemo) return;
    setDeleteDialogOpen(true);
  }, [currentMemo]);

  const handleConfirmDeleteMemo = useCallback(() => {
    if (!currentMemo) return;
    void useMemoStore.getState().deleteMemo(currentMemo.id).then((ok) => {
      if (ok) {
        setDeleteDialogOpen(false);
        setDeleted(true);
        void clearDocument();
      }
    });
  }, [clearDocument, currentMemo]);

  useEffect(() => {
    let cancelled = false;
    if (!memoId) {
      setError('Missing note id');
      return;
    }
    windows.resolveNoteWindowPayload(memoId)
      .then(async (nextPayload) => {
        if (cancelled) return;
        const memo = await memosClient.readMemo(memoId);
        if (cancelled) return;
        if (memo) {
          useMemoStore.getState().handleMemoUpdated(memo as MemoItem);
          setCurrentMemo(memo as MemoItem);
        }
        await openMemoDocument({
          memoId: nextPayload.memoId,
          path: nextPayload.filePath,
          notebookId: nextPayload.notebookId,
          notebookPath: nextPayload.notebookPath,
          history: 'skip',
        });
        if (cancelled) return;
        setPayload(nextPayload);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [memoId]);

  useEffect(() => {
    if (!memoId) return;
    return registerMemoEventHandler((event: MemoEvent) => {
      if (event.kind === 'updated' && event.id === memoId) {
        setDeleted(false);
        useMemoStore.getState().handleMemoUpdated(event.memo);
        setCurrentMemo(event.memo);
        useDocumentStore.getState().replaceActiveMemoPath(event.id, event.path);
        setPayload((prev) => prev
          ? {
              ...prev,
              filePath: event.path,
              notebookId: event.notebookId,
            }
          : prev);
      }
      if (event.kind === 'deleted' && event.id === memoId) {
        setDeleted(true);
        setCurrentMemo(null);
        void useDocumentStore.getState().clearDocument();
      }
    }, (event) => {
      if (event.kind === 'updated') return event.id === memoId;
      if (event.kind === 'deleted') return event.id === memoId;
      return false;
    });
  }, [memoId]);

  useEffect(() => {
    void getCurrentWindow().setTitle(FIXED_NOTE_WINDOW_TITLE);
  }, []);

  if (error || !memoId) {
    return (
      <div className="flex h-screen w-screen flex-col overflow-hidden text-[var(--foreground)]" style={{ backgroundColor: 'var(--document-bg)' }}>
        <WindowsTitlebarControls />
        <div
          data-tauri-drag-region
          className={isWindowsPlatform() ? 'h-9 shrink-0 pr-[126px]' : 'h-12 shrink-0'}
          style={{ backgroundImage: 'linear-gradient(to bottom, var(--bg-titlebar), transparent)' }}
        />
        <div className="flex flex-1 items-center justify-center text-sm text-[var(--muted-foreground)]">
          {error ?? 'Missing note id'}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden text-[var(--foreground)]" style={{ backgroundColor: 'var(--document-bg)' }}>
      <WindowsTitlebarControls />
      {isWindowsPlatform() ? (
        <DocumentTitlebarWin
          currentMemo={currentMemo}
          isSidebarHidden={false}
          onToggleSidebar={NOOP}
          canNavigateBack={false}
          canNavigateForward={false}
          onNavigateBack={NOOP}
          onNavigateForward={NOOP}
          showNavigationButtons={false}
          onOpenSearch={() => setIsSearchPanelOpen(true)}
          onCopyLink={handleCopyLink}
          onCopyFullText={handleCopyFullText}
          onOpenProperties={handleOpenNoteProperties}
          onTogglePin={handleTogglePin}
          onExportMarkdown={handleExportMarkdown}
          onSaveAsTemplate={handleSaveAsTemplate}
          onExportWord={handleExportWord}
          onRequestDeleteMemo={handleRequestDeleteMemo}
          onColorsChange={handleColorsChange}
        />
      ) : (
        <DocumentTitlebarMac
          currentMemo={currentMemo}
          isSidebarHidden={false}
          onToggleSidebar={NOOP}
          canNavigateBack={false}
          canNavigateForward={false}
          onNavigateBack={NOOP}
          onNavigateForward={NOOP}
          showNavigationButtons={false}
          onOpenSearch={() => setIsSearchPanelOpen(true)}
          onCopyLink={handleCopyLink}
          onCopyFullText={handleCopyFullText}
          onOpenProperties={handleOpenNoteProperties}
          onTogglePin={handleTogglePin}
          onExportMarkdown={handleExportMarkdown}
          onSaveAsTemplate={handleSaveAsTemplate}
          onExportWord={handleExportWord}
          onRequestDeleteMemo={handleRequestDeleteMemo}
          onColorsChange={handleColorsChange}
        />
      )}
      {deleted ? (
        <div className="flex flex-1 items-center justify-center text-sm text-[var(--muted-foreground)]">
          Note deleted
        </div>
      ) : payload && currentDocumentPath ? (
        <div className="relative flex-1 min-h-0 min-w-0 overflow-hidden">
          <DocumentContainer
            key={activeMemoSession?.id ?? payload.memoId}
            filePath={currentDocumentPath}
            memoId={payload.memoId}
            notebookId={activeMemoSession?.notebookId ?? payload.notebookId}
            notebookPath={activeMemoSession?.notebookPath ?? payload.notebookPath}
            transitionId={activeMemoSession?.transitionId ?? null}
            isExternalDocument={false}
            searchPanelOpen={isSearchPanelOpen}
            onSearchPanelOpenChange={setIsSearchPanelOpen}
            toolbarCollapsed={toolbarCollapsed}
            onToolbarCollapsedChange={setToolbarCollapsed}
            onMetainfoData={(data) => {
              currentDocumentContentRef.current = data.memoContent;
            }}
          />
          {isDocumentTransitioning && (
            <div
              className="absolute inset-0 z-40 flex items-center justify-center bg-[color-mix(in_oklch,var(--card)_78%,transparent)] backdrop-blur-[1px]"
              role="status"
              aria-label="Loading"
            >
              <div
                className="h-5 w-5 rounded-full border-2 border-[color-mix(in_oklch,var(--muted-foreground)_26%,transparent)] border-t-[var(--brand)] animate-spin"
                aria-hidden="true"
              />
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-[var(--muted-foreground)]">
          Loading...
        </div>
      )}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('memo.delete.title')}</DialogTitle>
            <DialogDescription>
              {t('memo.delete.description', {
                name: displayTitleFromFilename(currentMemo?.filename),
              } satisfies I18nParams)}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={() => setDeleteDialogOpen(false)}
              className="h-8 px-3 text-sm rounded-lg hover:bg-[var(--muted)]"
            >
              {t('memo.delete.cancel')}
            </button>
            <button
              type="button"
              onClick={handleConfirmDeleteMemo}
              className="relative h-8 pl-3 pr-7 text-sm rounded-lg bg-[var(--destructive)] text-white hover:opacity-90"
            >
              {t('memo.delete.confirm')}
              <Kbd className="!text-white border-0">↵</Kbd>
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
