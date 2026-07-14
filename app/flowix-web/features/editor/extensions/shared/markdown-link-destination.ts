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
