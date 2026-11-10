import { MarkdownManager } from '@tiptap/markdown';
import { describe, expect, it, vi } from 'vitest';
import { createMarkdownEditorExtensions } from './markdown-editor-extensions';

/**
 * Both stock list tokenizers split the *whole* remaining document into lines
 * before deciding where their block ends, which makes lexing O(blocks ×
 * document). `markdown-list-tokenizer.ts` bounds the source it hands them; this
 * asserts that bound is actually applied.
 *
 * It is deliberately structural rather than a duration: the 400 KB shape that
 * used to take 5.8 s is covered by `npm run check:markdown-parse-perf`, which
 * runs outside the parallel test workers where timing is meaningful.
 */
const handedSources: number[] = [];

vi.mock('./markdown-tokenizer-source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./markdown-tokenizer-source')>();
  return {
    ...actual,
    limitToBlockHead: (src: string, itemPattern: RegExp) => {
      const bounded = actual.limitToBlockHead(src, itemPattern);
      handedSources.push(bounded.length);
      return bounded;
    },
  };
});

const LIST_BLOCKS = 2000;

function alternatingListDocument(): string {
  return Array.from({ length: LIST_BLOCKS }, (_, index) => (
    index % 2 === 0
      ? `- [ ] task ${index}`
      : `1. step ${index}\n2. step ${index + 1}`
  )).join('\n\n');
}

const manager = new MarkdownManager({
  extensions: createMarkdownEditorExtensions({
    getOwnerPath: () => undefined,
    getAttachmentNotebookId: () => undefined,
    workspaceHost: 'column-1',
    getPlaceholder: () => '',
  }),
});

describe('list tokenizer source bound', () => {
  it('never hands a list tokenizer the whole remaining document', () => {
    handedSources.length = 0;
    const markdown = alternatingListDocument();
    manager.parse(markdown);

    expect(handedSources.length).toBeGreaterThan(LIST_BLOCKS / 2);
    // A block is tens of characters; the remainder of the document is
    // ~60 KB here. Anything above a few hundred bytes means the split is
    // running over the rest of the note again.
    expect(Math.max(...handedSources)).toBeLessThan(400);
    expect(handedSources.reduce((total, size) => total + size, 0))
      .toBeLessThan(markdown.length * 2);
  });

  it('does not bound non-list blocks (they are rejected before the split)', () => {
    handedSources.length = 0;
    manager.parse('paragraph one\n\nparagraph two\n\nparagraph three');

    expect(handedSources).toEqual([]);
  });
});
