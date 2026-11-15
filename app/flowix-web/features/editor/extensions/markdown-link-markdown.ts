import { Extension, type MarkdownParseHelpers, type MarkdownToken, type PasteRuleMatch, type InputRuleMatch } from '@tiptap/core';
import { readMarkdownLink } from './shared/markdown-link-destination';
import { sanitizeLinkHref } from '@/lib/safe-link';

interface ParsedMarkdownLink {
  raw: string;
  text: string;
  href: string;
  title: string | null;
}

const ASSET_URL_RE = /^(asset:\/\/|https?:\/\/asset\.localhost\/)/i;
const FLOWIX_MEMO_URL_RE = /^flowix:\/\/memo\/.*$/i;

export function normalizePlainLinkHref(url: string | null | undefined): string {
  const safeHref = sanitizeLinkHref(url);
  if (!safeHref) return '';
  const trimmed = safeHref.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) return `http:${trimmed}`;
  if (trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('?')) return trimmed;
  return `http://${trimmed}`;
}

function stripAngleBracketDestination(destination: string): string {
  return destination.startsWith('<') && destination.endsWith('>')
    ? destination.slice(1, -1).trim()
    : destination;
}

function normalizeMarkdownDestination(url: string | null | undefined): string {
  const safeHref = sanitizeLinkHref(url);
  if (!safeHref) return '';
  const destination = stripAngleBracketDestination(safeHref);
  if (!destination || /^[a-z][a-z0-9+.-]*:/i.test(destination) || destination.startsWith('//')) {
    return normalizePlainLinkHref(destination);
  }
  return destination;
}

export function isPlainMarkdownLinkUrl(url: string | null | undefined): boolean {
  if (!url || FLOWIX_MEMO_URL_RE.test(url) || ASSET_URL_RE.test(url)) return false;
  return true;
}

function stripOptionalTitle(destination: string): { href: string; title: string | null } {
  const trimmed = destination.trim();
  const bracketTitleMatch = /^<(.+)>\s+["']([^"']*)["']$/.exec(trimmed);
  if (bracketTitleMatch) {
    return { href: normalizeMarkdownDestination(bracketTitleMatch[1]), title: bracketTitleMatch[2] || null };
  }
  const titleMatch = /^(\S+)\s+["']([^"']*)["']$/.exec(trimmed);
  if (!titleMatch) return { href: normalizeMarkdownDestination(trimmed), title: null };
  return { href: normalizeMarkdownDestination(titleMatch[1]), title: titleMatch[2] || null };
}

function* markdownLinkMatches(text: string): Generator<ParsedMarkdownLink & { index: number }> {
  for (let index = text.indexOf('['); index >= 0; index = text.indexOf('[', index + 1)) {
    let escapes = 0;
    for (let at = index - 1; at >= 0 && text[at] === '\\'; at--) escapes++;
    if (escapes % 2 || text[index - 1] === '!' || text[index + 1] === '[') continue;
    const link = readMarkdownLink(text, index);
    if (!link || /[\r\n]/.test(text.slice(index, link.end + 1))) continue;
    const { href, title } = stripOptionalTitle(link.url);
    if (!link.label || !isPlainMarkdownLinkUrl(href)) continue;
    yield { index, raw: text.slice(index, link.end + 1), text: link.label, href, title };
    index = link.end;
  }
}

export function findLastMarkdownLink(text: string): InputRuleMatch | null {
  let found: InputRuleMatch | null = null;
  for (const parsed of markdownLinkMatches(text)) {
    if (parsed.index + parsed.raw.length !== text.length) continue;
    found = {
      index: parsed.index,
      text: parsed.raw,
      replaceWith: parsed.text,
      data: { href: parsed.href, title: parsed.title },
    };
  }
  return found;
}

export function findMarkdownLinkPasteMatches(text: string): PasteRuleMatch[] {
  const matches: PasteRuleMatch[] = [];
  for (const parsed of markdownLinkMatches(text)) {
    if (!parsed) continue;
    matches.push({
      index: parsed.index,
      text: parsed.raw,
      replaceWith: parsed.text,
      data: { href: parsed.href, title: parsed.title },
    });
  }
  return matches;
}

export const markdownLinkMarkdownSpec = {
  parseMarkdown(token: MarkdownToken, helpers: MarkdownParseHelpers) {
    if (!isPlainMarkdownLinkUrl(token.href)) return null;
    return helpers.applyMark('link', helpers.parseInline(token.tokens || []), {
      href: normalizeMarkdownDestination(token.href),
      title: token.title || null,
    });
  },
};

// @ts-expect-error The Markdown runtime accepts null to let subsequent handlers process non-link tokens.
export const MarkdownLinkParserExtension = Extension.create({
  name: 'link',
  priority: 50,
  ...markdownLinkMarkdownSpec,
});
