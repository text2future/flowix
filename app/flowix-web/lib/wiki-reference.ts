import { canonicalPath } from './path';
import { decodeDocumentHref, resolveDocumentRelativeHref } from './document-relative-path';

export interface WikiReferenceToken {
  raw: string;
  /** Encoded path spelling, without the heading or alias. */
  destination: string;
  href: string;
  target: string;
  heading: string | null;
  title: string;
}

export function splitWikiTarget(raw: string): { target: string; heading: string | null } {
  const hash = raw.indexOf('#');
  return {
    target: decodeDocumentHref((hash < 0 ? raw : raw.slice(0, hash)).trim()),
    heading: hash < 0 ? null : decodeDocumentHref(raw.slice(hash).replace(/^#+\s*/, '').trim()) || null,
  };
}

export function parseWikiReferenceAtStart(src: string): WikiReferenceToken | null {
  if (!src.startsWith('[[')) return null;
  const end = src.indexOf(']]', 2);
  if (end < 0 || /[\r\n]/.test(src.slice(2, end))) return null;
  const body = src.slice(2, end);
  const alias = body.indexOf('|');
  const rawTarget = alias < 0 ? body : body.slice(0, alias);
  const { target, heading } = splitWikiTarget(rawTarget);
  if (!target) return null;
  const title = target.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/i, '') || target;
  return {
    raw: src.slice(0, end + 2),
    destination: rawTarget.split('#')[0].trim(),
    href: rawTarget,
    target, heading,
    title: (alias < 0 ? title : body.slice(alias + 1).trim()) || title,
  };
}

/** Scan whole source spans so emphasis inside a path cannot split a reference. */
export function wikiReferenceSpans(source: string, blocked: readonly { start: number; end: number }[] = []) {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const range of [...blocked].sort((a, b) => a.start - b.start)) {
    const previous = ranges[ranges.length - 1];
    if (previous && previous.end >= range.start) previous.end = Math.max(previous.end, range.end);
    else ranges.push({ ...range });
  }
  const references: Array<{ start: number; end: number; token: WikiReferenceToken }> = [];
  let range = 0;
  for (const match of source.matchAll(/\[\[([^\]\r\n]*)\]\]/g)) {
    const start = match.index;
    while (range < ranges.length && ranges[range].end <= start) range++;
    if (ranges[range] && ranges[range].start <= start) continue;
    let escapes = 0;
    for (let at = start - 1; at >= 0 && source[at] === '\\'; at--) escapes++;
    if (escapes % 2) continue;
    const token = parseWikiReferenceAtStart(match[0]);
    if (token) references.push({ start, end: start + token.raw.length, token });
  }
  return references;
}

/** The same lexical note destination is used by clicks, serialization and moves. */
export function resolveWikiDocumentHref(href: string, documentPath?: string) {
  const raw = /^[\\/]{2}/.test(href) ? `file:${canonicalPath(href)}` : href;
  const target = resolveDocumentRelativeHref(raw, documentPath);
  if (!target || target.isDirectory) return target;
  const filename = target.path.split('/').pop() ?? '';
  return filename.lastIndexOf('.') > 0 ? target : { ...target, path: `${target.path}.md` };
}
