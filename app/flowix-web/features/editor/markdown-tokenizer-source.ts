/**
 * Cuts a tokenizer's input down to the head it actually needs.
 *
 * 扫描窗口与 `scanHead` / `boundedIndexOf` / `boundedSearch` 已经下沉到
 * `@/lib/bounded-source`：声明 markdown 节点的别的 feature 也要用它们，不该
 * 为此依赖 editor。这里只保留「块头裁剪」这条编辑器特有的规则，并转发那几个
 * 纯字符串工具，避免内部几十处导入一起改。
 */
export {
  MARKDOWN_START_SCAN_WINDOW,
  boundedIndexOf,
  boundedSearch,
  scanHead,
} from '@/lib/bounded-source';

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
