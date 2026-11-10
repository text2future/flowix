import { Extension, type MarkdownToken, type JSONContent } from '@tiptap/core';
import { boundedIndexOf } from '@features/editor/markdown-tokenizer-source';
import { normalizeVideoInfo } from './providers';

const EMBED_RE = /^<!--[ \t]*flowix:video-embed[ \t]+([^\n]*?)[ \t]*-->\r?\n\[视频\]\((https?:\/\/[^\s)]+)\)(?:\r?\n|$)/;

export const videoEmbedMarkdownSpec = {
  markdownTokenizer: {
    name: 'videoEmbed',
    level: 'block' as const,
    start: (src: string) => boundedIndexOf(src, '<!-- flowix:video-embed'),
    tokenize(src: string) {
      const match = EMBED_RE.exec(src);
      if (!match) return undefined;
      try {
        const attrs = normalizeVideoInfo(JSON.parse(match[1]));
        if (!attrs || attrs.sourceUrl !== match[2]) return undefined;
        return { type: 'videoEmbed', raw: match[0], text: match[1] };
      } catch { return undefined; }
    },
  },
  parseMarkdown(token: MarkdownToken) {
    try {
      const attrs = normalizeVideoInfo(JSON.parse(token.text ?? ''));
      if (attrs) return { type: 'videoEmbed', attrs };
    } catch { /* Keep malformed input as text. */ }
    return { type: 'paragraph', content: [{ type: 'text', text: token.raw ?? '' }] };
  },
  renderMarkdown(node: JSONContent) {
    const attrs = normalizeVideoInfo(node.attrs);
    if (!attrs) return '';
    return `<!-- flowix:video-embed ${JSON.stringify(attrs)} -->\n[视频](${attrs.sourceUrl})`;
  },
};

export const VideoEmbedMarkdownExtension = Extension.create({ name: 'videoEmbed', ...videoEmbedMarkdownSpec });
