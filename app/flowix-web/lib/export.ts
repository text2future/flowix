// Markdown export utilities for Markdown / Word (DOC) outputs.

import { Marked } from 'marked';

const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const MAX_FILE_NAME_LENGTH = 120;

// Use a dedicated `Marked` instance so `@tiptap/markdown`'s global extensions
// (which register a `taskList` tokenizer without a renderer) don't leak in
// and crash `marked.parse()`. A fresh instance keeps the default GFM task
// list support and is untouched by anything `marked.use(...)` did to the
// singleton.
const exportMarked = new Marked({
  gfm: true,
  breaks: false,
  async: false,
});

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const ILLEGAL_FILENAME_CHARS = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);
const ILLEGAL_FILENAME_CONTROLS = new Set(
  Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i))
);

const PRINT_BASE_STYLES = `
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.7;
    color: #1f2328;
    background: #ffffff;
    padding: 32px 40px;
  }
  h1, h2, h3, h4, h5, h6 {
    margin: 1.4em 0 0.6em;
    line-height: 1.3;
    font-weight: 600;
  }
  h1 { font-size: 1.8em; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.3em; }
  h2 { font-size: 1.45em; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.25em; }
  h3 { font-size: 1.2em; }
  h4 { font-size: 1.05em; }
  p { margin: 0.6em 0; }
  a { color: #2563eb; text-decoration: none; }
  ul, ol { padding-left: 1.6em; margin: 0.6em 0; }
  li + li { margin-top: 0.2em; }
  blockquote {
    margin: 0.8em 0;
    padding: 0.2em 1em;
    color: #57606a;
    border-left: 3px solid #d0d7de;
    background: #f6f8fa;
  }
  code {
    font-family: "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    font-size: 0.9em;
    background: rgba(175, 184, 193, 0.2);
    padding: 0.15em 0.35em;
    border-radius: 4px;
  }
  pre {
    background: #f6f8fa;
    padding: 14px 16px;
    border-radius: 6px;
    overflow-x: auto;
    line-height: 1.5;
  }
  pre code { background: transparent; padding: 0; font-size: 0.875em; }
  table {
    border-collapse: collapse;
    margin: 0.8em 0;
    display: block;
    overflow-x: auto;
  }
  th, td {
    border: 1px solid #d0d7de;
    padding: 6px 12px;
    text-align: left;
  }
  th { background: #f6f8fa; font-weight: 600; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.5em 0; }
  img { max-width: 100%; height: auto; }
  input[type="checkbox"] { margin-right: 6px; }
  @media print {
    body { padding: 0; }
    pre, blockquote { page-break-inside: avoid; }
    h1, h2, h3, h4 { page-break-after: avoid; }
  }
`;

/** Strip the YAML frontmatter block (between leading `---` markers) from markdown content. */
export function stripFrontmatter(content: string): string {
  return content.replace(FRONTMATTER_PATTERN, '').replace(/^\s+/, '');
}

/** Convert markdown source to an HTML string. GFM is enabled to match the editor. */
export function markdownToHtml(markdown: string): string {
  return exportMarked.parse(stripFrontmatter(markdown)) as string;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch] ?? ch);
}

/**
 * Wrap rendered HTML in a Word-compatible HTML document (saved with a `.doc` extension).
 * Word treats these files as native documents and renders them with the declared styles.
 */
export function buildWordHtml(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title || '未命名')}</title>
<!--[if gte mso 9]>
<xml>
  <w:WordDocument>
    <w:View>Print</w:View>
    <w:Zoom>100</w:Zoom>
    <w:DoNotOptimizeForBrowser/>
  </w:WordDocument>
</xml>
<![endif]-->
<style>${PRINT_BASE_STYLES}</style>
</head>
<body>
<main>${bodyHtml}</main>
</body>
</html>`;
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
  return cleaned || '未命名';
}
