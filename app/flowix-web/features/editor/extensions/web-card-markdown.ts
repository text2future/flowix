import { Extension, type MarkdownToken } from '@tiptap/core';
import { boundedIndexOf } from '@features/editor/markdown-tokenizer-source';

export type WebCardAttrs = {
  url: string;
  title: string;
  description: string;
  image: string;
};

export const DEFAULT_WEB_CARD_ATTRS: WebCardAttrs = {
  url: '',
  title: '',
  description: '',
  image: '',
};

const WEB_CARD_RE = /^::webcard\s*(\{[\s\S]*?\})(?:\n|$)/;

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeWebCardAttrs(attrs: Partial<WebCardAttrs> | null | undefined): WebCardAttrs {
  return {
    url: normalizeText(attrs?.url),
    title: normalizeText(attrs?.title),
    description: normalizeText(attrs?.description),
    image: normalizeText(attrs?.image),
  };
}

export const webCardMarkdownSpec = {
  markdownTokenizer: {
    name: 'webCard',
    level: 'block' as const,
    start(src: string) {
      return boundedIndexOf(src, '::webcard');
    },
    tokenize(src: string) {
      const match = WEB_CARD_RE.exec(src);
      return match ? { type: 'webCard', raw: match[0], text: match[1] } : undefined;
    },
  },
  parseMarkdown(token: MarkdownToken) {
    try {
      return { type: 'webCard', attrs: normalizeWebCardAttrs(JSON.parse(token.text ?? '')) };
    } catch {
      return { type: 'webCard', attrs: DEFAULT_WEB_CARD_ATTRS };
    }
  },
};

export const WebCardMarkdownExtension = Extension.create({
  name: 'webCard',
  ...webCardMarkdownSpec,
});
