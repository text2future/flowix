import { VideoEmbedMarkdownExtension } from './extensions/video-embed/markdown';
import { BulletList, ListItem } from '@tiptap/extension-list';
import { TaskList } from '@tiptap/extension-task-list';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import StarterKit from '@tiptap/starter-kit';
import { AttachmentMarkdownExtensions } from '@features/editor/extensions/attachment-link/markdown/extensions';
import { CodeBlockShikiBase } from '@features/editor/extensions/codeblock-shiki/codeblock-shiki-base';
import { FlowixHighlight } from '@features/editor/extensions/flowix-text-mark';
import { MarkdownLinkParserExtension } from '@features/editor/extensions/markdown-link-markdown';
import { NoteReferenceMarkdownExtension } from '@features/editor/extensions/note-link/note-reference-markdown';
import { FlowixTable } from '@features/editor/extensions/table/flowix-table';
import { FrontmatterMarkdownExtension } from '@features/editor/extensions/frontmatter-markdown';
import { TableReferenceMarkdownExtension } from '@features/multidimensional-table/table-reference-markdown';
import { MediaLibraryReferenceMarkdownExtension } from '@features/media-library/media-library-reference-markdown';
import { MarkdownEscape, LegacyAdjacentStrongMarkdown } from './markdown-parser-core-extensions';
import { LiteralUnderscoreStrong } from '@features/editor/extensions/literal-underscore-markdown';
import { MathBlockMarkdownExtension } from '@features/editor/extensions/math-block-markdown';
import { WebCardMarkdownExtension } from '@features/editor/extensions/web-card-markdown';
import { MarkdownParagraph, MarkdownTaskItem } from './markdown-parser-common-extensions';
import { AgentThreadCardMarkdownExtension } from '@features/agent/thread-card/agent-thread-card-markdown-spec';
import { FlowixOrderedList } from './markdown-ordered-list';
import { guardListMarkdownTokenizer } from './markdown-list-tokenizer';

/**
 * List tokenizers split the remaining document before checking the first line.
 * Rejecting non-list blocks up front is what keeps parsing linear in block
 * count; see `markdown-list-tokenizer.ts`.
 */
const GuardedTaskList = guardListMarkdownTokenizer(
  TaskList,
  /^\s*[-+*]\s+\[[ xX]\]\s+/,
);

/**
 * MarkdownManager only consumes Markdown tokenizers and parse handlers. Keep
 * this registry separate from editor menus, NodeViews, and editing plugins.
 */
export function createMarkdownParserExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      dropcursor: false,
      gapcursor: false,
      link: false,
      codeBlock: false,
      paragraph: false,
      listItem: false,
      // Registered below through guarded variants: the stock tokenizers scan
      // the whole remaining document on every block.
      bulletList: false,
      orderedList: false,
    }),
    MarkdownParagraph,
    ListItem,
    BulletList,
    FlowixOrderedList,
    GuardedTaskList,
    MarkdownTaskItem,
    MarkdownEscape,
    LegacyAdjacentStrongMarkdown,
    LiteralUnderscoreStrong,
    ...AttachmentMarkdownExtensions,
    MarkdownLinkParserExtension,
    CodeBlockShikiBase,
    MathBlockMarkdownExtension,
    WebCardMarkdownExtension,
    VideoEmbedMarkdownExtension,
    FlowixTable,
    // FlowixTable declares `content: 'tableRow+'`, so the row/cell nodes must
    // exist here too. Without them the manager cannot build a schema for the
    // raw-HTML branch (`generateJSON`) and every note containing HTML throws.
    TableRow,
    TableHeader,
    TableCell,
    TableReferenceMarkdownExtension,
    MediaLibraryReferenceMarkdownExtension,
    FlowixHighlight.configure({ multicolor: true }),
    FrontmatterMarkdownExtension,
    NoteReferenceMarkdownExtension,
    // Notes that embed an AI thread card used to be rejected by the worker so
    // the browser parser could keep the card. Registering the markdown-only
    // spec lets background parsing keep it as a node instead.
    AgentThreadCardMarkdownExtension,
  ];
}
