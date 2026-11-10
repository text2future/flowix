import { Extension, type MarkdownToken } from '@tiptap/core';
import { readMarkdownLinkDestination } from '@features/editor/extensions/shared/markdown-link-destination';
import {
  buildNoteOpenLink,
  buildNoteOpenLinkById,
  buildNotebookRelativeOpenLink,
} from '@platform/open-target/path-link';
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

export interface ParsedWikiNoteLink {
  raw: string;
  target: string;
  heading: string | null;
  title: string;
}

export const FLOWIX_NOTE_URL_RE = /^flowix:\/\/open\?/i;

function decodeMarkdownHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

export function splitObsidianTarget(rawTarget: string): { target: string; heading: string | null } {
  const hash = rawTarget.indexOf('#');
  if (hash < 0) return { target: decodeMarkdownHref(rawTarget.trim()), heading: null };
  const target = decodeMarkdownHref(rawTarget.slice(0, hash).trim());
  const heading = decodeMarkdownHref(rawTarget.slice(hash).replace(/^#+\s*/, '').trim());
  return { target, heading: heading || null };
}

export function parseWikiNoteLinkAtStart(src: string): ParsedWikiNoteLink | null {
  if (!src.startsWith('[[')) return null;
  const end = src.indexOf(']]', 2);
  if (end < 0 || src.slice(2, end).includes('\n')) return null;
  const body = src.slice(2, end);
  const aliasAt = body.indexOf('|');
  const rawTarget = aliasAt < 0 ? body : body.slice(0, aliasAt);
  const { target, heading } = splitObsidianTarget(rawTarget);
  if (!target) return null;
  const fallbackTitle = target.split('/').pop()?.replace(/\.md$/i, '') || target;
  return {
    raw: src.slice(0, end + 2),
    target,
    heading,
    title: (aliasAt < 0 ? fallbackTitle : body.slice(aliasAt + 1).trim()) || fallbackTitle,
  };
}

export function isRelativeNoteDestination(href: string): boolean {
  const value = href.trim();
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  if (value.startsWith('/') || value.startsWith('#') || value.startsWith('?') || value.startsWith('//')) return false;
  return /\.md(?:#|$)/i.test(value) || /%20/i.test(value);
}

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

export function escapeMarkdownLinkText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
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
    originalPath: null,
    linkStyle: 'flowix',
    linkTarget: href,
    heading: headingFromTarget(pathTarget),
    stale: !pathTarget,
  };
}

export interface NoteReferenceDestination {
  relativePath?: string | null;
  heading?: string | null;
  notebookId?: string | null;
  notebookName?: string | null;
}

/**
 * Destination to persist for a note reference.
 *
 * A same-notebook reference carries no notebook key at all: its target is
 * whatever `relativePath` means inside the notebook that owns the referring
 * document, so neither rename nor move of the notebook can break it. Every
 * other reference is cross-notebook and names its notebook by ID, which is the
 * only target that survives a rename. Links authored before IDs existed keep
 * their name form.
 *
 * Returns null when the reference has no writable form (invalid path, or a
 * same-notebook reference whose owning notebook is unknown), so the caller can
 * keep the authored text instead.
 */
export function noteReferenceOpenLink(
  target: NoteReferenceDestination,
  ownerNotebookId: string | null | undefined,
): string | null {
  const file = target.relativePath;
  if (!file) return null;
  const heading = target.heading ?? undefined;
  try {
    if (target.notebookId && ownerNotebookId && target.notebookId === ownerNotebookId) {
      return buildNotebookRelativeOpenLink(file, heading);
    }
    if (target.notebookId) return buildNoteOpenLinkById(target.notebookId, file, heading);
    if (target.notebookName) return buildNoteOpenLink(target.notebookName, file, heading);
  } catch { /* Keep the authored link instead of writing an invalid one. */ }
  return null;
}

export function attrsFromWikiNoteLink(parsed: ParsedWikiNoteLink): NoteReferenceAttrs {
  return {
    notebookId: null, notebookName: '', title: parsed.title,
    originalPath: null, linkStyle: 'wiki', linkTarget: parsed.target, heading: parsed.heading, stale: false,
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
    const { notebookName, title } = splitDisplay(unescapeHtml(String(token.text ?? '')));
    return {
      type: 'noteReference',
      attrs: {
        notebookId: pickAttr(attrsStr, 'notebook'),
        relativePath: pickAttr(attrsStr, 'relativePath'),
        notebookName,
        title,
        originalPath: pickAttr(attrsStr, 'path'),
        linkStyle: 'flowix',
        linkTarget: null,
        heading: null,
        stale: parseBooleanAttr(pickAttr(attrsStr, 'stale')),
      } satisfies NoteReferenceAttrs,
    };
  },
};

export const NoteReferenceMarkdownExtension = Extension.create({
  name: 'noteReference',
  priority: 1000,
  ...noteReferenceMarkdownSpec,
});
