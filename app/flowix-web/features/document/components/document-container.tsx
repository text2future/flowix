'use client';

import type { SurfacePresentationUpdate } from '@features/workspace/public/surface-api';
import { getDocumentSession } from '../store/document-runtime-session';

import { useEffect, useCallback, useRef, useMemo, useState } from 'react';
import {
  captureLatestDocumentContent,
  hasDocumentUnsavedChanges,
} from '@features/document/store/document-session-service';
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
import { getWorkspaceMemoState } from '@features/memo/public/workspace-api';
import { resolveNotebookIdForPath } from '@features/document/use-cases/resolve-notebook-id-for-path';
import { toast } from '@/lib/toast';
import { files, product } from '@platform/tauri/client/desktop';
import { externalDocuments } from '@platform/tauri/client/memos';
import { notes } from '@platform/tauri/client/notes';
import { markdownFilenameForTitle, renameMarkdownTitle } from '@features/document/use-cases/local-document-operations';
import {
  initialDocumentContainerState,
  type DocumentContainerProps,
} from '@features/document/components/session/types';
import { useDocumentContent } from '@features/document/components/session/use-document-content';
import { useDocumentAutosave } from '@features/document/components/session/use-document-autosave';
import { DocumentContentBoundary } from './session/document-content-boundary';
import { useDocumentMetainfo } from './session/use-document-metainfo';
import { useExternalDocumentChangeWatch } from '@features/document/components/session/use-external-document-change-watch';
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
import { focusWorkspaceColumnFromEvent } from '@features/workspace/public/host-api';
import { getBuffer, subscribeDocumentBufferChanges } from '@features/document/store/buffer-registry';
import { documentIdentityKey } from '@features/document/store/document-identity';
import {
  expectExternalDocumentWrite,
  isExternalDocumentRenameInProgress,
} from '@features/document/store/external-document-operation';
import { rebaseActiveDocumentPath } from '@features/document/store/document-session-service';
import type { Editor, JSONContent } from '@tiptap/core';
import { replaceExternalDocumentPath } from '@features/workspace/public/note-navigation-api';
import { openDocumentLocalLink } from '@features/document/use-cases/open-document-local-link';
import {
  cancelAgentLocationRequest,
  consumeAgentLocationRequest,
  peekAgentLocationRequest,
  subscribeAgentLocationRequest,
} from '@features/document/use-cases/agent-location-navigation';
import { parseMarkdownInWorker } from '@features/editor/markdown-parser';
import { markDocumentOpenTrace } from '@/lib/document-open-perf';

type ParsedMarkdownDocument = {
  key: string;
  source: string;
  /** `null` keeps the editor's compatibility fallback after Worker failure. */
  document: JSONContent | null;
};

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
  workspaceHost,
  navigationViewId,
  readOnly: forcedReadOnly = false,
  initialFocus,
  onEditorReady,
  onSurfaceLifecycleReady,
  onContentStateChange,
  onFlushReady,
}: DocumentContainerProps) {
  const filePath = fileIdentity.path;
  const searchPanelControlProps = onSearchPanelOpenChange
    ? { searchPanelOpen: searchPanelOpen ?? false, onSearchPanelOpenChange }
    : {};
  const displayId = fileIdentity.displayId;
  const { t } = useI18n();
  const hostId = workspaceHost ?? (documentSessionMode === 'isolated' ? 'column-2' : 'column-1');
  const locationViewId = navigationViewId ?? hostId;
  const focusedColumnId = useWorkspaceFocusStore((store) => store.focusedColumnId);
  const readOnly = forcedReadOnly || focusedColumnId !== hostId;
  // Property actions may activate this host on demand. Keep them available
  // while another host owns edit focus, but honor explicit/path-based read-only.
  const propertyActionsEnabled = !forcedReadOnly && (!isExternalDocument || Boolean(externalScopePath));
  const activatePropertyEditor = useCallback(() => {
    if (propertyActionsEnabled) useWorkspaceFocusStore.getState().focusColumn(hostId);
  }, [hostId, propertyActionsEnabled]);
  const containerRef = useRef<HTMLDivElement>(null);
  const resolvedExternalDisplayId = isExternalDocument ? displayId : null;
  const documentInstanceKey = useMemo(
    () => `md:${displayId}`,
    [displayId]
  );
  const documentIdentity = getDocumentSession(
    documentIdentityFromFile({ path: filePath, displayId }),
  ).identity;
  const propertyTargetId = documentPropertyTargetId(displayId, hostId);
  const [propertyAreaHoverTargetId, setPropertyAreaHoverTargetId] = useState<string | null>(null);
  const propertyAreaHovered = propertyAreaHoverTargetId === propertyTargetId;
  const handlePropertyAreaHoverChange = useCallback((hovered: boolean) => {
    setPropertyAreaHoverTargetId((current) => {
      if (hovered) return propertyTargetId;
      return current === propertyTargetId ? null : current;
    });
  }, [propertyTargetId]);
  const editorMode = useDocumentEditorMode(hostId, documentIdentity);
  // Rich/source mode belongs to the open Markdown file identity. Non-Markdown
  // external files retain their independent CodeMirror presentation setting.
  const usesCodeEditor = isExternalDocument
    ? externalEditorMode === 'code' || editorMode === 'source'
    : editorMode === 'source';
  const loadedDocumentInstanceKeyRef = useRef<string | null>(null);
  const editorHandleRef = useRef<MarkdownEditorHandle | null>(null);
  // 编辑器懒加载完成后递增，驱动待消费的定位请求在 handle 就绪后重试，
  // 避免用固定计时器猜测加载状态。
  const [editorReadyTick, setEditorReadyTick] = useState(0);
  const [richEditorMount, setRichEditorMount] = useState<{ key: string; ready: boolean } | null>(null);
  const [codeEditorReadyFor, setCodeEditorReadyFor] = useState<string | null>(null);
  const richEditorMountReadyFor = richEditorMount?.key ?? null;
  const richEditorReadyFor = richEditorMount?.ready ? richEditorMount.key : null;
  const [parsedMarkdownDocument, setParsedMarkdownDocument] = useState<ParsedMarkdownDocument | null>(null);
  const titleEditorRef = useRef<MemoTitleEditorHandle | null>(null);
  const memoFilename = fileNameFromPath(filePath);
  const renameInProgressRef = useRef(false);
  const previousFilePathRef = useRef(filePath);
  const getCurrentFilePath = useCallback(() => documentIdentity.path, [documentIdentity]);
  const getAttachmentNotebookId = useCallback(() => {
    return resolveNotebookIdForPath(documentIdentity.path, getWorkspaceMemoState().notebooks);
  }, [documentIdentity]);
  const imageNotebookId = getAttachmentNotebookId();
  const imageScopePath = getWorkspaceMemoState().notebooks.find(notebook => notebook.id === imageNotebookId)?.path ?? externalScopePath;
  const getAttachmentOwnerPath = useCallback(() => {
    // COSEC: Uploads must belong to a note inside a registered notebook.
    return getAttachmentNotebookId() ? getCurrentFilePath() : undefined;
  }, [getAttachmentNotebookId, getCurrentFilePath]);
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

  const [, refreshMountSource] = useState(0);
  const contentForMount = getBuffer(documentIdentity)?.content ?? '';
  const markdownParserKey = JSON.stringify([documentInstanceKey, filePath]);
  const parsedMarkdownMatches = parsedMarkdownDocument?.key === markdownParserKey
    && parsedMarkdownDocument.source === contentForMount;
  const shouldMountRichEditor = state.isLoaded && !state.isLoading && !state.error && !usesCodeEditor;
  const needsWorkerMarkdownParse = richEditorMountReadyFor !== documentInstanceKey
    && !parsedMarkdownMatches;
  const canMountRichEditor = shouldMountRichEditor && !needsWorkerMarkdownParse;
  const editorIsReady = state.isLoaded && !state.isLoading && !state.error
    && (usesCodeEditor ? codeEditorReadyFor === documentInstanceKey : richEditorReadyFor === documentInstanceKey);

  useEffect(() => {
    if (!shouldMountRichEditor
      || richEditorMountReadyFor === documentInstanceKey || parsedMarkdownMatches) return;

    let cancelled = false;
    const source = contentForMount;
    const startedAt = performance.now();
    markDocumentOpenTrace(transitionId, 'editor:markdown-worker-start', {
      contentChars: source.length,
      path: filePath,
    });
    const finishWith = (document: JSONContent | null, error?: string, workerMs?: number) => {
      if (cancelled) return;
      const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
      setParsedMarkdownDocument({ key: markdownParserKey, source, document });
      console.info('[perf:open-doc]', 'MarkdownParser:worker', {
        elapsedMs,
        workerMs,
        contentChars: source.length,
        success: !error,
        ...(error ? { error } : {}),
      });
      markDocumentOpenTrace(transitionId, error ? 'editor:markdown-worker-error' : 'editor:markdown-worker-ready', {
        elapsedMs,
        workerMs,
        contentChars: source.length,
        error,
      });
    };

    void parseMarkdownInWorker(source).then((reply) => {
      finishWith(reply.document ?? null, undefined, reply.workerMs);
    }).catch((error) => {
      finishWith(null, error instanceof Error ? error.message : String(error));
    });

    return () => {
      cancelled = true;
    };
  }, [
    documentInstanceKey,
    filePath,
    markdownParserKey,
    parsedMarkdownMatches,
    richEditorMountReadyFor,
    shouldMountRichEditor,
    contentForMount,
    transitionId,
  ]);

  useEffect(() => {
    if (!canMountRichEditor) {
      setRichEditorMount(null);
      return;
    }
    if (richEditorMountReadyFor === documentInstanceKey) return;
    setRichEditorMount({ key: documentInstanceKey, ready: false });
  }, [canMountRichEditor, documentInstanceKey, richEditorMountReadyFor]);

  useEffect(() => {
    if (!onContentStateChange) return;
    if (state.error) {
      const retry = () => reloadDocument(filePath, { showLoading: true });
      if (isExternalDocument && /\.(?:md|markdown)$/i.test(filePath)
        && state.errorKind === 'missing-note') {
        onContentStateChange({ status: 'missing-note', path: filePath, retry });
      } else {
        onContentStateChange({ status: 'error', message: state.error, retry });
      }
    } else if (!editorIsReady) {
      onContentStateChange({ status: 'loading', retainContent: true });
    } else {
      onContentStateChange({ status: 'ready' });
    }
  }, [editorIsReady, filePath, isExternalDocument, onContentStateChange, reloadDocument, state.error, state.errorKind]);

  useEffect(() => {
    if (!filePath) return;
    const revealPendingLocation = () => {
      if (state.error) {
        const pending = peekAgentLocationRequest(filePath);
        if (pending?.host === hostId && pending.viewId === locationViewId) {
          cancelAgentLocationRequest(filePath, pending.id);
        }
        return;
      }
      const request = peekAgentLocationRequest(filePath);
      if (!request || request.host !== hostId || request.viewId !== locationViewId
        || (!request.location && !request.anchor)) return;
      if (!state.isLoaded) return;
      if (!usesCodeEditor) {
        if (!request.location && request.anchor) {
          // Heading anchors are semantic (GitHub slug): reveal in the rich
          // text view without forcing source mode.
          const found = editorHandleRef.current?.revealHeadingAnchor?.(request.anchor);
          if (found === null || found === undefined) return;
          consumeAgentLocationRequest(filePath, request.id);
          if (!found) toast.info(t('document.file.anchorNotFound'));
          return;
        }
        // Agent links refer to source lines. Rich Markdown positions have no
        // stable one-to-one mapping, so switch this document surface to source.
        setDocumentEditorMode(hostId, documentIdentity, 'source');
        return;
      }
      if (request.location) {
        const result = editorHandleRef.current?.revealSourceLocation?.(request.location);
        if (!result) return;
        consumeAgentLocationRequest(filePath, request.id);
        if (result.clamped) toast.info(t('document.file.locationClamped'));
        return;
      }
      const found = request.anchor
        ? editorHandleRef.current?.revealSourceAnchor?.(request.anchor)
        : null;
      if (found === null || found === undefined) return;
      consumeAgentLocationRequest(filePath, request.id);
      if (!found) toast.info(t('document.file.anchorNotFound'));
    };
    revealPendingLocation();
    return subscribeAgentLocationRequest(filePath, revealPendingLocation);
  }, [documentIdentity, filePath, hostId, locationViewId, state.error, state.isLoaded, t, usesCodeEditor, editorReadyTick]);

  useEffect(() => () => {
    const request = peekAgentLocationRequest(filePath);
    if (request?.viewId === locationViewId) cancelAgentLocationRequest(filePath, request.id);
  }, [filePath, locationViewId]);

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
    let savedRevision = getBuffer(documentIdentity)?.savedRevision ?? -1;
    let request = 0;
    const unsubscribe = subscribeDocumentBufferChanges((identity, reason) => {
      if (documentIdentityKey(identity) !== key) return;
      if (reason !== 'save_settled' && reason !== 'merged') return;
      const revision = getBuffer(documentIdentity)?.savedRevision ?? -1;
      // Recovery protection also emits save_settled; only a canonical save
      // can change the file's modification time.
      if (revision <= savedRevision) return;
      savedRevision = revision;
      const currentRequest = ++request;
      void notes.modifiedAt(filePath).then((modifiedAt) => {
        if (!cancelled && currentRequest === request && modifiedAt) {
          setState((previous) => previous.updatedAtDate?.getTime() === new Date(modifiedAt).getTime()
            ? previous : { ...previous, updatedAtDate: new Date(modifiedAt) });
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
    identity: documentIdentity,
    externalScopePath,
    flushPendingContent: flushPendingEditorChanges,
    hostId,
    isActive: () => !forcedReadOnly && useWorkspaceFocusStore.getState().focusedColumnId === hostId,
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
      const notebookId = getAttachmentNotebookId();
      const result = await renameMarkdownTitle({
        path: currentPath,
        title: requestedTitle,
        scopePath: externalScopePath,
        notebook: getWorkspaceMemoState().notebooks.find(notebook => notebook.id === notebookId) ?? null,
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
    getAttachmentNotebookId,
    isExternalDocument,
    resolvedExternalDisplayId,
    t,
  ]);

  useEffect(() => {
    const key = documentIdentityKey(documentIdentity);
    const unsubscribeBuffer = subscribeDocumentBufferChanges((identity) => {
      if (documentIdentityKey(identity) !== key) return;
      // While an editor is mounting, another surface can publish newer text.
      // Once mounted, its content boundary owns all live text notifications.
      if (!editorHandleRef.current) refreshMountSource((version) => version + 1);
    });
    const unsubscribeFocus = useWorkspaceFocusStore.subscribe((next, previous) => {
      if (previous.focusedColumnId === hostId && next.focusedColumnId !== hostId) {
        // Finish composition and publish the outgoing editor before React
        // enables the incoming surface. Disk persistence remains debounced.
        const active = document.activeElement;
        if (active instanceof HTMLElement && containerRef.current?.contains(active)) active.blur();
        editorHandleRef.current?.commitPropertyDraft?.();
        captureLatestDocumentContent(documentIdentity, hostId);
      }
    });
    return () => {
      unsubscribeBuffer();
      unsubscribeFocus();
    };
  }, [documentIdentity, hostId]);

  useEffect(() => {
    onFlushReady?.(flushDocument, discardDocument);
    return () => onFlushReady?.(null, null);
  }, [discardDocument, flushDocument, onFlushReady]);
  useEffect(() => {
    if (!editorIsReady) return;
    let active = true;
    onSurfaceLifecycleReady?.({
      status: 'ready', flush: flushDocument, discard: discardDocument,
      focus: (target = 'body') => {
        if (!active || !containerRef.current?.getClientRects().length) return false;
        const focus = target === 'title'
          ? titleEditorRef.current?.focusEnd
          : editorHandleRef.current?.focusStart;
        if (!focus) return false;
        useWorkspaceFocusStore.getState().focusColumn(hostId);
        requestAnimationFrame(() => {
          if (active && containerRef.current?.isConnected
            && useWorkspaceFocusStore.getState().focusedColumnId === hostId) {
            if (target === 'title') titleEditorRef.current?.focusEnd();
            else editorHandleRef.current?.focusStart?.();
          }
        });
        return true;
      },
    });
    return () => {
      active = false;
      onSurfaceLifecycleReady?.(null);
    };
  }, [discardDocument, editorIsReady, flushDocument, hostId, onSurfaceLifecycleReady]);
  useEffect(() => {
    if (!filePath) {
      setState(initialDocumentContainerState);
      return;
    }

    const loadedDocumentInstanceKey = loadedDocumentInstanceKeyRef.current;
    const instanceKeyChanged = loadedDocumentInstanceKey !== documentInstanceKey;
    const pathChanged = previousFilePathRef.current !== filePath;
    previousFilePathRef.current = filePath;
    loadedDocumentInstanceKeyRef.current = documentInstanceKey;

    // A path is an attribute of this session, never an editor lifecycle key.
    // Actual external content changes arrive through the content watchers.
    if (!instanceKeyChanged) {
      rebaseActiveDocumentPath(documentIdentity, filePath);
      if (pathChanged) {
        if (state.isLoading) return;
        if (state.error || !state.isLoaded) {
          reloadDocument(filePath, {
            preservePending: hasDocumentUnsavedChanges(documentIdentity),
            showLoading: true,
          });
          return;
        }
      }
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

  const metadata = useMemo(() => ({
    createdAt: state.createdAt, updatedAt: state.updatedAt,
    isFavorited: state.isFavorited, frontmatterMeta: state.frontmatterMeta,
  }), [state.createdAt, state.updatedAt, state.isFavorited, state.frontmatterMeta]);
  useDocumentMetainfo({
    identity: documentIdentity,
    loaded: state.isLoaded && Boolean(filePath),
    active: focusedColumnId === hostId,
    metadata,
    onMetainfoData,
  });

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
      propertyActionsEnabled={propertyActionsEnabled}
      workspaceHost={hostId}
      onActivateProperties={activatePropertyEditor}
      autoFocus={initialFocus === 'title'}
      sourceMode={usesCodeEditor}
      showPropertiesToggle
      propertyAreaHovered={propertyAreaHovered}
      allowReadOnlyBoundaryNavigation
      onMoveToBody={handleMoveTitleToBody}
      onPasteToBody={handlePasteTitleContentToBody}
    />
  ) : null;

  return (
    <div
      ref={containerRef}
      data-document-session-mode={documentSessionMode}
      onFocusCapture={(event) => focusWorkspaceColumnFromEvent(event, hostId)}
      onPointerDownCapture={(event) => focusWorkspaceColumnFromEvent(event, hostId)}
      className="document-container h-full w-full min-w-0 flex flex-col bg-transparent relative overflow-hidden"
    >
      <div className="relative flex-1 min-h-0 min-w-0 overflow-hidden">
        {!onContentStateChange && !state.error && !editorIsReady && (
          <CenteredLoadingSpinner className="pointer-events-none absolute inset-0 z-10" />
        )}
        <DocumentContentBoundary identity={documentIdentity}>{(content) => <>
        {state.isLoaded && !state.isLoading && usesCodeEditor && (
          <LazyCodeEditor
            ref={editorHandleRef}
            key={documentInstanceKey}
            filePath={filePath}
            content={content}
            editable={!readOnly}
            onChange={handleChange}
            autoFocus={initialFocus === 'body'}
            onEditorScroll={handleEditorScroll}
            onEditingFinished={flushPendingEditorChanges}
            onReadyChange={(ready) => {
              setCodeEditorReadyFor((current) => ready
                ? documentInstanceKey : current === documentInstanceKey ? null : current);
            }}
            scrollHeader={documentHeader ?? undefined}
            {...searchPanelControlProps}
          />
        )}
        {canMountRichEditor && richEditorMountReadyFor === documentInstanceKey && (
          <LazyDocumentEditor
            ownerPath={documentIdentity.path}
            getAttachmentOwnerPath={getAttachmentOwnerPath}
            getAttachmentNotebookId={getAttachmentNotebookId}
            workspaceHost={hostId}
            propertyTargetId={propertyTargetId}
            onPropertyAreaHoverChange={handlePropertyAreaHoverChange}
            onViewSourceMode={handleToggleEditorMode}
            transitionId={transitionId}
            ref={editorHandleRef}
            key={documentInstanceKey}
            content={content}
            initialParsedContent={parsedMarkdownMatches && parsedMarkdownDocument?.source === content ? parsedMarkdownDocument.document ?? undefined : undefined}
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
            {...searchPanelControlProps}
            onBeforeCreate={(editor: Editor) => {
              onEditorReady?.(editor);
              setRichEditorMount({ key: documentInstanceKey, ready: true });
              // The editor has consumed the initial tree; release the duplicate.
              setParsedMarkdownDocument((parsed) => (
                parsed?.key === markdownParserKey ? null : parsed
              ));
              setEditorReadyTick((tick) => tick + 1);
            }}
            imageContext={{
              documentPath: filePath,
              scopePath: imageScopePath,
              readImage: (path, scopePath) => files.readImage(path, scopePath),
            }}
            linkContext={{
              documentPath: filePath,
              openLocalPath: (target) => openDocumentLocalLink(target, externalScopePath),
            }}
            toolbarCollapsed={toolbarCollapsed}
            onToolbarCollapsedChange={onToolbarCollapsedChange}
          />
        )}
        </>}</DocumentContentBoundary>
      </div>
    </div>
  );
}

export function UnavailableFileView({
  filePath,
  openContainingFolder = false,
  scopePath,
  reportPresentation,
}: {
  filePath: string;
  openContainingFolder?: boolean;
  scopePath?: string | null;
  reportPresentation?: (update: SurfacePresentationUpdate) => void;
}) {
  const { t } = useI18n();
  const filename = filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
  const reveal = useCallback(async () => {
    try { await product.revealInFileManager(filePath); }
    catch { toast.error(t('memo.fileTree.openFailed')); }
  }, [filePath, t]);
  const openDefault = useCallback(async () => {
    try { await externalDocuments.openWithDefaultApp(filePath, scopePath); }
    catch { toast.error(t('errors.friendly.externalOpen')); }
  }, [filePath, scopePath, t]);
  useEffect(() => {
    const actions = [{ id: 'reveal', label: { key: openContainingFolder ? 'document.file.openContainingFolder' : 'document.file.reveal' }, enabled: true, run: reveal }];
    if (openContainingFolder) actions.push({ id: 'open-default', label: { key: 'document.file.openWithDefaultApp' }, enabled: true, run: openDefault });
    reportPresentation?.({ title: filename, actions,
      state: { status: 'unavailable', reason: 'unsupported', message: { key: 'document.file.unavailable', fallbackText: filename }, actions } });
  }, [filename, openContainingFolder, openDefault, reportPresentation, reveal]);
  if (reportPresentation) return null;

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-sm text-[var(--muted-foreground)]">
      <span className="max-w-full truncate text-[var(--foreground)]" title={filename}>{filename}</span>
      <span>{t('document.file.unavailable')}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => { void reveal(); }}
          className="inline-flex h-8 items-center rounded-lg border border-[var(--border)] px-3 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        >
          {t(openContainingFolder ? 'document.file.openContainingFolder' : 'document.file.reveal')}
        </button>
        {openContainingFolder && (
          <button
            type="button"
            onClick={() => { void openDefault(); }}
            className="inline-flex h-8 items-center rounded-lg border border-[var(--border)] px-3 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
          >
            {t('document.file.openWithDefaultApp')}
          </button>
        )}
      </div>
    </div>
  );
}
