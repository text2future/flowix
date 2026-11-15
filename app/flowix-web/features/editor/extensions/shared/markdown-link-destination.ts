/** Keep filenames literal inside a Markdown link label. */
export function escapeMarkdownLinkLabel(value: string): string {
  return value.replace(/[\\[\]`*_~<>&]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}

export function readMarkdownLink(src: string, start = 0): { url: string; label: string; end: number } | null {
  if (start < 0 || src[start] !== '[') return null;
  let depth = 0;
  for (let index = start + 1; index < src.length; index++) {
    if (src[index] === '\\') { index++; continue; }
    if (src[index] === '[') depth++;
    if (src[index] !== ']') continue;
    if (depth > 0) { depth--; continue; }
    if (src[index + 1] !== '(') return null;
    const destination = readMarkdownLinkDestination(src, index + 1);
    return destination ? {
      ...destination,
      label: src.slice(start + 1, index).replace(/\\([\\[\]`*_~<>&])/g, '$1'),
    } : null;
  }
  return null;
}

export function readMarkdownLinkDestination(src: string, openParen: number): { url: string; end: number } | null {
  let depth = 0;

  for (let i = openParen + 1; i < src.length; i += 1) {
    const char = src[i];

    if (char === '\\') {
      i += 1;
      continue;
    }

    if (char === '(') {
      depth += 1;
      continue;
    }

    if (char !== ')') continue;

    if (depth > 0) {
      depth -= 1;
      continue;
    }

    return { url: src.slice(openParen + 1, i), end: i };
  }

  return null;
}
