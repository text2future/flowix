import type { MarkedExtension } from 'marked';

/**
 * Flowix treats `__text__` as literal text, never bold.
 *
 * CommonMark turns a pair of underscores into `<strong>`, which silently eats
 * the delimiters of real identifiers — `__pycache__`, `__init__.py`,
 * `__repr__`. The editor, the clipboard and the export renderer all register
 * this inline tokenizer so every surface keeps two underscores verbatim, while
 * `**bold**` stays the one and only way to write bold.
 *
 * Matching stops at the end of the line: a run without a closing `__` on the
 * same line is left to the stock tokenizers.
 */
export const LITERAL_UNDERSCORE_TOKEN_NAME = 'literalUnderscoreStrong';

const LITERAL_DOUBLE_UNDERSCORE_RE = /^__[^\n]*?__/;

export const literalUnderscoreTokenizer = {
  name: LITERAL_UNDERSCORE_TOKEN_NAME,
  level: 'inline' as const,
  // marked calls an inline extension's `start` (it must be a function there,
  // unlike a block extension's string hint); resolving the index keeps the
  // lexer from running the tokenizer on every position.
  start: (src: string) => src.indexOf('_'),
  tokenizer(src: string) {
    const match = LITERAL_DOUBLE_UNDERSCORE_RE.exec(src);
    if (!match) return undefined;

    // A plain `text` token is the whole point: no `strong` mark is created, so
    // the underscores survive parsing, serialization and export unchanged.
    return {
      type: 'text',
      raw: match[0],
      text: match[0],
    };
  },
};

export const LITERAL_UNDERSCORE_MARKED_EXTENSION: MarkedExtension = {
  extensions: [literalUnderscoreTokenizer],
};
