const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const MAX_FILE_NAME_LENGTH = 120;

const ILLEGAL_FILENAME_CHARS = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);
const ILLEGAL_FILENAME_CONTROLS = new Set(
  Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i))
);

/** Strip the YAML frontmatter block (between leading `---` markers) from markdown content. */
export function stripFrontmatter(content: string): string {
  return content.replace(FRONTMATTER_PATTERN, '').replace(/^\s+/, '');
}

/** Strip characters that are illegal in file names on common desktop file systems. */
export function sanitizeFileName(name: string): string {
  const cleaned = (name || '')
    .split('')
    .map((ch) => (ILLEGAL_FILENAME_CONTROLS.has(ch) || ILLEGAL_FILENAME_CHARS.has(ch) ? '_' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FILE_NAME_LENGTH);
  return cleaned || 'Untitled';
}
