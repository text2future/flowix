import { Editor, Extension, renderNestedMarkdownContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { ListItem } from '@tiptap/extension-list';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Markdown } from '@tiptap/markdown';
import Placeholder from '@tiptap/extension-placeholder';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, useCallback } from 'react';
import { useShortcutScope, pushHandler } from '@features/shortcuts';
import { AttachmentLink } from '@features/editor/extensions/attachment-link';
import { TableBubbleMenu } from '@features/editor/extensions/table/table-bubble-menu';
import { EditorToolbar } from '@features/editor/components/editor-toolbar';
import { SelectionBubbleMenu } from '@features/editor/components/selection-bubble-menu';
import { DragContextMenu } from '@features/editor/components/drag-context-menu';
import { attachLinkHoverTooltip } from '@features/editor/components/link-hover-tooltip';
import { Tag } from '@features/editor/extensions/tag';
import MarkdownPaste from '@features/editor/extensions/markdown-paste';
import ManagedPasteRules from '@features/editor/extensions/paste-rules';
import { LinkSelectionHighlight, MarkdownLink } from '@features/editor/extensions/markdown-link';
import { NoteReference } from '@features/editor/extensions/note-link';
import { NoteMention } from '@features/editor/extensions/note-mention';
import { TagMention } from '@features/editor/extensions/tag-mention';
import { DateTimeWidget, updateDateTimeWidget } from '@features/editor/extensions/datetime-widget';
import { CodeBlockShiki } from '@features/editor/extensions/codeblock-shiki/codeblock-shiki';
import { MathBlock } from '@features/editor/extensions/math-block';
import { WebCard } from '@features/editor/extensions/web-card';
import { SearchAndReplace } from '@features/editor/extensions/search-replace';
import { SearchReplacePanel } from '@features/editor/components/search-replace-panel';
import Frontmatter from '@features/editor/extensions/frontmatter';
import { MenuPinExtension } from '@features/editor/extensions/menu-pin';
import { BlockDragExtension } from '@features/editor/extensions/block-drag';
import { SlashMenu } from '@features/editor/extensions/slash-menu';
import { AgentThreadCard } from '@features/editor/extensions/agent-thread-card';
import { TabAgentRun } from '@features/editor/extensions/tab-agent-run';
import { TabCharacter } from '@features/editor/extensions/tab-character';
import { TablePlugin } from '@features/editor/extensions/table/table-plugin';
import { useI18n } from '@features/i18n';

interface MarkdownEditorProps {
  content: string;
  editable?: boolean;
  placeholder?: string;
  onChange?: (markdown: string) => void;
  className?: string;
  onEditorScroll?: (scrollTop: number) => void;
  autoFocus?: boolean;
  editorStorageUpdatedAt?: Date | null;
  onBeforeCreate?: (editor: Editor) => void;
  // 搜索面板由父组件控制（titlebar 按钮 / Ctrl+F 共享同一开关）
  searchPanelOpen?: boolean;
  onSearchPanelOpenChange?: (open: boolean) => void;
  // Toolbar collapsed — owned by main-layout. Tooltip of the toolbar's visibility
  // is driven purely by this state; the editor no longer tracks focus.
  toolbarCollapsed?: boolean;
  onToolbarCollapsedChange?: (collapsed: boolean) => void;
  onEditingFinished?: () => void;
}

export interface MarkdownEditorHandle {
  flushPendingChanges: () => string | null;
  getCurrentMarkdown: () => string;
}

/**
 * Tiptap mount 阶段的"静默期" (毫秒) ── 详见 `mountedAtRef` 注释。
 * mount 后此时间窗内的 onUpdate 一律吞掉, 不走 recordDocumentEdit →
 * 不调度 autosave。
 *
 * 取值依据 ── Tiptap mount 阶段连续 onUpdate (parse / 扩展 hook /
 * ProseMirror schema 校验) 经验值在 50~200ms 内集中爆发; 500ms 留
 * 2~3 倍安全余量, 同时远小于 1s 的 autosave debounce, 不会让真实
 * 用户编辑被误吞 ── 打开后 < 500ms 内敲字属于极罕见操作。
 */
const MOUNT_QUIET_MS = 500;
const SERIALIZE_DEBOUNCE_MS = 200;

interface PendingExternalContent {
  content: string;
  localEditVersion: number;
}

type MarkdownRenderContext = {
  parentType?: string | null;
  index?: number;
  meta?: {
    parentAttrs?: {
      start?: number;
    };
  };
};

type MarkdownNodeLike = {
  type?: string;
  text?: string;
  content?: unknown;
};

const TABLE_CELL_PARENT_TYPES = new Set(['tableCell', 'tableHeader']);
const LIST_ITEM_PARENT_TYPES = new Set(['listItem', 'taskItem']);
const TABLE_SEPARATOR_CELL_RE = /^:?-{3,}:?$/;
const EMPTY_MARKDOWN_PLACEHOLDER_RE = /&(?:amp;)?nbsp;/gi;
const EMPTY_PARAGRAPH_MARKDOWN = '&nbsp;';

function stripEmptyMarkdownPlaceholders(value: string): string {
  return value
    .replace(/\u00a0/g, '')
    .replace(EMPTY_MARKDOWN_PLACEHOLDER_RE, '')
    .trim();
}

function isEmptyMarkdownPlaceholderOnly(value: string): boolean {
  return stripEmptyMarkdownPlaceholders(value) === '';
}

function getParentType(ctx: MarkdownRenderContext): string {
  return ctx.parentType || '';
}

function isTableCellContext(ctx: MarkdownRenderContext): boolean {
  return TABLE_CELL_PARENT_TYPES.has(getParentType(ctx));
}

function isListItemLeadingParagraphContext(ctx: MarkdownRenderContext): boolean {
  return LIST_ITEM_PARENT_TYPES.has(getParentType(ctx)) && ctx.index === 0;
}

function shouldDropEmptyParagraph(ctx: MarkdownRenderContext): boolean {
  return isTableCellContext(ctx) || isListItemLeadingParagraphContext(ctx);
}

function renderEmptyParagraphMarkdown(ctx: MarkdownRenderContext): string {
  return shouldDropEmptyParagraph(ctx) ? '' : EMPTY_PARAGRAPH_MARKDOWN;
}

function isEmptyParagraphPlaceholderTextNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;

  const maybeNode = node as MarkdownNodeLike;
  return maybeNode.type === 'text' &&
    typeof maybeNode.text === 'string' &&
    isEmptyMarkdownPlaceholderOnly(maybeNode.text);
}

function isEmptyParagraphForMarkdown(content: unknown[], ctx: MarkdownRenderContext): boolean {
  if (content.length === 0) return true;
  return shouldDropEmptyParagraph(ctx) && content.every(isEmptyParagraphPlaceholderTextNode);
}

function isMarkdownTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.slice(1, -1).includes('|');
}

function isTableSeparatorCell(cell: string): boolean {
  return TABLE_SEPARATOR_CELL_RE.test(cell.trim());
}

function normalizeMarkdownTableLine(line: string): string {
  if (!isMarkdownTableLine(line)) return line;

  const cells = line.split('|');
  const innerCells = cells.slice(1, -1);
  if (innerCells.every(isTableSeparatorCell)) return line;

  const normalizedCells = innerCells.map((cell) => (
    isEmptyMarkdownPlaceholderOnly(cell) ? '' : cell
  ));
  return `|${normalizedCells.join('|')}|`;
}

function normalizeMarkdownTableEmptyCells(markdown: string): string {
  return markdown
    .split('\n')
    .map(normalizeMarkdownTableLine)
    .join('\n');
}

const PreservedParagraph = Paragraph.extend({
  renderMarkdown(node, h, ctx: MarkdownRenderContext) {
    const content = Array.isArray(node.content) ? node.content : [];
    if (isEmptyParagraphForMarkdown(content, ctx)) {
      return renderEmptyParagraphMarkdown(ctx);
    }

    return h.renderChildren(content);
  },
});

const MarkdownEscape = Extension.create({
  name: 'markdownEscape',
  markdownTokenName: 'escape',
  parseMarkdown(token, h) {
    return h.createTextNode(token.raw || token.text || '');
  },
});

function isEmptyParagraphNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;

  const maybeNode = node as { type?: string; content?: unknown };
  if (maybeNode.type !== 'paragraph') return false;
  if (!Array.isArray(maybeNode.content) || maybeNode.content.length === 0) return true;
  return maybeNode.content.every(isEmptyParagraphPlaceholderTextNode);
}

const PreservedListItem = ListItem.extend({
  renderMarkdown(node, h, ctx) {
    const content = Array.isArray(node.content) ? node.content : [];

    if (content.length === 1 && isEmptyParagraphNode(content[0])) {
      if (ctx?.parentType === 'orderedList') {
        const start = ctx.meta?.parentAttrs?.start || 1;
        return `${start + ctx.index}. ${EMPTY_PARAGRAPH_MARKDOWN}`;
      }

      return '-';
    }

    return renderNestedMarkdownContent(
      node,
      h,
      (context: any) => {
        if (context.parentType === 'bulletList') {
          return '- ';
        }
        if (context.parentType === 'orderedList') {
          const start = context.meta?.parentAttrs?.start || 1;
          return `${start + context.index}. `;
        }
        return '- ';
      },
      ctx,
    );
  },
});

const PreservedTaskItem = TaskItem.extend({
  renderMarkdown(node, h) {
    const checkedChar = node.attrs?.checked ? 'x' : ' ';
    const prefix = `- [${checkedChar}] `;
    const content = Array.isArray(node.content) ? node.content : [];

    if (!isEmptyParagraphNode(content[0])) {
      return renderNestedMarkdownContent(node, h, prefix);
    }

    const nestedContent = content.slice(1);
    let output = nestedContent.length === 0 ? `${prefix}${EMPTY_PARAGRAPH_MARKDOWN}` : prefix;

    nestedContent.forEach((child, index) => {
      const childContent = h.renderChild?.(child, index + 1) ?? h.renderChildren([child]);
      if (childContent === undefined || childContent === null) return;

      const indentedChild = childContent
        .split('\n')
        .map(line => h.indent(line || ''))
        .join('\n');

      output += child.type === 'paragraph' ? `\n\n${indentedChild}` : `\n${indentedChild}`;
    });

    return output;
  },
});

function normalizeTaskItemPlaceholders(editor: Editor): void {
  const { state, view } = editor;
  let tr = state.tr;

  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'taskItem') return true;

    const firstChild = node.firstChild;
    if (!firstChild || firstChild.type.name !== 'paragraph') return false;
    if (!isEmptyMarkdownPlaceholderOnly(firstChild.textContent)) return false;

    const paragraphPos = pos + 1;
    const from = paragraphPos + 1;
    const to = paragraphPos + firstChild.nodeSize - 1;
    if (from < to) {
      tr = tr.delete(from, to);
    }

    return false;
  });

  if (tr.docChanged) {
    view.dispatch(tr);
  }
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor({
  content,
  editable = true,
  placeholder,
  onChange,
  className,
  onEditorScroll,
  autoFocus = false,
  editorStorageUpdatedAt,
  onBeforeCreate,
  searchPanelOpen = false,
  onSearchPanelOpenChange,
  toolbarCollapsed = false,
  onToolbarCollapsedChange,
  onEditingFinished,
}, ref) {
  const { t } = useI18n();
  const resolvedPlaceholder = placeholder || t('editor.placeholder');
  // placeholder 是 mount effect 的输入字符串，但本身不应成为 mount 的依赖：
  // i18n 切换会让 resolvedPlaceholder 重新生成，导致 Editor 被 destroy→重建，
  // 重建间隙各 extension 读 view.dom 触发 "editor view is not available"。
  // 这里把最新值放在 ref 里：mount 时读一次初值，运行时通过下面的同步 effect
  // 原地更新 Placeholder.options 并 dispatch meta 触发重新装饰。
  const resolvedPlaceholderRef = useRef(resolvedPlaceholder);
  resolvedPlaceholderRef.current = resolvedPlaceholder;
  const elementRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const [editorInstance, setEditorInstance] = useState<Editor | null>(null);
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serializeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEditorScrollRef = useRef(onEditorScroll);
  const contentRef = useRef(normalizeMarkdownTableEmptyCells(content));
  const isApplyingExternalContentRef = useRef(false);
  const isComposingRef = useRef(false);
  const pendingSerializeDirtyRef = useRef(false);
  const localEditVersionRef = useRef(0);
  const pendingExternalContentRef = useRef<PendingExternalContent | null>(null);
  // mount 阶段的"静默期" ── Tiptap 用 `content` prop 初始化 editor 时会
  // 解析 + 规范化 markdown (行尾 CRLF→LF / 末尾补 \n / frontmatter 重排),
  // 触发连续多次 onUpdate, 每一次的字节都跟磁盘原文略有差异 ── 跟
  // recordDocumentEdit 的 byte equality 比对会失败, 把"伪编辑"误判为真
  // 编辑, 1s 后 scheduleSave → write_document IPC → 后端 emit
  // `user_edit` ── 用户没编辑的情况下。 旧实现是 `isInitialMountRef` 只
  // 跳过第一次 onUpdate, 第二次起漏过; 改用时间窗 (MOUNT_QUIET_MS) 拦
  // 住整个 mount 阶段, 让 recordDocumentEdit 的语义比较 (见
  // [buffer-equality.ts]) 兜底后续潜在差异 ── 双层防御: 时间窗挡
  // 快速 normalizations, 语义比较挡慢速 / 漏网 normalization。
  const mountedAtRef = useRef(0);
  const onChangeRef = useRef(onChange);
  const onSearchPanelOpenChangeRef = useRef(onSearchPanelOpenChange);
  const onEditingFinishedRef = useRef(onEditingFinished);
  onEditorScrollRef.current = onEditorScroll;
  onChangeRef.current = onChange;
  onSearchPanelOpenChangeRef.current = onSearchPanelOpenChange;
  onEditingFinishedRef.current = onEditingFinished;

  const clearSerializeTimer = useCallback(() => {
    if (serializeTimerRef.current) {
      clearTimeout(serializeTimerRef.current);
      serializeTimerRef.current = null;
    }
  }, []);

  const serializePendingChanges = useCallback((options?: { force?: boolean }) => {
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

    const markdown = normalizeMarkdownTableEmptyCells(editor.getMarkdown());
    if (markdown === contentRef.current) {
      return null;
    }

    contentRef.current = markdown;
    onChangeRef.current?.(markdown);
    return markdown;
  }, [clearSerializeTimer]);

  const schedulePendingSerialization = useCallback(() => {
    clearSerializeTimer();
    const editor = editorRef.current;
    const viewState = editor?.view as (Editor['view'] & { composing?: boolean }) | undefined;
    if (isComposingRef.current || viewState?.composing) {
      return;
    }
    serializeTimerRef.current = setTimeout(() => {
      serializePendingChanges();
    }, SERIALIZE_DEBOUNCE_MS);
  }, [clearSerializeTimer, serializePendingChanges]);

  useImperativeHandle(ref, () => ({
    flushPendingChanges: () => serializePendingChanges({ force: true }),
    getCurrentMarkdown: () => {
      if (pendingSerializeDirtyRef.current) {
        return serializePendingChanges({ force: true }) ?? contentRef.current;
      }
      return contentRef.current;
    },
  }), [serializePendingChanges]);

  const logEditorPerf = useCallback((label: string, startedAt: number, meta?: Record<string, unknown>) => {
    console.info('[perf:open-doc]', label, {
      elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
      contentChars: contentRef.current.length,
      ...meta,
    });
  }, []);

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
    const normalizedNextContent = normalizeMarkdownTableEmptyCells(nextContent);
    if (!editor || normalizedNextContent === contentRef.current) {
      return;
    }
    clearSerializeTimer();
    pendingSerializeDirtyRef.current = false;

    const selection = editor.state.selection;
    const scrollEl = elementRef.current ? findScrollable(elementRef.current) : null;
    const scrollTop = scrollEl?.scrollTop ?? 0;
    const scrollLeft = scrollEl?.scrollLeft ?? 0;

    contentRef.current = normalizedNextContent;
    isApplyingExternalContentRef.current = true;
    try {
      editor.commands.setContent(normalizedNextContent, { contentType: 'markdown', emitUpdate: false });
      normalizeTaskItemPlaceholders(editor);
    } finally {
      isApplyingExternalContentRef.current = false;
    }
    logEditorPerf('MarkdownEditor:setContent', startedAt, {
      nextChars: normalizedNextContent.length,
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

  useEffect(() => {
    if (!elementRef.current || !content) {
      return;
    }
    const mountStartedAt = performance.now();
    const initialContent = normalizeMarkdownTableEmptyCells(content);
    contentRef.current = initialContent;

    const editor = new Editor({
      element: elementRef.current,
      // 修复跨多块复制时多余空行：ProseMirror 默认在块间插入 `\n\n`，
      // 改成单个 `\n`，粘贴到纯文本目标时块间只保留一个换行。
      editorProps: {
        clipboardTextSerializer(content) {
          return content.content.textBetween(0, content.content.size, '\n', '\n');
        },
      },
      extensions: [
        StarterKit.configure({
          heading: {
            levels: [1, 2, 3, 4],
          },
          dropcursor: false,
          gapcursor: false,
          link: false,
          codeBlock: false,
          paragraph: false,
          listItem: false,
        }),
        PreservedParagraph,
        PreservedListItem,
        MarkdownEscape,
        AttachmentLink,
        MarkdownLink,
        LinkSelectionHighlight,
        CodeBlockShiki,
        MathBlock,
        WebCard,
        TextStyle,
        Color,
        Highlight.configure({ multicolor: true }),
        TablePlugin,
        TaskList,
        PreservedTaskItem.configure({
          nested: true,
        }),
        Markdown.configure({
          markedOptions: {
            gfm: true,
            breaks: true,
          },
        }),
        Placeholder.configure({
          placeholder: resolvedPlaceholderRef.current,
          showOnlyCurrent: true,
        }),
        Tag,
        ManagedPasteRules,
        MarkdownPaste,
        DateTimeWidget,
        Frontmatter,
        NoteReference,
        NoteMention,
        TagMention,
        AgentThreadCard,
        SlashMenu,
        TabCharacter,
        TabAgentRun,
        SearchAndReplace,
        MenuPinExtension,
        BlockDragExtension,
      ],
      content: initialContent,
      contentType: 'markdown',
      editable,
      autofocus: autoFocus ? 'end' : false,
      onUpdate: () => {
        if (isApplyingExternalContentRef.current) return;
        // mount 静默期 ── 见 mountedAtRef 声明处注释。Tiptap mount 阶段
        // 会连续触发 onUpdate, 都在时间窗内一律吞掉。 时间窗外放行
        // onChange, recordDocumentEdit 的语义比较 ([buffer-equality.ts])
        // 兜底"漏过" 的非实质修改 (Tiptap 慢速归一 / 扩展二次归一等)。
        if (Date.now() - mountedAtRef.current < MOUNT_QUIET_MS) return;
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
    normalizeTaskItemPlaceholders(editor);
    logEditorPerf('MarkdownEditor:create', mountStartedAt, {
      initialChars: initialContent.length,
      docSize: editor.state.doc.content.size,
    });

    onBeforeCreate?.(editor);
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
    // 标记 mount 时刻 ── 后续 onUpdate 据此判定"是否还在静默期"。
    // 此时 new Editor 已构造完, 第一次 onUpdate 通常在下一个 microtask
    // 触发, mountedAtRef 在此赋值后与 Date.now() 的差值会落在 0~几十 ms,
    // 远小于 MOUNT_QUIET_MS, 第一次 onUpdate 必然被吞。
    mountedAtRef.current = Date.now();

    if (editorStorageUpdatedAt) {
      updateDateTimeWidget(editor, editorStorageUpdatedAt);
    }

    const detachLinkHoverTooltip = attachLinkHoverTooltip(editor, elementRef.current);

    const scrollEl = findScrollable(elementRef.current);
    if (scrollEl) {
      const handleScroll = () => {
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
      serializePendingChanges({ force: true });
      editorDom.removeEventListener('compositionstart', handleCompositionStart);
      editorDom.removeEventListener('compositionend', handleCompositionEnd);
      detachLinkHoverTooltip();
      editor.destroy();
      editorRef.current = null;
      setEditorInstance(null);
    };
  }, [applyExternalContent, findScrollable, schedulePendingSerialization, serializePendingChanges]);

  // 语言切换时，原地把 Placeholder extension 的 placeholder 字符串换掉，
  // 再 dispatch 一条带 'placeholder-update' meta 的空事务触发装饰重算。
  // 不重建 Editor — 重建会让 view.dom 瞬间失效，extension 子树的 unmount
  // 路径里读 view.dom 会触发 "The editor view is not available"。
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed) return;
    const placeholderExt = editor.extensionManager.extensions.find(
      (ext) => ext.name === 'placeholder',
    );
    if (!placeholderExt) return;
    placeholderExt.options.placeholder = resolvedPlaceholder;
    editor.view.dispatch(
      editor.state.tr.setMeta('placeholder-update', true),
    );
  }, [resolvedPlaceholder]);

  useEffect(() => {
    const editor = editorRef.current;
    const normalizedContent = normalizeMarkdownTableEmptyCells(content);
    if (editor && pendingSerializeDirtyRef.current) {
      serializePendingChanges({ force: true });
    }
    if (!editor || editor.isDestroyed || normalizedContent === contentRef.current) {
      return;
    }

    const viewState = editor.view as typeof editor.view & { composing?: boolean };
    if (isComposingRef.current || viewState.composing) {
      pendingExternalContentRef.current = {
        content: normalizedContent,
        localEditVersion: localEditVersionRef.current,
      };
      return;
    }

    pendingExternalContentRef.current = null;
    applyExternalContent(normalizedContent);
  }, [content, applyExternalContent, serializePendingChanges]);

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.setEditable(editable);
    }
  }, [editable]);

  useEffect(() => {
    if (editorRef.current) {
      updateDateTimeWidget(editorRef.current, editorStorageUpdatedAt || null);
    }
  }, [editorStorageUpdatedAt]);

  // 把 editor.find / editor.undo / editor.redo 三个 action 的实例级 handler
  // 注册到全局 handler-registry。组件卸载时 pop 走 — 命令面板 (Phase 3)
  // 仍能从 registry 读到 action 列表, 但 run 落到空栈, 行为退化为 no-op。
  //
  // ⌘F 不限制 scope (走 'window'), 焦点不在编辑器内时 invokeHandler 也会命中
  // 这个栈 — 单一编辑器挂载, 自然没有歧义。Phase 3 若引入第二个 Tiptap 实例
  // (e.g. 浮层编辑器), 改用 focus 事件动态 push/pop 即可。
  useEffect(() => {
    const pops = [
      pushHandler('editor.find', () => {
        onSearchPanelOpenChangeRef.current?.(true);
      }),
      pushHandler('editor.undo', () => {
        editorRef.current?.commands.undo();
      }),
      pushHandler('editor.redo', () => {
        editorRef.current?.commands.redo();
      }),
      // 块元素切换 (⌘1-4 / ⌘0 / ⌘⇧7-9) — 与 drag-context-menu items.tsx
      // 里的菜单项一一对应, 走同一组 Tiptap chain().focus().toggleXxx() 命令。
      // focus() 先调用是为了: 用户可能从标题输入框等地方按快捷键,
      // focus 保证命令落到编辑器内的当前 block。
      pushHandler('editor.setHeading1', () => {
        editorRef.current?.chain().focus().toggleHeading({ level: 1 }).run();
      }),
      pushHandler('editor.setHeading2', () => {
        editorRef.current?.chain().focus().toggleHeading({ level: 2 }).run();
      }),
      pushHandler('editor.setHeading3', () => {
        editorRef.current?.chain().focus().toggleHeading({ level: 3 }).run();
      }),
      pushHandler('editor.setHeading4', () => {
        editorRef.current?.chain().focus().toggleHeading({ level: 4 }).run();
      }),
      pushHandler('editor.setParagraph', () => {
        editorRef.current?.chain().focus().setParagraph().run();
      }),
      pushHandler('editor.toggleBulletList', () => {
        editorRef.current?.chain().focus().toggleBulletList().run();
      }),
      pushHandler('editor.toggleOrderedList', () => {
        editorRef.current?.chain().focus().toggleOrderedList().run();
      }),
      pushHandler('editor.toggleTaskList', () => {
        editorRef.current?.chain().focus().toggleTaskList().run();
      }),
    ];
    return () => {
      for (const pop of pops) pop();
    };
  }, []);

  // 主题切换时强制 Shiki 重新着色。
  //
  // 链路: useApplyTheme.apply() 写完 --shiki-theme 后 dispatch 'app-theme-changed' →
  // 本 effect 收到事件 → 在下一帧给 PM view 发一个带 'shikiPluginForceDecoration'
  // meta 的空事务, shiki-plugin.ts 的 state.apply 据此重跑 getDecorations。
  // 用 rAF 而非同步触发是为了与浏览器布局/绘制合批, 避免 CSS var 写入和
  // decoration 重建在同一 microtask 里冲突 (rAF 还顺带去抖, 多次连续切换主题
  // 时只触发一次 dispatch)。
  useEffect(() => {
    let rafId: number | null = null;
    const handleThemeChange = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const editor = editorRef.current;
        if (!editor || editor.isDestroyed) return;
        editor.view.dispatch(
          editor.state.tr.setMeta('shikiPluginForceDecoration', true)
        );
      });
    };

    window.addEventListener('app-theme-changed', handleThemeChange);
    return () => {
      window.removeEventListener('app-theme-changed', handleThemeChange);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

  return (
    <div className={`markdown-editor ${className || ''}`}>
      <SearchReplacePanel
        editor={editorRef.current}
        visible={searchPanelOpen}
        onClose={() => onSearchPanelOpenChangeRef.current?.(false)}
      />
      <div ref={elementRef} className="editor-content">
        {editorInstance && <DragContextMenu editor={editorInstance} />}
        {editorInstance && !isScrolling && (
          <>
            <TableBubbleMenu editor={editorInstance} />
            <SelectionBubbleMenu editor={editorInstance} />
          </>
        )}
      </div>
      <EditorToolbar
        editor={editorInstance}
        collapsed={toolbarCollapsed}
        onCollapsedChange={onToolbarCollapsedChange}
      />
    </div>
  );
});
