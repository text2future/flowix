/**
 * Bounds the source handed to Markdown tokenizers.
 *
 * Every block tokenizer receives the whole remaining document as `src`, and
 * the stock ones keep rescanning it: `start()` hooks search for the next
 * construct, list `tokenize` hooks split the remainder into lines. Both make
 * lexing O(blocks × document) — measured at roughly a third of lexing time on a
 * 200 KB note with ~2k blocks, and 5.8 s on 400 KB of short lists.
 *
 * `start` hooks only need the head of the string: a block construct always
 * starts a line, and paragraphs end at the next blank line long before the
 * window is exhausted (generous enough that even a long single paragraph cannot
 * hide a construct from it). `tokenize` hooks need the block, not the document,
 * which `limitToBlockHead` provides.
 */
export const MARKDOWN_START_SCAN_WINDOW = 2048;

export function scanHead(src: string): string {
  return src.length > MARKDOWN_START_SCAN_WINDOW
    ? src.slice(0, MARKDOWN_START_SCAN_WINDOW)
    : src;
}

export function boundedIndexOf(src: string, needle: string): number {
  return scanHead(src).indexOf(needle);
}

export function boundedSearch(src: string, pattern: RegExp | string): number {
  return scanHead(src).search(pattern);
}

const INDENTED_LINE_RE = /^\s/;

/**
 * Cut `src` at the end of the block that starts at offset 0.
 *
 * `start` hooks only scan a window, but list `tokenize` hooks materialize the
 * *whole* remaining document as lines (`src.split('\n')`) before deciding where
 * their block ends — in `@tiptap/extension-list` for ordered lists and in
 * `@tiptap/core`'s `parseIndentedBlocks` for task lists. That makes lexing
 * O(blocks × document): ~2k short lists in a 200 KB note spent 1.66 s of a
 * 1.68 s parse in those two hooks, and the same bytes written as paragraphs
 * cost 11 ms. 400 KB of short lists took 5.8 s and grew quadratically.
 *
 * The cut replays the exit rule both implementations already use — a blank line
 * ends the block unless the next line is indented or starts a new item — so it
 * only ever removes lines the tokenizer would not have consumed. Passing extra
 * lines is harmless (the tokenizer still reports its own `consumed`); passing
 * too few would truncate content, so the rule must stay a superset of both.
 *
 * `itemPattern` must be anchored at `^` and free of the `g` flag (`test` on a
 * global regex is stateful).
 */
export function limitToBlockHead(src: string, itemPattern: RegExp): string {
  let lineStart = 0;
  let afterBlankLine = false;

  while (lineStart < src.length) {
    const lineEnd = src.indexOf('\n', lineStart);
    const line = lineEnd === -1 ? src.slice(lineStart) : src.slice(lineStart, lineEnd);
    const nextLineStart = lineEnd === -1 ? src.length : lineEnd + 1;

    if (line.trim() === '') {
      afterBlankLine = true;
      lineStart = nextLineStart;
      continue;
    }

    if (afterBlankLine && !INDENTED_LINE_RE.test(line) && !itemPattern.test(line)) {
      return src.slice(0, lineStart);
    }

    afterBlankLine = false;
    lineStart = nextLineStart;
  }

  return src;
}
