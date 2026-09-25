const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'tif', 'tiff', 'heic',
]);

const VIDEO_EXTENSIONS = new Set([
  '3gp', 'avi', 'flv', 'm2ts', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'mts', 'webm', 'wmv',
]);

export type ResourceKind = 'note' | 'image' | 'video' | 'other';

// Keep this list aligned with the extension allowlist in
// `supported_text_document_path` in the desktop external-document command.
// All entries, including Markdown, are rendered as source text by CodeMirror
// when opened from the file tree. Extensionless files are handled separately
// below because their content type is determined by the desktop reader.
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
  if (CODE_TEXT_EXTENSIONS.has(extension)) return true;

  // The file tree backend probes extensionless files as UTF-8 text and rejects
  // binary content. Treat those files as CodeMirror candidates so files such
  // as LICENSE, Makefile, and Dockerfile can be opened in the same editor.
  return extension === '';
}

export function isEditableTextFilePath(path: string): boolean {
  return isMarkdownFilePath(path) || isCodeTextFilePath(path);
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
