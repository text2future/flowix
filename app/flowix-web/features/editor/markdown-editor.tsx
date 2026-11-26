import { useDocumentAttachmentContext } from './use-document-attachment-context';
import { useEditorImageSources } from './use-editor-image-sources';
import { useSessionViewChannel } from '@features/workspace/public/session-view-state-api';
import { useDeferredMarkdownSerialization } from './use-deferred-markdown-serialization';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useCallback, type MouseEvent as ReactMouseEvent } from 'react';
import { useShortcutScope } from '@features/shortcuts';
import { useEditorShortcutHandlers } from './use-editor-shortcut-handlers';
import { TableBubbleMenu } from '@features/editor/extensions/table/table-bubble-menu';
import { TableAxisMenu } from '@features/editor/extensions/table/table-axis-menu';
import { SelectionBubbleMenu } from '@features/editor/components/selection-bubble-menu';
import { HeadingOutlineNavigation } from '@features/editor/components/heading-outline-navigation';
import { DragContextMenu } from '@features/editor/components/drag-context-menu';
import { attachLinkHoverTooltip } from '@features/editor/components/link-hover-tooltip';
import { navigateToHeadingAnchor } from '@features/editor/components/heading-anchor-navigation';
import { CustomComponentPickerDialog } from '@features/editor/components/custom-component-picker-dialog';
import {
  registerCustomComponentEditorTarget,
  type NotebookCustomComponent,
} from '@features/editor/public/custom-component-api';
import type { EditorLinkContext } from '@features/editor/editor-link-resolution';
import { pasteClipboardSnapshot } from '@features/editor/extensions/paste-rules';
import type { ClipboardSnapshot } from '@features/editor/extensions/paste-rules/clipboard';
import { SearchReplacePanel } from '@features/editor/components/search-replace-panel';
import { REPLACE_PROTECTED_COMMENTS_META } from '@features/editor/extensions/protected-comment';
import { SKIP_AGENT_THREAD_CARD_CLEANUP_META } from '@features/agent/thread-card/agent-thread-card-extension';
import { translate, useI18n } from '@/lib/i18n';
import { samePath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { markDocumentOpenTrace } from '@/lib/document-open-perf';
import { perfMark } from '@/lib/perf-probe';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { CodeBlockShiki } from '@features/editor/extensions/codeblock-shiki/codeblock-shiki';
import { createMarkdownEditorExtensions, serializeEditorMarkdown } from './markdown-editor-extensions';
import {
  createEmptyParagraph,
  focusEmptyParagraphAfterMedia,
  getEditableBodyStart,
  isBlankEditorDocument,
} from './editor-body-navigation';
import { attachEditorViewRecovery } from './editor-view-recovery';
import { focusTerminalBlockGap } from './extensions/block-gap-cursor';
import { isSlashMenuOpen } from './extensions/slash-menu';
import { normalizeTaskItemPlaceholders, resetEditorHistory } from './editor-document-reset';
import { useSearchPanelState } from './use-search-panel-state';

import type { MarkdownEditorProps, MarkdownEditorHandle, PendingExternalContent } from './markdown-editor-types';
export type { MarkdownEditorHandle } from './markdown-editor-types';

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor({
  ownerPath,
  workspaceHost = 'column-1',
  getAttachmentContext,
  propertyTargetId,
  onPropertyAreaHoverChange,
  onViewSourceMode,
  transitionId = null,
  content,
  editable = true,
  placeholder,
  onChange,
  onDirty,
  className,
  onEditorScroll,
  autoFocus = false,
  onBeforeCreate,
  searchPanelOpen = false,
  onSearchPanelOpenChange,
  onEditingFinished,
  onFocusTitle,
  onAppendToTitle,
  linkContext,
  imageContext,
  header,
}, ref) {
  const { t } = useI18n();
  const resolvedPlaceholder = placeholder || t('editor.placeholder');
  // placeholder 是 mount effect 的输入字符串，但本身不应成为 mount 的依赖：
  // i18n 切换会让 resolvedPlaceholder 重新生成，导致 Editor 被 destroy→重建，
  // 重建间隙各 extension 读 view.dom 触发 "editor view is not available"。
  // 这里把最新值放在 ref 里：mount 时读取，placeholder 回调始终拿最新值；
  // 运行时通过下面的同步 effect dispatch meta 触发重新装饰。
  const resolvedPlaceholderRef = useRef(resolvedPlaceholder);
  resolvedPlaceholderRef.current = resolvedPlaceholder;
  // The channel already scopes state by session and navigation entry.
  const recovery = useSessionViewChannel('markdown');
  const recoveryChannelRef = useRef(recovery);
  recoveryChannelRef.current = recovery;
  const viewRecoveryRef = useRef<ReturnType<typeof attachEditorViewRecovery> | null>(null);
  const elementRef = useRef<HTMLDivElement>(null);
  const editorMountRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const [editorInstance, setEditorInstance] = useState<Editor | null>(null);
  const [componentPickerRequest, setComponentPickerRequest] = useState<{
    editor: Editor;
    notebookId: string;
    notebookPath: string;
  } | null>(null);
  const [isSearchPanelOpen, handleSearchPanelOpenChange] = useSearchPanelState(
    searchPanelOpen,
    onSearchPanelOpenChange,
  );
  const firstFrameTraceRef = useRef<number | null>(null);
  const onEditorScrollRef = useRef(onEditorScroll);
  const contentRef = useRef(content);
  const isApplyingExternalContentRef = useRef(false);
  const isComposingRef = useRef(false);
  const localEditVersionRef = useRef(0);
  const pendingExternalContentRef = useRef<PendingExternalContent | null>(null);
  const onChangeRef = useRef(onChange);
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  const onEditingFinishedRef = useRef(onEditingFinished);
  const onFocusTitleRef = useRef(onFocusTitle);
  const onAppendToTitleRef = useRef(onAppendToTitle);
  const editableRef = useRef(editable);
  // 链接导航上下文走 ref：mount effect 不因文档路径变化重建编辑器，
  // 点击时始终读取最新值。
  const linkContextRef = useRef<EditorLinkContext | undefined>(linkContext);
  const imageContextRef = useRef(imageContext);
  onEditorScrollRef.current = onEditorScroll;
  onChangeRef.current = onChange;
  onEditingFinishedRef.current = onEditingFinished;
  onFocusTitleRef.current = onFocusTitle;
  onAppendToTitleRef.current = onAppendToTitle;
  editableRef.current = editable;
  linkContextRef.current = linkContext;
  imageContextRef.current = imageContext;

  useEditorImageSources(editorRef, imageContext);

  const {
    getContext: getCurrentAttachmentContext,
    getOwnerPath: getCurrentAttachmentOwnerPath,
    getDocumentPath: getCurrentDocumentPath,
  } = useDocumentAttachmentContext(ownerPath, getAttachmentContext);

  const openComponentPicker = useCallback((editor: Editor) => {
    const context = getCurrentAttachmentContext();
    if (!context.notebookId || !context.rootPath) {
      toast.error(translate(getCurrentAppLanguage(), 'editor.slash.componentRequiresNotebook'));
      return;
    }
    setComponentPickerRequest({
      editor,
      notebookId: context.notebookId,
      notebookPath: context.rootPath,
    });
  }, [getCurrentAttachmentContext]);

  const insertPickedComponent = useCallback((component: NotebookCustomComponent): boolean => {
    const request = componentPickerRequest;
    if (!request || request.editor !== editorRef.current || request.editor.isDestroyed || !request.editor.isEditable) {
      return false;
    }
    if (getCurrentAttachmentContext().notebookId !== request.notebookId) return false;
    return request.editor.chain().focus().insertCustomComponent(component).run();
  }, [componentPickerRequest, getCurrentAttachmentContext]);

  const {
    pendingDirtyRef: pendingSerializeDirtyRef,
    clearTimer: clearSerializeTimer,
    flush: serializePendingChanges,
    schedule: schedulePendingSerialization,
  } = useDeferredMarkdownSerialization({
    editorRef,
    contentRef,
    isComposingRef,
    onChangeRef,
    onDirtyRef,
  });

  const logEditorPerf = useCallback((label: string, startedAt: number, meta?: Record<string, unknown>) => {
    console.info('[perf:open-doc]', label, {
      elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
      contentChars: contentRef.current.length,
      ...meta,
    });
    markDocumentOpenTrace(transitionId, `editor:${label}`, {
      contentChars: contentRef.current.length,
      stageElapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
      ...meta,
    });
  }, [transitionId]);

  // 注册 'editor' scope — 挂载期间 editor.undo / editor.redo 生效,
  // 卸载后 pop, 防止在 memo 列表/弹窗里按 ⌘Z 误触发。
  useShortcutScope('editor');

  const findScrollable = useCallback((el: Element): HTMLElement | null => {
    const style = window.getComputedStyle(el);
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
      return el as HTMLElement;
    }
    for (const child of Array.from(el.children)) {
      const found = findScrollable(child);
      if (found) return found;
    }
    return null;
  }, []);

  const applyExternalContent = useCallback((nextContent: string) => {
    const startedAt = performance.now();
    const editor = editorRef.current;
    if (!editor || nextContent === contentRef.current) {
      return;
    }

    // A local edit can reach the document buffer before contentRef is updated
    // by the debounced serializer (notably after an async image upload). If
    // the incoming content is already exactly what ProseMirror currently
    // serializes, it is only a reconciliation echo. Calling setContent here
    // would unnecessarily destroy the editor's history and make the previous
    // paste appear non-undoable.
    const currentEditorContent = serializeEditorMarkdown(editor, getCurrentDocumentPath());
    if (nextContent === currentEditorContent) {
      contentRef.current = nextContent;
      return;
    }

    clearSerializeTimer();
    pendingSerializeDirtyRef.current = false;

    const selection = editor.state.selection;
    const scrollEl = elementRef.current ? findScrollable(elementRef.current) : null;
    const scrollTop = scrollEl?.scrollTop ?? 0;
    const scrollLeft = scrollEl?.scrollLeft ?? 0;

    contentRef.current = nextContent;
    isApplyingExternalContentRef.current = true;
    try {
      editor
        .chain()
        .setMeta(SKIP_AGENT_THREAD_CARD_CLEANUP_META, true)
        .setMeta(REPLACE_PROTECTED_COMMENTS_META, true)
        .setMeta('addToHistory', false)
        .setContent(nextContent, { contentType: 'markdown', emitUpdate: false })
        .run();
      normalizeTaskItemPlaceholders(editor);
      resetEditorHistory(editor);
    } finally {
      isApplyingExternalContentRef.current = false;
    }
    logEditorPerf('MarkdownEditor:setContent', startedAt, {
      nextChars: nextContent.length,
    });
    perfMark('editor-apply-external-ms', performance.now() - startedAt, {
      chars: nextContent.length,
    });

    const docSize = editor.state.doc.content.size;
    const from = Math.min(selection.from, docSize);
    const to = Math.min(selection.to, docSize);
    editor.commands.setTextSelection({ from, to });
    if (scrollEl) {
      scrollEl.scrollTop = scrollTop;
      scrollEl.scrollLeft = scrollLeft;
    }
  }, [clearSerializeTimer, findScrollable, getCurrentDocumentPath, logEditorPerf, pendingSerializeDirtyRef]);

  const focusBodyStart = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed) return;
    // A metadata-only note has no text position until its body is created.
    const { block, position } = getEditableBodyStart(editor);
    if (!block && editor.isEditable) {
      editor.view.dispatch(editor.state.tr.insert(position, createEmptyParagraph(editor)));
    }
    // The frontmatter protection plugin corrects `focus('start')` to the
    // first editable position when a tags/property row is present.
    editor.commands.focus('start');
  }, []);

  const handleEditorSurfaceMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !editableRef.current) return;

    const editor = editorRef.current;
    const editorMount = editorMountRef.current;
    if (!editor || editor.isDestroyed || !editorMount) return;
    if (focusTerminalBlockGap(editor.view, event.nativeEvent)) return;
    if (!isBlankEditorDocument(editor)) {
      return;
    }

    // ProseMirror owns clicks on its descendants and can place the caret from
    // the pointer coordinates. For a blank document, handle the whole editor
    // surface explicitly because a click below the empty paragraph can still
    // produce no selection in WebKit/WebView.
    const target = event.target;
    if (target !== event.currentTarget && !(target instanceof Node && editorMount.contains(target))) {
      return;
    }

    focusBodyStart();
    event.preventDefault();
  }, [focusBodyStart]);

  const moveTitleToBody = useCallback((trailingContent: string) => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed || !editor.isEditable) return;

    const { position } = getEditableBodyStart(editor);
    const text = trailingContent.trim().length > 0 ? trailingContent : undefined;
    const tr = editor.state.tr.insert(position, createEmptyParagraph(editor, text));
    // The moved title tail is the existing content at the new body start;
    // keep the caret before it so typing continues at the split point.
    const cursorPosition = position + 1;
    tr.setSelection(TextSelection.near(tr.doc.resolve(cursorPosition), 1));
    tr.scrollIntoView();
    editor.view.dispatch(tr);
    editor.view.focus();
  }, []);

  const pasteToBody = useCallback((snapshot: ClipboardSnapshot) => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed || !editor.isEditable) return false;

    const { block, position } = getEditableBodyStart(editor);
    if (!block) {
      const tr = editor.state.tr
        .insert(position, createEmptyParagraph(editor))
        .setMeta('addToHistory', false);
      tr.setSelection(TextSelection.near(tr.doc.resolve(position + 1), 1));
      editor.view.dispatch(tr);
    } else {
      const selection = TextSelection.near(
        editor.state.doc.resolve(Math.min(position + 1, editor.state.doc.content.size)),
        1,
      );
      editor.view.dispatch(editor.state.tr.setSelection(selection));
    }

    return pasteClipboardSnapshot(editor, snapshot, getCurrentAttachmentOwnerPath());
  }, [getCurrentAttachmentOwnerPath]);

  const handleBackspaceAtBodyStart = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed || !editor.isEditable) return false;

    const { block, blockIndex, position } = getEditableBodyStart(editor);
    const { selection } = editor.state;
    if (
      !block
      || !selection.empty
      || !selection.$from.parent.isTextblock
      || selection.from !== position + 1
      || (block.type.name !== 'paragraph' && block.type.name !== 'heading')
    ) {
      return false;
    }

    const title = block.textContent.trim();
    if (!title) {
      // An empty paragraph created by title-Enter is still part of the
      // title/body boundary. Backspace should cross that boundary instead of
      // being swallowed by the default paragraph handler.
      if (blockIndex < editor.state.doc.childCount - 1) {
        const tr = editor.state.tr.delete(position, position + block.nodeSize);
        tr.scrollIntoView();
        editor.view.dispatch(tr);
      }
      onFocusTitleRef.current?.();
      return true;
    }

    const removeMergedBodyBlock = () => {
      if (editor.isDestroyed) return;
      const currentBlock = editor.state.doc.nodeAt(position);
      // The async external-file rename may finish after another transaction.
      // Only remove the exact block that was offered to the title.
      if (
        !currentBlock
        || currentBlock.type !== block.type
        || currentBlock.textContent.trim() !== title
      ) return;
      const tr = blockIndex === editor.state.doc.childCount - 1
        ? editor.state.tr.replaceWith(
            position,
            position + currentBlock.nodeSize,
            createEmptyParagraph(editor),
          )
        : editor.state.tr.delete(position, position + currentBlock.nodeSize);
      tr.scrollIntoView();
      editor.view.dispatch(tr);
    };

    const appendResult = onAppendToTitleRef.current?.(title);
    if (appendResult instanceof Promise) {
      void appendResult.then((accepted) => {
        if (accepted) removeMergedBodyBlock();
      }, () => undefined);
      return true;
    }
    if (appendResult === false) return true;
    removeMergedBodyBlock();
    return true;
  }, []);

  useImperativeHandle(ref, () => ({
    flushPendingChanges: () => serializePendingChanges({ force: true }),
    commitPropertyDraft: () => {
      editorRef.current?.view.dom.dispatchEvent(new Event('flowix:editor-flush-drafts'));
    },
    getCurrentMarkdown: () => {
      if (pendingSerializeDirtyRef.current) {
        return serializePendingChanges({ force: true }) ?? contentRef.current;
      }
      return contentRef.current;
    },
    // 标题锚点是语义定位（GitHub slug），富文本视图可直接滚动，无需切源码。
    revealHeadingAnchor: (anchor: string): boolean | null => {
      const editor = editorRef.current;
      if (!editor) return null;
      return navigateToHeadingAnchor(editor.view.dom, `#${anchor}`);
    },
    focusStart: focusBodyStart,
    moveTitleToBody,
    pasteToBody,
  }), [focusBodyStart, moveTitleToBody, pasteToBody, pendingSerializeDirtyRef, serializePendingChanges]);

  useEffect(() => {
    if (!editorMountRef.current) {
      return;
    }
    const mountStartedAt = performance.now();
    const initialContent = content;
    contentRef.current = initialContent;

    const constructorStartedAt = performance.now();
    // 扩展集构建单独计时：定位 `new Editor` 大耗时分段（扩展/schema 构建 vs
    // marked 解析 + ProseMirror doc 构建）。
    const extensionsBuildStartedAt = performance.now();
    const editorExtensions = createMarkdownEditorExtensions({
      ownerPath,
      getAttachmentContext: getCurrentAttachmentContext,
      getImageContext: () => imageContextRef.current,
      getLinkContext: () => linkContextRef.current,
      propertyTargetId,
      onPropertyAreaHoverChange,
      onViewSourceMode,
      onOpenComponentPicker: openComponentPicker,
      transitionId,
      workspaceHost,
      getPlaceholder: () => resolvedPlaceholderRef.current,
    }, CodeBlockShiki);
    logEditorPerf('MarkdownEditor:extensions-build', extensionsBuildStartedAt, {
      contentChars: initialContent.length,
    });
    const editor = new Editor({
      // 两步创建（不带 element 构造 + 显式 mount）：把 `new Editor` 的耗时
      // 拆成「markdown 解析 + PM doc 构建」与「DOM 渲染 + node views +
      // plugin views」两段。mount 与 tiptap 自动挂载路径完全等价。
      // 修复跨多块复制时多余空行：ProseMirror 默认在块间插入 `\n\n`，
      // 改成单个 `\n`，粘贴到纯文本目标时块间只保留一个换行。
      editorProps: {
        // The formatting toolbar overlays the bottom of the scroller. Start
        // scrolling about three lines early and keep the caret above it.
        // Threshold triggers the scroll; margin controls its destination.
        scrollThreshold: { top: 0, right: 0, bottom: 96, left: 0 },
        scrollMargin: { top: 5, right: 5, bottom: 96, left: 5 },
        attributes: editable
          ? {}
          : {
              tabindex: '0',
              'aria-readonly': 'true',
            },
        clipboardTextSerializer(content) {
          return content.content.textBetween(0, content.content.size, '\n', '\n');
        },
        handleDOMEvents: {
          mousedown: (view, event) => {
            if (focusEmptyParagraphAfterMedia(view, event)) return true;
            return false;
          },
        },
        handleKeyDown: (view, event) => {
          if (isSlashMenuOpen(view)) return false;
          if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) {
            return false;
          }

          const { selection } = editor.state;
          if (!(selection instanceof TextSelection) || !selection.empty) return false;

          if ((event.key === 'ArrowUp' || event.key === 'ArrowLeft')
            && selection.from === getEditableBodyStart(editor).position + 1) {
            event.preventDefault();
            onFocusTitleRef.current?.();
            return true;
          }

          // Boundary navigation remains available in a read-only host. Only
          // mutations (such as promoting the first body line) require the
          // current editable state.
          if (!editableRef.current) return false;

          if (event.key === 'Backspace' && handleBackspaceAtBodyStart()) {
            event.preventDefault();
            return true;
          }

          return false;
        },
      },
      extensions: editorExtensions,
      content: initialContent,
      contentType: 'markdown',
      editable,
      autofocus: !recoveryChannelRef.current?.read() && autoFocus ? 'end' : false,
      onUpdate: ({ transaction }) => {
        if (isApplyingExternalContentRef.current || !transaction.docChanged) return;
        localEditVersionRef.current += 1;
        pendingSerializeDirtyRef.current = true;
        schedulePendingSerialization();
      },
      // onBlur 仍需要触发 onEditingFinished (最终化重命名等); toolbar 显隐
      // 不再依赖 focus, 去掉 onFocus 以避免无谓的 setState。
      onBlur: ({ event }) => {
        const nextTarget = event.relatedTarget as HTMLElement | null;
        if (nextTarget?.closest?.('.agent-thread-card')) return;
        serializePendingChanges({ force: true });
        onEditingFinishedRef.current?.();
      },
    });
    logEditorPerf('MarkdownEditor:constructor', constructorStartedAt, {
      initialChars: initialContent.length,
    });
    // DOM 渲染段：node views + ProseMirror doc → DOM + plugin views（含 shiki init）。
    const domMountStartedAt = performance.now();
    editor.mount(editorMountRef.current);
    logEditorPerf('MarkdownEditor:dom-mount', domMountStartedAt, {
      contentChars: initialContent.length,
    });
    const placeholderNormalizationStartedAt = performance.now();
    normalizeTaskItemPlaceholders(editor);
    logEditorPerf('MarkdownEditor:normalizeTaskPlaceholders', placeholderNormalizationStartedAt);
    const documentScanStartedAt = performance.now();
    let codeBlockCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'codeBlock') codeBlockCount += 1;
    });
    logEditorPerf('MarkdownEditor:documentScan', documentScanStartedAt, {
      docSize: editor.state.doc.content.size,
      codeBlockCount,
    });
    logEditorPerf('MarkdownEditor:create', mountStartedAt, {
      initialChars: initialContent.length,
      docSize: editor.state.doc.content.size,
      codeBlockCount,
    });

    onBeforeCreate?.(editor);
    editor.getMarkdown = () => serializeEditorMarkdown(editor, getCurrentDocumentPath());
    editorRef.current = editor;
    setEditorInstance(editor);
    const editorDom = editor.view.dom;
    const handleCompositionStart = () => {
      isComposingRef.current = true;
    };
    const handleCompositionEnd = () => {
      isComposingRef.current = false;
      if (pendingSerializeDirtyRef.current) {
        schedulePendingSerialization();
      }
      window.requestAnimationFrame(() => {
        window.setTimeout(() => {
          const pending = pendingExternalContentRef.current;
          if (!pending) return;
          pendingExternalContentRef.current = null;
          if (pending.localEditVersion !== localEditVersionRef.current) return;
          applyExternalContent(pending.content);
        }, 0);
      });
    };
    editorDom.addEventListener('compositionstart', handleCompositionStart);
    editorDom.addEventListener('compositionend', handleCompositionEnd);

    const detachLinkHoverTooltip = attachLinkHoverTooltip(
      editor,
      editorMountRef.current,
      () => linkContextRef.current,
    );

    const scrollEl = elementRef.current ? findScrollable(elementRef.current) : null;
    if (scrollEl) {
      const handleScroll = () => {
        viewRecoveryRef.current?.schedule();
        onEditorScrollRef.current?.(scrollEl.scrollTop);
      };

      scrollEl.addEventListener('scroll', handleScroll, { passive: true });

      return () => {
        viewRecoveryRef.current?.dispose();
        viewRecoveryRef.current = null;
        serializePendingChanges({ force: true });
        editorDom.removeEventListener('compositionstart', handleCompositionStart);
        editorDom.removeEventListener('compositionend', handleCompositionEnd);
        scrollEl.removeEventListener('scroll', handleScroll);
        detachLinkHoverTooltip();
        editor.destroy();
        editorRef.current = null;
        setEditorInstance(null);
      };
    }

    return () => {
      viewRecoveryRef.current?.dispose();
      viewRecoveryRef.current = null;
      serializePendingChanges({ force: true });
      editorDom.removeEventListener('compositionstart', handleCompositionStart);
      editorDom.removeEventListener('compositionend', handleCompositionEnd);
      detachLinkHoverTooltip();
      editor.destroy();
      editorRef.current = null;
      setEditorInstance(null);
    };
  }, [
    applyExternalContent,
    findScrollable,
    getCurrentAttachmentOwnerPath,
    getCurrentAttachmentContext,
    openComponentPicker,
    handleBackspaceAtBodyStart,
    pendingSerializeDirtyRef,
    schedulePendingSerialization,
    serializePendingChanges,
  ]);

  // Recovery is an adapter to a live editor, not an editor lifecycle input.
  useLayoutEffect(() => {
    if (!editorInstance || editorInstance.isDestroyed) return;
    const scrollEl = elementRef.current ? findScrollable(elementRef.current) : null;
    const binding = attachEditorViewRecovery(editorInstance, recovery, scrollEl);
    viewRecoveryRef.current = binding;
    return () => {
      binding.dispose();
      if (viewRecoveryRef.current === binding) viewRecoveryRef.current = null;
    };
  }, [editorInstance, recovery, findScrollable]);

  useLayoutEffect(() => {
    if (!editorInstance || transitionId === null || firstFrameTraceRef.current === transitionId) {
      return;
    }

    firstFrameTraceRef.current = transitionId;
    markDocumentOpenTrace(transitionId, 'editor:react-commit', {
      domNodes: editorMountRef.current?.querySelectorAll('*').length ?? 0,
    });

    let firstFrameId: number | null = null;
    let secondFrameId: number | null = null;
    const scheduleFrame = (callback: FrameRequestCallback) => {
      if (typeof requestAnimationFrame === 'function') {
        return requestAnimationFrame(callback);
      }
      return window.setTimeout(() => callback(performance.now()), 16);
    };

    firstFrameId = scheduleFrame(() => {
      secondFrameId = scheduleFrame(() => {
        markDocumentOpenTrace(transitionId, 'editor:first-visible-frame', {
          domNodes: editorMountRef.current?.querySelectorAll('*').length ?? 0,
        });
      });
    });

    return () => {
      if (firstFrameId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(firstFrameId);
      }
      if (secondFrameId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(secondFrameId);
      }
    };
  }, [editorInstance, transitionId]);

  useEffect(() => {
    const editor = editorInstance;
    if (!editor || editor.isDestroyed || !editable) return;
    const context = getCurrentAttachmentContext();
    const notebookPath = context.rootPath;
    const documentPath = getCurrentDocumentPath();
    if (!notebookPath || !documentPath) return;

    return registerCustomComponentEditorTarget({
      notebookPath,
      documentPath,
      insert(component: NotebookCustomComponent) {
        if (editor.isDestroyed || !editor.isEditable) return false;
        const currentContext = getCurrentAttachmentContext();
        const currentDocumentPath = getCurrentDocumentPath();
        if (!currentContext.rootPath || !samePath(currentContext.rootPath, notebookPath)) return false;
        if (!currentDocumentPath || !samePath(currentDocumentPath, documentPath)) return false;
        return editor.chain().focus().insertCustomComponent(component).run();
      },
    });
  }, [editorInstance, editable, getCurrentAttachmentContext, getCurrentDocumentPath, ownerPath]);

  // 语言切换时，placeholder 回调会读取最新的 ref；dispatch 一条带
  // 'placeholder-update' meta 的空事务触发重新装饰。不能把回调改回字符串，
  // 否则视频/图片 NodeSelection 位于空段落边界时的抑制逻辑会丢失。
  // 不重建 Editor — 重建会让 view.dom 瞬间失效，extension 子树的 unmount
  // 路径里读 view.dom 会触发 "The editor view is not available"。
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed) return;
    const placeholderExt = editor.extensionManager.extensions.find(
      (ext) => ext.name === 'placeholder',
    );
    if (!placeholderExt) return;
    editor.view.dispatch(
      editor.state.tr.setMeta('placeholder-update', true),
    );
  }, [resolvedPlaceholder]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (editor && pendingSerializeDirtyRef.current) {
      serializePendingChanges({ force: true });
      return;
    }
    if (!editor || editor.isDestroyed || content === contentRef.current) {
      return;
    }

    const viewState = editor.view as typeof editor.view & { composing?: boolean };
    if (isComposingRef.current || viewState.composing) {
      pendingExternalContentRef.current = {
        content,
        localEditVersion: localEditVersionRef.current,
      };
      return;
    }

    pendingExternalContentRef.current = null;
    applyExternalContent(content);
  }, [content, applyExternalContent, pendingSerializeDirtyRef, serializePendingChanges]);

  useLayoutEffect(() => {
    if (editorRef.current) {
      if (editorRef.current.isEditable !== editable) {
        editorRef.current.view.dom.dispatchEvent(new Event('flowix:editor-flush-drafts'));
      }
      editorRef.current.setEditable(editable, false);
      const editorDom = editorRef.current.view.dom;
      editorDom.dispatchEvent(new Event('flowix:editor-editability-change'));
      if (editable) {
        editorDom.removeAttribute('tabindex');
        editorDom.removeAttribute('aria-readonly');
      } else {
        editorDom.setAttribute('tabindex', '0');
        editorDom.setAttribute('aria-readonly', 'true');
      }
    }
  }, [editable]);

  useEditorShortcutHandlers(editorRef, handleSearchPanelOpenChange);

  const editorContentChildren = (
    <>
      {editorInstance && <HeadingOutlineNavigation editor={editorInstance} />}
      {header}
      <div ref={editorMountRef} className="editor-document-body" />
      {editorInstance && <DragContextMenu editor={editorInstance} />}
      {/* 两个漂浮菜单常驻挂载: 元素的显隐与定位由它们自己按编辑器状态决定,
       * 不靠滚动时卸载 (旧实现会因为 React 门户与 tiptap 的 DOM 归属错位,
       * 在 body 里留下没有内容的 .selection-bubble-menu 空壳)。 */}
      {editorInstance && (
        <>
          <TableBubbleMenu editor={editorInstance} />
          <TableAxisMenu editor={editorInstance} />
          <SelectionBubbleMenu editor={editorInstance} />
        </>
      )}
    </>
  );

  return (
    <div className={`markdown-editor ${className || ''}`}>
      {componentPickerRequest && (
        <CustomComponentPickerDialog
          open
          insertMode
          onOpenChange={(open) => {
            if (!open) setComponentPickerRequest(null);
          }}
          notebookPath={componentPickerRequest.notebookPath}
          onInsert={insertPickedComponent}
        />
      )}
      <SearchReplacePanel
        editor={editorRef.current}
        visible={isSearchPanelOpen}
        onClose={() => handleSearchPanelOpenChange(false)}
      />
      <OverlayScrollbar
        className="editor-content-frame"
        scrollerClassName="editor-content"
        scrollerRef={elementRef}
        onMouseDown={handleEditorSurfaceMouseDown}
      >
        {editorContentChildren}
      </OverlayScrollbar>
    </div>
  );
});
