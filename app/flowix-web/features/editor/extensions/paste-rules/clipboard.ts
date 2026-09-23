export interface ClipboardSnapshot {
  types: string[];
  markdown: string;
  text: string;
  html: string;
  uriList: string[];
  files: File[];
  sourceMime: string;
}

const MARKDOWN_MIME_TYPES = [
  'text/markdown',
  'text/x-markdown',
  'application/markdown',
] as const;

function normalizeUriList(uriList: string): string[] {
  return uriList
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
}

export function readClipboardSnapshot(data: DataTransfer): ClipboardSnapshot {
  const types = Array.from(data.types || []);
  const markdownMime = MARKDOWN_MIME_TYPES.find(mime => types.includes(mime));
  const markdown = markdownMime ? (data.getData(markdownMime) ?? '') : '';
  const plainText = data.getData('text/plain') ?? '';
  const uriList = normalizeUriList(data.getData('text/uri-list') ?? '');
  const html = data.getData('text/html') ?? '';
  const sourceMime = markdown.trim().length > 0
    ? markdownMime ?? 'text/markdown'
    : plainText.length > 0
      ? 'text/plain'
      : html.trim().length > 0
        ? 'text/html'
        : uriList.length > 0
          ? 'text/uri-list'
          : '';

  return {
    types,
    markdown,
    text: plainText || markdown || uriList[0] || '',
    html,
    uriList,
    files: Array.from(data.files || []),
    sourceMime,
  };
}
