import { Editor, Extension, renderNestedMarkdownContent } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { ListItem } from '@tiptap/extension-list';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Markdown } from '@tiptap/markdown';
import Placeholder from '@tiptap/extension-placeholder';
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useCallback, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { useShortcutScope, pushHandler } from '@features/shortcuts';
import { AttachmentLink } from '@features/editor/extensions/attachment-link';
import { FlowixHighlight } from '@features/editor/extensions/flowix-text-mark';
import { TableBubbleMenu } from '@features/editor/extensions/table/table-bubble-menu';
import { EditorToolbar } from '@features/editor/components/editor-toolbar';
import { SelectionBubbleMenu } from '@features/editor/components/selection-bubble-menu';
import { HeadingOutlineNavigation } from '@features/editor/components/heading-outline-navigation';
import { DragContextMenu } from '@features/editor/components/drag-context-menu';
import { attachLinkHoverTooltip } from '@features/editor/components/link-hover-tooltip';
import { Tag } from '@features/editor/extensions/tag';
import MarkdownPaste from '@features/editor/extensions/markdown-paste';
import ManagedPasteRules, { pasteClipboardSnapshot } from '@features/editor/extensions/paste-rules';
import type { ClipboardSnapshot } from '@features/editor/extensions/paste-rules/clipboard';
import { LinkSelectionHighlight, MarkdownLink } from '@features/editor/extensions/markdown-link';
import { NoteReference } from '@features/editor/extensions/note-link';
import { NoteMention, WikiNoteMention } from '@features/editor/extensions/note-mention';
import { TagMention } from '@features/editor/extensions/tag-mention';
import { CodeBlockShiki } from '@features/editor/extensions/codeblock-shiki/codeblock-shiki';
import { MathBlock } from '@features/editor/extensions/math-block';
import { WebCard } from '@features/editor/extensions/web-card';
import { SearchAndReplace } from '@features/editor/extensions/search-replace';
import { SearchReplacePanel } from '@features/editor/components/search-replace-panel';
import Frontmatter, { selectEditableDocumentContent } from '@features/editor/extensions/frontmatter';
import { MenuPinExtension } from '@features/editor/extensions/menu-pin';
import { BlockDragExtension } from '@features/editor/extensions/block-drag';
import { applyListType, ListTypeShortcuts } from '@features/editor/extensions/list-transforms';
import { SlashMenu } from '@features/editor/extensions/slash-menu';
import { AgentThreadCard } from '@features/agent/thread-card';
import { SKIP_AGENT_THREAD_CARD_CLEANUP_META } from '@features/agent/thread-card/agent-thread-card-extension';
import { TabAgentRun } from '@features/editor/extensions/tab-agent-run';
import { TabCharacter } from '@features/editor/extensions/tab-character';
import { TablePlugin } from '@features/editor/extensions/table/table-plugin';
import { StableCaret } from '@features/editor/extensions/stable-caret';
import { useI18n } from '@/lib/i18n';
import { markDocumentOpenTrace } from '@/lib/document-open-perf';
import { isWindowsPlatform } from '@/lib/shortcuts/platform';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';

interface MarkdownEditorProps {
  memoId?: string;
  transitionId?: number | null;
  content: string;
  editable?: boolean;
  placeholder?: string;
  onChange?: (markdown: string) => void;
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
  onAppendToTitle?: (title: string) => void;
  /** Content in the document scroller that stays outside ProseMirror. */
  header?: ReactNode;
}

export interface MarkdownEditorHandle {
  flushPendingChanges: () => string | null;
  getCurrentMarkdown: () => string;
  focusStart?: () => void;
  moveTitleToBody?: (trailingContent: string) => void;
  pasteToBody?: (snapshot: ClipboardSnapshot) => boolean;
}

interface NestedListMarkdownContext {
  parentType?: string;
  index: number;
  meta?: { parentAttrs?: { start?: number } };
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
const SERIALIZE_IDLE_TIMEOUT_MS = 500;

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

/** Mark name used only while serializing ambiguous bold boundaries. */
const HTMLStrongFallback = Extension.create({
  name: 'htmlStrongFallback',
  renderMarkdown: (node, h) => `<strong>${h.renderChildren(node)}</strong>`,
  markdownOptions: {
    htmlReopen: {
      open: '<strong>',
      close: '</strong>',
    },
  },
});

/**
 * Read compatibility for notes written before the serializer fallback was
 * added. New notes never use this form; they serialize the ambiguous run as
 * standard inline HTML instead.
 */
const LegacyAdjacentStrongMarkdown = Extension.create({
  name: 'legacyAdjacentStrongMarkdown',
  markdownTokenizer: {
    name: 'strong',
    level: 'inline',
    start: '**',
    tokenize(src, _tokens, lexer) {
      const match = /^\*\*(?!\s)((?:(?!\*\*)[^\n])+?\S)\*\*(?=[\p{L}\p{N}])/u.exec(src);
      if (!match) return undefined;

      return {
        type: 'strong',
        raw: match[0],
        text: match[1],
        tokens: lexer.inlineTokens(match[1]),
      };
    },
  },
});

function isUnicodeLetterOrNumber(value: string | undefined): boolean {
  return !!value && /^[\p{L}\p{N}]$/u.test(value);
}

function isUnicodePunctuation(value: string | undefined): boolean {
  // Marked's delimiter rules treat both Unicode punctuation and symbols as
  // punctuation around a closing `**`. Symbols include currency signs,
  // copyright marks, and emoji, all of which can trigger the same ambiguity.
  return !!value && /^[\p{P}\p{S}]$/u.test(value);
}

function markIsBold(mark: { type?: string }): boolean {
  return mark.type === 'bold' || mark.type === 'htmlStrongFallback';
}

/**
 * CommonMark rejects `**text。**下一句` because the closing delimiter is
 * followed immediately by a letter. Convert only those bold runs to inline
 * HTML, which is standard Markdown and remains portable across parsers.
 */
function markAmbiguousBoldRunsAsHtml(node: JSONContent): JSONContent {
  if (!Array.isArray(node.content)) return node;

  const content = node.content.map(child => markAmbiguousBoldRunsAsHtml(child));
  if (node.type !== 'paragraph' && node.type !== 'heading') {
    return { ...node, content };
  }

  const nextContent = content.map(child => ({ ...child, marks: child.marks ? [...child.marks] : child.marks }));
  let index = 0;
  while (index < nextContent.length) {
    const child = nextContent[index];
    if (child.type !== 'text' || !child.marks?.some(markIsBold)) {
      index += 1;
      continue;
    }

    const runStart = index;
    while (
      index + 1 < nextContent.length
      && nextContent[index + 1].type === 'text'
      && nextContent[index + 1].marks?.some(markIsBold)
    ) {
      index += 1;
    }

    const lastText = nextContent[index].text ?? '';
    const followingText = nextContent[index + 1]?.type === 'text'
      ? nextContent[index + 1].text ?? ''
      : '';
    const lastCharacters = Array.from(lastText);
    const lastCharacter = lastCharacters[lastCharacters.length - 1];
    const followingCharacter = Array.from(followingText)[0];
    const isAmbiguous = isUnicodePunctuation(lastCharacter)
      && isUnicodeLetterOrNumber(followingCharacter);

    if (isAmbiguous) {
      for (let runIndex = runStart; runIndex <= index; runIndex += 1) {
        const marks = nextContent[runIndex].marks ?? [];
        nextContent[runIndex].marks = marks.map(mark => (
          mark.type === 'bold' ? { ...mark, type: 'htmlStrongFallback' } : mark
        ));
      }
    }

    index += 1;
  }

  return { ...node, content: nextContent };
}

function serializeEditorMarkdown(editor: Editor): string {
  const json = markAmbiguousBoldRunsAsHtml(editor.getJSON());
  return editor.markdown?.serialize(json) ?? editor.getMarkdown();
}

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
      (context: NestedListMarkdownContext) => {
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

interface EditableBodyStart {
  block: ProseMirrorNode | null;
  blockIndex: number;
  position: number;
}

/**
 * Find the first real body block without treating the protected frontmatter
 * node (which renders the tag row) as document content.
 */
function getEditableBodyStart(editor: Editor): EditableBodyStart {
  let position = 0;
  for (let index = 0; index < editor.state.doc.childCount; index += 1) {
    const block = editor.state.doc.child(index);
    if (block.type.name !== 'frontmatter') {
      return { block, blockIndex: index, position };
    }
    position += block.nodeSize;
  }

  return {
    block: null,
    blockIndex: editor.state.doc.childCount,
    position,
  };
}

function isBlankEditorDocument(editor: Editor): boolean {
  const { block, blockIndex } = getEditableBodyStart(editor);
  return Boolean(
    block &&
    blockIndex === editor.state.doc.childCount - 1 &&
    block.type.name === 'paragraph' &&
    block.textContent.trim() === '',
  );
}

function createEmptyParagraph(editor: Editor, text?: string): ProseMirrorNode {
  const paragraph = editor.state.schema.nodes.paragraph;
  return paragraph.create(null, text ? editor.state.schema.text(text) : undefined);
}

/**
 * WebKit can fail to place the native caret in an empty paragraph immediately
 * after a non-editable block NodeView. The first click then only focuses the
 * editor and a second click is needed before typing works. Resolve that
 * paragraph explicitly while a media block is selected.
 */
function focusEmptyParagraphAfterMedia(
  view: Editor['view'],
  event: MouseEvent,
): boolean {
  if (event.button !== 0) return false;

  const selection = view.state.selection;
  if (
    !(selection instanceof NodeSelection) ||
    (selection.node.type.name !== 'image' && selection.node.type.name !== 'videoAttachment')
  ) return false;

  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;

  const paragraph = target.closest('p');
  if (
    !(paragraph instanceof HTMLElement) ||
    !view.dom.contains(paragraph) ||
    paragraph.textContent !== '' ||
    paragraph.closest('[contenteditable="false"]')
  ) return false;

  try {
    const textPosition = view.posAtDOM(paragraph, 0);
    const nextSelection = TextSelection.create(view.state.doc, textPosition);
    if (!nextSelection.$from.parent.isTextblock || !nextSelection.empty) return false;

    view.dispatch(view.state.tr.setSelection(nextSelection).setMeta('pointer', true));
    view.focus();
    event.preventDefault();
    return true;
  } catch {
    // The DOM may have been replaced between the pointer event and the
    // position lookup (for example while a NodeView is updating).
    return false;
  }
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor({
  memoId,
  transitionId = null,
  content,
  editable = true,
  placeholder,
  onChange,
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
  const elementRef = useRef<HTMLDivElement>(null);
  const editorMountRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const [editorInstance, setEditorInstance] = useState<Editor | null>(null);
  const useWindowsEditorScrollbar = isWindowsPlatform();
  const firstFrameTraceRef = useRef<number | null>(null);
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serializeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serializeIdleCallbackRef = useRef<number | null>(null);
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
  const onFocusTitleRef = useRef(onFocusTitle);
  const onAppendToTitleRef = useRef(onAppendToTitle);
  const editableRef = useRef(editable);
  onEditorScrollRef.current = onEditorScroll;
  onChangeRef.current = onChange;
  onSearchPanelOpenChangeRef.current = onSearchPanelOpenChange;
  onEditingFinishedRef.current = onEditingFinished;
  onFocusTitleRef.current = onFocusTitle;
  onAppendToTitleRef.current = onAppendToTitle;
  editableRef.current = editable;

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

    const markdown = normalizeMarkdownTableEmptyCells(editor.getMarkdown());
    if (markdown === contentRef.current) {
      return null;
    }

    contentRef.current = markdown;
    onChangeRef.current?.(markdown);
    return markdown;
  }, [clearSerializeTimer]);

  const schedulePendingSerialization = useCallback(() => {
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
    const normalizedNextContent = normalizeMarkdownTableEmptyCells(nextContent);
    if (!editor || normalizedNextContent === contentRef.current) {
      return;
    }

    // A local edit can reach the document buffer before contentRef is updated
    // by the debounced serializer (notably after an async image upload). If
    // the incoming content is already exactly what ProseMirror currently
    // serializes, it is only a reconciliation echo. Calling setContent here
    // would unnecessarily destroy the editor's history and make the previous
    // paste appear non-undoable.
    const currentEditorContent = normalizeMarkdownTableEmptyCells(
      serializeEditorMarkdown(editor),
    );
    if (normalizedNextContent === currentEditorContent) {
      contentRef.current = normalizedNextContent;
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
      editor
        .chain()
        .setMeta(SKIP_AGENT_THREAD_CARD_CLEANUP_META, true)
        .setMeta('addToHistory', false)
        .setContent(normalizedNextContent, { contentType: 'markdown', emitUpdate: false })
        .run();
      normalizeTaskItemPlaceholders(editor);
      resetEditorHistory(editor);
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

  const focusBodyStart = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed) return;
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

    return pasteClipboardSnapshot(editor, snapshot, memoId);
  }, [memoId]);

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

    const tr = blockIndex === editor.state.doc.childCount - 1
      ? editor.state.tr.replaceWith(position, position + block.nodeSize, createEmptyParagraph(editor))
      : editor.state.tr.delete(position, position + block.nodeSize);
    tr.scrollIntoView();
    editor.view.dispatch(tr);
    onAppendToTitleRef.current?.(title);
    return true;
  }, []);

  useImperativeHandle(ref, () => ({
    flushPendingChanges: () => serializePendingChanges({ force: true }),
    getCurrentMarkdown: () => {
      if (pendingSerializeDirtyRef.current) {
        return serializePendingChanges({ force: true }) ?? contentRef.current;
      }
      return contentRef.current;
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
    const initialContent = normalizeMarkdownTableEmptyCells(content);
    contentRef.current = initialContent;

    const editor = new Editor({
      element: editorMountRef.current,
      // 修复跨多块复制时多余空行：ProseMirror 默认在块间插入 `\n\n`，
      // 改成单个 `\n`，粘贴到纯文本目标时块间只保留一个换行。
      editorProps: {
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
          mousedown: (view, event) => focusEmptyParagraphAfterMedia(view, event),
        },
        handleKeyDown: (_view, event) => {
          if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) {
            return false;
          }

          const { selection } = editor.state;
          if (!(selection instanceof TextSelection) || !selection.empty) return false;

          if (event.key === 'ArrowUp' && selection.from === getEditableBodyStart(editor).position + 1) {
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
        HTMLStrongFallback,
        LegacyAdjacentStrongMarkdown,
        AttachmentLink.configure({ memoId }),
        MarkdownLink,
        LinkSelectionHighlight,
        CodeBlockShiki.configure({ traceId: transitionId }),
        MathBlock,
        WebCard,
        FlowixHighlight.configure({ multicolor: true }),
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
          showOnlyCurrent: true,
          // `showOnlyCurrent` uses an inclusive range check. A block
          // NodeSelection starts exactly at the end of the preceding block,
          // so an empty paragraph immediately before a selected video/image
          // would otherwise be treated as the current block and show its
          // placeholder. Node selections have no text caret, so that boundary
          // paragraph is not an editable current block.
          placeholder: ({ editor, node, pos }) => {
            const selection = editor.state.selection;
            if (
              selection instanceof NodeSelection &&
              selection.from === pos + node.nodeSize
            ) {
              return '';
            }
            return resolvedPlaceholderRef.current;
          },
        }),
        Tag,
        ManagedPasteRules.configure({ memoId }),
        MarkdownPaste,
        Frontmatter.configure({ memoId }),
        NoteReference,
        NoteMention,
        WikiNoteMention,
        TagMention,
        StableCaret,
        AgentThreadCard,
        SlashMenu,
        TabCharacter,
        TabAgentRun,
        SearchAndReplace,
        MenuPinExtension,
        BlockDragExtension,
        ListTypeShortcuts,
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
    let codeBlockCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'codeBlock') codeBlockCount += 1;
    });
    logEditorPerf('MarkdownEditor:create', mountStartedAt, {
      initialChars: initialContent.length,
      docSize: editor.state.doc.content.size,
      codeBlockCount,
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
    // 标记 mount 时刻 ── 后续 onUpdate 据此判定"是否还在静默期"。
    // 此时 new Editor 已构造完, 第一次 onUpdate 通常在下一个 microtask
    // 触发, mountedAtRef 在此赋值后与 Date.now() 的差值会落在 0~几十 ms,
    // 远小于 MOUNT_QUIET_MS, 第一次 onUpdate 必然被吞。
    mountedAtRef.current = Date.now();

    const detachLinkHoverTooltip = attachLinkHoverTooltip(editor, editorMountRef.current);

    const scrollEl = elementRef.current ? findScrollable(elementRef.current) : null;
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
  }, [
    applyExternalContent,
    findScrollable,
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

  useEffect(() => {
    const editor = editorRef.current;
    const normalizedContent = normalizeMarkdownTableEmptyCells(content);
    if (editor && pendingSerializeDirtyRef.current) {
      serializePendingChanges({ force: true });
      return;
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

  useLayoutEffect(() => {
    if (editorRef.current) {
      editorRef.current.setEditable(editable);
      const editorDom = editorRef.current.view.dom;
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
      {useWindowsEditorScrollbar ? (
        <OverlayScrollbar
          className="editor-content-frame"
          scrollerClassName="editor-content"
          scrollerRef={elementRef}
          onMouseDown={handleEditorSurfaceMouseDown}
        >
          {editorContentChildren}
        </OverlayScrollbar>
      ) : (
        <div
          ref={elementRef}
          className="editor-content"
          onMouseDown={handleEditorSurfaceMouseDown}
        >
          {editorContentChildren}
        </div>
      )}
      <EditorToolbar
        editor={editorInstance}
        collapsed={toolbarCollapsed}
        onCollapsedChange={onToolbarCollapsedChange}
      />
    </div>
  );
});
