export interface ClipboardSnapshot {
  types: string[];
  text: string;
  html: string;
  files: File[];
}

function normalizeUriList(uriList: string): string {
  return uriList
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0 && !line.startsWith('#')) ?? '';
}

export function readClipboardSnapshot(data: DataTransfer): ClipboardSnapshot {
  const text = data.getData('text/plain') ?? '';
  const uriList = normalizeUriList(data.getData('text/uri-list') ?? '');

  return {
    types: Array.from(data.types || []),
    text: text || uriList,
    html: data.getData('text/html') ?? '',
    files: Array.from(data.files || []),
  };
}
