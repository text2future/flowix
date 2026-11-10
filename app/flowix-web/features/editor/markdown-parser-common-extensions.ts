import { Paragraph } from '@tiptap/extension-paragraph';
import { TaskItem } from '@tiptap/extension-task-item';
import { TaskList } from '@tiptap/extension-task-list';
import type { JSONContent, MarkdownParseHelpers, MarkdownToken } from '@tiptap/core';
import { guardListMarkdownTokenizer } from './markdown-list-tokenizer';

/**
 * The stock TaskList tokenizer splits the whole remaining document on every
 * block boundary (`parseIndentedBlocks`). The editor registry uses the guarded
 * variant, which rejects non-list blocks up front and bounds the source it
 * hands to that split — see `markdown-list-tokenizer.ts`.
 */
export const GuardedTaskList = guardListMarkdownTokenizer(
  TaskList,
  /^\s*[-+*]\s+\[[ xX]\]\s+/,
);

const EMPTY_MARKDOWN_PLACEHOLDER_RE = /^(?:&(?:amp;)?nbsp;|\u00a0)$/i;

function isEmptyMarkdownPlaceholderText(value: string | undefined): boolean {
  return typeof value === 'string' && EMPTY_MARKDOWN_PLACEHOLDER_RE.test(value.trim());
}

function isEmptyMarkdownPlaceholder(
  content: JSONContent[],
  tokens: MarkdownToken[] = [],
  fallbackText?: string,
): boolean {
  const sourceToken = tokens.length === 1 && tokens[0].type === 'text' ? tokens[0] : undefined;
  const isReservedSource = sourceToken
    ? isEmptyMarkdownPlaceholderText(sourceToken.raw) || isEmptyMarkdownPlaceholderText(sourceToken.text)
    : isEmptyMarkdownPlaceholderText(fallbackText);

  return content.length === 1
    && content[0].type === 'text'
    && (!content[0].marks || content[0].marks.length === 0)
    && typeof content[0].text === 'string'
    && isReservedSource
    && isEmptyMarkdownPlaceholderText(content[0].text);
}

/** Shared Markdown parsing for paragraphs, including the saved empty-line marker. */
export const MarkdownParagraph = Paragraph.extend({
  parseMarkdown(token: MarkdownToken, helpers: MarkdownParseHelpers) {
    const tokens = token.tokens ?? [];

    // Markdown represents a standalone image as a block node in Flowix.
    if (tokens.length === 1 && tokens[0].type === 'image') {
      return helpers.parseChildren([tokens[0]]);
    }

    const content = helpers.parseInline(tokens);
    return helpers.createNode(
      'paragraph',
      undefined,
      isEmptyMarkdownPlaceholder(content, tokens) ? [] : content,
    );
  },
});

/** TaskItem parses its first paragraph directly, so it must share placeholder handling. */
export const MarkdownTaskItem = TaskItem.extend({
  parseMarkdown(token: MarkdownToken, helpers: MarkdownParseHelpers) {
    const inlineContent = token.tokens?.length
      ? helpers.parseInline(token.tokens)
      : token.text
        ? [helpers.createNode('text', { text: token.text })]
        : [];
    const content: JSONContent[] = [helpers.createNode(
      'paragraph',
      undefined,
      isEmptyMarkdownPlaceholder(inlineContent, token.tokens ?? [], token.text) ? [] : inlineContent,
    )];

    if (token.nestedTokens?.length) {
      content.push(...helpers.parseChildren(token.nestedTokens));
    }

    return helpers.createNode('taskItem', { checked: token.checked || false }, content);
  },
});
