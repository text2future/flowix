'use client';

import { useEffect, useCallback, useRef, useMemo, useState } from 'react';
import { useMemoStore } from '@features/memo';
import {
  applyLoadedDocumentContent,
  consumeSelfDocumentPathUpdate,
  hasDocumentUnsavedChanges,
  useDocumentStore,
  type DocumentIdentity,
} from '@features/document';
import { getDocumentInstanceKey } from '@/lib/path';
import { toast } from '@/lib/toast';
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
import { useDocumentFinalize } from '@features/document/components/session/use-document-finalize';
import { useExternalDocumentChangeWatch } from '@features/document/components/session/use-external-document-change-watch';
import { useMemoDocumentChangeWatch } from '@features/document/components/session/use-memo-document-change-watch';
import { LazyDocumentEditor } from '@features/document/components/lazy-document-editor';
import { LazyMarkmapView } from '@features/document/components/lazy-markmap-view';
import { NotePropertiesDialog } from '@features/document/components/note-properties-dialog';
import type { MarkdownEditorHandle } from '@features/editor/markdown-editor';
import backgroundImage from '@/assets/bg.document.png';
import { useI18n } from '@features/i18n';
import { FileText, GitFork } from 'lucide-react';
import { Tooltip } from '@shared/ui/tooltip';

type DocumentViewMode = 'editor' | 'markmap';

export function DocumentContainer({
  filePath,
  memoId = null,
  notebookId = null,
  notebookPath = null,
  transitionId = null,
  onMetainfoData,
  onCharCountChange,
  isExternalDocument = false,
  searchPanelOpen = false,
  onSearchPanelOpenChange,
  toolbarCollapsed = false,
  onToolbarCollapsedChange,
}: DocumentContainerProps) {
  const { t } = useI18n();
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
  const loadedDocumentInstanceKeyRef = useRef<string | null>(null);
  const prevFilePathRef = useRef<string | null>(null);
  const editorHandleRef = useRef<MarkdownEditorHandle | null>(null);
  // 切片订阅: 替代原来的 `useMemoStore()` 全量订阅 —— 任何 set 都会让本组件重渲,
  // 包括 doc 内容 / charCount 这些高频变化。切到 selector 后, 只在用到的
  // 字段 (selectedNotebook + 4 个 action) 变化时才重渲。 activeMemo 单独
  // 用 useShallow 走 memoId selector, 避免按 memo 数组长度变化而重渲。
  const upsertMemo = useMemoStore((store) => store.upsertMemo);
  const activeMemo = useMemoStore(useCallback((store) => {
    return findMemoById(store, memoId);
  }, [memoId]));
  const openMemoDocument = useDocumentStore((store) => store.openMemoDocument);
  const {
    state,
    setState,
    reloadDocument,
  } = useDocumentContent({ identity: documentIdentity, memoId, notebookPath, isExternalDocument, transitionId });
  const flushPendingEditorChanges = useCallback(() => {
    return editorHandleRef.current?.flushPendingChanges() ?? null;
  }, []);

  const {
    clearSaveTimer,
    handleChange,
    saveDoc,
  } = useDocumentAutosave({
    filePath,
    identity: documentIdentity,
    memoId,
    isExternalDocument,
    setState,
    reloadDocument,
    flushPendingContent: flushPendingEditorChanges,
  });
  const { finalizeMemoRename } = useDocumentFinalize({
    filePath,
    memoId,
    notebookId,
    notebookPath,
    isExternalDocument,
    clearSaveTimer,
    saveDoc,
    setState,
    upsertMemo,
    openMemoDocument,
  });
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [propertiesContentSnapshot, setPropertiesContentSnapshot] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<DocumentViewMode>('editor');

  const changeViewMode = useCallback((nextMode: DocumentViewMode) => {
    if (nextMode === viewMode) return;
    if (nextMode === 'markmap') {
      const latestContent = flushPendingEditorChanges();
      if (latestContent !== null) {
        handleChange(latestContent);
        setState((prev) => ({ ...prev, fullContent: latestContent }));
      }
      finalizeMemoRename();
    }
    setViewMode(nextMode);
  }, [finalizeMemoRename, flushPendingEditorChanges, handleChange, setState, viewMode]);

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
      // Restoring a retained single-tab window starts a new document
      // transition, but this mounted editor already has the current content.
      // Skip the redundant reload while still releasing the loading overlay.
      if (transitionId !== null) {
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

    // Switching to a different document must not carry the previous document's
    // unsaved editor snapshot into the new load. The buffer for the new path
    // was just (re)allocated inside reloadDocument -> setActiveDocumentPath, so its
    // pendingContent is already null. clearSaveTimer is a defensive sweep
    // for any stray timer from the previous document.
    clearSaveTimer();

    reloadDocument(filePath, { preservePending: false, showLoading: true });
  }, [filePath, documentIdentity, documentInstanceKey, isExternalDocument, memoId, reloadDocument, clearSaveTimer]);

  useExternalDocumentChangeWatch({
    filePath,
    identity: documentIdentity,
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
      onCharCountChange?.(state.charCount);
    }
  }, [filePath, metaInfo, onMetainfoData, onCharCountChange, state.charCount]);

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
          await useDocumentStore.getState().clearDocument();
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

  return (
    <div className="document-container h-full w-full min-w-0 flex flex-col bg-transparent relative overflow-hidden">
      {state.fullContent && (
        <div
          className="absolute right-4 top-3 z-30 flex items-center rounded-xl border border-[color-mix(in_oklch,var(--border)_84%,transparent)] bg-[color-mix(in_oklch,var(--card)_86%,transparent)] p-1 shadow-sm backdrop-blur-xl"
          role="tablist"
          aria-label={t('document.viewMode.label')}
        >
          <Tooltip content={t('document.viewMode.editor')}>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'editor'}
              onClick={() => changeViewMode('editor')}
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
                viewMode === 'editor'
                  ? 'bg-[var(--primary)] text-[var(--primary-foreground)] shadow-sm'
                  : 'text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]'
              }`}
            >
              <FileText className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{t('document.viewMode.editor')}</span>
            </button>
          </Tooltip>
          <Tooltip content={t('document.viewMode.markmap')}>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'markmap'}
              onClick={() => changeViewMode('markmap')}
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
                viewMode === 'markmap'
                  ? 'bg-[var(--primary)] text-[var(--primary-foreground)] shadow-sm'
                  : 'text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]'
              }`}
            >
              <GitFork className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{t('document.viewMode.markmap')}</span>
            </button>
          </Tooltip>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-hidden">
        {state.fullContent && viewMode === 'editor' && (
          <LazyDocumentEditor
            ref={editorHandleRef}
            key={documentInstanceKey}
            content={state.fullContent}
            onChange={(content) => {
              handleChange(content);
              if (state.isNewlyCreated) setState(prev => ({ ...prev, isNewlyCreated: false }));
            }}
            className=""
            onEditorScroll={(scrollTop) => setState(prev => ({ ...prev, isScrolled: scrollTop > 90 }))}
            onEditingFinished={() => {
              flushPendingEditorChanges();
              finalizeMemoRename();
            }}
            autoFocus={state.isNewlyCreated}
            editorStorageUpdatedAt={state.updatedAtDate ?? (activeMemo?.updatedAt ? new Date(activeMemo.updatedAt) : null)}
            searchPanelOpen={searchPanelOpen}
            onSearchPanelOpenChange={onSearchPanelOpenChange}
            toolbarCollapsed={toolbarCollapsed}
            onToolbarCollapsedChange={onToolbarCollapsedChange}
          />
        )}
        {state.fullContent && viewMode === 'markmap' && (
          <LazyMarkmapView content={state.fullContent} />
        )}
      </div>
      {!isExternalDocument && memoId && (
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
