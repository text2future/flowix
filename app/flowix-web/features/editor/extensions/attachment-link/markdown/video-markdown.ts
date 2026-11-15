import { Extension, type MarkdownToken } from '@tiptap/core';
import { readMarkdownLink } from '@features/editor/extensions/shared/markdown-link-destination';
import { scanHead } from '@features/editor/markdown-tokenizer-source';
import { decodeStorageKey, isVideoUrl } from './asset-markdown';
import { parseFlowixMediaStyleComment, parseFlowixMediaStyleSuffix } from './media-style';

export type VideoAlignment = 'left' | 'center' | 'right';

export function normalizeVideoAlignment(value: unknown): VideoAlignment {
  return value === 'left' || value === 'right' ? value : 'center';
}

function parseVideoSuffix(value: string): { raw: string; align: VideoAlignment } {
  const modern = parseFlowixMediaStyleSuffix(value);
  if (modern) return { raw: modern.raw, align: normalizeVideoAlignment(modern.style.align) };
  const legacy = /^\{align=(left|center|right)\}/.exec(value);
  return { raw: legacy?.[0] ?? '', align: normalizeVideoAlignment(legacy?.[1]) };
}

function findVideoLinkStart(src: string): number {
  let pos = 0;
  while (pos < src.length) {
    const openBracket = src.indexOf('[', pos);
    if (openBracket === -1) break;
    const link = readMarkdownLink(src, openBracket);
    if (link && isVideoUrl(link.url) && /^(?:asset:\/\/|https?:\/\/asset\.localhost\/)/i.test(link.url)) return openBracket;
    pos = openBracket + 1;
  }
  return -1;
}

export const videoMarkdownSpec = {
  markdownTokenizer: {
    name: 'videoAttachment',
    level: 'block' as const,
    start(src: string) {
      const head = scanHead(src);
      const candidateIndex = head.search(/^<!--[ \t]*flowix:media[ \t]+\{/m);
      const candidate = candidateIndex >= 0 ? parseFlowixMediaStyleComment(src.slice(candidateIndex)) : null;
      const commentIndex = candidate && src.slice(candidateIndex + candidate.raw.length).startsWith('[') ? candidateIndex : -1;
      const mediaIndex = findVideoLinkStart(head);
      if (commentIndex < 0) return mediaIndex;
      if (mediaIndex < 0) return commentIndex;
      return Math.min(commentIndex, mediaIndex);
    },
    tokenize(src: string) {
      const metadata = parseFlowixMediaStyleComment(src);
      const source = metadata ? src.slice(metadata.raw.length) : src;
      const link = readMarkdownLink(source);
      if (!link) return undefined;
      const isLegacyAsset = /^(?:asset:\/\/|https?:\/\/asset\.localhost\/)/i.test(link.url);
      if (!isVideoUrl(link.url) || (!metadata && !isLegacyAsset)) return undefined;
      const suffix = parseVideoSuffix(source.slice(link.end + 1));
      const align = metadata ? normalizeVideoAlignment(metadata.style.align) : suffix.align;
      return {
        type: 'videoAttachment',
        raw: (metadata?.raw ?? '') + source.slice(0, link.end + 1) + suffix.raw,
        align,
      };
    },
  },
  parseMarkdown(token: MarkdownToken) {
    const raw = typeof token.raw === 'string' ? token.raw : '';
    const metadata = parseFlowixMediaStyleComment(raw);
    const source = metadata ? raw.slice(metadata.raw.length) : raw;
    const link = readMarkdownLink(source);
    if (!link || !isVideoUrl(link.url)) return { type: 'text', text: raw };
    const suffix = parseVideoSuffix(source.slice(link.end + 1));
    return {
      type: 'videoAttachment',
      attrs: {
        src: link.url,
        title: link.label,
        storageMode: 'attachment',
        storageKey: decodeStorageKey(link.url),
        align: metadata ? normalizeVideoAlignment(metadata.style.align) : suffix.align,
      },
    };
  },
};

export const VideoMarkdownExtension = Extension.create({ name: 'videoAttachment', ...videoMarkdownSpec });
