import {
  fileExtension,
  isMarkdownFilePath,
  isEditableTextFilePath,
  isImageFilePath,
  isVideoFilePath,
  isHtmlFilePath,
  isTextMimeType,
} from '@features/content/model/content-kind';

export {
  fileExtension,
  isMarkdownFilePath,
  isCodeTextFilePath,
  isEditableTextFilePath,
  isImageFilePath,
  isVideoFilePath,
  isHtmlFilePath,
  isNotebookResourcePath,
  resourceKindFromPath,
} from '@features/content/model/content-kind';

export type { ResourceKind } from '@features/content/model/content-kind';

export type ExternalFileViewKind = 'code' | 'csv' | 'markdown' | 'image' | 'video' | 'html' | 'docx' | 'unavailable';

/** Renderer choice belongs to the opening Surface, separate from factual content classification. */
export function externalFileViewKind(
  path: string,
  mimeType?: string | null,
  detectedTextContent = false,
): ExternalFileViewKind {
  const extension = fileExtension(path);
  if (extension === 'docx') return 'docx';
  if (extension === 'csv') return 'csv';
  if (isImageFilePath(path)) return 'image';
  if (isVideoFilePath(path)) return 'video';
  if (isHtmlFilePath(path)) return 'html';
  if (isMarkdownFilePath(path)) return 'markdown';
  if (isEditableTextFilePath(path, mimeType) || detectedTextContent) return 'code';
  return 'unavailable';
}

const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE_RE = /^[a-z]:[\\/]/i;

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

/** Scheme-less Markdown destinations are filesystem paths, regardless of extension. */
export function isRelativePathHref(rawHref: string | null | undefined): boolean {
  const href = rawHref?.trim() ?? '';
  if (!href || hasControlCharacters(href)) return false;
  // Fragments, queries, protocol-relative, rooted, scheme and drive hrefs all
  // keep their existing meaning.
  if (href.startsWith('#') || href.startsWith('?') || href.startsWith('/')) return false;
  if (WINDOWS_DRIVE_RE.test(href) || URI_SCHEME_RE.test(href)) return false;
  const pathPart = href.split(/[?#]/, 1)[0];
  if (!pathPart) return false;
  return true;
}

/** Kept for API compatibility; classifier text MIME behavior is centralized in content-kind. */
export { isTextMimeType };
