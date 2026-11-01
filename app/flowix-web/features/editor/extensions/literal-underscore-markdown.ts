import { Extension } from '@tiptap/core';
import {
  literalUnderscoreTokenizer,
  LITERAL_UNDERSCORE_TOKEN_NAME,
} from '@/lib/markdown-literal-underscore';

/**
 * Keeps `__text__` literal while the Markdown parser runs.
 *
 * Two underscores collide with real identifiers — `__pycache__`,
 * `__init__.py`, `__repr__` — and CommonMark would turn them into `bold`,
 * which deletes the delimiters from the document and rewrites them as `**` on
 * save. Emphasis is asterisk-only, so this consumes the underscore run before
 * the built-in `emStrong` tokenizer can mark it.
 *
 * The tokenizer lives in `lib/markdown-literal-underscore` because the export
 * renderer registers the same one on its own marked instance.
 */
export const LiteralUnderscoreStrong = Extension.create({
  name: LITERAL_UNDERSCORE_TOKEN_NAME,

  markdownTokenizer: {
    name: LITERAL_UNDERSCORE_TOKEN_NAME,
    level: 'inline',
    start: literalUnderscoreTokenizer.start,
    tokenize: literalUnderscoreTokenizer.tokenizer,
  },
});

export default LiteralUnderscoreStrong;
