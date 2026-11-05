import { Extension, type MarkdownParseHelpers, type MarkdownToken } from '@tiptap/core';
import { scanHead } from '@features/editor/markdown-tokenizer-start';
import { decodeStorageKey } from './asset-markdown';
import { parseFlowixMediaStyleComment, parseFlowixMediaStyleSuffix } from './media-style';

const MARKDOWN_IMAGE_RE = /^!\[((?:\\.|[^\]\\])*)\]\(([^)\n]+)\)/;

export function escapeImageAlt(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/[\r\n]+/g, ' ');
}

function unescapeImageAlt(value: string): string {
  return value.replace(/\\([\\[\]])/g, '$1');
}
const ASSET_IMAGE_RE = /^(asset:\/\/|https?:\/\/asset\.localhost\/)/i;
export const DEFAULT_IMAGE_WIDTH_PERCENT = 100;
const MIN_IMAGE_WIDTH_PERCENT = 20;
export const MAX_IMAGE_WIDTH_PERCENT = 100;

export type ImageAlignment = 'left' | 'center' | 'right';

export function isAttachmentImageHref(href: string | null | undefined): boolean {
  return !!href && ASSET_IMAGE_RE.test(href);
}

export function normalizeWidthPercent(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(Math.min(MAX_IMAGE_WIDTH_PERCENT, Math.max(MIN_IMAGE_WIDTH_PERCENT, numeric)) * 10) / 10;
}

export function normalizeImageAlignment(value: unknown): ImageAlignment {
  return value === 'left' || value === 'right' ? value : 'center';
}

function parseImageSuffix(value: string): { raw: string; widthPercent: number | null; align: ImageAlignment } {
  const modern = parseFlowixMediaStyleSuffix(value);
  if (modern) {
    return {
      raw: modern.raw,
      widthPercent: normalizeWidthPercent(modern.style.widthPercent),
      align: normalizeImageAlignment(modern.style.align),
    };
  }
  const legacy = /^\{([^}\n]+)\}/.exec(value);
  const attributes = Object.fromEntries(
    [...(legacy?.[1] ?? '').matchAll(/(?:^|\s)(width|align)=([^\s}]+)/g)].map(([, key, item]) => [key, item]),
  );
  const hasLegacyStyle = Object.keys(attributes).length > 0;
  return {
    raw: hasLegacyStyle ? (legacy?.[0] ?? '') : '',
    widthPercent: normalizeWidthPercent(attributes.width?.replace('%', '')),
    align: normalizeImageAlignment(attributes.align),
  };
}

export const imageMarkdownSpec = {
  markdownTokenizer: {
    name: 'image',
    level: 'block' as const,
    start(src: string) {
      const head = scanHead(src);
      const candidateIndex = head.search(/^<!--[ \t]*flowix:media[ \t]+\{/m);
      const candidate = candidateIndex >= 0 ? parseFlowixMediaStyleComment(src.slice(candidateIndex)) : null;
      const commentIndex = candidate && src.slice(candidateIndex + candidate.raw.length).startsWith('![') ? candidateIndex : -1;
      const imageIndex = head.indexOf('![');
      if (commentIndex < 0) return imageIndex;
      if (imageIndex < 0) return commentIndex;
      return Math.min(commentIndex, imageIndex);
    },
    tokenize(src: string) {
      const metadata = parseFlowixMediaStyleComment(src);
      const source = metadata ? src.slice(metadata.raw.length) : src;
      const match = MARKDOWN_IMAGE_RE.exec(source);
      if (!match) return undefined;
      const suffix = parseImageSuffix(source.slice(match[0].length));
      return {
        type: 'image',
        raw: (metadata?.raw ?? '') + match[0] + suffix.raw,
        href: match[2],
        text: unescapeImageAlt(match[1]),
        title: null,
        widthPercent: metadata ? normalizeWidthPercent(metadata.style.widthPercent) : suffix.widthPercent,
        align: metadata ? normalizeImageAlignment(metadata.style.align) : suffix.align,
      };
    },
  },
  parseMarkdown(token: MarkdownToken, helpers: MarkdownParseHelpers) {
    if (!token.href) return { type: 'text', text: token.raw || '' };
    const commonAttrs = {
      src: token.href,
      alt: token.text || null,
      title: token.title || null,
      widthPercent: token.widthPercent ?? null,
      align: token.align ?? 'center',
    };
    if (!isAttachmentImageHref(token.href)) {
      return helpers.createNode('image', { ...commonAttrs, storageMode: null, storageKey: null });
    }
    return helpers.createNode('image', {
      ...commonAttrs,
      storageMode: 'attachment',
      storageKey: decodeStorageKey(token.href),
    });
  },
};

export const ImageMarkdownExtension = Extension.create({ name: 'image', ...imageMarkdownSpec });
