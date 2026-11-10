import { Extension, type MarkdownToken } from '@tiptap/core';
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
    const closeBracket = src.indexOf(']', openBracket);
    const openParen = src.indexOf('(', openBracket);
    if (closeBracket === -1 || openParen === -1 || closeBracket !== openParen - 1) {
      pos = openBracket + 1;
      continue;
    }
    if (src.startsWith('asset://', openParen + 1)) return openBracket;
    pos = openBracket + 1;
  }
  return -1;
}

function findClosingParen(source: string, openParen: number): number {
  for (let index = openParen + 1; index < source.length; index += 1) {
    if (source[index] === '%' && index + 2 < source.length && source[index + 1] === '2' && source[index + 2] === '9') {
      index += 2;
      continue;
    }
    if (source[index] === ')' && !(index > 0 && source[index - 1] === '%')) return index;
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
      if (!source.startsWith('[')) return undefined;
      const closeBracket = source.indexOf(']');
      if (closeBracket === -1) return undefined;
      const openParen = source.indexOf('(', closeBracket);
      if (openParen !== closeBracket + 1) return undefined;
      const closePos = findClosingParen(source, openParen);
      if (closePos === -1) return undefined;
      const url = source.slice(openParen + 1, closePos);
      if (!isVideoUrl(url)) return undefined;
      const suffix = parseVideoSuffix(source.slice(closePos + 1));
      const align = metadata ? normalizeVideoAlignment(metadata.style.align) : suffix.align;
      return {
        type: 'videoAttachment',
        raw: (metadata?.raw ?? '') + source.slice(0, closePos + 1) + suffix.raw,
        align,
      };
    },
  },
  parseMarkdown(token: MarkdownToken) {
    const raw = typeof token.raw === 'string' ? token.raw : '';
    if (raw.startsWith('!')) return { type: 'text', text: raw };
    const firstBracket = raw.indexOf('[');
    if (firstBracket === -1) return { type: 'text', text: raw };
    const closeBracket = raw.indexOf(']', firstBracket + 1);
    const openParen = raw.indexOf('(', firstBracket);
    if (closeBracket === -1 || openParen === -1 || closeBracket !== openParen - 1) return { type: 'text', text: raw };
    const closePos = findClosingParen(raw, openParen);
    if (closePos === -1) return { type: 'text', text: raw };
    const src = raw.slice(openParen + 1, closePos);
    if (!isVideoUrl(src)) return { type: 'text', text: raw };
    const metadata = parseFlowixMediaStyleComment(raw);
    const suffix = parseVideoSuffix(raw.slice(closePos + 1));
    return {
      type: 'videoAttachment',
      attrs: {
        src,
        title: raw.slice(firstBracket + 1, closeBracket),
        storageMode: 'attachment',
        storageKey: decodeStorageKey(src),
        align: metadata ? normalizeVideoAlignment(metadata.style.align) : suffix.align,
      },
    };
  },
};

export const VideoMarkdownExtension = Extension.create({ name: 'videoAttachment', ...videoMarkdownSpec });
