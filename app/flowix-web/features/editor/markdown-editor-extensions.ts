import { getWorkspaceMemoState } from '@features/memo/public/workspace-api';
import type { EditorImageContext } from './editor-image-source';
import { FlowixOrderedList } from './markdown-ordered-list';
import { VideoEmbed } from './extensions/video-embed/node';
import { Editor, Extension, renderNestedMarkdownContent } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { ListItem } from '@tiptap/extension-list';
import { Markdown } from '@tiptap/markdown';
import Placeholder from '@tiptap/extension-placeholder';
import { AttachmentLink } from '@features/editor/extensions/attachment-link';
import { FlowixHighlight } from '@features/editor/extensions/flowix-text-mark';
import { Tag } from '@features/editor/extensions/tag';
import MarkdownPaste from '@features/editor/extensions/markdown-paste';
import ManagedPasteRules from '@features/editor/extensions/paste-rules';
import { LinkSelectionHighlight, MarkdownLink } from '@features/editor/extensions/markdown-link';
import { NoteReference } from '@features/editor/extensions/note-link';
import { NoteMention, WikiNoteMention } from '@features/editor/extensions/note-mention';
import { TagMention } from '@features/editor/extensions/tag-mention';
import { CodeBlockShikiBase } from '@features/editor/extensions/codeblock-shiki/codeblock-shiki-base';
import { MarkdownEscape, LegacyAdjacentStrongMarkdown } from './markdown-parser-core-extensions';
import { AsteriskOnlyBold } from '@features/editor/extensions/asterisk-only-bold';
import { LiteralUnderscoreStrong } from '@features/editor/extensions/literal-underscore-markdown';
import { MathBlock } from '@features/editor/extensions/math-block';
import { WebCard } from '@features/editor/extensions/web-card';
import { TableReference } from '@features/multidimensional-table/table-reference-node';
import { MediaLibraryReference } from '@features/media-library/media-library-reference-node';
import { SearchAndReplace } from '@features/editor/extensions/search-replace';
import Frontmatter from '@features/editor/extensions/frontmatter';
import { MenuPinExtension } from '@features/editor/extensions/menu-pin';
import { BlockDragExtension } from '@features/editor/extensions/block-drag';
import { ListTypeShortcuts } from '@features/editor/extensions/list-transforms';
import { SlashMenu } from '@features/editor/extensions/slash-menu';
import { AgentThreadCard } from '@features/agent/thread-card';
import { TabAgentRun } from '@features/editor/extensions/tab-agent-run';
import { TabCharacter } from '@features/editor/extensions/tab-character';
import { tableNeedsHtml } from '@features/editor/extensions/table/flowix-table';
import { createTablePlugin } from '@features/editor/extensions/table/table-plugin';
import type { TablePluginOptions } from '@features/editor/extensions/table/table-plugin';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { translate } from '@/lib/i18n/provider';
import { BlockGapCursor } from './extensions/block-gap-cursor';
import { EditorFirstBlockMark } from './extensions/editor-first-block-mark';
import { HorizontalRuleBackspace } from '@features/editor/extensions/horizontal-rule-backspace';
import { StableCaret } from '@features/editor/extensions/stable-caret';
import { MarkdownParagraph, MarkdownTaskItem, GuardedTaskList } from './markdown-parser-common-extensions';
import { isEmptyMarkdownPlaceholderOnly } from './markdown-normalization';
import type { WorkspaceColumnId } from '@features/workspace/public/host-api';

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
const EMPTY_PARAGRAPH_MARKDOWN = '&nbsp;';

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

const PreservedParagraph = MarkdownParagraph.extend({
  renderMarkdown(node, h, ctx: MarkdownRenderContext) {
    const content = Array.isArray(node.content) ? node.content : [];
    if (isEmptyParagraphForMarkdown(content, ctx)) {
      return renderEmptyParagraphMarkdown(ctx);
    }

    return h.renderChildren(content);
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
  // HTML tables serialize native schema nodes, so Markdown-only marks must
  // never enter their subtrees (including nested tables).
  if (node.type === 'table' && tableNeedsHtml(node)) return node;

  const content = node.content.map(child => markAmbiguousBoldRunsAsHtml(child));
  if (node.type !== 'paragraph' && node.type !== 'heading') {
    return content.every((child, index) => child === node.content![index])
      ? node
      : { ...node, content };
  }

  let nextContent = content;
  let changed = content.some((child, index) => child !== node.content![index]);
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
        const runChild = nextContent[runIndex];
        const marks = runChild.marks;
        if (!marks?.some(mark => mark.type === 'bold')) continue;
        if (nextContent === content) nextContent = [...content];
        nextContent[runIndex] = {
          ...runChild,
          marks: marks.map(mark => (
            mark.type === 'bold' ? { ...mark, type: 'htmlStrongFallback' } : mark
          )),
        };
        changed = true;
      }
    }

    index += 1;
  }

  return changed ? { ...node, content: nextContent } : node;
}

export function serializeEditorMarkdown(editor: Editor): string {
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

    const start = ctx?.meta?.parentAttrs?.start || 1;
    const prefix = ctx?.parentType === 'orderedList' ? `${start + ctx.index}. ` : '- ';
    // Match continuation indentation to the marker width, including multi-digit
    // numbers. Fixed two-space serialization corrupts nested code on reload.
    const indent = ' '.repeat(prefix.length);
    const first = h.renderChildren([content[0]]);
    let output = prefix + first.split('\n').join(`\n${indent}`);
    content.slice(1).forEach((child, index) => {
      const rendered = h.renderChild?.(child, index + 1) ?? h.renderChildren([child]);
      if (rendered === undefined || rendered === null) return;
      const nested = rendered.split('\n').map(line => indent + line).join('\n');
      output += child.type === 'paragraph' ? `\n\n${nested}` : `\n${nested}`;
    });
    return output;
  },
});

const PreservedTaskItem = MarkdownTaskItem.extend({
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

export interface MarkdownEditorExtensionContext {
  getImageContext?: () => EditorImageContext | undefined;
  ownerPath?: string;
  getOwnerPath: () => string | undefined;
  getAttachmentNotebookId: () => string | undefined;
  propertyTargetId?: string;
  onPropertyAreaHoverChange?: (hovered: boolean) => void;
  onViewSourceMode?: () => void;
  transitionId?: number | null;
  workspaceHost: WorkspaceColumnId;
  getPlaceholder: () => string;
}

/** Full interactive editor registry; parser specs are shared through pure Markdown modules. */
function tableControlLabels(): NonNullable<TablePluginOptions['labels']> {
  // The edge buttons are plain DOM created by the plugin, so they cannot read
  // i18n at render time. Labels are resolved when the editor is built — the
  // same tradeoff `insertTableTemplate` makes for template cell text.
  const language = getCurrentAppLanguage();
  return {
    insertColumnAfter: translate(language, 'editor.table.insertColumnAfter'),
    insertRowAfter: translate(language, 'editor.table.insertRowAfter'),
    reorderColumn: translate(language, 'editor.table.reorderColumn'),
    reorderRow: translate(language, 'editor.table.reorderRow'),
  };
}

export function createMarkdownEditorExtensions({
  ownerPath,
  getImageContext,
  getOwnerPath,
  getAttachmentNotebookId,
  propertyTargetId,
  onPropertyAreaHoverChange,
  onViewSourceMode,
  transitionId,
  workspaceHost,
  getPlaceholder,
}: MarkdownEditorExtensionContext, codeBlockExtension = CodeBlockShikiBase) {
  // Event order follows extension priority, not this array's visual order:
  // gap input normalization (1200) > slash menu (1150) > managed paste and the
  // divider Backspace crossing (1100) > editing handlers such as TabCharacter
  // (1000) > gap navigation (50).
  // Keep paste on its existing pipeline; the host's editorProps handlers run
  // before plugins and must also defer to an active slash menu.
  // Grouped by concern; the array order is load-bearing (see the snapshot test
  // in `markdown-editor-extensions.test.ts`), so groups are spread in place.
  const schemaAndTextExtensions = [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      dropcursor: false,
      gapcursor: false,
      // BlockGapCursor provides input after closed blocks. A forced trailing
      // node would recreate the empty line the user just removed.
      trailingNode: false,
      link: false,
      codeBlock: false,
      paragraph: false,
      listItem: false,
      orderedList: false,
      // Registered below as an asterisk-only mark: the stock underscore rules
      // would eat `__pycache__` and other identifiers.
      bold: false,
    }),
    AsteriskOnlyBold,
    LiteralUnderscoreStrong,
    PreservedParagraph,
    PreservedListItem,
    FlowixOrderedList,
    MarkdownEscape,
    HTMLStrongFallback,
    LegacyAdjacentStrongMarkdown,
  ];

  const blockAndMediaExtensions = [
    AttachmentLink.configure({ ownerPath, getOwnerPath, getNotebookId: getAttachmentNotebookId, getImageContext }),
    MarkdownLink,
    LinkSelectionHighlight,
    codeBlockExtension.configure({ traceId: transitionId }),
    MathBlock,
    WebCard,
    VideoEmbed,
    TableReference,
    MediaLibraryReference,
    FlowixHighlight.configure({ multicolor: true }),
    createTablePlugin({ labels: tableControlLabels() }),
  ];

  const markdownSpecAndPasteExtensions = [
    GuardedTaskList,
    PreservedTaskItem.configure({ nested: true }),
    Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    Placeholder.configure({
      showOnlyCurrent: true,
      // Node selections have no text caret, so suppress the placeholder on
      // the empty paragraph immediately before a selected media node.
      placeholder: ({ editor, node, pos }) => {
        const selection = editor.state.selection;
        if (
          selection instanceof NodeSelection &&
          selection.from === pos + node.nodeSize
        ) {
          return '';
        }
        return getPlaceholder();
      },
    }),
    Tag,
    ManagedPasteRules.configure({ ownerPath, getOwnerPath,
      getLinkContext: (documentPath) => documentPath ? {
        documentPath, notebookId: getAttachmentNotebookId(),
        notebooks: getWorkspaceMemoState().notebooks,
      } : undefined,
    }),
    MarkdownPaste,
  ];

  const documentChromeExtensions = [
    Frontmatter.configure({
      propertyTargetId,
      onPropertyAreaHoverChange,
      onViewSourceMode,
      getAttachmentNotebookId,
    }),
    NoteReference,
    NoteMention,
    WikiNoteMention,
    TagMention,
    BlockGapCursor,
    EditorFirstBlockMark,
    HorizontalRuleBackspace,
    StableCaret,
  ];

  const interactionExtensions = [
    AgentThreadCard.configure({ workspaceHost }),
    SlashMenu,
    TabCharacter,
    TabAgentRun,
    SearchAndReplace,
    MenuPinExtension,
    BlockDragExtension,
    ListTypeShortcuts,
  ];

  return [
    ...schemaAndTextExtensions,
    ...blockAndMediaExtensions,
    ...markdownSpecAndPasteExtensions,
    ...documentChromeExtensions,
    ...interactionExtensions,
  ];
}
