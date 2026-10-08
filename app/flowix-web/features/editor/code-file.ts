const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'tif', 'tiff', 'heic', 'heif',
]);

const VIDEO_EXTENSIONS = new Set([
  '3gp', 'avi', 'flv', 'm2ts', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'mts', 'webm', 'wmv',
]);

export type ResourceKind = 'note' | 'image' | 'video' | 'other';
export type ExternalFileViewKind = 'code' | 'csv' | 'markdown' | 'image' | 'video' | 'html' | 'docx' | 'unavailable';

// Keep this list aligned with the extension allowlist in
// `supported_text_document_path` in the desktop external-document command.
// All entries, including Markdown, are rendered as source text by CodeMirror
// when opened from the file tree. Unlisted extensions are classified by the
// desktop MIME database before they are sent to the text editor.
const CODE_TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'log',
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'xml',
  'html', 'htm', 'css', 'scss', 'sass', 'less',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts',
  'vue', 'svelte',
  'py', 'pyw', 'rs', 'go', 'java', 'kt', 'kts',
  'c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx',
  'cs', 'swift', 'php', 'rb', 'sh', 'bash', 'zsh', 'fish',
  'sql', 'graphql', 'gql', 'lua', 'r', 'dart', 'scala',
  'ex', 'exs', 'erl', 'hrl', 'fs', 'fsx', 'vb', 'pl', 'pm',
  'proto', 'ini', 'conf', 'cfg', 'properties', 'gradle',
]);

export function fileExtension(path: string): string {
  const filename = path.split(/[\\/]/).pop() ?? path;
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return '';
  return filename.slice(dot + 1).toLowerCase();
}

export function isMarkdownFilePath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(fileExtension(path));
}

export function isCodeTextFilePath(path: string): boolean {
  const extension = fileExtension(path);
  return CODE_TEXT_EXTENSIONS.has(extension);
}

const TEXT_APPLICATION_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/x-yaml',
  'application/toml',
  'application/sql',
  'application/graphql',
]);

export function isTextMimeType(mimeType: string | null | undefined): boolean {
  const mime = mimeType?.split(';', 1)[0]?.trim().toLowerCase();
  return !!mime && (mime.startsWith('text/') || TEXT_APPLICATION_MIME_TYPES.has(mime));
}

export function isEditableTextFilePath(path: string, mimeType?: string | null): boolean {
  return isMarkdownFilePath(path) || isCodeTextFilePath(path) || isTextMimeType(mimeType);
}

export function isImageFilePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(fileExtension(path));
}

export function isVideoFilePath(path: string): boolean {
  return VIDEO_EXTENSIONS.has(fileExtension(path));
}

export function isHtmlFilePath(path: string): boolean {
  return ['html', 'htm'].includes(fileExtension(path));
}

/** Pick the view for a file opened outside the notebook memo model. */
export function externalFileViewKind(path: string, mimeType?: string | null): ExternalFileViewKind {
  if (fileExtension(path) === 'docx') return 'docx';
  if (fileExtension(path) === 'csv') return 'csv';
  if (isImageFilePath(path)) return 'image';
  if (isVideoFilePath(path)) return 'video';
  if (isHtmlFilePath(path)) return 'html';
  if (isMarkdownFilePath(path)) return 'markdown';
  if (isEditableTextFilePath(path, mimeType)) return 'code';
  return 'unavailable';
}

/** Classify files shown by the notebook tree and external document view. */
export function resourceKindFromPath(path: string): ResourceKind {
  if (isMarkdownFilePath(path)) return 'note';
  if (isImageFilePath(path)) return 'image';
  if (isVideoFilePath(path)) return 'video';
  return 'other';
}

export function isNotebookResourcePath(path: string): boolean {
  const kind = resourceKindFromPath(path);
  return kind === 'note' || kind === 'image' || kind === 'video';
}
