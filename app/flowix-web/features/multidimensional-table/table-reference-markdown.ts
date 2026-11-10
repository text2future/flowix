import { Extension, type MarkdownToken } from '@tiptap/core';
import { boundedSearch } from '@features/editor/public/markdown-tokenizer-api';

export const TABLE_REFERENCE_MARKER = 'flowix:table-reference';
export const TABLE_REFERENCE_VERSION = 1;

export interface TableReferenceAttrs {
  notebookId: string | null;
  relativePath: string | null;
  collectionId: string | null;
  viewId: string | null;
}

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeTableReferenceAttrs(value: unknown): TableReferenceAttrs {
  const attrs = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    notebookId: normalizeText(attrs.notebookId),
    relativePath: normalizeText(attrs.relativePath)?.replace(/\\/g, '/').replace(/^\/+/, '') ?? null,
    collectionId: normalizeText(attrs.collectionId),
    viewId: normalizeText(attrs.viewId),
  };
}

export function tableReferenceMetadataFromSource(source: string): Record<string, unknown> | null {
  const match = new RegExp(`^<!--[ \\t]*${TABLE_REFERENCE_MARKER}[ \\t]+(\\{[^\\r\\n]*\\})[ \\t]*-->(?:\\r?\\n|$)`).exec(source);
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

export const tableReferenceMarkdownSpec = {
  markdownTokenizer: {
    name: 'tableReference',
    level: 'block' as const,
    start(source: string) {
      return boundedSearch(source, new RegExp(`^<!--[ \\t]*${TABLE_REFERENCE_MARKER}[ \\t]+\\{`, 'm'));
    },
    tokenize(source: string) {
      const metadata = tableReferenceMetadataFromSource(source);
      if (!metadata) return undefined;
      const match = new RegExp(`^<!--[ \\t]*${TABLE_REFERENCE_MARKER}[ \\t]+\\{[^\\r\\n]*\\}[ \\t]*-->(?:\\r?\\n|$)`).exec(source);
      return match ? { type: 'tableReference', raw: match[0], metadata } : undefined;
    },
  },
  parseMarkdown(token: MarkdownToken) {
    const metadata = token.metadata && typeof token.metadata === 'object'
      ? token.metadata as Record<string, unknown>
      : tableReferenceMetadataFromSource(token.raw ?? '') ?? {};
    const data = metadata.version === TABLE_REFERENCE_VERSION ? metadata : {};
    return { type: 'tableReference', attrs: normalizeTableReferenceAttrs(data) };
  },
};

export const TableReferenceMarkdownExtension = Extension.create({
  name: 'tableReference',
  ...tableReferenceMarkdownSpec,
});
