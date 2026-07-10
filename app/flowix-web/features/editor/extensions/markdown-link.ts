import Link from '@tiptap/extension-link';
import { Extension, markInputRule, markPasteRule, type InputRuleMatch, type PasteRuleMatch } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { isVideoUrl } from '@features/editor/extensions/attachment-link/utils';

interface ParsedMarkdownLink {
  raw: string;
  text: string;
  href: string;
  title: string | null;
}

const ASSET_URL_RE = /^(asset:\/\/|https?:\/\/asset\.localhost\/)/i;
const MARKDOWN_LINK_RE = /!?\[([^\]\n]+)\]\(([^)\n]+)\)/g;
const FLOWIX_MEMO_URL_RE = /^flowix:\/\/memo\/.*$/i;

export const linkSelectionHighlightPluginKey = new PluginKey<DecorationSet>('linkSelectionHighlight');

export function normalizePlainLinkHref(url: string | null | undefined): string {
  const trimmed = url?.trim() ?? '';
  if (!trimmed) return '';

  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith('//')) {
    return `http:${trimmed}`;
  }

  if (trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('?')) {
    return trimmed;
  }

  return `http://${trimmed}`;
}

function stripOptionalTitle(destination: string): { href: string; title: string | null } {
  const trimmed = destination.trim();
  const titleMatch = /^(\S+)\s+["']([^"']*)["']$/.exec(trimmed);

  if (!titleMatch) {
    return { href: normalizePlainLinkHref(trimmed), title: null };
  }

  return {
    href: normalizePlainLinkHref(titleMatch[1]),
    title: titleMatch[2] || null,
  };
}

export function isPlainMarkdownLinkUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  if (FLOWIX_MEMO_URL_RE.test(url)) return false;
  if (ASSET_URL_RE.test(url)) return false;
  if (isVideoUrl(url)) return false;
  return true;
}

function parseMarkdownLinkMatch(match: RegExpExecArray): ParsedMarkdownLink | null {
  const raw = match[0];
  if (raw.startsWith('!')) return null;

  const text = match[1]?.trim();
  const { href, title } = stripOptionalTitle(match[2] ?? '');

  if (!text || !isPlainMarkdownLinkUrl(href)) {
    return null;
  }

  return { raw, text, href, title };
}

function findLastMarkdownLink(text: string): InputRuleMatch | null {
  let found: InputRuleMatch | null = null;
  MARKDOWN_LINK_RE.lastIndex = 0;

  for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
    if (match.index === undefined) continue;
    const parsed = parseMarkdownLinkMatch(match);
    if (!parsed) continue;
    if (match.index + parsed.raw.length !== text.length) continue;

    found = {
      index: match.index,
      text: parsed.raw,
      replaceWith: parsed.text,
      data: { href: parsed.href, title: parsed.title },
    };
  }

  return found;
}

export function findMarkdownLinkPasteMatches(text: string): PasteRuleMatch[] {
  const matches: PasteRuleMatch[] = [];
  MARKDOWN_LINK_RE.lastIndex = 0;

  for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
    if (match.index === undefined) continue;
    const parsed = parseMarkdownLinkMatch(match);
    if (!parsed) continue;

    matches.push({
      index: match.index,
      text: parsed.raw,
      replaceWith: parsed.text,
      data: { href: parsed.href, title: parsed.title },
    });
  }

  return matches;
}

export const MarkdownLink = Link.extend({
  priority: 50,

  parseMarkdown(token: any, helpers: any) {
    if (!isPlainMarkdownLinkUrl(token.href)) {
      return null;
    }

    return helpers.applyMark('link', helpers.parseInline(token.tokens || []), {
      href: normalizePlainLinkHref(token.href),
      title: token.title || null,
    });
  },

  addInputRules() {
    const parentRules = this.parent?.() ?? [];

    return [
      markInputRule({
        find: findLastMarkdownLink,
        type: this.type,
        getAttributes: match => ({
          href: match.data?.href,
          title: match.data?.title ?? null,
        }),
      }),
      ...parentRules,
    ];
  },

  addPasteRules() {
    const parentRules = this.parent?.() ?? [];

    return [
      markPasteRule({
        find: findMarkdownLinkPasteMatches,
        type: this.type,
        getAttributes: match => ({
          href: match.data?.href,
          title: match.data?.title ?? null,
        }),
      }),
      ...parentRules,
    ];
  },
}).configure({
  openOnClick: false,
  linkOnPaste: true,
  autolink: true,
  HTMLAttributes: {
    target: '_blank',
    rel: 'noopener noreferrer',
  },
});

export const LinkSelectionHighlight = Extension.create({
  name: 'linkSelectionHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: linkSelectionHighlightPluginKey,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, value) => {
            const meta = tr.getMeta(linkSelectionHighlightPluginKey) as
              | { from?: number; to?: number; clear?: boolean }
              | undefined;

            if (meta?.clear) {
              return DecorationSet.empty;
            }

            if (typeof meta?.from === 'number' && typeof meta?.to === 'number' && meta.from < meta.to) {
              return DecorationSet.create(tr.doc, [
                Decoration.inline(meta.from, meta.to, {
                  class: 'editor-link-selection-highlight',
                }),
              ]);
            }

            return value.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});
