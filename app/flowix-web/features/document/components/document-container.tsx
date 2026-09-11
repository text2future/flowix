'use client';

import { useEffect, useCallback, useRef, useMemo, useState } from 'react';
import { useMemoStore } from '@features/memo';
import { files } from '@platform/tauri/client';
import {
  applyLoadedDocumentContent,
  consumeSelfDocumentPathUpdate,
  hasDocumentUnsavedChanges,
  useDocumentMetricsStore,
  useDocumentStore,
  type DocumentIdentity,
} from '@features/document';
import { getDocumentInstanceKey } from '@/lib/path';
import { toast } from '@/lib/toast';
import { openPath } from '@platform/tauri/opener';
import {
  initialDocumentContainerState,
  type DocumentContainerProps,
} from '@features/document/components/session/types';
import {
  countTextUnits,
  extractBodyContent,
  findMemoById,
} from '@features/document/components/session/document-utils';
import { useDocumentContent } from '@features/document/components/session/use-document-content';
import { useDocumentAutosave } from '@features/document/components/session/use-document-autosave';
import { useExternalDocumentChangeWatch } from '@features/document/components/session/use-external-document-change-watch';
import { useMemoDocumentChangeWatch } from '@features/document/components/session/use-memo-document-change-watch';
import { LazyDocumentEditor } from '@features/document/components/lazy-document-editor';
import { LazyCodeEditor } from '@features/document/components/lazy-code-editor';
import { NotePropertiesDialog } from '@features/document/components/note-properties-dialog';
import { MemoDocumentHeader } from '@features/document/components/memo-document-header';
import type { MarkdownEditorHandle } from '@features/editor/markdown-editor';
import { isEditableTextFilePath, isImageFilePath } from '@features/editor/code-file';
import backgroundImage from '@/assets/bg.document.png';
import { useI18n } from '@/lib/i18n';
import { clearWorkspaceDocument } from '@features/workspace/use-cases/workspace-navigation';
import { removeBrowserColumnTabsByMemoId } from '@features/workspace/use-cases/browser-column-navigation';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import { getBuffer, subscribeDocumentBufferChanges } from '@features/document/store/buffer-registry';
import { documentIdentityKey } from '@features/document/store/document-identity';

export function DocumentContainer({
  filePath,
  memoId = null,
  notebookPath = null,
  transitionId = null,
  onMetainfoData,
  isExternalDocument = false,
  externalScopePath = null,
  searchPanelOpen = false,
  onSearchPanelOpenChange,
  toolbarCollapsed = false,
  onToolbarCollapsedChange,
  documentSessionMode = 'main',
  readOnly: forcedReadOnly = false,
  initialFocus,
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
  const isImagePreview = isExternalDocument && isImageFilePath(filePath);
  const isUnsupportedExternalFile = isExternalDocument && !isEditableTextFilePath(filePath) && !isImagePreview;
  // Every text file in the file tree, including Markdown, is source text and
  // therefore uses CodeMirror. Memo documents retain their rich editor.
  const usesCodeEditor = isExternalDocument && isEditableTextFilePath(filePath);
  const loadedDocumentInstanceKeyRef = useRef<string | null>(null);
  const prevFilePathRef = useRef<string | null>(null);
  const editorHandleRef = useRef<MarkdownEditorHandle | null>(null);
  // 切片订阅: 替代原来的 `useMemoStore()` 全量订阅 —— 任何 set 都会让本组件重渲,
  // 包括 doc 内容 / charCount 这些高频变化。切到 selector 后, 只在用到的
  // 仅订阅当前 memo 实体，避免按 memo 数组长度变化而重渲。
  const activeMemo = useMemoStore(useCallback((store) => {
    return findMemoById(store, memoId);
  }, [memoId]));
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
    skipContentLoad: isImagePreview || isUnsupportedExternalFile,
    transitionId,
    isolatedSession: documentSessionMode === 'isolated',
  });
  const flushPendingEditorChanges = useCallback(() => {
    return editorHandleRef.current?.flushPendingChanges() ?? null;
  }, []);

  const {
    clearSaveTimer,
    flushDocument,
    discardDocument,
    handleChange,
    saveDoc,
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
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [propertiesContentSnapshot, setPropertiesContentSnapshot] = useState<string | null>(null);

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
    const handleNavigateToMemo = async (e: Event) => {
      const customEvent = e as CustomEvent<{ memoId: string }>;
      const targetMemoId = customEvent.detail?.memoId;
      if (targetMemoId) {
        const { memos } = useMemoStore.getState();
        const memo = memos.find(m => m.id === targetMemoId);
        if (memo?.filename) {
          // Navigate by path - handled by parent component
          window.location.hash = `/memo/${memo.id}`;
        }
      }
    };

    document.addEventListener('navigate-to-memo', handleNavigateToMemo);
    return () => {
      document.removeEventListener('navigate-to-memo', handleNavigateToMemo);
    };
  }, []);

  useEffect(() => {
    if (!memoId) return;

    const handleOpenProperties = (event: Event) => {
      const detail = (event as CustomEvent<{ memoId: string }>).detail;
      if (detail?.memoId !== memoId) return;
      setPropertiesOpen(true);
    };

    window.addEventListener('flowix:open-note-properties', handleOpenProperties);
    return () => {
      window.removeEventListener('flowix:open-note-properties', handleOpenProperties);
    };
  }, [memoId]);

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
      return;
    }

    const isDirtyForRename = !instanceKeyChanged && hasDocumentUnsavedChanges(documentIdentity);
    if (isDirtyForRename) {
      prevFilePathRef.current = filePath;
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
    return (
      <div className="relative w-full h-full flex items-center justify-center">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-no-repeat bg-bottom bg-[length:auto_800px] opacity-[0.32]"
          style={{ backgroundImage: `url(${backgroundImage})` }}
        />
        <span className="relative text-center text-[var(--muted-foreground)] text-sm">
          {t("document.empty")}
        </span>
      </div>
    );
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
            className="inline-flex items-center h-7 px-2.5 text-xs rounded-lg bg-transparent border border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
          >
            {t('document.ghost.deleteButton')}
          </button>
        )}
      </div>
    );
  }

  if (isUnsupportedExternalFile) {
    return <UnavailableFileView filePath={filePath} />;
  }

  return (
    <div ref={containerRef} onFocusCapture={() => useWorkspaceFocusStore.getState().focusHost(hostId)} onPointerDownCapture={() => useWorkspaceFocusStore.getState().focusHost(hostId)} className="document-container h-full w-full min-w-0 flex flex-col bg-transparent relative overflow-hidden">
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        {!state.isLoading && isImagePreview && (
          <ImageFilePreview filePath={filePath} scopePath={externalScopePath} />
        )}
        {!state.isLoading && usesCodeEditor && (
          <LazyCodeEditor
            ref={editorHandleRef}
            key={documentInstanceKey}
            filePath={filePath}
            content={state.fullContent}
            editable={!readOnly}
            onChange={handleChange}
            onEditorScroll={(scrollTop) => setState(prev => ({ ...prev, isScrolled: scrollTop > 90 }))}
            onEditingFinished={flushPendingEditorChanges}
            searchPanelOpen={searchPanelOpen}
            onSearchPanelOpenChange={onSearchPanelOpenChange}
          />
        )}
        {!state.isLoading && !usesCodeEditor && state.fullContent && (
          <LazyDocumentEditor
            memoId={memoId ?? undefined}
            ref={editorHandleRef}
            key={documentInstanceKey}
            content={state.fullContent}
            header={!isExternalDocument && memoId && activeMemo ? (
              <MemoDocumentHeader
                memoId={memoId}
                filename={activeMemo.filename}
                updatedAt={state.updatedAtDate ?? (activeMemo.updatedAt ? new Date(activeMemo.updatedAt) : null)}
                editable={!readOnly}
                autoFocus={initialFocus === 'title'}
                onMoveToBody={() => editorHandleRef.current?.focusStart?.()}
              />
            ) : null}
            editable={!readOnly}
            onChange={(content) => {
              handleChange(content);
            }}
            className=""
            onEditorScroll={(scrollTop) => setState(prev => ({ ...prev, isScrolled: scrollTop > 90 }))}
            onEditingFinished={() => {
              flushPendingEditorChanges();
            }}
            autoFocus={initialFocus === 'body'}
            searchPanelOpen={searchPanelOpen}
            onSearchPanelOpenChange={onSearchPanelOpenChange}
            toolbarCollapsed={toolbarCollapsed}
            onToolbarCollapsedChange={onToolbarCollapsedChange}
          />
        )}
      </div>
      {!readOnly && !isExternalDocument && memoId && (
        <NotePropertiesDialog
          open={propertiesOpen}
          content={propertiesContentSnapshot ?? state.fullContent}
          onOpenChange={(open) => {
            if (open) {
              // 打开属性面板前清掉 autosave debounce timer, 避免:
              // 1. 用户敲了字后立刻打开面板 → 1s 后 timer 触发, 用
              //    propertiesContentSnapshot (尚未含属性改动) 覆盖磁盘;
              // 2. 用户在面板里改完属性, saveDoc(force) 已落盘, 但 timer
              //    随后再用旧 snapshot 走 CAS-fail 之外的路径把磁盘回滚。
              clearSaveTimer();
              const latestContent = flushPendingEditorChanges();
              if (latestContent !== null) {
                setPropertiesContentSnapshot(latestContent);
              }
            } else {
              setPropertiesContentSnapshot(null);
            }
            setPropertiesOpen(open);
          }}
          onSave={async (nextContent) => {
            flushPendingEditorChanges();
            setPropertiesContentSnapshot(null);
            setState((prev) => ({ ...prev, fullContent: nextContent }));
            handleChange(nextContent);
            clearSaveTimer();
            await saveDoc(nextContent, filePath, { force: true });
          }}
        />
      )}
    </div>
  );
}

function UnavailableFileView({ filePath }: { filePath: string }) {
  const { t } = useI18n();
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-sm text-[var(--muted-foreground)]">
      <span>{t('document.file.unavailable')}</span>
      <button
        type="button"
        onClick={() => void openPath(parentDirectory(filePath))}
        className="inline-flex h-8 items-center rounded-lg border border-[var(--border)] px-3 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]"
      >
        {t('document.file.reveal')}
      </button>
    </div>
  );
}

function parentDirectory(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const separator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (separator > 0) return normalized.slice(0, separator);
  return normalized.startsWith('/') ? '/' : normalized;
}

function ImageFilePreview({ filePath, scopePath }: { filePath: string; scopePath: string | null }) {
  const { t } = useI18n();
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setLoading(true);
    setFailed(false);
    void files.readImage(filePath, scopePath ?? undefined).then((dataUrl) => {
      if (cancelled) return;
      setSrc(dataUrl);
      setFailed(!dataUrl);
      setLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setFailed(true);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath, scopePath]);

  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">{t('document.file.loading')}</div>;
  }
  if (failed || !src) return <UnavailableFileView filePath={filePath} />;

  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto bg-[var(--background)] p-6">
      <img
        src={src}
        alt={filePath.split(/[\\/]/).pop() ?? filePath}
        className="max-h-full max-w-full object-contain"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
