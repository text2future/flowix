import { describe, expect, it } from 'vitest';
import { MARKDOWN_START_SCAN_WINDOW, limitToBlockHead, scanHead } from './markdown-tokenizer-source';

const ORDERED_ITEM = /^(\s*)(\d+)[.)]\s+(.*)$/;
const TASK_ITEM = /^\s*[-+*]\s+\[([ xX])\]\s+/;

/**
 * The list tokenizers cut `src` with `limitToBlockHead` before the stock code
 * splits it into lines. The cut has to stay a superset of what those tokenizers
 * consume: extra lines are ignored, missing lines silently drop content. These
 * cases mirror the exit rules of `collectOrderedListItems` and
 * `parseIndentedBlocks`.
 */
describe('limitToBlockHead', () => {
  it('keeps a block that runs to the end of the document', () => {
    const src = '1. a\n2. b';
    expect(limitToBlockHead(src, ORDERED_ITEM)).toBe(src);
  });

  it('cuts at the blank line that ends the block', () => {
    expect(limitToBlockHead('1. a\n2. b\n\nparagraph\n\n1. c', ORDERED_ITEM))
      .toBe('1. a\n2. b\n\n');
  });

  it('keeps a continuation line that follows a blank line indented', () => {
    expect(limitToBlockHead('1. a\n\n   indented\n2. b\n\nplain', ORDERED_ITEM))
      .toBe('1. a\n\n   indented\n2. b\n\n');
  });

  it('keeps a list that continues after a blank line with a new item', () => {
    expect(limitToBlockHead('1. a\n\n2. b\n\nx', ORDERED_ITEM)).toBe('1. a\n\n2. b\n\n');
  });

  it('keeps a lazy continuation line that is not preceded by a blank line', () => {
    expect(limitToBlockHead('1. a\nlazy line\n\nplain', ORDERED_ITEM)).toBe('1. a\nlazy line\n\n');
  });

  it('keeps nested items', () => {
    expect(limitToBlockHead('1. a\n   1. nested\n   2. nested\n2. b\n\nafter', ORDERED_ITEM))
      .toBe('1. a\n   1. nested\n   2. nested\n2. b\n\n');
  });

  it('handles task lists with their own item pattern', () => {
    expect(limitToBlockHead('- [ ] a\n\n  continuation\n- [x] b\n\npara', TASK_ITEM))
      .toBe('- [ ] a\n\n  continuation\n- [x] b\n\n');
  });

  it('cuts a task list where the next block starts', () => {
    expect(limitToBlockHead('- [ ] a\n- [x] b\n\nplain\n\n- [ ] c', TASK_ITEM))
      .toBe('- [ ] a\n- [x] b\n\n');
  });

  it('tolerates leading blank lines and CRLF terminators', () => {
    expect(limitToBlockHead('\n\n1. a\n\n1. b\n\nx', ORDERED_ITEM)).toBe('\n\n1. a\n\n1. b\n\n');
    expect(limitToBlockHead('1. a\r\n2. b\r\n\r\nplain', ORDERED_ITEM)).toBe('1. a\r\n2. b\r\n\r\n');
  });

  it('returns the input unchanged for empty or blank source', () => {
    expect(limitToBlockHead('', ORDERED_ITEM)).toBe('');
    expect(limitToBlockHead('\n\n\n', ORDERED_ITEM)).toBe('\n\n\n');
  });

  it('never returns more than the input', () => {
    const src = '1. a\n2. b\n\npara';
    const head = limitToBlockHead(src, ORDERED_ITEM);
    expect(src.startsWith(head)).toBe(true);
    expect(head.length).toBeLessThanOrEqual(src.length);
  });
});

describe('scanHead', () => {
  it('bounds the window used by tokenizer start hooks', () => {
    const long = 'x'.repeat(MARKDOWN_START_SCAN_WINDOW + 10);
    expect(scanHead(long).length).toBe(MARKDOWN_START_SCAN_WINDOW);
    expect(scanHead('short')).toBe('short');
  });
});
