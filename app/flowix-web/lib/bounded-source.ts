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
 * hide a construct from it).
 *
 * 这些函数是纯字符串工具，但每个「声明了 markdown 节点的 feature」都要用
 * （表格引用、媒体库引用、资料列表引用、Agent 卡片……）。放在 `lib/` 而不是
 * editor 里，是为了让那些 feature 不必反向依赖 editor：一个 subtype feature
 * 为了找一个 `<!-- marker` 而依赖整个编辑器扩展树，会让懒加载边界和单模块
 * 测试一起失效。
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
