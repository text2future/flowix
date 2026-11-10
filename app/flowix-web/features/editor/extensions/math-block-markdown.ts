import { Extension, type MarkdownToken } from '@tiptap/core';
import { boundedIndexOf } from '@features/editor/markdown-tokenizer-source';

const BLOCK_MATH_RE = /^\$\$\s*\n?([\s\S]*?)\n?\s*\$\$(?:\n|$)/;

export function normalizeLatex(value: unknown): string {
  if (typeof value !== 'string') return '';

  let normalized = value.trim();
  let unwrapped = true;
  while (unwrapped) {
    unwrapped = false;
    const bracketed = /^\\\[\s*([\s\S]*?)\s*\\\]$/.exec(normalized);
    if (bracketed) {
      normalized = bracketed[1].trim();
      unwrapped = true;
      continue;
    }
    const dollarWrapped = /^\$\$\s*([\s\S]*?)\s*\$\$$/.exec(normalized);
    if (dollarWrapped) {
      normalized = dollarWrapped[1].trim();
      unwrapped = true;
    }
  }
  return normalized;
}

export const mathBlockMarkdownSpec = {
  markdownTokenizer: {
    name: 'mathBlock',
    level: 'block' as const,
    start(src: string) {
      return boundedIndexOf(src, '$$');
    },
    tokenize(src: string) {
      const match = BLOCK_MATH_RE.exec(src);
      if (!match) return undefined;
      return { type: 'mathBlock', raw: match[0], text: match[1] };
    },
  },
  parseMarkdown(token: MarkdownToken) {
    return { type: 'mathBlock', attrs: { latex: normalizeLatex(token.text) } };
  },
};

export const MathBlockMarkdownExtension = Extension.create({
  name: 'mathBlock',
  ...mathBlockMarkdownSpec,
});
