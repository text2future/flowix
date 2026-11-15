import { Extension, type MarkdownToken } from '@tiptap/core';
import { readMarkdownLinkDestination } from '@features/editor/extensions/shared/markdown-link-destination';
import { parseWikiReferenceAtStart, splitWikiTarget, type WikiReferenceToken } from '@/lib/wiki-reference';
import { parseBooleanAttr, pickAttr, splitDisplay, unescapeHtml } from './markdown';

export interface NoteReferenceAttrs {
  notebookId: string | null;
  relativePath?: string | null;
  notebookName: string;
  title: string;
  originalPath: string | null;
  linkStyle: 'flowix' | 'wiki' | 'markdown';
  linkTarget: string | null;
  heading: string | null;
  stale: boolean;
}

export interface ParsedMarkdownNoteLink {
  raw: string;
  text: string;
  href: string;
}

export type ParsedWikiNoteLink = WikiReferenceToken;

export const FLOWIX_NOTE_URL_RE = /^flowix:\/\/open\?/i;

function decodeMarkdownHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

export const splitObsidianTarget = splitWikiTarget;
export const parseWikiNoteLinkAtStart = parseWikiReferenceAtStart;

function findMarkdownLinkCloseBracket(src: string): number {
  for (let i = 1; i < src.length; i += 1) {
    const char = src[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '\n') return -1;
    if (char === ']') return i;
  }
  return -1;
}

export function parseMarkdownNoteLinkAtStart(src: string): ParsedMarkdownNoteLink | null {
  if (!src.startsWith('[')) return null;
  const closeBracket = findMarkdownLinkCloseBracket(src);
  if (closeBracket < 0 || src[closeBracket + 1] !== '(') return null;
  const destination = readMarkdownLinkDestination(src, closeBracket + 1);
  if (!destination || !FLOWIX_NOTE_URL_RE.test(destination.url)) return null;
  return { raw: src.slice(0, destination.end + 1), text: src.slice(1, closeBracket), href: destination.url };
}

function unescapeMarkdownLinkText(text: string): string {
  return text.replace(/\\([\\\[\]])/g, '$1');
}

/** Anchor of a note link: the `#fragment` first, then the generator's `heading` parameter. */
function headingFromTarget(target: URL | null): string | null {
  if (!target) return null;
  const fragment = target.hash ? decodeMarkdownHref(target.hash.replace(/^#/, '')).trim() : '';
  return fragment || target.searchParams.get('heading')?.trim() || null;
}

export function attrsFromMarkdownNoteLink(titleText: string, href: string): NoteReferenceAttrs {
  if (!FLOWIX_NOTE_URL_RE.test(href)) {
    const { target, heading } = splitObsidianTarget(href);
    return {
      notebookId: null, notebookName: '', title: unescapeMarkdownLinkText(titleText).trim(),
      originalPath: null, linkStyle: 'markdown', linkTarget: target, heading, stale: false,
    };
  }
  let pathTarget: URL | null = null;
  try { pathTarget = new URL(href); } catch { /* Keep malformed links unresolved. */ }
  return {
    notebookId: pathTarget?.searchParams.get('notebookId') ?? null,
    relativePath: pathTarget?.searchParams.get('f') ?? pathTarget?.searchParams.get('file') ?? pathTarget?.searchParams.get('relativePath') ?? null,
    notebookName: pathTarget?.searchParams.get('b') ?? pathTarget?.searchParams.get('book') ?? '',
    title: unescapeMarkdownLinkText(titleText).trim(),
    originalPath: pathTarget?.searchParams.get('path') ?? null,
    linkStyle: 'flowix',
    linkTarget: href,
    heading: headingFromTarget(pathTarget),
    stale: !pathTarget,
  };
}

export function attrsFromWikiNoteLink(parsed: ParsedWikiNoteLink): NoteReferenceAttrs {
  return {
    notebookId: null, notebookName: '', title: parsed.title,
    originalPath: null, linkStyle: 'wiki',
    // Keep escapes intact until filesystem resolution, so literal #, ? and % survive.
    linkTarget: parsed.destination,
    heading: parsed.heading, stale: false,
  };
}

/** Shared reader for native HTML transfers and historical <note> Markdown tags. */
export function attrsFromLegacyNoteTag(attr: (name: string) => string | null, text: string): NoteReferenceAttrs {
  const read = (name: string) => attr(name) || null;
  const transferPath = read('data-note-path');
  const { notebookName, title } = splitDisplay(text);
  const style = read('data-note-style');
  return {
    notebookId: transferPath ? null : read('notebook'),
    relativePath: transferPath ? null : read('relativePath'),
    notebookName: transferPath ? '' : notebookName, title,
    originalPath: transferPath || read('path'),
    linkStyle: !transferPath && (style === 'wiki' || style === 'markdown') ? style : 'flowix',
    linkTarget: transferPath ? null : read('data-note-target'),
    heading: read('data-note-heading'), stale: parseBooleanAttr(read('stale')),
  };
}

export const noteReferenceMarkdownSpec = {
  markdownTokenizer: {
    name: 'noteReference',
    level: 'inline' as const,
    start(src: string) {
      const noteIndex = src.indexOf('<note ');
      const linkHrefIndex = src.indexOf('(flowix://open?');
      const wikiIndex = src.indexOf('[[');
      const indexes = [noteIndex, linkHrefIndex < 0 ? -1 : Math.max(0, src.lastIndexOf('[', linkHrefIndex)), wikiIndex]
        .filter(index => index >= 0);
      return indexes.length ? Math.min(...indexes) : -1;
    },
    tokenize(src: string) {
      const wiki = parseWikiNoteLinkAtStart(src);
      if (wiki) return { type: 'noteReference', raw: wiki.raw, wiki };
      const link = parseMarkdownNoteLinkAtStart(src);
      if (link) return { type: 'noteReference', raw: link.raw, href: link.href, text: link.text };
      const note = /^<note\s+([^>]*)>([\s\S]*?)<\/note>/.exec(src);
      if (!note) return undefined;
      return { type: 'noteReference', raw: note[0], attrs: note[1], text: note[2] };
    },
  },
  parseMarkdown(token: MarkdownToken) {
    const wiki = token.wiki as ParsedWikiNoteLink | undefined;
    if (wiki) return { type: 'noteReference', attrs: attrsFromWikiNoteLink(wiki) };
    const href = String(token.href ?? '');
    if (FLOWIX_NOTE_URL_RE.test(href)) {
      return { type: 'noteReference', attrs: attrsFromMarkdownNoteLink(String(token.text ?? ''), href) };
    }
    const attrsStr = String(token.attrs ?? '');
    return {
      type: 'noteReference',
      attrs: attrsFromLegacyNoteTag(name => pickAttr(attrsStr, name), unescapeHtml(String(token.text ?? ''))),
    };
  },
};

export const NoteReferenceMarkdownExtension = Extension.create({
  name: 'noteReference',
  priority: 1000,
  ...noteReferenceMarkdownSpec,
});
