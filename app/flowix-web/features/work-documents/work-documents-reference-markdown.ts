import { Extension, type MarkdownToken } from '@tiptap/core';
import { boundedSearch } from '@/lib/bounded-source';

export const WORK_DOCUMENTS_REFERENCE_MARKER = 'flowix:work-documents-reference';
export const WORK_DOCUMENTS_REFERENCE_VERSION = 1;

export interface WorkDocumentsReferenceAttrs {
  notebookId: string | null;
  relativePath: string | null;
  collectionId: string | null;
}

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeWorkDocumentsReferenceAttrs(value: unknown): WorkDocumentsReferenceAttrs {
  const attrs = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    notebookId: normalizeText(attrs.notebookId),
    relativePath: normalizeText(attrs.relativePath)?.replace(/\\/g, '/').replace(/^\/+/, '') ?? null,
    collectionId: normalizeText(attrs.collectionId),
  };
}

export function workDocumentsReferenceMetadataFromSource(source: string): Record<string, unknown> | null {
  const match = new RegExp(`^<!--[ \\t]*${WORK_DOCUMENTS_REFERENCE_MARKER}[ \\t]+(\\{[^\\r\\n]*\\})[ \\t]*-->(?:\\r?\\n|$)`).exec(source);
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

export const workDocumentsReferenceMarkdownSpec = {
  markdownTokenizer: {
    name: 'workDocumentsReference',
    level: 'block' as const,
    start(source: string) {
      return boundedSearch(source, new RegExp(`^<!--[ \\t]*${WORK_DOCUMENTS_REFERENCE_MARKER}[ \\t]+\\{`, 'm'));
    },
    tokenize(source: string) {
      const metadata = workDocumentsReferenceMetadataFromSource(source);
      if (!metadata) return undefined;
      const match = new RegExp(`^<!--[ \\t]*${WORK_DOCUMENTS_REFERENCE_MARKER}[ \\t]+\\{[^\\r\\n]*\\}[ \\t]*-->(?:\\r?\\n|$)`).exec(source);
      return match ? { type: 'workDocumentsReference', raw: match[0], metadata } : undefined;
    },
  },
  parseMarkdown(token: MarkdownToken) {
    const metadata = token.metadata && typeof token.metadata === 'object'
      ? token.metadata as Record<string, unknown>
      : workDocumentsReferenceMetadataFromSource(token.raw ?? '') ?? {};
    const attrs = metadata.version === WORK_DOCUMENTS_REFERENCE_VERSION ? metadata : {};
    return { type: 'workDocumentsReference', attrs: normalizeWorkDocumentsReferenceAttrs(attrs) };
  },
};

export const WorkDocumentsReferenceMarkdownExtension = Extension.create({
  name: 'workDocumentsReference',
  ...workDocumentsReferenceMarkdownSpec,
});
