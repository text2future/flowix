'use client';

import { useEffect, useCallback, useRef, useMemo } from 'react';
import { useMemoStore } from '@features/memo/store/memo-store';
import {
  applyLoadedDocumentContent,
  registerDocumentCapture,
  captureLatestDocumentContent,
  consumeSelfDocumentPathUpdate,
  hasDocumentUnsavedChanges,
} from '@features/document/store/document-session-service';
import { useDocumentMetricsStore } from '@features/document/store/document-metrics-store';
import { useDocumentStore } from '@features/document/store/document-store';
import {
  setDocumentEditorMode,
  useDocumentEditorMode,
} from '@features/document/store/document-editor-view-store';
import type { DocumentIdentity } from '@features/document/store/document-identity';
import { fileNameFromPath, getDocumentInstanceKey } from '@/lib/path';
import { toast } from '@/lib/toast';
import { product } from '@platform/tauri/client/desktop';
import { openPath } from '@platform/tauri/opener';
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
import { useMemoDocumentChangeWatch } from '@features/document/components/session/use-memo-document-change-watch';
import {
  LazyDocumentEditor,
  preloadDocumentEditor,
} from '@features/document/components/lazy-document-editor';
import { LazyCodeEditor } from '@features/document/components/lazy-code-editor';
import { SourceMemoEditor } from '@features/document/components/source-memo-editor';
import { MemoDocumentHeader } from '@features/document/components/memo-document-header';
import type {
  MemoTitleBodyNavigation,
  MemoTitleEditorHandle,
} from '@features/document/components/memo-title-editor';
import type { MarkdownEditorHandle } from '@features/editor/markdown-editor';
import type { ClipboardSnapshot } from '@features/editor/extensions/paste-rules/clipboard';
import { useI18n } from '@/lib/i18n';
import { CenteredLoadingSpinner } from '@shared/ui/centered-loading-spinner';
import { WorkspaceEmptyState } from '@shared/ui/workspace-empty-state';
import { clearWorkspaceDocument } from '@features/workspace/use-cases/workspace-navigation';
import { removeBrowserColumnTabsByMemoId } from '@features/workspace/use-cases/browser-column-navigation';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import { getBuffer, subscribeDocumentBufferChanges } from '@features/document/store/buffer-registry';
import { documentIdentityKey } from '@features/document/store/document-identity';
import type { Editor } from '@tiptap/core';

export function DocumentContainer({
  filePath,
  memoId = null,
  notebookPath = null,
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
  const { t } = useI18n();
  const hostId = documentSessionMode === 'isolated' ? 'browser-column' : 'main-third';
  const focusedHostId = useWorkspaceFocusStore((store) => store.focusedHostId);
  const readOnly = forcedReadOnly || focusedHostId !== hostId;
  const containerRef = useRef<HTMLDivElement>(null);
  const documentInstanceKey = useMemo(
    () => memoId ? `memo:${memoId}` : getDocumentInstanceKey(filePath),
    [filePath, memoId]
  );
  const documentIdentity = useMemo<DocumentIdentity>(
    () => !isExternalDocument && memoId
      ? { kind: 'memo', id: memoId }
      : { kind: 'external', path: filePath },
    [filePath, isExternalDocument, memoId],
  );
  const editorMode = useDocumentEditorMode(hostId, documentIdentity);
  // External Markdown files use Tiptap while other external text files use
  // CodeMirror. Memo documents keep their per-memo rich/source editor setting.
  const usesCodeEditor = isExternalDocument
    ? externalEditorMode === 'code'
    : editorMode === 'source';
  const loadedDocumentInstanceKeyRef = useRef<string | null>(null);
  const prevFilePathRef = useRef<string | null>(null);
  const editorHandleRef = useRef<MarkdownEditorHandle | null>(null);
  const titleEditorRef = useRef<MemoTitleEditorHandle | null>(null);
  const memoFilename = fileNameFromPath(filePath);
  const {
    state,
    setState,
    reloadDocument,
  } = useDocumentContent({
    identity: documentIdentity,
    memoId,
    notebookPath,
    isExternalDocument,
    externalScopePath,
    transitionId,
    isolatedSession: documentSessionMode === 'isolated',
  });

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
    editorHandleRef.current?.moveTitleToBody?.(trailingContent ?? '');
  }, []);

  const handlePasteTitleContentToBody = useCallback((snapshot: ClipboardSnapshot) => {
    editorHandleRef.current?.pasteToBody?.(snapshot);
  }, []);

  const handleToggleEditorMode = useCallback(() => {
    if (isExternalDocument || !memoId) return;
    captureLatestDocumentContent(documentIdentity, hostId);
    setDocumentEditorMode(
      hostId,
      documentIdentity,
      editorMode === 'source' ? 'rich' : 'source',
    );
  }, [documentIdentity, editorMode, hostId, isExternalDocument, memoId]);

  useEffect(() => (
    registerDocumentCapture(documentIdentity, flushPendingEditorChanges, hostId)
  ), [documentIdentity, flushPendingEditorChanges, hostId]);

  const {
    clearSaveTimer,
    flushDocument,
    discardDocument,
    handleChange,
  } = useDocumentAutosave({
    filePath,
    identity: documentIdentity,
    memoId,
    isExternalDocument,
    externalScopePath,
    setState,
    reloadDocument,
    flushPendingContent: flushPendingEditorChanges,
    isolatedSession: documentSessionMode === 'isolated',
  });

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
    const unsubscribeBuffer = subscribeDocumentBufferChanges((identity) => {
      if (documentIdentityKey(identity) === key) sync();
    });
    const unsubscribeFocus = useWorkspaceFocusStore.subscribe((next, previous) => {
      if (previous.focusedHostId === hostId && next.focusedHostId !== hostId) {
        // Finish composition and publish the outgoing editor before React
        // enables the incoming surface. Disk persistence remains debounced.
        const active = document.activeElement;
        if (active instanceof HTMLElement && containerRef.current?.contains(active)) active.blur();
        flushPendingEditorChanges();
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
    if (!memoId) return;

    const handleVersionRestored = (event: Event) => {
      const detail = (event as CustomEvent<{
        memoId: string;
        path: string;
        content: string;
      }>).detail;

      if (!detail || detail.memoId !== memoId) return;

      clearSaveTimer();
      const body = extractBodyContent(detail.content);
      const textUnits = countTextUnits(body);
      applyLoadedDocumentContent(documentIdentity, detail.path, detail.content, {
        preservePending: false,
      });
      setState((prev) => ({
        ...prev,
        fullContent: detail.content,
        isLoaded: true,
        isLoading: false,
        error: null,
        isScrolled: false,
        charCount: textUnits,
        tokenCount: Math.ceil(textUnits / 4),
      }));
    };

    window.addEventListener('flowix:memo-version-restored', handleVersionRestored);
    return () => {
      window.removeEventListener('flowix:memo-version-restored', handleVersionRestored);
    };
  }, [clearSaveTimer, documentIdentity, memoId, setState]);

  useEffect(() => {
    if (!filePath) {
      setState(initialDocumentContainerState);
      return;
    }

    const loadedDocumentInstanceKey = loadedDocumentInstanceKeyRef.current;
    const instanceKeyChanged = loadedDocumentInstanceKey !== documentInstanceKey;
    loadedDocumentInstanceKeyRef.current = documentInstanceKey;

    // memoId 仍指向同一 memo 时, 保持 Tiptap 实例不重建 ── 但 filePath
    // 变化时 (物理 rename) 仍要 reloadDocument: useMemoEvents 在 rename
    // 场景已经同步过 buffer, 但 store 层 API 不动 React state.fullContent;
    // reloadDocument 内部 setState 才能把磁盘新内容 (含新 frontmatter /
    // 派生 title) 推到编辑器视图。否则 VSCode 改首行 / 改 frontmatter
    // filename 触发 rename 后, 编辑器永远显示旧内容。
    //
    // dirty 时跳过 reload ── 否则会覆盖用户未保存字符 (前端 saveDoc 触
    // 发的 rename 场景, 用户在 1s debounce 内可能又敲了字)。dirty
    // 状态下的 rename 冲突由 useExternalDocumentChangeWatch 在事件
    // listener 里走 maybeWarnAboutConflict。
    if (!instanceKeyChanged && filePath === prevFilePathRef.current) {
      // Restoring a retained document starts a new document transition, but
      // this mounted editor already has the current content.
      // Skip the redundant reload while still releasing the loading overlay.
      if (documentSessionMode !== 'isolated' && transitionId !== null) {
        useDocumentStore.getState().finishDocumentTransition(transitionId);
      }
      return;
    }

    if (
      !instanceKeyChanged &&
      !isExternalDocument &&
      memoId &&
      consumeSelfDocumentPathUpdate(memoId, filePath)
    ) {
      prevFilePathRef.current = filePath;
      // The self-path update has already been applied to the retained editor.
      // It therefore skips reloadDocument, whose normal completion path would
      // release the transition overlay. Release it explicitly before leaving.
      if (documentSessionMode !== 'isolated' && transitionId !== null) {
        useDocumentStore.getState().finishDocumentTransition(transitionId);
      }
      return;
    }

    const isDirtyForRename = !instanceKeyChanged && hasDocumentUnsavedChanges(documentIdentity);
    if (isDirtyForRename) {
      prevFilePathRef.current = filePath;
      // A dirty rename deliberately skips the disk reload so we do not lose
      // the live draft, but it still needs to finish the transition that
      // caused this effect to run.
      if (documentSessionMode !== 'isolated' && transitionId !== null) {
        useDocumentStore.getState().finishDocumentTransition(transitionId);
      }
      return;
    }
    prevFilePathRef.current = filePath;

    // Stop this surface's old timer before loading. The target identity may
    // already have a live draft owned by the other column; preserve it below.
    clearSaveTimer();

    reloadDocument(filePath, {
      // A second surface for the same identity shares this buffer. Preserve
      // its live draft instead of replacing it with the disk snapshot.
      preservePending: hasDocumentUnsavedChanges(documentIdentity),
      showLoading: true,
    });
  }, [filePath, documentIdentity, documentInstanceKey, documentSessionMode, isExternalDocument, memoId, reloadDocument, clearSaveTimer]);

  useExternalDocumentChangeWatch({
    filePath,
    identity: documentIdentity,
    scopePath: externalScopePath,
    clearSaveTimer,
    reloadDocument,
  });

  useMemoDocumentChangeWatch({
    filePath,
    identity: documentIdentity,
    clearSaveTimer,
    reloadDocument,
  });

  const metaInfo = useMemo(() => {
    return {
      charCount: state.charCount,
      tokenCount: state.tokenCount,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      memoPath: memoId ?? null,
      memoContent: state.fullContent,
      isFavorited: state.isFavorited,
      frontmatterMeta: state.frontmatterMeta,
    };
  }, [state.charCount, state.tokenCount, state.createdAt, state.updatedAt, state.fullContent, state.isFavorited, state.frontmatterMeta, memoId]);

  useEffect(() => {
    if (filePath) {
      onMetainfoData?.(metaInfo);
    }
  }, [filePath, metaInfo, onMetainfoData]);

  if (!filePath) {
    return <WorkspaceEmptyState tone="document" message={t('shell.emptyDocument')} />;
  }

  if (state.error) {
    // 物理文件丢失场景: memo index 还有这条 entry, 但磁盘上 .md 没了。
    // 之前的兜底只有一行 "读取失败" 文字, 用户没有任何方式主动清掉这个
    // 幽灵 entry。 现在加一个 "删除当前笔记" 按钮 ── 直接走 store 的
    // deleteMemo, 后端 ops::delete_memo 在 file 不存在时会落进 ghost 分支
    // (ops.rs:411-414) 只清 memo index, 然后 emit MemoEvent::Deleted。
    // store 收到事件把 memos 数组里这一项 filter 掉, 列表幽灵消失;
    // 同步调 clearDocument() 把当前打开的 ghost 文档也清掉, 避免下次
    // 切回时再次尝试 readDocument 同一个 path。
    //
    // 不走 flowix:request-delete-memo 弹窗 ── 用户在错误态点按钮本身
    // 已经是"我接受清掉这条"的明确意图, 多一层 dialog 反而干扰恢复流。
    const handleDeleteCurrent = async () => {
      if (!memoId) return;
      try {
        const success = await useMemoStore.getState().deleteMemo(memoId);
        if (success) {
          removeBrowserColumnTabsByMemoId(memoId);
          if (documentSessionMode !== 'isolated') await clearWorkspaceDocument();
          toast.success(t('document.ghost.removed'));
        } else {
          toast.error(t('document.ghost.deleteFailed'));
        }
      } catch {
        toast.error(t('document.ghost.deleteFailed'));
      }
    };
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--muted-foreground)]">
        <span className="text-sm">{state.error}</span>
        {!isExternalDocument && memoId && (
          <button
            type="button"
            onClick={handleDeleteCurrent}
            className="inline-flex items-center h-7 px-2.5 text-xs rounded-lg bg-transparent border border-[var(--border)] text-[var(--muted-foreground)] hover:bg-transparent hover:border-[var(--destructive)] hover:text-[var(--destructive)]"
          >
            {t('document.ghost.deleteButton')}
          </button>
        )}
      </div>
    );
  }

  const memoDocumentHeader = !isExternalDocument && memoId ? (
    <MemoDocumentHeader
      titleRef={titleEditorRef}
      memoId={memoId}
      filename={memoFilename}
      updatedAt={state.updatedAtDate}
      editable={!readOnly}
      autoFocus={initialFocus === 'title'}
      onMoveToBody={handleMoveTitleToBody}
      onPasteToBody={handlePasteTitleContentToBody}
      editorMode={editorMode}
      onToggleEditorMode={handleToggleEditorMode}
    />
  ) : null;

  return (
    <div ref={containerRef} data-document-session-mode={documentSessionMode} onFocusCapture={() => useWorkspaceFocusStore.getState().focusHost(hostId)} onPointerDownCapture={() => useWorkspaceFocusStore.getState().focusHost(hostId)} className="document-container h-full w-full min-w-0 flex flex-col bg-transparent relative overflow-hidden">
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        {state.isLoading && (
          <CenteredLoadingSpinner className="h-full w-full" />
        )}
        {!state.isLoading && usesCodeEditor && (
          !isExternalDocument && memoId ? (
            <SourceMemoEditor
              ref={editorHandleRef}
              key={documentInstanceKey}
              filePath={filePath}
              content={state.fullContent}
              editable={!readOnly}
              onChange={handleChange}
              autoFocus={initialFocus === 'body'}
              memoId={memoId}
              filename={memoFilename}
              titleAutoFocus={initialFocus === 'title'}
              titleRef={titleEditorRef}
              onMoveToBody={handleMoveTitleToBody}
              onPasteToBody={handlePasteTitleContentToBody}
              editorMode={editorMode}
              onToggleEditorMode={handleToggleEditorMode}
              sourceModeToggleLabel={t('document.action.richTextMode')}
              onEditorScroll={handleEditorScroll}
              onEditingFinished={flushPendingEditorChanges}
              searchPanelOpen={searchPanelOpen}
              onSearchPanelOpenChange={onSearchPanelOpenChange}
            />
          ) : (
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
              searchPanelOpen={searchPanelOpen}
              onSearchPanelOpenChange={onSearchPanelOpenChange}
            />
          )
        )}
        {!state.isLoading && state.isLoaded && !usesCodeEditor && (
          <LazyDocumentEditor
            memoId={memoId ?? undefined}
            transitionId={transitionId}
            ref={editorHandleRef}
            key={documentInstanceKey}
            content={state.fullContent}
            header={memoDocumentHeader}
            editable={!readOnly}
            onChange={(content) => {
              handleChange(content);
            }}
            className=""
            onEditorScroll={handleEditorScroll}
            onEditingFinished={() => {
              flushPendingEditorChanges();
            }}
            onFocusTitle={() => titleEditorRef.current?.focusEnd()}
            onAppendToTitle={(title) => titleEditorRef.current?.appendBodyLine(title)}
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
}: {
  filePath: string;
  openContainingFolder?: boolean;
}) {
  const { t } = useI18n();
  const filename = filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
  const parentPath = filePath.replace(/[\\/][^\\/]*$/, '') || (filePath.startsWith('/') ? '/' : filePath);
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-sm text-[var(--muted-foreground)]">
      <span className="max-w-full truncate text-[var(--foreground)]" title={filename}>{filename}</span>
      <span>{t('document.file.unavailable')}</span>
      <button
        type="button"
        onClick={() => {
          const action = openContainingFolder
            ? openPath(parentPath)
            : product.revealInFileManager(filePath);
          void action.catch(() => {
            toast.error(t('memo.fileTree.openFailed'));
          });
        }}
        className="inline-flex h-8 items-center rounded-lg border border-[var(--border)] px-3 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]"
      >
        {t(openContainingFolder ? 'document.file.openContainingFolder' : 'document.file.reveal')}
      </button>
    </div>
  );
}
