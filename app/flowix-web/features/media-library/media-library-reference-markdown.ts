import { Extension, type MarkdownToken } from '@tiptap/core';
import { boundedSearch } from '@features/editor/public/markdown-tokenizer-api';

export const MEDIA_LIBRARY_REFERENCE_MARKER = 'flowix:media-library-reference';
export const MEDIA_LIBRARY_REFERENCE_VERSION = 1;

export interface MediaLibraryReferenceAttrs {
  notebookId: string | null;
  relativePath: string | null;
  collectionId: string | null;
}

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeMediaLibraryReferenceAttrs(value: unknown): MediaLibraryReferenceAttrs {
  const attrs = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    notebookId: normalizeText(attrs.notebookId),
    relativePath: normalizeText(attrs.relativePath)?.replace(/\\/g, '/').replace(/^\/+/, '') ?? null,
    collectionId: normalizeText(attrs.collectionId),
  };
}

export function mediaLibraryReferenceMetadataFromSource(source: string): Record<string, unknown> | null {
  const match = new RegExp(`^<!--[ \\t]*${MEDIA_LIBRARY_REFERENCE_MARKER}[ \\t]+(\\{[^\\r\\n]*\\})[ \\t]*-->(?:\\r?\\n|$)`).exec(source);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export const mediaLibraryReferenceMarkdownSpec = {
  markdownTokenizer: {
    name: 'mediaLibraryReference',
    level: 'block' as const,
    start(source: string) {
      return boundedSearch(source, new RegExp(`^<!--[ \\t]*${MEDIA_LIBRARY_REFERENCE_MARKER}[ \\t]+\\{`, 'm'));
    },
    tokenize(source: string) {
      const metadata = mediaLibraryReferenceMetadataFromSource(source);
      if (!metadata) return undefined;
      const match = new RegExp(`^<!--[ \\t]*${MEDIA_LIBRARY_REFERENCE_MARKER}[ \\t]+\\{[^\\r\\n]*\\}[ \\t]*-->(?:\\r?\\n|$)`).exec(source);
      return match ? { type: 'mediaLibraryReference', raw: match[0], metadata } : undefined;
    },
  },
  parseMarkdown(token: MarkdownToken) {
    const metadata = token.metadata && typeof token.metadata === 'object'
      ? token.metadata as Record<string, unknown>
      : mediaLibraryReferenceMetadataFromSource(token.raw ?? '') ?? {};
    const attrs = metadata.version === MEDIA_LIBRARY_REFERENCE_VERSION ? metadata : {};
    return { type: 'mediaLibraryReference', attrs: normalizeMediaLibraryReferenceAttrs(attrs) };
  },
};

export const MediaLibraryReferenceMarkdownExtension = Extension.create({
  name: 'mediaLibraryReference',
  ...mediaLibraryReferenceMarkdownSpec,
});
