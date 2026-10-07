'use client';

import { getDocumentSession } from '../store/document-runtime-session';

import { useEffect, useCallback, useRef, useMemo } from 'react';
import { flushSync } from 'react-dom';
import {
  captureLatestDocumentContent,
  hasDocumentUnsavedChanges,
} from '@features/document/store/document-session-service';
import { useDocumentMetricsStore } from '@features/document/store/document-metrics-store';
import { useDocumentStore } from '@features/document/store/document-store';
import {
  setDocumentEditorMode,
  useDocumentEditorMode,
} from '@features/document/store/document-editor-view-store';
import {
  documentIdentityFromFile,
  documentPropertyTargetId,
} from '@features/document/store/document-identity';
import { fileNameFromPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { product } from '@platform/tauri/client/desktop';
import { externalDocuments } from '@platform/tauri/client/memos';
import { notes } from '@platform/tauri/client/notes';
import { markdownFilenameForTitle, renameMarkdownTitle } from '@features/document/use-cases/local-document-operations';
import {
  initialDocumentContainerState,
  type DocumentContainerProps,
} from '@features/document/components/session/types';
import {
  countTextUnits,
  extractBodyContent,
} from '@features/document/components/session/document-utils';
import { useDocumentContent } from '@features/document/components/session/use-document-content';
import { useDocumentAutosave } from '@features/document/components/session/use-document-autosave';
import { useExternalDocumentChangeWatch } from '@features/document/components/session/use-external-document-change-watch';
import { DocumentConflictPanel } from '@features/document/components/document-save-status';
import {
  LazyDocumentEditor,
  preloadDocumentEditor,
} from '@features/document/components/lazy-document-editor';
import { LazyCodeEditor } from '@features/document/components/lazy-code-editor';
import { MemoDocumentHeader } from '@features/document/components/memo-document-header';
import type {
  MemoTitleBodyNavigation,
  MemoTitleEditorHandle,
} from '@features/document/components/memo-title-editor';
import type { RenameDocumentTitle } from '@features/document/components/memo-title-session';
import type { MarkdownEditorHandle } from '@features/editor/markdown-editor';
import type { ClipboardSnapshot } from '@features/editor/extensions/paste-rules/clipboard';
import { useI18n } from '@/lib/i18n';
import { CenteredLoadingSpinner } from '@shared/ui/centered-loading-spinner';
import { WorkspaceEmptyState } from '@shared/ui/workspace-empty-state';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import { getBuffer, subscribeDocumentBufferChanges } from '@features/document/store/buffer-registry';
import { documentIdentityKey } from '@features/document/store/document-identity';
import {
  expectExternalDocumentWrite,
  isExternalDocumentRenameInProgress,
} from '@features/document/store/external-document-operation';
import { rebaseActiveDocumentPath } from '@features/document/store/document-session-service';
import type { Editor } from '@tiptap/core';
import { replaceExternalDocumentPath } from '@features/workspace/use-cases/workspace-navigation';

export function DocumentContainer({
  fileIdentity,
  transitionId = null,
  onMetainfoData,
  isExternalDocument = false,
  externalScopePath = null,
  externalEditorMode = 'code',
  searchPanelOpen = false,
  onSearchPanelOpenChange,
  toolbarCollapsed = false,
  onToolbarCollapsedChange,
  documentSessionMode = 'main',
  readOnly: forcedReadOnly = false,
  initialFocus,
  onEditorReady,
  onFlushReady,
}: DocumentContainerProps) {
  const filePath = fileIdentity.path;
  const displayId = fileIdentity.displayId;
  const { t } = useI18n();
  const hostId = documentSessionMode === 'isolated' ? 'browser-column' : 'main-third';
  const focusedHostId = useWorkspaceFocusStore((store) => store.focusedHostId);
  const readOnly = forcedReadOnly || focusedHostId !== hostId;
  const containerRef = useRef<HTMLDivElement>(null);
  const resolvedExternalDisplayId = isExternalDocument ? displayId : null;
  const documentInstanceKey = useMemo(
    () => `md:${displayId}`,
    [displayId]
  );
  const documentIdentity = getDocumentSession(
    documentIdentityFromFile({ path: filePath, displayId }),
  ).identity;
  const propertyTargetId = documentPropertyTargetId(displayId);
  const editorMode = useDocumentEditorMode(hostId, documentIdentity);
  // Rich/source mode belongs to the open Markdown file identity. Non-Markdown
  // external files retain their independent CodeMirror presentation setting.
  const usesCodeEditor = isExternalDocument
    ? externalEditorMode === 'code' || editorMode === 'source'
    : editorMode === 'source';
  const loadedDocumentInstanceKeyRef = useRef<string | null>(null);
  const editorHandleRef = useRef<MarkdownEditorHandle | null>(null);
  const titleEditorRef = useRef<MemoTitleEditorHandle | null>(null);
  const memoFilename = fileNameFromPath(filePath);
  const renameInProgressRef = useRef(false);
  const getCurrentFilePath = useCallback(() => documentIdentity.path, [documentIdentity]);
  const {
    state,
    setState,
    reloadDocument,
  } = useDocumentContent({
    identity: documentIdentity,
    externalScopePath,
    transitionId,
    isolatedSession: documentSessionMode === 'isolated',
  });

  useEffect(() => {
    if (!state.isLoaded || state.updatedAtDate || !filePath) return;
    let cancelled = false;
    void notes.modifiedAt(filePath).then((modifiedAt) => {
      if (cancelled || !modifiedAt) return;
      setState((previous) => previous.updatedAtDate ? previous : {
        ...previous,
        updatedAtDate: new Date(modifiedAt),
      });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [filePath, state.isLoaded, state.updatedAtDate, setState]);

  useEffect(() => {
    const key = documentIdentityKey(documentIdentity);
    let cancelled = false;
    const unsubscribe = subscribeDocumentBufferChanges((identity, reason) => {
      if (documentIdentityKey(identity) !== key) return;
      if (reason !== 'save_settled' && reason !== 'merged') return;
      void notes.modifiedAt(filePath).then((modifiedAt) => {
        if (!cancelled && modifiedAt) {
          setState((previous) => ({ ...previous, updatedAtDate: new Date(modifiedAt) }));
        }
      }).catch(() => undefined);
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [documentIdentity, filePath, setState]);

  useEffect(() => {
    if (usesCodeEditor) onEditorReady?.(null);
    return () => onEditorReady?.(null);
  }, [onEditorReady, usesCodeEditor]);

  useEffect(() => {
    if (
      transitionId === null
      || usesCodeEditor
    ) {
      return;
    }
    preloadDocumentEditor();
  }, [transitionId, usesCodeEditor]);
  const flushPendingEditorChanges = useCallback(() => {
    return editorHandleRef.current?.flushPendingChanges() ?? null;
  }, []);
  const handleEditorScroll = useCallback((scrollTop: number) => {
    const isScrolled = scrollTop > 90;
    setState((prev) => (
      prev.isScrolled === isScrolled
        ? prev
        : { ...prev, isScrolled }
    ));
  }, [setState]);

  const handleMoveTitleToBody = useCallback(({
    trailingContent,
    insertEmptyLine,
  }: MemoTitleBodyNavigation) => {
    if (!insertEmptyLine) {
      editorHandleRef.current?.focusStart?.();
      return;
    }
    const moveToBody = () => editorHandleRef.current?.moveTitleToBody?.(trailingContent ?? '');
    if (isExternalDocument) requestAnimationFrame(moveToBody);
    else moveToBody();
  }, [isExternalDocument]);

  const handlePasteTitleContentToBody = useCallback((snapshot: ClipboardSnapshot) => {
    editorHandleRef.current?.pasteToBody?.(snapshot);
  }, []);

  const handleToggleEditorMode = useCallback(() => {
    if (isExternalDocument && externalEditorMode !== 'markdown') return;
    captureLatestDocumentContent(documentIdentity, hostId);
    setDocumentEditorMode(
      hostId,
      documentIdentity,
      editorMode === 'source' ? 'rich' : 'source',
    );
  }, [documentIdentity, editorMode, externalEditorMode, hostId, isExternalDocument]);

  const {
    clearSaveTimer,
    flushDocument,
    discardDocument,
    handleChange,
    handleDirty,
  } = useDocumentAutosave({
    filePath,
    getCurrentFilePath,
    identity: documentIdentity,
    externalScopePath,
    setState,
    reloadDocument,
    flushPendingContent: flushPendingEditorChanges,
    hostId,
    isActive: () => !forcedReadOnly && useWorkspaceFocusStore.getState().focusedHostId === hostId,
    isolatedSession: documentSessionMode === 'isolated',
  });

  const commitExternalTitle = useCallback(async (
    requestedTitle: string,
    expectedFilename: string,
    options?: { expectBodyMutation?: boolean },
  ): Promise<string | null> => {
    if (
      renameInProgressRef.current
      || (resolvedExternalDisplayId && isExternalDocumentRenameInProgress(resolvedExternalDisplayId))
      || !isExternalDocument
      || externalEditorMode !== 'markdown'
      || !externalScopePath
      || !resolvedExternalDisplayId
    ) return null;

    const currentPath = getCurrentFilePath();
    const currentFilename = fileNameFromPath(currentPath);
    if (currentFilename !== expectedFilename) {
      throw new Error(t('document.save.externalChanged'));
    }

    const nextFilename = markdownFilenameForTitle(currentPath, requestedTitle);
    if (!nextFilename) return null;
    if (nextFilename === currentFilename) {
      if (options?.expectBodyMutation) expectExternalDocumentWrite(currentPath);
      return currentFilename;
    }

    renameInProgressRef.current = true;
    try {
      if (
        getCurrentFilePath() !== currentPath
        || isExternalDocumentRenameInProgress(resolvedExternalDisplayId)
      ) return null;

      // Keep editing live. The shared operation coordinates open buffers,
      // performs the scoped rename, and publishes the new path before unlock.
      const result = await renameMarkdownTitle({
        path: currentPath,
        title: requestedTitle,
        scopePath: externalScopePath,
        displayId: resolvedExternalDisplayId,
        expectFollowupWrite: options?.expectBodyMutation,
        onPathChanged: (oldPath, newPath) => replaceExternalDocumentPath(resolvedExternalDisplayId, oldPath, newPath),
      });
      return result?.filename ?? null;
    } finally {
      renameInProgressRef.current = false;
    }
  }, [
    externalEditorMode,
    externalScopePath,
    isExternalDocument,
    resolvedExternalDisplayId,
    t,
  ]);

  useEffect(() => {
    const key = documentIdentityKey(documentIdentity);
    const sync = () => {
      const buffer = getBuffer(documentIdentity);
      if (!buffer) return;
      const content = buffer.content;
      const textUnits = countTextUnits(extractBodyContent(content));
      const tokenCount = Math.ceil(textUnits / 4);
      setState((prev) => (
        prev.fullContent === content
        && prev.charCount === textUnits
        && prev.tokenCount === tokenCount
          ? prev
          : {
              ...prev,
              fullContent: content,
              charCount: textUnits,
              tokenCount,
            }
      ));
    };
    const unsubscribeBuffer = subscribeDocumentBufferChanges((identity, reason) => {
      if (documentIdentityKey(identity) !== key) return;
      if (reason === 'merged') flushSync(sync);
      else sync();
    });
    const unsubscribeFocus = useWorkspaceFocusStore.subscribe((next, previous) => {
      if (previous.focusedHostId === hostId && next.focusedHostId !== hostId) {
        // Finish composition and publish the outgoing editor before React
        // enables the incoming surface. Disk persistence remains debounced.
        const active = document.activeElement;
        if (active instanceof HTMLElement && containerRef.current?.contains(active)) active.blur();
        captureLatestDocumentContent(documentIdentity, hostId);
      }
    });
    return () => {
      unsubscribeBuffer();
      unsubscribeFocus();
    };
  }, [documentIdentity, flushPendingEditorChanges, hostId, setState]);

  useEffect(() => {
    onFlushReady?.(flushDocument, discardDocument);
    return () => onFlushReady?.(null, null);
  }, [discardDocument, flushDocument, onFlushReady]);
  useEffect(() => {
    if (!filePath) {
      useDocumentMetricsStore.getState().clear(documentInstanceKey);
      return;
    }
    useDocumentMetricsStore.getState().setCharCount(documentInstanceKey, state.charCount);
  }, [documentInstanceKey, filePath, state.charCount]);

  useEffect(() => () => {
    useDocumentMetricsStore.getState().clear(documentInstanceKey);
  }, [documentInstanceKey]);

  useEffect(() => {
    if (!filePath) {
      setState(initialDocumentContainerState);
      return;
    }

    const loadedDocumentInstanceKey = loadedDocumentInstanceKeyRef.current;
    const instanceKeyChanged = loadedDocumentInstanceKey !== documentInstanceKey;
    loadedDocumentInstanceKeyRef.current = documentInstanceKey;

    // A path is an attribute of this session, never an editor lifecycle key.
    // Actual external content changes arrive through the content watchers.
    if (!instanceKeyChanged) {
      rebaseActiveDocumentPath(documentIdentity, filePath);
      if (documentSessionMode !== 'isolated' && transitionId !== null) {
        useDocumentStore.getState().finishDocumentTransition(transitionId);
      }
      return;
    }

    reloadDocument(filePath, {
      // A second surface for the same identity shares this buffer. Preserve
      // its live draft instead of replacing it with the disk snapshot.
      preservePending: hasDocumentUnsavedChanges(documentIdentity),
      showLoading: true,
    });
  }, [filePath, documentIdentity, documentInstanceKey, documentSessionMode, isExternalDocument, reloadDocument, clearSaveTimer]);

  useExternalDocumentChangeWatch({
    filePath,
    identity: documentIdentity,
    scopePath: externalScopePath,
    clearSaveTimer,
    reloadDocument,
  });

  const metaInfo = useMemo(() => {
    return {
      charCount: state.charCount,
      tokenCount: state.tokenCount,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      memoPath: null,
      memoContent: state.fullContent,
      isFavorited: state.isFavorited,
      frontmatterMeta: state.frontmatterMeta,
    };
  }, [state.charCount, state.tokenCount, state.createdAt, state.updatedAt, state.fullContent, state.isFavorited, state.frontmatterMeta]);

  useEffect(() => {
    if (filePath) {
      onMetainfoData?.(metaInfo);
    }
  }, [filePath, metaInfo, onMetainfoData]);

  if (!filePath) {
    return <WorkspaceEmptyState tone="document" message={t('shell.emptyDocument')} />;
  }

  if (state.error) {
    return <WorkspaceEmptyState tone="document" message={state.error} />;
  }

  const hasMarkdownTitle = isExternalDocument && externalEditorMode === 'markdown';
  const renameTitle: RenameDocumentTitle = commitExternalTitle;
  const documentHeader = hasMarkdownTitle ? (
    <MemoDocumentHeader
      titleRef={titleEditorRef}
      displayId={displayId}
      filename={memoFilename}
      renameTitle={renameTitle}
      updatedAt={state.updatedAtDate}
      editable={
        !readOnly
        && (!isExternalDocument || Boolean(externalScopePath))
      }
      autoFocus={initialFocus === 'title'}
      sourceMode={usesCodeEditor}
      showPropertiesToggle
      allowReadOnlyBoundaryNavigation
      onMoveToBody={handleMoveTitleToBody}
      onPasteToBody={handlePasteTitleContentToBody}
      editorMode={editorMode}
      onToggleEditorMode={handleToggleEditorMode}
    />
  ) : null;

  return (
    <div
      ref={containerRef}
      data-document-session-mode={documentSessionMode}
      onFocusCapture={() => useWorkspaceFocusStore.getState().focusHost(hostId)}
      onPointerDownCapture={() => useWorkspaceFocusStore.getState().focusHost(hostId)}
      className="document-container h-full w-full min-w-0 flex flex-col bg-transparent relative overflow-hidden"
    >
      {focusedHostId === hostId &&
        <DocumentConflictPanel identity={documentIdentity} scopePath={externalScopePath} />}
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        {state.isLoading && (
          <CenteredLoadingSpinner className="h-full w-full" />
        )}
        {!state.isLoading && usesCodeEditor && (
          <LazyCodeEditor
            ref={editorHandleRef}
            key={documentInstanceKey}
            filePath={filePath}
            content={state.fullContent}
            editable={!readOnly}
            onChange={handleChange}
            autoFocus={initialFocus === 'body'}
            onEditorScroll={handleEditorScroll}
            onEditingFinished={flushPendingEditorChanges}
            scrollHeader={documentHeader ?? undefined}
            searchPanelOpen={searchPanelOpen}
            onSearchPanelOpenChange={onSearchPanelOpenChange}
          />
        )}
        {!state.isLoading && state.isLoaded && !usesCodeEditor && (
          <LazyDocumentEditor
            propertyTargetId={propertyTargetId}
            onViewSourceMode={handleToggleEditorMode}
            transitionId={transitionId}
            ref={editorHandleRef}
            key={documentInstanceKey}
            content={state.fullContent}
            header={documentHeader}
            editable={!readOnly}
            onDirty={handleDirty}
            onChange={(content) => {
              handleChange(content);
            }}
            className=""
            onEditorScroll={handleEditorScroll}
            onEditingFinished={() => {
              flushPendingEditorChanges();
            }}
            onFocusTitle={() => {
              titleEditorRef.current?.focusEnd();
            }}
            onAppendToTitle={(title) => {
              return titleEditorRef.current?.appendBodyLine(title) ?? false;
            }}
            autoFocus={initialFocus === 'body'}
            searchPanelOpen={searchPanelOpen}
            onSearchPanelOpenChange={onSearchPanelOpenChange}
            onBeforeCreate={(editor: Editor) => onEditorReady?.(editor)}
            toolbarCollapsed={toolbarCollapsed}
            onToolbarCollapsedChange={onToolbarCollapsedChange}
          />
        )}
      </div>
    </div>
  );
}

export function UnavailableFileView({
  filePath,
  openContainingFolder = false,
  scopePath,
}: {
  filePath: string;
  openContainingFolder?: boolean;
  scopePath?: string | null;
}) {
  const { t } = useI18n();
  const filename = filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-sm text-[var(--muted-foreground)]">
      <span className="max-w-full truncate text-[var(--foreground)]" title={filename}>{filename}</span>
      <span>{t('document.file.unavailable')}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            const action = product.revealInFileManager(filePath);
            void action.catch(() => {
              toast.error(t('memo.fileTree.openFailed'));
            });
          }}
          className="inline-flex h-8 items-center rounded-lg border border-[var(--border)] px-3 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]"
        >
          {t(openContainingFolder ? 'document.file.openContainingFolder' : 'document.file.reveal')}
        </button>
        {openContainingFolder && (
          <button
            type="button"
            onClick={() => {
              void externalDocuments.openWithDefaultApp(filePath, scopePath).catch(() => {
                toast.error(t('memo.fileTree.openFailed'));
              });
            }}
            className="inline-flex h-8 items-center rounded-lg border border-[var(--border)] px-3 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]"
          >
            {t('document.file.openWithDefaultApp')}
          </button>
        )}
      </div>
    </div>
  );
}
