import type { EditorImageContext } from './editor-image-source';
import { useSessionViewChannel } from '@features/workspace/public/session-view-state-api';
import { createLogger } from '@/lib/logger';
import { Editor } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useCallback, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { useShortcutScope, pushHandler } from '@features/shortcuts';
import { TableBubbleMenu } from '@features/editor/extensions/table/table-bubble-menu';
import { EditorToolbar } from '@features/editor/components/editor-toolbar';
import { SelectionBubbleMenu } from '@features/editor/components/selection-bubble-menu';
import { HeadingOutlineNavigation } from '@features/editor/components/heading-outline-navigation';
import { DragContextMenu } from '@features/editor/components/drag-context-menu';
import { attachLinkHoverTooltip } from '@features/editor/components/link-hover-tooltip';
import { navigateToHeadingAnchor } from '@features/editor/components/heading-anchor-navigation';
import type { EditorLinkContext } from '@features/editor/editor-link-resolution';
import { pasteClipboardSnapshot } from '@features/editor/extensions/paste-rules';
import type { ClipboardSnapshot } from '@features/editor/extensions/paste-rules/clipboard';
import { SearchReplacePanel } from '@features/editor/components/search-replace-panel';
import { selectEditableDocumentContent } from '@features/editor/extensions/frontmatter';
import { applyListType } from '@features/editor/extensions/list-transforms';
import { SKIP_AGENT_THREAD_CARD_CLEANUP_META } from '@features/agent/thread-card/agent-thread-card-extension';
import { useI18n } from '@/lib/i18n';
import { markDocumentOpenTrace } from '@/lib/document-open-perf';
import { perfMark } from '@/lib/perf-probe';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import type { WorkspaceColumnId } from '@features/workspace/public/host-api';
import { CodeBlockShiki } from '@features/editor/extensions/codeblock-shiki/codeblock-shiki';
import { createMarkdownEditorExtensions, serializeEditorMarkdown } from './markdown-editor-extensions';
import {
  createEmptyParagraph,
  focusEmptyParagraphAfterMedia,
  getEditableBodyStart,
  isBlankEditorDocument,
} from './editor-body-navigation';
import { attachEditorViewRecovery } from './editor-view-recovery';
import { isSlashMenuOpen } from './extensions/slash-menu';
import { isEmptyMarkdownPlaceholderOnly } from './markdown-normalization';

interface MarkdownEditorProps {
  /** Absolute or notebook-relative path of the note owning editor uploads. */
  ownerPath?: string;
  /** Workspace surface hosting this editor, passed to surface-aware NodeViews. */
  workspaceHost?: WorkspaceColumnId;
  /** Read the current path when an upload starts, including after a rename. */
  getAttachmentOwnerPath?: () => string | undefined;
  getAttachmentNotebookId?: () => string | undefined;
  propertyTargetId?: string;
  onPropertyAreaHoverChange?: (hovered: boolean) => void;
  onViewSourceMode?: () => void;
  transitionId?: number | null;
  content: string;
  /** Pre-parsed Markdown JSON supplied by the large-document worker path. */
  initialParsedContent?: JSONContent;
  editable?: boolean;
  placeholder?: string;
  onChange?: (markdown: string) => void;
  /** Schedule capture on the owning document clock, without serializing on input. */
  onDirty?: () => void;
  className?: string;
  onEditorScroll?: (scrollTop: number) => void;
  autoFocus?: boolean;
  onBeforeCreate?: (editor: Editor) => void;
  // 搜索面板由父组件控制（titlebar 按钮 / Ctrl+F 共享同一开关）
  searchPanelOpen?: boolean;
  onSearchPanelOpenChange?: (open: boolean) => void;
  // Toolbar collapsed — owned by main-layout. Tooltip of the toolbar's visibility
  // is driven purely by this state; the editor no longer tracks focus.
  toolbarCollapsed?: boolean;
  onToolbarCollapsedChange?: (collapsed: boolean) => void;
  onEditingFinished?: () => void;
  /** Move focus from the first editable body block to the title. */
  onFocusTitle?: () => void;
  /** Append the first editable body line to the existing title. */
  /** Return false when the title update was refused; the body block is then preserved. */
  onAppendToTitle?: (title: string) => void | boolean | Promise<boolean>;
  /**
   * Navigation context for in-content links: relative path hrefs resolve
   * against `documentPath` and route through `openLocalPath` (supplied by the
   * document layer). Omitted contexts fall back to the historic web opener.
   */
  linkContext?: EditorLinkContext;
  imageContext?: EditorImageContext;
  /** Content in the document scroller that stays outside ProseMirror. */
  header?: ReactNode;
}

const persistenceLog = createLogger('document:editor');

const SERIALIZE_DEBOUNCE_MS = 200;
const SERIALIZE_IDLE_TIMEOUT_MS = 500;

interface PendingExternalContent {
  content: string;
  localEditVersion: number;
}

export interface MarkdownEditorHandle {
  flushPendingChanges: () => string | null;
  commitPropertyDraft?: () => void;
  getCurrentMarkdown: () => string;
  revealSourceLocation?: (location: { line: number; column?: number }) => { clamped: boolean } | null;
  revealSourceAnchor?: (anchor: string) => boolean | null;
  /** Reveal a GitHub-slug heading anchor in the rich text view (scroll only). */
  revealHeadingAnchor?: (anchor: string) => boolean | null;
  focusStart?: () => void;
  moveTitleToBody?: (trailingContent: string) => void;
  pasteToBody?: (snapshot: ClipboardSnapshot) => boolean;
}


function normalizeTaskItemPlaceholders(editor: Editor): void {
  const { state, view } = editor;
  const deletions: Array<{ from: number; to: number }> = [];

  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'taskItem') return true;

    const firstChild = node.firstChild;
    if (!firstChild || firstChild.type.name !== 'paragraph') return false;
    if (!isEmptyMarkdownPlaceholderOnly(firstChild.textContent)) return false;

    const paragraphPos = pos + 1;
    const from = paragraphPos + 1;
    const to = paragraphPos + firstChild.nodeSize - 1;
    if (from < to) {
      deletions.push({ from, to });
    }

    return false;
  });

  if (deletions.length > 0) {
    // All positions refer to the original document. Applying the ranges from
    // right to left keeps an earlier deletion from shifting a later range.
    const tr = state.tr;
    deletions
      .sort((a, b) => b.from - a.from)
      .forEach(({ from, to }) => tr.delete(from, to));
    tr.setMeta('addToHistory', false);
    view.dispatch(tr);
  }
}

/**
 * An authoritative external document replacement starts a new undo domain.
 * Reusing the existing history plugin would leave steps from the previous
 * document mapped against the replacement. Remove and re-register the same
 * plugin instance so its state is initialized empty without rebuilding the
 * editor view or its NodeViews.
 */
function resetEditorHistory(editor: Editor): void {
  const historyPlugin = editor.state.plugins.find((plugin) => {
    const key = (plugin as unknown as { key?: string }).key;
    return key?.startsWith('history$') === true;
  });
  if (!historyPlugin) return;

  editor.unregisterPlugin('history');
  editor.registerPlugin(historyPlugin);
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor({
  ownerPath,
  workspaceHost = 'column-1',
  getAttachmentOwnerPath,
  getAttachmentNotebookId,
  propertyTargetId,
  onPropertyAreaHoverChange,
  onViewSourceMode,
  transitionId = null,
  content,
  initialParsedContent,
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
  toolbarCollapsed = false,
  onToolbarCollapsedChange,
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
  const recovery = useSessionViewChannel(`markdown:${ownerPath ?? ''}`);
  const elementRef = useRef<HTMLDivElement>(null);
  const editorMountRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const [editorInstance, setEditorInstance] = useState<Editor | null>(null);
  const firstFrameTraceRef = useRef<number | null>(null);
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serializeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serializeIdleCallbackRef = useRef<number | null>(null);
  const onEditorScrollRef = useRef(onEditorScroll);
  const contentRef = useRef(content);
  const initialParsedContentRef = useRef(initialParsedContent);
  initialParsedContentRef.current = initialParsedContent;
  const isApplyingExternalContentRef = useRef(false);
  const isComposingRef = useRef(false);
  const pendingSerializeDirtyRef = useRef(false);
  const localEditVersionRef = useRef(0);
  const pendingExternalContentRef = useRef<PendingExternalContent | null>(null);
  const onChangeRef = useRef(onChange);
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  const onSearchPanelOpenChangeRef = useRef(onSearchPanelOpenChange);
  const onEditingFinishedRef = useRef(onEditingFinished);
  const onFocusTitleRef = useRef(onFocusTitle);
  const onAppendToTitleRef = useRef(onAppendToTitle);
  const editableRef = useRef(editable);
  const attachmentOwnerRef = useRef({ ownerPath, getAttachmentOwnerPath, getAttachmentNotebookId });
  // 链接导航上下文走 ref：mount effect 不因文档路径变化重建编辑器，
  // 点击时始终读取最新值。
  const linkContextRef = useRef<EditorLinkContext | undefined>(linkContext);
  const imageContextRef = useRef(imageContext);
  onEditorScrollRef.current = onEditorScroll;
  onChangeRef.current = onChange;
  onSearchPanelOpenChangeRef.current = onSearchPanelOpenChange;
  onEditingFinishedRef.current = onEditingFinished;
  onFocusTitleRef.current = onFocusTitle;
  onAppendToTitleRef.current = onAppendToTitle;
  editableRef.current = editable;
  attachmentOwnerRef.current = { ownerPath, getAttachmentOwnerPath, getAttachmentNotebookId };
  linkContextRef.current = linkContext;
  imageContextRef.current = imageContext;

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (editor && !editor.isDestroyed) {
      editor.storage.image.refreshSources();
    }
  }, [imageContext?.documentPath, imageContext?.scopePath]);

  const getCurrentAttachmentOwnerPath = useCallback(() => {
    const current = attachmentOwnerRef.current;
    return current.getAttachmentOwnerPath ? current.getAttachmentOwnerPath() : current.ownerPath;
  }, []);
  const getCurrentAttachmentNotebookId = useCallback(() => attachmentOwnerRef.current.getAttachmentNotebookId?.(), []);

  const clearSerializeTimer = useCallback(() => {
    if (serializeTimerRef.current) {
      clearTimeout(serializeTimerRef.current);
      serializeTimerRef.current = null;
    }
    if (serializeIdleCallbackRef.current !== null) {
      const idleWindow = window as Window & {
        cancelIdleCallback?: (handle: number) => void;
      };
      idleWindow.cancelIdleCallback?.(serializeIdleCallbackRef.current);
      serializeIdleCallbackRef.current = null;
    }
  }, []);

  const serializePendingChanges = useCallback((options?: {
    force?: boolean;
  }) => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed || !pendingSerializeDirtyRef.current) {
      return null;
    }

    const viewState = editor.view as typeof editor.view & { composing?: boolean };
    if (!options?.force && (isComposingRef.current || viewState.composing)) {
      return null;
    }

    clearSerializeTimer();
    pendingSerializeDirtyRef.current = false;

    const serializationStarted = performance.now();
    const markdown = editor.getMarkdown();
    const serializationMs = performance.now() - serializationStarted;
    if (serializationMs > 50) persistenceLog.info('slow serialization', { elapsedMs: serializationMs, characters: markdown.length });
    perfMark('editor-serialize-ms', serializationMs, { chars: markdown.length });
    if (markdown === contentRef.current) {
      return null;
    }

    contentRef.current = markdown;
    onChangeRef.current?.(markdown);
    return markdown;
  }, [clearSerializeTimer]);

  const schedulePendingSerialization = useCallback(() => {
    if (onDirtyRef.current) { onDirtyRef.current(); return; }
    // Wait for a short quiet period before serializing. The previous
    // implementation started a new full-document serialization every 200ms
    // during continuous typing, even though only the latest content can be
    // observed by the document buffer and autosave queue.
    clearSerializeTimer();
    const editor = editorRef.current;
    const viewState = editor?.view as (Editor['view'] & { composing?: boolean }) | undefined;
    if (isComposingRef.current || viewState?.composing) {
      serializeTimerRef.current = null;
      return;
    }
    serializeTimerRef.current = setTimeout(() => {
      serializeTimerRef.current = null;
      const idleWindow = window as Window & {
        requestIdleCallback?: (
          callback: (deadline: IdleDeadline) => void,
          options?: { timeout: number },
        ) => number;
      };
      if (!idleWindow.requestIdleCallback) {
        serializePendingChanges();
        return;
      }

      serializeIdleCallbackRef.current = idleWindow.requestIdleCallback((_deadline) => {
        serializeIdleCallbackRef.current = null;
        serializePendingChanges();
      }, { timeout: SERIALIZE_IDLE_TIMEOUT_MS });
    }, SERIALIZE_DEBOUNCE_MS);
  }, [clearSerializeTimer, serializePendingChanges]);

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
    const currentEditorContent = serializeEditorMarkdown(editor);
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
  }, [clearSerializeTimer, findScrollable, logEditorPerf]);

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
    if (!editor || editor.isDestroyed || !editorMount || !isBlankEditorDocument(editor)) {
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
  }), [focusBodyStart, moveTitleToBody, pasteToBody, serializePendingChanges]);

  useEffect(() => {
    if (!editorMountRef.current) {
      return;
    }
    const mountStartedAt = performance.now();
    const initialContent = content;
    const parsedContent = initialParsedContentRef.current;
    contentRef.current = initialContent;

    const constructorStartedAt = performance.now();
    const editor = new Editor({
      element: editorMountRef.current,
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
      extensions: createMarkdownEditorExtensions({
        ownerPath,
        getOwnerPath: getCurrentAttachmentOwnerPath,
        getImageContext: () => imageContextRef.current,
        getAttachmentNotebookId: getCurrentAttachmentNotebookId,
        propertyTargetId,
        onPropertyAreaHoverChange,
        onViewSourceMode,
        transitionId,
        workspaceHost,
        getPlaceholder: () => resolvedPlaceholderRef.current,
      }, CodeBlockShiki),
      content: parsedContent ?? initialContent,
      contentType: parsedContent ? 'json' : 'markdown',
      editable,
      autofocus: !recovery?.read() && autoFocus ? 'end' : false,
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
      initialContentType: parsedContent ? 'json' : 'markdown',
    });

    onBeforeCreate?.(editor);
    editor.getMarkdown = () => serializeEditorMarkdown(editor);
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
    const viewRecovery = attachEditorViewRecovery(editor, recovery, scrollEl);
    if (scrollEl) {
      const handleScroll = () => {
        viewRecovery.schedule();
        setIsScrolling(true);
        if (scrollTimerRef.current) {
          clearTimeout(scrollTimerRef.current);
        }
        scrollTimerRef.current = setTimeout(() => {
          setIsScrolling(false);
        }, 150);
        onEditorScrollRef.current?.(scrollEl.scrollTop);
      };

      scrollEl.addEventListener('scroll', handleScroll, { passive: true });

      return () => {
        viewRecovery.dispose();
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
      viewRecovery.dispose();
      serializePendingChanges({ force: true });
      editorDom.removeEventListener('compositionstart', handleCompositionStart);
      editorDom.removeEventListener('compositionend', handleCompositionEnd);
      detachLinkHoverTooltip();
      editor.destroy();
      editorRef.current = null;
      setEditorInstance(null);
    };
  }, [
    recovery,
    applyExternalContent,
    findScrollable,
    getCurrentAttachmentOwnerPath,
    getCurrentAttachmentNotebookId,
    handleBackspaceAtBodyStart,
    schedulePendingSerialization,
    serializePendingChanges,
  ]);

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
  }, [content, applyExternalContent, serializePendingChanges]);

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

  // 把 editor.find / editor.undo / editor.redo 以及块级格式 action 的实例级
  // handler 注册到全局 handler-registry。组件卸载时 pop 走 — 命令面板
  // (Phase 3) 仍能从 registry 读到 action 列表, 但 run 落到空栈, 行为退化
  // 为 no-op。编辑器命令附带真实 DOM focus 检查，避免多列同时挂载时把
  // 命令发给最后挂载而非当前活动的编辑器。
  //
  useEffect(() => {
    const editorIsFocused = () => {
      const editor = editorRef.current;
      if (!editor || editor.isDestroyed) return false;
      try {
        return editor.view.hasFocus();
      } catch {
        return false;
      }
    };
    const pops = [
      pushHandler('editor.selectAll', () => {
        const editor = editorRef.current;
        if (!editor) return false;
        return selectEditableDocumentContent(editor);
      }, { isActive: editorIsFocused }),
      pushHandler('editor.find', () => {
        onSearchPanelOpenChangeRef.current?.(true);
      }, { isActive: editorIsFocused }),
      pushHandler('editor.undo', () => {
        return editorRef.current?.commands.undo() ?? false;
      }, { isActive: editorIsFocused }),
      pushHandler('editor.redo', () => {
        return editorRef.current?.commands.redo() ?? false;
      }, { isActive: editorIsFocused }),
      // 块元素切换 (⌘1-4 / ⌘0 / ⌘⇧7-9) — 与 drag-context-menu items.tsx
      // 里的菜单项一一对应, 走同一组 Tiptap chain().focus().toggleXxx() 命令。
      // focus() 先调用是为了: 用户可能从标题输入框等地方按快捷键,
      // focus 保证命令落到编辑器内的当前 block。
      pushHandler('editor.setHeading1', () => {
        editorRef.current?.chain().focus().toggleHeading({ level: 1 }).run();
      }, { isActive: editorIsFocused }),
      pushHandler('editor.setHeading2', () => {
        editorRef.current?.chain().focus().toggleHeading({ level: 2 }).run();
      }, { isActive: editorIsFocused }),
      pushHandler('editor.setHeading3', () => {
        editorRef.current?.chain().focus().toggleHeading({ level: 3 }).run();
      }, { isActive: editorIsFocused }),
      pushHandler('editor.setHeading4', () => {
        editorRef.current?.chain().focus().toggleHeading({ level: 4 }).run();
      }, { isActive: editorIsFocused }),
      pushHandler('editor.setParagraph', () => {
        editorRef.current?.chain().focus().setParagraph().run();
      }, { isActive: editorIsFocused }),
      pushHandler('editor.toggleBulletList', () => {
        if (editorRef.current) applyListType(editorRef.current, 'bulletList');
      }, { isActive: editorIsFocused }),
      pushHandler('editor.toggleOrderedList', () => {
        if (editorRef.current) applyListType(editorRef.current, 'orderedList');
      }, { isActive: editorIsFocused }),
      pushHandler('editor.toggleTaskList', () => {
        if (editorRef.current) applyListType(editorRef.current, 'taskList');
      }, { isActive: editorIsFocused }),
    ];
    return () => {
      for (const pop of pops) pop();
    };
  }, []);

  const editorContentChildren = (
    <>
      {editorInstance && <HeadingOutlineNavigation editor={editorInstance} />}
      {header}
      <div ref={editorMountRef} className="editor-document-body" />
      {editorInstance && <DragContextMenu editor={editorInstance} />}
      {editorInstance && !isScrolling && (
        <>
          <TableBubbleMenu editor={editorInstance} />
          <SelectionBubbleMenu editor={editorInstance} />
        </>
      )}
    </>
  );

  return (
    <div className={`markdown-editor ${className || ''}`}>
      <SearchReplacePanel
        editor={editorRef.current}
        visible={searchPanelOpen}
        onClose={() => onSearchPanelOpenChangeRef.current?.(false)}
      />
      <OverlayScrollbar
        className="editor-content-frame"
        scrollerClassName="editor-content"
        scrollerRef={elementRef}
        onMouseDown={handleEditorSurfaceMouseDown}
      >
        {editorContentChildren}
      </OverlayScrollbar>
      <EditorToolbar
        editor={editorInstance}
        collapsed={toolbarCollapsed}
        onCollapsedChange={onToolbarCollapsedChange}
      />
    </div>
  );
});
