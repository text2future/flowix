/**
 * Bounded-source helpers for Markdown tokenizers that live outside the editor
 * feature (table references, media-library references, agent thread cards).
 *
 * Anything that registers a Tiptap `markdownTokenizer` needs the same window
 * rules; exporting them here keeps other features off the editor's private
 * paths without pulling the extension tree into their graph.
 */
export {
  MARKDOWN_START_SCAN_WINDOW,
  boundedIndexOf,
  boundedSearch,
  limitToBlockHead,
  scanHead,
} from '../markdown-tokenizer-source';
